import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactWriter } from "../eval/recall/artifacts.ts";
import { startOperation } from "../eval/recall/metrics.ts";
import { realClock } from "../eval/recall/pi-arm.ts";
import { sanitizeArtifact } from "../eval/recall/safe-artifacts.ts";
import { completeGroups, groupManifest } from "./fixtures/eval-recall-groups.ts";

async function files(path: string): Promise<string[]> {
	return (await Promise.all((await readdir(path, { withFileTypes: true })).map(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]))).flat();
}
test("isolated artifacts separate preparation and each fork while retaining private permissions and owned evidence", async t => {
	const root = await mkdtemp(join(tmpdir(), "isolated-artifacts-")); t.after(() => rm(root, { recursive: true, force: true }));
	const groups = await completeGroups(), directory = join(root, "run"), writer = await createArtifactWriter(directory, groupManifest(groups));
	const runTiming = startOperation(realClock);
	for (const group of groups) await writer.finish(group);
	await writer.complete({ runTiming, cleanupComplete: true });
	const paths = await files(directory);
	assert.equal(paths.filter(p => /\/preparation\/(baseline|paging)\/snapshot.json$/.test(p)).length, 4);
	assert.equal(paths.filter(p => /\/probes\/[^/]+\/(baseline|paging)\/snapshot.json$/.test(p)).length, 24);
	for (const path of paths) assert.equal((await stat(path)).mode & 0o777, 0o600);
	const result = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
	assert.equal(result.stageGroups.length, 2); assert.equal(result.stageGroups[0].forks.length, 12); assert.equal(result.pairs, undefined);
	const completion = JSON.parse(await readFile(join(directory, "completion.json"), "utf8"));
	assert.equal(completion.schemaVersion, 3); assert.equal(completion.cleanupComplete, true); assert.equal(completion.offlineGateEvidence.passed, true);
	assert.ok(completion.runWallMs.value >= 0);
});

test("private checkpoint objects and arbitrary diagnostic text are never exported", () => {
	const secret = "PRIVATE_ARTIFACT_SENTINEL";
	const value = sanitizeArtifact({ owner: { sessionId: "source", checkpointId: "safe-id", forkId: "fork" },
		privateCheckpoint: { id: secret }, tape: { observations: secret }, checkpointDigest: secret, rawProviderBody: secret,
		usage: { reason: secret }, restoration: { failureCode: secret }, gate: { failureCode: "probe-known-visible" },
		measured: { reason: "non-monotonic-clock", status: "invalid", value: null } });
	assert.ok(!JSON.stringify(value).includes(secret));
	assert.ok(JSON.stringify(value).includes("safe-id")); assert.ok(JSON.stringify(value).includes("non-monotonic-clock"));
});

test("successful results without final resource cleanup cannot publish a completion marker", async t => {
	const root = await mkdtemp(join(tmpdir(), "isolated-cleanup-")); t.after(() => rm(root, { recursive: true, force: true }));
	const groups = await completeGroups(), directory = join(root, "run"), writer = await createArtifactWriter(directory, groupManifest(groups));
	for (const group of groups) await writer.finish(group);
	await assert.rejects(writer.complete({ runTiming: startOperation(realClock), cleanupComplete: false }));
	assert.ok(!(await readdir(directory)).includes("completion.json"));
	assert.equal(JSON.parse(await readFile(join(directory, "results.json"), "utf8")).stageGroups.length, 2);
});
