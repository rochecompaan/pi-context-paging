import { buildWorkload, buildWorkStep, type Arm, type PromptStep, type Workload } from "./workload.ts";
import { realClock, type ArmSnapshot, type Clock, type EvalArm } from "./pi-arm.ts";
import { createRequestGuard, defaultLimits, type EvalLimits } from "./request-guard.ts";
import { exposures, finishStage, scoreProbeArm, stageOpportunity, successfulCompactions,
	type PairProbe, type Snapshots, type StageResult } from "./pair-stages.ts";
import type { RequestMeta } from "./codex-payload.ts";

export type PairProgress = { type: "prompt-idle"; seed: string; step: PromptStep; arm: Arm; snapshots: Snapshots;
	promptCounts: Record<Arm, number>; sentAttempts: Record<Arm, number> };
export type PairOptions = {
	seed: string; firstArm: Arm; workload?: Workload; limits?: Partial<EvalLimits>; clock?: Clock;
	createArm(options: { arm: Arm; requestGuard: (meta: RequestMeta) => void; clock: Clock }): Promise<EvalArm>;
	onReady?(snapshots: Readonly<Record<Arm, ArmSnapshot>>): Promise<void>;
	onProgress?(progress: PairProgress): Promise<void>;
};
export type PairResult = {
	seed: string; firstArm: Arm; status: "complete" | "inconclusive" | "incomplete"; steps: PromptStep[];
	snapshots: Snapshots; probes: PairProbe[]; stages: { A: StageResult; B: StageResult };
	crossStageExposure: string[]; errors: { code: string; arm?: Arm; promptId?: string | null }[];
	stopReason: string | null; promptCounts: Record<Arm, number>; sentAttempts: Record<Arm, number>; latencyMs: number;
};
const emptyStage = (stage: "A" | "B"): StageResult => ({ stage, complete: false, valid: false, reason: null,
	qualifiedKnown: 0, probes: [], timing: [] });

