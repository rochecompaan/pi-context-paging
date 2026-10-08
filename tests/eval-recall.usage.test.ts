import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage, normalizeAttemptUsage, ExecutionUsageLedger } from "../eval/recall/usage.ts";
import { completeProviderUsage, providerAttempt, requestWith, sdkUsage, usageOwner } from "./fixtures/eval-recall-usage.ts";
import type { UsageLedgerEntry } from "../eval/recall/pi-journal.ts";
import type { ProviderUsageObservation } from "../eval/recall/codex-runtime.ts";
import { projectProviderUsage } from "../eval/recall/codex-usage.ts";

function observation(requestId: string, input: number, output: number, cached: number): ProviderUsageObservation {
	return projectProviderUsage({ type: "response.completed", response: { usage: {
		input_tokens: input, output_tokens: output, input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
	} } }, requestId, `${requestId}-attempt`)!;
}

function row(id: string, input = 100, kind: UsageLedgerEntry["kind"] = "assistant"): UsageLedgerEntry {
	return { entryId: id, kind, requestIds: [id], catalogPricesKnown: true,
		sdkUsage: { input, output: 7, cacheRead: 20, cacheWrite: 0, totalTokens: input + 27,
			cost: { input: 1, output: 0.3, cacheRead: 0.2, cacheWrite: 0, total: 1.5 } },
		observations: [observation(id, input + 20, 7, 20)] };
}

test("owned SDK token and cost normalization is used rather than recomputed from provider totals", () => {
	const result = aggregateUsage([row("assistant", 80)]);
	assert.equal(result.inputTokens, 80);
	assert.equal(result.outputTokens, 7);
	assert.equal(result.cacheReadTokens, 20);
	assert.equal(result.cacheWriteTokens, 0);
	assert.equal(result.estimatedCost, 1.5);
});

test("native compaction is a subtotal, not another addition to the session total", () => {
	const compaction = row("summary", 100, "compaction");
	const result = aggregateUsage([row("assistant", 800), row("usage-entry", 100, "explicit"), compaction, compaction]);
	assert.equal(result.inputTokens, 1000);
	assert.equal(result.compaction.inputTokens, 100);
	assert.equal(result.estimatedCost, 4.5);
	assert.equal(result.compaction.estimatedCost, 1.5);
	assert.equal(result.entries, 3);
});

for (const [field, unknowns] of [
	["inputTokens", ["inputTokens", "estimatedCost"]],
	["outputTokens", ["outputTokens", "estimatedCost"]],
	["cachedTokens", ["inputTokens", "cacheReadTokens", "estimatedCost"]],
	["cacheWriteTokens", ["inputTokens", "cacheWriteTokens", "estimatedCost"]],
] as const) test(`missing raw ${field} makes dependent totals unknown despite persisted zeros`, () => {
	const entry = row("missing");
	entry.observations = [{ ...entry.observations[0], [field]: null }];
	const result = aggregateUsage([row("complete"), entry]);
	for (const component of unknowns) assert.equal(result[component], null);
	assert.ok(result.missing.some(missing => missing.entryId === "missing" && missing.requestId === "missing"));
	if (field !== "outputTokens") assert.equal(result.outputTokens, 14);
});

test("reported zero remains known zero and is distinct from an omitted field", () => {
	const entry = row("zero", 0);
	entry.sdkUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	entry.observations = [observation("zero", 0, 0, 0)];
	const result = aggregateUsage([entry]);
	assert.equal(result.inputTokens, 0);
	assert.equal(result.outputTokens, 0);
	assert.equal(result.cacheReadTokens, 0);
	assert.equal(result.cacheWriteTokens, 0);
	assert.equal(result.estimatedCost, 0);
	assert.deepEqual(result.missing, []);
});

test("every contributing split-turn request needs its own raw usage observation", () => {
	const entry = row("summary", 100, "compaction");
	entry.requestIds = ["summary", "split-turn"];
	const result = aggregateUsage([entry]);
	assert.equal(result.inputTokens, null);
	assert.equal(result.outputTokens, null);
	assert.equal(result.compaction.estimatedCost, null);
	assert.ok(result.missing.some(missing => missing.requestId === "split-turn" && missing.reason === "missing-observation"));
});

test("unknown catalog prices make cost unknown without discarding measured tokens", () => {
	const entry = row("unpriced");
	entry.catalogPricesKnown = false;
	const result = aggregateUsage([entry]);
	assert.equal(result.inputTokens, 100);
	assert.equal(result.estimatedCost, null);
	assert.ok(result.missing.some(missing => missing.reason === "missing-catalog-prices"));
});

