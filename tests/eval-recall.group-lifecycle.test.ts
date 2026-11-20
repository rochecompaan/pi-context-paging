import assert from "node:assert/strict";
import test from "node:test";
import { createGroupLifecycle, type GroupError } from "../eval/recall/group-lifecycle.ts";
import { createRequestGuard, defaultLimits } from "../eval/recall/request-guard.ts";
import { createTaskRecorder } from "../eval/recall/task-metrics.ts";
import { buildWorkload, type Arm } from "../eval/recall/workload.ts";
import { stageFixture, groupClock } from "./fixtures/eval-recall-stage-group.ts";
import type { ArmFactoryOptions } from "../eval/recall/fork.ts";
import type { SessionOwner } from "../eval/recall/metrics.ts";

/**
 * The per-pair deadline is the only thing bounding live model spend for one pair, so the contract
 * worth pinning is what happens the moment it fires: the awaited action loses, dispatch is refused,
 * and every arm that exists — including one whose setup finishes late — is stopped.
 */
const DEADLINE_MS = 60_000;

function owner(arm: Arm): SessionOwner {
	return { runId: "run-lifecycle", stage: "A", seed: "lifecycle-seed", arm, sessionId: `session-${arm}`, checkpointId: null, forkId: null };
}

function setup(controls = {}, deadlineMs = DEADLINE_MS) {
	const timer = groupClock();
	const clock = timer.clock;
	const guard = createRequestGuard(defaultLimits, clock);
	const recorder = createTaskRecorder(clock);
	const fixture = stageFixture(buildWorkload("lifecycle-seed"), controls);
	const errors: GroupError[] = [];
	const lifecycle = createGroupLifecycle({ clock, deadlineMs, guard, recorder, errors,
		createArm: fixture.createArm, cleanupSession: fixture.cleanupSession });
	const input = (arm: Arm): ArmFactoryOptions => ({ arm, owner: owner(arm), requestGuard: guard.beforeAttempt, clock, taskRecorder: recorder });
	// Read the live-timer count lazily: destructuring the getter would evaluate it before the deadline timer exists.
	return { clock, advance: timer.advance, liveTimers: () => timer.activeTimers, guard, recorder, fixture, errors, lifecycle, input, owner: owner };
}

test("the deadline releases the awaited action, stops the guard, and aborts the live arm", async t => {
	const s = setup();
	t.after(() => { void s.lifecycle.finish([], () => {}); });
	const created = await s.lifecycle.create(s.input("baseline"));
	void created;
	let rejection = "";
	const awaited = s.lifecycle.wait(new Promise<never>(() => {})).catch((error: Error) => { rejection = error.message; });
	s.advance(DEADLINE_MS);
	await awaited;
	assert.match(rejection, /Stage deadline/);
	assert.throws(() => s.guard.check(), /Eval stopped: max-pair-minutes/);
	assert.equal(s.fixture.sessions[0]?.aborted, 1);
});

test("dispatch is refused once the deadline has passed, so no new model work starts", async t => {
	const s = setup();
	t.after(() => { void s.lifecycle.finish([], () => {}); });
	s.advance(DEADLINE_MS);
	await assert.rejects(() => s.lifecycle.create(s.input("paging")), /Eval stopped: max-pair-minutes/);
	assert.equal(s.fixture.sessions.length, 0);
});

test("an arm whose setup lands after the deadline is stopped, not left running", async t => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const s = setup({ onCreate: async () => { await gate; } });
	t.after(() => { void s.lifecycle.finish([], () => {}); });
	const creating = s.lifecycle.create(s.input("baseline"));
	await Promise.resolve();
	s.advance(DEADLINE_MS);
	release();
	await creating;
	assert.equal(s.fixture.sessions[0]?.aborted, 1);
});

test("an action that settles after the deadline won the race does not reject unhandled", async t => {
	const s = setup();
	t.after(() => { void s.lifecycle.finish([], () => {}); });
	const seen: unknown[] = [];
	const observe = (reason: unknown) => { seen.push(reason); };
	process.on("unhandledRejection", observe);
	try {
		let fail!: (error: Error) => void;
		const action = new Promise<never>((_resolve, reject) => { fail = reject; });
		s.lifecycle.wait(action).catch(() => {});
		s.advance(DEADLINE_MS);
		fail(new Error("late provider failure"));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepEqual(seen, []);
	} finally {
		process.off("unhandledRejection", observe);
	}
});