/** One shared sequence. Scores never choose whether pressure work has reached a stage. */
export async function runPair(options: PairOptions): Promise<PairResult> {
	const workload = options.workload ?? buildWorkload(options.seed), clock = options.clock ?? realClock;
	const limits = { ...defaultLimits, ...options.limits }, guard = createRequestGuard(limits, clock);
	const started = clock.nowMs(), created = new Map<Arm, EvalArm>();
	const snapshots: Snapshots = {}, steps: PromptStep[] = [], probes: PairProbe[] = [];
	const stages = { A: emptyStage("A"), B: emptyStage("B") }, exposure = new Set<string>();
	const errors: PairResult["errors"] = [], aborts: Promise<unknown>[] = [];
	const order: Arm[] = options.firstArm === "baseline" ? ["baseline", "paging"] : ["paging", "baseline"];
	let closed = false, workIndex = 0, expire!: () => void;
	const expired = new Promise<void>(resolve => { expire = resolve; });
	const wait = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, expired.then(() => { throw new Error("Pair deadline"); })]);
	const timer = clock.setTimeout(() => {
		guard.stop("max-pair-minutes"); expire();
		for (const arm of created.values()) aborts.push(arm.abort().catch(() => { errors.push({ code: "abort-error" }); }));
	}, limits.maxPairMinutes * 60_000);
	const check = () => guard.check();
	const send = async (step: PromptStep) => {
		check(); steps.push(step);
		for (const arm of order) {
			check(); guard.beginPrompt(arm, step.id);
			snapshots[arm] = await wait(created.get(arm)!.runPrompt(step));
			if (snapshots[arm]!.errors.length) {
				errors.push(...snapshots[arm]!.errors.map(error => ({ ...error, arm })));
				throw new Error("Arm error");
			}
			check();
			await options.onProgress?.({ type: "prompt-idle", seed: workload.seed, step, arm, snapshots: { ...snapshots },
				promptCounts: guard.promptCounts, sentAttempts: guard.sentAttempts });
		}
	};
	const work = async (reserved: number) => {
		if (steps.length >= limits.maxUserPrompts - reserved) {
			guard.stop("max-user-prompts"); check();
		}
		await send(buildWorkStep(workload.seed, workIndex++));
	};
	const group = async (stage: "A" | "B") => {
		for (const probe of workload.probes[stage]) {
			const before = { ...snapshots } as Record<Arm, ArmSnapshot>;
			await send(probe.step);
			const result: PairProbe = { probe, baseline: scoreProbeArm(workload, probe, snapshots.baseline!, before.baseline),
				paging: scoreProbeArm(workload, probe, snapshots.paging!, before.paging),
				comparisonEligible: !probe.factId || !exposure.has(probe.factId) };
			for (const id of exposures(workload, probe, snapshots, result)) exposure.add(id);
			probes.push(result); stages[stage].probes.push(result);
			stages[stage].timing.push({ promptId: probe.step.id,
				baselineCompactionsBefore: successfulCompactions(before.baseline), baselineCompactionsAfter: successfulCompactions(snapshots.baseline),
				baselineRequestId: snapshots.baseline!.requests.find(request => request.promptId === probe.step.id && request.purpose === "conversation")?.requestId ?? null,
				pagingRequestId: snapshots.paging!.requests.find(request => request.promptId === probe.step.id && request.purpose === "conversation")?.requestId ?? null });
		}
		finishStage(stages[stage], workload, snapshots, exposure);
	};
	try {
		if (workload.seed !== options.seed) throw new Error("Workload seed mismatch");
		for (const arm of ["baseline", "paging"] as const) {
			check();
			const pending = options.createArm({ arm, requestGuard: guard.beforeAttempt, clock }).then(async instance => {
				if (closed) { try { await instance.abort(); } finally { instance.dispose(); } }
				else { created.set(arm, instance); snapshots[arm] = instance.snapshot(); }
				return instance;
			});
			await wait(pending);
		}
		if (snapshots.baseline!.metadataFingerprint !== snapshots.paging!.metadataFingerprint) throw new Error("Arm metadata mismatch");
		await options.onReady?.(snapshots as Record<Arm, ArmSnapshot>);
		for (const step of workload.seedSteps) await send(step);
		while (!stageOpportunity("A", workload, snapshots) && !successfulCompactions(snapshots.baseline)) await work(12);
		if (successfulCompactions(snapshots.baseline)) stages.A.reason = "baseline-compacted-before-stage-A";
		else await group("A");
		// Even an inconclusive A can leave a separately labeled B observation.
		await work(6);
		while (!stageOpportunity("B", workload, snapshots) || steps.length + workload.probes.B.length < 24) await work(6);
		await group("B");
	} catch {
		if (!errors.length) errors.push({ code: guard.stopReason ?? "pair-error" });
	} finally {
		closed = true; clock.clearTimeout(timer);
		await Promise.allSettled([...aborts, ...[...created.values()].map(async instance => {
			try { await instance.abort(); } catch { errors.push({ code: "abort-error" }); }
		})]);
		for (const [arm, instance] of created) {
			try { snapshots[arm] = instance.snapshot(); } catch { errors.push({ code: "snapshot-error", arm }); }
			try { instance.dispose(); } catch { errors.push({ code: "dispose-error", arm }); }
		}
	}
	for (const stage of ["A", "B"] as const) finishStage(stages[stage], workload, snapshots, exposure);
	const status = errors.length || guard.stopReason || !stages.B.complete ? "incomplete"
		: stages.A.valid && stages.B.valid && guard.promptCounts.baseline >= 24 && guard.promptCounts.paging >= 24 ? "complete" : "inconclusive";
	return { seed: workload.seed, firstArm: options.firstArm, status, steps, snapshots, probes, stages,
		crossStageExposure: [...exposure].sort(), errors, stopReason: guard.stopReason,
		promptCounts: guard.promptCounts, sentAttempts: guard.sentAttempts, latencyMs: clock.nowMs() - started };
}
