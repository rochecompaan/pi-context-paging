import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createArtifactWriter, type ArtifactWriter } from "./artifacts.ts";
import { EVAL_MODEL, PAGING_SETTINGS, WORKLOAD_VERSION } from "./experiment-settings.ts";
import { buildManifest, isEligiblePilot, sameModelMetadata, type RunManifest } from "./manifest.ts";
import { assertOutputLocation } from "./output-location.ts";
import { safeError } from "./safe-artifacts.ts";
import { assertCleanSource, type CleanSourceSnapshot } from "./source-integrity.ts";
import type { EvalCliOptions } from "./cli-options.ts";
import type { SafeModelMetadata } from "./codex-runtime.ts";
import type { PairOptions, PairResult } from "./pair.ts";
import type { EvalArm, Clock } from "./pi-arm.ts";
import type { JournalEvent } from "./pi-journal.ts";
import type { RequestMeta } from "./codex-payload.ts";
import type { Arm } from "./workload.ts";
export { parseEvalArgs } from "./cli-options.ts";
export type { EvalCliOptions } from "./cli-options.ts";

export type LiveEval = {
	modelMetadata: SafeModelMetadata; sdkVersion: string;
	runPair(options: PairOptions): Promise<PairResult>;
	createArm(options: { seed: string; arm: Arm; clock: Clock; requestGuard(meta: RequestMeta): Promise<void>; eventSink(event: JournalEvent): void }): Promise<EvalArm>;
	cleanup(): Promise<void>;
};
export type EvalCliDependencies = {
	repoRoot: string;
	inspectSource?: typeof assertCleanSource;
	loadLive(): Promise<LiveEval>;
	createArtifacts?: typeof createArtifactWriter;
	clock?: Clock;
	log(line: string): void;
};
function reject(code: string): never { throw Object.assign(new Error("Recall evaluation blocked"), { code }); }
async function loadPilot(path: string): Promise<{ manifest: RunManifest; result: PairResult }> {
	const manifest = JSON.parse(await readFile(path, "utf8")) as RunManifest;
	const results = JSON.parse(await readFile(join(dirname(path), "results.json"), "utf8")) as { pairs: PairResult[] };
	const completion = JSON.parse(await readFile(join(dirname(path), "completion.json"), "utf8")) as { status: string; runId: string; experimentHash: string; pairs: number };
	if (completion.status !== "complete" || completion.runId !== manifest.runId || completion.experimentHash !== manifest.experimentHash
		|| completion.pairs !== 1 || !Array.isArray(results.pairs) || results.pairs.length !== 1) reject("INVALID_PILOT_RESULTS");
	return { manifest, result: results.pairs[0] };
}

