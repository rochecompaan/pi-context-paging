import { randomUUID } from "node:crypto";
import { checkpointEvidence, restoreCheckpointData, type PrivateCheckpoint, type CheckpointEvidence } from "./checkpoint.ts";
import { runProbeFork, type ArmFactoryOptions, type ProbeForkResult } from "./fork.ts";
import { createGroupLifecycle, type GroupError } from "./group-lifecycle.ts";
import { assertOwner, elapsed, finishOperation, missing, sameOwner, startOperation, type Measurement, type SessionOwner } from "./metrics.ts";
import { checkpointOpportunity, scoreProbeArm, sourceExcluded, successfulCompactions, type PairProbe, type ProbeArmResult, type Snapshots, type StageResult } from "./pair-stages.ts";
import { realClock, type Clock, type EvalArm } from "./pi-arm.ts";
import { qualifyInitialProbe, type ProbeGateResult } from "./probe-gate.ts";
import { matchFact } from "./evidence.ts";
import { createRequestGuard, defaultLimits, type EvalLimits } from "./request-guard.ts";
import { createTaskRecorder } from "./task-metrics.ts";
import { buildWorkload, buildWorkStep, factForProbe, type Arm, type Probe, type PromptStep, type Stage, type Workload } from "./workload.ts";

export type StageForkResult = ProbeForkResult & { probe: Probe; gate: ProbeGateResult | null };
export type StageProgress = { type: "prompt-idle"; seed: string; stage: Stage; step: PromptStep; arm: Arm; snapshots: Snapshots;
	promptCounts: Record<Arm, number>; sentAttempts: Record<Arm, number> };
export type StageGroupOptions = {
	runId: string; seed: string; stage: Stage; firstArm: Arm; workload?: Workload; limits?: Partial<EvalLimits>; clock?: Clock;
	createArm(options: ArmFactoryOptions): Promise<EvalArm>; cleanupSession(owner: SessionOwner): Promise<void>;
	onReady?(snapshots: Readonly<Record<Arm, NonNullable<Snapshots[Arm]>>>): Promise<void>;
	onProgress?(progress: StageProgress): Promise<void>;
	onForkEvidence?(fork: Readonly<StageForkResult>): Promise<void>;
	onForkTiming?(fork: Readonly<StageForkResult>): Promise<void>;
};
export type StageGroupResult = {
	runId: string; seed: string; stage: Stage; firstArm: Arm; order: Arm[]; status: "complete" | "inconclusive" | "incomplete";
	steps: PromptStep[]; sources: Snapshots; checkpoints: Partial<Record<Arm, CheckpointEvidence>>;
	forks: StageForkResult[]; probes: PairProbe[]; stageEvidence: StageResult; crossStageExposure: string[]; errors: GroupError[]; stopReason: string | null;
	promptCounts: Record<Arm, number>; sentAttempts: Record<Arm, number>; cleanup: { complete: boolean };
	timing: ReturnType<typeof startOperation>; groupWallMs: Measurement<number>; preparationActiveMs: Record<Arm, Measurement<number>>;
	taskRecords: ReturnType<ReturnType<typeof createTaskRecorder>["records"]>;
	usageRecords: NonNullable<Snapshots[Arm]>["executionUsage"];
};

