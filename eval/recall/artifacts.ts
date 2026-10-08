import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { completeStageGroup, verifiedManifest, type RunManifest } from "./manifest.ts";
import { elapsed, finishOperation, sameOwner, startOperation, type TimedOperation, type SessionOwner } from "./metrics.ts";
import { observedDuration } from "./eligibility.ts";
import type { StageProgress, StageGroupResult, StageForkResult } from "./stage-group.ts";
import type { JournalEvent } from "./pi-journal.ts";
import type { ArmSnapshot } from "./pi-arm.ts";
import { realClock, type Clock } from "./clock.ts";
import { renderReport } from "./report.ts";
import { summarizeMetrics, type RunMetricsSummary } from "./metric-summary.ts";
import { safeError, sanitizeArtifact } from "./safe-artifacts.ts";
import type { Arm } from "./workload.ts";

export type CompletionInput = { runTiming: TimedOperation; cleanupComplete: boolean; clock?: Clock };
export type ArtifactWriter = {
	appendEvent(seed: string, arm: Arm, event: JournalEvent): void;
	appendProgress(progress: StageProgress): Promise<void>;
	writeFork(fork: Readonly<StageForkResult>): Promise<void>;
	flush(): Promise<void>; updateManifest(manifest: RunManifest): Promise<void>; recordFailure(error: unknown): Promise<void>;
	finish(result: StageGroupResult): Promise<void>; complete(input: CompletionInput): Promise<void>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(sanitizeArtifact(value), null, 2)}\n`;

/** Serialized evidence writes latch failure before the next provider dispatch. */
export async function createArtifactWriter(directory: string, initial: RunManifest, clock: Clock = realClock): Promise<ArtifactWriter> {
	await mkdir(directory, { mode: 0o700 });
	let manifest = initial, queue = Promise.resolve(), failure: unknown = null;
	const groups = new Map<string, StageGroupResult>(), shared = new Map<string, Map<string, StageProgress["step"]>>();
	const events = new Map<string, string[]>();
	function groupDirectory(seed: string): string {
		const index = manifest.seeds.indexOf(seed);
		if (index < 0) throw new Error("Artifact seed is not in this run");
		return join(directory, "stage-groups", `group-${String(index).padStart(3, "0")}-${hash(seed).slice(0, 12)}`);
	}
	function evidenceDirectory(seed: string, arm: Arm, probeId?: string): string {
		if (!["baseline", "paging"].includes(arm) || probeId && !/^probe-[AB]-(id|path|error|quantity|decision|unknown)$/.test(probeId)) throw new Error("Invalid evidence scope");
		return probeId ? join(groupDirectory(seed), "probes", probeId, arm) : join(groupDirectory(seed), "preparation", arm);
	}
	function healthy() { if (failure) throw failure; }
	function validateOwner(owner: SessionOwner, seed: string, arm: Arm) {
		const index = manifest.seeds.indexOf(seed);
		if (index < 0 || owner.runId !== manifest.runId || owner.seed !== seed || owner.arm !== arm || owner.stage !== manifest.stages[index]) throw new Error("Evidence ownership mismatch");
	}
	function enqueue(operation: () => Promise<void>): Promise<void> {
		const pending = queue.then(async () => { healthy(); await operation(); });
		queue = pending.catch(error => { failure = error; }); return pending;
	}
	async function atomic(path: string, value: string) {
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, value, { mode: 0o600, flag: "wx" }); await rename(temporary, path);
	}
	async function savePrompts(seed: string, steps: readonly StageProgress["step"][]) {
		const path = groupDirectory(seed); await mkdir(path, { recursive: true, mode: 0o700 });
		await atomic(join(path, "prompts.json"), json({ hash: hash(JSON.stringify(steps)), steps }));
	}
	async function saveSnapshot(path: string, snapshot: ArmSnapshot) {
		await mkdir(path, { recursive: true, mode: 0o700 });
		await atomic(join(path, "transcript.json"), json(snapshot.entries));
		await atomic(join(path, "request-traces.json"), json(snapshot.requests));
		await atomic(join(path, "snapshot.json"), json(snapshot));
	}
	async function saveSources(seed: string, snapshots: StageProgress["snapshots"]) {
		for (const arm of ["baseline", "paging"] as const) if (snapshots[arm]) {
			validateOwner(snapshots[arm]!.owner, seed, arm);
			if (snapshots[arm]!.owner.forkId !== null) throw new Error("Preparation evidence belongs to a fork");
			await saveSnapshot(evidenceDirectory(seed, arm), snapshots[arm]!);
		}
	}
	async function saveFork(fork: Readonly<StageForkResult>) {
		validateOwner(fork.owner, fork.owner.seed, fork.owner.arm);
		if (fork.owner.stage !== fork.probe.stage || !fork.owner.forkId || !fork.owner.checkpointId || fork.snapshot && !sameOwner(fork.owner, fork.snapshot.owner)) throw new Error("Fork ownership mismatch");
		const path = evidenceDirectory(fork.owner.seed, fork.owner.arm, fork.probe.id);
		await mkdir(path, { recursive: true, mode: 0o700 });
		if (fork.snapshot) await saveSnapshot(path, fork.snapshot);
		await atomic(join(path, "fork.json"), json(fork));
	}
	function ordered() { return manifest.seeds.flatMap(seed => groups.has(seed) ? [groups.get(seed)!] : []); }
	async function summaries(runTiming?: TimedOperation) {
		const metrics = summarizeMetrics(manifest, ordered(), runTiming);
		await atomic(join(directory, "results.json"), json({ schemaVersion: 3, stageGroups: ordered(), metrics }));
		await atomic(join(directory, "report.md"), renderReport(manifest, sanitizeArtifact(ordered()) as StageGroupResult[], sanitizeArtifact(metrics) as RunMetricsSummary));
	}
	await atomic(join(directory, "manifest.json"), json(manifest)); await summaries();
	async function flush() {
		const pending = [...events]; events.clear();
		if (pending.length) await enqueue(async () => { for (const [path, lines] of pending) {
			await mkdir(join(path, ".."), { recursive: true, mode: 0o700 }); await appendFile(path, lines.join(""), { mode: 0o600 });
		} });
		await queue; healthy();
	}
	return {
		appendEvent(seed, arm, event) {
			healthy();
			validateOwner(event, seed, arm);
			const path = join(evidenceDirectory(seed, arm, event.forkId ? event.promptId ?? undefined : undefined), "events.jsonl");
			const lines = events.get(path) ?? []; lines.push(`${JSON.stringify(sanitizeArtifact(event))}\n`); events.set(path, lines);
		}, flush,
		async appendProgress(progress) {
			const steps = shared.get(progress.seed) ?? new Map(); steps.set(progress.step.id, progress.step); shared.set(progress.seed, steps);
			await flush(); await enqueue(async () => {
				await savePrompts(progress.seed, [...steps.values()]); await saveSources(progress.seed, progress.snapshots);
				await atomic(join(groupDirectory(progress.seed), "progress.json"), json(progress));
			});
		},
		async writeFork(fork) { await flush(); await enqueue(() => saveFork(fork)); },
		updateManifest(next) {
			if (next.runId !== manifest.runId || JSON.stringify(next.seeds) !== JSON.stringify(manifest.seeds) || JSON.stringify(next.stages) !== JSON.stringify(manifest.stages)) throw new Error("Artifact run identity changed");
			manifest = next; return enqueue(async () => { await atomic(join(directory, "manifest.json"), json(manifest)); await summaries(); });
		},
		recordFailure(error) { return enqueue(() => atomic(join(directory, "failure.json"), json(safeError(error)))); },
		async finish(result) {
			await flush(); await enqueue(async () => {
				if (result.runId !== manifest.runId) throw new Error("Stage run identity mismatch");
				await savePrompts(result.seed, result.steps); await saveSources(result.seed, result.sources);
				for (const fork of result.forks) await saveFork(fork);
				await atomic(join(groupDirectory(result.seed), "probes.json"), json(result.probes));
				groups.set(result.seed, result); await summaries();
				// One bounded final stamp. Its own persistence is not recursively timed.
				result.timing.endMs = clock.nowMs(); result.timing.endedAtUtc = clock.utcNow();
				result.groupWallMs = result.timing.durationMs = elapsed(result.timing.startMs, result.timing.endMs);
				await atomic(join(groupDirectory(result.seed), "results.json"), json(result)); await summaries();
			});
		},
		complete(input) { return enqueue(async () => {
			if (!input.cleanupComplete || !verifiedManifest(manifest) || groups.size !== manifest.seeds.length || ordered().some(g => !completeStageGroup(g))) throw new Error("Run is not complete");
			if (manifest.mode === "pilot" && manifest.stages.join(",") !== "A,B") throw new Error("Pilot stages missing");
			const finalization = startOperation(input.clock ?? clock);
			await summaries(); finishOperation(finalization, "succeeded", input.clock ?? clock);
			finishOperation(input.runTiming, "succeeded", input.clock ?? clock);
			if (!observedDuration(input.runTiming.durationMs) || !observedDuration(finalization.durationMs)) throw new Error("Run timing incomplete");
			// Stamp final metrics once with the measured boundary; do not recursively time serialization.
			await summaries(input.runTiming);
			const completion = { schemaVersion: 3, status: "complete", runId: manifest.runId, experimentHash: manifest.experimentHash,
				stageGroups: groups.size, stages: manifest.stages, cleanupComplete: true, finalizedArtifacts: true,
				offlineGateEvidence: { passed: true, method: manifest.restorationMethods.paging, sdkVersion: manifest.sdkVersion,
					restoredForks: ordered().flatMap(g => g.forks).length },
				runTiming: input.runTiming, runWallMs: input.runTiming.durationMs, finalizationTiming: finalization,
				finalStampBoundary: "before-bounded-final-record-writes" };
			// Only completion.json is run-success authority; it is the final write.
			await atomic(join(directory, "run-timing.json"), json({ ...completion, status: "timing-finalized" }));
			await atomic(join(directory, "completion.json"), json(completion));
		}); },
	};
}