/** Live code is loaded only after clean-source and cheap pilot checks. */
export async function runEval(options: EvalCliOptions, dependencies: EvalCliDependencies): Promise<number> {
	const log = dependencies.log;
	if (options.mode === "dry-run") {
		log(`Dry run: no credentials, sessions or model requests. ${EVAL_MODEL.provider}/${EVAL_MODEL.id}, ${EVAL_MODEL.thinking}, SSE; paging ${PAGING_SETTINGS.tokenBudget}/${PAGING_SETTINGS.trimToTokens}.`);
		log(`Safety limits: ${JSON.stringify(options.limits)}. Use --pilot for one pair, then --batch --pilot-manifest <path>.`);
		log(`Workload: ${WORKLOAD_VERSION}, seed ${JSON.stringify(options.seed)}; at least 24 shared prompts. Stage A follows source exclusion; stage B follows native compaction.`);
		log(`Artifacts: ${JSON.stringify(options.outputDirectory)}/<run-id>; manifest.json, results.json, report.md, completion.json and private per-arm evidence.`);
		return 0;
	}
	const seeds = options.mode === "pilot" ? [options.seed] : Array.from({ length: options.pairs }, (_, i) => `${options.seed}-${i + 1}`);
	const firstArms: Arm[] = seeds.map((_, i) => i % 2 ? "paging" : "baseline");
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
	let source: CleanSourceSnapshot | null = null, sourceFailed = false, writer: ArtifactWriter | undefined, live: LiveEval | undefined;
	let infrastructureError: unknown = null, latest: PairResult | undefined, exitCode = 0;
	let manifest = buildManifest({ runId, mode: options.mode, sourceRevision: null, sourceIntegrity: null,
		sdkVersion: "unavailable", nodeVersion: process.version, modelMetadata: null, limits: options.limits, seeds, firstArms });
	const rebuild = () => buildManifest({ ...manifest, sourceRevision: source?.sourceRevision ?? null,
		sourceIntegrity: sourceFailed ? null : source?.sourceIntegrity ?? null });
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
		writer = await (dependencies.createArtifacts ?? createArtifactWriter)(directory, manifest);
		log(`Artifacts: ${directory}`);
		verify(); manifest = rebuild(); await writer.updateManifest(manifest);
		let pilot: Awaited<ReturnType<typeof loadPilot>> | undefined;
		if (options.mode === "batch") {
			pilot = await loadPilot(resolve(dependencies.repoRoot, options.pilotManifestPath!));
			const provisional = buildManifest({ ...manifest, sdkVersion: pilot.manifest.sdkVersion, modelMetadata: pilot.manifest.modelMetadata });
			if (!isEligiblePilot(pilot.manifest, pilot.result, provisional).eligible) reject("INELIGIBLE_PILOT");
		}
		verify(); live = await dependencies.loadLive(); verify();
		manifest = buildManifest({ ...rebuild(), sdkVersion: live.sdkVersion, modelMetadata: live.modelMetadata });
		await writer.updateManifest(manifest);
		if (pilot && !isEligiblePilot(pilot.manifest, pilot.result, manifest).eligible) reject("PILOT_EXPERIMENT_CHANGED");
		for (let index = 0; index < seeds.length; index++) {
			verify(); const seed = seeds[index];
			latest = await live.runPair({ seed, firstArm: firstArms[index], limits: options.limits, clock: dependencies.clock,
				createArm: async armOptions => {
					verify();
					return live!.createArm({ ...armOptions, seed,
						eventSink: event => writer!.appendEvent(seed, armOptions.arm, event),
						requestGuard: async meta => {
							await observeFailure(() => writer!.flush()); verify(); armOptions.requestGuard(meta);
						},
					});
				},
				onReady: async snapshots => {
					verify();
					if (![snapshots.baseline, snapshots.paging].every(snapshot => sameModelMetadata(snapshot.modelMetadata, manifest.modelMetadata))) reject("ARM_MODEL_CHANGED");
				},
				onProgress: progress => observeFailure(() => writer!.appendProgress(progress)),
			});
			try { verify(); } catch { /* Keep the pair's partial evidence below. */ }
			if (infrastructureError) {
				latest.status = "incomplete"; latest.errors.push({ code: sourceFailed ? "source-error" : "artifact-error" });
				manifest = rebuild(); await writer.updateManifest(manifest);
			}
			await writer.finish(latest); verify();
			log(`Pair ${seed}: ${latest.status}; ${latest.steps.length} shared prompts; HTTP attempts ${JSON.stringify(latest.sentAttempts)}.`);
			if (infrastructureError || latest.errors.length && !latest.stopReason) { exitCode = 2; break; }
			if (latest.status !== "complete") exitCode = 3;
			if (latest.status === "incomplete") break;
		}
	} catch (error) {
		exitCode = 2; infrastructureError ??= error;
	} finally {
		if (live) try { await live.cleanup(); } catch (error) { exitCode = 2; infrastructureError ??= error; }
		if (source) try { verify(); } catch { exitCode = 2; }
		if (writer && exitCode === 0) try { await writer.complete(); } catch (error) { exitCode = 2; infrastructureError ??= error; }
		if (writer && infrastructureError) {
			manifest = rebuild();
			if (latest) { latest.status = "incomplete"; if (!latest.errors.some(error => error.code === (sourceFailed ? "source-error" : "artifact-error"))) latest.errors.push({ code: sourceFailed ? "source-error" : "artifact-error" }); }
			try { await writer.updateManifest(manifest); if (latest) await writer.finish(latest); await writer.recordFailure(infrastructureError); }
			catch { /* Earlier private evidence remains; no further model work. */ }
		}
		if (infrastructureError) log(`Blocked: ${JSON.stringify(safeError(infrastructureError))}. Partial artifacts retained where writable.`);
	}
	return exitCode;
}
