import assert from "node:assert/strict";
import test from "node:test";
import { buildManifest, experimentFingerprint, isEligiblePilot, renderReport, type RunManifest } from "../eval/recall/report.ts";
import { runPair, type PairResult } from "../eval/recall/pair.ts";
import { buildWorkload } from "../eval/recall/workload.ts";
import { defaultLimits } from "../eval/recall/request-guard.ts";
import { makeScriptedArm } from "./fixtures/eval-recall.ts";

async function completePair(): Promise<PairResult> {
	const workload = buildWorkload("report-fixture");
	return runPair({ seed: workload.seed, firstArm: "baseline", workload,
		createArm: async options => makeScriptedArm({ ...options, workload, beforeAttempt: options.requestGuard, order: [] }).instance });
}
function manifest(pair: PairResult, mode: "pilot" | "batch" = "pilot"): RunManifest {
	return buildManifest({ runId: `report-${mode}`, mode, sourceRevision: "a".repeat(40), sourceIntegrity: "clean-checkout-v1",
		sdkVersion: "0.87.1", nodeVersion: process.version, modelMetadata: pair.snapshots.baseline!.modelMetadata,
		limits: defaultLimits, seeds: [pair.seed], firstArms: [pair.firstArm] });
}

test("experiment fingerprints exclude run identity, seeds, order and measured results", async () => {
	const pair = await completePair();
	assert.equal(pair.status, "complete");
	const original = manifest(pair);
	assert.equal(experimentFingerprint(original), experimentFingerprint({ ...original, runId: "different", seeds: ["next"], firstArms: ["paging"] }));
	assert.equal(original.experimentHash, experimentFingerprint(original));
});

test("a structurally complete pilot with wrong model answers can authorize the batch", async () => {
	const pair = await completePair();
	for (const probe of pair.probes) { probe.baseline.score.correct = false; probe.paging.score.correct = false; }
	assert.deepEqual(isEligiblePilot(manifest(pair), pair, manifest(pair, "batch")), { eligible: true, reason: null });
});

test("missing stages, unsupported traces, contamination and safety stops cannot qualify a pilot", async () => {
	const original = await completePair();
	for (const damage of [
		(pair: PairResult) => { pair.stages.A.valid = false; },
		(pair: PairResult) => { pair.stages.B.complete = false; },
		(pair: PairResult) => { pair.probes[0].paging.traceComplete = false; },
		(pair: PairResult) => { pair.snapshots.baseline!.requests[0].complete = false; },
		(pair: PairResult) => { pair.crossStageExposure.push("B-id"); },
		(pair: PairResult) => { pair.stopReason = "max-requests-per-arm"; },
		(pair: PairResult) => { pair.promptCounts.paging = 23; },
		(pair: PairResult) => { pair.errors.push({ code: "pair-error" }); },
	]) {
		const pair = structuredClone(original); damage(pair);
		assert.equal(isEligiblePilot(manifest(original), pair, manifest(original, "batch")).eligible, false);
	}
});

test("source evidence, SDK, Node, model metadata, thinking and settings bind pilot eligibility", async () => {
	const pair = await completePair(), pilot = manifest(pair);
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
		const next = structuredClone(manifest(pair, "batch")); damage(next);
		next.experimentHash = experimentFingerprint(next);
		assert.equal(isEligiblePilot(pilot, pair, next).eligible, false);
	}
	for (const damage of [(p: RunManifest) => { p.sourceIntegrity = null; }, (p: RunManifest) => { p.modelMetadata = null; },
		(p: RunManifest) => { p.experimentHash = "f".repeat(64); }]) {
		const broken = structuredClone(pilot); damage(broken);
		assert.equal(isEligiblePilot(broken, pair, manifest(pair, "batch")).eligible, false);
	}
});

test("reports retain stage, category, revised-decision, qualification and paired-difference evidence", async () => {
	const pair = await completePair();
	for (const probe of pair.probes.filter(probe => probe.probe.factId)) probe.baseline.score.correct = false;
	const report = renderReport(manifest(pair), [pair]);
	for (const phrase of ["Stage A", "Stage B", "Known", "Unknown", "Qualified", "decision", "Revised decision", "Paired", "report-fixture", "+1.000", "Opaque reasoning", "Catalog estimates", "Compaction subtotal"]) {
		assert.ok(report.includes(phrase), `missing report evidence: ${phrase}`);
	}
	assert.ok(report.includes("5/5"));
	assert.ok(report.includes("0/5"));
});

test("incomplete or contaminated pairs are observations, not aggregate wins", async () => {
	const pair = await completePair(); pair.status = "inconclusive"; pair.stages.B.valid = false;
	pair.stages.B.reason = "cross-stage-exposure"; pair.crossStageExposure = ["B-id"];
	const report = renderReport(manifest(pair), [pair]);
	assert.ok(report.includes("cross-stage-exposure"));
	assert.ok(report.includes("Eligible pairs: 0/1"));
	assert.ok(report.includes("No winner"));
});
