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
	/** Per-model `enabled` overrides keyed by exact `provider/modelId`. */
	modelEnabled: ReadonlyMap<string, boolean>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModelEnabledOverrides(settings: unknown, into: Map<string, boolean>): void {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return;
	const overrides = settings.contextPaging.modelOverrides;
	if (!isRecord(overrides)) return;
	for (const [modelKey, override] of Object.entries(overrides)) {
		if (isRecord(override) && typeof override.enabled === "boolean") into.set(modelKey, override.enabled);
	}
}

/** Returns whether paging is enabled for a model, before any session command. */
export function enabledForModel(settings: ResolvedContextPagingSettings, modelKey: string | undefined): boolean {
	return (modelKey === undefined ? undefined : settings.modelEnabled.get(modelKey)) ?? settings.enabled;
}

function readEnabledSetting(settings: unknown): boolean | undefined {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return undefined;
	return typeof settings.contextPaging.enabled === "boolean"
		? settings.contextPaging.enabled
		: undefined;
}

function readTokenSetting(settings: unknown, key: "tokenBudget" | "trimToTokens"): number | undefined {
	if (!isRecord(settings) || !isRecord(settings.contextPaging)) return undefined;
	const value = settings.contextPaging[key];
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
	const modelEnabled = new Map<string, boolean>();
	readModelEnabledOverrides(sources.globalSettings, modelEnabled);
	readModelEnabledOverrides(projectSettings, modelEnabled);
	return {
		enabled: readEnabledSetting(projectSettings)
			?? readEnabledSetting(sources.globalSettings)
			?? true,
		tokenBudget,
		trimToTokens: explicitTarget ?? defaultTrimToTokens(tokenBudget),
		trimToTokensExplicit: explicitTarget !== undefined,
		modelEnabled,
	};
}