test("inconsistent duplicates cannot erase a missing request or invent a normalized zero", () => {
	const entry = row("duplicate");
	const missing = { ...entry, requestIds: ["duplicate", "absent"] };
	assert.equal(aggregateUsage([missing, entry]).inputTokens, null);
	assert.equal(aggregateUsage([entry, missing]).inputTokens, null);
	assert.equal(aggregateUsage([entry, { ...entry, sdkUsage: { ...entry.sdkUsage!, input: 0 } }]).inputTokens, null);
});

test("invalid or missing SDK measurements never become measured zeros", () => {
	for (const sdkUsage of [null, { ...row("invalid").sdkUsage!, output: Number.NaN }]) {
		const result = aggregateUsage([{ ...row("invalid"), sdkUsage }]);
		assert.equal(result.outputTokens, null);
		assert.equal(result.estimatedCost, null);
	}
});

test("conflicting raw observations cannot authorize a complete measurement", () => {
	const entry = row("conflict");
	const observation: ProviderUsageObservation = { ...entry.observations[0], outputTokens: null };
	const result = aggregateUsage([entry, { ...entry, observations: [observation] }]);
	assert.equal(result.outputTokens, null);
	assert.equal(result.estimatedCost, null);
});

test("attempt usage distinguishes all input, uncached input, reasoning subset, and omitted writes", () => {
	const usage = normalizeAttemptUsage(providerAttempt(), sdkUsage());
	assert.equal(usage.totalInputTokens.value, 100);
	assert.equal(usage.uncachedInputTokens.value, 80);
	assert.equal(usage.outputTokens.value, 7);
	assert.equal(usage.reasoningTokens.value, 3);
	assert.equal(usage.totalTokens.value, 107);
	assert.equal(usage.totalTokens.status, "derived");
	assert.equal(usage.cacheReadTokens.value, 20);
	assert.equal(usage.cacheReadFraction.value, 0.2);
	assert.deepEqual(usage.cacheWriteTokens, { value: null, status: "not-reported", reason: "provider-field-omitted" });
});

test("explicit writes are input components; valid zeros remain known", () => {
	for (const write of [0, 5]) {
		const usage = normalizeAttemptUsage(providerAttempt({ ...completeProviderUsage,
			input_tokens_details: { cached_tokens: 20, cache_write_tokens: write } }), null);
		assert.equal(usage.uncachedInputTokens.value, 80 - write);
		assert.equal(usage.cacheWriteTokens.value, write);
		assert.equal(usage.totalTokens.value, 107);
	}
	const zero = normalizeAttemptUsage(providerAttempt({ input_tokens: 0, output_tokens: 0,
		input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }), null);
	assert.equal(zero.totalTokens.value, 0);
	assert.equal(zero.cacheWriteTokens.value, 0);
	assert.equal(zero.reasoningTokens.value, 0);
	assert.equal(zero.cacheReadFraction.value, null);
	assert.equal(zero.cacheReadFraction.status, "not-applicable");
});

test("independently reported input survives missing cache and optional reasoning", () => {
	const missingCache = normalizeAttemptUsage(providerAttempt({ input_tokens: 100, output_tokens: 7 }), sdkUsage());
	assert.equal(missingCache.totalInputTokens.value, 100);
	assert.equal(missingCache.totalTokens.value, 107);
	assert.equal(missingCache.uncachedInputTokens.value, null);
	assert.equal(missingCache.cacheReadFraction.value, null);
	assert.equal(missingCache.reasoningTokens.value, null);
	assert.equal(missingCache.reasoningTokens.status, "not-reported");
	const missingInput = normalizeAttemptUsage(providerAttempt({ output_tokens: 7, input_tokens_details: { cached_tokens: 20 } }), sdkUsage());
	assert.equal(missingInput.totalInputTokens.value, null);
	assert.equal(missingInput.totalTokens.value, null);
	assert.equal(missingInput.outputTokens.value, 7);
});

test("invalid counts, inconsistent components, and unsafe sums are never normalized zeros", () => {
	for (const input of [-1, 1.5, "100", Number.NaN]) {
		const usage = normalizeAttemptUsage(providerAttempt({ ...completeProviderUsage, input_tokens: input }), null);
		assert.equal(usage.totalInputTokens.status, "invalid");
		assert.equal(usage.totalTokens.value, null);
	}
	const impossible = normalizeAttemptUsage(providerAttempt({ ...completeProviderUsage,
		input_tokens_details: { cached_tokens: 101 }, output_tokens_details: { reasoning_tokens: 8 } }), null);
	assert.equal(impossible.totalInputTokens.value, 100);
	assert.equal(impossible.uncachedInputTokens.status, "invalid");
	assert.equal(impossible.cacheReadFraction.status, "invalid");
	assert.equal(impossible.reasoningTokens.status, "invalid");
	const overflow = normalizeAttemptUsage(providerAttempt({ ...completeProviderUsage, input_tokens: Number.MAX_SAFE_INTEGER }), null);
	assert.equal(overflow.totalTokens.status, "invalid");
});

