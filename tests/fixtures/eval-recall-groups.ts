import { runStageGroup, type StageGroupResult } from "../../eval/recall/stage-group.ts";
import { buildManifest, type RunManifest } from "../../eval/recall/manifest.ts";
import { buildWorkload, type Stage } from "../../eval/recall/workload.ts";
import { defaultLimits } from "../../eval/recall/request-guard.ts";
import { stageFixture } from "./eval-recall-stage-group.ts";

export async function completeGroup(stage: Stage, seed = `report-fixture-stage-${stage}`, runId = "fixture-run"): Promise<StageGroupResult> {
	const f = stageFixture(buildWorkload(seed));
	return runStageGroup({ runId, seed, stage, firstArm: "baseline", createArm: f.createArm,
		cleanupSession: f.cleanupSession, onForkEvidence: async () => {}, onForkTiming: async () => {} });
}
export async function completeGroups(): Promise<StageGroupResult[]> { return [await completeGroup("A"), await completeGroup("B")]; }
export function groupManifest(groups: readonly StageGroupResult[], mode: "pilot" | "batch" = "pilot"): RunManifest {
	return buildManifest({ runId: groups[0].runId, mode, sourceRevision: "a".repeat(40), sourceIntegrity: "clean-checkout-v1",
		sdkVersion: "0.87.1", nodeVersion: process.version, modelMetadata: groups[0].sources.baseline!.modelMetadata,
		limits: defaultLimits, seeds: groups.map(g => g.seed), stages: groups.map(g => g.stage), firstArms: groups.map(g => g.firstArm) });
}
