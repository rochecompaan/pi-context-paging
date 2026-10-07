import assert from "node:assert/strict";
import test from "node:test";
import { buildManifest, experimentFingerprint, isEligiblePilot, renderReport, type RunManifest } from "../eval/recall/report.ts";
import { completePair as structurallyComplete } from "../eval/recall/manifest.ts";
import { runPair, type PairResult } from "../eval/recall/pair.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { defaultLimits } from "../eval/recall/request-guard.ts";
import { makeScriptedArm } from "./fixtures/eval-recall.ts";

async function completePilot(): Promise<PairResult[]> {
	const pairs: PairResult[] = [];
	for (const stage of ["A", "B"] as const) {
		const workload = buildWorkload(`report-fixture-stage-${stage}`);
		pairs.push(await runPair({ seed: workload.seed, stage, firstArm: "baseline", workload,
			createArm: async options => makeScriptedArm({ ...options, workload, beforeAttempt: options.requestGuard, order: [] }).instance }));
	}
	return pairs;
}
function manifest(pairs: readonly PairResult[], mode: "pilot" | "batch" = "pilot"): RunManifest {
	return buildManifest({ runId: `report-${mode}`, mode, sourceRevision: "a".repeat(40), sourceIntegrity: "clean-checkout-v1",
		sdkVersion: "0.87.1", nodeVersion: process.version, modelMetadata: pairs[0].snapshots.baseline!.modelMetadata,
		limits: defaultLimits, seeds: pairs.map(pair => pair.seed), stages: pairs.map(pair => pair.stage), firstArms: pairs.map(pair => pair.firstArm) });
}

test("experiment fingerprints exclude run identity, seeds, order and measured results", async () => {
	const pairs = await completePilot();
	assert.ok(pairs.every(pair => pair.status === "complete"));
	const original = manifest(pairs);
	assert.equal(experimentFingerprint(original), experimentFingerprint({ ...original, runId: "different", seeds: ["next-A", "next-B"], firstArms: ["paging", "baseline"] }));
	assert.equal(original.experimentHash, experimentFingerprint(original));
});

test("two structurally complete stage pairs with wrong answers can authorize the batch", async () => {
	const pairs = await completePilot();
	for (const pair of pairs) for (const probe of pair.probes) { probe.baseline.score.correct = false; probe.paging.score.correct = false; }
	assert.deepEqual(isEligiblePilot(manifest(pairs), pairs, manifest(pairs, "batch")), { eligible: true, reason: null });
});

test("a missing stage, repeated stage or legacy combined conversation cannot authorize a batch", async () => {
	const pairs = await completePilot(), pilot = manifest(pairs), next = manifest(pairs, "batch");
	assert.equal(isEligiblePilot(pilot, pairs.slice(0, 1), next).eligible, false);
	assert.equal(isEligiblePilot(pilot, [pairs[0], pairs[0]], next).eligible, false);
	const legacy = structuredClone(pilot); (legacy as unknown as { schemaVersion: number }).schemaVersion = 1;
	legacy.experimentHash = experimentFingerprint(legacy);
	assert.equal(isEligiblePilot(legacy, pairs, next).eligible, false);
	const mixed = structuredClone(pairs[1]);
	mixed.steps.unshift(pairs[0].probes[0].probe.step);
	mixed.promptCounts.baseline++; mixed.promptCounts.paging++;
	mixed.snapshots.baseline!.promptCount++; mixed.snapshots.paging!.promptCount++;
	assert.equal(structurallyComplete(mixed), false);
});

test("unused-stage exposure in A is diagnostic and does not contaminate fresh B sessions", async () => {
	const pairs = await completePilot(); pairs[0].crossStageExposure.push("B-id");
	assert.deepEqual(isEligiblePilot(manifest(pairs), pairs, manifest(pairs, "batch")), { eligible: true, reason: null });
});

