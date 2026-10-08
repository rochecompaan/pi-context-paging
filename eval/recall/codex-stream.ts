import type { Clock } from "./clock.ts";
import { elapsed, finishOperation, missing, type AttemptRecord, type OperationStatus } from "./metrics.ts";
import { isObject, projectProviderUsage, type ProviderUsageObservation } from "./codex-usage.ts";

export type StreamObservationOptions = {
	attempt: AttemptRecord; clock: Clock; signal?: AbortSignal | null; maxBufferedChars?: number;
	onUsage(observation: ProviderUsageObservation): void;
	onDelta?(kind: "model" | "text", elapsedMs: number): void;
	onSettled(attempt: AttemptRecord): void;
};

export function settleAttempt(attempt: AttemptRecord, clock: Clock, status: OperationStatus,
	reason: string | null = null, complete = false): boolean {
	if (attempt.timing.endMs !== null) return false;
	finishOperation(attempt.timing, status, clock);
	attempt.attemptWallMs = attempt.timing.durationMs;
	attempt.observationComplete = complete;
	attempt.failureCode = reason;
	for (const key of ["timeToFirstModelDeltaMs", "timeToFirstTextMs"] as const) {
		if (attempt[key].value === null) attempt[key] = missing(complete ? "not-reported" : "incomplete",
			reason ?? (key === "timeToFirstTextMs" ? "no-text-delta" : "no-model-delta"));
	}
	if (!complete && !attempt.providerUsage.error) attempt.providerUsage.error = reason ?? "stream-incomplete";
	return true;
}

/** Observe only bytes the native adapter consumes; never tee, replace, or read ahead. */
export function observeCodexStream(response: Response, options: StreamObservationOptions): Response {
	const { attempt, clock } = options;
	const decoder = new TextDecoder();
	const limit = options.maxBufferedChars ?? 64 * 1024;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let line = "", data = "", skipLine = false, skipEvent = false;
	let lost: string | null = null;
	let done = false;
	const settle = (status: OperationStatus, reason: string | null = null, terminal = false) => {
		if (done) return;
		done = true; options.signal?.removeEventListener("abort", aborted);
		if (settleAttempt(attempt, clock, status, lost ?? reason, terminal && !lost)) options.onSettled(attempt);
	};
	const aborted = () => settle("aborted", "stream-aborted");
	const delta = (kind: "model" | "text") => {
		const key = kind === "model" ? "timeToFirstModelDeltaMs" : "timeToFirstTextMs";
		if (lost || attempt[key].value !== null) return;
		attempt[key] = elapsed(attempt.timing.startMs, clock.nowMs());
		if (attempt[key].value !== null) options.onDelta?.(kind, attempt[key].value);
	};
	const event = (text: string) => {
		if (done || !text || text === "[DONE]") return;
		let value: unknown;
		try { value = JSON.parse(text); } catch { lost ??= "invalid-sse-json"; return; }
		if (!isObject(value)) return;
		if (typeof value.delta === "string" && value.delta.length > 0) {
			if (value.type === "response.output_text.delta") { delta("model"); delta("text"); }
			else if (["response.function_call_arguments.delta", "response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(String(value.type))) delta("model");
		}
		const usage = projectProviderUsage(value, attempt.requestId, attempt.attemptId);
		if (usage) { attempt.providerUsage = usage; attempt.usageObservations.push(usage); options.onUsage(usage); }
		if (["response.completed", "response.done", "response.failed", "response.incomplete", "error"].includes(String(value.type))) {
			const status = !response.ok || value.type === "response.failed" || value.type === "error" ? "failed"
				: value.type === "response.incomplete" ? "censored" : "succeeded";
			settle(status, status === "failed" ? "provider-response-failed" : status === "censored" ? "provider-response-incomplete" : null, true);
		}
	};
	const finishLine = () => {
		const current = line.endsWith("\r") ? line.slice(0, -1) : line;
		line = "";
		if (skipLine) { skipLine = false; return; }
		if (!current) { if (!skipEvent) event(data); data = ""; skipEvent = false; return; }
		if (!skipEvent && current.startsWith("data:")) {
			const part = current.slice(5).replace(/^ /, "");
			if (data.length + part.length + 1 > limit) { lost ??= "stream-buffer-limit"; skipEvent = true; data = ""; }
			else data += (data ? "\n" : "") + part;
		}
	};
	const consume = (text: string) => {
		if (done) return;
		for (const char of text) {
			if (char === "\n") finishLine();
			else if (!skipLine) {
				if (line.length >= limit) { lost ??= "stream-buffer-limit"; skipLine = true; skipEvent = true; line = ""; data = ""; }
				else line += char;
			}
		}
	};
	if (options.signal?.aborted) aborted();
	else options.signal?.addEventListener("abort", aborted, { once: true });
	if (!response.body) { settle(response.ok ? "censored" : "failed", "response-without-body"); return response; }
	const upstream = response.body;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				reader ??= upstream.getReader();
				const next = await reader.read();
				if (next.done) {
					consume(decoder.decode()); settle(response.ok ? "censored" : "failed", "stream-without-terminal");
					line = data = ""; controller.close(); reader.releaseLock(); return;
				}
				// Decode bounded slices; the original byte chunk is forwarded unchanged.
				for (let offset = 0; offset < next.value.length; offset += 4096) consume(decoder.decode(next.value.subarray(offset, offset + 4096), { stream: true }));
				controller.enqueue(next.value);
			} catch (error) {
				settle(options.signal?.aborted ? "aborted" : "failed", "stream-reader-error");
				line = data = ""; controller.error(error); reader?.releaseLock();
			}
		},
		async cancel(reason) {
			settle(options.signal?.aborted ? "aborted" : "canceled", "stream-canceled"); line = data = "";
			if (reader) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } }
			else await upstream.cancel(reason);
		},
	}, { highWaterMark: 0 });
	const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
	for (const key of ["url", "type", "redirected"] as const) Object.defineProperty(observed, key, { get: () => response[key] });
	return observed;
}
