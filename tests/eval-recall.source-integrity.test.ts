import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertCleanSource } from "../eval/recall/source-integrity.ts";

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "recall-source-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const put = (path: string, value = "export const fixture = true;\n") => {
		mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value);
	};
	git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
	put(".gitignore", ".pi/evals/\neval/recall/ignored.ts\n");
	for (const path of ["src/index.ts", "eval/recall/codex-runtime.ts", "eval/recall/source-integrity.ts", "scripts/recall-eval.ts"]) put(path);
	git("add", "."); git("commit", "--quiet", "-m", "fixture");
	return { root, git, put, revision: git("rev-parse", "HEAD") };
}

test("a real clean checkout records full HEAD and ignores private run artifacts", t => {
	const f = fixture(t);
	f.put(".pi/evals/run/manifest.json", "{}");
	assert.deepEqual(assertCleanSource(f.root), { sourceRevision: f.revision, sourceIntegrity: "clean-checkout-v1" });
});

for (const [path, staged] of [["src/index.ts", false], ["eval/recall/codex-runtime.ts", true], ["eval/recall/untracked.ts", false]] as const) {
	test(`source inspection rejects ${staged ? "staged" : "unstaged/untracked"} ${path} even with unchanged HEAD`, t => {
		const f = fixture(t); f.put(path, "export const changed = true;\n");
		if (staged) f.git("add", path);
		assert.equal(f.git("rev-parse", "HEAD"), f.revision);
		assert.throws(() => assertCleanSource(f.root, f.revision));
	});
}

test("ignored live modules still need tracked Git evidence", t => {
	const f = fixture(t); f.put("eval/recall/ignored.ts");
	assert.equal(f.git("status", "--porcelain"), "");
	assert.throws(() => assertCleanSource(f.root));
});

test("index flags cannot conceal dirty live code behind a clean Git status", t => {
	const f = fixture(t);
	f.git("update-index", "--assume-unchanged", "src/index.ts");
	f.put("src/index.ts", "export const hidden = true;\n");
	assert.equal(f.git("status", "--porcelain"), "");
	assert.throws(() => assertCleanSource(f.root));
});

test("a clean changed revision cannot reuse an earlier pilot", t => {
	const f = fixture(t); f.put("src/index.ts", "export const next = true;\n");
	f.git("add", "."); f.git("commit", "--quiet", "-m", "next");
	assert.throws(() => assertCleanSource(f.root, f.revision));
	assert.notEqual(assertCleanSource(f.root).sourceRevision, f.revision);
});

test("tracked symlinks cannot hide mutable live code outside the checkout", t => {
	const f = fixture(t); f.put("outside-code", "export const mutable = true;\n");
	symlinkSync("../outside-code", join(f.root, "src", "linked.ts"));
	f.git("add", "."); f.git("commit", "--quiet", "-m", "linked source");
	assert.throws(() => assertCleanSource(f.root));
});

test("missing Git evidence or the wrong source root is not verified", t => {
	const f = fixture(t);
	assert.throws(() => assertCleanSource(join(f.root, "src")));
	const empty = mkdtempSync(join(tmpdir(), "recall-no-git-")); t.after(() => rmSync(empty, { recursive: true, force: true }));
	assert.throws(() => assertCleanSource(empty));
});
