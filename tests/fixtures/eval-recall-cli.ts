import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { EvalCliDependencies, LiveEval } from "../../eval/recall/cli.ts";
import { createArtifactWriter } from "../../eval/recall/artifacts.ts";
import { assertCleanSource } from "../../eval/recall/source-integrity.ts";
import { runStageGroup } from "../../eval/recall/stage-group.ts";
import { buildWorkload } from "../../eval/recall/workload.ts";
import { makeScriptedArm } from "./eval-recall.ts";
import { stageFixture } from "./eval-recall-stage-group.ts";

/** Real git/source checks and private writer; callers can replace the session boundary. */
export async function cliFixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "recall-cli-")); t.after(() => rm(root, { recursive: true, force: true }));
	const put = async (path: string, value: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); };
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
	await put(".gitignore", ".pi/evals/\n");
	for (const path of ["src/index.ts", "eval/recall/codex-runtime.ts", "eval/recall/source-integrity.ts", "scripts/recall-eval.ts"]) await put(path, "export const fixture = true;\n");
	git("add", "."); git("commit", "--quiet", "-m", "fixture");
	const arms: ReturnType<typeof stageFixture>["sessions"] = [], order: string[] = [], outputs: string[] = [], directories: string[] = [];
	let loads = 0, cleanup = 0;
	const metadata = makeScriptedArm({ arm: "baseline", workload: buildWorkload("metadata"), beforeAttempt() {}, order: [] }).instance.snapshot().modelMetadata;
	const live: LiveEval = { modelMetadata: metadata, sdkVersion: "0.87.1", runStageGroup,
		async createArm(options) {
			const f = stageFixture(buildWorkload(options.owner.seed), { async onPrompt(_options, step) { order.push(`${options.arm}:${step.id}`); } });
			const arm = await f.createArm(options); arms.push(...f.sessions); return arm;
		}, async cleanupSession() {}, async cleanup() { cleanup++; } };
	const dependencies: EvalCliDependencies = { repoRoot: root, inspectSource: assertCleanSource,
		async loadLive() { loads++; return live; },
		async createArtifacts(path, manifest, clock) { directories.push(path); return createArtifactWriter(path, manifest, clock); },
		log(line) { outputs.push(line); } };
	return { root, put, git, arms, order, directories, live, dependencies, outputs, get loads() { return loads; }, get cleanup() { return cleanup; } };
}
