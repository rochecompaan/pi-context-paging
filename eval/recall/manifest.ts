import { createHash } from "node:crypto";
import type { SafeModelMetadata } from "./codex-runtime.ts";
import { CONVERSATION_DESIGN, EVAL_MODEL, PAGING_SETTINGS, WORKLOAD_VERSION } from "./experiment-settings.ts";
import type { PairResult } from "./pair.ts";
import type { EvalLimits } from "./request-guard.ts";
import { sanitizeArtifact } from "./safe-artifacts.ts";
import type { CleanSourceSnapshot } from "./source-integrity.ts";
import type { Arm, Stage } from "./workload.ts";

export type ManifestInput = {
	runId: string; mode: "pilot" | "batch";
	sourceRevision: string | null; sourceIntegrity: CleanSourceSnapshot["sourceIntegrity"] | null;
	sdkVersion: string; nodeVersion: string; modelMetadata: SafeModelMetadata | null;
	limits: Readonly<EvalLimits>; seeds: readonly string[]; stages: readonly Stage[]; firstArms: readonly Arm[];
};
export type RunManifest = Omit<ManifestInput, "limits"> & {
	limits: EvalLimits;
	schemaVersion: 2; conversationDesign: typeof CONVERSATION_DESIGN; thinking: typeof EVAL_MODEL.thinking; transport: "sse"; workloadVersion: typeof WORKLOAD_VERSION;
	baseline: { pagingEnabled: false; contextWindow: number | null; compaction: "native-defaults"; cacheWarming: "off"; builtInTools: false };
	paging: { enabled: boolean; tokenBudget: number; trimToTokens: number; compaction: "native-defaults"; cacheWarming: "off"; builtInTools: false };
	experimentHash: string;
};
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
function publicMetadata(metadata: SafeModelMetadata | null): SafeModelMetadata | null {
	return (sanitizeArtifact({ modelMetadata: metadata }) as { modelMetadata: SafeModelMetadata | null }).modelMetadata;
}
export function sameModelMetadata(a: SafeModelMetadata | null, b: SafeModelMetadata | null): boolean {
	return canonical(publicMetadata(a)) === canonical(publicMetadata(b));
}
export function experimentFingerprint(manifest: RunManifest): string {
	const { schemaVersion, conversationDesign, sourceRevision, sourceIntegrity, sdkVersion, nodeVersion, thinking, baseline, paging, transport, limits, workloadVersion } = manifest;
	return createHash("sha256").update(canonical({ schemaVersion, conversationDesign, sourceRevision, sourceIntegrity, sdkVersion, nodeVersion,
		modelMetadata: publicMetadata(manifest.modelMetadata), thinking, baseline, paging, transport, limits, workloadVersion })).digest("hex");
}
export function buildManifest(input: ManifestInput): RunManifest {
	const modelMetadata = publicMetadata(input.modelMetadata);
	const result: RunManifest = {
		schemaVersion: 2, conversationDesign: CONVERSATION_DESIGN, runId: input.runId, mode: input.mode, sourceRevision: input.sourceRevision, sourceIntegrity: input.sourceIntegrity,
		sdkVersion: input.sdkVersion, nodeVersion: input.nodeVersion, modelMetadata, thinking: EVAL_MODEL.thinking,
		baseline: { pagingEnabled: false, contextWindow: modelMetadata?.contextWindow ?? null, compaction: "native-defaults", cacheWarming: "off", builtInTools: false },
		paging: { ...PAGING_SETTINGS, compaction: "native-defaults", cacheWarming: "off", builtInTools: false },
		transport: "sse", limits: { ...input.limits }, workloadVersion: WORKLOAD_VERSION,
		seeds: [...input.seeds], stages: [...input.stages], firstArms: [...input.firstArms], experimentHash: "",
	};
	result.experimentHash = experimentFingerprint(result);
	return result;
}

