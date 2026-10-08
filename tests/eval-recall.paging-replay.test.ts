import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { prepareReplayFixture } from "./fixtures/eval-recall-checkpoint.ts";

// A lost calibration/remembered cut must change the actual next native request.
test("replay reproduces calibrated selection without dispatch", async t => {
	mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
	t.after(() => mock.timers.reset());
	const fixture = await prepareReplayFixture("calibrated-cut");
	t.after(() => fixture.close());
	const before = fixture.dispatchCount();
	const restored = await fixture.restore();
	assert.equal(fixture.dispatchCount(), before, "restoration must not call a provider");
	assert.deepEqual(restored.nativeView(), fixture.checkpointView);
	const uninterrupted = await fixture.source.next();
	const resumed = await restored.next();
	assert.deepEqual(resumed, uninterrupted, "native history copy alone loses paging calibration/cut");
	assert.equal(restored.restoration.passed, true);
	assert.ok(restored.restoration.checks.every(check => check.passed));
});

// A sanitized transcript, dropped context edit or opaque block must fail this test.
test("replay preserves native projection and opaque fields", async t => {
	mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
	t.after(() => mock.timers.reset());
	for (const name of ["context-edit", "native-summary", "recovery-followup"] as const) {
		const fixture = await prepareReplayFixture(name);
		try {
			assert.ok(JSON.stringify(fixture.checkpointView.branch).includes("SYNTHETIC_PRIVATE_CONTINUATION"), "fixture must contain an opaque continuation field");
			if (name === "context-edit") assert.ok(fixture.checkpointView.branch.some(entry => entry.type === "context_edit"));
			if (name === "native-summary") assert.ok(fixture.checkpointView.branch.some(entry => entry.type === "compaction"));
			if (name === "recovery-followup") assert.ok(fixture.checkpointView.branch.some(entry => entry.type === "message" && entry.message.role === "toolResult"));
			const before = fixture.dispatchCount();
			const restored = await fixture.restore();
			assert.equal(fixture.dispatchCount(), before);
			assert.deepEqual(restored.nativeView(), fixture.checkpointView);
			assert.deepEqual(await restored.next(), await fixture.source.next());
			assert.equal(restored.restoration.passed, true);
			assert.deepEqual(fixture.source.nativeView().branch.slice(0, fixture.checkpointView.branch.length), fixture.checkpointView.branch);
		} finally { await fixture.close(); }
	}
});

test("replay rejects changed live model and tool configuration", async t => {
	const fixture = await prepareReplayFixture("calibrated-cut");
	t.after(() => fixture.close());
	const before = fixture.dispatchCount();
	const model = await fixture.restore({ mutate: session => { session.agent.state.model = { ...session.model!, contextWindow: session.model!.contextWindow + 1 }; } });
	assert.equal(model.restoration.passed, false);
	const tools = await fixture.restore({ mutate: session => { session.agent.state.tools = []; } });
	assert.equal(tools.restoration.passed, false);
	assert.equal(fixture.dispatchCount(), before);
});

test("replay rejects forged tapes and changed paging settings without dispatch", async t => {
	const fixture = await prepareReplayFixture("calibrated-cut");
	t.after(() => fixture.close());
	const before = fixture.dispatchCount();
	assert.throws(() => JSON.stringify(fixture.tape), /must not be serialized/);
	const forged = await fixture.restore({ tape: { method: "host-lifecycle-replay-v1" } });
	assert.equal(forged.restoration.passed, false);
	const changed = await fixture.restore({ settings: { globalSettings: { contextPaging: { enabled: false } }, projectTrusted: false } });
	assert.equal(changed.restoration.passed, false);
	assert.equal(fixture.dispatchCount(), before);
});

// A reset anchor, source-closure reuse or mutation of the tape must change later cuts.
test("repeated restore follows the same subsequent cut trajectory", async t => {
	mock.timers.enable({ apis: ["Date"], now: 1_790_000_000_000 });
	t.after(() => mock.timers.reset());
	const fixture = await prepareReplayFixture("calibrated-cut");
	t.after(() => fixture.close());
	const first = await fixture.restore();
	const second = await fixture.restore();
	assert.notEqual(first.session.sessionManager.getSessionId(), second.session.sessionManager.getSessionId());
	let firstFuturePayload: unknown;
	// Continue until a new cut must resolve a post-checkpoint history entry.
	for (let i = 0; i < 8; i++) {
		const uninterrupted = await fixture.source.next();
		if (i === 0) firstFuturePayload = uninterrupted;
		assert.deepEqual(await first.next(), uninterrupted);
		assert.deepEqual(await second.next(), uninterrupted);
	}
	const before = fixture.dispatchCount();
	const third = await fixture.restore();
	assert.equal(third.restoration.passed, true);
	assert.equal(fixture.dispatchCount(), before);
	assert.deepEqual(third.nativeView(), fixture.checkpointView);
	assert.deepEqual(await third.next(), firstFuturePayload, "source and sibling progress must not mutate the frozen tape");
	assert.deepEqual(fixture.checkpointView, fixture.frozenView());
});
