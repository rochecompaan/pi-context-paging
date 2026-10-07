import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type Provider, type Model, type Api } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { observeProvider, prepareCodexRuntime, type RequestHooks, type ProviderUsageObservation } from "../eval/recall/codex-runtime.ts";
import { fixtureRuntime, makeFixtureProvider, measuredUsage, sseResponse } from "./fixtures/eval-recall-provider.ts";

function hooks() {
	let requests = 0;
	const observations: ProviderUsageObservation[] = [];
	const events: string[] = [];
	const payloads: unknown[] = [];
	const value: RequestHooks = {
		allocateMeta: () => ({ requestId: `request-${++requests}`, promptId: "p1", arm: "baseline", purpose: "conversation" }),
		onPayload: async (_meta, payload) => { events.push("payload"); payloads.push(payload); },
		beforeHttpAttempt: () => { events.push("guard"); },
		onHttpAttemptEnd: (_meta, status) => { events.push(`status:${status}`); },
		onUsageObservation: (_meta, observation) => { observations.push(observation); },
	};
	return { value, events, payloads, observations };
}
const native = openaiCodexProvider();
const model = native.getModels().find(model => model.id === "gpt-6-luna")!;
const context = normalizeContext({ systemPrompt: "Be concise.", messages: [{ role: "user", content: "hello", timestamp: 1 }] });

test("preflight resolves only the exact available model with native window and xhigh", async () => {
	const altered = { ...model, contextWindow: 300000 };
	const fixture = await fixtureRuntime(undefined, [altered]);
	const prepared = await prepareCodexRuntime("/unused", hooks().value, async () => fixture.runtime);
	assert.equal(prepared.model.id, "gpt-6-luna");
	assert.equal(prepared.model.contextWindow, 300000);
	assert.equal(prepared.metadata.contextWindow, 300000);
	assert.equal(prepared.metadataFingerprint.length, 64);
	assert.ok(Object.isFrozen(prepared.metadata));
	assert.ok(Object.isFrozen(prepared.metadata.cost));
});

for (const [name, models, configured, code] of [
	["missing exact model", [], true, "EVAL_MODEL_UNAVAILABLE"],
	["unavailable credentials", [model], false, "EVAL_CREDENTIALS_UNAVAILABLE"],
	["unsupported xhigh", [{ ...model, thinkingLevelMap: { ...model.thinkingLevelMap, xhigh: null } }], true, "EVAL_XHIGH_UNAVAILABLE"],
] as const) test(`preflight refuses ${name} without substitution`, async () => {
	const fixture = await fixtureRuntime(undefined, models as readonly Model<Api>[], configured);
	await assert.rejects(prepareCodexRuntime("/unused", hooks().value, async () => fixture.runtime), { code });
	assert.equal(fixture.dispatches.length, 0);
});

test("metadata drift stops before model inference", async () => {
	const mutable = structuredClone(model);
	const fixture = await fixtureRuntime(undefined, [mutable]);
	const prepared = await prepareCodexRuntime("/unused", hooks().value, async () => fixture.runtime);
	mutable.contextWindow += 1;
	assert.throws(() => prepared.assertUnchanged(), /metadata/);
	assert.equal(fixture.dispatches.length, 0);
});

