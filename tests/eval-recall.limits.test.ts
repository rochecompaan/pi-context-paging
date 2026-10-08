import assert from "node:assert/strict";
import test from "node:test";
import { createRequestGuard } from "../eval/recall/request-guard.ts";
import { runStageGroup } from "../eval/recall/stage-group.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { ownerFixture } from "./fixtures/eval-recall.ts";
import { stageFixture } from "./fixtures/eval-recall-stage-group.ts";
import type { Clock } from "../eval/recall/pi-arm.ts";

function fakeClock() {
	let time = 0;
	const timers = new Map<object, { deadline: number; callback: () => void }>();
	const clock: Clock = { nowMs: () => time, utcNow: () => new Date(Date.UTC(2026, 0, 1) + time).toISOString(),
		setTimeout(callback, delay) { const key = {}; timers.set(key, { deadline: time + delay, callback }); return key; },
		clearTimeout(handle) { timers.delete(handle as object); } };
	return { clock, advance(ms: number) { time += ms; for (const [key, timer] of timers) if (timer.deadline <= time) {
		timers.delete(key); timer.callback();
	} }, get activeTimers() { return timers.size; } };
}
const limits = { maxUserPrompts: 64, maxRequestsPerPrompt: 12, maxRequestsPerArm: 256, maxPairMinutes: 120 };

test("one allowance spans preparation and six forks, including retries, without resetting a stop", () => {
	const guard = createRequestGuard({ ...limits, maxRequestsPerArm: 30 }, fakeClock().clock);
	const source = ownerFixture();
	for (let index = 0; index < 23; index++) {
		guard.beginPrompt("paging", `prepare-${index}`, source);
		guard.beforeAttempt({ ...source, promptId: `prepare-${index}`, requestId: `source-${index}`, purpose: "conversation" });
	}
	for (let index = 0; index < 6; index++) {
		const owner = { ...source, sessionId: `fork-${index}`, checkpointId: "checkpoint", forkId: `fork-${index}` };
		guard.beginPrompt("paging", `probe-${index}`, owner);
		guard.beforeAttempt({ ...owner, promptId: `probe-${index}`, requestId: `fork-${index}`, purpose: "conversation" });
		if (index === 0) guard.beforeAttempt({ ...owner, promptId: `probe-${index}`, requestId: "retry", purpose: "conversation" });
	}
	assert.equal(guard.promptCounts.paging, 29);
	assert.equal(guard.sentAttempts.paging, 30);
	const last = { ...source, sessionId: "fork-5", checkpointId: "checkpoint", forkId: "fork-5" };
	assert.throws(() => guard.beforeAttempt({ ...last, promptId: "probe-5", requestId: "blocked", purpose: "conversation" }));
	assert.throws(() => guard.beginPrompt("paging", "new-fork", last));
	assert.equal(guard.stopReason, "max-requests-per-arm");
});

test("an owner-bound prompt rejects a sibling's HTTP request before accounting it", () => {
	const guard = createRequestGuard(limits, fakeClock().clock), owner = ownerFixture("paging", { sessionId: "fork", checkpointId: "checkpoint", forkId: "fork" });
	guard.beginPrompt("paging", "probe", owner);
	assert.throws(() => guard.beforeAttempt({ ...owner, sessionId: "sibling", promptId: "probe", requestId: "r", purpose: "conversation" }));
	assert.equal(guard.sentAttempts.paging, 0);
	assert.equal(guard.stopReason, "request-owner-mismatch");
});

test("attempt 13 is blocked before dispatch; retry and compaction attempts count against the same prompt", () => {
	const guard = createRequestGuard(limits, fakeClock().clock);
	guard.beginPrompt("paging", "probe-A-id");
	const sent: string[] = [];
	for (let index = 0; index < 12; index++) {
		guard.beforeAttempt({ ...ownerFixture("paging"), arm: "paging", promptId: "probe-A-id", requestId: index < 9 ? "retried" : "summary", purpose: index < 9 ? "conversation" : "compaction" });
		sent.push("sent");
	}
	assert.throws(() => { guard.beforeAttempt({ ...ownerFixture("paging"), arm: "paging", promptId: "probe-A-id", requestId: "blocked", purpose: "conversation" }); sent.push("sent"); });
	assert.equal(sent.length, 12);
	assert.equal(guard.sentAttempts.paging, 12);
	assert.equal(guard.promptCounts.paging, 1);
	assert.equal(guard.stopReason, "max-requests-per-prompt");
});

