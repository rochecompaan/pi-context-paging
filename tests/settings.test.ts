import assert from "node:assert/strict";
import test from "node:test";
import { defaultTrimToTokens, enabledForModel, resolveContextPagingSettings } from "../src/settings.ts";

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
	assert.equal(enabledForModel(settings, "a/one"), false);
	assert.equal(enabledForModel(settings, "b/two"), true);
	assert.equal(enabledForModel(settings, "c/three"), false);
	assert.equal(enabledForModel(settings, "d/four"), true);
	assert.equal(enabledForModel(settings, undefined), true);
});

test("ignores untrusted project model overrides", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { modelOverrides: { "a/one": { enabled: false } } } },
		projectSettings: { contextPaging: { modelOverrides: { "a/one": { enabled: true } } } },
		projectTrusted: false,
	});
	assert.equal(enabledForModel(settings, "a/one"), false);
});

test("falls through invalid model overrides to the next source", () => {
	for (const invalid of [true, "off", null, [], { enabled: "false" }, { enabled: 0 }, {}]) {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { enabled: false, modelOverrides: { "a/one": { enabled: true } } } },
			projectSettings: { contextPaging: { modelOverrides: { "a/one": invalid } } },
			projectTrusted: true,
		});
		assert.equal(enabledForModel(settings, "a/one"), true, `invalid override: ${JSON.stringify(invalid)}`);
		assert.equal(enabledForModel(settings, "b/two"), false);
	}
	for (const invalid of [true, "x", null, []]) {
		const settings = resolveContextPagingSettings({
			globalSettings: { contextPaging: { modelOverrides: invalid } }, projectTrusted: false,
		});
		assert.equal(settings.modelEnabled.size, 0);
	}
});

test("does not resolve model overrides from inherited object keys", () => {
	const settings = resolveContextPagingSettings({
		globalSettings: { contextPaging: { enabled: true, modelOverrides: JSON.parse('{"__proto__": {"enabled": false}}') } },
		projectTrusted: false,
	});
	assert.equal(enabledForModel(settings, "constructor"), true);
	assert.equal(enabledForModel(settings, "toString"), true);
});