export function verifiedManifest(manifest: RunManifest): boolean {
	return manifest.schemaVersion === 2 && manifest.conversationDesign === CONVERSATION_DESIGN
		&& manifest.seeds.length > 0 && new Set(manifest.seeds).size === manifest.seeds.length
		&& manifest.stages.length === manifest.seeds.length && manifest.stages.every(stage => stage === "A" || stage === "B")
		&& manifest.firstArms.length === manifest.seeds.length && manifest.sourceIntegrity === "clean-checkout-v1"
		&& typeof manifest.sourceRevision === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.sourceRevision)
		&& manifest.modelMetadata?.provider === EVAL_MODEL.provider && manifest.modelMetadata.id === EVAL_MODEL.id
		&& manifest.modelMetadata.api === "openai-codex-responses" && Number.isSafeInteger(manifest.modelMetadata.contextWindow)
		&& manifest.modelMetadata.contextWindow > 0 && manifest.thinking === EVAL_MODEL.thinking
		&& manifest.transport === "sse" && manifest.workloadVersion === WORKLOAD_VERSION
		&& manifest.experimentHash === experimentFingerprint(manifest);
}

/** Model correctness is not a structural gate. Retain complete wrong answers. */
export function completePair(result: PairResult): boolean {
	try {
		if ((result.stage !== "A" && result.stage !== "B") || result.status !== "complete" || result.stopReason || result.errors.length
			|| result.steps.length < 24 || result.promptCounts.baseline !== result.steps.length || result.promptCounts.paging !== result.steps.length
			|| result.probes.length !== 6 || result.probes.some(probe => probe.probe.stage !== result.stage)) return false;
		const observed = result.stages[result.stage], other = result.stages[result.stage === "A" ? "B" : "A"];
		if (!observed.complete || !observed.valid || observed.reason || observed.probes.length !== 6 || observed.timing.length !== 6
			|| other.probes.length || other.complete || other.valid) return false;
		const probeSteps = result.steps.filter(step => step.kind === "probe");
		if (probeSteps.length !== 6 || probeSteps.some(step => step.stage !== result.stage)) return false;
		if (observed.qualifiedKnown !== observed.probes.filter(probe => probe.probe.factId && probe.paging.evidence.qualified).length) return false;
		if (result.stage === "A" && (observed.qualifiedKnown < 4 || observed.timing.some(timing => timing.baselineCompactionsAfter > 0))) return false;
		if (result.stage === "B" && (result.crossStageExposure.length || observed.timing.some(timing => timing.baselineCompactionsBefore < 1))) return false;
		for (const arm of ["baseline", "paging"] as const) {
			const snapshot = result.snapshots[arm];
			if (!snapshot || snapshot.errors.length || snapshot.promptCount !== result.steps.length || !snapshot.requests.length
				|| snapshot.requests.some(request => !request.complete || request.arm !== arm)) return false;
		}
		return result.probes.every(probe => probe.comparisonEligible && probe.baseline.traceComplete && probe.paging.traceComplete)
			&& (result.stage === "B" ? result.snapshots.baseline!.compactions.some(event => event.success)
				: !result.snapshots.baseline!.compactions.some(event => event.success))
			&& sameModelMetadata(result.snapshots.baseline!.modelMetadata, result.snapshots.paging!.modelMetadata);
	} catch { return false; }
}

export function isEligiblePilot(pilot: RunManifest, results: readonly PairResult[], next: RunManifest): { eligible: boolean; reason: string | null } {
	const reject = (reason: string) => ({ eligible: false, reason });
	try {
		if (pilot.mode !== "pilot" || next.mode !== "batch") return reject("wrong-run-mode");
		if (!verifiedManifest(pilot) || !verifiedManifest(next)) return reject("unverified-manifest");
		if (pilot.seeds.length !== 2 || pilot.stages[0] !== "A" || pilot.stages[1] !== "B" || results.length !== 2
			|| results.some((result, index) => result.seed !== pilot.seeds[index] || result.stage !== pilot.stages[index]
				|| result.firstArm !== pilot.firstArms[index])) return reject("pilot-identity-mismatch");
		if (pilot.experimentHash !== next.experimentHash) return reject("experiment-mismatch");
		if (results.some(result => !completePair(result))) return reject("incomplete-pilot-structure");
		if (results.some(result => !sameModelMetadata(result.snapshots.baseline!.modelMetadata, pilot.modelMetadata))) return reject("pilot-model-mismatch");
		return { eligible: true, reason: null };
	} catch { return reject("malformed-pilot"); }
}
