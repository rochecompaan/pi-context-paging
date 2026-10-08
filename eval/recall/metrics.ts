import type { Arm, Stage } from "./workload.ts";
import type { Clock } from "./clock.ts";
import type { RequestMeta } from "./codex-payload.ts";
import { unknownProviderUsage, type ProviderUsageObservation } from "./codex-usage.ts";

export type MeasurementStatus = "observed" | "derived" | "not-reported" | "not-supported" | "invalid" | "incomplete" | "not-applicable";
export type Measurement<T> = { value: T | null; status: MeasurementStatus; reason: string | null };
export type OperationStatus = "succeeded" | "failed" | "aborted" | "canceled" | "censored";
export type NormalizedUsage = {
	totalInputTokens: Measurement<number>; uncachedInputTokens: Measurement<number>; outputTokens: Measurement<number>;
	reasoningTokens: Measurement<number>; totalTokens: Measurement<number>; cacheReadTokens: Measurement<number>;
	cacheWriteTokens: Measurement<number>; cacheReadFraction: Measurement<number>;
	providerMapping: "native-openai-codex-responses";
	sdkCrossCheck: { status: "unjoined" | "consistent" | "mismatched" | "not-checkable"; fields: string[] };
};
export type TimedOperation = {
	startedAtUtc: string; endedAtUtc: string | null; startMs: number; endMs: number | null;
	durationMs: Measurement<number>; status: OperationStatus;
};
export type AttemptRecord = RequestMeta & {
	attemptId: string; httpStatus: number | null; timing: TimedOperation;
	attemptWallMs: Measurement<number>; responseHeadersMs: Measurement<number>;
	timeToFirstModelDeltaMs: Measurement<number>; timeToFirstTextMs: Measurement<number>;
	providerUsage: ProviderUsageObservation; usageObservations: ProviderUsageObservation[]; observationComplete: boolean; failureCode: string | null;
};
export type RequestRecord = RequestMeta & {
	timing: TimedOperation; attempts: AttemptRecord[]; status: OperationStatus; requestWallMs: Measurement<number>;
};
export function missing<T>(status: MeasurementStatus, reason: string): Measurement<T> {
	return { value: null, status, reason };
}
export function elapsed(start: number, end: number): Measurement<number> {
	const value = end - start;
	return Number.isFinite(value) && value >= 0 ? { value, status: "observed", reason: null } : missing("invalid", "non-monotonic-clock");
}
export function startOperation(clock: Clock): TimedOperation {
	return { startedAtUtc: clock.utcNow(), endedAtUtc: null, startMs: clock.nowMs(), endMs: null,
		durationMs: missing("incomplete", "operation-active"), status: "censored" };
}
export function finishOperation(operation: TimedOperation, status: OperationStatus, clock: Clock): void {
	if (operation.endMs !== null) return;
	operation.endMs = clock.nowMs(); operation.endedAtUtc = clock.utcNow(); operation.status = status;
	operation.durationMs = elapsed(operation.startMs, operation.endMs);
}
export function createAttemptRecord(meta: RequestMeta, attemptId: string, clock: Clock): AttemptRecord {
	return { ...meta, attemptId, httpStatus: null, timing: startOperation(clock),
		attemptWallMs: missing("incomplete", "attempt-active"), responseHeadersMs: missing("not-reported", "no-response-headers"),
		timeToFirstModelDeltaMs: missing("incomplete", "stream-active"), timeToFirstTextMs: missing("incomplete", "stream-active"),
		providerUsage: unknownProviderUsage(meta.requestId, undefined, attemptId), usageObservations: [], observationComplete: false, failureCode: null };
}


/** Provider omissions are optional; lost host boundaries or response observation are not. */
export function completeRequestMeasurements(request: RequestRecord): boolean {
	const measured = (m: Measurement<number>) => m.value !== null && Number.isFinite(m.value) && m.value >= 0
		&& (m.status === "observed" || m.status === "derived");
	const terminal = (timing: TimedOperation, wall: Measurement<number>) => Number.isFinite(timing.startMs)
		&& timing.endMs !== null && Number.isFinite(timing.endMs) && timing.endedAtUtc !== null && timing.status !== "censored"
		&& measured(wall) && measured(timing.durationMs) && wall.value === timing.durationMs.value && wall.value === timing.endMs - timing.startMs;
	const optionalDelta = (m: Measurement<number>) => measured(m) || m.value === null && m.status === "not-reported";
	return request.status === request.timing.status && terminal(request.timing, request.requestWallMs) && request.attempts.length > 0
		&& request.attempts.every(attempt => {
			if (!terminal(attempt.timing, attempt.attemptWallMs)) return false;
			if (attempt.httpStatus === null) return ["failed", "aborted"].includes(attempt.timing.status)
				&& attempt.responseHeadersMs.value === null && attempt.responseHeadersMs.status === "not-reported";
			if (!measured(attempt.responseHeadersMs)) return false;
			// A rejected HTTP response has no successful model stream to observe.
			if (attempt.httpStatus < 200 || attempt.httpStatus >= 300) return attempt.timing.status !== "succeeded";
			return attempt.observationComplete && (!attempt.failureCode || attempt.failureCode === "provider-response-failed")
				&& optionalDelta(attempt.timeToFirstModelDeltaMs) && optionalDelta(attempt.timeToFirstTextMs);
		});
}

/** Controller-issued identity for one native execution, never inferred from tool IDs. */
export type SessionOwner = {
	runId: string;
	stage: Stage;
	seed: string;
	arm: Arm;
	sessionId: string;
	checkpointId: string | null;
	forkId: string | null;
};

const ownerKeys = ["runId", "stage", "seed", "arm", "sessionId", "checkpointId", "forkId"] as const;
export function sameOwner(left: SessionOwner, right: SessionOwner): boolean {
	try { assertOwner(left); assertOwner(right); } catch { return false; }
	return ownerKeys.every(key => left[key] === right[key]);
}
export function assertOwner(owner: SessionOwner): void {
	if (!owner || ![owner.runId, owner.seed, owner.sessionId].every(value => typeof value === "string" && value.length > 0)
		|| !["A", "B"].includes(owner.stage) || !["baseline", "paging"].includes(owner.arm)
		|| (owner.checkpointId === null) !== (owner.forkId === null)
		|| [owner.checkpointId, owner.forkId].some(value => value !== null && (typeof value !== "string" || value.length === 0))) {
		throw new Error("Invalid evaluation session ownership");
	}
}
