import assert from "node:assert/strict";
import test from "node:test";
import { defaultTrimToTokens, settingsForModel, resolveContextPagingSettings } from "../src/settings.ts";

const invalidTargets: unknown[] = [
	0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
	Number.MAX_SAFE_INTEGER + 1, "80000", true, null, [], {},
];

test("derives the implicit target after budget resolution", () => {
	const defaults = resolveContextPagingSettings({ globalSettings: {}, projectTrusted: false });
	assert.equal(defaults.tokenBudget, 128_000);
	assert.equal(defaults.trimToTokens, 80_000);
	assert.equal(defaults.trimToTokensExplicit, false);
	const project = resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 128_000 } },
		projectSettings: { contextPaging: { tokenBudget: 64_000 } }, projectTrusted: true,
	});
	assert.equal(project.tokenBudget, 64_000);
	assert.equal(project.trimToTokens, 40_000);
	assert.equal(project.trimToTokensExplicit, false);
});

test("keeps an explicit global target with a lower project budget", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { trimToTokens: 80_000 } },
		projectSettings: { contextPaging: { tokenBudget: 64_000 } }, projectTrusted: true,
	});
	assert.equal(settings.tokenBudget, 64_000);
	assert.equal(settings.trimToTokens, 80_000);
	assert.equal(settings.trimToTokensExplicit, true);
});

test("lets a trusted valid project target override the global target", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { trimToTokens: 50_000 } },
		projectSettings: { contextPaging: { trimToTokens: 20_000 } }, projectTrusted: true,
	});
	assert.equal(settings.trimToTokens, 20_000);
	assert.equal(settings.trimToTokensExplicit, true);
});

test("ignores untrusted budget and target overrides", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: 64_000, trimToTokens: 30_000 } },
		projectSettings: { contextPaging: { tokenBudget: 128_000, trimToTokens: 90_000 } }, projectTrusted: false,
	});
	assert.equal(settings.tokenBudget, 64_000);
	assert.equal(settings.trimToTokens, 30_000);
	assert.equal(settings.trimToTokensExplicit, true);
});

test("falls through invalid project targets to a valid global target", () => {
	for (const invalid of invalidTargets) {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { trimToTokens: 30_000 } },
			projectSettings: { contextPaging: { tokenBudget: 64_000, trimToTokens: invalid } }, projectTrusted: true,
		});
		assert.equal(settings.tokenBudget, 64_000);
		assert.equal(settings.trimToTokens, 30_000, `invalid project target: ${String(invalid)}`);
		assert.equal(settings.trimToTokensExplicit, true);
	}
});

test("falls through invalid global targets to the resolved adaptive default", () => {
	for (const invalid of invalidTargets) {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { trimToTokens: invalid } },
			projectSettings: { contextPaging: { tokenBudget: 64_000 } }, projectTrusted: true,
		});
		assert.equal(settings.trimToTokens, 40_000, `invalid global target: ${String(invalid)}`);
		assert.equal(settings.trimToTokensExplicit, false);
	}
});

test("retains valid-value provenance for an explicit at-or-above-budget target", () => {
	for (const trimToTokens of [64_000, 80_000, Number.MAX_SAFE_INTEGER]) {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { tokenBudget: 64_000, trimToTokens } }, projectTrusted: false,
		});
		assert.equal(settings.trimToTokens, trimToTokens);
		assert.equal(settings.trimToTokensExplicit, true);
	}
});

test("derives exact adaptive targets for large resolved budgets", () => {
	for (const [tokenBudget, target] of [
		[1, 1], [Number.MAX_SAFE_INTEGER, 5_629_499_534_213_119],
		[Number.MAX_SAFE_INTEGER - 4, 5_629_499_534_213_116],
	]) {
		const settings = resolveContextPagingSettings({ globalSettings: { contextPaging: { tokenBudget } }, projectTrusted: false });
		assert.equal(settings.trimToTokens, target);
		assert.equal(settings.trimToTokensExplicit, false);
	}
});

