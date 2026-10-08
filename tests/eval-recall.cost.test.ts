import assert from "node:assert/strict";
import test from "node:test";
import { calculateCost, type Api, type Model } from "@earendil-works/pi-ai";
import { EVAL_MODEL } from "../eval/recall/codex-runtime.ts";
import { describePricing, priceAttempt } from "../eval/recall/cost.ts";
import { normalizeAttemptUsage } from "../eval/recall/usage.ts";
import { makeFixtureProvider } from "./fixtures/eval-recall-provider.ts";
import { completeProviderUsage, providerAttempt, sdkUsage } from "./fixtures/eval-recall-usage.ts";

function model(): Model<Api> {
	const pinned = makeFixtureProvider().getModels().find(model => model.id === EVAL_MODEL.id)!;
	return { ...pinned, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } };
}
function completeUsage(input = 100) {
	return normalizeAttemptUsage(providerAttempt({ ...completeProviderUsage, input_tokens: input,
		input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 } }), null);
}

test("complete catalog components match native calculateCost, not persisted SDK cost", () => {
	const pinned = model(), evidence = describePricing(pinned);
	const usage = normalizeAttemptUsage(providerAttempt({ ...completeProviderUsage,
		input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 } }), sdkUsage());
	const costs = priceAttempt(usage, pinned, evidence), native = calculateCost(pinned, sdkUsage());
	assert.equal(costs.uncachedInputCostUsd.value, native.input);
	assert.equal(costs.outputCostUsd.value, native.output);
	assert.equal(costs.cacheReadCostUsd.value, native.cacheRead);
	assert.equal(costs.cacheWriteCostUsd.value, native.cacheWrite);
	assert.equal(costs.estimatedCostUsd.value, native.total);
	assert.equal(costs.knownCostSubtotalUsd.value, native.total);
	assert.equal(costs.actualCostUsd.value, null);
	assert.equal(costs.actualCostUsd.status, "not-reported");
});

test("measured charged writes reduce uncached input and price exactly once", () => {
	const pinned = model(); pinned.cost.cacheWrite = 3;
	const usage = normalizeAttemptUsage(providerAttempt({ ...completeProviderUsage,
		input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 } }), null);
	const costs = priceAttempt(usage, pinned, describePricing(pinned));
	const native = calculateCost(pinned, { ...sdkUsage(70), cacheWrite: 10 });
	assert.equal(usage.totalInputTokens.value, 100);
	assert.equal(costs.cacheWriteCostUsd.value, native.cacheWrite);
	assert.equal(costs.estimatedCostUsd.value, native.total);
});

test("native tier boundaries include cached input and reprice the whole request", () => {
	const pinned = model();
	pinned.cost.tiers = [{ inputTokensAbove: 100, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 }];
	const evidence = describePricing(pinned);
	for (const totalInput of [100, 101]) {
		const priced = priceAttempt(completeUsage(totalInput), pinned, evidence);
		const sdk = sdkUsage(totalInput - 20), native = calculateCost(pinned, sdk);
		assert.equal(priced.estimatedCostUsd.value, native.total);
		assert.equal(priced.outputCostUsd.value, native.output);
		assert.equal(priced.cacheReadCostUsd.value, native.cacheRead);
	}
	assert.ok(priceAttempt(completeUsage(101), pinned, evidence).outputCostUsd.value!
		> priceAttempt(completeUsage(100), pinned, evidence).outputCostUsd.value!);
});

test("zero-price catalog evidence can establish a non-applicable write charge without inventing usage", () => {
	const pinned = model(), usage = normalizeAttemptUsage(providerAttempt(), null), evidence = describePricing(pinned);
	const priced = priceAttempt(usage, pinned, evidence);
	assert.equal(usage.cacheWriteTokens.value, null);
	assert.equal(evidence.applicableCharges.cacheWrite, false);
	assert.equal(priced.cacheWriteCostUsd.value, null);
	assert.equal(priced.cacheWriteCostUsd.status, "not-applicable");
	assert.equal(priced.estimatedCostUsd.value, calculateCost(pinned, sdkUsage()).total);
});

