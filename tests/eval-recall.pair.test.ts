import assert from "node:assert/strict";
import test from "node:test";
import { runStageGroup, type StageGroupOptions } from "../eval/recall/stage-group.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { stageFixture } from "./fixtures/eval-recall-stage-group.ts";

function harness(controls: Parameters<typeof stageFixture>[1] = {}, extra: Partial<StageGroupOptions> = {}) {
	const f = stageFixture(buildWorkload("controller-contract"), controls);
	return { f, options: { runId: "fixture-run", seed: f.workload.seed, workload: f.workload, stage: "A", firstArm: "paging",
		createArm: f.createArm, cleanupSession: f.cleanupSession, ...extra } as StageGroupOptions };
}
for (const stage of ["A", "B"] as const) test(`stage ${stage} owns two preparation sources and twelve single-question forks`, async () => {
	const { f, options } = harness({}, { stage }); const result = await runStageGroup(options);
	assert.equal(result.status, "complete"); assert.equal(result.probes.length, 6); assert.equal(result.forks.length, 12);
	assert.ok(result.steps.every(s => s.kind !== "probe"));
	for (const row of f.sessions) if (row.options.checkpoint) { assert.equal(row.received.length, 1); assert.equal(row.inherited.length, 23); assert.equal(row.received[0].stage, stage); }
	assert.ok(f.sessions.every(s => s.disposed && s.aborted > 0));
});
test("paired sources and fork questions keep the selected first-arm order", async () => {
	const order: string[] = [], { options } = harness({ onPrompt: async (o, s) => { order.push(`${o.arm}:${s.id}`); } });
	const result = await runStageGroup(options);
	assert.deepEqual(order.slice(0, 4), ["paging:seed-A-id-v1", "baseline:seed-A-id-v1", "paging:seed-A-path-v1", "baseline:seed-A-path-v1"]);
	assert.deepEqual(order.slice(-12, -10), ["paging:probe-A-id", "baseline:probe-A-id"]);
	assert.equal(result.stageEvidence.qualifiedKnown, 5); assert.equal(result.promptCounts.baseline, 29);
});
test("wrong answers preserve structural qualification", async () => {
	const { options } = harness({ wrongAnswers: true }); const result = await runStageGroup(options);
	assert.equal(result.status, "complete"); assert.equal(result.stageEvidence.qualifiedKnown, 5);
	assert.ok(result.probes.every(p => !p.paging.score.correct)); assert.deepEqual(result.errors, []);
});
test("an unused B value exposed in A remains diagnostic and never enters fresh B forks", async () => {
	const { options } = harness(), create = options.createArm, value = options.workload!.facts.find(f => f.factId === "B-id")!.value;
	options.createArm = async o => { const arm = await create(o), prompt = arm.runPrompt;
		if (o.checkpoint) arm.runPrompt = async step => ({ ...await prompt(step), finalAnswerText: JSON.stringify({ answer: value }) });
		return arm;
	};
	const a = await runStageGroup(options); assert.equal(a.status, "complete"); assert.deepEqual(a.crossStageExposure, ["B-id"]);
	const { f, options: next } = harness({}, { stage: "B" }); const b = await runStageGroup(next);
	assert.equal(b.status, "complete"); assert.deepEqual(b.crossStageExposure, []);
	assert.ok(f.sessions.filter(s => s.options.checkpoint).every(s => s.inherited.every(text => !text.includes(`{"answer":"${value}"}`))));
});
test("baseline summary credit remains valid after native compaction", async () => {
	const { options } = harness({}, { stage: "B" }); const result = await runStageGroup(options);
	assert.equal(result.status, "complete"); assert.ok(result.probes.filter(p => p.probe.factId).every(p => p.baseline.score.correct && p.baseline.evidence.visibility === "resident-summary"));
});
test("the visible fifth known paging target stops before its dispatch", async () => {
	const { f, options } = harness({ visibleFifth: true }); const result = await runStageGroup(options);
	assert.equal(result.status, "incomplete"); assert.equal(result.forks.at(-1)!.gate!.failureCode, "probe-answer-visible");
	assert.ok(!f.dispatches.some(r => r.arm === "paging" && r.promptId === "probe-A-decision"));
});
test("startup metadata drift rejects every prompt", async () => {
	const { f, options } = harness(), create = options.createArm;
	options.createArm = async o => { const arm = await create(o), snapshot = arm.snapshot; if (o.arm === "paging") arm.snapshot = () => ({ ...snapshot(), metadataFingerprint: "other" }); return arm; };
	const result = await runStageGroup(options); assert.equal(result.status, "incomplete"); assert.equal(f.dispatches.length, 0);
});
test("a reused source fails ownership before any dispatch", async () => {
	const { options } = harness(), sources = new Map<string, Awaited<ReturnType<StageGroupOptions["createArm"]>>>(), create = options.createArm;
	options.createArm = async o => { const arm = await create(o); if (!o.checkpoint) sources.set(o.arm, arm); return arm; };
	await runStageGroup(options);
	const result = await runStageGroup({ ...options, stage: "B", createArm: async o => sources.get(o.arm)! });
	assert.equal(result.status, "incomplete"); assert.deepEqual(result.sentAttempts, { baseline: 0, paging: 0 });
});
test("partial startup closes its first source and excludes private exception text", async () => {
	const { f, options } = harness({}, { firstArm: "baseline" }), create = options.createArm;
	options.createArm = async o => { if (o.arm === "paging") throw new Error("PRIVATE_STARTUP_SENTINEL"); return create(o); };
	const result = await runStageGroup(options); assert.equal(result.status, "incomplete"); assert.equal(f.sessions[0].disposed, true);
	assert.ok(!JSON.stringify(result.errors).includes("PRIVATE_STARTUP_SENTINEL"));
});
test("progress failure ends work while retaining the completed owned request", async () => {
	const { f, options } = harness({}, { onProgress: async () => { throw new Error("PRIVATE_WRITE_SENTINEL"); } });
	const result = await runStageGroup(options); assert.equal(result.status, "incomplete"); assert.equal(f.dispatches.length, 1);
	assert.ok(f.sessions.every(s => s.disposed)); assert.ok(!JSON.stringify(result).includes("PRIVATE_WRITE_SENTINEL"));
});
test("retry/continuation attempts share the prompt allowance across forks", async () => {
	const { options } = harness({ attempts: 2 }); const result = await runStageGroup(options);
	assert.equal(result.status, "complete"); assert.equal(result.sentAttempts.baseline, 58); assert.equal(result.promptCounts.baseline, 29);
});
