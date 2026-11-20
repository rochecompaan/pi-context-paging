import assert from "node:assert/strict";
import test from "node:test";
import { completeGroup } from "./fixtures/eval-recall-groups.ts";
import { completeStageGroup, observedDuration } from "../eval/recall/eligibility.ts";
import type { Measurement, MeasurementStatus } from "../eval/recall/metrics.ts";
import type { ArmSnapshot } from "../eval/recall/pi-arm.ts";
import type { StageGroupResult } from "../eval/recall/stage-group.ts";

/**
 * `completeStageGroup` is what lets the harness say a pair is eligible at all: five qualified known
 * probes per stage plus an unknown control, every fork restored through the right method, every
 * record owned by a session in this group. A gate that shape is easy to write and easy to break
 * silently, so it is tested against a group the harness really produced — not a hand-written one.
 */
let built: Promise<StageGroupResult> | undefined;
const groupA = () => (built ??= completeGroup("A"));

/** Rewrites every owner-identifying field in a subtree, so a defect touches only what it names. */
function rehome(value: unknown, from: string, to: string): void {
	if (Array.isArray(value)) { for (const item of value) rehome(item, from, to); return; }
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (record.sessionId === from) record.sessionId = to;
		for (const nested of Object.values(record)) rehome(nested, from, to);
	}
}

const duration = (value: number | null, status: MeasurementStatus): Measurement<number> =>
	({ value, status, reason: value === null ? "no-observations" : null });

test("a real, fully-formed stage group is eligible on both stages", async () => {
	for (const stage of ["A", "B"] as const) {
		const group = await completeGroup(stage);
		assert.equal(completeStageGroup(group), true, `stage ${stage}`);
	}
});

test("the gate reads the result without changing it, so artifacts keep their source shape", async () => {
	const group = await groupA();
	const before = JSON.stringify(group);
	completeStageGroup(group);
	assert.equal(JSON.stringify(group), before);
});

test("an observed duration is finite and non-negative, and everything else is not an observation", () => {
	for (const value of [0, 1, 1_234.5]) {
		assert.equal(observedDuration(duration(value, "observed")), true, String(value));
		assert.equal(observedDuration(duration(value, "derived")), true, String(value));
	}
	for (const sample of [duration(null, "not-reported"), duration(null, "not-supported"), duration(Number.NaN, "observed"), duration(Number.POSITIVE_INFINITY, "observed"),
		duration(-1, "observed"), duration(-0.5, "derived"), duration(5, "invalid"), duration(5, "not-applicable"), duration(5, "incomplete")]) {
		assert.equal(observedDuration(sample), false, `${sample.status} ${String(sample.value)}`);
	}
});

test("the gate rejects a group whose evidence, ownership, ordering, timing, or accounting is broken", async () => {
	const group = await groupA();
	const pagingForks = (g: StageGroupResult) => g.forks.filter(fork => fork.owner.arm === "paging");
	const defects: [string, (g: StageGroupResult) => void][] = [
		["four qualified known probes", g => { g.stageEvidence.qualifiedKnown = 4; }],
		["six qualified known probes (double counting)", g => { g.stageEvidence.qualifiedKnown = 6; }],
		["stage evidence carries a reason", g => { g.stageEvidence.reason = "probe-answer-visible"; }],
		["stage evidence incomplete", g => { g.stageEvidence.complete = false; }],
		["group stopped early", g => { g.stopReason = "max-requests-per-arm"; }],
		["cleanup reported incomplete", g => { g.cleanup.complete = false; }],
		["wall time never observed", g => { g.groupWallMs = duration(null, "not-reported"); }],
		["paging probe gate unqualified", g => { const fork = pagingForks(g).find(f => f.probe.factId)!; fork.gate = { ...fork.gate!, qualified: false }; }],
		["fork reported a failure code", g => { g.forks[7].failureCode = "fork-prompt-failed"; }],
		["fork cleanup incomplete", g => { g.forks[7].cleanup = { ...g.forks[7].cleanup, complete: false }; }],
		["probe excluded from comparison", g => { g.probes[0].comparisonEligible = false; }],
		["paging probe evidence unqualified", g => { g.probes[0].paging.evidence = { ...g.probes[0].paging.evidence, qualified: false }; }],
		["arms measured different models", g => { g.sources.paging!.modelMetadata = { ...g.sources.paging!.modelMetadata, id: "other-model" }; }],
		["sent attempt count disagrees with the records", g => { g.sentAttempts.baseline += 1; }],
		["paging restored through the baseline method", g => { const fork = pagingForks(g)[0]; fork.restoration = { ...fork.restoration!, method: "baseline-native-history-v1" }; }],
		["snapshot owned by another session", g => { const fork = pagingForks(g)[0];
			fork.snapshot = { ...fork.snapshot!, owner: { ...fork.snapshot!.owner, sessionId: "someone-else" } } as ArmSnapshot; }],
		["two records share one session id", g => { const fork = pagingForks(g)[0];
			const owner = { ...fork.owner, sessionId: g.sources.paging!.owner.sessionId };
			fork.owner = owner; fork.snapshot = { ...fork.snapshot!, owner } as ArmSnapshot; }],
		["two forks share one session id", g => {
			// Distinct fork ids, one session id, and every record of the second fork rewritten to match,
			// so only the gate's session-uniqueness rule can catch it.
			const indexes = g.forks.map((fork, index) => [fork, index] as const).filter(([fork]) => fork.owner.arm === "paging").map(([, index]) => index);
			const taken = g.forks[indexes[0]].owner.sessionId, stolen = g.forks[indexes[1]].owner.sessionId;
			rehome(g, stolen, taken);
		}],
		["fork is missing its scoring phase", g => { const fork = pagingForks(g)[0];
			g.taskRecords = g.taskRecords.filter(r => !(r.sessionId === fork.owner.sessionId && r.phase === "scoring"));
			fork.taskRecords = fork.taskRecords.filter(r => r.phase !== "scoring"); }],
		["a timing record belongs to no session in the group", g => { g.taskRecords = [...g.taskRecords, { ...g.taskRecords[0], sessionId: "stranger", runId: "other-run" }]; }],
		["prompt count off by one", g => { g.promptCounts.paging += 1; }],
		["phase duration disagrees with its own start and end", g => { const row = g.taskRecords.find(r => r.phase === "prompt")!;
			row.timing.durationMs = { ...row.timing.durationMs, value: row.timing.durationMs.value! + 1 }; }],
		["paging fork order does not match the workload", g => { const [first, second] = g.forks.map((fork, index) => [fork, index] as const)
			.filter(([fork]) => fork.owner.arm === "paging").map(([, index]) => index);
			[g.forks[first], g.forks[second]] = [g.forks[second], g.forks[first]]; }],
		["baseline fork order does not match the workload", g => { const indexes = g.forks.map((fork, index) => [fork, index] as const)
			.filter(([fork]) => fork.owner.arm === "baseline").map(([, index]) => index);
			[g.forks[indexes[2]], g.forks[indexes[4]]] = [g.forks[indexes[4]], g.forks[indexes[2]]]; }],
		["source carries a recovery result", g => { g.sources.paging!.recoveryResults = [{ code: "unjoined-recovery-result" } as unknown as ArmSnapshot["recoveryResults"][number]]; }],
	];
	const pristine = JSON.stringify(group);
	for (const [name, defect] of defects) {
		const candidate = JSON.parse(pristine) as StageGroupResult;
		defect(candidate);
		assert.equal(completeStageGroup(candidate), false, name);
	}
	assert.equal(completeStageGroup(group), true, "the pristine group stays eligible");
});
