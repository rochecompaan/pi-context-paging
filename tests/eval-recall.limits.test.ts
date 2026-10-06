import assert from "node:assert/strict";
import test from "node:test";
import { createRequestGuard } from "../eval/recall/request-guard.ts";
import { runPair } from "../eval/recall/pair.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { makeScriptedArm } from "./fixtures/eval-recall.ts";
import type { Clock } from "../eval/recall/pi-arm.ts";

function fakeClock() {
	let time = 0;
	const timers = new Map<object, { deadline: number; callback: () => void }>();
	const clock: Clock = { nowMs: () => time,
		setTimeout(callback, delay) { const key = {}; timers.set(key, { deadline: time + delay, callback }); return key; },
		clearTimeout(handle) { timers.delete(handle as object); } };
	return { clock, advance(ms: number) { time += ms; for (const [key, timer] of timers) if (timer.deadline <= time) {
		timers.delete(key); timer.callback();
	} }, get activeTimers() { return timers.size; } };
}
const limits = { maxUserPrompts: 64, maxRequestsPerPrompt: 12, maxRequestsPerArm: 256, maxPairMinutes: 120 };

test("attempt 13 is blocked before dispatch; retry and compaction attempts count against the same prompt", () => {
	const guard = createRequestGuard(limits, fakeClock().clock);
	guard.beginPrompt("paging", "probe-A-id");
	const sent: string[] = [];
	for (let index = 0; index < 12; index++) {
		guard.beforeAttempt({ arm: "paging", promptId: "probe-A-id", requestId: index < 9 ? "retried" : "summary", purpose: index < 9 ? "conversation" : "compaction" });
		sent.push("sent");
	}
	assert.throws(() => { guard.beforeAttempt({ arm: "paging", promptId: "probe-A-id", requestId: "blocked", purpose: "conversation" }); sent.push("sent"); });
	assert.equal(sent.length, 12);
	assert.equal(guard.sentAttempts.paging, 12);
	assert.equal(guard.promptCounts.paging, 1);
	assert.equal(guard.stopReason, "max-requests-per-prompt");
});

test("attempt 257 is blocked at the per-arm cap independently of the other arm", () => {
	const guard = createRequestGuard({ ...limits, maxRequestsPerPrompt: 512 }, fakeClock().clock);
	guard.beginPrompt("baseline", "work-0");
	for (let index = 0; index < 256; index++) guard.beforeAttempt({ arm: "baseline", promptId: "work-0", requestId: `${index}`, purpose: "conversation" });
	assert.equal(guard.sentAttempts.baseline, 256);
	assert.equal(guard.sentAttempts.paging, 0);
	assert.throws(() => guard.beforeAttempt({ arm: "baseline", promptId: "work-0", requestId: "257", purpose: "compaction" }));
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
			guard.beforeAttempt({ arm: "paging", promptId: "other", requestId: "r", purpose: "conversation" }));
		assert.equal(guard.promptCounts.paging, 1);
		assert.equal(guard.sentAttempts.paging, 0);
	}
});

test("a deadline during second-arm startup closes the first arm and any late-created arm", async () => {
	const fake = fakeClock(), workload = buildWorkload("startup-deadline");
	let enter!: () => void, release!: () => void, disposed!: () => void;
	const entered = new Promise<void>(resolve => { enter = resolve; });
	const blocked = new Promise<void>(resolve => { release = resolve; });
	const lateClosed = new Promise<void>(resolve => { disposed = resolve; });
	let first!: ReturnType<typeof makeScriptedArm>, late!: ReturnType<typeof makeScriptedArm>;
	const running = runPair({ seed: workload.seed, workload, firstArm: "baseline", clock: fake.clock,
		createArm: async ({ arm, requestGuard }) => {
			const fixture = makeScriptedArm({ arm, workload, beforeAttempt: requestGuard, order: [] });
			if (arm === "baseline") { first = fixture; return fixture.instance; }
			late = fixture; enter(); await blocked;
			const close = fixture.instance.dispose;
			fixture.instance.dispose = () => { close(); disposed(); };
			return fixture.instance;
		} });
	await entered; fake.advance(120 * 60_000);
	const result = await running;
	assert.equal(result.status, "incomplete");
	assert.equal(result.stopReason, "max-pair-minutes");
	assert.equal(first.disposed, true);
	release(); await lateClosed;
	assert.equal(late.disposed, true);
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
	const arms: ReturnType<typeof makeScriptedArm>[] = [];
	const running = runPair({ seed: workload.seed, workload, firstArm: "baseline", clock: fake.clock,
		createArm: async ({ arm, requestGuard }) => {
			const fixture = makeScriptedArm({ arm, workload, beforeAttempt: requestGuard, order: [],
				onPrompt: async () => { entered(); await active; }, onAbort: release });
			arms.push(fixture); return fixture.instance;
		} });
	await started;
	fake.advance(120 * 60_000 + 1);
	const result = await running;
	assert.equal(result.status, "incomplete");
	assert.equal(result.stopReason, "max-pair-minutes");
	assert.equal(result.snapshots.baseline!.requests.length, 1);
	assert.equal(result.promptCounts.paging, 0);
	assert.ok(arms.every(arm => arm.aborted > 0 && arm.disposed));
	assert.equal(fake.activeTimers, 0);
});
