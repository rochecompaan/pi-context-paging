import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseEvalArgs, runEval, type EvalCliDependencies, type LiveEval } from "../eval/recall/cli.ts";
import { createArtifactWriter } from "../eval/recall/artifacts.ts";
import { assertCleanSource } from "../eval/recall/source-integrity.ts";
import { makeScriptedArm } from "./fixtures/eval-recall.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { runPair } from "../eval/recall/pair.ts";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "recall-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
	const put = async (path: string, value: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); };
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
	await put(".gitignore", ".pi/evals/\n");
	for (const path of ["src/index.ts", "eval/recall/codex-runtime.ts", "eval/recall/source-integrity.ts", "scripts/recall-eval.ts"]) await put(path, "export const fixture = true;\n");
	git("add", "."); git("commit", "--quiet", "-m", "fixture");
	const arms: ReturnType<typeof makeScriptedArm>[] = [], order: string[] = [], outputs: string[] = [], directories: string[] = [];
	let loads = 0, cleanup = 0;
	const metadata = makeScriptedArm({ arm: "baseline", workload: buildWorkload("metadata"), beforeAttempt() {}, order: [] }).instance.snapshot().modelMetadata;
	const live: LiveEval = { modelMetadata: metadata, sdkVersion: "0.87.1", runPair,
		async createArm(options) {
			const arm = makeScriptedArm({ ...options, workload: buildWorkload(options.seed), beforeAttempt: options.requestGuard, order }); arms.push(arm); return arm.instance;
		}, async cleanup() { cleanup++; } };
	const dependencies: EvalCliDependencies = { repoRoot: root, inspectSource: assertCleanSource,
		async loadLive() { loads++; return live; },
		async createArtifacts(path, manifest) { directories.push(path); return createArtifactWriter(path, manifest); },
		log(line) { outputs.push(line); } };
	return { root, put, git, arms, order, directories, live, dependencies, outputs, get loads() { return loads; }, get cleanup() { return cleanup; } };
}

test("argument parsing defaults to a provider-free dry run and rejects overrides or malformed limits", () => {
	assert.equal(parseEvalArgs([]).mode, "dry-run");
	assert.equal(parseEvalArgs(["--batch", "--pilot-manifest", "pilot.json"]).pairs, 3);
	assert.equal(parseEvalArgs(["--pilot", "--max-user-prompts", "32"]).limits.maxUserPrompts, 32);
	for (const args of [["--pilot", "--dry-run"], ["--batch"], ["--pairs", "2"], ["--pilot", "--pilot-manifest", "p"],
		["--max-requests-per-arm", "0"], ["--max-pair-minutes", "1.5"], ["--max-user-prompts", "4junk"],
		["--model", "other"], ["--token-budget", "1000"], ["--unknown"], ["--seed"], ["--seed", ""], ["--max-pair-minutes", "9999999999"]]) assert.throws(() => parseEvalArgs(args), args.join(" "));
});

test("default and explicit dry runs never inspect credentials, load live modules, create arms or artifacts", async t => {
	const f = await fixture(t);
	f.dependencies.inspectSource = () => { throw new Error("dry run inspected source"); };
	for (const args of [[], ["--dry-run"]]) assert.equal(await runEval(parseEvalArgs(args), f.dependencies), 0);
	assert.equal(f.loads, 0); assert.equal(f.arms.length, 0); assert.equal(f.directories.length, 0);
	assert.ok(f.outputs.some(line => line.includes("Dry run")));
});

test("a complete pilot authorizes three distinct alternating pairs without requiring perfect answers", async t => {
	const f = await fixture(t);
	const create = f.live.createArm;
	f.live.createArm = async options => {
		const arm = await create(options), prompt = arm.runPrompt;
		arm.runPrompt = async step => { await prompt(step); const snapshot = arm.snapshot(); snapshot.finalAnswerText = '{"answer":"wrong"}'; return snapshot; };
		return arm;
	};
	assert.equal(await runEval(parseEvalArgs(["--pilot", "--seed", "pilot"]), f.dependencies), 0);
	const pilot = join(f.directories[0], "manifest.json");
	assert.equal(await runEval(parseEvalArgs(["--batch", "--pilot-manifest", pilot]), f.dependencies), 0);
	const manifest = JSON.parse(await readFile(join(f.directories[1], "manifest.json"), "utf8"));
	assert.equal(new Set(manifest.seeds).size, 3); assert.deepEqual(manifest.firstArms, ["baseline", "paging", "baseline"]);
	const { pairs } = JSON.parse(await readFile(join(f.directories[1], "results.json"), "utf8"));
	assert.equal(pairs.length, 3); assert.ok(pairs.every((pair: { status: string }) => pair.status === "complete"));
	assert.ok(f.arms.every(arm => arm.disposed && arm.aborted)); assert.equal(f.cleanup, 2);
});