test("computes the adaptive default exactly for accepted integer boundaries", () => {
	assert.equal(defaultTrimToTokens(1), 1);
	assert.equal(defaultTrimToTokens(Number.MAX_SAFE_INTEGER - 1), 5_629_499_534_213_118);
	assert.equal(defaultTrimToTokens(Number.MAX_SAFE_INTEGER - 4), 5_629_499_534_213_116);
});

test("merges trusted project model overrides over global ones by model key", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { modelOverrides: { "a/one": { enabled: false }, "b/two": { enabled: false } } } },
		projectSettings: { contextPaging: { modelOverrides: { "b/two": { enabled: true }, "c/three": { enabled: false } } } },
		projectTrusted: true,
	});
	assert.equal(settingsForModel(settings, "a/one").enabled, false);
	assert.equal(settingsForModel(settings, "b/two").enabled, true);
	assert.equal(settingsForModel(settings, "c/three").enabled, false);
	assert.equal(settingsForModel(settings, "d/four").enabled, true);
	assert.equal(settingsForModel(settings, undefined).enabled, true);
});

test("ignores untrusted project model overrides", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { modelOverrides: { "a/one": { enabled: false } } } },
		projectSettings: { contextPaging: { modelOverrides: { "a/one": { enabled: true } } } },
		projectTrusted: false,
	});
	assert.equal(settingsForModel(settings, "a/one").enabled, false);
});

test("falls through invalid model overrides to the next source", () => {
	for (const invalid of [true, "off", null, [], { enabled: "false" }, { enabled: 0 }, {}]) {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { enabled: false, modelOverrides: { "a/one": { enabled: true } } } },
			projectSettings: { contextPaging: { modelOverrides: { "a/one": invalid } } },
			projectTrusted: true,
		});
		assert.equal(settingsForModel(settings, "a/one").enabled, true, `invalid override: ${JSON.stringify(invalid)}`);
		assert.equal(settingsForModel(settings, "b/two").enabled, false);
	}
	for (const invalid of [true, "x", null, []]) {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { modelOverrides: invalid } }, projectTrusted: false,
		});
		assert.equal(settings.modelOverrides.size, 0);
	}
});

test("does not resolve model overrides from inherited object keys", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: true, modelOverrides: JSON.parse('{"__proto__": {"enabled": false}}') } },
		projectTrusted: false,
	});
	assert.equal(settingsForModel(settings, "constructor").enabled, true);
	assert.equal(settingsForModel(settings, "toString").enabled, true);
});

test("merges model override fields one by one across sources", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { modelOverrides: { "a/one": { enabled: false, tokenBudget: 64_000 } } } },
		projectSettings: { contextPaging: { modelOverrides: { "a/one": { tokenBudget: 32_000, trimToTokens: "x" } } } },
		projectTrusted: true,
	});
	assert.deepEqual(settingsForModel(settings, "a/one"), {
		enabled: false, tokenBudget: 32_000, trimToTokens: 20_000, trimToTokensExplicit: false, enabledByModelOverride: true,
	});
});

test("derives the model target from a model budget instead of the global explicit target", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: {
			contextPaging: {
				tokenBudget: 128_000,
				trimToTokens: 80_000,
				modelOverrides: { "a/one": { tokenBudget: 48_000 }, "b/two": { trimToTokens: 60_000 } },
			},
		},
		projectTrusted: false,
	});
	assert.deepEqual(settingsForModel(settings, "a/one"), {
		enabled: true, tokenBudget: 48_000, trimToTokens: 30_000, trimToTokensExplicit: false, enabledByModelOverride: false,
	});
	assert.deepEqual(settingsForModel(settings, "b/two"), {
		enabled: true, tokenBudget: 128_000, trimToTokens: 60_000, trimToTokensExplicit: true, enabledByModelOverride: false,
	});
	assert.deepEqual(settingsForModel(settings, "c/three"), {
		enabled: true, tokenBudget: 128_000, trimToTokens: 80_000, trimToTokensExplicit: true, enabledByModelOverride: false,
	});
});

