import { sameModelMetadata } from "./experiment-identity.ts";
import { completeRequestMeasurements, sameOwner, type Measurement, type SessionOwner } from "./metrics.ts";
import { PAGING_RESTORATION_METHOD } from "./paging-replay.ts";
import { successfulCompactions, sourceExcluded } from "./pair-stages.ts";
import { qualifyInitialProbe } from "./probe-gate.ts";
import type { ArmSnapshot } from "./pi-arm.ts";
import type { StageGroupResult } from "./stage-group.ts";
import type { PhaseRecord } from "./task-metrics.ts";
import { buildWorkload, factForProbe, type Arm } from "./workload.ts";

export const observedDuration = (m: Measurement<number>) => m && m.value !== null && Number.isFinite(m.value) && m.value >= 0
	&& (m.status === "observed" || m.status === "derived");
function ownedSnapshot(snapshot: ArmSnapshot, owner: SessionOwner): boolean {
	return sameOwner(snapshot.owner, owner) && !snapshot.errors.length && snapshot.requests.length > 0
		&& snapshot.requests.every(r => sameOwner(r, owner) && r.complete)
		&& snapshot.requestRecords.length > 0 && snapshot.requestRecords.every(r => sameOwner(r, owner) && r.status === "succeeded"
			&& completeRequestMeasurements(r) && r.attempts.every(a => sameOwner(a, owner)
				&& a.requestId === r.requestId && a.promptId === r.promptId && a.purpose === r.purpose && observedDuration(a.attemptWallMs))
			&& snapshot.requests.some(p => p.requestId === r.requestId && p.promptId === r.promptId))
		&& snapshot.requests.every(p => snapshot.requestRecords.some(r => r.requestId === p.requestId && r.promptId === p.promptId))
		&& snapshot.executionUsage.every(r => sameOwner(r, owner) && snapshot.requestRecords.some(q => q.requestId === r.requestId
			&& q.attempts.some(a => a.attemptId === r.attemptId)));
}
function phases(rows: readonly PhaseRecord[], owner: SessionOwner, required: readonly PhaseRecord["phase"][]): boolean {
	const owned = rows.filter(r => sameOwner(r, owner));
	return required.every(phase => owned.some(r => r.phase === phase && r.timing.status === "succeeded"))
		&& owned.every(r => observedDuration(r.timing.durationMs) && r.timing.startMs !== null && r.timing.endMs !== null
			&& r.timing.endedAtUtc !== null && r.timing.endMs - r.timing.startMs === r.timing.durationMs.value);
}

