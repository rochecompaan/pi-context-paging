import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkload, factForProbe, type FactVersion, type Probe, type Stage, type Workload } from "../eval/recall/workload.ts";
import { checkpointOpportunity, latestConversation } from "../eval/recall/pair-stages.ts";
import type { ArmSnapshot } from "../eval/recall/pi-arm.ts";
import type { RequestEvidence } from "../eval/recall/codex-payload.ts";
import type { CompactionEvent } from "../eval/recall/pi-journal.ts";
import { completeGroups } from "./fixtures/eval-recall-groups.ts";
import type { StageGroupResult } from "../eval/recall/stage-group.ts";

/**
 * `checkpointOpportunity` decides the one moment the experiment forks: the stage loop keeps sending
 * work until this gate says `ready`, then captures the checkpoint both arms resume from. A boundary
 * accepted on false grounds forks the arms at a point where the targets were never paged out, so the
 * published paging comparison measures nothing; a boundary never accepted burns the prompt budget.
 * These tests pin every reason the gate refuses, using real stage groups so the accepted case is a
 * real boundary rather than a hand-drawn one.
 */
const workload: Workload = buildWorkload("checkpoint-boundary-seed");
const groups = await completeGroups();
const groupA = groups.find(group => group.stage === "A")!;
const groupB = groups.find(group => group.stage === "B")!;
const sourcesOf = (group: StageGroupResult) => ({ paging: group.sources.paging, baseline: group.sources.baseline });
const known = (stage: Stage) => workload.probes[stage].filter(probe => probe.factId !== null);
const factsOf = (stage: Stage) => known(stage).map(probe => factForProbe(workload, probe)!);

function patchLatest(snapshot: ArmSnapshot, patch: (request: RequestEvidence) => RequestEvidence): ArmSnapshot {
	const latest = latestConversation(snapshot)!;
	return { ...snapshot, requests: snapshot.requests.map(request => request === latest ? patch(request) : request) };
}

test("a real stage group offers a ready boundary for its own stage", () => {
	for (const group of [groupA, groupB]) {
		const candidate = checkpointOpportunity(workload, group.stage, sourcesOf(group));
		assert.equal(candidate.reason, null);
		assert.equal(candidate.ready, true, `stage ${group.stage} ends at a real paging boundary`);
		assert.equal(candidate.qualifiedKnown, 5, "all five fact categories are out of the paging request");
	}
});

test("the same evidence is a valid stage-A boundary and an invalid stage-B boundary", () => {
	const asB = checkpointOpportunity(workload, "B", sourcesOf(groupA));
	assert.equal(asB.ready, false);
	assert.equal(asB.reason, "baseline-native-boundary-not-ready",
		"stage B compares paging against the native arm's compaction, so a baseline that has not compacted is not a boundary");
	assert.equal(asB.qualifiedKnown, 5, "the paging side is ready; only the native arm is behind");
	const asA = checkpointOpportunity(workload, "A", sourcesOf(groupB));
	assert.equal(asA.ready, false);
	assert.equal(asA.reason, "baseline-compacted-before-stage-A",
		"stage A compares paging against resident native context, so a baseline that already compacted is unusable");
	assert.equal(asA.qualifiedKnown, 5, "the count is kept for the stage report even when the stage aborts");
});

test("the candidate request must be complete and belong to its own session", () => {
	const sources = sourcesOf(groupA);
	const paging = sources.paging!, baseline = sources.baseline!;
	assert.equal(checkpointOpportunity(workload, "A", { baseline }).reason, "candidate-evidence-incomplete", "no paging snapshot, no boundary");
	assert.equal(checkpointOpportunity(workload, "A", { paging }).reason, "candidate-evidence-incomplete", "no baseline snapshot, no boundary");
	assert.equal(checkpointOpportunity(workload, "A", { paging: undefined, baseline }).reason, "candidate-evidence-incomplete");
	const base = sourcesOf(groupA);
	for (const arm of ["paging", "baseline"] as const) {
		const snapshot = arm === "paging" ? paging : baseline;
		const withArm = (value: ArmSnapshot) => arm === "paging" ? { ...base, paging: value } : { ...base, baseline: value };
		assert.equal(checkpointOpportunity(workload, "A", withArm(patchLatest(snapshot, request => ({ ...request, complete: false })))).reason,
			"candidate-evidence-incomplete", `an incomplete ${arm} request cannot be the boundary`);
		assert.equal(checkpointOpportunity(workload, "A", withArm(patchLatest(snapshot, request => ({ ...request, sessionId: "another-session" })))).reason,
			"candidate-evidence-incomplete", `a ${arm} request from another session is not this run's evidence`);
		assert.equal(checkpointOpportunity(workload, "A", withArm({ ...snapshot, requests: [] })).reason, "candidate-evidence-incomplete",
			`a ${arm} snapshot with no conversation request has no boundary`);
	}
	assert.equal(checkpointOpportunity(workload, "A", sourcesOf(groupA)).ready, true, "the untouched pair is still ready");
});

