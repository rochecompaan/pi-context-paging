import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { realClock } from "../eval/recall/clock.ts";
import { createTaskRecorder, operationOwner, taskDurations } from "../eval/recall/task-metrics.ts";
import { createAttemptRecord, finishOperation } from "../eval/recall/metrics.ts";
import { PiJournal } from "../eval/recall/pi-journal.ts";
import { freezeCheckpoint } from "../eval/recall/checkpoint.ts";
import { runProbeFork } from "../eval/recall/fork.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { ownerFixture, makeScriptedArm } from "./fixtures/eval-recall.ts";

function clockFixture() {
	let now = 0;
	return { ...realClock, nowMs: () => now, utcNow: () => new Date(Date.UTC(2026, 9, 7) + now).toISOString(), set: (value: number) => { now = value; } };
}
const workload = buildWorkload("task-metrics");

test("prompt wall time includes provider and tool work without summing nested intervals", () => {
	const clock = clockFixture(), recorder = createTaskRecorder(clock), owner = operationOwner(ownerFixture(), { promptId: "prompt" });
	clock.set(10); const prompt = recorder.begin("prompt", owner);
	clock.set(12); const request = createAttemptRecord({ ...owner, promptId: "prompt", requestId: "request", purpose: "conversation" }, "attempt", clock);
	clock.set(20); finishOperation(request.timing, "succeeded", clock);
	const tool = recorder.begin("tool", { ...owner, requestId: "request", toolCallId: "call", toolName: "load_history" });
	clock.set(25); recorder.end(tool, "succeeded");
	clock.set(40); recorder.end(prompt, "succeeded");
	const metrics = taskDurations(recorder.records());
	assert.equal(metrics.promptTaskMs.value, 30);
	assert.equal(metrics.toolWallMs.value, 5);
	assert.equal(request.timing.durationMs.value, 8);
	assert.equal(recorder.records().find(row => row.phase === "tool")?.requestId, "request");
	assert.equal(recorder.records().find(row => row.phase === "prompt")?.timing.endedAtUtc, "2026-10-07T00:00:00.040Z");
});

test("missing boundaries, overlapping intervals, and failure statuses retain explicit evidence", () => {
	const clock = clockFixture(), recorder = createTaskRecorder(clock), owner = operationOwner(ownerFixture());
	const first = recorder.begin("artifact-write", owner);
	clock.set(2); const second = recorder.begin("cleanup", owner);
	clock.set(5); recorder.end(first, "failed");
	clock.set(8); recorder.end(second, "succeeded");
	recorder.begin("prompt", owner);
	recorder.endWithoutStart("tool", { ...owner, toolCallId: "missing", toolName: "load_history" }, "failed");
	const rows = recorder.records();
	assert.equal(rows.find(row => row.phase === "artifact-write")?.timing.status, "failed");
	assert.equal(rows.find(row => row.phase === "artifact-write")?.timing.durationMs.value, 5);
	assert.equal(rows.find(row => row.phase === "cleanup")?.timing.durationMs.value, 6);
	assert.equal(taskDurations(rows).promptTaskMs.status, "incomplete");
	assert.equal(taskDurations(rows).toolWallMs.status, "incomplete");
	assert.equal(rows.find(row => row.phase === "tool")?.timing.startMs, null);
	assert.equal(rows.find(row => row.phase === "tool")?.timing.status, "failed");
	assert.throws(() => recorder.end("unknown-operation", "succeeded"), /Unknown/);
	rows[0].timing.status = "succeeded";
	assert.equal(recorder.records()[0].timing.status, "failed");
});

test("operation details cannot replace controller-issued session ownership", () => {
	const owner = ownerFixture();
	const foreign = { ...ownerFixture("baseline", { sessionId: "foreign" }), promptId: "prompt", requestId: "request" };
	const scope = operationOwner(owner, foreign);
	assert.equal(scope.sessionId, owner.sessionId);
	assert.equal(scope.arm, owner.arm);
	assert.equal(scope.requestId, "request");
});

test("timing rejects backward clocks and foreign ownership and keeps completed boundaries stable", () => {
	const clock = clockFixture(), recorder = createTaskRecorder(clock), owner = operationOwner(ownerFixture());
	clock.set(10); const id = recorder.begin("prompt", owner);
	clock.set(5); recorder.end(id, "failed");
	assert.equal(taskDurations(recorder.records()).promptTaskMs.status, "invalid");
	assert.throws(() => recorder.begin("prompt", { ...owner, sessionId: "" }), /ownership/);
	clock.set(20); const completed = recorder.begin("cleanup", owner);
	clock.set(25); recorder.end(completed, "succeeded");
	clock.set(40); recorder.end(completed, "succeeded");
	assert.equal(recorder.records().find(row => row.operationId === completed)?.timing.durationMs.value, 5);
});

