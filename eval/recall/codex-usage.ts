import type { RequestMeta } from "./codex-payload.ts";

export type ProviderUsageObservation = {
	requestId: string;
	usagePresent: boolean;
	error?: string;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedTokens: number | null;
	cacheWriteTokens: number | null;
};
function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function projectUsage(event: unknown, requestId: string): ProviderUsageObservation | null {
	if (!object(event) || !["response.completed", "response.done", "response.incomplete"].includes(String(event.type))) return null;
	const response = object(event.response) ? event.response : {};
	const present = Object.hasOwn(response, "usage");
	const errors: string[] = [];
	if (present && !object(response.usage)) errors.push("invalid-usage");
	const usage = object(response.usage) ? response.usage : {};
	const details = object(usage.input_tokens_details) ? usage.input_tokens_details : {};
	if (Object.hasOwn(usage, "input_tokens_details") && !object(usage.input_tokens_details)) errors.push("invalid-input-details");
	const field = (record: Record<string, unknown>, key: string): number | null => {
		if (!Object.hasOwn(record, key)) return null;
		const value = record[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
		errors.push(`invalid-${key}`); return null;
	};
	const result: ProviderUsageObservation = { requestId, usagePresent: present,
		inputTokens: field(usage, "input_tokens"), outputTokens: field(usage, "output_tokens"),
		cachedTokens: field(details, "cached_tokens"), cacheWriteTokens: field(details, "cache_write_tokens") };
	return { ...result, ...(errors.length ? { error: errors.join(",") } : {}) };
}

// Observe a consumed stream, not a clone/tee that reads ahead of the adapter.
// Bytes and cancellation pass through; only a terminal usage projection survives.
export function observeSseUsage(response: Response, meta: RequestMeta,
	onObservation: (observation: ProviderUsageObservation) => void): Response {
	if (!response.ok || !response.body) return response;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let done = false;
	let disabled = false;
	const consume = (text: string, final = false) => {
		if (disabled || done) return;
		buffered += text;
		// Bound observer memory. Never truncate or reject the provider's bytes.
		if (buffered.length > 8 * 1024 * 1024) { disabled = true; buffered = ""; return; }
		const frames = buffered.split(/\r?\n\r?\n/);
		buffered = final ? "" : frames.pop()!;
		for (const frame of frames) {
			const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
				.map(line => line.slice(5).replace(/^ /, "")).join("\n");
			if (!data || data === "[DONE]") continue;
			try {
				const observation = projectUsage(JSON.parse(data), meta.requestId);
				if (observation && !done) { done = true; onObservation(observation); }
			} catch { /* Native adapter owns parse errors; presence remains unknown. */ }
		}
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) { consume(decoder.decode(), true); controller.close(); reader.releaseLock(); return; }
				consume(decoder.decode(next.value, { stream: true }));
				controller.enqueue(next.value);
			} catch (error) { buffered = ""; controller.error(error); reader.releaseLock(); }
		},
		async cancel(reason) { buffered = ""; await reader.cancel(reason); reader.releaseLock(); },
	}, { highWaterMark: 0 });
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
