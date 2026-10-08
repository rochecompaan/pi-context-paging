import assert from "node:assert/strict";
import test from "node:test";
import { observeCodexStream } from "../eval/recall/codex-stream.ts";
import { createAttemptRecord } from "../eval/recall/metrics.ts";
import type { RequestMeta } from "../eval/recall/codex-payload.ts";
import { fixtureClock } from "./fixtures/eval-recall-clock.ts";

const meta: RequestMeta = { runId: "run", stage: "A", seed: "seed", arm: "paging", sessionId: "session",
	checkpointId: "checkpoint", forkId: "fork", requestId: "request", promptId: "prompt", purpose: "conversation" };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const terminal = frame({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 7,
	input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 3 } },
	output: [{ encrypted_content: "PRIVATE_OPAQUE_BYTES" }] } });

function fixture(chunks: readonly { at: number; text: string | Uint8Array }[], options: { status?: number; readerError?: Error; limit?: number; signal?: AbortSignal } = {}) {
	const time = fixtureClock();
	const attempt = createAttemptRecord(meta, "attempt-1", time.clock);
	time.at(3);
	attempt.httpStatus = options.status ?? 200;
	attempt.responseHeadersMs = { value: 3, status: "observed", reason: null };
	let reads = 0;
	let canceled: unknown;
	let settled = 0;
	const response = new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[reads++];
			if (chunk) { time.at(chunk.at); controller.enqueue(typeof chunk.text === "string" ? new TextEncoder().encode(chunk.text) : chunk.text); }
			else if (options.readerError) { time.at(23); controller.error(options.readerError); }
			else controller.close();
		},
		cancel(reason) { canceled = reason; },
	}, { highWaterMark: 0 }), { status: attempt.httpStatus, headers: { "Content-Type": "text/event-stream", "X-Fixture": "unchanged" } });
	const observed = observeCodexStream(response, { attempt, clock: time.clock, maxBufferedChars: options.limit, signal: options.signal,
		onUsage: usage => { attempt.providerUsage = usage; }, onSettled: () => { settled++; } });
	return { attempt, observed, time, reads: () => reads, canceled: () => canceled, settled: () => settled };
}

test("measures consumed content rather than headers, lifecycle events, or empty deltas", async () => {
	const chunks = [
		{ at: 4, text: frame({ type: "response.created" }) + frame({ type: "response.output_text.delta", delta: "" }) },
		{ at: 7, text: frame({ type: "response.function_call_arguments.delta", delta: "{" }) },
		{ at: 11, text: frame({ type: "response.output_text.delta", delta: "answer" }) },
		{ at: 19, text: terminal },
	];
	const f = fixture(chunks);
	assert.equal(f.reads(), 0);
	assert.equal(f.settled(), 0);
	assert.equal(await f.observed.text(), chunks.map(chunk => chunk.text).join(""));
	assert.equal(f.observed.headers.get("X-Fixture"), "unchanged");
	assert.equal(f.attempt.responseHeadersMs.value, 3);
	assert.equal(f.attempt.timeToFirstModelDeltaMs.value, 7);
	assert.equal(f.attempt.timeToFirstTextMs.value, 11);
	assert.equal(f.attempt.attemptWallMs.value, 19);
	assert.equal(f.attempt.timing.startedAtUtc, "2026-01-01T00:00:00.000Z");
	assert.equal(f.attempt.timing.endedAtUtc, "2026-01-01T00:00:00.019Z");
	assert.equal(f.attempt.timing.status, "succeeded");
	assert.equal(f.attempt.providerUsage.reasoningTokens, 3);
	assert.equal(f.settled(), 1);
	assert.equal(JSON.stringify(f.attempt).includes("PRIVATE_OPAQUE_BYTES"), false);
});

test("tool-only and reasoning-only streams report model latency but no fabricated text latency", async () => {
	for (const type of ["response.function_call_arguments.delta", "response.reasoning_summary_text.delta"]) {
		const f = fixture([{ at: 7, text: frame({ type, delta: "content" }) }, { at: 19, text: terminal }]);
		await f.observed.text();
		assert.equal(f.attempt.timeToFirstModelDeltaMs.value, 7);
		assert.equal(f.attempt.timeToFirstTextMs.value, null);
		assert.equal(f.attempt.timeToFirstTextMs.status, "not-reported");
		assert.ok(f.attempt.timeToFirstTextMs.reason);
	}
});

test("arbitrary UTF-8 and CRLF chunk boundaries preserve the original bytes and numeric projection", async () => {
	const text = frame({ type: "response.output_text.delta", delta: "café" }).replaceAll("\n", "\r\n") + terminal;
	const f = fixture([...new TextEncoder().encode(text)].map((byte, index) => ({ at: index + 4, text: Uint8Array.of(byte) })));
	assert.equal(await f.observed.text(), text);
	assert.equal(f.attempt.providerUsage.inputTokens, 100);
	assert.equal(f.attempt.timing.status, "succeeded");
});

