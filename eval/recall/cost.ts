import { isDeepStrictEqual } from "node:util";
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { EVAL_MODEL, metadataFor, metadataFingerprint } from "./codex-runtime.ts";
import { missing, type Measurement, type NormalizedUsage } from "./metrics.ts";

export type CostMeasurements = {
	uncachedInputCostUsd: Measurement<number>; outputCostUsd: Measurement<number>;
	cacheReadCostUsd: Measurement<number>; cacheWriteCostUsd: Measurement<number>;
	estimatedCostUsd: Measurement<number>; knownCostSubtotalUsd: Measurement<number>; actualCostUsd: Measurement<number>;
};
type Rates = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
export type PricingEvidence = {
	currency: "USD"; units: "USD-per-million-tokens"; modelMetadataFingerprint: string;
	providerMapping: "native-openai-codex-responses" | null; provider: string; modelId: string; api: string;
	baseRates: Rates; tiers: (Rates & { inputTokensAbove: number | null })[]; tiersValid: boolean;
	applicableCharges: { uncachedInput: true; output: true; cacheRead: true; cacheWrite: boolean | null };
	missingRequirements: string[]; omittedWriteInputNormalization: "native-optional-field-default-only";
};
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const rateFields = ["input", "output", "cacheRead", "cacheWrite"] as const;
const components = {
	uncachedInputCostUsd: { usage: "uncachedInputTokens", native: "input" },
	outputCostUsd: { usage: "outputTokens", native: "output" },
	cacheReadCostUsd: { usage: "cacheReadTokens", native: "cacheRead" },
	cacheWriteCostUsd: { usage: "cacheWriteTokens", native: "cacheWrite" },
} as const;
function rates(value: unknown, path: string, requirements: string[]): Rates {
	const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
	return Object.fromEntries(rateFields.map(field => {
		if (!valid(record[field])) requirements.push(`${path}.${field}`);
		return [field, valid(record[field]) ? record[field] : null];
	})) as Rates;
}

/** The captured catalog, not an omitted wire field, establishes charge applicability. */
export function describePricing(model: Model<Api>): PricingEvidence {
	const missingRequirements: string[] = [];
	const mapping = model.provider === EVAL_MODEL.provider && model.id === EVAL_MODEL.id && model.api === "openai-codex-responses";
	if (!mapping) missingRequirements.push("unsupported-provider-mapping");
	const baseRates = rates(model.cost, "base", missingRequirements);
	const catalogTiers = model.cost?.tiers;
	let tiersValid = catalogTiers === undefined || Array.isArray(catalogTiers);
	const tiers = (Array.isArray(catalogTiers) ? catalogTiers : []).map((tier, index) => {
		const threshold = tier?.inputTokensAbove;
		if (!Number.isSafeInteger(threshold) || threshold < 0) { tiersValid = false; missingRequirements.push(`tier-${index}.threshold`); }
		return { ...rates(tier, `tier-${index}`, missingRequirements), inputTokensAbove: Number.isSafeInteger(threshold) && threshold >= 0 ? threshold : null };
	});
	if (!tiersValid) missingRequirements.push("invalid-catalog-tiers");
	const writeRates = [baseRates.cacheWrite, ...tiers.map(tier => tier.cacheWrite)];
	const cacheWrite = !mapping || !tiersValid || writeRates.some(rate => rate === null) ? null : writeRates.some(rate => rate! > 0);
	return { currency: "USD", units: "USD-per-million-tokens", modelMetadataFingerprint: metadataFingerprint(metadataFor(model)),
		providerMapping: mapping ? "native-openai-codex-responses" : null, provider: model.provider, modelId: model.id, api: model.api,
		baseRates, tiers, tiersValid, applicableCharges: { uncachedInput: true, output: true, cacheRead: true, cacheWrite },
		missingRequirements, omittedWriteInputNormalization: "native-optional-field-default-only" };
}

export function priceAttempt(usage: NormalizedUsage, model: Model<Api>, evidence: PricingEvidence): CostMeasurements {
	const result: CostMeasurements = { uncachedInputCostUsd: missing("incomplete", "missing-priced-usage"), outputCostUsd: missing("incomplete", "missing-priced-usage"),
		cacheReadCostUsd: missing("incomplete", "missing-priced-usage"), cacheWriteCostUsd: missing("incomplete", "missing-priced-usage"),
		estimatedCostUsd: missing("incomplete", "missing-applicable-components"), knownCostSubtotalUsd: missing("incomplete", "missing-priced-usage"),
		actualCostUsd: missing("not-reported", "no-attributable-billing-source") };
	const current = describePricing(model);
	const drift = current.modelMetadataFingerprint !== evidence.modelMetadataFingerprint;
	const blocked = drift ? "pricing-metadata-changed" : !isDeepStrictEqual(current, evidence) ? "pricing-evidence-changed"
		: !evidence.providerMapping || usage.providerMapping !== evidence.providerMapping ? "unsupported-provider-mapping"
		: !evidence.tiersValid ? "invalid-catalog-tiers" : null;
	if (blocked) {
		for (const field of [...Object.keys(components), "estimatedCostUsd", "knownCostSubtotalUsd"] as (keyof CostMeasurements)[]) result[field] = missing("invalid", blocked);
		return result;
	}
	const totalInput = usage.totalInputTokens.value;
	const tierUnknown = evidence.tiers.length > 0 && totalInput === null;
	const nativeUsage: Usage = {
		// A placeholder for unknown ordinary input selects only the known request-wide tier.
		// Its input cost is never exposed unless ordinary input was measured.
		input: usage.uncachedInputTokens.value ?? Math.max(0, (totalInput ?? 0) - (usage.cacheReadTokens.value ?? 0) - (usage.cacheWriteTokens.value ?? 0)),
		output: usage.outputTokens.value ?? 0, cacheRead: usage.cacheReadTokens.value ?? 0, cacheWrite: usage.cacheWriteTokens.value ?? 0,
		totalTokens: usage.totalTokens.value ?? 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const catalog = model.cost && typeof model.cost === "object" ? calculateCost(model, nativeUsage) : null;
	for (const [field, mapping] of Object.entries(components) as [keyof typeof components, typeof components[keyof typeof components]][]) {
		const measured = usage[mapping.usage];
		if (field === "cacheWriteCostUsd" && measured.value === null && evidence.applicableCharges.cacheWrite === false) {
			result[field] = missing("not-applicable", "catalog-zero-cache-write-charge"); continue;
		}
		if (tierUnknown) result[field] = missing("incomplete", "missing-request-wide-tier-input");
		else if (measured.value === null) result[field] = missing(measured.status, "missing-applicable-usage");
		else if (!catalog || !valid(catalog[mapping.native])) result[field] = missing("invalid", "missing-or-invalid-catalog-price");
		else result[field] = { value: catalog[mapping.native], status: "derived", reason: "native-calculateCost" };
	}
	const entries = Object.values(components).length;
	const values = Object.keys(components).map(field => result[field as keyof typeof components]);
	const known = values.filter(value => value.value !== null), subtotal = known.reduce((sum, value) => sum + value.value!, 0);
	const complete = values.every(value => value.value !== null || value.status === "not-applicable");
	result.knownCostSubtotalUsd = valid(subtotal) ? { value: subtotal, status: "derived", reason: complete ? "complete-applicable-components" : `partial-${known.length}-of-${entries}-components` }
		: missing("invalid", "non-finite-cost-subtotal");
	if (complete && catalog && valid(catalog.total)) result.estimatedCostUsd = { value: catalog.total, status: "derived", reason: "native-calculateCost" };
	return result;
}
