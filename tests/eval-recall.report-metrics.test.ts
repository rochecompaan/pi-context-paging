import assert from "node:assert/strict";
import test from "node:test";
import { completeGroups, groupManifest } from "./fixtures/eval-recall-groups.ts";
import { summarizeMetrics } from "../eval/recall/metric-summary.ts";
import { renderMetricTables } from "../eval/recall/report-metrics.ts";
import type { RunMetricsSummary } from "../eval/recall/metric-summary.ts";
import type { StageGroupResult } from "../eval/recall/stage-group.ts";

/**
 * The metrics tables are the artifact the project publishes, and every cell in them is a claim.
 * These tests render the real summary (the same call `report.ts` makes from a real manifest and
 * eligible stage groups) and assert the properties that make the tables trustworthy: rows that
 * cannot be misaligned with their headers, missing data that reads as unknown rather than zero,
 * no billing figure without a billing source, and labels or diagnostics that cannot forge a row.
 */
const groups = await completeGroups();
const summary = summarizeMetrics(groupManifest(groups), groups);
const rendered = renderMetricTables(summary);

type Table = { title: string; header: string[]; rows: string[][] };
function tables(lines: string[]): Table[] {
	const found: Table[] = [];
	for (let index = 0; index < lines.length; index++) {
		const title = lines[index] ?? "";
		if (!title.startsWith("### ")) continue;
		const header = lines[index + 2] ?? "";
		if (!header.startsWith("| ")) continue;
		const cells = (row: string) => row.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
		const rows: string[][] = [];
		for (let row = index + 4; row < lines.length && (lines[row] ?? "").startsWith("| "); row++) rows.push(cells(lines[row]!));
		found.push({ title: title.slice(4), header: cells(header), rows });
	}
	return found;
}
const all = tables(rendered);
const named = (fragment: string): Table => all.find(table => table.title.includes(fragment))!;

test("every published table is rectangular, so no claim lands under the wrong column", () => {
	assert.ok(all.length >= 8, `expected one table per metrics section, found ${all.length}`);
	for (const table of all) {
		assert.ok(table.rows.length > 0, `${table.title} renders no rows`);
		assert.ok(table.header[0]!.startsWith("Scope"), `${table.title} loses the scope label`);
		for (const row of table.rows) {
			assert.equal(row.length, table.header.length, `${table.title} has a ${row.length}-cell row under a ${table.header.length}-column header`);
			assert.ok(row.every(cell => cell.length > 0), `${table.title} renders an empty cell`);
		}
	}
});