test("both native stream paths compose payload callbacks and force stateless SSE", async () => {
	for (const method of ["stream", "streamSimple"] as const) {
		const h = hooks();
		const provider = observeProvider(makeFixtureProvider(), h.value);
		let dispatches = 0;
		const result = await provider[method](model, context, {
			apiKey: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.fake`,
			transport: "websocket-cached", maxRetries: 0,
			onPayload: payload => { h.events.push("caller"); return { ...(payload as object), instructions: "replaced" }; },
			fetch: async () => { dispatches++; return sseResponse({ text: "native answer", usage: measuredUsage }); },
		}).result();
		assert.equal(result.stopReason, "stop");
		assert.equal(result.content.find(block => block.type === "text")?.text, "native answer");
		assert.equal(dispatches, 1);
		assert.deepEqual(h.events, ["caller", "payload", "guard", "status:200"]);
		const payload = h.payloads[0] as Record<string, unknown>;
		assert.equal(payload.instructions, "replaced");
		assert.equal(payload.store, false);
		assert.equal(Object.hasOwn(payload, "previous_response_id"), false);
		assert.deepEqual(h.observations, [{ requestId: "request-1", usagePresent: true,
			inputTokens: 100, outputTokens: 7, cachedTokens: 20, cacheWriteTokens: null }]);
	}
});

for (const [name, usage, expected] of [
	["no usage", undefined, [null, null, null]],
	["empty usage", {}, [null, null, null]],
	["missing input", { output_tokens: 0, input_tokens_details: { cached_tokens: 0 } }, [null, 0, 0]],
	["missing output", { input_tokens: 0, input_tokens_details: { cached_tokens: 0 } }, [0, null, 0]],
	["missing cached", { input_tokens: 0, output_tokens: 0 }, [0, 0, null]],
	["explicit zero", { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } }, [0, 0, 0]],
] as const) test(`retains raw field presence for ${name} despite native normalized zeros`, async () => {
	const h = hooks();
	const fixture = await fixtureRuntime(() => ({ text: "ok", ...(usage === undefined ? {} : { usage }) }));
	const prepared = await prepareCodexRuntime("/unused", h.value, async () => fixture.runtime);
	const answer = await prepared.runtime.completeSimple(prepared.model, { messages: context.messages }, { maxRetries: 0 });
	assert.equal(answer.stopReason, "stop");
	assert.equal(answer.usage.input, 0);
	assert.equal(answer.usage.output, 0);
	assert.equal(answer.usage.cacheRead, 0);
	const observation = h.observations[0];
	assert.equal(observation.usagePresent, usage !== undefined);
	assert.deepEqual([observation.inputTokens, observation.outputTokens, observation.cachedTokens], expected);
});

test("rejects invalid numeric measurements instead of treating them as measured zeros", async () => {
	const h = hooks();
	const fixture = await fixtureRuntime(() => ({ usage: { input_tokens: -1, output_tokens: "0", input_tokens_details: { cached_tokens: 0 } } }));
	const prepared = await prepareCodexRuntime("/unused", h.value, async () => fixture.runtime);
	await prepared.runtime.completeSimple(prepared.model, { messages: context.messages }, { maxRetries: 0 });
	assert.match(h.observations[0].error!, /invalid/);
	assert.equal(h.observations[0].inputTokens, null);
	assert.equal(h.observations[0].outputTokens, null);
});

test("guards every actual retry dispatch without allocating another logical request", async () => {
	const h = hooks();
	const fixture = await fixtureRuntime(index => index === 0 ? { status: 500 } : { usage: measuredUsage });
	const prepared = await prepareCodexRuntime("/unused", h.value, async () => fixture.runtime);
	const result = await prepared.runtime.completeSimple(prepared.model, { messages: context.messages }, { maxRetries: 1 });
	assert.equal(result.stopReason, "stop");
	assert.equal(fixture.dispatches.length, 2);
	assert.deepEqual(h.events, ["payload", "guard", "status:500", "guard", "status:200"]);
	assert.equal(h.observations.length, 1);
});

test("an asynchronous artifact or source guard blocks dispatch before provider fetch", async () => {
	const h = hooks();
	h.value.beforeHttpAttempt = async () => { await Promise.resolve(); throw new Error("guard blocked"); };
	const fixture = await fixtureRuntime(() => ({ usage: measuredUsage }));
	const prepared = await prepareCodexRuntime("/unused", h.value, async () => fixture.runtime);
	const answer = await prepared.runtime.completeSimple(prepared.model, { messages: context.messages }, { maxRetries: 0 });
	assert.equal(fixture.dispatches.length, 0);
	assert.equal(answer.stopReason, "error");
	assert.equal(h.observations.length, 0);
});

test("a stream without terminal response leaves measurement presence unknown", async () => {
	const h = hooks();
	const fixture = await fixtureRuntime(() => ({ terminal: false }));
	const prepared = await prepareCodexRuntime("/unused", h.value, async () => fixture.runtime);
	await prepared.runtime.completeSimple(prepared.model, { messages: context.messages }, { maxRetries: 0 });
	assert.equal(h.observations.length, 0);
});
