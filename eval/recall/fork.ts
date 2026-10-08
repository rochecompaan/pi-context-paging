import { checkpointEvidence, type PrivateCheckpoint, type CheckpointEvidence, type CheckpointRestoration } from "./checkpoint.ts";
import type { RequestMeta, RequestEvidence } from "./codex-payload.ts";
import { sameOwner, type SessionOwner } from "./metrics.ts";
import { createTaskRecorder, operationOwner, ownedTaskRecords, taskDurations,
	type TaskRecorder, type TaskDurations, type PhaseName, type PhaseRecord } from "./task-metrics.ts";
import type { ArmSnapshot, Clock, EvalArm } from "./pi-arm.ts";
import type { JournalEvent } from "./pi-journal.ts";
import type { Arm, PromptStep } from "./workload.ts";

export type ArmFactoryOptions = {
	arm: Arm;
	owner: SessionOwner;
	checkpoint?: PrivateCheckpoint;
	requestGuard(meta: RequestMeta): void | Promise<void>;
	payloadGuard?(evidence: RequestEvidence): void | Promise<void>;
	clock: Clock;
	eventSink?: (event: JournalEvent) => void;
	taskRecorder?: TaskRecorder;
};
export type ProbeForkOptions = {
	checkpoint: PrivateCheckpoint;
	owner: SessionOwner;
	step: PromptStep;
	createArm(options: ArmFactoryOptions): Promise<EvalArm>;
	requestGuard(meta: RequestMeta): void | Promise<void>;
	payloadGuard?(evidence: RequestEvidence): void | Promise<void>;
	clock: Clock;
	cleanupSession(owner: SessionOwner): Promise<void>;
	taskRecorder?: TaskRecorder;
	score?(result: Readonly<ProbeForkResult>): void | Promise<void>;
	beforePrompt?(): void;
	writeEvidence?(result: Readonly<ProbeForkResult>): void | Promise<void>;
	writeTiming?(result: Readonly<ProbeForkResult>): void | Promise<void>;
};
export type ProbeForkResult = TaskDurations & {
	taskRecords: readonly PhaseRecord[];
	owner: SessionOwner;
	checkpoint: CheckpointEvidence;
	restoration: CheckpointRestoration | null;
	inheritedPromptCount: number;
	snapshot: ArmSnapshot | null;
	failureCode: string | null;
	cleanup: { complete: boolean; failureCode: string | null };
};

/** The probe includes evidence persistence and cleanup; its final timing write is not recursive. */
export async function runProbeFork(options: ProbeForkOptions): Promise<ProbeForkResult> {
	const recorder = options.taskRecorder ?? createTaskRecorder(options.clock), scope = operationOwner(options.owner, { promptId: options.step.id });
	const probe = recorder.begin("probe", scope);
	const checkpoint = checkpointEvidence(options.checkpoint);
	const result: ProbeForkResult = { ...taskDurations([]), taskRecords: [], owner: { ...options.owner }, checkpoint, restoration: null,
		inheritedPromptCount: checkpoint.inheritedPromptCount, snapshot: null, failureCode: null,
		cleanup: { complete: false, failureCode: null } };
	const refresh = () => {
		const rows = new Map((result.snapshot?.taskRecords ?? []).filter(row => sameOwner(row, options.owner)).map(row => [row.operationId, row]));
		for (const row of ownedTaskRecords(recorder, options.owner)) rows.set(row.operationId, row);
		result.taskRecords = [...rows.values()]; Object.assign(result, taskDurations(result.taskRecords));
	};
	const hostPhase = async (phase: PhaseName, action: () => void | Promise<void>) => {
		const id = recorder.begin(phase, scope); refresh();
		try { await action(); recorder.end(id, "succeeded"); }
		catch (error) { recorder.end(id, "failed"); throw error; }
		finally { refresh(); }
	};
	let arm: EvalArm | undefined;
	try {
		try {
			if (options.step.kind !== "probe") throw new Error("Fork requires one probe");
			arm = await options.createArm({ arm: options.owner.arm, owner: options.owner, checkpoint: options.checkpoint,
				requestGuard: options.requestGuard, payloadGuard: options.payloadGuard, clock: options.clock, taskRecorder: recorder });
			result.snapshot = arm.snapshot(); result.restoration = result.snapshot.restoration ?? null;
			if (!sameOwner(result.snapshot.owner, options.owner)) result.failureCode = "fork-ownership-failed";
			else if (!result.restoration?.passed) result.failureCode = "fork-restoration-failed";
			else {
				options.beforePrompt?.();
				result.snapshot = await arm.runPrompt(options.step);
				if (result.snapshot.errors.length) result.failureCode = "fork-prompt-failed";
			}
		} catch {
			result.failureCode ??= arm ? "fork-prompt-failed" : "fork-setup-failed";
			if (arm) try { result.snapshot = arm.snapshot(); } catch { /* Keep already captured partial evidence. */ }
		}
		refresh();
		if (options.score) try { await hostPhase("scoring", () => options.score!(result)); }
		catch { result.failureCode ??= "fork-scoring-failed"; }
		if (options.writeEvidence) try { await hostPhase("artifact-write", () => options.writeEvidence!(result)); }
		catch { result.failureCode ??= "fork-artifact-write-failed"; }
	} finally {
		const cleanup = recorder.begin("cleanup", scope);
		try { await arm?.abort(); } catch { result.cleanup.failureCode = "fork-abort-failed"; }
		try { arm?.dispose(); } catch { result.cleanup.failureCode ??= "fork-dispose-failed"; }
		try { await options.cleanupSession(options.owner); } catch { result.cleanup.failureCode ??= "fork-resource-cleanup-failed"; }
		result.cleanup.complete = result.cleanup.failureCode === null;
		if (!result.cleanup.complete) result.failureCode ??= "fork-cleanup-failed";
		recorder.end(cleanup, result.cleanup.complete ? "succeeded" : "failed");
		recorder.end(probe, result.failureCode ? "failed" : "succeeded"); refresh();
	}
	try { await options.writeTiming?.(result); }
	catch { result.failureCode ??= "fork-timing-write-failed"; recorder.end(probe, "failed"); refresh(); }
	return result;
}
