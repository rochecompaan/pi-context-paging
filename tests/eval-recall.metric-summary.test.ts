import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMetrics, pairedMeasurement, summarizeDurations } from "../eval/recall/metric-summary.ts";
import { elapsed, missing, type SessionOwner, type TimedOperation } from "../eval/recall/metrics.ts";
import { normalizeAttemptUsage, type ExecutionUsageRow } from "../eval/recall/usage.ts";
import { completeGroups, groupManifest } from "./fixtures/eval-recall-groups.ts";
import { completeProviderUsage, providerAttempt } from "./fixtures/eval-recall-usage.ts";

const measured = (value: number) => ({ value, status: "observed" as const, reason: null });
const timing = (value: number, status: TimedOperation["status"] = "succeeded"): TimedOperation => ({
	startedAtUtc: "2026-10-07T00:00:00Z", endedAtUtc: "2026-10-07T00:00:01Z", startMs: 0, endMs: value, durationMs: elapsed(0, value), status });
async function fixture() {
	const groups = await completeGroups(), group = groups[0]; group.forks = group.forks.filter(f => ["probe-A-id", "probe-A-path"].includes(f.probe.id));
	let id = 0; const rows: ExecutionUsageRow[] = [];
	function dispatch(owner: SessionOwner, input: number, cache = 0) {
		const requestId = `metric-${++id}`, attemptId = `${requestId}-attempt`;
		const attempt = { ...providerAttempt({ ...completeProviderUsage, input_tokens: input,
			input_tokens_details: { cached_tokens: cache, cache_write_tokens: 0 } }), ...owner, requestId, attemptId,
			timing: timing(10), attemptWallMs: measured(10) };
		attempt.providerUsage = { ...attempt.providerUsage, requestId, attemptId }; attempt.usageObservations = [attempt.providerUsage];
		rows.push({ ...owner, requestId, attemptId, promptId: attempt.promptId, purpose: attempt.purpose, usage: normalizeAttemptUsage(attempt, null), sdkEntryIds: [] });
		return { ...attempt, attempts: [attempt], timing: timing(10), status: "succeeded" as const, requestWallMs: measured(10) };
	}
	for (const arm of ["baseline", "paging"] as const) {
		const source = group.sources[arm]!; source.requestRecords = [dispatch(source.owner, 100)];
		source.statsCrossCheck.tokens.input = 100;
		for (const [i, fork] of group.forks.filter(f => f.owner.arm === arm).entries()) {
			fork.snapshot!.requestRecords = [dispatch(fork.owner, (arm === "baseline" ? 10 : 15) + i * 10)];
			fork.snapshot!.statsCrossCheck.tokens.input = 100; fork.probeTaskMs = measured(12);
		}
		group.preparationActiveMs[arm] = measured(20);
	}
	group.usageRecords = rows;
	return { group, manifest: groupManifest([group]), rows, dispatch };
}

test("actual preparation plus new fork usage is charged once, never inherited SDK statistics", async () => {
	const { group, manifest } = await fixture(), result = summarizeMetrics(manifest, [group]);
	const baseline = result.arms.find(s => s.arm === "baseline")!, paging = result.arms.find(s => s.arm === "paging")!;
	assert.equal(baseline.usage.totalInputTokens.value, 130); assert.equal(paging.usage.totalInputTokens.value, 140);
	assert.equal(result.run.usage.totalInputTokens.value, 270); assert.equal(result.stageGroups[0].usage.totalInputTokens.value, 270);
	assert.equal(result.paired.find(p => p.scope === "arm")!.usage.totalInputTokens.value, 10);
	assert.equal(result.paired.find(p => p.scope === "probe" && p.probeId === "probe-A-id")!.usage.totalInputTokens.value, 5);
	assert.equal(result.run.counts.attempts, 6); assert.equal(result.stages[0].sampleCount, 1);
	assert.equal(baseline.armActiveMs.value, 44); assert.equal(baseline.probeTaskMs.value, 24);
});

test("aggregate cache fraction is a ratio of sums, not the mean of request ratios", async () => {
	const { group, manifest, dispatch } = await fixture(); group.forks = [];
	group.sources.baseline!.requestRecords = [dispatch(group.sources.baseline!.owner, 10, 9), dispatch(group.sources.baseline!.owner, 90, 0)];
	const selected = group.sources.baseline!.requestRecords.flatMap(r => r.attempts).map(a => ({ ...a, usage: normalizeAttemptUsage(a, null), sdkEntryIds: [] }));
	group.usageRecords = selected;
	const summary = summarizeMetrics(manifest, [group]).preparation.find(s => s.arm === "baseline")!;
	assert.equal(summary.usage.cacheReadFraction.value, 0.09);
});

