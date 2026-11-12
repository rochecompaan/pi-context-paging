export const DEFAULT_CONTEXT_TOKEN_BUDGET = 128_000;

export type ContextPagingSettingsSources = {
	globalSettings: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
};

/** A token count, or `"auto"`/`"auto:<ratio>"` as a fraction of the active model's context window. */
export type TokenBudgetSetting = number | { autoRatio: number };

export const DEFAULT_AUTO_BUDGET_RATIO = 0.5;

export type ResolvedContextPagingSettings = {
	enabled: boolean;
	/** The configured budget, or the default when `tokenBudgetAutoRatio` is set. */
	tokenBudget: number;
	/** Set when `tokenBudget` is `"auto"`; the budget then follows the model window. */
	tokenBudgetAutoRatio?: number;
	trimToTokens: number;
	trimToTokensExplicit: boolean;
	/** Per-model overrides keyed by exact `provider/modelId`, merged field by field. */
	modelOverrides: ReadonlyMap<string, ContextPagingModelOverride>;
};

export type ContextPagingModelOverride = {
	enabled?: boolean;
	tokenBudget?: TokenBudgetSetting;
	trimToTokens?: number;
};

export type ContextPagingModelSettings = Omit<ResolvedContextPagingSettings, "modelOverrides" | "tokenBudgetAutoRatio"> & {
	/** True when the active model's override set `enabled`. */
	enabledByModelOverride: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModelOverrides(settings: unknown, into: Map<string, ContextPagingModelOverride>): void {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return;
	const overrides = settings.contextPaging.modelOverrides;
	if (!isRecord(overrides)) return;
	for (const [modelKey, override] of Object.entries(overrides)) {
		if (!isRecord(override)) continue;
		const merged = { ...into.get(modelKey) };
		if (typeof override.enabled === "boolean") merged.enabled = override.enabled;
		const tokenBudget = readTokenBudget(override);
		if (tokenBudget !== undefined) merged.tokenBudget = tokenBudget;
		const trimToTokens = readTokenValue(override, "trimToTokens");
		if (trimToTokens !== undefined) merged.trimToTokens = trimToTokens;
		into.set(modelKey, merged);
	}
}

function budgetForWindow(setting: TokenBudgetSetting, contextWindow: number | undefined): number {
	if (typeof setting === "number") return setting;
	if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return DEFAULT_CONTEXT_TOKEN_BUDGET;
	}
	return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(contextWindow * setting.autoRatio)));
}

/**
 * Returns the settings for a model, before any session command. An `"auto"` budget is a
 * fraction of `contextWindow`, or the default budget when the window is unknown.
 * A model `tokenBudget` without a model `trimToTokens` derives its target from that budget,
 * because a top-level explicit target was chosen for the top-level budget.
 */
export function settingsForModel(
	settings: ResolvedContextPagingSettings,
	modelKey: string | undefined,
	contextWindow?: number,
): ContextPagingModelSettings {
	const { modelOverrides, tokenBudgetAutoRatio, ...base } = settings;
	const override = modelKey === undefined ? undefined : modelOverrides.get(modelKey);
	const budgetSetting = override?.tokenBudget
		?? (tokenBudgetAutoRatio === undefined ? base.tokenBudget : { autoRatio: tokenBudgetAutoRatio });
	const tokenBudget = budgetForWindow(budgetSetting, contextWindow);
	const explicitTarget = override?.trimToTokens
		?? (override?.tokenBudget === undefined && base.trimToTokensExplicit ? base.trimToTokens : undefined);
	return {
		enabled: override?.enabled ?? base.enabled,
		tokenBudget,
		...(typeof budgetSetting === "number" ? {} : { tokenBudgetAutoRatio: budgetSetting.autoRatio }),
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

function readTokenSetting(settings: unknown, key: "trimToTokens"): number | undefined {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return undefined;
	return readTokenValue(settings.contextPaging, key);
}

function readTokenValue(record: Record<string, unknown>, key: "tokenBudget" | "trimToTokens"): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function readTokenBudget(record: Record<string, unknown>): TokenBudgetSetting | undefined {
	const value = record.tokenBudget;
	if (typeof value !== "string") return readTokenValue(record, "tokenBudget");
	if (value === "auto") return { autoRatio: DEFAULT_AUTO_BUDGET_RATIO };
	if (!value.startsWith("auto:")) return undefined;
	const ratioText = value.slice("auto:".length);
	const autoRatio = Number(ratioText);
	return ratioText.trim() !== "" && Number.isFinite(autoRatio) && autoRatio > 0 && autoRatio <= 1
		? { autoRatio }
		: undefined;
}

function readTokenBudgetSetting(settings: unknown): TokenBudgetSetting | undefined {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return undefined;
	return readTokenBudget(settings.contextPaging);
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
	const budgetSetting = readTokenBudgetSetting(projectSettings)
		?? readTokenBudgetSetting(sources.globalSettings)
		?? DEFAULT_CONTEXT_TOKEN_BUDGET;
	const tokenBudget = typeof budgetSetting === "number" ? budgetSetting : DEFAULT_CONTEXT_TOKEN_BUDGET;
	const explicitTarget = readTokenSetting(projectSettings, "trimToTokens")
		?? readTokenSetting(sources.globalSettings, "trimToTokens");
	const modelOverrides = new Map<string, ContextPagingModelOverride>();
	readModelOverrides(sources.globalSettings, modelOverrides);
	readModelOverrides(projectSettings, modelOverrides);
	return {
		enabled: readEnabledSetting(projectSettings)
			?? readEnabledSetting(sources.globalSettings)
			?? true,
		tokenBudget,
		...(typeof budgetSetting === "number" ? {} : { tokenBudgetAutoRatio: budgetSetting.autoRatio }),
		trimToTokens: explicitTarget ?? defaultTrimToTokens(tokenBudget),
		trimToTokensExplicit: explicitTarget !== undefined,
		modelOverrides,
	};
}