test("omission never makes a charge non-applicable, including a charged write tier", () => {
	for (const tiered of [false, true]) {
		const pinned = model();
		if (tiered) pinned.cost.tiers = [{ inputTokensAbove: 100, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 3 }];
		else pinned.cost.cacheWrite = 3;
		const usage = normalizeAttemptUsage(providerAttempt(), null), evidence = describePricing(pinned);
		const costs = priceAttempt(usage, pinned, evidence);
		assert.equal(evidence.applicableCharges.cacheWrite, true);
		assert.equal(costs.estimatedCostUsd.value, null);
		assert.ok(costs.knownCostSubtotalUsd.value! > 0);
		assert.match(costs.knownCostSubtotalUsd.reason!, /partial/);
	}
});

test("missing usage and prices preserve supported partial components, never a complete estimate", () => {
	const pinned = model(); pinned.cost.output = Number.NaN;
	let costs = priceAttempt(completeUsage(), pinned, describePricing(pinned));
	assert.equal(costs.outputCostUsd.value, null);
	assert.equal(costs.estimatedCostUsd.value, null);
	assert.equal(costs.knownCostSubtotalUsd.value, costs.uncachedInputCostUsd.value! + costs.cacheReadCostUsd.value!);
	assert.match(costs.knownCostSubtotalUsd.reason!, /partial/);
	const ordinary = model(), missing = normalizeAttemptUsage(providerAttempt({ output_tokens: 7 }), null);
	costs = priceAttempt(missing, ordinary, describePricing(ordinary));
	assert.equal(costs.outputCostUsd.value, calculateCost(ordinary, sdkUsage()).output);
	assert.equal(costs.uncachedInputCostUsd.value, null);
	assert.equal(costs.estimatedCostUsd.value, null);
	assert.equal(costs.knownCostSubtotalUsd.value, costs.outputCostUsd.value);
});

test("request-wide tiers require total input even for an independently known output count", () => {
	const pinned = model(); pinned.cost.tiers = [{ inputTokensAbove: 100, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 }];
	const usage = normalizeAttemptUsage(providerAttempt({ output_tokens: 7 }), null);
	const costs = priceAttempt(usage, pinned, describePricing(pinned));
	assert.equal(costs.outputCostUsd.value, null);
	assert.equal(costs.estimatedCostUsd.value, null);
	const cachedMissing = normalizeAttemptUsage(providerAttempt({ input_tokens: 101, output_tokens: 7 }), null);
	const partial = priceAttempt(cachedMissing, pinned, describePricing(pinned));
	assert.equal(partial.outputCostUsd.value, calculateCost(pinned, { ...sdkUsage(101), cacheRead: 0 }).output);
});

test("a matching fingerprint cannot authorize a forged charge-applicability assumption", () => {
	const pinned = model(); pinned.cost.cacheWrite = 3;
	const evidence = describePricing(pinned);
	const forged = { ...evidence, applicableCharges: { ...evidence.applicableCharges, cacheWrite: false } };
	const usage = normalizeAttemptUsage(providerAttempt(), null);
	assert.equal(priceAttempt(usage, pinned, forged).estimatedCostUsd.status, "invalid");
	assert.equal(priceAttempt(usage, pinned, forged).estimatedCostUsd.value, null);
});

test("model drift, unsupported mappings, malformed tiers, and overflowing costs fail closed", () => {
	const pinned = model(), evidence = describePricing(pinned);
	pinned.cost.input = 2;
	assert.equal(priceAttempt(completeUsage(), pinned, evidence).estimatedCostUsd.status, "invalid");
	const unsupported = { ...model(), api: "openai-responses" as const };
	assert.equal(priceAttempt(completeUsage(), unsupported, describePricing(unsupported)).estimatedCostUsd.value, null);
	const malformed = model(); malformed.cost.tiers = [{ inputTokensAbove: Number.NaN, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 }];
	assert.equal(priceAttempt(completeUsage(), malformed, describePricing(malformed)).estimatedCostUsd.status, "invalid");
	const huge = model(); huge.cost.output = Number.MAX_VALUE;
	const massiveOutput = normalizeAttemptUsage(providerAttempt({ ...completeProviderUsage, output_tokens: 1_000_000_000 }), null);
	assert.equal(priceAttempt(massiveOutput, huge, describePricing(huge)).estimatedCostUsd.value, null);
});
