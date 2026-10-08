import type { Api, Model } from "@earendil-works/pi-ai";
import { describePricing, priceAttempt, type CostMeasurements } from "./cost.ts";
import { sameOwner, missing, type Measurement, type NormalizedUsage, type RequestRecord, type SessionOwner, type TimedOperation } from "./metrics.ts";
import { derived, pairedMeasurement, ratioMeasurement, sumMeasurements, summarizeDurations, type AggregateMeasurement } from "./metric-arithmetic.ts";
import type { RunManifest } from "./manifest.ts";
import type { ArmSnapshot } from "./pi-arm.ts";
import type { StageGroupResult } from "./stage-group.ts";
import type { PhaseRecord } from "./task-metrics.ts";
import type { ExecutionUsageRow } from "./usage.ts";
import type { Arm, Stage } from "./workload.ts";
export { pairedMeasurement, summarizeDurations } from "./metric-arithmetic.ts";

const usageFields = ["totalInputTokens", "uncachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
const costFields = ["uncachedInputCostUsd", "outputCostUsd", "cacheReadCostUsd", "cacheWriteCostUsd", "estimatedCostUsd", "knownCostSubtotalUsd", "actualCostUsd"] as const;
type UsageMetrics = Record<typeof usageFields[number] | "cacheReadFraction", AggregateMeasurement>;
type CostMetrics = Record<keyof CostMeasurements, AggregateMeasurement>;
type Unit = { group: StageGroupResult; owner: SessionOwner; probeId: string | null; snapshot: ArmSnapshot | null;
	rows: ExecutionUsageRow[]; requests: readonly RequestRecord[]; phases: readonly PhaseRecord[]; preparationActiveMs: Measurement<number>; probeTaskMs: Measurement<number> };
export type MetricScope = {
	scope: "preparation" | "probe" | "arm" | "stage-group" | "stage" | "run"; stage: Stage | null; seed: string | null; arm: Arm | null; probeId: string | null;
	sampleCount: number; executionCount: number; complete: boolean; usage: UsageMetrics; cost: CostMetrics;
	preparationActiveMs: AggregateMeasurement; probeTaskMs: AggregateMeasurement; armActiveMs: AggregateMeasurement; promptTaskMs: AggregateMeasurement;
	stageGroupWallMs: AggregateMeasurement; runWallMs: Measurement<number>; counts: { requests: number; attempts: number; retries: number; providerErrors: number;
		compactionAttempts: number; compactionSuccesses: number; compactionFailures: number; compactionCancellations: number; tools: Record<string, number> };
	responses: Record<"conversation" | "compaction", { request: ReturnType<typeof summarizeDurations>; attempt: ReturnType<typeof summarizeDurations>;
		responseHeadersMs: AggregateMeasurement; timeToFirstModelDeltaMs: AggregateMeasurement; timeToFirstTextMs: AggregateMeasurement }>;
	phases: Partial<Record<PhaseRecord["phase"], ReturnType<typeof summarizeDurations>>>;
};
export type PairedMetrics = Pick<MetricScope, "stage" | "seed" | "probeId"> & { scope: "preparation" | "probe" | "arm";
	usage: Record<keyof UsageMetrics, Measurement<number>>; cost: Record<keyof CostMetrics, Measurement<number>>;
	preparationActiveMs: Measurement<number>; promptTaskMs: Measurement<number>; probeTaskMs: Measurement<number>; armActiveMs: Measurement<number>; attempts: Measurement<number> };
export type RunMetricsSummary = {
	pricing: ReturnType<typeof describePricing> | null; preparation: MetricScope[]; probes: MetricScope[]; arms: MetricScope[]; stageGroups: MetricScope[];
	stages: MetricScope[]; run: MetricScope; paired: PairedMetrics[];
};
const ownerKey = (o: SessionOwner) => JSON.stringify([o.runId, o.stage, o.seed, o.arm, o.sessionId, o.checkpointId, o.forkId]);
const attemptKey = (r: SessionOwner & { requestId: string; attemptId: string }) => `${ownerKey(r)}:${JSON.stringify([r.requestId, r.attemptId])}`;
function unitsFor(manifest: RunManifest, group: StageGroupResult): Unit[] {
	if (group.runId !== manifest.runId) throw new Error("Metric run ownership mismatch");
	const snapshots = [...Object.values(group.sources).filter((s): s is ArmSnapshot => !!s), ...group.forks.flatMap(f => f.snapshot ? [f.snapshot] : [])];
	const actual = new Set<string>();
	for (const s of snapshots) for (const r of s.requestRecords) {
		if (!sameOwner(s.owner, r)) throw new Error("Metric request ownership mismatch");
		for (const a of r.attempts) {
			const key = attemptKey(a);
			if (!sameOwner(r, a) || a.requestId !== r.requestId || actual.has(key)) throw new Error("Metric attempt ownership mismatch");
			actual.add(key);
		}
	}
	const seen = new Set<string>();
	for (const row of group.usageRecords) {
		const key = attemptKey(row);
		if (seen.has(key) || !actual.has(key)) throw new Error("Metric usage ownership mismatch");
		seen.add(key);
	}
	function unit(owner: SessionOwner, snapshot: ArmSnapshot | null, probeId: string | null, active: Measurement<number>, probe: Measurement<number>): Unit {
		if (owner.runId !== group.runId || owner.stage !== group.stage || owner.seed !== group.seed || snapshot && !sameOwner(owner, snapshot.owner)) throw new Error("Metric execution ownership mismatch");
		const rows = group.usageRecords.filter(r => sameOwner(r, owner));
		// Missing canonical rows are not replaced with inherited statistics or SDK defaults.
		for (const request of snapshot?.requestRecords ?? []) for (const a of request.attempts) if (!seen.has(attemptKey(a))) rows.push({ ...a,
			sdkEntryIds: [], usage: { ...Object.fromEntries([...usageFields, "cacheReadFraction"].map(f => [f, missing("incomplete", "missing-execution-usage")])),
				providerMapping: "native-openai-codex-responses", sdkCrossCheck: { status: "unjoined", fields: [] } } as unknown as NormalizedUsage });
		return { group, owner, probeId, snapshot, rows, requests: snapshot?.requestRecords ?? [], phases: group.taskRecords.filter(r => sameOwner(r, owner)), preparationActiveMs: active, probeTaskMs: probe };
	}
	const missingSources = [...new Map(group.taskRecords.filter(r => r.forkId === null && !group.sources[r.arm]).map(r => [ownerKey(r), r])).values()];
	return [...Object.values(group.sources).filter((s): s is ArmSnapshot => !!s).map(s => unit(s.owner, s, null, group.preparationActiveMs[s.arm], derived(0))),
		...missingSources.map(r => unit(r, null, null, group.preparationActiveMs[r.arm], derived(0))),
		...group.forks.map(f => unit(f.owner, f.snapshot, f.probe.id, derived(0), f.probeTaskMs))];
}

/** Reduce actual executions only; nested response, tool and compaction intervals are explanatory subtotals. */
export function summarizeMetrics(manifest: RunManifest, groups: readonly StageGroupResult[], runTiming?: TimedOperation): RunMetricsSummary {
	if (new Set(groups.map(g => JSON.stringify([g.stage, g.seed]))).size !== groups.length) throw new Error("Repeated metric stage group");
	const model = manifest.modelMetadata as unknown as Model<Api> | null;
	const pricing = model ? describePricing(model) : null, units = groups.flatMap(g => unitsFor(manifest, g));
	function scope(kind: MetricScope["scope"], selected: Unit[], stage: Stage | null = null, seed: string | null = null, arm: Arm | null = null, probeId: string | null = null): MetricScope {
		const rows = selected.flatMap(u => u.rows), requests = selected.flatMap(u => u.requests), attempts = requests.flatMap(r => r.attempts);
		const phases = [...new Map(selected.flatMap(u => u.phases).map(r => [r.operationId, r])).values()];
		const usage = Object.fromEntries(usageFields.map(f => [f, sumMeasurements(rows.map(r => r.usage[f]))])) as UsageMetrics;
		usage.cacheReadFraction = ratioMeasurement(usage.cacheReadTokens, usage.totalInputTokens);
		const priced = rows.map(r => model && pricing ? priceAttempt(r.usage, model, pricing) : Object.fromEntries(costFields.map(f => [f, missing("incomplete", "missing-catalog-prices")])) as CostMeasurements);
		const cost = Object.fromEntries(costFields.map(f => [f, sumMeasurements(priced.map(c => c[f]))])) as CostMetrics;
		cost.actualCostUsd = { ...cost.actualCostUsd, value: null, status: "not-reported", reason: "no-attributable-billing-source" };
		const selectedGroups = [...new Set(selected.map(u => u.group))];
		const preparationActiveMs = sumMeasurements(selected.filter(u => u.probeId === null).map(u => u.preparationActiveMs));
		const probeTaskMs = sumMeasurements(selected.filter(u => u.probeId !== null).map(u => u.probeTaskMs));
		const compactions = phases.filter(r => r.phase === "compaction"), tools: Record<string, number> = {};
		for (const row of phases.filter(r => r.phase === "tool")) tools[row.toolName ?? "unrecorded"] = (tools[row.toolName ?? "unrecorded"] ?? 0) + 1;
		const responses = Object.fromEntries((["conversation", "compaction"] as const).map(purpose => {
			const selectedRequests = requests.filter(r => r.purpose === purpose), selectedAttempts = selectedRequests.flatMap(r => r.attempts);
			return [purpose, { request: summarizeDurations(selectedRequests.map(r => ({ ...r.timing, durationMs: r.requestWallMs }))),
				attempt: summarizeDurations(selectedAttempts.map(a => ({ ...a.timing, durationMs: a.attemptWallMs }))),
				...Object.fromEntries((["responseHeadersMs", "timeToFirstModelDeltaMs", "timeToFirstTextMs"] as const).map(f => [f, sumMeasurements(selectedAttempts.map(a => a[f]))])) }];
		})) as MetricScope["responses"];
		return { scope: kind, stage, seed, arm, probeId, sampleCount: selectedGroups.length, executionCount: selected.length,
			complete: selected.length > 0 && selectedGroups.every(g => g.status === "complete"), usage, cost, preparationActiveMs, probeTaskMs,
			armActiveMs: sumMeasurements([...selected.filter(u => u.probeId === null).map(u => u.preparationActiveMs), ...selected.filter(u => u.probeId !== null).map(u => u.probeTaskMs)]),
			promptTaskMs: sumMeasurements(phases.filter(r => r.phase === "prompt").map(r => r.timing.durationMs)),
			stageGroupWallMs: sumMeasurements(selectedGroups.map(g => g.groupWallMs)), runWallMs: runTiming?.durationMs ?? missing("incomplete", "operation-active"),
			counts: { requests: requests.length, attempts: attempts.length, retries: requests.reduce((n, r) => n + Math.max(0, r.attempts.length - 1), 0),
				providerErrors: attempts.filter(a => a.timing.status === "failed").length, compactionAttempts: compactions.length,
				compactionSuccesses: compactions.filter(c => c.timing.status === "succeeded").length, compactionFailures: compactions.filter(c => c.timing.status === "failed").length,
				compactionCancellations: compactions.filter(c => ["canceled", "aborted"].includes(c.timing.status)).length, tools }, responses,
			phases: Object.fromEntries([...new Set(phases.map(r => r.phase))].map(phase => [phase, summarizeDurations(phases.filter(r => r.phase === phase).map(r => r.timing))])) };
	}
	const preparation: MetricScope[] = [], probes: MetricScope[] = [], arms: MetricScope[] = [], stageGroups: MetricScope[] = [];
	for (const group of groups) {
		const selected = units.filter(u => u.group === group); stageGroups.push(scope("stage-group", selected, group.stage, group.seed));
		for (const arm of ["baseline", "paging"] as const) {
			const owned = selected.filter(u => u.owner.arm === arm); arms.push(scope("arm", owned, group.stage, group.seed, arm));
			preparation.push(scope("preparation", owned.filter(u => u.probeId === null), group.stage, group.seed, arm));
			for (const unit of owned.filter(u => u.probeId !== null)) probes.push(scope("probe", [unit], group.stage, group.seed, arm, unit.probeId));
		}
	}
	const paired: PairedMetrics[] = [];
	for (const scopes of [preparation, probes, arms]) for (const baseline of scopes.filter(s => s.arm === "baseline")) {
		const paging = scopes.find(s => s.arm === "paging" && s.stage === baseline.stage && s.seed === baseline.seed && s.probeId === baseline.probeId);
		if (!paging) continue;
		const compare = (a: Measurement<number>, b: Measurement<number>) => baseline.complete && paging.complete ? pairedMeasurement(a, b) : missing<number>("incomplete", "non-comparable-executions");
		paired.push({ scope: baseline.scope as PairedMetrics["scope"], stage: baseline.stage, seed: baseline.seed, probeId: baseline.probeId,
			usage: Object.fromEntries([...usageFields, "cacheReadFraction"].map(f => [f, compare(paging.usage[f as keyof UsageMetrics], baseline.usage[f as keyof UsageMetrics])])) as PairedMetrics["usage"],
			cost: Object.fromEntries(costFields.map(f => [f, compare(paging.cost[f], baseline.cost[f])])) as PairedMetrics["cost"],
			...Object.fromEntries((["preparationActiveMs", "promptTaskMs", "probeTaskMs", "armActiveMs"] as const).map(f => [f, compare(paging[f], baseline[f])])) as Pick<PairedMetrics, "preparationActiveMs" | "promptTaskMs" | "probeTaskMs" | "armActiveMs">,
			attempts: compare(derived(paging.counts.attempts), derived(baseline.counts.attempts)) });
	}
	return { pricing, preparation, probes, arms, stageGroups, stages: (["A", "B"] as const).map(stage => scope("stage", units.filter(u => u.owner.stage === stage), stage)), run: scope("run", units), paired };
}
