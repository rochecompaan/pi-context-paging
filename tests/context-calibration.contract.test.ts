import assert from "node:assert/strict";
import test from "node:test";
import { calibrateResponse, validTokenEstimates, type ContextTokenEstimates } from "../src/context-calibration.ts";

/**
 * The cut budget is spent against provider-reported reality, not against a heuristic. Calibration is
 * the correction that keeps them together, so the property worth pinning is that a calibrated
 * projection reproduces the reported total exactly, and that a dense recovery payload's undercount
 * does not become a permanent resident cost.
 */
function project(overhead: number, scale: number, residentTokens: number, messageTokens: number, outgoingTokens: number): number {
	return residentTokens + overhead + outgoingTokens + scale * (messageTokens - outgoingTokens);
}

/** The identity is exact in real arithmetic; token counts are not integers, so compare with a relative tolerance. */
function assertProjects(calibration: { residentOverheadTokens: number; messageScale: number }, resident: number, messages: number, outgoing: number, reported: number) {
	const projected = project(calibration.residentOverheadTokens, calibration.messageScale, resident, messages, outgoing);
	assert.ok(Math.abs(projected - reported) <= Math.max(1, reported) * 1e-9, `projected ${projected} for reported ${reported}`);
}

const RESIDENT = 2_000, MESSAGES = 8_000, OUTGOING = 1_000, REPORTED = 12_000;

test("a calibrated projection reproduces the provider-reported total exactly", () => {
	const cases: [number, number, number, number, number | undefined][] = [
		[RESIDENT, MESSAGES, REPORTED, OUTGOING, undefined],
		[RESIDENT, MESSAGES, REPORTED, OUTGOING, 300],
		[RESIDENT, MESSAGES, REPORTED, 0, undefined],
		[RESIDENT, MESSAGES, 40_000, OUTGOING, 5_000],
		[1, 1, 4, 0, undefined],
		[0, 1_000, 1_500, 200, undefined],
		[64_000, 12_000, 78_500, 12_000, undefined],
	];
	for (const [resident, messages, reported, outgoing, previous] of cases) {
		const calibration = calibrateResponse(resident, messages, reported, previous, outgoing);
		assert.notEqual(calibration, undefined, JSON.stringify([resident, messages, reported, previous, outgoing]));
		assertProjects(calibration!, resident, messages, outgoing, reported);
	}
});

test("the first measurement splits the undercount by the resident share", () => {
	const calibration = calibrateResponse(RESIDENT, MESSAGES, REPORTED, undefined, OUTGOING)!;
	const scalable = MESSAGES - OUTGOING;
	assert.equal(calibration.residentOverheadTokens, (REPORTED - RESIDENT - MESSAGES) * (RESIDENT / (RESIDENT + scalable)));
	assert.equal(calibration.messageScale, 1 + (REPORTED - RESIDENT - MESSAGES - calibration.residentOverheadTokens) / scalable);
});

test("a later, smaller undercount lowers the resident overhead instead of raising it", () => {
	const first = calibrateResponse(RESIDENT, MESSAGES, REPORTED, undefined, OUTGOING)!;
	// A recovery-heavy turn reports less surplus than the first measurement implied.
	const second = calibrateResponse(RESIDENT, MESSAGES, RESIDENT + MESSAGES + 120, first.residentOverheadTokens, OUTGOING)!;
	assert.equal(second.residentOverheadTokens, 120);
	assert.ok(second.residentOverheadTokens < first.residentOverheadTokens);
	assertProjects(second, RESIDENT, MESSAGES, OUTGOING, RESIDENT + MESSAGES + 120);
	// A larger surplus must not inflate overhead past what was observed.
	const third = calibrateResponse(RESIDENT, MESSAGES, REPORTED, second.residentOverheadTokens, OUTGOING)!;
	assert.equal(third.residentOverheadTokens, second.residentOverheadTokens);
});

test("no calibration is invented when the heuristic already covers usage, or when nothing is scalable", () => {
	// Heuristics that overestimate must not be "corrected" upward, and an exact match needs nothing.
	assert.equal(calibrateResponse(RESIDENT, MESSAGES, RESIDENT + MESSAGES, undefined, OUTGOING), undefined);
	assert.equal(calibrateResponse(RESIDENT, MESSAGES, RESIDENT + MESSAGES - 500, undefined, OUTGOING), undefined);
	// Every message is in the outgoing tail and there is no resident cost: overhead is unidentifiable.
	assert.equal(calibrateResponse(0, 1_000, 1_500, undefined, 1_000), undefined);
	// With no scalable messages the whole undercount is resident and the scale stays neutral.
	const onlyResident = calibrateResponse(500, 1_000, 1_800, undefined, 1_000)!;
	assert.equal(onlyResident.residentOverheadTokens, 300);
	assert.equal(onlyResident.messageScale, 1);
});

test("token estimates are usable only when they are finite, non-negative, and match the message count", () => {
	const estimates = (residentTokens: number, messageTokens: number[]): ContextTokenEstimates => ({ residentTokens, messageTokens });
	assert.equal(validTokenEstimates(estimates(0, []), 0), true);
	assert.equal(validTokenEstimates(estimates(1_024, [10, 20, 30]), 3), true);
	assert.equal(validTokenEstimates(undefined, 0), false);
	for (const bad of [estimates(Number.NaN, [10]), estimates(Number.POSITIVE_INFINITY, [10]), estimates(-1, [10]),
		estimates(10, [Number.NaN]), estimates(10, [-0.5]), estimates(10, [Number.POSITIVE_INFINITY]), estimates(10, [10, 20])]) {
		assert.equal(validTokenEstimates(bad, 1), false, JSON.stringify(bad));
	}
	// Length mismatch is the interesting one: a stale snapshot must not be trusted for a new request.
	assert.equal(validTokenEstimates(estimates(10, [10, 20]), 1), false);
	assert.equal(validTokenEstimates(estimates(10, [10]), 2), false);
});
