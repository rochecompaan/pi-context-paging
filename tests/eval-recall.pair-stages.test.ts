import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkload, factForProbe, type Arm, type Probe, type Workload } from "../eval/recall/workload.ts";
import { latestConversation, scoreProbeArm, sourceExcluded, successfulCompactions } from "../eval/recall/pair-stages.ts";
import type { ArmSnapshot } from "../eval/recall/pi-arm.ts";
import type { ReadableBlock, RequestEvidence } from "../eval/recall/codex-payload.ts";
import type { ObservedToolCall, RecoveryResult } from "../eval/recall/evidence.ts";
import type { SessionOwner } from "../eval/recall/metrics.ts";
import { completeGroup } from "./fixtures/eval-recall-groups.ts";

/**
 * `scoreProbeArm` is the last wiring step behind the project's headline claim: it decides which
 * requests belong to a probe and hands them, with the snapshot's recovery results and observed tool
 * calls, to the evidence analyser. A probe credited with the wrong request set scores recovery
 * success for work it never did, so these tests pin the pairing, the latency window, trace
 * completeness, and the chain that must line up before `recoverySuccess` is true.
 */
const seed = "pair-stages-seed";
const workload: Workload = buildWorkload(seed);
const probes = workload.probes.A;
const known = probes.find(probe => probe.factId !== null)!;
const unknown = probes.find(probe => probe.factId === null)!;
const fact = factForProbe(workload, known)!;
// A fork belongs to a checkpoint (assertOwner requires both ids or neither).
const owner = (arm: Arm): SessionOwner => ({ runId: "run-1", stage: "A", seed, arm, sessionId: `session-${arm}`, checkpointId: "checkpoint-1", forkId: "fork-1" });

function requestFor(probe: Probe, arm: Arm, over: Partial<RequestEvidence> = {}): RequestEvidence {
	return { ...owner(arm), requestId: `req-${arm}-${probe.step.id}`, promptId: probe.step.id, complete: true, blocks: [],
		opaque: { count: 0, hashes: [] }, ...over, purpose: over.purpose ?? "conversation" };
}

/** Inert bookkeeping fields are filled with typed placeholders; the tests read the evidence fields. */
function snapshotOf(arm: Arm, over: Partial<ArmSnapshot> = {}): ArmSnapshot {
	return { arm, owner: owner(arm), promptCount: 1, requests: [], requestRecords: [], taskRecords: [], recoveryResults: [],
		toolCalls: [], finalAnswerText: "", finalAnswerEventIndex: 100, origins: [], compactions: [], entries: [], usageLedger: [],
		executionUsage: [], latencyMs: 5000, statsCrossCheck: { tokens: {}, cost: {} }, errors: [],
		modelMetadata: {}, metadataFingerprint: "fingerprint", ...over } as ArmSnapshot;
}

/** A probe turn that recovers the fact with a paging tool and answers with it. */
function recoveredProbeTurn(probe: Probe, arm: Arm, overrides: {
	result?: Partial<RecoveryResult>; calls?: Partial<ObservedToolCall>[] | null; blocks?: ReadableBlock[]; answer?: string;
	extraRequests?: RequestEvidence[];
} = {}): ArmSnapshot {
	const value = factForProbe(workload, probe)?.value ?? "";
	const blocks = overrides.blocks ?? [
		{ role: "user", text: `What is the ${fact.field} for ${fact.subject}?` },
		{ role: "assistant", kind: "tool-call", text: "search_history", toolCallId: "call-1", toolItemId: "item-1" },
	];
	const request = requestFor(probe, arm, { blocks });
	const callOverrides = overrides.calls?.[0] ?? {};
	const observed: ObservedToolCall | null = overrides.calls === null ? null : { ...owner(arm), requestId: request.requestId,
		toolCallId: "call-1", toolName: "search_history", eventIndex: 10, ...callOverrides,
		promptId: callOverrides.promptId ?? probe.step.id, purpose: callOverrides.purpose ?? "conversation" };
	const result: RecoveryResult = { ...owner(arm), promptId: probe.step.id, requestId: request.requestId, toolCallId: "call-1",
		toolName: "search_history", text: `${fact.subject} ${fact.field}: ${value}`, isError: false, eventIndex: 11, ...overrides.result };
	return snapshotOf(arm, {
		requests: [request, ...(overrides.extraRequests ?? [])], recoveryResults: [result], toolCalls: observed ? [observed] : [],
		finalAnswerText: overrides.answer ?? JSON.stringify({ answer: value }), finalAnswerEventIndex: 20,
	});
}

