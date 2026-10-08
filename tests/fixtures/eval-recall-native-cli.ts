import assert from "node:assert/strict";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { metadataFor, EVAL_MODEL } from "../../eval/recall/codex-runtime.ts";
import { createPiArm } from "../../eval/recall/pi-arm.ts";
import { runStageGroup, type StageGroupResult } from "../../eval/recall/stage-group.ts";
import { buildWorkload, factForProbe, type FactVersion, type Workload } from "../../eval/recall/workload.ts";
import { cliFixture } from "./eval-recall-cli.ts";
import { fixtureRuntime, measuredUsage, type FixtureScript } from "./eval-recall-provider.ts";

/** A revised source bundles all targets, so one unrestricted lookup can reveal all five. */
function bundledWorkload(seed: string): Workload {
	const workload = buildWorkload(seed), facts = [...workload.facts], seedSteps = [...workload.seedSteps];
	for (const stage of ["A", "B"] as const) {
		const original = facts.find(f => f.factId === `${stage}-quantity`)!;
		const revised: FactVersion = { ...original, version: 2, value: "73129 ms", sourcePromptId: `seed-${stage}-quantity-v2` };
		facts.push(revised);
		const latest = workload.probes[stage].filter(p => p.factId).map(p => p.factId === revised.factId ? revised : factForProbe(workload, p)!);
		seedSteps.push({ id: revised.sourcePromptId, kind: "revision", text: `Incident checkpoint for ${revised.subject}.\nThis quantity replaces the earlier value. Current incident records:\n`
			+ latest.map(f => `${f.subject}: ${f.field} = ${f.value}`).join("\n") + "\nAcknowledge without copying values." });
	}
	return { ...workload, facts, seedSteps };
}
function strings(value: unknown): string[] {
	if (typeof value === "string") {
		try { return strings(JSON.parse(value)); } catch { return [value]; }
	}
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === "object") return Object.values(value).flatMap(strings);
	return [];
}
function promptText(context: TranscriptContext): string {
	const user = context.messages.filter(m => m.role === "user").at(-1);
	return typeof user?.content === "string" ? user.content : user?.content.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
}

/** Native SDK/transport/extension/controller/CLI/writer; only provider responses are local. */
export async function nativeCliFixture(t: TestContext, failureScript?: FixtureScript) {
	const f = await cliFixture(t), catalog = await fixtureRuntime();
	f.live.modelMetadata = metadataFor(catalog.runtime.getModel(EVAL_MODEL.provider, EVAL_MODEL.id)!);
	const groups: StageGroupResult[] = [], sessions: { sessionId: string; source: boolean; disposed: boolean; aborted: boolean; dispatches: number }[] = [];
	const workloads = new Map<string, Workload>();
	f.live.runStageGroup = async options => {
		const workload = bundledWorkload(options.seed); workloads.set(options.seed, workload);
		const result = await runStageGroup({ ...options, workload }); groups.push(result); return result;
	};
	f.live.createArm = async options => {
		const workload = workloads.get(options.owner.seed)!;
		const fixture = await fixtureRuntime(failureScript ?? ((index, context) => {
			const probe = workload.probes[options.owner.stage].find(p => p.step.text === promptText(context));
			const usage = { ...measuredUsage, input_tokens: Math.ceil(JSON.stringify(context).length / 4) };
			if (!probe) return { text: "Noted.", usage };
			// Only the first known fork recovers. Siblings must not inherit this result.
			if (options.arm === "paging" && probe.id.endsWith("-id") && index === 0) {
				const fact = factForProbe(workload, probe)!;
				return { tool: { name: "search_history", arguments: { query: fact.subject, limit: 10, load: true } }, usage };
			}
			const fact = factForProbe(workload, probe);
			const prefix = fact ? `${fact.subject}: ${fact.field} = ` : null;
			const values = prefix ? strings(context.messages).flatMap(text => text.split("\n").filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length))) : [];
			return { text: JSON.stringify({ answer: values.at(-1) ?? null }), usage };
		}), undefined, true, failureScript ? { maxRetries: 1 } : {});
		const before = fixture.dispatches.length;
		const arm = await createPiArm({ ...options, resourceDir: join(f.root, ".pi/evals/resources", options.owner.sessionId), agentDir: "/unused", createRuntime: async () => fixture.runtime });
		assert.equal(fixture.dispatches.length, before, "native creation/restoration dispatched a request");
		const record = { sessionId: options.owner.sessionId, source: !options.checkpoint, disposed: false, aborted: false, dispatches: 0 };
		sessions.push(record);
		const abort = arm.abort, dispose = arm.dispose;
		arm.abort = async () => { record.aborted = true; await abort(); };
		arm.dispose = () => { record.disposed = true; record.dispatches = fixture.dispatches.length; fixture.dispatches.length = 0; dispose(); };
		return arm;
	};
	return { ...f, groups, sessions, workloads };
}
