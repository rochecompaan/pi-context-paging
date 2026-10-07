import assert from "node:assert/strict";
import test from "node:test";
import { runPair, type PairOptions } from "../eval/recall/pair.ts";
import { buildWorkload, type Arm, type Workload } from "../eval/recall/workload.ts";
import { makeScriptedArm, summaryPresence, type ArmScript } from "./fixtures/eval-recall.ts";

const workload = buildWorkload("controller-contract");
function harness(scripts: Partial<Record<Arm, ArmScript>> = {}, extra: Partial<PairOptions> = {}) {
	const arms = new Map<Arm, ReturnType<typeof makeScriptedArm>>(), order: string[] = [];
	const options: PairOptions = { seed: workload.seed, stage: "A", workload, firstArm: "paging", ...extra,
		createArm: async ({ arm, requestGuard }) => {
			const fixture = makeScriptedArm({ arm, workload: extra.workload ?? workload, beforeAttempt: requestGuard, order, script: scripts[arm] });
			arms.set(arm, fixture);
			return fixture.instance;
		} };
	return { arms, order, options };
}

for (const stage of ["A", "B"] as const) test(`stage ${stage} uses its own conversation without probes from the other stage`, async () => {
	const h = harness({}, { stage });
	const result = await runPair(h.options);
	assert.equal(result.probes.length, 6);
	assert.ok(result.probes.every(probe => probe.probe.stage === stage));
	assert.ok(result.steps.filter(step => step.kind === "probe").every(step => step.stage === stage));
	assert.deepEqual(h.arms.get("baseline")!.received, h.arms.get("paging")!.received);
	assert.ok([...h.arms.values()].every(arm => arm.disposed && arm.aborted > 0));
});

test("both arms receive the same seed, revision, work and probe steps in selected first-arm order", async () => {
	const h = harness();
	const result = await runPair(h.options);
	assert.equal(result.status, "complete");
	assert.equal(result.stages.A.qualifiedKnown, 5);
	assert.equal(result.stages.B.complete, false);
	assert.equal(result.probes.length, 6);
	assert.deepEqual(h.arms.get("baseline")!.received, h.arms.get("paging")!.received);
	assert.deepEqual(h.order.slice(0, 4), ["paging:seed-A-id-v1", "baseline:seed-A-id-v1", "paging:seed-A-path-v1", "baseline:seed-A-path-v1"]);
	assert.deepEqual(result.steps.slice(0, 12), workload.seedSteps);
	assert.equal(result.steps.filter(step => step.kind === "work").length, 6);
	assert.equal(result.snapshots.baseline!.compactions.length, 0);
	assert.equal(result.promptCounts.baseline, 24);
	assert.ok([...h.arms.values()].every(arm => arm.disposed && arm.aborted > 0));
});

test("wrong and malformed model answers score zero without changing stage qualification", async () => {
	const h = harness({ paging: step => step.kind === "probe" ? { finalAnswerText: step.id === "probe-A-id" ? "not json" : '{"answer":"wrong"}' } : {} });
	const result = await runPair(h.options);
	assert.equal(result.status, "complete");
	assert.equal(result.stages.A.qualifiedKnown, 5);
	assert.equal(result.probes[0].paging.score.reason, "invalid-json");
	assert.ok(result.probes.every(probe => !probe.paging.score.correct));
	assert.deepEqual(result.errors, []);
});

test("a baseline summary retains full credit while source messages stay excluded", async () => {
	const h = harness({ baseline: (step, snapshot) => step.stage === "B" ? {
		requests: snapshot.requests.map(request => request.promptId === step.id ? { ...request, blocks: summaryPresence(workload) } : request),
	} : {} }, { stage: "B" });
	const result = await runPair(h.options);
	assert.equal(result.status, "complete");
	const known = result.probes.filter(probe => probe.probe.stage === "B" && probe.probe.factId);
	assert.ok(known.every(probe => probe.baseline.score.correct && probe.baseline.evidence.visibility === "resident-summary"));
	assert.equal(result.stages.B.valid, true);
});

for (const trigger of ["probe-A-id", "probe-A-error", "probe-A-unknown"]) test(`compaction at ${trigger} is inconclusive and never relabels the stage`, async () => {
	const h = harness({ baseline: (step, snapshot) => step.id === trigger ? {
		compactions: [...snapshot.compactions, { eventIndex: 999, reason: "threshold", success: true }],
	} : {} });
	const result = await runPair(h.options);
	assert.equal(result.status, "inconclusive");
	assert.equal(result.stages.A.reason, "baseline-compacted-during-stage-A");
	assert.equal(result.stages.A.timing.length, 6);
	assert.equal(result.stages.B.complete, false);
	assert.equal(result.probes.filter(probe => probe.probe.stage === "A").length, 6);
});

