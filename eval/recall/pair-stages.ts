import { analyzeProbe, matchFact, type ProbeEvidence } from "./evidence.ts";
import { scoreAnswer, type ProbeScore } from "./scoring.ts";
import { factForProbe, type Arm, type Probe, type Stage, type Workload } from "./workload.ts";
import type { ArmSnapshot } from "./pi-arm.ts";
import type { RequestEvidence } from "./codex-payload.ts";

export type ProbeArmResult = { score: ProbeScore; evidence: ProbeEvidence; latencyMs: number; traceComplete: boolean };
export type PairProbe = { probe: Probe; baseline: ProbeArmResult; paging: ProbeArmResult; comparisonEligible: boolean };
export type ProbeTiming = {
	promptId: string; baselineCompactionsBefore: number; baselineCompactionsAfter: number;
	baselineRequestId: string | null; pagingRequestId: string | null;
};
export type StageResult = { stage: Stage; complete: boolean; valid: boolean; reason: string | null;
	qualifiedKnown: number; probes: PairProbe[]; timing: ProbeTiming[] };
export type Snapshots = Partial<Record<Arm, ArmSnapshot>>;

export function successfulCompactions(snapshot: ArmSnapshot | undefined): number {
	return snapshot?.compactions.filter(event => event.success).length ?? 0;
}
export function latestConversation(snapshot: ArmSnapshot | undefined): RequestEvidence | undefined {
	return snapshot ? [...snapshot.requests].reverse().find(request => request.purpose === "conversation") : undefined;
}
export function sourceExcluded(request: RequestEvidence | undefined, sourcePromptId: string): boolean {
	return !!request?.complete && !request.blocks.some(block => block.role === "user" && block.sourcePromptId === sourcePromptId);
}
export function stageOpportunity(stage: Stage, workload: Workload, snapshots: Snapshots): boolean {
	const paging = latestConversation(snapshots.paging), baseline = latestConversation(snapshots.baseline);
	if (!paging?.complete || !baseline?.complete) return false;
	const known = workload.probes[stage].filter(probe => probe.factId);
	if (stage === "A") return !successfulCompactions(snapshots.baseline) && known.filter(probe => {
		const fact = factForProbe(workload, probe)!;
		return sourceExcluded(paging, fact.sourcePromptId) && matchFact(fact, paging.blocks.map(block => block.text)) === "none";
	}).length >= 4;
	return successfulCompactions(snapshots.baseline) > 0 && known.every(probe => sourceExcluded(baseline, factForProbe(workload, probe)!.sourcePromptId));
}

export function scoreProbeArm(workload: Workload, probe: Probe, snapshot: ArmSnapshot, before: ArmSnapshot): ProbeArmResult {
	const fact = factForProbe(workload, probe);
	const score = scoreAnswer(probe, fact?.value ?? null, snapshot.finalAnswerText);
	const requests = snapshot.requests.filter(request => request.promptId === probe.step.id && request.purpose === "conversation");
	const initial = requests[0] ?? { requestId: "missing", promptId: probe.step.id, arm: snapshot.arm,
		purpose: "conversation" as const, complete: false, blocks: [], opaque: { count: 0, hashes: [] } };
	return { score, latencyMs: snapshot.latencyMs - before.latencyMs, traceComplete: requests.length > 0 && requests.every(request => request.complete),
		evidence: analyzeProbe({ probe, fact, initial, followUps: requests.slice(1), recoveryResults: snapshot.recoveryResults,
			score, finalAnswerEventIndex: snapshot.finalAnswerEventIndex }) };
}

export function exposures(workload: Workload, probe: Probe, snapshots: Snapshots, result: PairProbe): string[] {
	if (probe.stage !== "A") return [];
	const texts = (["baseline", "paging"] as const).flatMap(arm => [snapshots[arm]!.finalAnswerText, result[arm].score.actual ?? "",
		...snapshots[arm]!.recoveryResults.filter(event => event.promptId === probe.step.id && !event.isError).map(event => event.text)]);
	return [...new Set(workload.facts.filter(fact => fact.factId.startsWith("B-") && matchFact(fact, texts) === "match").map(fact => fact.factId))];
}
export function finishStage(stage: StageResult, workload: Workload, snapshots: Snapshots, exposure: ReadonlySet<string>): void {
	stage.complete = stage.probes.length === workload.probes[stage.stage].length;
	stage.qualifiedKnown = stage.probes.filter(probe => probe.probe.factId && probe.paging.evidence.qualified).length;
	if (!stage.complete) stage.reason ??= "stage-not-completed";
	else if (stage.stage === "A" && stage.timing.some(time => time.baselineCompactionsAfter > 0)) stage.reason = "baseline-compacted-during-stage-A";
	else if (stage.probes.some(probe => !probe.baseline.traceComplete || !probe.paging.traceComplete)) stage.reason = "missing-trace-evidence";
	else if (stage.stage === "A" && stage.qualifiedKnown < 4) stage.reason = "insufficient-qualified-known-probes";
	else if (stage.stage === "B" && !successfulCompactions(snapshots.baseline)) stage.reason = "no-successful-baseline-compaction";
	else if (stage.stage === "B" && stage.probes.some(probe => {
		const fact = factForProbe(workload, probe.probe);
		const initial = snapshots.baseline!.requests.find(request => request.promptId === probe.probe.step.id && request.purpose === "conversation");
		return fact && !sourceExcluded(initial, fact.sourcePromptId);
	})) stage.reason = "baseline-source-still-resident";
	else if (stage.stage === "B" && exposure.size > 0) stage.reason = "cross-stage-exposure";
	stage.valid = stage.complete && stage.reason === null;
}
