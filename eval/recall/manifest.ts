import { createHash } from "node:crypto";
import type { SafeModelMetadata } from "./codex-runtime.ts";
import { CONVERSATION_DESIGN, EVAL_MODEL, PAGING_SETTINGS, WORKLOAD_VERSION } from "./experiment-settings.ts";
import { canonical, publicMetadata, sameModelMetadata } from "./experiment-identity.ts";
import { completeStageGroup } from "./eligibility.ts";
import { PAGING_RESTORATION_METHOD } from "./paging-replay.ts";
import type { EvalLimits } from "./request-guard.ts";
import type { CleanSourceSnapshot } from "./source-integrity.ts";
import type { StageGroupResult } from "./stage-group.ts";
import type { Arm, Stage } from "./workload.ts";
export { completeStageGroup, sameModelMetadata };

export type ManifestInput = {
	runId: string; mode: "pilot" | "batch";
	sourceRevision: string | null; sourceIntegrity: CleanSourceSnapshot["sourceIntegrity"] | null;
	sdkVersion: string; nodeVersion: string; modelMetadata: SafeModelMetadata | null;
	limits: Readonly<EvalLimits>; seeds: readonly string[]; stages: readonly Stage[]; firstArms: readonly Arm[];
};
export type RunManifest = Omit<ManifestInput, "limits"> & {
	limits: EvalLimits; schemaVersion: 3; conversationDesign: typeof CONVERSATION_DESIGN; thinking: typeof EVAL_MODEL.thinking;
	transport: "sse"; workloadVersion: typeof WORKLOAD_VERSION;
	baseline: { pagingEnabled: false; contextWindow: number | null; compaction: "native-defaults"; cacheWarming: "off"; builtInTools: false };
	paging: { enabled: boolean; tokenBudget: number; trimToTokens: number; compaction: "native-defaults"; cacheWarming: "off"; builtInTools: false };
	restorationMethods: { baseline: "baseline-native-history-v1"; paging: typeof PAGING_RESTORATION_METHOD };
	pricingEvidence: { mapping: "native-openai-codex-responses"; calculator: "sdk-calculateCost"; billedCost: "unknown" };
	probeOrder: readonly string[]; groupContract: { sourceSessions: 2; probeForks: 12; knownPagingTargets: 5 };
	sourceSessionCount: number; probeForkCount: number;
	checkpointConfiguration: { identity: "native-effective-config-sha256-v1"; fidelity: "exact-per-source-and-fork" };
	experimentHash: string;
};
export function experimentFingerprint(manifest: RunManifest): string {
	const { runId: _id, mode: _mode, seeds: _seeds, stages: _stages, firstArms: _order, sourceSessionCount: _sources,
		probeForkCount: _forks, experimentHash: _hash, ...experiment } = manifest;
	return createHash("sha256").update(canonical({ ...experiment, modelMetadata: publicMetadata(manifest.modelMetadata) })).digest("hex");
}
export function buildManifest(input: ManifestInput): RunManifest {
	const modelMetadata = publicMetadata(input.modelMetadata);
	const result: RunManifest = {
		runId: input.runId, mode: input.mode, sourceRevision: input.sourceRevision, sourceIntegrity: input.sourceIntegrity, sdkVersion: input.sdkVersion, nodeVersion: input.nodeVersion,
		schemaVersion: 3, conversationDesign: CONVERSATION_DESIGN, modelMetadata, thinking: EVAL_MODEL.thinking,
		baseline: { pagingEnabled: false, contextWindow: modelMetadata?.contextWindow ?? null, compaction: "native-defaults", cacheWarming: "off", builtInTools: false },
		paging: { ...PAGING_SETTINGS, compaction: "native-defaults", cacheWarming: "off", builtInTools: false },
		transport: "sse", limits: { ...input.limits }, workloadVersion: WORKLOAD_VERSION,
		seeds: [...input.seeds], stages: [...input.stages], firstArms: [...input.firstArms],
		restorationMethods: { baseline: "baseline-native-history-v1", paging: PAGING_RESTORATION_METHOD },
		pricingEvidence: { mapping: "native-openai-codex-responses", calculator: "sdk-calculateCost", billedCost: "unknown" },
		probeOrder: ["id", "path", "error", "quantity", "decision", "unknown"],
		groupContract: { sourceSessions: 2, probeForks: 12, knownPagingTargets: 5 }, sourceSessionCount: input.seeds.length * 2, probeForkCount: input.seeds.length * 12,
		checkpointConfiguration: { identity: "native-effective-config-sha256-v1", fidelity: "exact-per-source-and-fork" }, experimentHash: "",
	};
	result.experimentHash = experimentFingerprint(result); return result;
}
export function verifiedManifest(m: RunManifest): boolean {
	try {
		return m.schemaVersion === 3 && m.conversationDesign === CONVERSATION_DESIGN && m.seeds.length > 0 && new Set(m.seeds).size === m.seeds.length
			&& m.stages.length === m.seeds.length && m.stages.every(s => s === "A" || s === "B") && m.firstArms.length === m.seeds.length
			&& m.firstArms.every(a => a === "baseline" || a === "paging") && m.sourceIntegrity === "clean-checkout-v1"
			&& typeof m.sourceRevision === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(m.sourceRevision)
			&& m.modelMetadata?.provider === EVAL_MODEL.provider && m.modelMetadata.id === EVAL_MODEL.id && m.modelMetadata.api === "openai-codex-responses"
			&& Number.isSafeInteger(m.modelMetadata.contextWindow) && m.modelMetadata.contextWindow > 0 && m.thinking === EVAL_MODEL.thinking
			&& m.transport === "sse" && m.workloadVersion === WORKLOAD_VERSION && m.sourceSessionCount === m.seeds.length * 2 && m.probeForkCount === m.seeds.length * 12
			&& m.experimentHash === experimentFingerprint(m) && m.experimentHash === buildManifest(m).experimentHash;
	} catch { return false; }
}
export function isEligiblePilot(pilot: RunManifest, groups: readonly StageGroupResult[], next: RunManifest): { eligible: boolean; reason: string | null } {
	const reject = (reason: string) => ({ eligible: false, reason });
	try {
		if (pilot.mode !== "pilot" || next.mode !== "batch") return reject("wrong-run-mode");
		if (!verifiedManifest(pilot) || !verifiedManifest(next)) return reject("unverified-manifest");
		if (pilot.seeds.length !== 2 || pilot.stages.join(",") !== "A,B" || groups.length !== 2
			|| groups.some((g, i) => g.runId !== pilot.runId || g.seed !== pilot.seeds[i] || g.stage !== pilot.stages[i] || g.firstArm !== pilot.firstArms[i])) return reject("pilot-identity-mismatch");
		if (pilot.experimentHash !== next.experimentHash) return reject("experiment-mismatch");
		if (groups.some(g => !completeStageGroup(g))) return reject("incomplete-pilot-structure");
		if (groups.some(g => !sameModelMetadata(g.sources.baseline!.modelMetadata, pilot.modelMetadata))) return reject("pilot-model-mismatch");
		return { eligible: true, reason: null };
	} catch { return reject("malformed-pilot"); }
}