for (const exposure of ["answer", "recovery"] as const) test(`stage A ${exposure} exposure cannot refresh the independent stage B conversation`, async () => {
	const target = workload.facts.find(fact => fact.factId === "B-id")!;
	const h = harness({ paging: (step, snapshot) => step.id !== "probe-A-id" ? {} : exposure === "answer"
		? { finalAnswerText: JSON.stringify({ answer: target.value }) }
		: { recoveryResults: [...snapshot.recoveryResults, { promptId: step.id,
			requestId: snapshot.requests.at(-1)!.requestId, toolCallId: "recovery-call", toolName: "load_history",
			text: `Recovered record: ${target.value}`, isError: false, eventIndex: snapshot.finalAnswerEventIndex - 1 }] } });
	const result = await runPair(h.options);
	assert.equal(result.status, "complete");
	assert.deepEqual(result.crossStageExposure, ["B-id"]);
	assert.equal(result.stages.B.probes.length, 0);
	const b = harness({}, { stage: "B" }), independent = await runPair(b.options);
	assert.equal(independent.status, "complete");
	assert.deepEqual(independent.crossStageExposure, []);
	assert.ok(independent.probes.every(probe => probe.comparisonEligible));
	assert.ok(b.arms.get("paging")!.received.every(step => step.stage !== "A"));
});

test("missing probe traces preserve the answer score but cannot qualify stage A", async () => {
	const h = harness({ paging: (step, snapshot) => step.stage === "A" ? {
		requests: snapshot.requests.filter(request => request.promptId !== step.id),
	} : {} });
	const result = await runPair(h.options);
	assert.equal(result.status, "inconclusive");
	assert.equal(result.stages.A.qualifiedKnown, 0);
	assert.ok(result.probes.filter(probe => probe.probe.stage === "A").every(probe => probe.paging.score.correct));
	assert.deepEqual(result.errors, []);
});

test("a source-bearing recovered tool result is not an original resident user message", async () => {
	const h = harness({ paging: (step, snapshot) => step.stage === "A" ? {
		requests: snapshot.requests.map(request => request.promptId !== step.id ? request : { ...request,
			blocks: workload.facts.filter(fact => fact.factId.startsWith("A-")).map(fact => ({ role: "toolResult", kind: "tool-result" as const,
				text: "A recovered source wrapper without a readable target", sourcePromptId: fact.sourcePromptId })) }),
	} : {} });
	const result = await runPair(h.options);
	assert.equal(result.stages.A.qualifiedKnown, 5);
});

test("a canceled baseline compaction never opens stage B and the user cap preserves partial observations", async () => {
	const h = harness({ baseline: (_, snapshot) => ({ compactions: snapshot.compactions.map(event => ({ ...event, success: false })) }) },
		{ stage: "B", limits: { maxUserPrompts: 25 } });
	const result = await runPair(h.options);
	assert.equal(result.status, "incomplete");
	assert.equal(result.stages.B.complete, false);
	assert.equal(result.stopReason, "max-user-prompts");
	assert.equal(result.probes.length, 0);
	assert.ok(result.snapshots.baseline!.compactions.every(event => !event.success));
	assert.ok([...h.arms.values()].every(arm => arm.disposed));
});

test("provider errors stop the pair before the next arm and preserve the failing request", async () => {
	const h = harness({ paging: step => step.id === "probe-A-path" ? { errors: [{ code: "assistant-error", promptId: step.id }] } : {} });
	const result = await runPair(h.options);
	assert.equal(result.status, "incomplete");
	assert.ok(result.snapshots.paging!.requests.some(request => request.promptId === "probe-A-path"));
	assert.ok(!h.arms.get("baseline")!.received.some(step => step.id === "probe-A-path"));
	assert.ok([...h.arms.values()].every(arm => arm.disposed && arm.aborted > 0));
});

test("different startup model fingerprints stop before any user prompt or model dispatch", async () => {
	const h = harness(), create = h.options.createArm;
	const result = await runPair({ ...h.options, createArm: async options => {
		const instance = await create(options), original = instance.snapshot;
		if (options.arm === "paging") instance.snapshot = () => ({ ...original(), metadataFingerprint: "different-native-model" });
		return instance;
	} });
	assert.equal(result.status, "incomplete");
	assert.deepEqual(result.sentAttempts, { baseline: 0, paging: 0 });
	assert.deepEqual(result.steps, []);
	assert.ok([...h.arms.values()].every(arm => arm.disposed));
});

