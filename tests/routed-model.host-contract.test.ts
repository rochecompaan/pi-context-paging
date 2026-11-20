import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { VIRTUAL_MODEL_API } from "../src/routed-model.ts";

/**
 * Pi owns the `api` tag that marks a virtual selection, and this package cannot import it: peers are `*`, so a
 * build that imports a virtual-models module would crash every session on a host that has none. The contract is
 * checked against the host build that is actually installed here instead.
 */
function installedHost(): { version: string; source: string | undefined } {
	// The host's `exports` map blocks require.resolve, and the layout is a plain dev dependency, so locate the
	// package by walking up from this test file.
	let dir = import.meta.dirname;
	let root: string | undefined;
	while (dir !== dirname(dir)) {
		const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
		if (existsSync(join(candidate, "package.json"))) { root = candidate; break; }
		dir = dirname(dir);
	}
	if (root === undefined) return { version: "not installed", source: undefined };
	const version = String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
	const source = join(root, "dist", "core", "virtual-models.js");
	return { version, source: existsSync(source) ? source : undefined };
}

test("the extension's virtual-model tag matches the installed host's", (t) => {
	const { version, source } = installedHost();
	if (source === undefined) {
		// A host with no virtual models never reaches the comparisons, so there is nothing to agree with.
		// The skip is the signal: on this Pi the routed-window check cannot run, and no test here can tell
		// whether the tag still matches. Bump the dev host to a Pi with virtual models to bind it.
		t.skip(`installed Pi ${version} has no virtual-model routing (no dist/core/virtual-models.js)`);
		return;
	}
	const tag = readFileSync(source, "utf8").match(/VIRTUAL_MODEL_API\s*=\s*"([^"]*)"/)?.[1];
	assert.ok(
		tag !== undefined,
		`installed Pi ${version} has virtual-models.js without a VIRTUAL_MODEL_API literal; read it and update this contract`,
	);
	assert.equal(
		VIRTUAL_MODEL_API,
		tag,
		`Pi ${version} tags a virtual selection as "${tag}" and the extension compares "${VIRTUAL_MODEL_API}", so `
		+ "paging would read a virtual selection as a physical model with a 0 window and abort every provider call",
	);
});

test("the virtual-model tag is defined once in the product", () => {
	// A second copy is how the two sides drift apart silently: the host rename scenario above.
	const src = join(import.meta.dirname, "..", "src");
	const naming = readdirSync(src)
		.filter((name) => name.endsWith(".ts"))
		.filter((name) => readFileSync(join(src, name), "utf8").includes(`"${VIRTUAL_MODEL_API}"`));
	assert.deepEqual(naming, ["routed-model.ts"], "only routed-model.ts may name the tag, and only in its const");
	const occurrences = readFileSync(join(src, "routed-model.ts"), "utf8").match(/"pi-virtual"/g) ?? [];
	assert.equal(occurrences.length, 1, "the tag is named exactly once, where it is defined");
});
