import { missing, type Measurement, type OperationStatus } from "./metrics.ts";
import type { PhaseTiming } from "./task-metrics.ts";

export type AggregateMeasurement = Measurement<number> & {
	measuredSubtotal: number; observedCount: number; missingCount: number; notApplicableCount: number; sampleCount: number;
	coverage: number; missing: { status: Measurement<number>["status"]; reason: string | null }[];
};
export const derived = (value: number): Measurement<number> => Number.isFinite(value)
	? { value, status: "derived", reason: null } : missing("invalid", "non-finite-aggregate");
export function sumMeasurements(values: readonly Measurement<number>[]): AggregateMeasurement {
	const observed = values.filter(m => m.value !== null && Number.isFinite(m.value) && ["observed", "derived"].includes(m.status));
	const absent = values.filter(m => !observed.includes(m) && m.status !== "not-applicable");
	const notApplicableCount = values.filter(m => m.status === "not-applicable").length;
	const measuredSubtotal = observed.reduce((n, m) => n + m.value!, 0);
	return { ...(absent.length ? missing<number>(absent.some(m => m.status === "invalid") ? "invalid" : "incomplete", "incomplete-aggregate") : derived(measuredSubtotal)),
		measuredSubtotal, observedCount: observed.length, missingCount: absent.length, notApplicableCount, sampleCount: values.length,
		coverage: values.length ? (observed.length + notApplicableCount) / values.length : 1,
		missing: absent.map(m => ({ status: m.status, reason: m.reason })) };
}
export function pairedMeasurement(paging: Measurement<number>, baseline: Measurement<number>): Measurement<number> {
	return [paging, baseline].every(m => m.value !== null && Number.isFinite(m.value) && ["observed", "derived"].includes(m.status))
		? derived(paging.value! - baseline.value!) : missing("incomplete", "incomplete-paired-operands");
}
export function ratioMeasurement(numerator: AggregateMeasurement, denominator: AggregateMeasurement): AggregateMeasurement {
	const measurement = denominator.value === 0 ? missing<number>("not-applicable", "zero-input")
		: numerator.value !== null && denominator.value !== null ? derived(numerator.value / denominator.value) : missing<number>("incomplete", "missing-cache-fraction-operands");
	return { ...denominator, ...measurement, measuredSubtotal: denominator.measuredSubtotal > 0 ? numerator.measuredSubtotal / denominator.measuredSubtotal : 0,
		observedCount: Math.min(numerator.observedCount, denominator.observedCount), missingCount: Math.max(numerator.missingCount, denominator.missingCount),
		coverage: Math.min(numerator.coverage, denominator.coverage), missing: [...numerator.missing, ...denominator.missing] };
}
function distribution(values: readonly Measurement<number>[]) {
	const total = sumMeasurements(values), sorted = values.filter(m => m.value !== null && ["observed", "derived"].includes(m.status)).map(m => m.value!).sort((a, b) => a - b);
	const metric = (value: number) => !sorted.length ? missing<number>("not-applicable", "no-observations")
		: total.value === null ? missing<number>("incomplete", "incomplete-aggregate") : derived(value);
	return { total, mean: metric(total.measuredSubtotal / sorted.length), median: metric(sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2),
		minimum: metric(sorted[0]), maximum: metric(sorted.at(-1)!) };
}
export function summarizeDurations(records: readonly PhaseTiming[]) {
	const statusCounts: Record<OperationStatus, number> = { succeeded: 0, failed: 0, aborted: 0, canceled: 0, censored: 0 };
	for (const r of records) statusCounts[r.status]++;
	return { ...distribution(records.map(r => r.durationMs)), sampleCount: records.length, values: records.map(r => ({ status: r.status, durationMs: r.durationMs })), statusCounts,
		successful: distribution(records.filter(r => r.status === "succeeded").map(r => r.durationMs)) };
}
export type DurationSummary = ReturnType<typeof summarizeDurations>;