test("dirty source at unchanged HEAD blocks batch before live imports or arm creation", async t => {
	const f = await fixture(t);
	assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 0);
	const revision = f.git("rev-parse", "HEAD");
	await f.put("eval/recall/codex-runtime.ts", "export const changed = true;\n");
	assert.equal(f.git("rev-parse", "HEAD"), revision);
	assert.equal(await runEval(parseEvalArgs(["--batch", "--pilot-manifest", join(f.directories[0], "manifest.json")]), f.dependencies), 2);
	assert.equal(f.loads, 1); assert.equal(f.arms.length, 2);
	const manifest = JSON.parse(await readFile(join(f.directories[1], "manifest.json"), "utf8"));
	assert.equal(manifest.sourceIntegrity, null);
});

for (const mutation of ["window", "settings", "missing-policy", "incomplete"] as const) {
	test(`an invalid pilot (${mutation}) cannot start a batch request`, async t => {
		const f = await fixture(t); assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 0);
		const path = join(f.directories[0], "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
		if (mutation === "window") manifest.modelMetadata.contextWindow++;
		if (mutation === "settings") manifest.thinking = "high";
		if (mutation === "missing-policy") delete manifest.sourceIntegrity;
		if (mutation === "incomplete") {
			const result = JSON.parse(await readFile(join(f.directories[0], "results.json"), "utf8")); result.pairs[0].status = "incomplete";
			await writeFile(join(f.directories[0], "results.json"), JSON.stringify(result));
		}
		await writeFile(path, JSON.stringify(manifest));
		assert.equal(await runEval(parseEvalArgs(["--batch", "--pilot-manifest", path]), f.dependencies), 2);
		assert.equal(f.loads, 1); assert.equal(f.arms.length, 2);
	});
}

test("a changed resolved native model is rejected before batch sessions", async t => {
	const f = await fixture(t); assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 0);
	f.live.modelMetadata = { ...f.live.modelMetadata, contextWindow: 300000 };
	assert.equal(await runEval(parseEvalArgs(["--batch", "--pilot-manifest", join(f.directories[0], "manifest.json")]), f.dependencies), 2);
	assert.equal(f.arms.length, 2);
});

test("source mutation during a prompt blocks the next dispatch, clears policy and closes both arms", async t => {
	const f = await fixture(t), create = f.live.createArm;
	f.live.createArm = async options => {
		const arm = await create(options), prompt = arm.runPrompt;
		arm.runPrompt = async step => { const snapshot = await prompt(step); await f.put("src/index.ts", "export const changed = true;\n"); return snapshot; };
		return arm;
	};
	assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 2);
	const manifest = JSON.parse(await readFile(join(f.directories[0], "manifest.json"), "utf8"));
	const { pairs } = JSON.parse(await readFile(join(f.directories[0], "results.json"), "utf8"));
	assert.equal(manifest.sourceIntegrity, null); assert.equal(pairs[0].sentAttempts.baseline + pairs[0].sentAttempts.paging, 1);
	assert.ok(f.arms.every(arm => arm.disposed && arm.aborted));
});

test("artifact errors stop further model work and retain earlier progress", async t => {
	const f = await fixture(t), create = f.dependencies.createArtifacts!;
	f.dependencies.createArtifacts = async (path, manifest) => {
		const writer = await create(path, manifest), append = writer.appendProgress; let writes = 0;
		writer.appendProgress = async progress => { await append(progress); if (++writes === 2) throw new Error("PRIVATE_ARTIFACT_FAILURE"); };
		return writer;
	};
	assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 2);
	assert.equal(f.order.length, 2); assert.ok(f.arms.every(arm => arm.disposed && arm.aborted));
	assert.ok((await readdir(join(f.directories[0], "pairs"))).length);
	assert.ok(!f.outputs.join(" ").includes("PRIVATE_ARTIFACT_FAILURE"));
});

