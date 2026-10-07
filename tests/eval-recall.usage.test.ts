import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage } from "../eval/recall/usage.ts";
import type { UsageLedgerEntry } from "../eval/recall/pi-journal.ts";
import type { ProviderUsageObservation } from "../eval/recall/codex-runtime.ts";

function row(id: string, input = 100, kind: UsageLedgerEntry["kind"] = "assistant"): UsageLedgerEntry {
	return { entryId: id, kind, requestIds: [id], catalogPricesKnown: true,
		sdkUsage: { input, output: 7, cacheRead: 20, cacheWrite: 0, totalTokens: input + 27,
			cost: { input: 1, output: 0.3, cacheRead: 0.2, cacheWrite: 0, total: 1.5 } },
		observations: [{ requestId: id, usagePresent: true, inputTokens: input + 20, outputTokens: 7, cachedTokens: 20, cacheWriteTokens: 0 }] };
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
	entry.observations = [{ requestId: "zero", usagePresent: true, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }];
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