test("unsupported traces, failed stage gates and safety stops cannot qualify a pilot", async () => {
	const original = await completePilot();
	for (const damage of [
		(pairs: PairResult[]) => { pairs[0].stages.A.valid = false; },
		(pairs: PairResult[]) => { pairs[1].stages.B.complete = false; },
		(pairs: PairResult[]) => { pairs[0].probes[0].paging.traceComplete = false; },
		(pairs: PairResult[]) => { pairs[1].snapshots.baseline!.requests[0].complete = false; },
		(pairs: PairResult[]) => { pairs[1].crossStageExposure.push("B-id"); },
		(pairs: PairResult[]) => { pairs[0].stopReason = "max-requests-per-arm"; },
		(pairs: PairResult[]) => { pairs[1].promptCounts.paging = 23; },
		(pairs: PairResult[]) => { pairs[0].errors.push({ code: "pair-error" }); },
	]) {
		const pairs = structuredClone(original); damage(pairs);
		assert.equal(isEligiblePilot(manifest(original), pairs, manifest(original, "batch")).eligible, false);
	}
});

test("source evidence, SDK, Node, model metadata, thinking and settings bind pilot eligibility", async () => {
	const pairs = await completePilot(), pilot = manifest(pairs);
	for (const damage of [
		(next: RunManifest) => { next.sourceRevision = "b".repeat(40); },
		(next: RunManifest) => { next.sourceIntegrity = null; },
		(next: RunManifest) => { next.sourceRevision = "main"; },
		(next: RunManifest) => { next.sdkVersion = "0.87.2"; },
		(next: RunManifest) => { next.nodeVersion = "v99.0.0"; },
		(next: RunManifest) => { next.modelMetadata!.contextWindow += 1; },
		(next: RunManifest) => { next.thinking = "high" as RunManifest["thinking"]; },
		(next: RunManifest) => { next.paging.tokenBudget += 1; },
		(next: RunManifest) => { next.limits.maxRequestsPerArm += 1; },
	]) {
		const next = structuredClone(manifest(pairs, "batch")); damage(next);
		next.experimentHash = experimentFingerprint(next);
		assert.equal(isEligiblePilot(pilot, pairs, next).eligible, false);
	}
	for (const damage of [(p: RunManifest) => { p.sourceIntegrity = null; }, (p: RunManifest) => { p.modelMetadata = null; },
		(p: RunManifest) => { p.experimentHash = "f".repeat(64); }]) {
		const broken = structuredClone(pilot); damage(broken);
		assert.equal(isEligiblePilot(broken, pairs, manifest(pairs, "batch")).eligible, false);
	}
});

test("reports count stage pairs separately and retain category, qualification, differences and usage", async () => {
	const pairs = await completePilot();
	for (const pair of pairs) for (const probe of pair.probes.filter(probe => probe.probe.factId)) probe.baseline.score.correct = false;
	const report = renderReport(manifest(pairs), pairs);
	for (const phrase of ["Stage A", "Stage B", "Known", "Unknown", "Qualified", "decision", "Revised decision", "Paired", "report-fixture", "+1.000", "Opaque reasoning", "Catalog estimates", "Compaction subtotal"]) {
		assert.ok(report.includes(phrase), `missing report evidence: ${phrase}`);
	}
	assert.ok(report.includes("5/5")); assert.ok(report.includes("0/5"));
	assert.ok(report.includes("| Stage A | 1 |")); assert.ok(report.includes("| Stage B | 1 |"));
});

test("an inconclusive B observation does not suppress an eligible independent A pair", async () => {
	const pairs = await completePilot(); pairs[1].status = "inconclusive"; pairs[1].stages.B.valid = false;
	pairs[1].stages.B.reason = "baseline-source-still-resident";
	const report = renderReport(manifest(pairs), pairs);
	assert.ok(report.includes("baseline-source-still-resident"));
	assert.ok(report.includes("Eligible pairs: 1/2"));
	assert.ok(report.includes("| Stage A | 1 |")); assert.ok(report.includes("| Stage B | 0 |"));
	assert.ok(report.includes("No winner"));
});