test("source failure remains latched even if the checkout is repaired before a retry", async t => {
	const f = await fixture(t), create = f.live.createArm;
	let acceptedAfterFailure = false;
	f.live.createArm = async options => {
		const arm = await create(options);
		arm.runPrompt = async step => {
			const meta = { requestId: "source-retry", promptId: step.id, arm: options.arm, purpose: "conversation" as const };
			await f.put("src/index.ts", "export const fixture = false;\n");
			await assert.rejects(() => options.requestGuard(meta));
			await f.put("src/index.ts", "export const fixture = true;\n");
			try { await options.requestGuard(meta); acceptedAfterFailure = true; } catch { /* A retry stays blocked. */ }
			throw new Error("fixture stopped after retry check");
		};
		return arm;
	};
	assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 2);
	assert.equal(acceptedAfterFailure, false);
});

test("unignored output cannot dirty the source checkout or start live work", async t => {
	const f = await fixture(t);
	assert.equal(await runEval(parseEvalArgs(["--pilot", "--output-dir", "results"]), f.dependencies), 2);
	assert.equal(f.loads, 0); assert.equal(f.git("status", "--porcelain"), "");
});

test("metadata drift during arm startup stops before the first prompt", async t => {
	const f = await fixture(t);
	f.live.modelMetadata = { ...f.live.modelMetadata, contextWindow: 300000 };
	assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 2);
	assert.equal(f.order.length, 0); assert.ok(f.arms.every(arm => arm.disposed));
});

test("a source change during final artifact writing revokes the completed pilot", async t => {
	const f = await fixture(t), create = f.dependencies.createArtifacts!;
	f.dependencies.createArtifacts = async (path, manifest) => {
		const writer = await create(path, manifest), finish = writer.finish;
		writer.finish = async result => { await finish(result); await f.put("src/index.ts", "export const changed = true;\n"); };
		return writer;
	};
	assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 2);
	const manifest = JSON.parse(await readFile(join(f.directories[0], "manifest.json"), "utf8"));
	const { pairs } = JSON.parse(await readFile(join(f.directories[0], "results.json"), "utf8"));
	assert.equal(manifest.sourceIntegrity, null); assert.equal(pairs[0].status, "incomplete");
});

test("a final write failure cannot authorize a batch from stale complete results", async t => {
	const f = await fixture(t), create = f.dependencies.createArtifacts!;
	f.dependencies.createArtifacts = async (path, manifest) => {
		const writer = await create(path, manifest), finish = writer.finish;
		writer.finish = async result => { await finish(result); await chmod(path, 0o500); throw new Error("final write failed"); };
		return writer;
	};
	assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 2);
	await chmod(f.directories[0], 0o700); f.dependencies.createArtifacts = create;
	const { pairs } = JSON.parse(await readFile(join(f.directories[0], "results.json"), "utf8"));
	assert.equal(pairs[0].status, "complete"); // The failed rewrite left an old summary.
	assert.equal(await runEval(parseEvalArgs(["--batch", "--pilot-manifest", join(f.directories[0], "manifest.json")]), f.dependencies), 2);
	assert.equal(f.loads, 1); assert.equal(f.arms.length, 2);
});

test("provider errors keep incomplete evidence, return exit 2 and close arms", async t => {
	const f = await fixture(t), create = f.live.createArm;
	f.live.createArm = async options => {
		const arm = await create(options), prompt = arm.runPrompt;
		arm.runPrompt = async step => { const snapshot = await prompt(step); snapshot.errors = [{ code: "assistant-error", promptId: step.id }]; return snapshot; };
		return arm;
	};
	assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 2);
	const { pairs } = JSON.parse(await readFile(join(f.directories[0], "results.json"), "utf8"));
	assert.equal(pairs[0].status, "incomplete"); assert.equal(pairs[0].errors[0].code, "assistant-error");
	assert.ok(f.arms.every(arm => arm.disposed && arm.aborted));
});

test("safety exhaustion returns exit 3 while keeping partial results", async t => {
	const f = await fixture(t);
	assert.equal(await runEval(parseEvalArgs(["--pilot", "--max-user-prompts", "23"]), f.dependencies), 3);
	const { pairs } = JSON.parse(await readFile(join(f.directories[0], "results.json"), "utf8"));
	assert.equal(pairs[0].stopReason, "max-user-prompts"); assert.ok(f.arms.every(arm => arm.disposed && arm.aborted));
});
