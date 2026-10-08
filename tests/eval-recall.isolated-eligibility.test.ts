import assert from "node:assert/strict";
import test from "node:test";
import { completeStageGroup, experimentFingerprint, isEligiblePilot } from "../eval/recall/manifest.ts";
import type { StageGroupResult } from "../eval/recall/stage-group.ts";
import type { ArmSnapshot } from "../eval/recall/pi-arm.ts";
import { completeGroups, groupManifest } from "./fixtures/eval-recall-groups.ts";

test("isolated wrong answers and explicitly missing optional provider measurements remain eligible", async () => {
	const groups = await completeGroups();
	for (const group of groups) for (const probe of group.probes) { probe.baseline.score.correct = false; probe.paging.score.correct = false; }
	assert.ok(groups.every(completeStageGroup));
	assert.deepEqual(isEligiblePilot(groupManifest(groups), groups, groupManifest(groups, "batch")), { eligible: true, reason: null });
});

test("lost mandatory response observations block source and fork pilot eligibility", async t => {
	const original = await completeGroups();
	const damage: [string, (snapshot: ArmSnapshot) => void][] = [
		["observer incomplete", s => { s.requestRecords[0].attempts[0].observationComplete = false; }],
		["observer failure", s => { s.requestRecords[0].attempts[0].failureCode = "stream-buffer-limit"; }],
		["invalid model latency", s => { s.requestRecords[0].attempts[0].timeToFirstModelDeltaMs = { value: null, status: "invalid", reason: "non-monotonic-clock" }; }],
		["incomplete text latency", s => { s.requestRecords[0].attempts[0].timeToFirstTextMs = { value: null, status: "incomplete", reason: "stream-active" }; }],
		["lost headers", s => { s.requestRecords[0].attempts[0].responseHeadersMs = { value: null, status: "not-reported", reason: "no-response-headers" }; }],
		["lost attempt end", s => { s.requestRecords[0].attempts[0].timing.endMs = null; }],
		["censored attempt", s => { s.requestRecords[0].attempts[0].timing.status = "censored"; }],
		["lost request end", s => { s.requestRecords[0].timing.endMs = null; }],
	];
	for (const target of ["source", "fork"] as const) for (const [name, corrupt] of damage) await t.test(`${target}: ${name}`, () => {
		const groups = structuredClone(original), group = groups[0];
		corrupt(target === "source" ? group.sources.baseline! : group.forks[0].snapshot!);
		assert.equal(completeStageGroup(group), false);
		assert.equal(isEligiblePilot(groupManifest(original), groups, groupManifest(original, "batch")).eligible, false);
	});
});

test("legacy schemas cannot authorize isolated batches", async () => {
	const groups = await completeGroups();
	for (const version of [1, 2]) {
		const pilot = groupManifest(groups); (pilot as unknown as { schemaVersion: number }).schemaVersion = version;
		pilot.experimentHash = experimentFingerprint(pilot);
		assert.equal(isEligiblePilot(pilot, groups, groupManifest(groups, "batch")).eligible, false);
	}
});

test("restoration, payload ownership and required host boundaries are structural completion gates", async () => {
	const original = await completeGroups();
	for (const damage of [
		(g: StageGroupResult) => { g.forks[0].restoration = null; },
		(g: StageGroupResult) => { g.forks[1].restoration!.method = "baseline-native-history-v1"; },
		(g: StageGroupResult) => { g.forks[0].checkpoint.configurationFingerprint = "f".repeat(64); },
		(g: StageGroupResult) => { g.forks[0].owner.stage = "B"; },
		(g: StageGroupResult) => { g.forks[0].snapshot!.requests[0].forkId = "sibling"; },
		(g: StageGroupResult) => { g.forks[0].snapshot!.requestRecords[0].attempts[0].sessionId = "sibling"; },
		(g: StageGroupResult) => { g.forks[0].taskRecords = g.forks[0].taskRecords.filter(r => r.phase !== "checkpoint-restore"); },
		(g: StageGroupResult) => { g.taskRecords = g.taskRecords.filter(r => r.phase !== "source-setup"); },
		(g: StageGroupResult) => { g.forks[0].cleanup.complete = false; },
		(g: StageGroupResult) => { g.groupWallMs.value = null; },
		(g: StageGroupResult) => { g.probes.find(p => p.probe.factId?.endsWith("decision"))!.paging.evidence.qualified = false; },
	]) {
		const groups = structuredClone(original); damage(groups[0]);
		assert.equal(completeStageGroup(groups[0]), false, damage.toString());
		assert.equal(isEligiblePilot(groupManifest(original), groups, groupManifest(original, "batch")).eligible, false);
	}
});