test("SDK defaults do not fabricate fields, and unsupported SDK normalization is rejected", () => {
	const usage = normalizeAttemptUsage(providerAttempt(), { ...sdkUsage(), input: 79, reasoning: 0 });
	assert.equal(usage.totalInputTokens.value, 100);
	assert.equal(usage.uncachedInputTokens.status, "invalid");
	assert.equal(usage.reasoningTokens.status, "invalid");
	assert.equal(usage.cacheWriteTokens.value, null);
});

test("equivalent observations deduplicate; conflicting or foreign observations stay invalid", () => {
	const attempt = providerAttempt();
	attempt.usageObservations = [attempt.providerUsage, structuredClone(attempt.providerUsage)];
	assert.equal(normalizeAttemptUsage(attempt, null).outputTokens.value, 7);
	attempt.usageObservations.push({ ...attempt.providerUsage, outputTokens: 8 });
	assert.equal(normalizeAttemptUsage(attempt, null).outputTokens.status, "invalid");
	attempt.usageObservations = [{ ...attempt.providerUsage, attemptId: "foreign-attempt" }];
	assert.equal(normalizeAttemptUsage(attempt, null).totalInputTokens.status, "invalid");
});

test("failed attempts survive without SDK entries and missing stream observation differs from omission", () => {
	const ledger = new ExecutionUsageLedger();
	const attempt = providerAttempt(); attempt.timing.status = "failed";
	ledger.recordRequest(requestWith(attempt));
	assert.equal(ledger.snapshot().length, 1);
	assert.equal(ledger.snapshot()[0].usage.totalInputTokens.value, 100);
	assert.deepEqual(ledger.snapshot()[0].sdkEntryIds, []);
	attempt.observationComplete = false;
	attempt.providerUsage = { ...attempt.providerUsage, usagePresent: false, inputTokens: null };
	assert.equal(ledger.snapshot()[0].usage.totalInputTokens.status, "incomplete");
});

test("conflicting diagnostic joins propagate unknowns without adding another charge", () => {
	const ledger = new ExecutionUsageLedger();
	ledger.recordRequest(requestWith(providerAttempt()));
	ledger.joinSdkEntry({ owner: usageOwner, entryId: "assistant", kind: "assistant", requestIds: ["request"], sdkUsage: sdkUsage() });
	ledger.joinSdkEntry({ owner: usageOwner, entryId: "explicit", kind: "explicit", requestIds: ["request"], sdkUsage: { ...sdkUsage(), output: 8 } });
	const rows = ledger.snapshot();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].usage.outputTokens.status, "invalid");
	assert.equal(rows[0].usage.totalTokens.value, null);
});

test("SDK joins never multiply preparation across forks or duplicate compaction charges", () => {
	const ledger = new ExecutionUsageLedger();
	for (const [sessionId, forkId] of [["source", null], ["fork-one", "one"], ["fork-two", "two"]] as const) {
		const owner = { ...usageOwner, sessionId, forkId, checkpointId: forkId ? "checkpoint" : null };
		const request = requestWith(providerAttempt(undefined, owner, "request"));
		ledger.recordRequest(request); ledger.recordRequest(request);
		for (const kind of ["assistant", "explicit"] as const) ledger.joinSdkEntry({ owner, entryId: `${sessionId}-${kind}`, kind,
			requestIds: ["request"], sdkUsage: sdkUsage() });
	}
	assert.equal(ledger.snapshot().length, 3);
	assert.equal(ledger.snapshot().reduce((sum, row) => sum + row.usage.totalInputTokens.value!, 0), 300);
	for (const id of ["summary-one", "summary-two"]) {
		const request = requestWith(providerAttempt(undefined, usageOwner, id));
		request.purpose = "compaction"; request.attempts[0].purpose = "compaction";
		ledger.recordRequest(request);
	}
	ledger.joinSdkEntry({ owner: usageOwner, entryId: "summary", kind: "compaction",
		requestIds: ["summary-one", "summary-two"], sdkUsage: { ...sdkUsage(160), output: 14, cacheRead: 40 } });
	const rows = ledger.snapshot();
	assert.equal(rows.length, 5);
	assert.equal(rows.filter(row => row.purpose === "compaction").length, 2);
	assert.equal(rows.reduce((sum, row) => sum + row.usage.totalInputTokens.value!, 0), 500);
	assert.throws(() => ledger.joinSdkEntry({ owner: { ...usageOwner, sessionId: "foreign" }, entryId: "foreign", kind: "assistant",
		requestIds: ["request"], sdkUsage: sdkUsage() }), /owned|ownership|unknown/i);
});
