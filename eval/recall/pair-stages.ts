import { analyzeProbe, type ProbeEvidence } from "./evidence.ts";
import { scoreAnswer, type ProbeScore } from "./scoring.ts";
import { factForProbe, type Arm, type Probe, type Stage, type Workload } from "./workload.ts";
import type { ArmSnapshot } from "./pi-arm.ts";
import type { RequestEvidence } from "./codex-payload.ts";
import { sameOwner } from "./metrics.ts";
import { readableAnswerMatch } from "./probe-gate.ts";

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
/** Observed candidate boundary: all five targets and every supplied source version. */
export function checkpointOpportunity(workload: Workload, stage: Stage, snapshots: Snapshots): {
	ready: boolean; qualifiedKnown: number; reason: string | null;
} {
	const paging = latestConversation(snapshots.paging), baseline = latestConversation(snapshots.baseline);
	const fail = (reason: string, qualifiedKnown = 0) => ({ ready: false, qualifiedKnown, reason });
	if (!paging?.complete || !baseline?.complete || !snapshots.paging || !snapshots.baseline
		|| !sameOwner(paging, snapshots.paging.owner) || !sameOwner(baseline, snapshots.baseline.owner)) return fail("candidate-evidence-incomplete");
	const known = workload.probes[stage].filter(probe => probe.factId !== null);
	const qualifiedKnown = known.filter(probe => workload.facts.filter(fact => fact.factId === probe.factId)
		.every(fact => sourceExcluded(paging, fact.sourcePromptId)
			&& snapshots.paging!.origins.some(origin => origin.sourcePromptId === fact.sourcePromptId))
		&& readableAnswerMatch(factForProbe(workload, probe)!, paging.blocks.map(block => block.text)) === "none").length;
	if (stage === "A" && successfulCompactions(snapshots.baseline)) return fail("baseline-compacted-before-stage-A", qualifiedKnown);
	if (qualifiedKnown !== 5 || known.length !== 5) return fail("paging-targets-not-excluded", qualifiedKnown);
	if (stage === "B" && (!successfulCompactions(snapshots.baseline) || known.some(probe => workload.facts
		.filter(fact => fact.factId === probe.factId).some(fact => !sourceExcluded(baseline, fact.sourcePromptId))))) {
		return fail("baseline-native-boundary-not-ready", qualifiedKnown);
	}
	return { ready: true, qualifiedKnown, reason: null };
}

export function scoreProbeArm(workload: Workload, probe: Probe, snapshot: ArmSnapshot, before: ArmSnapshot): ProbeArmResult {
	const fact = factForProbe(workload, probe);
	const score = scoreAnswer(probe, fact?.value ?? null, snapshot.finalAnswerText);
	const requests = snapshot.requests.filter(request => request.promptId === probe.step.id && request.purpose === "conversation");
	const initial = requests[0] ?? { requestId: "missing", promptId: probe.step.id, arm: snapshot.arm,
		purpose: "conversation" as const, complete: false, blocks: [], opaque: { count: 0, hashes: [] } };
	return { score, latencyMs: snapshot.latencyMs - before.latencyMs, traceComplete: requests.length > 0 && requests.every(request => request.complete),
		evidence: analyzeProbe({ probe, fact, initial, followUps: requests.slice(1), recoveryResults: snapshot.recoveryResults,
			observedCalls: snapshot.toolCalls,
			score, finalAnswerEventIndex: snapshot.finalAnswerEventIndex }) };
}
