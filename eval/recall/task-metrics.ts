import type { Clock } from "./clock.ts";
import { assertOwner, elapsed, finishOperation, missing, sameOwner, startOperation,
	type Measurement, type OperationStatus, type SessionOwner, type TimedOperation } from "./metrics.ts";

export type PhaseName = "source-setup" | "prompt" | "tool" | "compaction" | "fork-setup" | "checkpoint-restore" |
	"checkpoint-capture" | "scoring" | "artifact-write" | "cleanup" | "probe" | "stage-group" | "run";
export type OperationOwner = SessionOwner & { promptId: string | null; requestId: string | null; toolCallId: string | null;
	toolName?: string | null; taskId?: string };
const durationFields = { prompt: "promptTaskMs", tool: "toolWallMs", compaction: "compactionWallMs",
	"fork-setup": "forkSetupMs", "checkpoint-restore": "checkpointRestoreMs", probe: "probeTaskMs" } as const;
export type TaskDurations = Record<typeof durationFields[keyof typeof durationFields], Measurement<number>>;
export type PhaseTiming = Omit<TimedOperation, "startedAtUtc" | "startMs"> & { startedAtUtc: string | null; startMs: number | null };
export type PhaseRecord = OperationOwner & Partial<TaskDurations> & {
	operationId: string; taskId: string; phase: PhaseName; toolName: string | null; timing: PhaseTiming;
};
export type TaskRecorder = {
	begin(phase: PhaseName, owner: OperationOwner): string;
	end(operationId: string, status: OperationStatus): void;
	endWithoutStart(phase: PhaseName, owner: OperationOwner, status: OperationStatus): string;
	records(): readonly PhaseRecord[];
};
export function operationOwner(owner: SessionOwner, details: Partial<Omit<OperationOwner, keyof SessionOwner>> = {}): OperationOwner {
	return { promptId: null, requestId: null, toolCallId: null, ...details, ...owner };
}
function validate(owner: OperationOwner): void {
	assertOwner(owner);
	for (const value of [owner.promptId, owner.requestId, owner.toolCallId]) {
		if (value !== null && (typeof value !== "string" || !value.length)) throw new Error("Invalid operation ownership");
	}
}
let recorderSequence = 0;

/** Immutable snapshots of observed boundaries, with no bodies or error text. */
export function createTaskRecorder(clock: Clock): TaskRecorder {
	const recorderId = ++recorderSequence, rows = new Map<string, PhaseRecord>();
	let sequence = 0;
	function add(phase: PhaseName, owner: OperationOwner, timing: PhaseTiming): string {
		validate(owner);
		const operationId = JSON.stringify([owner.runId, owner.sessionId, phase, recorderId, ++sequence]);
		const row: PhaseRecord = { ...owner, operationId, phase, taskId: owner.taskId ?? `${owner.sessionId}:${owner.promptId ?? owner.forkId ?? phase}`,
			toolName: owner.toolName ?? null, timing };
		const field = durationFields[phase as keyof typeof durationFields];
		if (field) row[field] = timing.durationMs;
		rows.set(operationId, row);
		return operationId;
	}
	return {
		begin: (phase, owner) => add(phase, owner, startOperation(clock)),
		end(operationId, status) {
			const row = rows.get(operationId);
			if (!row) throw new Error("Unknown timing operation");
			if (row.timing.endMs !== null) {
				// A final timing write can fail after its interval has been finalized.
				if (status === "failed") row.timing.status = "failed";
				return;
			}
			if (row.timing.startMs === null) throw new Error("Missing timing operation start");
			finishOperation(row.timing as TimedOperation, status, clock);
			const field = durationFields[row.phase as keyof typeof durationFields];
			if (field) row[field] = row.timing.durationMs;
		},
		endWithoutStart: (phase, owner, status) => add(phase, owner, { startedAtUtc: null, startMs: null,
			endedAtUtc: clock.utcNow(), endMs: clock.nowMs(), durationMs: missing("incomplete", "missing-operation-start"), status }),
		records: () => structuredClone([...rows.values()]),
	};
}
export function ownedTaskRecords(recorder: TaskRecorder, owner: SessionOwner): PhaseRecord[] {
	return recorder.records().filter(row => sameOwner(row, owner));
}

/** Same-phase active subtotals only; nested phases never enter parent wall time. */
export function taskDurations(records: readonly PhaseRecord[]): TaskDurations {
	return Object.fromEntries(Object.entries(durationFields).map(([phase, field]) => {
		const rows = records.filter(row => row.phase === phase);
		if (!rows.length) return [field, missing("not-reported", "no-phase-observations")];
		if (rows.some(row => row.timing.durationMs.value === null)) return [field,
			missing(rows.some(row => row.timing.durationMs.status === "invalid") ? "invalid" : "incomplete", "missing-phase-boundary")];
		const sum = rows.reduce((sum, row) => sum + row.timing.durationMs.value!, 0);
		const measured = elapsed(0, sum);
		return [field, { ...measured, status: measured.value === null ? measured.status : "derived", reason: measured.value === null ? measured.reason : "same-phase-active-subtotal" }];
	})) as TaskDurations;
}
