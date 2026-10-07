import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunManifest } from "./manifest.ts";
import type { PairProgress, PairResult } from "./pair.ts";
import type { JournalEvent } from "./pi-journal.ts";
import { renderReport } from "./report.ts";
import { safeError, sanitizeArtifact } from "./safe-artifacts.ts";
import type { Arm } from "./workload.ts";

export type ArtifactWriter = {
	appendEvent(seed: string, arm: Arm, event: JournalEvent): void;
	appendProgress(progress: PairProgress): Promise<void>;
	flush(): Promise<void>;
	updateManifest(manifest: RunManifest): Promise<void>;
	recordFailure(error: unknown): Promise<void>;
	finish(result: PairResult): Promise<void>;
	complete(): Promise<void>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(sanitizeArtifact(value), null, 2)}\n`;

/** Serialize private evidence writes; a latched failure blocks the next request. */
export async function createArtifactWriter(directory: string, initial: RunManifest): Promise<ArtifactWriter> {
	await mkdir(directory, { mode: 0o700 }); // Deliberately not recursive: never reuse a run.
	let manifest = initial, queue = Promise.resolve(), failure: unknown = null;
	const pairs = new Map<string, PairResult>(), shared = new Map<string, Map<string, PairProgress["step"]>>();
	const events = new Map<string, string[]>();
	function pairDirectory(seed: string): string {
		const index = manifest.seeds.indexOf(seed);
		if (index < 0) throw new Error("Artifact seed is not in this run");
		return join(directory, "pairs", `pair-${String(index).padStart(3, "0")}-${hash(seed).slice(0, 12)}`);
	}
	function healthy() { if (failure) throw failure; }
	function enqueue(operation: () => Promise<void>): Promise<void> {
		const pending = queue.then(async () => { healthy(); await operation(); });
		queue = pending.catch(error => { failure = error; });
		return pending;
	}
	async function atomic(path: string, value: string) {
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	}
	async function savePrompts(seed: string, steps: readonly PairProgress["step"][]) {
		const path = pairDirectory(seed);
		await mkdir(path, { recursive: true, mode: 0o700 });
		await atomic(join(path, "prompts.json"), json({ hash: hash(JSON.stringify(steps)), steps }));
	}
	async function saveSnapshots(seed: string, snapshots: PairProgress["snapshots"]) {
		for (const arm of ["baseline", "paging"] as const) {
			const snapshot = snapshots[arm];
			if (!snapshot) continue;
			const path = join(pairDirectory(seed), arm);
			await mkdir(path, { recursive: true, mode: 0o700 });
			await atomic(join(path, "transcript.json"), json(snapshot.entries));
			await atomic(join(path, "request-traces.json"), json(snapshot.requests));
			await atomic(join(path, "snapshot.json"), json(snapshot));
		}
	}
	async function summaries() {
		const ordered = manifest.seeds.flatMap(seed => pairs.has(seed) ? [pairs.get(seed)!] : []);
		await atomic(join(directory, "results.json"), json({ pairs: ordered }));
		await atomic(join(directory, "report.md"), renderReport(manifest,
			sanitizeArtifact(ordered) as PairResult[]));
	}
	await atomic(join(directory, "manifest.json"), json(manifest));
	await summaries();
	async function flush() {
		const pending = [...events]; events.clear();
		if (pending.length) await enqueue(async () => {
			for (const [path, lines] of pending) {
				await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
				await appendFile(path, lines.join(""), { mode: 0o600 });
			}
		});
		await queue; healthy();
	}
	return {
		appendEvent(seed, arm, event) {
			healthy();
			const path = join(pairDirectory(seed), arm, "events.jsonl");
			const lines = events.get(path) ?? [];
			lines.push(`${JSON.stringify({ type: event.type, eventIndex: event.eventIndex,
				promptId: event.promptId, requestId: event.requestId, status: event.status })}\n`);
			events.set(path, lines);
		},
		flush,
		async appendProgress(progress) {
			const seed = progress.seed;
			const steps = shared.get(seed) ?? new Map(); steps.set(progress.step.id, progress.step); shared.set(seed, steps);
			await flush();
			await enqueue(async () => {
				await savePrompts(seed, [...steps.values()]);
				await saveSnapshots(seed, progress.snapshots);
				await atomic(join(pairDirectory(seed), "progress.json"), json(progress));
			});
		},
		updateManifest(next) {
			if (next.runId !== manifest.runId || JSON.stringify(next.seeds) !== JSON.stringify(manifest.seeds)
				|| JSON.stringify(next.stages) !== JSON.stringify(manifest.stages)) throw new Error("Artifact run identity changed");
			manifest = next;
			return enqueue(async () => { await atomic(join(directory, "manifest.json"), json(manifest)); await summaries(); });
		},
		recordFailure(error) { return enqueue(() => atomic(join(directory, "failure.json"), json(safeError(error)))); },
		complete() { return enqueue(async () => {
			if (pairs.size !== manifest.seeds.length || [...pairs.values()].some(pair => pair.status !== "complete")) throw new Error("Run is not complete");
			await atomic(join(directory, "completion.json"), json({ status: "complete", runId: manifest.runId, experimentHash: manifest.experimentHash, pairs: pairs.size }));
		}); },
		async finish(result) {
			await flush();
			await enqueue(async () => {
				await savePrompts(result.seed, result.steps); await saveSnapshots(result.seed, result.snapshots);
				await atomic(join(pairDirectory(result.seed), "probes.json"), json(result.probes));
				await atomic(join(pairDirectory(result.seed), "results.json"), json(result));
				pairs.set(result.seed, result); await summaries();
			});
		},
	};
}