/** A stage owns two preparation sources and twelve isolated, one-question executions. */
export async function runStageGroup(options: StageGroupOptions): Promise<StageGroupResult> {
	const workload = options.workload ?? buildWorkload(options.seed), clock = options.clock ?? realClock;
	const timing = startOperation(clock), limits = { ...defaultLimits, ...options.limits }, guard = createRequestGuard(limits, clock);
	const recorder = createTaskRecorder(clock), errors: GroupError[] = [], sources: Snapshots = {}, created = new Map<Arm, EvalArm>();
	const sourceOwners: SessionOwner[] = [], privateCheckpoints = new Map<Arm, PrivateCheckpoint>(), checkpoints: StageGroupResult["checkpoints"] = {};
	const steps: PromptStep[] = [], forks: StageForkResult[] = [], probes: PairProbe[] = [];
	const order: Arm[] = options.firstArm === "baseline" ? ["baseline", "paging"] : ["paging", "baseline"];
	const stageEvidence: StageResult = { stage: options.stage, complete: false, valid: false, reason: null, qualifiedKnown: 0, probes, timing: [] };
	const life = createGroupLifecycle({ clock, deadlineMs: limits.maxPairMinutes * 60_000, guard, recorder, errors,
		createArm: options.createArm, cleanupSession: options.cleanupSession });
	let workIndex = 0, cleanup = { complete: false };
	async function send(step: PromptStep) {
		guard.check(); steps.push(step);
		for (const arm of order) {
			const instance = created.get(arm)!, owner = sourceOwners.find(owner => owner.arm === arm)!;
			guard.beginPrompt(arm, step.id, owner);
			sources[arm] = await life.wait(instance.runPrompt(step));
			if (!sameOwner(sources[arm]!.owner, owner) || sources[arm]!.errors.length) throw new Error("Source execution failed");
			guard.check();
			if (options.onProgress) await life.wait(options.onProgress({ type: "prompt-idle", seed: options.seed, stage: options.stage, step, arm,
				snapshots: { ...sources }, promptCounts: guard.promptCounts, sentAttempts: guard.sentAttempts }));
		}
	}
	async function execute(probe: Probe, arm: Arm): Promise<ProbeArmResult | null> {
		const checkpoint = privateCheckpoints.get(arm)!, evidence = checkpoints[arm]!;
		const owner: SessionOwner = { runId: options.runId, seed: options.seed, stage: options.stage, arm,
			sessionId: randomUUID(), checkpointId: evidence.checkpointId, forkId: randomUUID() };
		const provenance = restoreCheckpointData(checkpoint).provenance.map(([, promptId]) => promptId);
		const observation: { gate: ProbeGateResult | null } = { gate: null };
		let score: ProbeArmResult | null = null;
		const result = await life.wait(runProbeFork({ checkpoint, owner, step: probe.step, clock, taskRecorder: recorder,
			createArm: life.create, requestGuard: guard.beforeAttempt, cleanupSession: life.cleanup,
			beforePrompt: () => guard.beginPrompt(arm, probe.step.id, owner),
			payloadGuard: request => {
				if (request.purpose !== "conversation" || observation.gate) return;
				let gate = qualifyInitialProbe({ owner, probe: arm === "paging" ? probe : { ...probe, factId: null }, request,
					sourceFacts: workload.facts.filter(fact => fact.factId === probe.factId), latestFact: factForProbe(workload, probe), sourceProvenance: provenance,
					siblingProbeTexts: workload.probes[options.stage].filter(sibling => sibling.id !== probe.id).map(sibling => sibling.step.text) });
				if (arm === "baseline" && options.stage === "B" && workload.facts.filter(fact => fact.factId === probe.factId)
					.some(fact => !sourceExcluded(request, fact.sourcePromptId))) gate = { ...gate, failureCode: "baseline-source-visible" };
				observation.gate = gate;
				if (gate.failureCode) { guard.stop(gate.failureCode); guard.check(); }
			},
			score: fork => {
				if (!fork.snapshot) return;
				score = scoreProbeArm(workload, probe, fork.snapshot, { ...fork.snapshot, latencyMs: 0 });
				if (arm === "paging") score.evidence.qualified &&= observation.gate?.qualified === true;
			},
			writeEvidence: options.onForkEvidence ? fork => options.onForkEvidence!({ ...fork, probe, gate: observation.gate }) : undefined,
			writeTiming: options.onForkTiming ? fork => options.onForkTiming!({ ...fork, probe, gate: observation.gate }) : undefined,
		}).then(result => {
			// Lifecycle settlement must retain this fork even when wait() loses to the deadline.
			forks.push({ ...result, probe, gate: observation.gate });
			return result;
		}));
		const gate = observation.gate;
		if (result.failureCode || !gate || gate.failureCode) {
			const code = gate?.failureCode ?? result.failureCode ?? "probe-initial-payload-missing";
			errors.push({ code, arm, promptId: probe.step.id }); guard.stop(code); guard.check();
		}
		return score;
	}
	try {
		if (workload.seed !== options.seed || !["A", "B"].includes(options.stage) || !["baseline", "paging"].includes(options.firstArm)) throw new Error("Invalid stage workload");
		for (const arm of order) {
			const owner: SessionOwner = { runId: options.runId, stage: options.stage, seed: options.seed, arm, sessionId: randomUUID(), checkpointId: null, forkId: null };
			assertOwner(owner); sourceOwners.push(owner);
			const instance = await life.wait(life.create({ arm, owner, requestGuard: guard.beforeAttempt, clock, taskRecorder: recorder }));
			created.set(arm, instance); sources[arm] = instance.snapshot();
			if (!sameOwner(sources[arm]!.owner, owner) || sources[arm]!.arm !== arm || sources[arm]!.promptCount || sources[arm]!.requests.length
				|| sources[arm]!.recoveryResults.length || sources[arm]!.compactions.length || sources[arm]!.toolCalls.length) throw new Error("Fresh sources required");
		}
		if (sources.baseline!.metadataFingerprint !== sources.paging!.metadataFingerprint) throw new Error("Arm metadata mismatch");
		if (options.onReady) await life.wait(options.onReady(sources as Record<Arm, NonNullable<Snapshots[Arm]>>));
		for (const step of workload.seedSteps) await send(step);
		while (true) {
			const candidate = checkpointOpportunity(workload, options.stage, sources);
			if (candidate.reason === "baseline-compacted-before-stage-A") { stageEvidence.reason = candidate.reason; break; }
			if (steps.length >= 23 && candidate.ready) {
				for (const arm of order) {
					guard.check();
					const checkpoint = await life.wait(created.get(arm)!.captureCheckpoint());
					privateCheckpoints.set(arm, checkpoint); checkpoints[arm] = checkpointEvidence(checkpoint);
					if (checkpoints[arm]!.sourceSessionId !== sources[arm]!.owner.sessionId || checkpoints[arm]!.inheritedPromptCount < 23) throw new Error("Invalid source checkpoint");
					sources[arm] = created.get(arm)!.snapshot();
				}
				break;
			}
			if (steps.length >= limits.maxUserPrompts - 6) { guard.stop("max-user-prompts"); guard.check(); }
			await send(buildWorkStep(workload.seed, workIndex++));
		}
		if (privateCheckpoints.size === 2) for (const probe of workload.probes[options.stage]) {
			const results: Partial<Record<Arm, ProbeArmResult>> = {};
			for (const arm of order) { guard.check(); const result = await execute(probe, arm); if (result) results[arm] = result; }
			if (!results.baseline || !results.paging) throw new Error("Probe scoring missing");
			probes.push({ probe, baseline: results.baseline, paging: results.paging, comparisonEligible: true });
			const baseline = forks.find(fork => fork.probe.id === probe.id && fork.owner.arm === "baseline")!;
			stageEvidence.timing.push({ promptId: probe.step.id, baselineCompactionsBefore: successfulCompactions(sources.baseline),
				baselineCompactionsAfter: successfulCompactions(baseline.snapshot ?? undefined),
				baselineRequestId: baseline.snapshot?.requests.find(request => request.purpose === "conversation")?.requestId ?? null,
				pagingRequestId: forks.find(fork => fork.probe.id === probe.id && fork.owner.arm === "paging")?.snapshot?.requests[0]?.requestId ?? null });
		}
	} catch { if (!errors.length) errors.push({ code: guard.stopReason ?? "stage-group-error" }); }
	finally { cleanup = await life.finish(sourceOwners, (owner, snapshot) => { sources[owner.arm] = snapshot; }); }
	stageEvidence.complete = probes.length === 6;
	stageEvidence.qualifiedKnown = probes.filter(row => row.probe.factId !== null && row.paging.evidence.qualified).length;
	if (stageEvidence.complete && options.stage === "A" && stageEvidence.timing.some(row => row.baselineCompactionsAfter > 0)) stageEvidence.reason = "baseline-compacted-during-stage-A";
	if (stageEvidence.complete && probes.some(row => !row.baseline.traceComplete || !row.paging.traceComplete)) stageEvidence.reason ??= "missing-trace-evidence";
	if (stageEvidence.complete && stageEvidence.qualifiedKnown !== 5) stageEvidence.reason ??= "insufficient-qualified-known-probes";
	if (!stageEvidence.complete) stageEvidence.reason ??= "stage-not-completed";
	stageEvidence.valid = stageEvidence.complete && stageEvidence.reason === null && !errors.length && cleanup.complete && !guard.stopReason;
	const status = errors.length || guard.stopReason || !cleanup.complete ? "incomplete" : stageEvidence.valid ? "complete" : "inconclusive";
	finishOperation(timing, status === "incomplete" ? "failed" : "succeeded", clock);
	const taskRecords = recorder.records();
	for (const owner of sourceOwners) {
		const source = sources[owner.arm];
		if (source) sources[owner.arm] = { ...source, taskRecords: taskRecords.filter(row => sameOwner(owner, row)) };
	}
	for (const fork of forks) if (fork.snapshot) fork.snapshot = { ...fork.snapshot, taskRecords: fork.taskRecords };
	const preparationActiveMs = Object.fromEntries(order.map(arm => {
		const rows = taskRecords.filter(row => sourceOwners.some(owner => owner.arm === arm && sameOwner(owner, row))
			&& ["source-setup", "prompt", "checkpoint-capture"].includes(row.phase));
		if (!rows.length || rows.some(row => row.timing.durationMs.value === null)) return [arm,
			missing(rows.some(row => row.timing.durationMs.status === "invalid") ? "invalid" : "incomplete", "preparation-phase-boundary-missing")];
		const duration = elapsed(0, rows.reduce((total, row) => total + row.timing.durationMs.value!, 0));
		return [arm, { ...duration, status: duration.value === null ? duration.status : "derived" }];
	})) as Record<Arm, Measurement<number>>;
	const otherStageTexts = forks.flatMap(fork => fork.snapshot ? [fork.snapshot.finalAnswerText,
		...fork.snapshot.recoveryResults.filter(result => !result.isError).map(result => result.text)] : []);
	const crossStageExposure = options.stage === "A" ? [...new Set(workload.facts.filter(fact => fact.factId.startsWith("B-")
		&& matchFact(fact, otherStageTexts) === "match").map(fact => fact.factId))] : [];
	return { runId: options.runId, seed: options.seed, stage: options.stage, firstArm: options.firstArm, order, status, steps, sources, checkpoints,
		forks, probes, stageEvidence, crossStageExposure, errors, stopReason: guard.stopReason, promptCounts: guard.promptCounts, sentAttempts: guard.sentAttempts, cleanup,
		timing, groupWallMs: timing.durationMs, preparationActiveMs, taskRecords,
		usageRecords: [...Object.values(sources).flatMap(source => source?.executionUsage ?? []), ...forks.flatMap(fork => fork.snapshot?.executionUsage ?? [])] };
}