/** Correctness and optional provider usage never decide structural recall eligibility. */
export function completeStageGroup(g: StageGroupResult): boolean {
	try {
		if (!["A", "B"].includes(g.stage) || g.status !== "complete" || g.errors.length || g.stopReason || !g.cleanup.complete
			|| g.steps.length < 23 || g.steps.some(s => s.kind === "probe") || g.forks.length !== 12 || g.probes.length !== 6
			|| !g.stageEvidence.complete || !g.stageEvidence.valid || g.stageEvidence.reason || g.stageEvidence.qualifiedKnown !== 5
			|| g.stageEvidence.timing.length !== 6 || !observedDuration(g.groupWallMs)) return false;
		const workload = buildWorkload(g.seed), expected = workload.probes[g.stage];
		const owners: SessionOwner[] = [], ids = new Set<string>(), forkIds = new Set<string>();
		for (const arm of ["baseline", "paging"] as const) {
			const source = g.sources[arm], cp = g.checkpoints[arm];
			if (!source || !cp || source.owner.runId !== g.runId || source.owner.stage !== g.stage || source.owner.seed !== g.seed
				|| source.owner.arm !== arm || source.owner.checkpointId !== null || source.owner.forkId !== null
				|| cp.sourceSessionId !== source.owner.sessionId || cp.inheritedPromptCount !== g.steps.length
				|| !/^[a-f0-9]{64}$/.test(cp.configurationFingerprint) || source.promptCount !== g.steps.length
				|| !ownedSnapshot(source, source.owner) || source.recoveryResults.length
				|| !phases(g.taskRecords, source.owner, ["source-setup", "prompt", "checkpoint-capture", "cleanup"])
				|| g.steps.some(s => !g.taskRecords.some(r => sameOwner(r, source.owner) && r.phase === "prompt" && r.promptId === s.id))
				|| !observedDuration(g.preparationActiveMs[arm]) || g.promptCounts[arm] !== g.steps.length + 6) return false;
			if (ids.has(source.owner.sessionId)) return false; ids.add(source.owner.sessionId); owners.push(source.owner);
			const forks = g.forks.filter(f => f.owner.arm === arm);
			if (forks.length !== 6 || forks.some((f, i) => f.probe.id !== expected[i].id)) return false;
			for (const f of forks) {
				const owner = f.owner, snapshot = f.snapshot;
				if (owner.runId !== g.runId || owner.stage !== g.stage || owner.seed !== g.seed || owner.checkpointId !== cp.checkpointId
					|| !owner.forkId || ids.has(owner.sessionId) || forkIds.has(owner.forkId) || f.failureCode || !f.cleanup.complete || f.cleanup.failureCode
					|| f.probe.stage !== g.stage || f.checkpoint.checkpointId !== cp.checkpointId || f.checkpoint.sourceSessionId !== cp.sourceSessionId
					|| f.checkpoint.configurationFingerprint !== cp.configurationFingerprint || f.inheritedPromptCount !== g.steps.length
					|| !f.restoration?.passed || f.restoration.failureCode || !f.restoration.checks.length || f.restoration.checks.some(c => !c.passed)
					|| f.restoration.method !== (arm === "paging" ? PAGING_RESTORATION_METHOD : "baseline-native-history-v1")
					|| !snapshot || snapshot.promptCount !== g.steps.length + 1 || !ownedSnapshot(snapshot, owner)
					|| !phases(f.taskRecords, owner, ["fork-setup", "checkpoint-restore", "prompt", "scoring", "artifact-write", "cleanup", "probe"])
					|| f.taskRecords.some(r => !sameOwner(r, owner)) || !observedDuration(f.probeTaskMs)
					|| snapshot.requestRecords.some(r => r.promptId !== f.probe.step.id) || f.gate?.failureCode || !f.gate) return false;
				ids.add(owner.sessionId); forkIds.add(owner.forkId); owners.push(owner);
				const request = snapshot.requests.find(r => r.purpose === "conversation")!;
				const facts = workload.facts.filter(fact => fact.factId === f.probe.factId);
				const gate = qualifyInitialProbe({ owner, probe: arm === "paging" ? f.probe : { ...f.probe, factId: null }, request,
					sourceFacts: facts, latestFact: factForProbe(workload, f.probe), sourceProvenance: source.origins.flatMap(o => o.sourcePromptId ? [o.sourcePromptId] : []),
					siblingProbeTexts: expected.filter(p => p.id !== f.probe.id).map(p => p.step.text) });
				if (gate.failureCode || arm === "paging" && f.probe.factId !== null && (!gate.qualified || !f.gate.qualified)) return false;
				if (arm === "baseline" && (g.stage === "A" ? successfulCompactions(snapshot) > 0
					: successfulCompactions(source) < 1 || facts.some(fact => !sourceExcluded(request, fact.sourcePromptId)))) return false;
			}
			const attempts = [source, ...forks.map(f => f.snapshot!)].flatMap(s => s.requestRecords).reduce((n, r) => n + r.attempts.length, 0);
			if (attempts !== g.sentAttempts[arm]) return false;
		}
		return g.taskRecords.every(r => owners.some(o => sameOwner(o, r)))
			&& sameModelMetadata(g.sources.baseline!.modelMetadata, g.sources.paging!.modelMetadata)
			&& g.probes.every((p, i) => p.probe.id === expected[i].id && p.probe.stage === g.stage && p.comparisonEligible
				&& p.baseline.traceComplete && p.paging.traceComplete && (p.probe.factId === null || p.paging.evidence.qualified));
	} catch { return false; }
}