test("ignores invalid model token values", () => {
	for (const invalid of invalidTargets) {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { tokenBudget: 96_000, modelOverrides: { "a/one": { tokenBudget: invalid, trimToTokens: invalid } } } },
			projectTrusted: false,
		});
		const { tokenBudget, trimToTokens } = settingsForModel(settings, "a/one");
		assert.deepEqual({ tokenBudget, trimToTokens }, { tokenBudget: 96_000, trimToTokens: 60_000 }, `invalid value: ${String(invalid)}`);
	}
});

test("resolves an auto budget as a fraction of the model window", () => {
	const resolve = (tokenBudget: unknown, contextWindow?: number, modelKey?: string) => {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { tokenBudget, modelOverrides: { "a/one": { tokenBudget: "auto:0.25" } } } },
			projectTrusted: false,
		});
		const { tokenBudget: budget, trimToTokens, trimToTokensExplicit } = settingsForModel(settings, modelKey, contextWindow);
		return { budget, trimToTokens, trimToTokensExplicit };
	};
	assert.deepEqual(resolve("auto", 200_000), { budget: 100_000, trimToTokens: 62_500, trimToTokensExplicit: false });
	assert.deepEqual(resolve("auto:0.4", 1_000_000), { budget: 400_000, trimToTokens: 250_000, trimToTokensExplicit: false });
	assert.deepEqual(resolve("auto:1", 32_768), { budget: 32_768, trimToTokens: 20_480, trimToTokensExplicit: false });
	assert.deepEqual(resolve("auto", undefined), { budget: 128_000, trimToTokens: 80_000, trimToTokensExplicit: false });
	assert.deepEqual(resolve("auto", Number.NaN), { budget: 128_000, trimToTokens: 80_000, trimToTokensExplicit: false });
	assert.deepEqual(resolve(96_000, 200_000, "a/one"), { budget: 50_000, trimToTokens: 31_250, trimToTokensExplicit: false });
	assert.deepEqual(resolve("auto", 200_000, "b/two"), { budget: 100_000, trimToTokens: 62_500, trimToTokensExplicit: false });
});

test("keeps the numeric resolved budget and adds the auto ratio", () => {
	const settings = resolveContextPagingSettings({ globalSettings: { contextPaging: { tokenBudget: "auto:0.4" } }, projectTrusted: false });
	assert.equal(settings.tokenBudget, 128_000);
	assert.equal(settings.trimToTokens, 80_000);
	assert.equal(settings.tokenBudgetAutoRatio, 0.4);
	assert.equal(resolveContextPagingSettings({ globalSettings: {}, projectTrusted: false }).tokenBudgetAutoRatio, undefined);
});

test("keeps an explicit target with an auto budget", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { tokenBudget: "auto", trimToTokens: 30_000 } }, projectTrusted: false,
	});
	const { tokenBudget, trimToTokens, trimToTokensExplicit } = settingsForModel(settings, undefined, 200_000);
	assert.deepEqual({ tokenBudget, trimToTokens, trimToTokensExplicit }, { tokenBudget: 100_000, trimToTokens: 30_000, trimToTokensExplicit: true });
});

test("falls through invalid auto budgets to the next source", () => {
	for (const invalid of ["Auto", "auto:", "auto: ", "auto:0", "auto:-0.5", "auto:1.5", "auto:x", "auto:NaN", "auto:Infinity", "0.5", ""]) {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { tokenBudget: "auto:0.25", modelOverrides: { "a/one": { tokenBudget: invalid } } } },
			projectSettings: { contextPaging: { tokenBudget: invalid } },
			projectTrusted: true,
		});
		assert.equal(settingsForModel(settings, "a/one", 200_000).tokenBudget, 50_000, `invalid budget: ${JSON.stringify(invalid)}`);
	}
});
