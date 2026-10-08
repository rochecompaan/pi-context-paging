import assert from "node:assert/strict";
import test from "node:test";
import { runStageGroup } from "../eval/recall/stage-group.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { checkpointDigest } from "../eval/recall/checkpoint.ts";
import { groupClock, stageFixture } from "./fixtures/eval-recall-stage-group.ts";
import { operationOwner } from "../eval/recall/task-metrics.ts";
import { summarizeMetrics } from "../eval/recall/metric-summary.ts";
import { normalizeAttemptUsage } from "../eval/recall/usage.ts";
import { groupManifest } from "./fixtures/eval-recall-groups.ts";
import { providerAttempt } from "./fixtures/eval-recall-usage.ts";

async function run(controls: Parameters<typeof stageFixture>[1] = {}, stage: "A" | "B" = "A") {
	const fixture = stageFixture(buildWorkload(`group-${stage}`), controls), fake = groupClock();
	const result = await runStageGroup({ ...fixture, runId: "group-run", seed: fixture.workload.seed, stage, firstArm: "paging", clock: fake.clock });
	return { fixture, result, fake };
}
test("two preparation sources freeze before twelve one-probe forks with shared allowances", async () => {
	const { fixture, result, fake } = await run();
	assert.equal(result.status, "complete");
	assert.equal(fixture.sessions.length, 14);
	const sources = fixture.sessions.filter(row => !row.options.checkpoint), forks = fixture.sessions.filter(row => row.options.checkpoint);
	assert.equal(sources[0].options.arm, "paging");
	assert.ok(sources.every(row => row.received.length === 23 && row.received.every(step => step.kind !== "probe")));
	assert.deepEqual(sources[0].received, sources[1].received);
	for (const fork of forks) {
		assert.equal(fork.inherited.length, 23);
		assert.equal(fork.received.length, 1);
		assert.equal(fork.received[0].kind, "probe");
		assert.ok(!fork.inherited.some(text => text.includes('Return only one JSON object')));
	}
	for (const probe of fixture.workload.probes.A) assert.deepEqual(forks.filter(row => row.received[0].id === probe.id).map(row => row.received[0].text), [probe.step.text, probe.step.text]);
	assert.equal(result.forks.length, 12);
	assert.equal(result.probes.length, 6);
	assert.equal(result.stageEvidence.qualifiedKnown, 5);
	assert.equal(result.probes.filter(row => row.probe.factId === null).length, 1);
	assert.deepEqual(result.promptCounts, { baseline: 29, paging: 29 });
	assert.deepEqual(result.sentAttempts, { baseline: 29, paging: 29 });
	assert.ok(fixture.sessions.every(row => row.disposed && row.aborted > 0));
	assert.equal(new Set(fixture.cleaned).size, 14);
	for (const source of Object.values(result.sources)) assert.equal(source!.taskRecords.find(row => row.phase === "cleanup")?.timing.status, "succeeded");
	for (const fork of result.forks) assert.deepEqual(fork.snapshot!.taskRecords, fork.taskRecords);
	assert.equal(fake.activeTimers, 0);
	for (const frozen of fixture.checkpoints) assert.equal(checkpointDigest(frozen.checkpoint), frozen.digest);
});
test("a rejected fifth paging gate dispatches no HTTP and stops before the unknown probe", async () => {
	const { fixture, result } = await run({ visibleFifth: true });
	assert.equal(result.status, "incomplete");
	assert.equal(result.stopReason, "probe-answer-visible");
	assert.equal(result.probes.length, 4);
	assert.equal(fixture.dispatches.filter(row => row.forkId && row.arm === "paging" && row.promptId.endsWith("decision")).length, 0);
	assert.equal(fixture.dispatches.filter(row => row.promptId.endsWith("unknown")).length, 0);
	assert.ok(result.forks.some(row => row.failureCode));
	assert.ok(fixture.sessions.every(row => row.disposed));
});
test("wrong final answers do not choose boundaries or stop a structurally sound group", async () => {
	const { result } = await run({ wrongAnswers: true });
	assert.equal(result.status, "complete");
	assert.equal(result.stageEvidence.qualifiedKnown, 5);
	assert.ok(result.probes.every(row => !row.paging.score.correct));
});
test("stage B has fresh sources and native baseline exclusion while allowing inherited answers", async () => {
	const { fixture, result } = await run({}, "B");
	assert.equal(result.status, "complete");
	assert.ok(result.sources.baseline!.compactions.some(row => row.success));
	assert.ok(result.probes.filter(row => row.probe.factId).every(row => row.baseline.score.correct));
	assert.ok(fixture.sessions.every(row => row.options.owner.stage === "B" && row.options.owner.seed === "group-B"));
});
test("native baseline compaction during an A response makes A inconclusive", async () => {
	const { result } = await run({ compactDuringA: true });
	assert.equal(result.status, "inconclusive");
	assert.equal(result.stageEvidence.valid, false);
	assert.equal(result.stageEvidence.reason, "baseline-compacted-during-stage-A");
});
test("restoration failure stops the group without sending or repairing that fork", async () => {
	const { fixture, result } = await run({ failRestoration: true });
	assert.equal(result.status, "incomplete");
	assert.equal(result.forks.length, 1);
	assert.equal(fixture.dispatches.filter(row => row.forkId).length, 0);
	assert.equal(fixture.checkpoints.length, 2);
});
test("unknown first and last give identical inherited input and five qualified known gates", async () => {
	const outputs: Record<string, string[]>[] = [];
	for (const unknownFirst of [true, false]) {
		const workload = buildWorkload("permutation");
		const sorted = [...workload.probes.A].sort((a, b) => unknownFirst ? Number(b.factId === null) - Number(a.factId === null) : Number(a.factId === null) - Number(b.factId === null));
		const fixture = stageFixture({ ...workload, probes: { ...workload.probes, A: sorted } });
		const result = await runStageGroup({ ...fixture, runId: "permutation", seed: workload.seed, stage: "A", firstArm: "baseline", clock: groupClock().clock });
		assert.equal(result.stageEvidence.qualifiedKnown, 5);
		outputs.push(Object.fromEntries(fixture.sessions.filter(row => row.options.checkpoint).map(row => [`${row.options.arm}:${row.received[0].id}`, row.inherited])));
		for (const frozen of fixture.checkpoints) assert.equal(checkpointDigest(frozen.checkpoint), frozen.digest);
	}
	assert.deepEqual(outputs[0], outputs[1]);
});
test("a setup that resolves after the deadline is awaited and disposed before return", async () => {
	const fake = groupClock();
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>(resolve => { enter = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
	const fixture = stageFixture(buildWorkload("late"), { onCreate: async options => { if (options.arm === "paging") { enter(); await blocked; } } });
	let settled = false;
	const pending = runStageGroup({ ...fixture, runId: "late", seed: fixture.workload.seed, stage: "A", firstArm: "baseline", clock: fake.clock }).then(result => { settled = true; return result; });
	await entered; fake.advance(120 * 60_000); await Promise.resolve(); assert.equal(settled, false);
	release(); const result = await pending;
	assert.equal(result.status, "incomplete");
	assert.equal(result.stopReason, "max-pair-minutes");
	assert.ok(fixture.sessions.every(row => row.disposed));
	assert.equal(fixture.cleaned.length, 2);
	assert.equal(fake.activeTimers, 0);
});

test("deadline joins the active fork into partial accounting before returning", async () => {
	const fake = groupClock(), workload = buildWorkload("fork-deadline");
	let enter!: () => void, release!: () => void, forkPrompts = 0, activeSessionId = "";
	const entered = new Promise<void>(resolve => { enter = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
	const fixture = stageFixture(workload, { onPrompt: async options => {
		if (options.checkpoint && ++forkPrompts === 3) { activeSessionId = options.owner.sessionId; enter(); await blocked; }
	} });
	const evidence: string[] = [], timing: string[] = [];
	const pending = runStageGroup({ ...fixture, runId: "fork-deadline", seed: workload.seed, stage: "A", firstArm: "baseline", clock: fake.clock,
		createArm: async options => {
			const arm = await fixture.createArm(options);
			return { ...arm, abort: async () => { if (options.owner.sessionId === activeSessionId) release(); await arm.abort(); },
				runPrompt: async step => {
					const snapshot = await arm.runPrompt(step);
					if (options.owner.sessionId === activeSessionId) {
						const request = snapshot.requestRecords[0], attempt = request.attempts[0];
						const usage = normalizeAttemptUsage(providerAttempt(undefined, options.owner, request.requestId, attempt.attemptId), null);
						snapshot.executionUsage = [{ ...options.owner, requestId: request.requestId, attemptId: attempt.attemptId,
							promptId: step.id, purpose: request.purpose, usage, sdkEntryIds: [] }];
					}
					return snapshot;
				} };
		}, onForkEvidence: async fork => { evidence.push(fork.owner.sessionId); }, onForkTiming: async fork => { timing.push(fork.owner.sessionId); } });
	await entered; fake.advance(120 * 60_000);
	const result = await pending;
	assert.equal(result.status, "incomplete"); assert.equal(result.stopReason, "max-pair-minutes");
	assert.equal(result.forks.length, 3);
	const active = result.forks.find(fork => fork.owner.sessionId === activeSessionId)!;
	assert.ok(active.snapshot); assert.equal(active.cleanup.complete, true);
	assert.equal(active.snapshot.requestRecords[0].attempts.length, 1);
	assert.ok(active.taskRecords.some(row => row.phase === "cleanup" && row.timing.status === "succeeded"));
	assert.equal(result.probes.length, 1); assert.equal(forkPrompts, 3);
	assert.deepEqual(evidence, result.forks.map(fork => fork.owner.sessionId)); assert.deepEqual(timing, evidence);
	assert.equal(fixture.sessions.length, 5); assert.ok(fixture.sessions.every(row => row.disposed));
	assert.equal(new Set(fixture.cleaned).size, 5); assert.equal(fake.activeTimers, 0);
	assert.equal(result.sentAttempts.baseline + result.sentAttempts.paging, 49);
	assert.equal(result.usageRecords.length, 1);
	const summary = summarizeMetrics(groupManifest([result]), [result]);
	assert.equal(summary.run.counts.attempts, 49);
	assert.equal(summary.run.usage.totalInputTokens.measuredSubtotal, 100);
	assert.equal(summary.probes.find(row => row.probeId === active.probe.id && row.arm === active.owner.arm)!.counts.attempts, 1);
	assert.ok(summary.paired.every(row => row.usage.totalInputTokens.value === null));
});

test("source active-time subtotals preserve invalid clocks instead of calling them missing", async () => {
	const fake = groupClock(), workload = buildWorkload("invalid-clock");
	const fixture = stageFixture(workload, { onCreate: async options => {
		if (options.checkpoint) return;
		const phase = options.taskRecorder!.begin("source-setup", operationOwner(options.owner));
		fake.advance(-1); options.taskRecorder!.end(phase, "succeeded");
	} });
	const result = await runStageGroup({ ...fixture, runId: "invalid-clock", seed: workload.seed, stage: "A", firstArm: "baseline", clock: fake.clock });
	assert.equal(result.preparationActiveMs.baseline.status, "invalid");
	assert.equal(result.preparationActiveMs.paging.status, "invalid");
	assert.equal(result.preparationActiveMs.baseline.value, null);
});