test("a reused conversation is rejected before any new prompt or model dispatch", async () => {
	const a = harness(), sessions = new Map<Arm, Awaited<ReturnType<PairOptions["createArm"]>>>(), create = a.options.createArm;
	await runPair({ ...a.options, createArm: async options => {
		const instance = await create(options); sessions.set(options.arm, instance); return instance;
	} });
	const b = await runPair({ ...a.options, stage: "B", createArm: async ({ arm }) => sessions.get(arm)! });
	assert.equal(b.status, "incomplete");
	assert.deepEqual(b.steps, []);
	assert.deepEqual(b.promptCounts, { baseline: 0, paging: 0 });
	assert.deepEqual(b.sentAttempts, { baseline: 0, paging: 0 });
});

test("partial startup closes the first session even if creating the second fails", async () => {
	const h = harness();
	const create = h.options.createArm;
	const result = await runPair({ ...h.options, createArm: async options => {
		if (options.arm === "paging") throw new Error("private startup details");
		return create(options);
	} });
	assert.equal(result.status, "incomplete");
	assert.equal(h.arms.get("baseline")!.disposed, true);
	assert.ok(!JSON.stringify(result.errors).includes("private startup details"));
});

for (const [visible, qualified, status] of [
	[["probe-A-id"], 4, "complete"], [["probe-A-id", "probe-A-path"], 3, "inconclusive"],
] as const) test(`stage A needs four known qualified probes, not five or three (${qualified})`, async () => {
	const h = harness({ paging: (step, snapshot) => visible.some(id => id === step.id) ? {
		requests: snapshot.requests.map(request => request.promptId === step.id ? { ...request, blocks: summaryPresence(workload) } : request),
	} : {} });
	const result = await runPair(h.options);
	assert.equal(result.stages.A.qualifiedKnown, qualified);
	assert.equal(result.status, status);
});

test("stage A is qualified from actual initial probe requests, not the earlier opportunity", async () => {
	const h = harness({ paging: (step, snapshot) => step.stage === "A" ? {
		requests: snapshot.requests.map(request => request.promptId === step.id ? { ...request,
			blocks: summaryPresence(workload).filter(block => !block.text.includes("Boreal")) } : request),
	} : {} });
	const result = await runPair(h.options);
	assert.equal(result.status, "inconclusive");
	assert.equal(result.stages.A.qualifiedKnown, 0);
	assert.equal(result.stages.A.reason, "insufficient-qualified-known-probes");
	assert.ok(result.stages.A.probes.filter(probe => probe.probe.factId).every(probe => probe.paging.evidence.visibility === "resident-summary"));
});

test("an early baseline compaction skips stage A without relabeling its conversation as stage B", async () => {
	const h = harness({ baseline: (step, snapshot) => step.id === "seed-B-decision-v2" ? {
		compactions: [...snapshot.compactions, { eventIndex: 999, success: true, reason: "threshold" }],
	} : {} });
	const result = await runPair(h.options);
	assert.equal(result.status, "inconclusive");
	assert.equal(result.stages.A.reason, "baseline-compacted-before-stage-A");
	assert.equal(result.stages.A.probes.length, 0);
	assert.equal(result.stages.B.probes.length, 0);
	assert.equal(result.promptCounts.baseline, 12);
});

test("a progress-sink failure preserves the completed request and closes every session", async () => {
	const h = harness({}, { onProgress: async () => { throw new Error("private artifact details"); } });
	const result = await runPair(h.options);
	assert.equal(result.status, "incomplete");
	assert.equal(result.snapshots.paging!.requests.length, 1);
	assert.equal(result.promptCounts.baseline, 0);
	assert.ok([...h.arms.values()].every(arm => arm.disposed));
	assert.ok(!JSON.stringify(result.errors).includes("private artifact details"));
});

test("tool follow-ups and native summary calls do not count as additional user prompts", async () => {
	const h = harness();
	const result = await runPair({ ...h.options, createArm: async ({ arm, requestGuard }) => {
		const fixture = makeScriptedArm({ arm, workload, beforeAttempt: requestGuard, order: h.order, attempts: () => 2 });
		h.arms.set(arm, fixture); return fixture.instance;
	} });
	assert.equal(result.status, "complete");
	assert.equal(result.sentAttempts.baseline, 2 * result.promptCounts.baseline);
	assert.equal(result.sentAttempts.paging, 2 * result.promptCounts.paging);
	assert.equal(result.promptCounts.baseline, result.steps.length);
});

test("early stage opportunities still require work before the six final probes to reach 24 prompts", async () => {
	const compact: Workload = { ...workload, seedSteps: workload.seedSteps.slice(0, 2) };
	const h = harness({}, { workload: compact, stage: "B" });
	const result = await runPair(h.options);
	assert.equal(result.status, "complete");
	assert.equal(result.promptCounts.baseline, 24);
	assert.equal(result.promptCounts.paging, 24);
	assert.equal(result.steps.filter(step => step.kind === "work").length, 16);
	assert.equal(result.steps.at(-7)!.kind, "work");
	assert.equal(result.steps.at(-6)!.id, "probe-B-id");
});