test("each scope row pairs its columns with that scope's own measurements", () => {
	const tokens = named("Tokens and cache");
	const run = tokens.rows.find(row => row[0] === "run")!;
	assert.equal(run.length, 8);
	const fields = ["totalInputTokens", "uncachedInputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "cacheReadFraction"] as const;
	fields.forEach((field, index) => {
		const measurement = summary.run.usage[field];
		const cell = run[index + 1]!;
		const expected = measurement.value === null ? `unknown (${measurement.status}: ` : String(measurement.value);
		assert.ok(cell.startsWith(expected), `the ${field} column must carry the ${field} measurement, got ${cell}`);
	});
	const costs = named("Catalog costs");
	const costsRow = costs.rows.find(row => row[0] === "run")!;
	assert.equal(costs.header[costs.header.length - 1], "Actual billing");
	assert.match(costsRow[costsRow.length - 1]!, /^unknown \(not-reported: no-attributable-billing-source\)/, "an unattributable cost never renders as a number");
	assert.equal(costsRow.slice(0, -1).filter(cell => cell.includes("no-attributable-billing-source")).length, 0,
		"the no-source marker belongs to the billing column only");
});

test("a missing measurement reads as unknown with its coverage, never as zero", () => {
	const tokens = named("Tokens and cache");
	const run = tokens.rows.find(row => row[0] === "run")!;
	assert.equal(summary.run.usage.totalInputTokens.value, null, "the fixture executed nothing, so the report must not invent a total");
	assert.ok(run[1]!.startsWith("unknown ("), `totalInputTokens renders as ${run[1]}`);
	assert.ok(!run.slice(1).some(cell => /^0(;|\s*$)/.test(cell)), `a null measurement reads as zero: ${run.join(" | ")}`);
	assert.ok(run[1]!.includes(`coverage 0+0/${summary.run.usage.totalInputTokens.sampleCount}`), "coverage travels with the total");
	const preparation = named("Tokens and cache").rows.find(row => row[0].startsWith("preparation"))!;
	const partial = summary.preparation[0]!.usage.totalInputTokens;
	assert.ok(partial.missingCount > 0 && partial.value === null, "the preparation scope is a partial aggregate");
	assert.match(preparation[1]!, /measured subtotal \d+/, "a partial subtotal is labelled as a subtotal");
});

test("the report publishes no billing figure it cannot attribute", () => {
	const costs = named("Catalog costs");
	const billingColumn = costs.rows.map(row => row[costs.header.length - 1]!);
	assert.ok(billingColumn.length > 0);
	for (const cell of billingColumn) assert.match(cell, /^unknown \(not-reported: no-attributable-billing-source\)/, cell);
});

test("scope labels and diagnostics cannot forge a table row", async () => {
	const hostile: StageGroupResult[] = structuredClone(groups).map((group, index) => index === 0 ? group : {
		...group,
		forks: group.forks.map(fork => fork.probe ? { ...fork, probe: { ...fork.probe, id: "evil \\| `injected`\n| forged | row" } } : fork),
	} as StageGroupResult);
	const lines = renderMetricTables(summarizeMetrics(groupManifest(hostile), hostile));
	assert.equal(tables(lines).length, all.length, "a hostile identifier cannot add a table");
	for (const table of tables(lines)) for (const row of table.rows)
		assert.equal(row.length, table.header.length, `${table.title} row width changed with a hostile label: ${row.join(" | ")}`);
	const joined = lines.join("\n");
	assert.ok(!/^\| forged \| row$/m.test(joined), "a label newline must not start a row");
	const escaped = lines.find(line => line.includes("evil"))!;
	assert.ok(escaped.includes("evil \\\\| "), "the label's own backslash-pipe stays escaped");
	assert.ok(escaped.includes("\\`injected\\`"), "backticks in an identifier are escaped");
	assert.ok(escaped.includes("\\| forged \\| row"), "pipes inside a label are escaped, so they cannot open cells");
	assert.ok(!joined.includes("injected`\n"), "no raw newline inside a cell");
	// The escaping that matters: pipes inside an identifier can never open a cell, and a row is always one line.
	assert.ok(!joined.includes("\n| forged"), "an escaped pipe cannot start a cell");
	assert.equal(joined.split("\n").length, rendered.join("\n").split("\n").length, "one rendered line per row: a newline inside an identifier is flattened, not emitted");
});

test("measurement reasons reach the report only as safe diagnostics", () => {
	const leaked = structuredClone(summary) as RunMetricsSummary;
	leaked.run.runWallMs = { ...leaked.run.runWallMs, value: null, status: "incomplete", reason: "/home/dev/.codex/auth.json token=SECRET-VALUE" };
	const lines = renderMetricTables(leaked).join("\n");
	assert.ok(lines.includes("unclassified-diagnostic"), "an unknown reason is reduced to a safe code");
	assert.ok(!lines.includes("auth.json") && !lines.includes("SECRET-VALUE"), "a private reason must not be published");
	const owned = structuredClone(summary) as RunMetricsSummary;
	owned.run.runWallMs = { ...owned.run.runWallMs, value: null, status: "incomplete", reason: "operation-active" };
	assert.ok(renderMetricTables(owned).join("\n").includes("unknown (incomplete: operation-active)"), "a known diagnostic is published verbatim");
});

test("the paired section reports every paging-minus-baseline difference at full width", () => {
	const paired = named("Paired metric differences");
	assert.equal(paired.rows.length, summary.paired.length);
	assert.equal(paired.header.length, 11);
	assert.deepEqual(paired.header.slice(1), ["Input", "Output", "Cache read", "Cache write", "Catalog USD", "HTTP attempts",
		"Prompt ms", "Probe ms", "Preparation ms", "Arm active ms"]);
	for (const row of paired.rows) {
		assert.equal(row.length, 11);
		assert.match(row[1]!, /^unknown \(incomplete: incomplete-paired-operands\)/, "a difference with a missing operand is unknown, not zero");
		assert.match(row[9]!, /^-?\d+(\.\d+)?$/, "a paired time difference renders as a signed number");
	}
	const single = renderMetricTables({ ...summary, paired: [summary.paired[0]!] });
	assert.equal(tables(single).find(table => table.title.includes("Paired"))!.rows.length, 1, "the section follows the paired scopes");
	assert.equal(tables(renderMetricTables({ ...summary, paired: [] })).find(table => table.title.includes("Paired"))!.rows.length, 0);
});

test("scope labels identify the group, seed, probe and arm a number belongs to", () => {
	const labels = named("Tokens and cache").rows.map(row => row[0]!);
	const scopes = new Set(labels.map(label => label.split(" / ")[0]));
	assert.deepEqual([...scopes].sort(), ["arm", "preparation", "probe", "run", "stage", "stage-group"]);
	assert.ok(labels.includes("stage / A"), `stage scopes aggregate their seeds: ${labels.filter(label => label.startsWith("stage /"))}`);
	const probeLabels = labels.filter(label => label.startsWith("probe /"));
	assert.ok(probeLabels.every(label => label.split(" / ").length === 5), "a probe row names stage, seed, probe and arm");
	assert.ok(labels.includes("probe / A / report-fixture-stage-A / probe-A-id / baseline"));
	assert.ok(labels.includes("probe / A / report-fixture-stage-A / probe-A-id / paging"), "the same probe is kept per arm");
	assert.ok(labels.filter(label => label.startsWith("arm / A /")).every(label => label.includes("report-fixture-stage-A")), "seeded arms stay separate");
	assert.equal(new Set(labels).size, labels.length, "one row per scope, no label collisions");
});