test("attempt 257 is blocked at the per-arm cap independently of the other arm", () => {
	const guard = createRequestGuard({ ...limits, maxRequestsPerPrompt: 512 }, fakeClock().clock);
	guard.beginPrompt("baseline", "work-0");
	for (let index = 0; index < 256; index++) guard.beforeAttempt({ ...ownerFixture("baseline"), arm: "baseline", promptId: "work-0", requestId: `${index}`, purpose: "conversation" });
	assert.equal(guard.sentAttempts.baseline, 256);
	assert.equal(guard.sentAttempts.paging, 0);
	assert.throws(() => guard.beforeAttempt({ ...ownerFixture("baseline"), arm: "baseline", promptId: "work-0", requestId: "257", purpose: "compaction" }));
	assert.equal(guard.stopReason, "max-requests-per-arm");
});

test("elapsed wall time latches a stop even before another HTTP dispatch", () => {
	const fake = fakeClock(), guard = createRequestGuard(limits, fake.clock);
	fake.advance(120 * 60_000);
	assert.throws(() => guard.beginPrompt("baseline", "work-0"));
	assert.equal(guard.stopReason, "max-pair-minutes");
	assert.equal(guard.promptCounts.baseline, 0);
});

test("unbound requests and duplicate prompt IDs cannot bypass accounting", () => {
	for (const mode of ["unbound", "duplicate"] as const) {
		const guard = createRequestGuard(limits, fakeClock().clock);
		guard.beginPrompt("paging", "probe-A-id");
		assert.throws(() => mode === "duplicate" ? guard.beginPrompt("paging", "probe-A-id") :
			guard.beforeAttempt({ ...ownerFixture("paging"), arm: "paging", promptId: "other", requestId: "r", purpose: "conversation" }));
		assert.equal(guard.promptCounts.paging, 1);
		assert.equal(guard.sentAttempts.paging, 0);
	}
});

test("a deadline during second-arm startup closes the first arm and any late-created arm", async () => {
	const fake = fakeClock(), workload = buildWorkload("startup-deadline");
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>(resolve => { enter = resolve; });
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const f = stageFixture(workload, { onCreate: async o => { if (o.arm === "paging") { enter(); await blocked; } } });
	const running = runStageGroup({ runId: "fixture-run", seed: workload.seed, stage: "A", workload, firstArm: "baseline", clock: fake.clock,
		createArm: f.createArm, cleanupSession: f.cleanupSession });
	await entered; fake.advance(120 * 60_000);
	release();
	const result = await running;
	assert.equal(result.status, "incomplete");
	assert.equal(result.stopReason, "max-pair-minutes");
	assert.equal(f.sessions.length, 2);
	assert.ok(f.sessions.every(s => s.disposed));
	assert.equal(fake.activeTimers, 0);
});

test("invalid and non-finite limits are rejected without starting model work", () => {
	for (const patch of [{ maxUserPrompts: 0 }, { maxRequestsPerPrompt: 1.5 }, { maxPairMinutes: Number.NaN }, { maxPairMinutes: Number.MAX_VALUE }]) {
		assert.throws(() => createRequestGuard({ ...limits, ...patch }, fakeClock().clock));
	}
	assert.throws(() => createRequestGuard({ ...limits, maxRequestsPerPrompt: undefined } as unknown as typeof limits, fakeClock().clock));
});

test("the startup deadline aborts an active prompt, preserves partial evidence, and clears the timer", async () => {
	const fake = fakeClock(), workload = buildWorkload("deadline");
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const active = new Promise<void>(resolve => { release = resolve; });
	const f = stageFixture(workload, { onPrompt: async () => { entered(); await active; } });
	const running = runStageGroup({ runId: "fixture-run", seed: workload.seed, stage: "A", workload, firstArm: "baseline", clock: fake.clock,
		cleanupSession: f.cleanupSession, createArm: async o => {
			const arm = await f.createArm(o), abort = arm.abort;
			arm.abort = async () => { release(); await abort(); }; return arm;
		} });
	await started;
	fake.advance(120 * 60_000 + 1);
	const result = await running;
	assert.equal(result.status, "incomplete");
	assert.equal(result.stopReason, "max-pair-minutes");
	assert.equal(result.sources.baseline!.requests.length, 1);
	assert.equal(result.promptCounts.paging, 0);
	assert.ok(f.sessions.every(arm => arm.aborted > 0 && arm.disposed));
	assert.equal(fake.activeTimers, 0);
});
