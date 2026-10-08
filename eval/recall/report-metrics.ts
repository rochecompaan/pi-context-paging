import type { Measurement } from "./metrics.ts";
import type { AggregateMeasurement, DurationSummary } from "./metric-arithmetic.ts";
import type { MetricScope, RunMetricsSummary } from "./metric-summary.ts";
import { safeDiagnostic } from "./safe-diagnostics.ts";
const cell = (value: unknown) => String(value ?? "unknown").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
	.replace(/\|/g, "\\|").replace(/`/g, "\\`").replace(/[\r\n]/g, " ");
function metric(m: Measurement<number>): string {
	return m.value === null ? `unknown (${cell(m.status)}: ${cell(safeDiagnostic(m.reason))})` : String(m.value);
}
function aggregate(m: AggregateMeasurement): string {
	return `${metric(m)}; coverage ${m.observedCount}+${m.notApplicableCount}/${m.sampleCount}${m.missingCount ? `; measured subtotal ${m.measuredSubtotal}` : ""}`;
}
const label = (s: Pick<MetricScope, "scope" | "stage" | "seed" | "arm" | "probeId">) => cell([s.scope, s.stage, s.seed, s.probeId, s.arm].filter(Boolean).join(" / "));
function table(lines: string[], title: string, columns: string[], rows: string[][]) {
	lines.push("", `### ${title}`, "", `| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map(row => `| ${row.join(" | ")} |`));
}
function distribution(d: DurationSummary): string[] {
	return [aggregate(d.total), metric(d.mean), metric(d.median), `${metric(d.minimum)}..${metric(d.maximum)}`, String(d.sampleCount), cell(JSON.stringify(d.statusCounts))];
}
/** Render coverage beside totals; never label a partial subtotal as a complete price or duration. */
export function renderMetricTables(summary: RunMetricsSummary): string[] {
	const scopes = [...summary.preparation, ...summary.probes, ...summary.arms, ...summary.stageGroups, ...summary.stages, summary.run];
	const lines = ["", "## Execution metrics", "", "Each preparation is charged once. Forks contain only new execution usage; inherited SDK statistics are diagnostic cross-checks.",
		"Coverage is observed plus catalog-established non-applicable measurements over required samples. Unknown is not zero.",
		"Response, tool and compaction intervals are nested subtotals, not additions to prompt or probe wall time. Arm active time adds preparation and probe tasks only.",
		"A/B and seed groups remain separate. Six sibling forks are not six independent preparation samples.",
		"Catalog estimates use native SDK calculateCost and captured request-wide tier rates. They are not actual billing or savings claims.",
		`Pricing evidence: ${cell(JSON.stringify(summary.pricing))}.`,
		`Run wall ms: ${metric(summary.run.runWallMs)}. Its boundary precedes the bounded final record writes.`];
	table(lines, "Tokens and cache", ["Scope", "Input incl. cache", "Uncached input", "Output", "Reasoning", "Cache read", "Cache write", "Read fraction"], scopes.map(s =>
		[label(s), ...(["totalInputTokens", "uncachedInputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "cacheReadFraction"] as const).map(f => aggregate(s.usage[f]))]));
	table(lines, "Catalog costs (USD)", ["Scope", "Uncached input", "Output", "Cache read", "Cache write", "Known component subtotal", "Complete estimate", "Actual billing"], scopes.map(s =>
		[label(s), ...(["uncachedInputCostUsd", "outputCostUsd", "cacheReadCostUsd", "cacheWriteCostUsd", "knownCostSubtotalUsd", "estimatedCostUsd", "actualCostUsd"] as const).map(f => aggregate(s.cost[f]))]));
	table(lines, "Host task time (ms)", ["Scope", "Preparation active", "Prompt task", "Probe task", "Arm active", "Group wall"], scopes.map(s =>
		[label(s), ...(["preparationActiveMs", "promptTaskMs", "probeTaskMs", "armActiveMs", "stageGroupWallMs"] as const).map(f => aggregate(s[f]))]));
	table(lines, "Dispatch and native operation counts", ["Scope", "Logical requests", "HTTP attempts", "Retries", "Provider errors", "Compaction attempts / success / failed / canceled", "Tools by name", "Preparation samples"], scopes.map(s =>
		[label(s), String(s.counts.requests), String(s.counts.attempts), String(s.counts.retries), String(s.counts.providerErrors),
			[s.counts.compactionAttempts, s.counts.compactionSuccesses, s.counts.compactionFailures, s.counts.compactionCancellations].join(" / "), cell(JSON.stringify(s.counts.tools)), String(s.sampleCount)]));
	const distributions = [...summary.arms, ...summary.stageGroups, ...summary.stages, summary.run];
	table(lines, "Response time distributions (ms)", ["Scope / purpose / kind", "Total", "Mean", "Median", "Range", "Samples", "Terminal statuses"], distributions.flatMap(s =>
		(["conversation", "compaction"] as const).flatMap(p => (["request", "attempt"] as const).flatMap(kind => [
			[`${label(s)} / ${p} / ${kind}`, ...distribution(s.responses[p][kind])],
			[`${label(s)} / ${p} / ${kind} successful only`, aggregate(s.responses[p][kind].successful.total), metric(s.responses[p][kind].successful.mean), metric(s.responses[p][kind].successful.median),
				`${metric(s.responses[p][kind].successful.minimum)}..${metric(s.responses[p][kind].successful.maximum)}`, String(s.responses[p][kind].statusCounts.succeeded), "succeeded"]]))));
	table(lines, "Response boundaries (ms, attempt sums)", ["Scope / purpose", "Headers", "First model delta", "First text"], distributions.flatMap(s =>
		(["conversation", "compaction"] as const).map(p => [`${label(s)} / ${p}`, aggregate(s.responses[p].responseHeadersMs), aggregate(s.responses[p].timeToFirstModelDeltaMs), aggregate(s.responses[p].timeToFirstTextMs)])));
	table(lines, "Host phase distributions (nested, ms)", ["Scope / phase", "Total", "Mean", "Median", "Range", "Samples", "Terminal statuses"], summary.arms.flatMap(s =>
		Object.entries(s.phases).map(([phase, d]) => [`${label(s)} / ${cell(phase)}`, ...distribution(d!)])));
	table(lines, "Paired metric differences (paging minus baseline)", ["Scope", "Input", "Output", "Cache read", "Cache write", "Catalog USD", "HTTP attempts", "Prompt ms", "Probe ms", "Preparation ms", "Arm active ms"], summary.paired.map(s =>
		[label({ ...s, arm: null }), metric(s.usage.totalInputTokens), metric(s.usage.outputTokens), metric(s.usage.cacheReadTokens), metric(s.usage.cacheWriteTokens), metric(s.cost.estimatedCostUsd), metric(s.attempts),
			metric(s.promptTaskMs), metric(s.probeTaskMs), metric(s.preparationActiveMs), metric(s.armActiveMs)]));
	return lines;
}
