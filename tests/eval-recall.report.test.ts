import assert from "node:assert/strict";
import test from "node:test";
import { experimentFingerprint, isEligiblePilot, renderReport, type RunManifest } from "../eval/recall/report.ts";
import { completeStageGroup } from "../eval/recall/manifest.ts";
import { completeGroups, groupManifest } from "./fixtures/eval-recall-groups.ts";

test("experiment fingerprints exclude run identity, seeds, order and measured results", async () => {
	const groups = await completeGroups(), original = groupManifest(groups);
	assert.equal(experimentFingerprint(original), experimentFingerprint({ ...original, runId: "different", seeds: ["next-A", "next-B"], firstArms: ["paging", "baseline"] }));
	assert.equal(original.experimentHash, experimentFingerprint(original));
});
test("two structurally complete isolated stage groups can authorize a batch despite wrong answers", async () => {
	const groups = await completeGroups(); for (const group of groups) for (const probe of group.probes) { probe.baseline.score.correct = false; probe.paging.score.correct = false; }
	assert.deepEqual(isEligiblePilot(groupManifest(groups), groups, groupManifest(groups, "batch")), { eligible: true, reason: null });
});
test("missing, repeated, legacy or mixed stages cannot authorize an isolated batch", async () => {
	const groups = await completeGroups(), pilot = groupManifest(groups), next = groupManifest(groups, "batch");
	assert.equal(isEligiblePilot(pilot, groups.slice(0, 1), next).eligible, false);
	assert.equal(isEligiblePilot(pilot, [groups[0], groups[0]], next).eligible, false);
	const legacy = structuredClone(pilot); (legacy as unknown as { schemaVersion: number }).schemaVersion = 1; legacy.experimentHash = experimentFingerprint(legacy);
	assert.equal(isEligiblePilot(legacy, groups, next).eligible, false);
	const mixed = structuredClone(groups[1]); mixed.steps.unshift(groups[0].probes[0].probe.step);
	assert.equal(completeStageGroup(mixed), false);
});
test("unsupported traces, failed gates and safety stops cannot qualify a pilot", async () => {
	const original = await completeGroups();
	for (const kind of ["gate", "incomplete", "trace", "request", "safety", "count", "error"] as const) {
		const groups = structuredClone(original);
		if (kind === "gate") groups[0].stageEvidence.valid = false;
		if (kind === "incomplete") groups[1].stageEvidence.complete = false;
		if (kind === "trace") groups[0].probes[0].paging.traceComplete = false;
		if (kind === "request") groups[1].sources.baseline!.requests[0].complete = false;
		if (kind === "safety") groups[0].stopReason = "max-requests-per-arm";
		if (kind === "count") groups[1].promptCounts.paging = 23;
		if (kind === "error") groups[0].errors.push({ code: "stage-group-error" });
		assert.equal(isEligiblePilot(groupManifest(original), groups, groupManifest(original, "batch")).eligible, false, kind);
	}
});
test("source, runtime, native metadata, restoration and pricing evidence bind pilot eligibility", async () => {
	const groups = await completeGroups(), pilot = groupManifest(groups);
	for (const damage of [
		(m: RunManifest) => { m.sourceRevision = "b".repeat(40); }, (m: RunManifest) => { m.sourceIntegrity = null; },
		(m: RunManifest) => { m.sourceRevision = "main"; }, (m: RunManifest) => { m.sdkVersion = "0.87.2"; },
		(m: RunManifest) => { m.nodeVersion = "v99.0.0"; }, (m: RunManifest) => { m.modelMetadata!.contextWindow++; },
		(m: RunManifest) => { m.thinking = "high" as RunManifest["thinking"]; }, (m: RunManifest) => { m.paging.tokenBudget++; },
		(m: RunManifest) => { m.limits.maxRequestsPerArm++; }, (m: RunManifest) => { m.restorationMethods.paging = "other" as RunManifest["restorationMethods"]["paging"]; },
		(m: RunManifest) => { m.pricingEvidence.calculator = "other" as RunManifest["pricingEvidence"]["calculator"]; },
	]) {
		const next = structuredClone(groupManifest(groups, "batch")); damage(next); next.experimentHash = experimentFingerprint(next);
		assert.equal(isEligiblePilot(pilot, groups, next).eligible, false);
	}
});
test("reports retain category scores, qualification and paired differences for independent groups", async () => {
	const groups = await completeGroups(); for (const g of groups) for (const p of g.probes.filter(p => p.probe.factId)) p.baseline.score.correct = false;
	const report = renderReport(groupManifest(groups), groups);
	for (const phrase of ["Stage A", "Stage B", "Known", "Unknown", "Qualified", "decision", "Revised decision", "Paired", "report-fixture", "+1.000", "Opaque reasoning"]) assert.ok(report.includes(phrase), phrase);
	assert.ok(report.includes("5/5")); assert.ok(report.includes("0/5")); assert.ok(report.includes("| Stage A | 1 |")); assert.ok(report.includes("| Stage B | 1 |"));
});
test("inconclusive B does not suppress an eligible independent A group", async () => {
	const groups = await completeGroups(); groups[1].status = "inconclusive"; groups[1].stageEvidence.valid = false;
	groups[1].stageEvidence.reason = "baseline-source-still-resident";
	const report = renderReport(groupManifest(groups), groups);
	assert.ok(report.includes("baseline-source-still-resident")); assert.ok(report.includes("Eligible stage groups: 1/2"));
	assert.ok(report.includes("| Stage A | 1 |")); assert.ok(report.includes("| Stage B | 0 |")); assert.ok(report.includes("No winner"));
});
test("isolated metric tables show execution scopes and unknown data rather than inherited session totals", async () => {
	const groups = await completeGroups(); for (const group of groups) for (const source of Object.values(group.sources)) source!.statsCrossCheck.tokens.input = 999999;
	const report = renderReport(groupManifest(groups), groups);
	assert.ok(report.includes("Tokens and cache")); assert.ok(report.includes("Catalog costs")); assert.ok(report.includes("Paired metric differences"));
	assert.ok(report.includes("preparation")); assert.ok(report.includes("probe-A-id")); assert.ok(report.includes("arm"));
	assert.ok(report.includes("unknown")); assert.ok(!/\| 999999(?:;| \|)/.test(report));
});