test("session cleanup runs once per session, so a shared cleanup path cannot double-delete", async t => {
	const s = setup();
	t.after(() => { void s.lifecycle.finish([], () => {}); });
	await s.lifecycle.create(s.input("baseline"));
	await s.lifecycle.cleanup(s.owner("baseline"));
	await s.lifecycle.cleanup(s.owner("baseline"));
	assert.deepEqual([...s.fixture.cleaned], ["session-baseline"]);
});

test("finish snapshots only source owners, disposes and cleans up every owner, and clears the timer", async t => {
	const s = setup();
	await s.lifecycle.create(s.input("baseline"));
	await s.lifecycle.create(s.input("paging"));
	const snapshotted: string[] = [];
	const result = await s.lifecycle.finish([s.owner("baseline")], (snapshotOwner) => { snapshotted.push(snapshotOwner.sessionId); });
	assert.deepEqual(snapshotted, ["session-baseline"]);
	assert.deepEqual([...s.fixture.cleaned].sort(), ["session-baseline", "session-paging"]);
	assert.equal(s.fixture.sessions.filter(session => session.disposed).length, 2);
	assert.equal(s.liveTimers(), 0);
	assert.deepEqual(s.errors, []);
	assert.equal(result.complete, true);
	const rows = s.recorder.records().filter(record => record.phase === "cleanup");
	assert.equal(rows.length, 2);
	assert.ok(rows.every(record => record.timing.status === "succeeded"));
});

test("an arm that cannot be stopped is reported as incomplete, and its session is still cleaned up", async t => {
	const { clock } = groupClock();
	const guard = createRequestGuard(defaultLimits, clock);
	const recorder = createTaskRecorder(clock);
	const fixture = stageFixture(buildWorkload("lifecycle-seed"));
	const errors: GroupError[] = [];
	const lifecycle = createGroupLifecycle({ clock, deadlineMs: DEADLINE_MS, guard, recorder, errors,
		createArm: async (armInput) => {
			const arm = await fixture.createArm(armInput);
			return { ...arm, abort: async () => { throw new Error("fixture abort failure"); } };
		},
		cleanupSession: fixture.cleanupSession });
	const input = (arm: Arm): ArmFactoryOptions => ({ arm, owner: owner(arm), requestGuard: guard.beforeAttempt, clock, taskRecorder: recorder });
	await lifecycle.create(input("baseline"));
	const result = await lifecycle.finish([owner("baseline")], () => {});
	assert.equal(result.complete, false);
	// The abort is attempted twice (the group-wide stop and the per-owner cleanup), and the group-wide
	// record carries no arm, so the contract to pin is that the failure is reported at all.
	assert.ok(errors.every(error => error.code === "abort-error"));
	assert.ok(errors.length >= 1);
	assert.ok(errors.some(error => error.arm === "baseline"));
	assert.deepEqual([...fixture.cleaned], ["session-baseline"]);
	const failed = recorder.records().filter(record => record.phase === "cleanup" && record.timing.status === "failed");
	assert.equal(failed.length, 1);
});

test("a failed session cleanup is reported as incomplete and recorded as a failed phase", async t => {
	const { clock } = groupClock();
	const guard = createRequestGuard(defaultLimits, clock);
	const recorder = createTaskRecorder(clock);
	const fixture = stageFixture(buildWorkload("lifecycle-seed"));
	const errors: GroupError[] = [];
	const lifecycle = createGroupLifecycle({ clock, deadlineMs: DEADLINE_MS, guard, recorder, errors,
		createArm: fixture.createArm,
		cleanupSession: async (sessionOwner) => {
			if (sessionOwner.arm === "paging") throw new Error("fixture cleanup failure");
			await fixture.cleanupSession(sessionOwner);
		} });
	const input = (arm: Arm): ArmFactoryOptions => ({ arm, owner: owner(arm), requestGuard: guard.beforeAttempt, clock, taskRecorder: recorder });
	await lifecycle.create(input("baseline"));
	await lifecycle.create(input("paging"));
	const result = await lifecycle.finish([owner("baseline"), owner("paging")], () => {});
	assert.equal(result.complete, false);
	assert.deepEqual(errors, [{ code: "resource-cleanup-error", arm: "paging" }]);
	const failed = recorder.records().filter(record => record.phase === "cleanup" && record.timing.status === "failed");
	assert.equal(failed.length, 1);
	assert.equal(failed[0]?.arm, "paging");
});