test("a probe is scored against its own step's conversation requests", () => {
	const other = probes.find(probe => probe.id !== known.id)!;
	const arm: Arm = "paging";
	const complete = snapshotOf(arm, { requests: [
		requestFor(known, arm), requestFor(known, arm, { requestId: "req-follow-up" }),
		requestFor(other, arm), requestFor(known, arm, { requestId: "req-compaction", purpose: "compaction", complete: false }),
	] });
	assert.equal(scoreProbeArm(workload, known, complete, snapshotOf(arm, { latencyMs: 0 })).traceComplete, true,
		"only the probe's own conversation requests count, so an incomplete compaction request on the same step is not its trace");
	const broken = snapshotOf(arm, { requests: [requestFor(known, arm), requestFor(known, arm, { requestId: "req-follow-up", complete: false })] });
	assert.equal(scoreProbeArm(workload, known, broken, snapshotOf(arm, { latencyMs: 0 })).traceComplete, false,
		"an incomplete request in the probe's own trace makes it incomplete");
	assert.equal(scoreProbeArm(workload, known, snapshotOf(arm, { requests: [requestFor(other, arm)] }), snapshotOf(arm, { latencyMs: 0 })).traceComplete, false,
		"another probe's request is never this probe's trace");
});

test("probe latency is measured from the snapshot the probe started in", () => {
	const arm: Arm = "paging";
	const snapshot = snapshotOf(arm, { latencyMs: 5000, requests: [requestFor(known, arm)] });
	// The stage group scores a fork against the same snapshot with a zeroed clock.
	assert.equal(scoreProbeArm(workload, known, snapshot, { ...snapshot, latencyMs: 0 }).latencyMs, 5000);
	assert.equal(scoreProbeArm(workload, known, snapshot, { ...snapshot, latencyMs: 1200 }).latencyMs, 3800);
	assert.equal(scoreProbeArm(workload, known, snapshot, { ...snapshot, latencyMs: 5000 }).latencyMs, 0, "a probe that added no time adds no latency");
});

test("a probe with no request keeps a placeholder trace and is never trace-complete", () => {
	const arm: Arm = "paging";
	const empty = snapshotOf(arm, { finalAnswerText: JSON.stringify({ answer: fact.value }) });
	const result = scoreProbeArm(workload, known, empty, snapshotOf(arm, { latencyMs: 0 }));
	assert.equal(result.traceComplete, false);
	assert.equal(result.score.correct, true, "the answer is still scored from the final answer text");
	assert.equal(result.score.expected, fact.value, "the expectation comes from this probe's fact");
	assert.equal(result.evidence.qualified, false, "no request evidence, so nothing is qualified");
	assert.equal(result.evidence.recoverySuccess, false, "no request evidence, so recovery is never credited");
});

test("the score compares this probe's fact value, including the unknown probe", () => {
	const arm: Arm = "baseline";
	const answer = (value: string | null) => JSON.stringify({ answer: value });
	const good = snapshotOf(arm, { requests: [requestFor(known, arm)], finalAnswerText: answer(fact.value) });
	const scoring = scoreProbeArm(workload, known, good, snapshotOf(arm, { latencyMs: 0 })).score;
	assert.equal(scoring.correct, true);
	assert.equal(scoring.probeId, known.id);
	const otherFact = factForProbe(workload, probes.find(probe => probe.factId !== null && probe.factId !== known.factId)!)!;
	const swapped = snapshotOf(arm, { requests: [requestFor(known, arm)], finalAnswerText: answer(otherFact.value) });
	const crossed = scoreProbeArm(workload, known, swapped, snapshotOf(arm, { latencyMs: 0 })).score;
	assert.equal(crossed.correct, false, "answering another probe's fact is not correct for this probe");
	assert.equal(crossed.expected, fact.value);
	assert.equal(crossed.actual, otherFact.value);
	const prose = snapshotOf(arm, { requests: [requestFor(known, arm)], finalAnswerText: `I think it is ${fact.value}` });
	assert.equal(scoreProbeArm(workload, known, prose, snapshotOf(arm, { latencyMs: 0 })).score.reason, "invalid-json",
		"prose is ungradeable, not a correct answer");
	const admit = snapshotOf(arm, { requests: [requestFor(unknown, arm)], finalAnswerText: answer(null) });
	const unknownScore = scoreProbeArm(workload, unknown, admit, snapshotOf(arm, { latencyMs: 0 })).score;
	assert.equal(unknownScore.expected, null, "the unknown probe expects an admission");
	assert.equal(unknownScore.correct, true);
	assert.equal(scoreProbeArm(workload, unknown, snapshotOf(arm, { requests: [requestFor(unknown, arm)], finalAnswerText: answer("invented") }), snapshotOf(arm, { latencyMs: 0 })).score.correct, false);
});

