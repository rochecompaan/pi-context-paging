import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactWriter } from "../eval/recall/artifacts.ts";
import { buildManifest } from "../eval/recall/manifest.ts";
import { runPair, type PairResult } from "../eval/recall/pair.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { defaultLimits } from "../eval/recall/request-guard.ts";
import { makeScriptedArm } from "./fixtures/eval-recall.ts";
import { sanitizeArtifact } from "../eval/recall/safe-artifacts.ts";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "recall-artifact-")); t.after(() => rm(root, { recursive: true, force: true }));
	const workload = buildWorkload("artifact-fixture");
	const pair = await runPair({ seed: workload.seed, stage: "A", firstArm: "baseline", workload,
		createArm: async options => makeScriptedArm({ ...options, workload, beforeAttempt: options.requestGuard, order: [] }).instance });
	const manifest = buildManifest({ runId: "fixture", mode: "pilot", sourceRevision: "a".repeat(40), sourceIntegrity: "clean-checkout-v1",
		sdkVersion: "0.87.1", nodeVersion: process.version, modelMetadata: pair.snapshots.baseline!.modelMetadata,
		limits: defaultLimits, seeds: [pair.seed], stages: [pair.stage], firstArms: [pair.firstArm] });
	return { directory: join(root, "run"), pair, manifest };
}
async function files(directory: string): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...await files(path)); else result.push(path);
	}
	return result;
}

test("private artifacts retain prompts, transcripts, traces, events, probes and final summaries", async t => {
	const f = await fixture(t), writer = await createArtifactWriter(f.directory, f.manifest);
	writer.appendEvent(f.pair.seed, "baseline", { type: "payload", eventIndex: 1, promptId: f.pair.steps[0].id, requestId: "baseline-request-1" });
	await writer.appendProgress({ type: "prompt-idle", seed: f.pair.seed, stage: f.pair.stage, step: f.pair.steps[0], arm: "baseline", snapshots: f.pair.snapshots,
		promptCounts: f.pair.promptCounts, sentAttempts: f.pair.sentAttempts });
	await writer.finish(f.pair);
	assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
	const paths = await files(f.directory);
	for (const path of paths) assert.equal((await stat(path)).mode & 0o777, 0o600, path);
	for (const name of ["manifest.json", "prompts.json", "transcript.json", "request-traces.json", "events.jsonl", "probes.json", "results.json", "report.md", "progress.json"]) assert.ok(paths.some(path => path.endsWith(`/${name}`)), name);
	const prompts = JSON.parse(await readFile(paths.find(path => path.endsWith("/prompts.json"))!, "utf8"));
	assert.equal(prompts.steps.length, f.pair.steps.length);
	assert.match(prompts.hash, /^[a-f0-9]{64}$/);
	const results = JSON.parse(await readFile(join(f.directory, "results.json"), "utf8"));
	assert.equal(results.pairs[0].status, "complete");
	assert.equal((await readFile(join(f.directory, "report.md"), "utf8")).includes("artifact-fixture"), true);
	await assert.rejects(createArtifactWriter(f.directory, f.manifest));
});

test("exports omit credentials, raw errors and encrypted signatures while keeping host failure scope", async t => {
	const f = await fixture(t);
	const secret = "PRIVATE_EXPORT_SENTINEL";
	Object.assign(f.pair.snapshots.baseline!, { authorization: secret, environment: { TOKEN: secret }, credentialResolution: { token: secret } });
	Object.assign(f.pair.snapshots.baseline!.modelMetadata, { headers: { authorization: secret } });
	Object.assign(f.pair, { rawError: new Error(secret), error: secret, encryptedContent: secret, thinkingSignature: secret });
	f.pair.errors.push({ code: "assistant-error", arm: "baseline", promptId: "probe-A-id" });
	f.pair.status = "incomplete";
	const writer = await createArtifactWriter(f.directory, f.manifest); await writer.finish(f.pair);
	for (const path of await files(f.directory)) assert.ok(!(await readFile(path, "utf8")).includes(secret), path);
	const result = JSON.parse(await readFile(join(f.directory, "results.json"), "utf8")).pairs[0] as PairResult;
	assert.equal(result.errors[0].code, "assistant-error");
	assert.equal(result.errors[0].arm, "baseline");
	assert.equal(result.errors[0].promptId, "probe-A-id");
});

test("a failed final write retains earlier private progress and rejects further writes", async t => {
	const f = await fixture(t), writer = await createArtifactWriter(f.directory, f.manifest);
	await writer.appendProgress({ type: "prompt-idle", seed: f.pair.seed, stage: f.pair.stage, step: f.pair.steps[0], arm: "baseline", snapshots: f.pair.snapshots,
		promptCounts: f.pair.promptCounts, sentAttempts: f.pair.sentAttempts });
	await rm(join(f.directory, "results.json"));
	await mkdir(join(f.directory, "results.json"));
	await assert.rejects(writer.finish(f.pair));
	const paths = await files(f.directory);
	assert.ok(paths.some(path => path.endsWith("/progress.json")));
	await assert.rejects(writer.flush());
});

test("untrusted uppercase error codes cannot leak private values", () => {
	const result = sanitizeArtifact({ error: { name: "Error", code: "PRIVATE_ERROR_CODE_SECRET" },
		failures: [Object.assign(new Error("private message"), { code: "SOURCE_REVISION_CHANGED" }),
			Object.assign(new Error("private message"), { code: "EACCES" })] });
	assert.ok(!JSON.stringify(result).includes("PRIVATE_ERROR_CODE_SECRET"));
	assert.ok(JSON.stringify(result).includes("SOURCE_REVISION_CHANGED"));
	assert.ok(JSON.stringify(result).includes("EACCES"));
});

test("raw string errors are redacted while owned parser diagnostics remain readable", () => {
	const result = sanitizeArtifact({ error: "PRIVATE_STRING_ERROR_SENTINEL", parser: { error: "unsupported-input-item,invalid-tools" }, usage: { error: "invalid-input_tokens" } }) as Record<string, unknown>;
	assert.ok(!JSON.stringify(result).includes("PRIVATE_STRING_ERROR_SENTINEL"));
	assert.equal((result.parser as { error: string }).error, "unsupported-input-item,invalid-tools");
	assert.equal((result.usage as { error: string }).error, "invalid-input_tokens");
});