test("compaction attempts start at the extension boundary and distinguish cancellation from abort", () => {
	for (const status of ["succeeded", "failed", "canceled", "aborted"] as const) {
		const clock = clockFixture(), recorder = createTaskRecorder(clock), owner = ownerFixture();
		const journal = new PiJournal({ arm: "paging", owner, taskRecorder: recorder });
		journal.session = { sessionManager: { getBranch: () => [] } } as unknown as AgentSession;
		journal.begin(workload.seedSteps[0]);
		journal.onEvent({ type: "compaction_start", reason: "threshold" });
		clock.set(2); journal.beforeCompaction("threshold");
		if (status === "canceled") journal.compactionDecision(true);
		clock.set(7);
		journal.onEvent({ type: "compaction_end", reason: "threshold", willRetry: false,
			aborted: status === "aborted" || status === "canceled", errorMessage: status === "failed" ? "PRIVATE_ERROR" : undefined,
			result: status === "succeeded" ? { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 100 } : undefined });
		const rows = recorder.records().filter(row => row.phase === "compaction");
		assert.equal(rows.length, 1);
		assert.equal(rows[0].timing.status, status);
		assert.equal(rows[0].compactionWallMs?.value, 5);
		assert.equal(rows[0].timing.startMs, 2);
		assert.ok(!JSON.stringify(rows).includes("PRIVATE_ERROR"));
	}
});

function checkpointFixture() {
	const manager = SessionManager.inMemory("/fixture");
	return freezeCheckpoint({ owner: ownerFixture(), entries: manager.getBranch(), projection: manager.buildSessionProjection(),
		leafId: manager.getLeafId(), promptCount: 23, provenance: [], compactions: [], tape: null,
		configuration: { metadataFingerprint: "fixture", model: undefined, cwd: "/fixture", thinkingLevel: "xhigh", systemPrompt: "fixture",
			tools: [], autoCompactionEnabled: true } });
}

test("probe lifetime includes scoring, evidence writes, and cleanup with setup and restore separated", async () => {
	const clock = clockFixture(), checkpoint = checkpointFixture();
	const owner = ownerFixture("paging", { sessionId: "fork", checkpointId: checkpoint.id, forkId: "fork" });
	const order: string[] = [];
	const result = await runProbeFork({ checkpoint, owner, step: workload.probes.A[0].step, clock, requestGuard: () => {},
		createArm: async options => {
			const recorder = options.taskRecorder!, scope = operationOwner(owner);
			const setup = recorder.begin("fork-setup", scope); clock.set(5); recorder.end(setup, "succeeded");
			const restore = recorder.begin("checkpoint-restore", scope); clock.set(8); recorder.end(restore, "succeeded");
			const scripted = makeScriptedArm({ arm: "paging", owner, workload, order, beforeAttempt: () => {}, onPrompt: async () => { clock.set(40); } });
			return { ...scripted.instance, snapshot: () => ({ ...scripted.instance.snapshot(), promptCount: 23,
				restoration: { method: "baseline-native-history-v1", passed: true, checks: [], failureCode: null } }) };
		},
		score: async () => { order.push("score"); clock.set(42); },
		writeEvidence: async () => { order.push("evidence"); clock.set(47); },
		cleanupSession: async () => { order.push("cleanup"); clock.set(50); },
		writeTiming: async result => { order.push("timing"); assert.equal(result.probeTaskMs.value, 50); clock.set(52); },
	});
	assert.equal(result.failureCode, null);
	assert.equal(result.forkSetupMs.value, 5);
	assert.equal(result.checkpointRestoreMs.value, 3);
	assert.equal(result.probeTaskMs.value, 50);
	assert.deepEqual(order.slice(-4), ["score", "evidence", "cleanup", "timing"]);
	assert.equal(result.taskRecords.filter(row => row.phase === "artifact-write").length, 1);
});

test("evidence or final timing write failure retains partial probe records and still cleans up", async () => {
	for (const failing of ["evidence", "timing"] as const) {
		const clock = clockFixture(), checkpoint = checkpointFixture();
		const owner = ownerFixture("paging", { sessionId: `fork-${failing}`, checkpointId: checkpoint.id, forkId: `fork-${failing}` });
		let cleaned = false;
		const result = await runProbeFork({ checkpoint, owner, step: workload.probes.A[0].step, clock, requestGuard: () => {},
			createArm: async options => {
				const scripted = makeScriptedArm({ arm: "paging", owner, workload, order: [], beforeAttempt: () => {} });
				return { ...scripted.instance, snapshot: () => ({ ...scripted.instance.snapshot(), restoration: {
					method: "baseline-native-history-v1", passed: true, checks: [], failureCode: null } }) };
			},
			writeEvidence: async () => { if (failing === "evidence") throw new Error("PRIVATE_WRITE_ERROR"); },
			writeTiming: async () => { if (failing === "timing") throw new Error("PRIVATE_WRITE_ERROR"); },
			cleanupSession: async () => { cleaned = true; clock.set(10); },
		});
		assert.equal(cleaned, true);
		assert.equal(result.failureCode, `fork-${failing === "evidence" ? "artifact" : "timing"}-write-failed`);
		assert.equal(result.taskRecords.find(row => row.phase === "probe")?.timing.status, "failed");
		assert.equal(result.probeTaskMs.value, 10);
		assert.ok(!JSON.stringify(result).includes("PRIVATE_WRITE_ERROR"));
	}
});
