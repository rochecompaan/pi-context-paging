import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { createPiArm, realClock, type EvalArm } from "../eval/recall/pi-arm.ts";
import { runProbeFork } from "../eval/recall/fork.ts";
import { checkpointDigest, restoreCheckpointData } from "../eval/recall/checkpoint.ts";
import type { SessionOwner } from "../eval/recall/metrics.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { fixtureRuntime, measuredUsage, type FixtureScript } from "./fixtures/eval-recall-provider.ts";

const workload = buildWorkload("checkpoint");
const opaqueFixture = "PRIVATE_CHECKPOINT_REASONING_SENTINEL";
function owner(sessionId: string, checkpointId: string | null = null): SessionOwner {
	return { runId: "offline-checkpoint", stage: "A", seed: workload.seed, arm: "paging", sessionId,
		checkpointId, forkId: checkpointId ? sessionId : null };
}
async function resources(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "recall-checkpoint-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}
async function prepare(arm: EvalArm) {
	for (const step of workload.seedSteps) await arm.runPrompt(step);
	for (let i = workload.seedSteps.length; i < 23; i++) await arm.runPrompt({ id: `prepare-${i}`, kind: "work", text: `Record ${i}.` });
}

test("private checkpoint forks isolate recovery, entries, journals, and usage", async t => {
	const root = await resources(t);
	const providers: Awaited<ReturnType<typeof fixtureRuntime>>[] = [];
	const createRuntime = async () => {
		const recovering = providers.length === 1, isSource = providers.length === 0;
		const script: FixtureScript = index => recovering && index === 0
			? { tool: { name: "search_history", arguments: { query: "incident", load: true } }, usage: measuredUsage }
			: { text: "Noted.", reasoning: isSource && index === 0 ? { type: "reasoning", id: "reasoning-checkpoint", summary: [], encrypted_content: opaqueFixture } : undefined, usage: measuredUsage };
		const provider = await fixtureRuntime(script); providers.push(provider); return provider.runtime;
	};
	const source = await createPiArm({ arm: "paging", owner: owner("source"), agentDir: "/unused", resourceDir: join(root, "source"), createRuntime });
	t.after(() => source.dispose());
	await prepare(source);
	const checkpoint = await source.captureCheckpoint();
	const originalDigest = checkpointDigest(checkpoint);
	assert.throws(() => JSON.stringify(checkpoint), /private/i);
	const inherited = restoreCheckpointData(checkpoint);
	assert.ok(JSON.stringify(inherited.entries).includes(opaqueFixture));
	assert.ok(!JSON.stringify(source.snapshot()).includes(opaqueFixture));
	source.dispose();
	const first = await createPiArm({ arm: "paging", owner: owner("fork-one", checkpoint.id), checkpoint, agentDir: "/unused", resourceDir: join(root, "first"), createRuntime });
	const second = await createPiArm({ arm: "paging", owner: owner("fork-two", checkpoint.id), checkpoint, agentDir: "/unused", resourceDir: join(root, "second"), createRuntime });
	t.after(() => { first.dispose(); second.dispose(); });
	assert.notEqual(first.snapshot().owner.sessionId, second.snapshot().owner.sessionId);
	assert.equal(second.snapshot().promptCount, 23);
	assert.equal(second.snapshot().requests.length, 0);
	assert.equal(second.snapshot().recoveryResults.length, 0);
	assert.equal(second.snapshot().usageLedger.length, 0);
	const before = second.snapshot();
	const firstResult = await first.runPrompt(workload.probes.A[0].step);
	assert.ok(firstResult.recoveryResults.length > 0);
	assert.ok(firstResult.recoveryResults.some(result => workload.facts.filter(fact => result.text.includes(fact.value)).length >= 2));
	assert.deepEqual(second.snapshot(), before);
	assert.equal(providers[2].dispatches.length, 0);
	assert.equal(checkpointDigest(checkpoint), originalDigest);
	const copy = restoreCheckpointData(checkpoint);
	const user = copy.entries.find(entry => entry.type === "message" && entry.message.role === "user")!;
	if (user.type !== "message" || user.message.role !== "user") throw new Error("Fixture missing user record");
	user.message.content = "Corrupted fork-local inherited object";
	assert.deepEqual(restoreCheckpointData(checkpoint), inherited);
	assert.deepEqual(second.snapshot(), before);
	assert.equal(firstResult.requests.every(request => request.sessionId === "fork-one" && request.checkpointId === checkpoint.id), true);
	assert.ok(second.snapshot().origins.some(origin => origin.sourcePromptId === workload.seedSteps[0].id));
	const secondResult = await second.runPrompt(workload.probes.A[1].step);
	assert.equal(secondResult.recoveryResults.length, 0);
	for (const provider of providers.slice(1)) assert.ok(JSON.stringify(provider.dispatches[0].payload).includes(opaqueFixture));
	assert.ok(!JSON.stringify(firstResult).includes(opaqueFixture));
	assert.ok(!JSON.stringify(secondResult).includes(opaqueFixture));
});

test("capture refuses probes, recovery during preparation, and failed prompts", async t => {
	const root = await resources(t);
	for (const mode of ["probe", "recovery", "error"] as const) {
		const provider = await fixtureRuntime(index => mode === "recovery" && index === 23
			? { tool: { name: "search_history", arguments: { query: "incident" } }, usage: measuredUsage }
			: mode === "error" && index === 23 ? { status: 400 } : { usage: measuredUsage });
		const arm = await createPiArm({ arm: "paging", owner: owner(`source-${mode}`), agentDir: "/unused", resourceDir: join(root, mode), createRuntime: async () => provider.runtime });
		t.after(() => arm.dispose());
		await prepare(arm);
		await arm.runPrompt(mode === "probe" ? workload.probes.A[0].step : { id: "invalid-preparation", kind: "work", text: "Next record." });
		await assert.rejects(arm.captureCheckpoint());
	}
});

test("capture refuses an active native prompt and a failed settled continuation", async t => {
	const root = await resources(t);
	let dispatched!: () => void;
	const dispatch = new Promise<void>(resolve => { dispatched = resolve; });
	const provider = await fixtureRuntime(index => { if (index === 23) { dispatched(); return { waitForAbort: true }; } return { usage: measuredUsage }; });
	const arm = await createPiArm({ arm: "paging", owner: owner("source-active"), agentDir: "/unused", resourceDir: root, createRuntime: async () => provider.runtime });
	t.after(() => arm.dispose());
	await prepare(arm);
	const running = arm.runPrompt({ id: "active-work", kind: "work", text: "Next record." });
	await dispatch;
	await assert.rejects(arm.captureCheckpoint());
	await arm.abort(); await running;
	await assert.rejects(arm.captureCheckpoint());
});

test("pending native steering or follow-up messages prevent a settled checkpoint", async t => {
	const bindings = t.mock.method(AgentSession.prototype, "bindExtensions");
	const runtime = await fixtureRuntime(() => ({ usage: measuredUsage }));
	const arm = await createPiArm({ arm: "paging", owner: owner("pending-source"), agentDir: "/unused", resourceDir: await resources(t), createRuntime: async () => runtime.runtime });
	t.after(() => arm.dispose());
	await prepare(arm);
	const native = bindings.mock.calls.at(-1)!.this as AgentSession;
	await native.steer("Pending steering record.");
	await assert.rejects(arm.captureCheckpoint());
	native.clearQueue();
	await native.followUp("Pending follow-up record.");
	await assert.rejects(arm.captureCheckpoint());
	native.clearQueue();
	assert.ok(await arm.captureCheckpoint());
});

test("owned fork results become incomplete when resource cleanup fails", async t => {
	const root = await resources(t);
	const runtime = await fixtureRuntime(() => ({ usage: measuredUsage }));
	const source = await createPiArm({ arm: "paging", owner: owner("cleanup-source"), agentDir: "/unused", resourceDir: join(root, "source"), createRuntime: async () => runtime.runtime });
	t.after(() => source.dispose());
	await prepare(source);
	const checkpoint = await source.captureCheckpoint();
	const result = await runProbeFork({ checkpoint, owner: owner("cleanup-fork", checkpoint.id), step: workload.probes.A[0].step, clock: realClock,
		requestGuard() {}, createArm: async options => createPiArm({ ...options, agentDir: "/unused", resourceDir: join(root, "fork"), createRuntime: async () => (await fixtureRuntime()).runtime }),
		async cleanupSession() { await rm(join(root, "fork"), { recursive: true, force: true }); throw new Error("private cleanup details"); } });
	assert.equal(result.cleanup.complete, false);
	assert.equal(result.cleanup.failureCode, "fork-resource-cleanup-failed");
	assert.equal(result.failureCode, "fork-cleanup-failed");
	assert.ok(result.snapshot);
	assert.equal(result.snapshot.promptCount, 24);
	assert.equal(result.snapshot.requests.length, 1);
	assert.ok(result.snapshot.requests.every(request => request.sessionId === "cleanup-fork"));
	assert.ok(!JSON.stringify(result).includes("private cleanup details"));
});

test("native restoration rejects changed model metadata before an HTTP request", async t => {
	const root = await resources(t);
	const runtime = await fixtureRuntime(() => ({ usage: measuredUsage }));
	const source = await createPiArm({ arm: "paging", owner: owner("drift-source"), agentDir: "/unused", resourceDir: join(root, "source"), createRuntime: async () => runtime.runtime });
	t.after(() => source.dispose());
	await prepare(source);
	const checkpoint = await source.captureCheckpoint();
	const model = runtime.runtime.getModel("openai-codex", "gpt-6-luna")!;
	const changed = await fixtureRuntime(undefined, [{ ...model, contextWindow: model.contextWindow + 1 }]);
	const result = await runProbeFork({ checkpoint, owner: owner("drift-fork", checkpoint.id), step: workload.probes.A[0].step, clock: realClock,
		requestGuard() {}, createArm: async options => createPiArm({ ...options, agentDir: "/unused", resourceDir: join(root, "fork"), createRuntime: async () => changed.runtime }),
		async cleanupSession() { await rm(join(root, "fork"), { recursive: true, force: true }); } });
	assert.equal(result.failureCode, "fork-setup-failed");
	assert.equal(result.snapshot, null);
	assert.equal(changed.dispatches.length, 0);
	assert.equal(result.cleanup.complete, true);
});

test("baseline restore retains native compaction without paging tools", async t => {
	const root = await resources(t);
	const providers: Awaited<ReturnType<typeof fixtureRuntime>>[] = [];
	const createRuntime = async () => {
		// Two bounded response events cross native keepRecentTokens without losing observation.
		const provider = await fixtureRuntime(index => ({ text: index === 1 || index === 2 ? "Native incident analysis. ".repeat(2_000) : "Retained native summary.",
			usage: { ...measuredUsage, input_tokens: index === 2 ? 270_000 : 100 } }));
		providers.push(provider); return provider.runtime;
	};
	const baselineOwner = { ...owner("baseline-source"), arm: "baseline" as const };
	const source = await createPiArm({ arm: "baseline", owner: baselineOwner, agentDir: "/unused", resourceDir: join(root, "source"), createRuntime });
	t.after(() => source.dispose());
	await prepare(source);
	assert.ok(source.snapshot().compactions.some(event => event.success));
	const checkpoint = await source.captureCheckpoint();
	const restored = await createPiArm({ arm: "baseline", owner: { ...baselineOwner, sessionId: "baseline-fork", checkpointId: checkpoint.id, forkId: "baseline-fork" }, checkpoint,
		agentDir: "/unused", resourceDir: join(root, "fork"), createRuntime });
	t.after(() => restored.dispose());
	assert.equal(providers[1].dispatches.length, 0);
	assert.deepEqual(restored.snapshot().entries, source.snapshot().entries);
	assert.ok(restored.snapshot().compactions.every(event => event.inherited));
	assert.equal(restored.snapshot().usageLedger.length, 0);
	const result = await restored.runPrompt(workload.probes.B[0].step);
	assert.ok(result.requests.every(request => request.blocks.every(block => block.kind !== "tool-declaration")));
	assert.ok(result.requests[0].blocks.some(block => block.compactionEntryId));
});
