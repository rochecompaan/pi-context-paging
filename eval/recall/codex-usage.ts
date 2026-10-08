import type { MeasurementStatus } from "./metrics.ts";

export type ProviderField = "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "reasoningTokens";
export type ProviderUsageObservation = {
	requestId: string;
	attemptId?: string;
	usagePresent: boolean;
	error?: string;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedTokens: number | null;
	cacheWriteTokens: number | null;
	reasoningTokens: number | null;
	fieldStatus: Record<ProviderField, MeasurementStatus>;
};
export function unknownProviderUsage(requestId: string, error?: string, attemptId?: string): ProviderUsageObservation {
	return { requestId, ...(attemptId ? { attemptId } : {}), usagePresent: false, ...(error ? { error } : {}),
		inputTokens: null, outputTokens: null, cachedTokens: null, cacheWriteTokens: null, reasoningTokens: null,
		fieldStatus: { inputTokens: "not-reported", outputTokens: "not-reported", cachedTokens: "not-reported",
			cacheWriteTokens: "not-reported", reasoningTokens: "not-reported" } };
}
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drop bodies, error text, output items, and signatures; retain only numeric presence. */
export function projectProviderUsage(event: unknown, requestId: string, attemptId: string): ProviderUsageObservation | null {
	if (!isObject(event) || !["response.completed", "response.done", "response.incomplete", "response.failed"].includes(String(event.type))) return null;
	const response = isObject(event.response) ? event.response : {};
	const result = unknownProviderUsage(requestId, undefined, attemptId);
	result.usagePresent = Object.hasOwn(response, "usage");
	const errors: string[] = [];
	const invalidUsage = result.usagePresent && !isObject(response.usage);
	if (invalidUsage) errors.push("invalid-usage");
	const usage = isObject(response.usage) ? response.usage : {};
	const detail = (key: string) => {
		const invalid = Object.hasOwn(usage, key) && !isObject(usage[key]);
		if (invalid) errors.push(`invalid-${key}`);
		return { record: isObject(usage[key]) ? usage[key] : {}, invalid: invalidUsage || invalid };
	};
	const input = detail("input_tokens_details"), output = detail("output_tokens_details");
	const field = (name: ProviderField, record: Record<string, unknown>, key: string, invalid: boolean) => {
		if (invalid) { result.fieldStatus[name] = "invalid"; return; }
		if (!Object.hasOwn(record, key)) return;
		const value = record[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
			result[name] = value; result.fieldStatus[name] = "observed";
		} else { result.fieldStatus[name] = "invalid"; errors.push(`invalid-${key}`); }
	};
	field("inputTokens", usage, "input_tokens", invalidUsage);
	field("outputTokens", usage, "output_tokens", invalidUsage);
	field("cachedTokens", input.record, "cached_tokens", input.invalid);
	field("cacheWriteTokens", input.record, "cache_write_tokens", input.invalid);
	field("reasoningTokens", output.record, "reasoning_tokens", output.invalid);
	if (errors.length) result.error = errors.join(",");
	return result;
}
