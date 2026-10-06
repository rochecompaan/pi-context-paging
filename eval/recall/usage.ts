import type { Usage } from "@earendil-works/pi-ai";
import type { ProviderUsageObservation } from "./codex-usage.ts";
import type { UsageLedgerEntry } from "./pi-journal.ts";

export type UsageTotals = {
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	estimatedCost: number | null;
};
export type MissingUsage = {
	entryId: string;
	requestId: string | null;
	component: keyof UsageTotals;
	reason: string;
};
export type UsageSummary = UsageTotals & { entries: number; compaction: UsageTotals; missing: MissingUsage[] };
type Component = keyof UsageTotals;
type RawField = "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens";
type Group = { entryId: string; rows: UsageLedgerEntry[]; requestIds: Set<string> };
const tokenFields = {
	inputTokens: { sdk: "input", raw: ["inputTokens", "cachedTokens", "cacheWriteTokens"] },
	outputTokens: { sdk: "output", raw: ["outputTokens"] },
	cacheReadTokens: { sdk: "cacheRead", raw: ["cachedTokens"] },
	cacheWriteTokens: { sdk: "cacheWrite", raw: ["cacheWriteTokens"] },
} as const;
const empty = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0 });
const token = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const cost = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function groupEntries(ledger: readonly UsageLedgerEntry[]): Group[] {
	const groups = new Map<string, Group>();
	for (const entry of ledger) {
		const group = groups.get(entry.entryId) ?? { entryId: entry.entryId, rows: [], requestIds: new Set<string>() };
		group.rows.push(entry);
		entry.requestIds.forEach(id => group.requestIds.add(id));
		groups.set(entry.entryId, group);
	}
	return [...groups.values()];
}

function rawFailure(observations: ProviderUsageObservation[], required: readonly RawField[]): string | null {
	if (!observations.length || observations.some(observation => observation.error === "no-observation")) return "missing-observation";
	if (observations.some(observation => !observation.usagePresent)) return "missing-usage";
	for (const field of required) {
		const values = observations.map(observation => observation[field]);
		if (values.some(value => !token(value))) return "missing-field";
		if (new Set(values).size > 1) return "conflicting-observation";
	}
	return null;
}

function totalsFor(group: Group, missing: MissingUsage[]): UsageTotals {
	const result = empty();
	const miss = (component: Component, reason: string, requestId: string | null = null) => {
		missing.push({ entryId: group.entryId, requestId, component, reason });
		result[component] = null;
	};
	const normalized = (component: Component, project: (usage: Usage) => unknown, valid: (value: unknown) => value is number) => {
		if (group.rows.some(row => !row.sdkUsage)) { miss(component, "missing-sdk-usage"); return; }
		const values = group.rows.map(row => project(row.sdkUsage!));
		if (!values.every(valid)) miss(component, "invalid-sdk-usage");
		else if (new Set(values).size !== 1) miss(component, "conflicting-sdk-usage");
		else result[component] = values[0] as number;
	};
	for (const [component, fields] of Object.entries(tokenFields) as [Exclude<Component, "estimatedCost">, typeof tokenFields[keyof typeof tokenFields]][]) {
		if (!group.requestIds.size) miss(component, "missing-request-join");
		for (const requestId of group.requestIds) {
			const observations = group.rows.flatMap(row => row.observations).filter(observation => observation.requestId === requestId);
			const failure = rawFailure(observations, fields.raw);
			if (failure) miss(component, failure, requestId);
		}
		if (result[component] !== null) normalized(component, usage => usage[fields.sdk], token);
	}
	if (Object.values(result).some(value => value === null)) miss("estimatedCost", "missing-token-components");
	else if (group.rows.some(row => row.catalogPricesKnown !== true)) miss("estimatedCost", "missing-catalog-prices");
	else normalized("estimatedCost", usage => {
		const prices = usage.cost;
		return prices && [prices.input, prices.output, prices.cacheRead, prices.cacheWrite].every(cost) ? prices.total : null;
	}, cost);
	return result;
}

function add(target: UsageTotals, next: UsageTotals) {
	for (const component of Object.keys(empty()) as Component[]) {
		const previous = target[component], value = next[component];
		target[component] = previous === null || value === null ? null : previous + value;
	}
}

/** Presence comes from wire observations; arithmetic uses SDK-owned normalization. */
export function aggregateUsage(ledger: readonly UsageLedgerEntry[]): UsageSummary {
	const result: UsageSummary = { ...empty(), entries: 0, compaction: empty(), missing: [] };
	for (const group of groupEntries(ledger)) {
		const totals = totalsFor(group, result.missing);
		add(result, totals);
		if (group.rows[0].kind === "compaction") add(result.compaction, totals);
		result.entries++;
	}
	return result;
}
