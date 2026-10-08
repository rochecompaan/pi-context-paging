import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseEvalArgs, runEval } from "../eval/recall/cli.ts";
import { factForProbe } from "../eval/recall/workload.ts";
import { nativeCliFixture } from "./fixtures/eval-recall-native-cli.ts";

test("full-budget native pilot preserves isolated recovery through CLI finalization", async t => {
	const f = await nativeCliFixture(t);
	assert.equal(await runEval(parseEvalArgs(["--pilot", "--seed", "sdk-isolated-offline"]), f.dependencies), 0, f.outputs.join("\n"));
	assert.equal(f.sessions.filter(s => s.source).length, 4); assert.equal(f.sessions.filter(s => !s.source).length, 24);
	assert.ok(f.sessions.every(s => s.disposed && s.aborted)); assert.equal(f.groups.length, 2);
	assert.notEqual(f.groups[0].seed, f.groups[1].seed);
	for (const group of f.groups) {
		assert.equal(group.status, "complete"); assert.equal(group.forks.length, 12); assert.equal(group.stageEvidence.qualifiedKnown, 5);
		assert.ok(group.forks.every(fork => fork.restoration?.passed && fork.snapshot!.promptCount >= 24
			&& fork.snapshot!.promptCount === group.steps.length + 1));
		assert.equal(group.sources.baseline!.compactions.some(e => e.success), group.stage === "B");
		assert.equal(group.sources.baseline!.requests.some(r => r.purpose === "compaction"), group.stage === "B");
		const workload = f.workloads.get(group.seed)!;
		const recovered = group.forks.find(fork => fork.owner.arm === "paging" && fork.probe.id.endsWith("-id"))!;
		assert.equal(recovered.snapshot!.recoveryResults.length, 1);
		const broad = recovered.snapshot!.recoveryResults[0].text;
		for (const probe of workload.probes[group.stage].filter(probe => probe.factId)) assert.ok(broad.includes(factForProbe(workload, probe)!.value), probe.id);
		assert.equal(group.probes[0].paging.evidence.recoverySuccess, true, JSON.stringify({ score: group.probes[0].paging.score, evidence: group.probes[0].paging.evidence, text: recovered.snapshot!.finalAnswerText, requests: recovered.snapshot!.requests.length, calls: recovered.snapshot!.toolCalls, recovery: recovered.snapshot!.recoveryResults.map(r => ({ id: r.toolCallId, event: r.eventIndex, request: r.requestId, error: r.isError })), final: recovered.snapshot!.finalAnswerEventIndex }));
		for (const fork of group.forks.filter(fork => fork.owner.arm === "paging" && fork !== recovered)) {
			assert.equal(fork.snapshot!.recoveryResults.length, 0);
			assert.equal(fork.snapshot!.finalAnswerText, '{"answer":null}');
			assert.ok(!fork.snapshot!.requests[0].blocks.some(block => block.kind === "tool-result"));
		}
		assert.equal(group.probes.find(p => p.probe.id.endsWith("-unknown"))!.paging.score.correct, true);
		assert.equal(factForProbe(workload, workload.probes[group.stage].find(p => p.factId?.endsWith("quantity"))!)!.version, 2);
		for (const arm of ["baseline", "paging"] as const) {
			const snapshots = [group.sources[arm]!, ...group.forks.filter(fork => fork.owner.arm === arm).map(fork => fork.snapshot!)];
			const dispatched = snapshots.reduce((n, snapshot) => n + f.sessions.find(s => s.sessionId === snapshot.owner.sessionId)!.dispatches, 0);
			assert.equal(group.sentAttempts[arm], dispatched);
			assert.equal(group.usageRecords.filter(row => row.arm === arm).length, dispatched);
			assert.ok(snapshots.every(snapshot => snapshot.executionUsage.length === snapshot.requestRecords.flatMap(r => r.attempts).length));
		}
	}
	const directory = f.directories[0], completion = JSON.parse(await readFile(join(directory, "completion.json"), "utf8"));
	assert.equal(completion.status, "complete"); assert.equal(completion.offlineGateEvidence.restoredForks, 24);
	const results = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
	assert.equal(results.metrics.run.usage.reasoningTokens.value, null);
	assert.ok(results.metrics.run.usage.reasoningTokens.missingCount > 0);
	assert.equal(results.metrics.run.counts.attempts, f.sessions.reduce((n, s) => n + s.dispatches, 0));
	assert.equal(results.metrics.run.cost.actualCostUsd.value, null);
	assert.equal(f.git("status", "--porcelain"), "");
});

test("failed native retry is counted independently of the single SDK entry and blocks completion", async t => {
	const f = await nativeCliFixture(t, index => ({ status: index === 0 ? 503 : 400, errorText: "PRIVATE_PROVIDER_FAILURE" }));
	assert.equal(await runEval(parseEvalArgs(["--pilot"]), f.dependencies), 2);
	const group = f.groups[0]; assert.equal(group.status, "incomplete"); assert.ok(f.sessions.every(s => s.disposed && s.aborted));
	assert.equal(group.usageRecords.length, 2); assert.equal(group.sentAttempts.baseline + group.sentAttempts.paging, 2);
	assert.equal(group.usageRecords[0].usage.totalInputTokens.value, null);
	assert.equal(group.sources.baseline!.usageLedger.length, 1);
	assert.equal(group.sources.baseline!.requestRecords[0].attempts[0].timing.status, "failed");
	assert.ok(group.usageRecords.every(row => row.usage.totalInputTokens.value === null));
	await assert.rejects(access(join(f.directories[0], "completion.json")), { code: "ENOENT" });
	assert.ok(!f.outputs.join("\n").includes("PRIVATE_PROVIDER_FAILURE"));
});