test("a consumed non-2xx attempt retains attributable usage and finishes failed, not at headers", async () => {
	const f = fixture([{ at: 19, text: terminal }], { status: 500 });
	assert.equal(f.settled(), 0);
	await f.observed.text();
	assert.equal(f.attempt.timing.status, "failed");
	assert.equal(f.attempt.attemptWallMs.value, 19);
	assert.equal(f.attempt.providerUsage.inputTokens, 100);
	assert.equal(f.settled(), 1);
});

test("unterminated streams and invalid numeric fields remain distinguishable from observed zero", async () => {
	const unfinished = fixture([{ at: 11, text: frame({ type: "response.output_text.delta", delta: "partial" }) }]);
	await unfinished.observed.text();
	assert.equal(unfinished.attempt.timing.status, "censored");
	assert.equal(unfinished.attempt.observationComplete, false);
	assert.equal(unfinished.attempt.providerUsage.inputTokens, null);
	const f = fixture([{ at: 19, text: frame({ type: "response.completed", response: { usage: {
		input_tokens: 0, output_tokens: "0", input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: -1 },
	} } }) }]);
	await f.observed.text();
	assert.equal(f.attempt.providerUsage.inputTokens, 0);
	assert.equal(f.attempt.providerUsage.fieldStatus.inputTokens, "observed");
	assert.equal(f.attempt.providerUsage.outputTokens, null);
	assert.equal(f.attempt.providerUsage.fieldStatus.outputTokens, "invalid");
	assert.equal(f.attempt.providerUsage.fieldStatus.reasoningTokens, "invalid");
	assert.equal(f.attempt.providerUsage.fieldStatus.cacheWriteTokens, "not-reported");
});

test("cancellation preserves reason and backpressure and settles exactly once", async () => {
	const f = fixture([{ at: 11, text: frame({ type: "response.output_text.delta", delta: "partial" }) }, { at: 19, text: terminal }]);
	const reader = f.observed.body!.getReader();
	await reader.read();
	assert.equal(f.reads(), 1);
	const reason = { marker: "native-cancel" };
	f.time.at(22);
	await reader.cancel(reason);
	assert.equal(f.canceled(), reason);
	assert.equal(f.reads(), 1);
	assert.equal(f.attempt.timing.status, "canceled");
	assert.equal(f.attempt.attemptWallMs.value, 22);
	assert.equal(f.settled(), 1);
});

test("reader errors pass through unchanged while preserving failed-attempt timing", async () => {
	const error = new Error("PRIVATE_READER_ERROR");
	const f = fixture([{ at: 11, text: frame({ type: "response.output_text.delta", delta: "partial" }) }], { readerError: error });
	await assert.rejects(f.observed.text(), observed => observed === error);
	assert.equal(f.attempt.timing.status, "failed");
	assert.equal(f.attempt.attemptWallMs.value, 23);
	assert.equal(f.settled(), 1);
	assert.equal(JSON.stringify(f.attempt).includes(error.message), false);
});

test("abort after headers preserves measured duration without a successful assistant entry", async () => {
	const controller = new AbortController();
	const f = fixture([{ at: 11, text: frame({ type: "response.output_text.delta", delta: "partial" }) }, { at: 19, text: terminal }], { signal: controller.signal });
	const reader = f.observed.body!.getReader();
	await reader.read(); f.time.at(22); controller.abort();
	assert.equal(f.attempt.timing.status, "aborted");
	assert.equal(f.attempt.attemptWallMs.value, 22);
	assert.equal(f.attempt.providerUsage.inputTokens, null);
	await reader.cancel(controller.signal.reason);
	assert.equal(f.canceled(), controller.signal.reason);
	assert.equal(f.reads(), 1);
	assert.equal(f.settled(), 1);
});

for (const [details, status, value] of [[{}, "not-reported", null], [{ reasoning_tokens: 0 }, "observed", 0],
	[{ reasoning_tokens: 1.5 }, "invalid", null]] as const) test(`reasoning subset ${status} remains distinct from inferred native zero`, async () => {
	const f = fixture([{ at: 19, text: frame({ type: "response.completed", response: { usage: { output_tokens_details: details } } }) }]);
	await f.observed.text();
	assert.equal(f.attempt.providerUsage.fieldStatus.reasoningTokens, status);
	assert.equal(f.attempt.providerUsage.reasoningTokens, value);
});

test("buffer exhaustion does not truncate provider bytes or invent early-delta measurements", async () => {
	const chunks = [{ at: 7, text: frame({ type: "response.output_text.delta", delta: "x".repeat(1024) }) }, { at: 19, text: terminal }];
	const f = fixture(chunks, { limit: 512 });
	assert.equal(await f.observed.text(), chunks.map(chunk => chunk.text).join(""));
	assert.equal(f.attempt.observationComplete, false);
	assert.equal(f.attempt.timeToFirstModelDeltaMs.value, null);
	assert.equal(f.attempt.timeToFirstModelDeltaMs.status, "incomplete");
	assert.equal(f.attempt.providerUsage.inputTokens, 100);
});