test("a target is excluded only when it was in the session and is now out of the request", () => {
	const stage: Stage = "A";
	const base = sourcesOf(groupA);
	const [first, ...rest] = factsOf(stage);
	const droppedFromOrigins: ArmSnapshot = { ...base.paging!,
		origins: base.paging!.origins.filter((origin: { sourcePromptId?: string }) => origin.sourcePromptId !== first.sourcePromptId) };
	const gone = checkpointOpportunity(workload, stage, { ...base, paging: droppedFromOrigins });
	assert.equal(gone.ready, false);
	assert.equal(gone.reason, "paging-targets-not-excluded");
	assert.equal(gone.qualifiedKnown, 4,
		"a target whose source never appears in the session was never paged out, so it does not qualify the boundary");
	const resident = checkpointOpportunity(workload, stage, { ...base,
		paging: patchLatest(base.paging!, request => ({ ...request, blocks: [...request.blocks,
			{ role: "user", text: "carried forward", sourcePromptId: first.sourcePromptId }] })) });
	assert.equal(resident.reason, "paging-targets-not-excluded");
	assert.equal(resident.qualifiedKnown, 4, "a source still present in the request is not an excluded target");
	const readable = checkpointOpportunity(workload, stage, { ...base,
		paging: patchLatest(base.paging!, request => ({ ...request, blocks: [...request.blocks,
			{ role: "assistant", text: `Recorded value: ${first.value}` }] })) });
	assert.equal(readable.reason, "paging-targets-not-excluded");
	assert.equal(readable.qualifiedKnown, 4, "an answer legible in the request leaks the target");
	assert.equal(checkpointOpportunity(workload, stage, { ...base, paging: patchLatest(base.paging!, request => ({ ...request,
		blocks: [...request.blocks, { role: "assistant", text: `Recorded value: ${first.value.split("").reverse().join("")}` }] })) }).ready, true,
	"the check reads the value, not any text in the request");
	assert.equal(rest.length, 4);
});

test("a bare quantity number in the request disqualifies the boundary", () => {
	const stage: Stage = "A";
	const base = sourcesOf(groupA);
	const quantity = factsOf(stage).find(fact => fact.category === "quantity")!;
	const number = quantity.value.split(" ")[0];
	assert.notEqual(quantity.value, number, "the quantity value carries a unit, so a bare number is a partial leak");
	const leaked = checkpointOpportunity(workload, stage, { ...base, paging: patchLatest(base.paging!, request => ({ ...request,
		blocks: [...request.blocks, { role: "assistant", text: `The measured value was ${number} on the canary.` }] })) });
	assert.equal(leaked.ready, false);
	assert.equal(leaked.reason, "paging-targets-not-excluded");
	assert.equal(leaked.qualifiedKnown, 4, "the number alone is enough to make the quantity answer reachable");
	const inside = checkpointOpportunity(workload, stage, { ...base, paging: patchLatest(base.paging!, request => ({ ...request,
		blocks: [...request.blocks, { role: "assistant", text: `window 1${number}7 stayed open until 2${number}` }] })) });
	assert.equal(inside.ready, true, "a digit embedded inside a longer number is not the quantity");
});

test("the gate requires all five categories to exist, not just to qualify", () => {
	const stage: Stage = "A";
	const base = sourcesOf(groupA);
	const trimmed: Workload = { ...workload, probes: { A: known("A").slice(0, 4), B: known("B") } };
	const candidate = checkpointOpportunity(trimmed, stage, base);
	assert.equal(candidate.ready, false);
	assert.equal(candidate.reason, "paging-targets-not-excluded",
		"a workload that probes four of five categories does not earn a fork boundary");
	assert.equal(candidate.qualifiedKnown, 4, "the report still shows what qualified");
	assert.equal(checkpointOpportunity(workload, stage, base).ready, true, "the full five-category workload is accepted");
	// Five qualified targets are not enough if the workload asks for six, and the sixth cannot qualify:
	// its source was never part of this session, so it can never have been paged out.
	const neverPresent = { factId: "A-extra", category: "id", version: 1, value: "extra-never-in-context-4f2a",
		sourcePromptId: "seed-A-extra-v1", subject: "Extra-4f2a", field: "recovery_token", uniqueLiteral: true } as FactVersion;
	assert.ok(!base.paging!.origins.some((origin: { sourcePromptId?: string }) => origin.sourcePromptId === neverPresent.sourcePromptId),
		"the extra target's source is not part of this session");
	const extra: Probe = { id: "probe-A-extra", stage: "A", factId: neverPresent.factId,
		step: { id: "probe-A-extra-step", kind: "probe", text: "Extra target", stage: "A", probeId: "probe-A-extra" } };
	const widened = checkpointOpportunity({ ...workload, facts: [...workload.facts, neverPresent],
		probes: { A: [...known("A"), extra], B: workload.probes.B } }, stage, base);
	assert.equal(widened.ready, false);
	assert.equal(widened.reason, "paging-targets-not-excluded");
	assert.equal(widened.qualifiedKnown, 5, "five targets qualify, but the workload asked for six, so no fork happens");
});

test("stage B waits for the native arm's compaction and for its sources to leave", () => {
	const base = sourcesOf(groupB);
	assert.equal(checkpointOpportunity(workload, "B", base).ready, true);
	const uncompact: ArmSnapshot = { ...base.baseline!, compactions: [] };
	assert.equal(checkpointOpportunity(workload, "B", { ...base, baseline: uncompact }).reason, "baseline-native-boundary-not-ready",
		"without a native compaction there is nothing to compare paging against");
	const failedOnly: ArmSnapshot = { ...base.baseline!, compactions: base.baseline!.compactions.map((event: CompactionEvent) => ({ ...event, success: false })) };
	assert.equal(checkpointOpportunity(workload, "B", { ...base, baseline: failedOnly }).reason, "baseline-native-boundary-not-ready",
		"a compaction that failed did not remove anything");
	const [fact] = factsOf("B");
	const resident = checkpointOpportunity(workload, "B", { ...base, baseline: patchLatest(base.baseline!, request => ({ ...request,
		blocks: [...request.blocks, { role: "user", text: "kept in context", sourcePromptId: fact.sourcePromptId }] })) });
	assert.equal(resident.reason, "baseline-native-boundary-not-ready",
		"a source the native arm still carries is not the native boundary");
});
