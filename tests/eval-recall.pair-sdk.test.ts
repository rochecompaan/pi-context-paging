import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPair } from "../eval/recall/pair.ts";
import { createPiArm } from "../eval/recall/pi-arm.ts";
import { buildWorkload, factForProbe, type Arm } from "../eval/recall/workload.ts";
import { fixtureRuntime, measuredUsage } from "./fixtures/eval-recall-provider.ts";

test("the controller reaches both full-budget stages through real SDK sessions and native compaction without a network", async t => {
	const workload = buildWorkload("full-budget-controller-fixture");
	const directory = await mkdtemp(join(tmpdir(), "recall-pair-sdk-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const fixtures = new Map<Arm, Awaited<ReturnType<typeof fixtureRuntime>>>();
	const result = await runPair({ seed: workload.seed, firstArm: "baseline", workload,
		createArm: async ({ arm, requestGuard, clock }) => {
			const fixture = await fixtureRuntime((_, transcript) => {
				const user = transcript.messages.filter(message => message.role === "user").at(-1);
				const userText = typeof user?.content === "string" ? user.content : user?.content.filter(part => part.type === "text").map(part => part.text).join("\n");
				const probe = [...workload.probes.A, ...workload.probes.B].find(probe => probe.step.text === userText);
				// Deterministic transport data, not real recall-effectiveness evidence.
				return { text: probe ? JSON.stringify({ answer: factForProbe(workload, probe)?.value ?? null }) : "Noted.",
					usage: { ...measuredUsage, input_tokens: Math.ceil(JSON.stringify(transcript).length / 4) } };
			});
			fixtures.set(arm, fixture);
			return createPiArm({ arm, resourceDir: join(directory, arm), agentDir: "/unused", requestGuard, clock,
				createRuntime: async () => fixture.runtime });
		} });
	assert.equal(result.status, "complete", JSON.stringify({ errors: result.errors, stages: result.stages, stop: result.stopReason }));
	assert.equal(result.probes.length, 12);
	assert.ok(result.promptCounts.baseline >= 24 && result.promptCounts.baseline <= 64);
	assert.equal(result.stages.A.qualifiedKnown, 5);
	assert.ok(result.snapshots.baseline!.compactions.some(event => event.success));
	assert.ok(!result.snapshots.paging!.compactions.some(event => event.success));
	assert.ok(result.snapshots.baseline!.requests.some(request => request.purpose === "compaction"));
	assert.equal(result.sentAttempts.baseline, fixtures.get("baseline")!.dispatches.length);
	assert.equal(result.sentAttempts.paging, fixtures.get("paging")!.dispatches.length);
	assert.equal(result.snapshots.paging!.modelMetadata.contextWindow, fixtureModelWindow(fixtures.get("paging")!));
});

function fixtureModelWindow(fixture: Awaited<ReturnType<typeof fixtureRuntime>>) {
	return fixture.runtime.getModel("openai-codex", "gpt-6-luna")!.contextWindow;
}