test("duration distributions retain failures separately and do not hide missing boundaries", () => {
	const summary = summarizeDurations([timing(10), timing(20), timing(60)]);
	assert.equal(summary.total.value, 90); assert.equal(summary.mean.value, 30); assert.equal(summary.median.value, 20);
	assert.equal(summary.minimum.value, 10); assert.equal(summary.maximum.value, 60); assert.equal(summary.sampleCount, 3);
	const failed = timing(5, "failed"), censored = { ...timing(0, "censored"), durationMs: missing<number>("incomplete", "missing-operation-start") };
	const partial = summarizeDurations([timing(10), failed, censored]);
	assert.equal(partial.statusCounts.failed, 1); assert.equal(partial.statusCounts.censored, 1);
	assert.equal(partial.successful.total.value, 10); assert.equal(partial.total.value, null);
	assert.equal(partial.total.measuredSubtotal, 15); assert.equal(partial.total.missingCount, 1);
});

test("one missing required count preserves subtotal and coverage but blocks a total and paired gain", async () => {
	const { group, manifest, rows } = await fixture(); rows[0].usage.totalInputTokens = missing("not-reported", "provider-field-omitted");
	rows[0].usage.uncachedInputTokens = missing("incomplete", "missing-input-components");
	const summary = summarizeMetrics(manifest, [group]), arm = summary.arms.find(s => s.arm === "baseline")!;
	assert.equal(arm.usage.totalInputTokens.value, null); assert.equal(arm.usage.totalInputTokens.measuredSubtotal, 30);
	assert.equal(arm.usage.totalInputTokens.observedCount, 2); assert.equal(arm.usage.totalInputTokens.missingCount, 1);
	assert.equal(summary.paired.find(p => p.scope === "arm")!.usage.totalInputTokens.value, null);
	assert.equal(pairedMeasurement(measured(5), missing("not-reported", "provider-field-omitted")).value, null);
	assert.equal(arm.cost.actualCostUsd.value, null); assert.ok(arm.cost.estimatedCostUsd.value === null);
});

test("foreign or duplicate canonical attempts cannot silently change metric totals", async () => {
	const { group, manifest, rows } = await fixture(); assert.throws(() => summarizeMetrics(manifest, [group, group]));
	rows.push(structuredClone(rows[0]));
	assert.throws(() => summarizeMetrics(manifest, [group])); rows.pop(); rows[0].sessionId = "foreign-session";
	assert.throws(() => summarizeMetrics(manifest, [group]));
});

test("compaction outcomes use new host phases, never inherited fork statistics", async () => {
	const { group, manifest } = await fixture(), owner = group.sources.baseline!.owner;
	group.taskRecords = ["succeeded", "failed", "canceled"].map((status, i) => ({ ...owner, operationId: `compaction-${i}`, taskId: "compaction", phase: "compaction",
		promptId: null, requestId: null, toolCallId: null, toolName: null, timing: timing(10, status as TimedOperation["status"]) }));
	for (const fork of group.forks) fork.snapshot!.compactions = [{ eventIndex: 1, reason: "threshold", success: true, inherited: true }];
	const summary = summarizeMetrics(manifest, [group]);
	assert.equal(summary.run.counts.compactionAttempts, 3); assert.equal(summary.run.counts.compactionSuccesses, 1);
	assert.equal(summary.run.counts.compactionFailures, 1); assert.equal(summary.run.counts.compactionCancellations, 1);
});

test("failed source setup retains owned timing and cannot claim a paired gain", async () => {
	const { group, manifest } = await fixture(), owner = group.sources.baseline!.owner;
	delete group.sources.baseline; group.forks = group.forks.filter(f => f.owner.arm !== "baseline");
	group.usageRecords = group.usageRecords.filter(r => r.arm !== "baseline"); group.status = "incomplete";
	group.preparationActiveMs.baseline = missing("incomplete", "preparation-phase-boundary-missing");
	group.taskRecords = [{ ...owner, operationId: "failed-setup", taskId: "setup", phase: "source-setup", promptId: null, requestId: null,
		toolCallId: null, toolName: null, timing: timing(15, "failed") }];
	const summary = summarizeMetrics(manifest, [group]), source = summary.preparation.find(s => s.arm === "baseline")!;
	assert.equal(source.phases["source-setup"]!.statusCounts.failed, 1); assert.equal(source.preparationActiveMs.value, null);
	assert.equal(summary.paired.find(p => p.scope === "arm")!.usage.totalInputTokens.value, null);
});
