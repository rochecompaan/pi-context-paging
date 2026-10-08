import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { prepareCodexRuntime } from "./codex-runtime.ts";
import { createPiArm } from "./pi-arm.ts";
import { runStageGroup } from "./stage-group.ts";
import type { LiveEval } from "./cli.ts";

/** Imported only after the entry-point checkout has passed source verification. */
export async function loadLiveEval(): Promise<LiveEval> {
	const versions: string[] = [];
	for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent"]) {
		const entry = fileURLToPath(import.meta.resolve(`@earendil-works/${name}`));
		const metadata = JSON.parse(await readFile(join(dirname(entry), "..", "package.json"), "utf8")) as { version: string };
		if (metadata.version !== "0.87.1") throw Object.assign(new Error("Unsupported eval SDK version"), { code: "UNSUPPORTED_EVAL_SDK" });
		versions.push(metadata.version);
	}
	const agentDir = getAgentDir();
	const noInference = (): never => { throw new Error("Preflight cannot dispatch inference"); };
	const prepared = await prepareCodexRuntime(agentDir, {
		allocateMeta: noInference, onPayload: async () => noInference(), beforeHttpAttempt: noInference,
		onRequestStart() {}, onAttemptStart() {}, onResponseHeaders() {}, onAttemptSettled() {}, onRequestSettled() {}, onUsageObservation() {},
	});
	const resources = new Map<string, string>();
	return {
		modelMetadata: prepared.metadata, sdkVersion: versions[2], runStageGroup,
		async createArm(options) {
			if (resources.has(options.owner.sessionId)) throw new Error("Duplicate native session ownership");
			const resourceDir = await mkdtemp(join(tmpdir(), "pi-recall-arm-")); resources.set(options.owner.sessionId, resourceDir);
			try { return await createPiArm({ ...options, agentDir, resourceDir }); }
			catch (error) { await rm(resourceDir, { recursive: true, force: true }); resources.delete(options.owner.sessionId); throw error; }
		},
		async cleanupSession(owner) {
			const path = resources.get(owner.sessionId);
			if (path) { await rm(path, { recursive: true, force: true }); resources.delete(owner.sessionId); }
		},
		async cleanup() { await Promise.all([...resources.values()].map(path => rm(path, { recursive: true, force: true }))); resources.clear(); },
	};
}
