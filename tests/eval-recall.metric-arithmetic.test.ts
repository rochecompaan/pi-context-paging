import assert from "node:assert/strict";
import test from "node:test";
import { ratioMeasurement, sumMeasurements, summarizeDurations } from "../eval/recall/metric-arithmetic.ts";
import { missing, type Measurement, type OperationStatus } from "../eval/recall/metrics.ts";
import type { PhaseTiming } from "../eval/recall/task-metrics.ts";

const observed = (value: number): Measurement<number> => ({ value, status: "observed", reason: null });
const derivedValue = (value: number): Measurement<number> => ({ value, status: "derived", reason: null });
const notApplicable = (): Measurement<number> => missing<number>("not-applicable", "zero-input");
const notReported = (): Measurement<number> => missing<number>("not-reported", "provider-usage-omitted");
const invalid = (): Measurement<number> => missing<number>("invalid", "invalid-provider-field");

/** PhaseTiming keeps the timing fields the summary ignores, so the fixture stays type-correct. */
function timing(durationMs: Measurement<number>, status: OperationStatus): PhaseTiming {
	return { startedAtUtc: "2026-01-01T00:00:00.000Z", startMs: 0,
		endedAtUtc: durationMs.value === null ? null : "2026-01-01T00:00:01.000Z", endMs: durationMs.value, durationMs, status };
}

test("a sum keeps its known subtotal and reports exactly which measurements are absent", () => {
	const summary = sumMeasurements([observed(10), derivedValue(5), notApplicable(), notReported(), observed(1)]);

	assert.equal(summary.measuredSubtotal, 16);
	assert.deepEqual({ observedCount: summary.observedCount, missingCount: summary.missingCount, notApplicableCount: summary.notApplicableCount, sampleCount: summary.sampleCount },
		{ observedCount: 3, missingCount: 1, notApplicableCount: 1, sampleCount: 5 });
	// An absent measurement makes the total unknown; the subtotal stays reportable.
	assert.equal(summary.value, null);
	assert.equal(summary.status, "incomplete");
	assert.deepEqual(summary.missing, [{ status: "not-reported", reason: "provider-usage-omitted" }]);
});

test("one invalid component invalidates a sum instead of summing around it", () => {
	const summary = sumMeasurements([observed(10), invalid(), observed(5)]);

	assert.equal(summary.value, null);
	assert.equal(summary.status, "invalid");
	assert.equal(summary.reason, "incomplete-aggregate");
	assert.equal(summary.measuredSubtotal, 15);
});

test("coverage counts not-applicable as explained, so explained gaps are not silent", () => {
	assert.equal(sumMeasurements([observed(1), observed(2)]).coverage, 1);
	assert.equal(sumMeasurements([observed(1), notApplicable()]).coverage, 1);
	assert.equal(sumMeasurements([observed(1), notReported()]).coverage, 0.5);
	assert.equal(sumMeasurements([]).coverage, 1);
});

test("a ratio of unknown operands stays unknown and a zero denominator is not-applicable", () => {
	const denominator = sumMeasurements([observed(4), observed(1)]);

	assert.deepEqual((() => { const r = ratioMeasurement(sumMeasurements([observed(3)]), denominator); return [r.value, r.status, r.reason]; })(), [0.6, "derived", null]);

	const zero = ratioMeasurement(sumMeasurements([observed(3)]), sumMeasurements([observed(0)]));
	assert.equal(zero.value, null);
	assert.equal(zero.status, "not-applicable");
	assert.equal(zero.reason, "zero-input");
	assert.equal(zero.measuredSubtotal, 0);

	const unknownNumerator = sumMeasurements([notReported()]);
	const incomplete = ratioMeasurement(unknownNumerator, denominator);
	assert.equal(incomplete.value, null);
	assert.equal(incomplete.status, "incomplete");
	assert.equal(incomplete.reason, "missing-cache-fraction-operands");
	// A ratio cannot be better evidenced than its weakest side.
	assert.equal(incomplete.coverage, Math.min(unknownNumerator.coverage, denominator.coverage));
	assert.equal(incomplete.observedCount, Math.min(unknownNumerator.observedCount, denominator.observedCount));
	assert.equal(incomplete.missingCount, Math.max(unknownNumerator.missingCount, denominator.missingCount));
});

test("a duration summary stays unknown when any run lacks a duration, and the successful subset stays reportable", () => {
	const summary = summarizeDurations([observed(10), observed(40), observed(20), notReported(), observed(30)].map((value, index) =>
		timing(value, index === 3 ? "failed" : index === 0 ? "aborted" : "succeeded")));

	// Every sample must carry a duration: the summary never describes a partial sample as if it were whole.
	for (const metric of [summary.total, summary.mean, summary.median, summary.minimum, summary.maximum]) {
		assert.equal(metric.value, null);
		assert.equal(metric.status, "incomplete");
		assert.equal(metric.reason, "incomplete-aggregate");
	}
	assert.equal(summary.sampleCount, 5);
	assert.deepEqual(summary.statusCounts, { succeeded: 3, failed: 1, aborted: 1, canceled: 0, censored: 0 });
	assert.equal(summary.successful.median.value, 30);
	assert.equal(summary.successful.minimum.value, 20);
	assert.equal(summary.successful.maximum.value, 40);
	assert.equal(summary.successful.total.sampleCount, 3);
	const complete = summarizeDurations([observed(10), observed(40), observed(20), observed(30)].map(value => timing(value, "succeeded")));
	assert.equal(complete.mean.value, 25);
	assert.equal(complete.median.value, 25);
	assert.equal(complete.total.value, 100);
});

test("a non-finite duration invalidates the whole summary instead of averaging around it", () => {
	const summary = summarizeDurations([timing(observed(10), "succeeded"), timing(invalid(), "failed"), timing({ value: Number.NaN, status: "observed", reason: null }, "succeeded")]);

	assert.equal(summary.total.value, null);
	// An invalid member invalidates the aggregate, and the non-finite sample never enters the
	// subtotal: a report must be able to show what the finite samples summed to.
	assert.equal(summary.total.status, "invalid");
	assert.equal(summary.total.reason, "incomplete-aggregate");
	assert.equal(summary.total.measuredSubtotal, 10);
	assert.equal(summary.total.missingCount, 2);
	for (const metric of [summary.mean, summary.median, summary.minimum, summary.maximum]) {
		assert.equal(metric.value, null);
		assert.equal(metric.status, "incomplete");
		assert.equal(metric.reason, "incomplete-aggregate");
	}
});

test("a duration summary over no runs is not-applicable, not a zero", () => {
	const summary = summarizeDurations([]);

	assert.equal(summary.median.status, "not-applicable");
	assert.equal(summary.median.reason, "no-observations");
	assert.equal(summary.successful.median.reason, "no-observations");
	assert.equal(summary.sampleCount, 0);
});
