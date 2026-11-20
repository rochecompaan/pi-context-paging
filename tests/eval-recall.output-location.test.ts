import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertOutputLocation } from "../eval/recall/output-location.ts";

/**
 * The recall harness writes private preparation and probe evidence, so the output guard is the
 * only thing keeping that out of a tracked checkout, out of `.git`, and out of a symlinked target.
 * Each case runs against a disposable git checkout, never this repository.
 */
function checkout(t: test.TestContext) {
	const parent = mkdtempSync(join(tmpdir(), "recall-output-"));
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	const root = join(parent, "checkout");
	mkdirSync(root);
	execFileSync("git", ["init", "--quiet", root], { stdio: ["ignore", "pipe", "pipe"] });
	writeFileSync(join(root, ".gitignore"), ".pi/evals/\n");
	return { parent, root, actual: realpathSync(parent) };
}

const coded = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test("the ignored default output directory resolves inside the checkout", t => {
	const { root, actual } = checkout(t);
	assert.equal(assertOutputLocation(root, ".pi/evals/full-budget-recall"), join(actual, "checkout", ".pi/evals", "full-budget-recall"));
});

test("an output directory that git tracks is refused, so private evidence cannot be committed", t => {
	const { root } = checkout(t);
	assert.throws(() => assertOutputLocation(root, "docs/artifacts"), coded("UNIGNORED_ARTIFACT_OUTPUT"));
	assert.throws(() => assertOutputLocation(root, "eval/recall/run"), coded("UNIGNORED_ARTIFACT_OUTPUT"));
});

test("the checkout root and .git are never valid output locations", t => {
	const { root } = checkout(t);
	assert.throws(() => assertOutputLocation(root, "."), /Unsafe artifact location/);
	assert.throws(() => assertOutputLocation(root, ".git/evals"), /Unsafe artifact location/);
	assert.throws(() => assertOutputLocation(root, ".git"), /Unsafe artifact location/);
});

test("a path outside the checkout is accepted, including one reached with a parent hop", t => {
	const { root, parent, actual } = checkout(t);
	assert.equal(assertOutputLocation(root, join(parent, "outside")), join(actual, "outside"));
	assert.equal(assertOutputLocation(root, "../outside"), join(actual, "outside"));
});

test("a symlink is resolved before deciding whether the output is inside the checkout", t => {
	const { root, parent, actual } = checkout(t);
	// A directory outside the checkout, reached through a link that points into it, is still
	// tracked output, so it must be refused rather than treated as an external path.
	symlinkSync(join(root, "docs"), join(parent, "into-docs"));
	assert.throws(() => assertOutputLocation(root, join(parent, "into-docs", "run")), coded("UNIGNORED_ARTIFACT_OUTPUT"));
	symlinkSync(join(root, ".pi/evals"), join(parent, "into-ignored"));
	assert.equal(assertOutputLocation(root, join(parent, "into-ignored", "run")), join(actual, "checkout", ".pi", "evals", "run"));
	// A link that leaves the checkout is output outside it, which the guard allows.
	mkdirSync(join(parent, "target"));
	symlinkSync(join(parent, "target"), join(root, "escape"));
	assert.equal(assertOutputLocation(root, "escape/run"), join(actual, "target", "run"));
});
