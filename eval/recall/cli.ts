import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createArtifactWriter, type ArtifactWriter } from "./artifacts.ts";
import { EVAL_MODEL, PAGING_SETTINGS, WORKLOAD_VERSION } from "./experiment-settings.ts";
import { buildManifest, isEligiblePilot, sameModelMetadata, type RunManifest } from "./manifest.ts";
import { observedDuration } from "./eligibility.ts";
import { finishOperation, startOperation, type SessionOwner } from "./metrics.ts";
import { realClock } from "./clock.ts";
import { assertOutputLocation } from "./output-location.ts";
import { safeError } from "./safe-artifacts.ts";
import { assertCleanSource, type CleanSourceSnapshot } from "./source-integrity.ts";
import type { EvalCliOptions } from "./cli-options.ts";
import type { SafeModelMetadata } from "./codex-runtime.ts";
import type { StageGroupOptions, StageGroupResult } from "./stage-group.ts";
import type { EvalArm, Clock } from "./pi-arm.ts";
import type { ArmFactoryOptions } from "./fork.ts";
import type { Arm, Stage } from "./workload.ts";
export { parseEvalArgs } from "./cli-options.ts";
export type { EvalCliOptions } from "./cli-options.ts";

export type LiveEval = {
	modelMetadata: SafeModelMetadata; sdkVersion: string;
	runStageGroup(options: StageGroupOptions): Promise<StageGroupResult>;
	createArm(options: ArmFactoryOptions): Promise<EvalArm>;
	cleanupSession(owner: SessionOwner): Promise<void>; cleanup(): Promise<void>;
};
export type EvalCliDependencies = {
	repoRoot: string; inspectSource?: typeof assertCleanSource; loadLive(): Promise<LiveEval>;
	createArtifacts?: typeof createArtifactWriter; clock?: Clock; log(line: string): void;
};
function reject(code: string): never { throw Object.assign(new Error("Recall evaluation blocked"), { code }); }
async function loadPilot(path: string): Promise<{ manifest: RunManifest; results: StageGroupResult[] }> {
	const manifest = JSON.parse(await readFile(path, "utf8")) as RunManifest;
	const results = JSON.parse(await readFile(join(dirname(path), "results.json"), "utf8"));
	const completion = JSON.parse(await readFile(join(dirname(path), "completion.json"), "utf8"));
	if (completion.schemaVersion !== 3 || completion.status !== "complete" || completion.runId !== manifest.runId
		|| completion.experimentHash !== manifest.experimentHash || completion.stageGroups !== 2 || !completion.cleanupComplete
		|| !completion.finalizedArtifacts || !completion.offlineGateEvidence?.passed || completion.offlineGateEvidence.restoredForks !== 24
		|| completion.offlineGateEvidence.method !== manifest.restorationMethods?.paging || completion.offlineGateEvidence.sdkVersion !== manifest.sdkVersion
		|| !observedDuration(completion.runWallMs) || completion.runTiming?.status !== "succeeded"
		|| !Array.isArray(results.stageGroups) || results.stageGroups.length !== 2) reject("INVALID_PILOT_RESULTS");
	return { manifest, results: results.stageGroups };
}

