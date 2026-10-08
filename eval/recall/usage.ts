import type { Usage } from "@earendil-works/pi-ai";
import type { ProviderField, ProviderUsageObservation } from "./codex-usage.ts";
import { assertOwner, sameOwner, missing, type AttemptRecord, type RequestRecord, type Measurement, type NormalizedUsage, type SessionOwner } from "./metrics.ts";
export type { NormalizedUsage } from "./metrics.ts";
export { aggregateUsage, type UsageSummary, type UsageTotals, type MissingUsage } from "./usage-legacy.ts";

const token = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const derived = (value: number, reason: string | null = null): Measurement<number> => ({ value, status: "derived", reason });
const normalizedFields = ["totalInputTokens", "uncachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "cacheReadFraction"] as const;
function invalidUsage(reason: string): NormalizedUsage {
	const invalid = () => missing<number>("invalid", reason);
	return { totalInputTokens: invalid(), uncachedInputTokens: invalid(), outputTokens: invalid(), reasoningTokens: invalid(),
		totalTokens: invalid(), cacheReadTokens: invalid(), cacheWriteTokens: invalid(), cacheReadFraction: invalid(),
		providerMapping: "native-openai-codex-responses", sdkCrossCheck: { status: "not-checkable", fields: [] } };
}
function providerField(attempt: AttemptRecord, observations: ProviderUsageObservation[], field: ProviderField): Measurement<number> {
	const values = observations.map(observation => {
		const status = observation.fieldStatus[field];
		if (status === "invalid") return missing<number>("invalid", "invalid-provider-field");
		if (!observation.usagePresent) return missing<number>(attempt.observationComplete ? "not-reported" : "incomplete",
			attempt.observationComplete ? "provider-usage-omitted" : "provider-observation-incomplete");
		if (status !== "observed") return missing<number>(status, "provider-field-omitted");
		return token(observation[field]) ? { value: observation[field], status: "observed" as const, reason: null }
			: missing<number>("invalid", "invalid-provider-field");
	});
	return new Set(values.map(value => JSON.stringify(value))).size === 1 ? values[0]
		: missing("invalid", "conflicting-provider-observations");
}

/** Wire presence owns measurement validity; SDK defaults never supply optional counts. */
export function normalizeAttemptUsage(attempt: AttemptRecord, sdkUsage: Usage | null): NormalizedUsage {
	const observations = attempt.usageObservations.length ? attempt.usageObservations : [attempt.providerUsage];
	if (observations.some(row => row.requestId !== attempt.requestId || row.attemptId !== attempt.attemptId)) return invalidUsage("foreign-provider-observation");
	const totalInputTokens = providerField(attempt, observations, "inputTokens");
	let cacheReadTokens = providerField(attempt, observations, "cachedTokens"), cacheWriteTokens = providerField(attempt, observations, "cacheWriteTokens");
	let outputTokens = providerField(attempt, observations, "outputTokens"), reasoningTokens = providerField(attempt, observations, "reasoningTokens");
	const writeForInput = cacheWriteTokens.value ?? (cacheWriteTokens.status === "not-reported" ? 0 : null);
	let uncachedInputTokens: Measurement<number> = missing("incomplete", "missing-input-components");
	if (totalInputTokens.value !== null && cacheReadTokens.value !== null && writeForInput !== null) {
		const value = totalInputTokens.value - cacheReadTokens.value - writeForInput;
		if (!token(value)) {
			uncachedInputTokens = missing("invalid", "cache-components-exceed-total-input");
			cacheReadTokens = missing("invalid", "cache-components-exceed-total-input");
			if (cacheWriteTokens.value !== null) cacheWriteTokens = missing("invalid", "cache-components-exceed-total-input");
		} else uncachedInputTokens = derived(value, cacheWriteTokens.value === null ? "native-codex-omitted-write-default-for-input-only" : null);
	}
	if (reasoningTokens.value !== null && outputTokens.value !== null && reasoningTokens.value > outputTokens.value) reasoningTokens = missing("invalid", "reasoning-exceeds-output");
	const result = { totalInputTokens, uncachedInputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens };
	const sdkCrossCheck: NormalizedUsage["sdkCrossCheck"] = { status: sdkUsage ? "not-checkable" : "unjoined", fields: [] };
	if (sdkUsage) {
		const mapping = { uncachedInputTokens: "input", outputTokens: "output", cacheReadTokens: "cacheRead", cacheWriteTokens: "cacheWrite", reasoningTokens: "reasoning" } as const;
		for (const [field, sdkField] of Object.entries(mapping) as [keyof typeof mapping, typeof mapping[keyof typeof mapping]][]) {
			if (result[field].value === null || (sdkField === "reasoning" && sdkUsage.reasoning === undefined)) continue;
			if (!token(sdkUsage[sdkField]) || sdkUsage[sdkField] !== result[field].value) {
				result[field] = missing("invalid", "sdk-usage-mismatch"); sdkCrossCheck.fields.push(field);
			} else if (sdkCrossCheck.status === "not-checkable") sdkCrossCheck.status = "consistent";
		}
		if (sdkCrossCheck.fields.length) sdkCrossCheck.status = "mismatched";
	}
	let totalTokens: Measurement<number> = missing("incomplete", "missing-total-operands");
	if (totalInputTokens.value !== null && result.outputTokens.value !== null) {
		const sum = totalInputTokens.value + result.outputTokens.value;
		totalTokens = token(sum) ? derived(sum) : missing("invalid", "unsafe-token-total");
	}
	let cacheReadFraction: Measurement<number> = missing(result.cacheReadTokens.status === "invalid" ? "invalid" : "incomplete", "missing-cache-fraction-operands");
	if (totalInputTokens.value === 0 && result.cacheReadTokens.value === 0) cacheReadFraction = missing("not-applicable", "zero-input");
	else if (totalInputTokens.value !== null && totalInputTokens.value > 0 && result.cacheReadTokens.value !== null) cacheReadFraction = derived(result.cacheReadTokens.value / totalInputTokens.value);
	return { ...result, totalTokens, cacheReadFraction, providerMapping: "native-openai-codex-responses", sdkCrossCheck };
}

export type SdkUsageJoin = { owner: SessionOwner; entryId: string; kind: "assistant" | "explicit" | "compaction"; requestIds: readonly string[]; sdkUsage: Usage | null };
export type ExecutionUsageRow = SessionOwner & { requestId: string; attemptId: string; promptId: string; purpose: RequestRecord["purpose"]; usage: NormalizedUsage; sdkEntryIds: string[] };
function ownerKey(owner: SessionOwner): string {
	assertOwner(owner);
	return JSON.stringify([owner.runId, owner.stage, owner.seed, owner.arm, owner.sessionId, owner.checkpointId, owner.forkId]);
}
const requestKey = (owner: SessionOwner, requestId: string) => `${ownerKey(owner)}:${JSON.stringify(requestId)}`;

/** Only canonical actual-dispatch records charge usage; persisted entries are diagnostic joins. */
export class ExecutionUsageLedger {
	private requests = new Map<string, RequestRecord>();
	private joins = new Map<string, SdkUsageJoin>();
	recordRequest(request: RequestRecord): void {
		const key = requestKey(request, request.requestId), existing = this.requests.get(key);
		if (existing && existing !== request && JSON.stringify(existing) !== JSON.stringify(request)) throw new Error("Conflicting owned logical request");
		if (!existing) this.requests.set(key, request);
	}
	joinSdkEntry(join: SdkUsageJoin): void {
		for (const requestId of join.requestIds) if (!this.requests.has(requestKey(join.owner, requestId))) throw new Error("SDK join has unknown request ownership");
		const key = `${ownerKey(join.owner)}:${JSON.stringify(join.entryId)}`, existing = this.joins.get(key);
		if (existing && JSON.stringify(existing) !== JSON.stringify(join)) throw new Error("Conflicting owned SDK join");
		if (!existing) this.joins.set(key, structuredClone(join));
	}
	sdkEntries(): SdkUsageJoin[] { return structuredClone([...this.joins.values()]); }
	snapshot(): ExecutionUsageRow[] {
		const rows = new Map<string, ExecutionUsageRow>(), originals = new Map<string, AttemptRecord>();
		for (const request of this.requests.values()) for (const attempt of request.attempts) {
			if (!sameOwner(request, attempt) || request.requestId !== attempt.requestId || request.promptId !== attempt.promptId || request.purpose !== attempt.purpose) throw new Error("Attempt has foreign request ownership");
			const key = `${requestKey(attempt, attempt.requestId)}:${JSON.stringify(attempt.attemptId)}`;
			const existing = originals.get(key);
			if (existing) {
				if (JSON.stringify(existing) !== JSON.stringify(attempt)) rows.get(key)!.usage = invalidUsage("conflicting-attempt-record");
				continue;
			}
			originals.set(key, attempt);
			const joins = [...this.joins.values()].filter(join => sameOwner(join.owner, attempt) && join.requestIds.includes(attempt.requestId));
			const sdkRows = joins.filter(join => join.requestIds.length === 1 && attempt.timing.status === "succeeded"
				&& request.attempts.at(-1)?.attemptId === attempt.attemptId && join.sdkUsage);
			const usage = normalizeAttemptUsage(attempt, sdkRows[0]?.sdkUsage ?? null);
			if (joins.length && !sdkRows.length) usage.sdkCrossCheck.status = "not-checkable";
			for (const join of sdkRows.slice(1)) {
				const check = normalizeAttemptUsage(attempt, join.sdkUsage);
				for (const field of normalizedFields) if (check[field].value === null) usage[field] = check[field];
				if (check.sdkCrossCheck.status === "mismatched") usage.sdkCrossCheck = { status: "mismatched",
					fields: [...new Set([...usage.sdkCrossCheck.fields, ...check.sdkCrossCheck.fields])] };
			}
			rows.set(key, { runId: attempt.runId, stage: attempt.stage, seed: attempt.seed, arm: attempt.arm, sessionId: attempt.sessionId,
				checkpointId: attempt.checkpointId, forkId: attempt.forkId, requestId: attempt.requestId, attemptId: attempt.attemptId,
				promptId: attempt.promptId, purpose: attempt.purpose, usage, sdkEntryIds: joins.map(join => join.entryId) });
		}
		return structuredClone([...rows.values()]);
	}
}
