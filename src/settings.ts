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
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
/** The settings this extension reads; anything else under `contextPaging` is a key the user believes works. */
const CONTEXT_PAGING_KEYS = new Set(["enabled", "tokenBudget", "trimToTokens"]);

export type UnusableContextPagingSetting = {
	readonly key: string;
	/** What the setting accepts, in the words a user can act on. */
	readonly expected: string;
};

export type ContextPagingSettingsInspection = {
	/** Keys present under `contextPaging` that no setting reads, sorted for a stable report. */
	readonly ignored: readonly string[];
	/** Known keys whose value cannot be read, so the value falls through to the next source or the default. */
	readonly unusable: readonly UnusableContextPagingSetting[];
	/** `contextPaging` exists but is not an object, so none of the user's settings can be read. */
	readonly malformed: boolean;
};

function isTokenValue(value: unknown): boolean {
	// The same acceptance rule readTokenSetting applies: a positive safe integer, nothing else.
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const TOKEN_EXPECTATION = "a whole number of tokens greater than zero";

export function inspectContextPagingSettings(settings: unknown): ContextPagingSettingsInspection {
	if (!isRecord(settings) || !("contextPaging" in settings)) return { ignored: [], unusable: [], malformed: false };
	const section = settings.contextPaging;
	if (!isRecord(section)) return { ignored: [], unusable: [], malformed: true };
	const unusable: UnusableContextPagingSetting[] = [];
	if ("enabled" in section && typeof section.enabled !== "boolean") unusable.push({ key: "enabled", expected: "true or false" });
	if ("tokenBudget" in section && !isTokenValue(section.tokenBudget)) unusable.push({ key: "tokenBudget", expected: TOKEN_EXPECTATION });
	if ("trimToTokens" in section && !isTokenValue(section.trimToTokens)) unusable.push({ key: "trimToTokens", expected: TOKEN_EXPECTATION });
	return {
		ignored: Object.keys(section).filter((key) => !CONTEXT_PAGING_KEYS.has(key)).sort(),
		unusable: unusable.sort((left, right) => left.key.localeCompare(right.key)),
		malformed: false,
	};
}

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
	return {
		enabled: readEnabledSetting(projectSettings)
			?? readEnabledSetting(sources.globalSettings)
			?? true,
		tokenBudget,
		trimToTokens: explicitTarget ?? defaultTrimToTokens(tokenBudget),
		trimToTokensExplicit: explicitTarget !== undefined,
	};
}
