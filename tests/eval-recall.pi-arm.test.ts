import { ownerFixture } from "./fixtures/eval-recall.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { PAGING_TOOL_NAMES } from "../src/history.ts";
import { realClock } from "../eval/recall/clock.ts";
import { createPiArm } from "../eval/recall/pi-arm.ts";
import { buildWorkStep, buildWorkload } from "../eval/recall/workload.ts";
import { fixtureRuntime, measuredUsage } from "./fixtures/eval-recall-provider.ts";

const workload = buildWorkload("pi-arm-fixture");
async function privateResources(t: test.TestContext) {
	const path = await mkdtemp(join(tmpdir(), "recall-arm-test-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

test("isolated real SDK arms expose only the intended recovery surface", async t => {
	for (const arm of ["baseline", "paging"] as const) {
		const fixture = await fixtureRuntime(() => ({ usage: measuredUsage }));
		const instance = await createPiArm({ arm, owner: ownerFixture(arm), agentDir: "/unused", resourceDir: await privateResources(t),
			createRuntime: async () => fixture.runtime });
		t.after(() => instance.dispose());
		const result = await instance.runPrompt(workload.seedSteps[0]);
		assert.equal(result.errors.length, 0);
		assert.equal(result.promptCount, 1);
		assert.equal(result.requests.length, 1);
		const declarations = result.requests[0].blocks.filter(block => block.kind === "tool-declaration")
			.map(block => JSON.parse(block.text).name).sort();
		assert.deepEqual(declarations, arm === "baseline" ? [] : [...PAGING_TOOL_NAMES].sort());
		assert.equal(result.requests[0].complete, true);
		assert.ok(result.requests[0].blocks.some(block => block.sourcePromptId === workload.seedSteps[0].id));
		assert.equal(result.usageLedger[0].sdkUsage?.input, 80);
		assert.equal(result.usageLedger[0].observations[0].inputTokens, 100);
		assert.equal(result.executionUsage.length, 1);
		assert.equal(result.executionUsage[0].usage.totalInputTokens.value, 100);
		assert.equal(result.executionUsage[0].usage.uncachedInputTokens.value, 80);
		assert.deepEqual(result.executionUsage[0].sdkEntryIds, [result.usageLedger[0].entryId]);
		assert.equal(result.modelMetadata.contextWindow, instance.snapshot().modelMetadata.contextWindow);
		assert.ok(!JSON.stringify(result).includes("e30."));
	}
});

test("failed native requests remain in execution usage even when SDK usage is only a default zero", async t => {
	const fixture = await fixtureRuntime(() => ({ status: 400, errorText: "PRIVATE_PROVIDER_FAILURE" }));
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	const result = await instance.runPrompt(workload.seedSteps[0]);
	assert.ok(result.executionUsage.length > 0);
	assert.equal(result.executionUsage.length, result.requestRecords.flatMap(request => request.attempts).length);
	assert.ok(result.executionUsage.every(row => row.usage.totalInputTokens.value === null));
	assert.ok(!JSON.stringify(result.executionUsage).includes("PRIVATE_PROVIDER_FAILURE"));
	assert.equal(result.taskRecords.find(row => row.phase === "prompt")?.timing.status, "failed");
});

test("native success cannot hide a lost mandatory response observer or authorize a checkpoint", async t => {
	const hugeAnswer = "valid native answer ".repeat(4_000);
	const fixture = await fixtureRuntime(index => ({ text: index === 22 ? hugeAnswer : "ack", usage: measuredUsage }));
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	for (let i = 0; i < 22; i++) await instance.runPrompt(buildWorkStep(workload.seed, i));
	const result = await instance.runPrompt(buildWorkStep(workload.seed, 22));
	assert.equal(result.finalAnswerText, hugeAnswer);
	assert.equal(result.promptCount, 23);
	const request = result.requestRecords.at(-1)!;
	assert.equal(request.status, "succeeded");
	assert.equal(request.attempts[0].observationComplete, false);
	assert.equal(request.attempts[0].failureCode, "stream-buffer-limit");
	assert.ok(result.errors.some(error => error.code === "mandatory-observation-incomplete"));
	assert.equal(result.taskRecords.filter(row => row.phase === "prompt").at(-1)!.timing.status, "failed");
	await assert.rejects(instance.captureCheckpoint(), /eligible/);
});

test("native completed responses without optional usage or text deltas remain usable", async t => {
	const fixture = await fixtureRuntime(() => ({ text: "" }));
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	const result = await instance.runPrompt(workload.seedSteps[0]);
	assert.equal(result.errors.length, 0);
	assert.equal(result.requestRecords[0].attempts[0].observationComplete, true);
	assert.equal(result.requestRecords[0].attempts[0].timeToFirstTextMs.status, "not-reported");
	assert.equal(result.executionUsage[0].usage.totalInputTokens.status, "not-reported");
	assert.equal(result.taskRecords.find(row => row.phase === "prompt")!.timing.status, "succeeded");
});

test("a measured rejected HTTP retry is not mistaken for mandatory response observation loss", async t => {
	const fixture = await fixtureRuntime(index => index === 0 ? { status: 500 } : { text: "ack", usage: measuredUsage }, undefined, true, { maxRetries: 1 });
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	const result = await instance.runPrompt(workload.seedSteps[0]);
	assert.equal(result.errors.length, 0);
	const request = result.requestRecords[0];
	assert.equal(request.status, "succeeded"); assert.equal(request.attempts.length, 2);
	assert.equal(request.attempts[0].httpStatus, 500); assert.equal(request.attempts[0].responseHeadersMs.status, "observed");
	assert.equal(request.attempts[0].observationComplete, false); assert.equal(request.attempts[1].observationComplete, true);
	assert.equal(result.executionUsage.length, 2);
	assert.equal(result.executionUsage[1].usage.totalInputTokens.value, 100);
});

test("a refused native capture retains its failed host-phase boundary", async t => {
	const fixture = await fixtureRuntime(() => ({ usage: measuredUsage }));
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	await instance.runPrompt(workload.seedSteps[0]);
	await assert.rejects(instance.captureCheckpoint(), /eligible/);
	const rows = instance.snapshot().taskRecords;
	assert.equal(rows.find(row => row.phase === "source-setup")?.timing.status, "succeeded");
	const failed = rows.find(row => row.phase === "checkpoint-capture")!;
	assert.equal(failed?.timing.status, "failed");
	assert.ok(failed.timing.durationMs.value! >= 0);
});

test("an awaited native payload gate rejects before any HTTP attempt", async t => {
	const fixture = await fixtureRuntime(() => ({ usage: measuredUsage }));
	let attempts = 0, observed = false;
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime, requestGuard: () => { attempts++; },
		payloadGuard: async evidence => {
			await Promise.resolve(); observed = evidence.complete;
			assert.ok(evidence.blocks.some(block => block.text === workload.seedSteps[0].text));
			throw new Error("Host wire gate refused");
		} });
	t.after(() => instance.dispose());
	const snapshot = await instance.runPrompt(workload.seedSteps[0]);
	assert.equal(attempts, 0);
	assert.equal(observed, true);
	assert.equal(snapshot.requestRecords.length, 1);
	assert.equal(snapshot.requestRecords[0].attempts.length, 0);
	assert.equal(snapshot.requestRecords[0].status, "failed");
});

test("native prompt and tool timing spans through idle rather than adding nested provider work", async t => {
	let now = 10, usageCount = 0;
	const clock = { ...realClock, nowMs: () => now, utcNow: () => new Date(Date.UTC(2026, 9, 7) + now).toISOString() };
	const fixture = await fixtureRuntime(index => index === 0
		? { tool: { name: "search_history", arguments: { query: "incident" } }, usage: measuredUsage }
		: { text: "final", usage: measuredUsage });
	const instance = await createPiArm({ arm: "paging", owner: ownerFixture("paging"), agentDir: "/unused", resourceDir: await privateResources(t),
		clock, createRuntime: async () => fixture.runtime, eventSink: event => {
			if (event.type === "message_start" && now === 10) now = 12;
			if (event.type === "usage-observation" && ++usageCount === 1) now = 20;
			if (event.type === "tool_execution_start") now = 20;
			if (event.type === "tool_execution_end") now = 25;
			if (event.type === "agent_end") now = 40;
		} });
	t.after(() => instance.dispose());
	const result = await instance.runPrompt(workload.seedSteps[0]);
	assert.equal(result.taskRecords.find(row => row.phase === "prompt")?.promptTaskMs?.value, 30);
	const tool = result.taskRecords.find(row => row.phase === "tool")!;
	assert.equal(tool.toolWallMs?.value, 5);
	assert.equal(tool.toolCallId, result.recoveryResults[0].toolCallId);
	assert.equal(tool.requestId, result.requests[0].requestId);
	assert.equal(result.requestRecords[0].requestWallMs.value, 8);
});

test("real recovery tool execution settles its follow-up before returning a prompt snapshot", async t => {
	let sourceId = "";
	const fixture = await fixtureRuntime(index => index === 1 ? {
		tool: { name: "load_history", arguments: { historyIds: [sourceId] } }, usage: measuredUsage,
	} : { text: index === 2 ? "final recovered answer" : "ack", usage: measuredUsage });
	const instance = await createPiArm({ arm: "paging", owner: ownerFixture("paging"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	const seeded = await instance.runPrompt(workload.seedSteps[0]);
	sourceId = seeded.entries.find(entry => entry.type === "message" && entry.message.role === "user")!.id;
	const result = await instance.runPrompt(workload.probes.A[0].step);
	assert.equal(result.requests.length, 3);
	assert.equal(result.finalAnswerText, "final recovered answer");
	assert.equal(result.recoveryResults.length, 1);
	assert.equal(result.recoveryResults[0].isError, false);
	assert.ok(result.recoveryResults[0].text.includes(workload.facts[0].value));
	assert.ok(result.recoveryResults[0].eventIndex < result.finalAnswerEventIndex);
	assert.equal(result.recoveryResults[0].requestId, result.requests[1].requestId);
	assert.deepEqual(result.usageLedger.map(entry => entry.requestIds.length), [1, 1, 1]);
	assert.ok(result.requests[2].blocks.some(block => block.kind === "tool-result"));
});

test("native split-turn compaction joins both raw usage observations to one persisted summary", async t => {
	const hugeAnswer = "Fixture incident analysis. ".repeat(4_000);
	const fixture = await fixtureRuntime(index => index === 1 ? {
		text: hugeAnswer, usage: { ...measuredUsage, input_tokens: 270_000 },
	} : index === 2 ? { text: workload.facts[0].value } : { text: "summary or ack", usage: measuredUsage });
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	await instance.runPrompt(workload.seedSteps[0]);
	const compacted = await instance.runPrompt(buildWorkStep(workload.seed, 0));
	assert.equal(compacted.compactions.filter(event => event.success).length, 1);
	assert.equal(compacted.taskRecords.filter(row => row.phase === "compaction" && row.timing.status === "succeeded").length, 1);
	const entry = compacted.usageLedger.find(entry => entry.kind === "compaction")!;
	assert.equal(entry.requestIds.length, 2);
	assert.equal(compacted.executionUsage.length, 4);
	const summaries = compacted.executionUsage.filter(row => row.purpose === "compaction");
	assert.equal(summaries.length, 2);
	assert.deepEqual(summaries.map(row => row.sdkEntryIds), [[entry.entryId], [entry.entryId]]);
	assert.deepEqual(summaries.map(row => row.usage.totalInputTokens.value), [null, 100]);
	assert.ok(summaries.every(row => row.usage.sdkCrossCheck.status === "not-checkable"));
	assert.deepEqual(entry.observations.map(observation => observation.usagePresent), [false, true]);
	assert.deepEqual(compacted.requests.map(request => request.purpose), ["conversation", "conversation", "compaction", "compaction"]);
	// The oversized earlier response lost mandatory observation. Keep its available joins,
	// but do not allow a later prompt to turn this partial trace into a complete source.
	assert.ok(compacted.errors.some(error => error.code === "mandatory-observation-incomplete"));
	await assert.rejects(instance.runPrompt(buildWorkStep(workload.seed, 1)), /unavailable/);
	assert.equal(fixture.dispatches.length, 4);
});

test("paging cancels native overflow compaction without recording a successful summary", async t => {
	const fixture = await fixtureRuntime(index => index === 3 ? { status: 400, errorText: "Your input exceeds the context window of this model" }
		: { usage: { ...measuredUsage, input_tokens: 16_000 } });
	const instance = await createPiArm({ arm: "paging", owner: ownerFixture("paging"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	await instance.runPrompt(buildWorkStep(workload.seed, 0));
	await instance.runPrompt(buildWorkStep(workload.seed, 1));
	await instance.runPrompt(buildWorkStep(workload.seed, 2));
	const result = await instance.runPrompt(buildWorkStep(workload.seed, 3));
	assert.equal(result.requests.length, 4);
	assert.ok(result.compactions.some(event => event.reason === "overflow" && !event.success));
	assert.ok(result.taskRecords.some(row => row.phase === "compaction" && row.timing.status === "canceled"));
	assert.ok(!result.entries.some(entry => entry.type === "compaction"));
});

test("paging also cancels threshold compaction after enough native recent history exists", async t => {
	const fixture = await fixtureRuntime(index => ({ usage: { ...measuredUsage, input_tokens: index < 3 ? 16_000 : 270_000 } }));
	const instance = await createPiArm({ arm: "paging", owner: ownerFixture("paging"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	for (let index = 0; index < 4; index++) await instance.runPrompt(buildWorkStep(workload.seed, index));
	const result = instance.snapshot();
	assert.equal(result.requests.length, 4);
	assert.ok(result.compactions.some(event => event.reason === "threshold" && !event.success));
	assert.ok(result.taskRecords.some(row => row.phase === "compaction" && row.timing.status === "canceled"));
	assert.ok(!result.entries.some(entry => entry.type === "compaction"));
});

test("full-budget paging removes an early source only from outgoing context, not raw history", async t => {
	const fixture = await fixtureRuntime((_index, context) => ({ usage: { ...measuredUsage,
		input_tokens: context.messages.reduce((sum, message) => sum + estimateTokens(message), 0) } }));
	const instance = await createPiArm({ arm: "paging", owner: ownerFixture("paging"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	await instance.runPrompt(workload.seedSteps[0]);
	for (let index = 0; index < 18; index++) await instance.runPrompt(buildWorkStep(workload.seed, index));
	const result = instance.snapshot();
	assert.equal(result.errors.length, 0);
	assert.equal(result.modelMetadata.contextWindow, fixture.runtime.getModel("openai-codex", "gpt-6-luna")!.contextWindow);
	assert.ok(!result.requests.at(-1)!.blocks.some(block => block.sourcePromptId === workload.seedSteps[0].id));
	assert.ok(result.entries.some(entry => entry.type === "message" && entry.message.role === "user"
		&& JSON.stringify(entry.message.content).includes(workload.seedSteps[0].text.split("\n")[1])));
	assert.ok(!result.compactions.some(event => event.success));
});

test("ordinary persisted usage retains missing-field presence rather than SDK normalized zeros", async t => {
	const samples = [{}, { usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } },
		{ usage: { output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } },
		{ usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 } } },
		{ usage: { input_tokens: 0, output_tokens: 0 } }];
	const fixture = await fixtureRuntime(index => ({ text: "ack", ...samples[index] }));
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	for (let index = 0; index < samples.length; index++) await instance.runPrompt(workload.seedSteps[index]);
	const ledger = instance.snapshot().usageLedger;
	assert.deepEqual(ledger.map(entry => entry.observations[0].usagePresent), [false, true, true, true, true]);
	assert.deepEqual(ledger.map(entry => entry.observations[0].inputTokens), [null, 0, null, 0, 0]);
	assert.deepEqual(ledger.map(entry => entry.observations[0].outputTokens), [null, 0, 0, null, 0]);
	assert.deepEqual(ledger.map(entry => entry.observations[0].cachedTokens), [null, 0, 0, 0, null]);
	assert.deepEqual(ledger.map(entry => entry.sdkUsage?.input), [0, 0, 0, 0, 0]);
});

test("private provider error text cannot enter snapshot artifacts", async t => {
	const fixture = await fixtureRuntime(() => ({ status: 400, errorText: "Bearer PRIVATE_ERROR_SENTINEL" }));
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	const result = await instance.runPrompt(workload.seedSteps[0]);
	assert.ok(result.errors.length > 0);
	assert.ok(!JSON.stringify(result).includes("PRIVATE_ERROR_SENTINEL"));
});

test("aborting an active SSE request settles the real SDK prompt and preserves unknown usage", async t => {
	let dispatched!: () => void;
	const started = new Promise<void>(resolve => { dispatched = resolve; });
	const fixture = await fixtureRuntime(() => { dispatched(); return { waitForAbort: true }; });
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime });
	t.after(() => instance.dispose());
	const running = instance.runPrompt(workload.seedSteps[0]);
	await started;
	await instance.abort();
	const result = await running;
	assert.equal(fixture.dispatches[0].signal?.aborted, true);
	assert.ok(result.errors.some(error => error.code === "assistant-aborted"));
	assert.equal(result.taskRecords.find(row => row.phase === "prompt")?.timing.status, "aborted");
	assert.equal(result.usageLedger[0].observations[0].inputTokens, null);
});

test("an actual HTTP request guard can stop dispatch and preserves partial evidence", async t => {
	const fixture = await fixtureRuntime(() => ({ usage: measuredUsage }));
	const instance = await createPiArm({ arm: "baseline", owner: ownerFixture("baseline"), agentDir: "/unused", resourceDir: await privateResources(t),
		createRuntime: async () => fixture.runtime, requestGuard: () => { throw new Error("stop"); } });
	t.after(() => instance.dispose());
	const result = await instance.runPrompt(workload.seedSteps[0]);
	assert.equal(fixture.dispatches.length, 0);
	assert.ok(result.errors.length > 0);
	assert.ok(result.usageLedger.every(entry => entry.observations.every(observation => !observation.usagePresent)));
});
