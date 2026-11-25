export const DEFAULT_CONTEXT_TOKEN_BUDGET = 128_000;

export type ContextPagingSettingsSources = {
	globalSettings: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
};

export type ResolvedContextPagingSettings = {
	enabled: boolean;
	tokenBudget: number;
	trimToTokens: number;
	trimToTokensExplicit: boolean;
	/** Per-model overrides keyed by exact `provider/modelId`, merged field by field. */
	modelOverrides: ReadonlyMap<string, ContextPagingModelOverride>;
	/** Override values that do not apply, so the extension can report them once. */
	settingProblems: readonly string[];
};

export type ContextPagingModelOverride = {
	enabled?: boolean;
	tokenBudget?: number;
	trimToTokens?: number;
};

export type ContextPagingModelSettings = Omit<ResolvedContextPagingSettings, "modelOverrides" | "settingProblems"> & {
	/** True when the active model's override set `enabled`. */
	enabledByModelOverride: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MODEL_OVERRIDE_FIELDS = new Set(["enabled", "tokenBudget", "trimToTokens"]);

function readModelOverrides(
	settings: unknown,
	source: "global" | "project",
	into: Map<string, ContextPagingModelOverride>,
	problems: string[],
): void {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return;
	const overrides = settings.contextPaging.modelOverrides;
	if (overrides === undefined) return;
	if (!isRecord(overrides)) {
		problems.push(`${source} contextPaging.modelOverrides must be an object.`);
		return;
	}
	for (const [modelKey, override] of Object.entries(overrides)) {
		const path = `${source} contextPaging.modelOverrides[${JSON.stringify(modelKey)}]`;
		if (!isRecord(override)) {
			problems.push(`${path} must be an object.`);
			continue;
		}
		const merged = { ...into.get(modelKey) };
		if (typeof override.enabled === "boolean") merged.enabled = override.enabled;
		else if (override.enabled !== undefined) problems.push(`${path}.enabled must be true or false.`);
		for (const key of ["tokenBudget", "trimToTokens"] as const) {
			const value = readTokenValue(override, key);
			if (value !== undefined) merged[key] = value;
			else if (override[key] !== undefined) problems.push(`${path}.${key} must be a positive integer.`);
		}
		for (const field of Object.keys(override)) {
			if (!MODEL_OVERRIDE_FIELDS.has(field)) problems.push(`${path} has an unknown field ${JSON.stringify(field)}.`);
		}
		into.set(modelKey, merged);
	}
}

/**
 * Returns the settings for a model, before any session command.
 * A model `tokenBudget` without a model `trimToTokens` derives its target from that budget,
 * because a top-level explicit target was chosen for the top-level budget.
 */
export function settingsForModel(
	settings: ResolvedContextPagingSettings,
	modelKey: string | undefined,
): ContextPagingModelSettings {
	const { modelOverrides, ...base } = settings;
	const override = modelKey === undefined ? undefined : modelOverrides.get(modelKey);
	const tokenBudget = override?.tokenBudget ?? base.tokenBudget;
	const explicitTarget = override?.trimToTokens
		?? (override?.tokenBudget === undefined && base.trimToTokensExplicit ? base.trimToTokens : undefined);
	return {
		enabled: override?.enabled ?? base.enabled,
		tokenBudget,
		trimToTokens: explicitTarget ?? defaultTrimToTokens(tokenBudget),
		trimToTokensExplicit: explicitTarget !== undefined,
		enabledByModelOverride: override?.enabled !== undefined,
	};
}

function readEnabledSetting(settings: unknown): boolean | undefined {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return undefined;
	return typeof settings.contextPaging.enabled === "boolean"
		? settings.contextPaging.enabled
		: undefined;
}

function readTokenSetting(settings: unknown, key: "tokenBudget" | "trimToTokens"): number | undefined {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return undefined;
	return readTokenValue(settings.contextPaging, key);
}

function readTokenValue(record: Record<string, unknown>, key: "tokenBudget" | "trimToTokens"): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

/** Computes the adaptive target without rounding an integer product before division. */
export function defaultTrimToTokens(tokenBudget: number): number {
	return Math.max(1, Number(BigInt(tokenBudget) * 5n / 8n));
}

/** Resolves trusted-project values over global values, then derives implicit targets. */
export function resolveContextPagingSettings(
	sources: ContextPagingSettingsSources,
): ResolvedContextPagingSettings {
	const projectSettings = sources.projectTrusted ? sources.projectSettings : undefined;
	const tokenBudget = readTokenSetting(projectSettings, "tokenBudget")
		?? readTokenSetting(sources.globalSettings, "tokenBudget")
		?? DEFAULT_CONTEXT_TOKEN_BUDGET;
	const explicitTarget = readTokenSetting(projectSettings, "trimToTokens")
		?? readTokenSetting(sources.globalSettings, "trimToTokens");
	const modelOverrides = new Map<string, ContextPagingModelOverride>();
	const settingProblems: string[] = [];
	readModelOverrides(sources.globalSettings, "global", modelOverrides, settingProblems);
	readModelOverrides(projectSettings, "project", modelOverrides, settingProblems);
	return {
		enabled: readEnabledSetting(projectSettings)
			?? readEnabledSetting(sources.globalSettings)
			?? true,
		tokenBudget,
		trimToTokens: explicitTarget ?? defaultTrimToTokens(tokenBudget),
		trimToTokensExplicit: explicitTarget !== undefined,
		modelOverrides,
		settingProblems,
	};
}