/** Live imports and dispatches follow fail-closed source, artifact and pilot checks. */
export async function runEval(options: EvalCliOptions, dependencies: EvalCliDependencies): Promise<number> {
	const log = dependencies.log, clock = dependencies.clock ?? realClock, runTiming = startOperation(clock);
	if (options.mode === "dry-run") {
		log(`Dry run: no credentials, sessions or model requests. ${EVAL_MODEL.provider}/${EVAL_MODEL.id}, ${EVAL_MODEL.thinking}, SSE; paging ${PAGING_SETTINGS.tokenBudget}/${PAGING_SETTINGS.trimToTokens}.`);
		log(`Workload: ${WORKLOAD_VERSION}, seed ${JSON.stringify(options.seed)}; at least 23 preparation prompts per source and one question per fork. Each probe lineage contains at least 24 user prompts.`);
		log(`Each stage group: two sources and twelve isolated forks. Pilot: four sources and twenty-four forks. Default batch: twelve sources and seventy-two forks; --pairs sets repetitions per stage.`);
		log(`Shared safety limits: ${JSON.stringify(options.limits)}. Preparation and all six forks share each arm's prompt and HTTP-attempt allowances, including retries and compaction. Wall-time limits apply per stage group.`);
		log(`Qualification: five-of-five known paging probes per stage, plus a separate unknown-control fork. Offline SDK restoration evidence is required before any live pilot.`);
		log(`Metrics: preparation once plus newly dispatched fork usage; preparation, probe, arm, stage-group, stage and run scopes. Missing measurements remain unknown; billed cost is unavailable.`);
		log(`Artifacts: ${JSON.stringify(options.outputDirectory)}/<run-id>; schema 3 manifest.json, results.json, report.md, run-timing.json, completion.json and private preparation/probe evidence.`);
		log(`Live pilot and later batch each require separate user authorization after offline verification, implementation approval and a clean commit.`);
		return 0;
	}
	const roots = options.mode === "pilot" ? [options.seed] : Array.from({ length: options.pairs }, (_, i) => `${options.seed}-${i + 1}`);
	const schedule = roots.flatMap((seed, index) => (["A", "B"] as const).map((stage, offset) => ({
		seed: `${seed}-stage-${stage}`, stage, firstArm: ((index + offset) % 2 ? "paging" : "baseline") as Arm,
	})));
	const seeds = schedule.map(g => g.seed), stages: Stage[] = schedule.map(g => g.stage), firstArms = schedule.map(g => g.firstArm);
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
	let source: CleanSourceSnapshot | null = null, sourceFailed = false, writer: ArtifactWriter | undefined, live: LiveEval | undefined;
	let infrastructureError: unknown = null, latest: StageGroupResult | undefined, exitCode = 0, cleanupComplete = false;
	let manifest = buildManifest({ runId, mode: options.mode, sourceRevision: null, sourceIntegrity: null,
		sdkVersion: "unavailable", nodeVersion: process.version, modelMetadata: null, limits: options.limits, seeds, stages, firstArms });
	const rebuild = () => buildManifest({ ...manifest, sourceRevision: source?.sourceRevision ?? null, sourceIntegrity: sourceFailed ? null : source?.sourceIntegrity ?? null });
	const verify = () => {
		if (sourceFailed) reject("SOURCE_RUN_ALREADY_BLOCKED");
		try { source = (dependencies.inspectSource ?? assertCleanSource)(dependencies.repoRoot, source?.sourceRevision); }
		catch (error) { sourceFailed = true; infrastructureError ??= error; throw error; }
	};
	const observeFailure = <T>(action: () => Promise<T>): Promise<T> => action().catch(error => { infrastructureError ??= error; throw error; });
	try {
		const output = assertOutputLocation(dependencies.repoRoot, options.outputDirectory);
		await mkdir(output, { recursive: true, mode: 0o700 });
		const directory = join(output, runId);
		writer = await (dependencies.createArtifacts ?? createArtifactWriter)(directory, manifest, clock); log(`Artifacts: ${directory}`);
		verify(); manifest = rebuild(); await writer.updateManifest(manifest);
		let pilot: Awaited<ReturnType<typeof loadPilot>> | undefined;
		if (options.mode === "batch") {
			pilot = await loadPilot(resolve(dependencies.repoRoot, options.pilotManifestPath!));
			const provisional = buildManifest({ ...manifest, sdkVersion: pilot.manifest.sdkVersion, modelMetadata: pilot.manifest.modelMetadata });
			if (seeds.some(seed => pilot!.manifest.seeds.includes(seed)) || !isEligiblePilot(pilot.manifest, pilot.results, provisional).eligible) reject("INELIGIBLE_PILOT");
		}
		verify(); live = await dependencies.loadLive(); verify();
		manifest = buildManifest({ ...rebuild(), sdkVersion: live.sdkVersion, modelMetadata: live.modelMetadata }); await writer.updateManifest(manifest);
		if (pilot && !isEligiblePilot(pilot.manifest, pilot.results, manifest).eligible) reject("PILOT_EXPERIMENT_CHANGED");
		for (const group of schedule) {
			verify();
			latest = await live.runStageGroup({ runId, ...group, limits: options.limits, clock, cleanupSession: owner => live!.cleanupSession(owner),
				createArm: async armOptions => {
					verify(); return live!.createArm({ ...armOptions, eventSink: event => writer!.appendEvent(group.seed, armOptions.arm, event),
						requestGuard: async meta => { await observeFailure(() => writer!.flush()); verify(); await armOptions.requestGuard(meta); },
					});
				},
				onReady: async snapshots => {
					verify(); if (![snapshots.baseline, snapshots.paging].every(s => sameModelMetadata(s.modelMetadata, manifest.modelMetadata))) reject("ARM_MODEL_CHANGED");
				},
				onProgress: progress => observeFailure(() => writer!.appendProgress(progress)),
				onForkEvidence: fork => observeFailure(() => writer!.writeFork(fork)), onForkTiming: fork => observeFailure(() => writer!.writeFork(fork)),
			});
			try { verify(); } catch { /* Preserve this group's partial evidence. */ }
			if (infrastructureError) {
				latest.status = "incomplete"; latest.errors.push({ code: sourceFailed ? "source-error" : "artifact-error" });
				manifest = rebuild(); await writer.updateManifest(manifest);
			}
			await writer.finish(latest); verify();
			log(`Stage ${latest.stage} group ${group.seed}: ${latest.status}; ${latest.steps.length} preparation prompts, ${latest.forks.length} forks; HTTP attempts ${JSON.stringify(latest.sentAttempts)}.`);
			const safetyStop = ["max-user-prompts", "max-requests-per-prompt", "max-requests-per-arm", "max-pair-minutes"].includes(latest.stopReason ?? "");
			if (infrastructureError || latest.errors.length && !safetyStop) { exitCode = 2; break; }
			if (latest.status !== "complete") exitCode = 3;
			if (latest.status === "incomplete") break;
		}
	} catch (error) { exitCode = 2; infrastructureError ??= error; }
	finally {
		if (live) try { await live.cleanup(); cleanupComplete = true; } catch (error) { exitCode = 2; infrastructureError ??= error; }
		if (source) try { verify(); } catch { exitCode = 2; }
		if (writer && exitCode === 0) try { await writer.complete({ runTiming, cleanupComplete, clock }); } catch (error) { exitCode = 2; infrastructureError ??= error; }
		if (exitCode !== 0) { finishOperation(runTiming, "failed", clock); runTiming.status = "failed"; }
		if (writer && infrastructureError) {
			manifest = rebuild();
			if (latest) { latest.status = "incomplete"; if (!latest.errors.some(e => e.code === (sourceFailed ? "source-error" : "artifact-error"))) latest.errors.push({ code: sourceFailed ? "source-error" : "artifact-error" }); }
			try { await writer.updateManifest(manifest); if (latest) await writer.finish(latest); await writer.recordFailure(infrastructureError); }
			catch { /* Earlier evidence remains; no further provider work. */ }
		}
		if (infrastructureError) log(`Blocked: ${JSON.stringify(safeError(infrastructureError))}. Partial artifacts retained where writable.`);
	}
	return exitCode;
}