test("recovery success requires the call, the result, the request and the answer to line up", () => {
	const arm: Arm = "paging";
	const score = (snapshot: ArmSnapshot) => scoreProbeArm(workload, known, snapshot, snapshotOf(arm, { latencyMs: 0 })).evidence;
	const clean = score(recoveredProbeTurn(known, arm));
	assert.equal(clean.visibility, "plaintext-absent", "the fact must be out of the request before recovery counts");
	assert.equal(clean.qualified, true);
	assert.equal(clean.recoverySuccess, true, "the complete chain is the published success signal");
	assert.equal(score(recoveredProbeTurn(known, arm, { result: { promptId: "step-of-another-probe" } })).recoverySuccess, false,
		"a result from another prompt is not this probe's recovery");
	assert.equal(score(recoveredProbeTurn(known, arm, { calls: null })).recoverySuccess, false,
		"a result with no observed tool call is not evidence");
	assert.equal(score(recoveredProbeTurn(known, arm, { result: { toolName: "bash" } })).recoverySuccess, false,
		"ordinary tool output is not paging recovery");
	assert.equal(score(recoveredProbeTurn(known, arm, { result: { isError: true } })).recoverySuccess, false);
	assert.equal(score(recoveredProbeTurn(known, arm, { result: { text: "nothing relevant here" } })).recoverySuccess, false,
		"the recovered text must contain the fact");
	assert.equal(score(recoveredProbeTurn(known, arm, { answer: JSON.stringify({ answer: "guessed" }) })).recoverySuccess, false,
		"an answer that is not correct is not a successful recovery");
	assert.equal(score(recoveredProbeTurn(known, arm, { blocks: [{ role: "user", text: `${fact.subject} ${fact.field}: ${fact.value}`, sourcePromptId: fact.sourcePromptId }] })).recoverySuccess, false,
		"a fact still resident in the request is not a recovery");
	// The first request of the trace is the graded request; later ones only have to be sound.
	const residentFollowUp = requestFor(known, arm, { requestId: "req-follow-up", blocks: [{ role: "user", text: `${fact.subject} ${fact.field}: ${fact.value}`, sourcePromptId: fact.sourcePromptId }] });
	assert.equal(score(recoveredProbeTurn(known, arm, { extraRequests: [residentFollowUp] })).recoverySuccess, true,
		"the answer is graded against the request the probe started with");
	assert.equal(score(recoveredProbeTurn(known, arm, { extraRequests: [requestFor(known, arm, { requestId: "req-follow-up", complete: false })] })).recoverySuccess, false,
		"an incomplete follow-up on the same probe makes the trace unqualified");
});

test("the paging call must be inside the traced request", () => {
	const arm: Arm = "paging";
	const base = recoveredProbeTurn(known, arm);
	const request = (base.requests[0] as RequestEvidence).blocks.filter(block => block.role === "user");
	const untraced = snapshotOf(arm, { ...base, requests: [{ ...(base.requests[0] as RequestEvidence), blocks: request }] });
	assert.equal(scoreProbeArm(workload, known, untraced, snapshotOf(arm, { latencyMs: 0 })).evidence.recoverySuccess, false,
		"a result whose tool call is not a block in the probe's request is not credited");
});

test("snapshot helpers read compactions, the latest request and excluded sources", async () => {
	const events = [{ success: true }, { success: false }, { success: true }] as never[];
	assert.equal(successfulCompactions(snapshotOf("paging", { compactions: events })), 2);
	assert.equal(successfulCompactions(snapshotOf("paging")), 0);
	assert.equal(successfulCompactions(undefined), 0, "a missing snapshot has no compactions, not zero-run compactions");
	const arm: Arm = "paging";
	const conversation = requestFor(known, arm, { requestId: "req-conversation" });
	const trailing = snapshotOf(arm, { requests: [
		requestFor(known, arm, { requestId: "req-early", purpose: "compaction" }), conversation,
		requestFor(known, arm, { requestId: "req-late", purpose: "compaction" })] });
	assert.equal(latestConversation(trailing)?.requestId, "req-conversation", "a compaction request is not the latest conversation");
	// The checkpoint gate reads the context the model is in now, so the newest conversation wins.
	const second = requestFor(known, arm, { requestId: "req-second" });
	assert.equal(latestConversation(snapshotOf(arm, { requests: [conversation, second] }))?.requestId, "req-second");
	assert.equal(latestConversation(snapshotOf(arm, { requests: [second, conversation] }))?.requestId, "req-conversation");
	assert.equal(latestConversation(snapshotOf(arm)), undefined);

	const group = await completeGroup("A", `pair-stages-fixture-${seed}`);
	const paging = group.sources.paging!;
	const latest = latestConversation(paging)!;
	assert.ok(latest.complete);
	for (const source of workload.facts.filter(item => item.sourcePromptId.startsWith("seed-A"))) {
		assert.equal(sourceExcluded(latest, source.sourcePromptId), true, `${source.sourcePromptId} is out of the paging request`);
		assert.equal(sourceExcluded({ ...latest, blocks: [...latest.blocks, { role: "user", text: "seeded", sourcePromptId: source.sourcePromptId }] }, source.sourcePromptId), false,
			"a source that is still in the request is not excluded");
	}
	assert.equal(sourceExcluded({ ...latest, complete: false }, "seed-A-id-v1"), false, "an incomplete request proves nothing about exclusion");
	assert.equal(sourceExcluded(undefined, "seed-A-id-v1"), false);
});
