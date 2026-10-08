import type { StageResult, PairProbe } from "./pair-stages.ts";
import type { ArmSnapshot } from "./pi-arm.ts";
import type { Arm, PromptStep, Stage } from "./workload.ts";
/** Read-only legacy report shape; never an isolated group or a live controller. */
export type HistoricalObservation = {
	seed: string; stage: Stage; firstArm: Arm; status: string; steps: PromptStep[]; stopReason: string | null;
	errors: { code: string }[]; crossStageExposure: string[]; sentAttempts: Record<Arm, number>;
	stages: Record<Stage, StageResult>; probes: PairProbe[]; snapshots: Partial<Record<Arm, ArmSnapshot>>;
};
