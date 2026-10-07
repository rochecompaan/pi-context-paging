import type { Arm, Stage } from "./workload.ts";
import type { PairProbe } from "./pair-stages.ts";
import type { PairResult } from "./pair.ts";
import { completePair, verifiedManifest, type RunManifest } from "./manifest.ts";
import { aggregateUsage } from "./usage.ts";
export { buildManifest, experimentFingerprint, isEligiblePilot } from "./manifest.ts";
export type { ManifestInput, RunManifest } from "./manifest.ts";

const cell = (value: unknown) => String(value ?? "unknown").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
	.replace(/\|/g, "\\|").replace(/`/g, "\\`").replace(/[\r\n]/g, " ");
const measured = (value: number | null) => value === null ? "unknown" : String(value);
function fraction(probes: readonly PairProbe[], arm: Arm): string {
	return `${probes.filter(probe => probe[arm].score.correct).length}/${probes.length}`;
}
function difference(probes: readonly PairProbe[]): string {
	if (!probes.length) return "unknown";
	const delta = (probes.filter(probe => probe.paging.score.correct).length - probes.filter(probe => probe.baseline.score.correct).length) / probes.length;
	return `${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`;
}
function stageRows(pair: PairResult, stage: Stage): string[] {
	const observed = pair.stages[stage];
	const probes = observed.probes.filter(probe => probe.comparisonEligible);
	const known = probes.filter(probe => probe.probe.factId), unknown = probes.filter(probe => !probe.probe.factId);
	const qualified = known.filter(probe => probe.paging.evidence.qualified);
	const lines = [`### Stage ${stage}`, "", `Gate: ${observed.valid ? "valid" : "inconclusive"}. Reason: ${cell(observed.reason ?? "none")}.`, "",
		"| Arm | Known | Unknown | Qualified known | Recovery-attributed |",
		"| --- | --- | --- | --- | --- |",
		...(["baseline", "paging"] as const).map(arm => `| ${arm} | ${fraction(known, arm)} | ${fraction(unknown, arm)} | ${fraction(qualified, arm)} | ${qualified.filter(probe => probe[arm].evidence.recoverySuccess).length}/${qualified.length} |`),
		"", `Paired known difference (paging minus baseline): ${difference(known)}. Qualified difference: ${difference(qualified)}.`, "",
		"| Category | Baseline | Paging |", "| --- | --- | --- |"];
	for (const category of ["id", "path", "error", "quantity", "decision"]) {
		const selected = known.filter(probe => probe.probe.factId!.endsWith(`-${category}`));
		lines.push(`| ${category} | ${fraction(selected, "baseline")} | ${fraction(selected, "paging")} |`);
	}
	lines.push("", `Revised decision accuracy: baseline ${fraction(known.filter(probe => probe.probe.factId!.endsWith("-decision")), "baseline")}; paging ${fraction(known.filter(probe => probe.probe.factId!.endsWith("-decision")), "paging")}.`, "",
		"| Probe | Baseline visibility | Paging visibility | Qualified paging | Correct baseline / paging | Expected | Baseline answer | Paging answer |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const probe of observed.probes) lines.push(`| ${cell(probe.probe.id)}${probe.comparisonEligible ? "" : " (excluded)"} | ${cell(probe.baseline.evidence.visibility ?? "unrecorded control")} | ${cell(probe.paging.evidence.visibility ?? "unrecorded control")} | ${probe.paging.evidence.qualified} | ${probe.baseline.score.correct} / ${probe.paging.score.correct} | ${cell(JSON.stringify(probe.paging.score.expected))} | ${cell(JSON.stringify(probe.baseline.score.actual))} | ${cell(JSON.stringify(probe.paging.score.actual))} |`);
	lines.push("", "| Prompt | Baseline compactions before / after | First baseline request | First paging request |", "| --- | --- | --- | --- |");
	for (const timing of observed.timing) lines.push(`| ${cell(timing.promptId)} | ${timing.baselineCompactionsBefore} / ${timing.baselineCompactionsAfter} | ${cell(timing.baselineRequestId)} | ${cell(timing.pagingRequestId)} |`);
	return lines;
}
function usageRows(pair: PairResult): string[] {
	const lines = ["### Usage and latency", "", "Catalog estimates use the SDK cost calculation. Missing measurements remain unknown.",
		"Compaction subtotal is already included in each total. SDK session statistics are a separate recorded cross-check.", "",
		"| Arm | Input | Output | Cache read | Cache write | Catalog estimate | Compaction input subtotal | Compaction cost subtotal | Latency ms | HTTP attempts |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
	for (const arm of ["baseline", "paging"] as const) {
		const snapshot = pair.snapshots[arm];
		if (!snapshot) { lines.push(`| ${arm} | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown | ${pair.sentAttempts[arm]} |`); continue; }
		const usage = aggregateUsage(snapshot.usageLedger);
		const format = (value: number | null) => !usage.entries ? "unknown" : measured(value);
		lines.push(`| ${arm} | ${format(usage.inputTokens)} | ${format(usage.outputTokens)} | ${format(usage.cacheReadTokens)} | ${format(usage.cacheWriteTokens)} | ${format(usage.estimatedCost)} | ${format(usage.compaction.inputTokens)} | ${format(usage.compaction.estimatedCost)} | ${snapshot.latencyMs} | ${pair.sentAttempts[arm]} |`);
		if (!usage.entries) lines.push("", `${arm}: no usage ledger entries. Totals are unknown.`);
		if (usage.missing.length) {
			lines.push("", `Missing ${arm} usage:`, "", "| Entry | Request | Component | Reason |", "| --- | --- | --- | --- |");
			for (const missing of usage.missing) lines.push(`| ${cell(missing.entryId)} | ${cell(missing.requestId)} | ${missing.component} | ${missing.reason} |`);
		}
	}
	return lines;
}

/** Keep individual observations even when they cannot contribute to comparisons. */
export function renderReport(manifest: RunManifest, pairs: readonly PairResult[]): string {
	const eligible = pairs.filter(pair => verifiedManifest(manifest) && completePair(pair));
	const lines = ["# Full-budget recall evaluation", "", `Run: ${cell(manifest.runId)}. Source: ${cell(manifest.sourceRevision)}. Policy: ${cell(manifest.sourceIntegrity)}.`,
		`Model: ${cell(manifest.modelMetadata?.provider)}/${cell(manifest.modelMetadata?.id)}. Thinking: ${manifest.thinking}. Transport: ${manifest.transport}.`,
		`Native context window: ${cell(manifest.modelMetadata?.contextWindow)}. Paging budget: ${manifest.paging.tokenBudget}. Trim target: ${manifest.paging.trimToTokens}.`,
		`SDK: ${cell(manifest.sdkVersion)}. Node.js: ${cell(manifest.nodeVersion)}. Experiment: ${manifest.experimentHash}.`, "",
		"Stages A and B use independent conversations. No A probes run in the B conversations.",
		`Eligible pairs: ${eligible.length}/${pairs.length}. No winner is declared from incomplete or contaminated observations.`, "",
		"Opaque reasoning is not inspected. Plaintext absence does not prove that a fact is absent from opaque reasoning.",
		"Recovery attribution requires a matching successful history-tool result before a correct final answer.", "", "## Paired summaries", "",
		"| Stage | Eligible pairs | Baseline known | Paging known | Paired known difference | Qualified difference |", "| --- | --- | --- | --- | --- | --- |"];
	for (const stage of ["A", "B"] as const) {
		const selected = eligible.filter(pair => pair.stage === stage);
		const known = selected.flatMap(pair => pair.stages[stage].probes).filter(probe => probe.probe.factId && probe.comparisonEligible);
		lines.push(`| Stage ${stage} | ${selected.length} | ${fraction(known, "baseline")} | ${fraction(known, "paging")} | ${difference(known)} | ${difference(known.filter(probe => probe.paging.evidence.qualified))} |`);
	}
	for (const pair of pairs) {
		lines.push("", `## Pair ${cell(pair.seed)}`, "", `Status: ${pair.status}. Stage: ${pair.stage}. First arm: ${pair.firstArm}. Shared prompts: ${pair.steps.length}.`,
			`Stop reason: ${cell(pair.stopReason ?? "none")}. Errors: ${cell(pair.errors.map(error => error.code).join(", ") || "none")}.`,
			`Unused-stage facts returned (diagnostic only): ${cell(pair.crossStageExposure.join(", ") || "none")}.`, "", ...stageRows(pair, pair.stage), "", ...usageRows(pair));
	}
	return `${lines.join("\n")}\n`;
}
