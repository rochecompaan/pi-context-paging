import type { Arm, PromptStep, Workload } from "../../eval/recall/workload.ts";
import { factForProbe } from "../../eval/recall/workload.ts";
import type { ReadableBlock, RequestEvidence, RequestMeta } from "../../eval/recall/codex-payload.ts";
import type { ArmSnapshot, EvalArm } from "../../eval/recall/pi-arm.ts";

export function evidenceFixture(overrides: Partial<RequestEvidence> = {}): RequestEvidence {
	return { requestId: "r0", promptId: "probe-A-id", arm: "paging", purpose: "conversation",
		complete: true, blocks: [], opaque: { count: 0, hashes: [] }, ...overrides };
}

export type ArmScript = (step: PromptStep, snapshot: ArmSnapshot) => Partial<ArmSnapshot>;
export function makeScriptedArm(options: {
	arm: Arm; workload: Workload; beforeAttempt: (meta: RequestMeta) => void; order: string[]; script?: ArmScript;
	attempts?: (step: PromptStep) => number; onPrompt?: (step: PromptStep) => Promise<void>; onAbort?: () => void;
}) {
	const { arm, workload } = options;
	const received: PromptStep[] = [];
	let disposed = false, aborted = 0;
	let state: ArmSnapshot = { arm, finalAnswerText: "", finalAnswerEventIndex: -1, entries: [], origins: [],
		requests: [], usageLedger: [], recoveryResults: [], compactions: [], promptCount: 0, latencyMs: 0, errors: [],
		statsCrossCheck: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 },
		modelMetadata: { provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses", contextWindow: 272000,
			maxTokens: 16384, reasoning: true, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 } },
		metadataFingerprint: "fixture-model" };
	const instance: EvalArm = {
		async runPrompt(step) {
			received.push(step);
			options.order.push(`${arm}:${step.id}`);
			state = { ...state, promptCount: received.length };
			for (let index = 0; index < (options.attempts?.(step) ?? 1); index++) {
				options.beforeAttempt({ arm, promptId: step.id, requestId: `${arm}-${step.id}-${index}`,
					purpose: index ? "compaction" : "conversation" });
			}
			const compacted = state.compactions.some(event => event.success);
			const originals = arm === "baseline" && !compacted;
			const blocks: ReadableBlock[] = originals ? workload.facts.map(fact => ({ role: "user", kind: "message",
				text: `${fact.subject}: ${fact.field} = ${fact.value}`, sourcePromptId: fact.sourcePromptId })) : [];
			const request = evidenceFixture({ arm, promptId: step.id, requestId: `${arm}-${step.id}`, blocks });
			let finalAnswerText = "Noted.";
			if (step.kind === "probe") {
				const probe = [...workload.probes.A, ...workload.probes.B].find(probe => probe.id === step.probeId)!;
				finalAnswerText = JSON.stringify({ answer: factForProbe(workload, probe)?.value ?? null });
			}
			state = { ...state, requests: [...state.requests, request], finalAnswerText, finalAnswerEventIndex: received.length * 10 };
			// This compaction follows the request. Only the NEXT payload excludes the originals.
			if (arm === "baseline" && step.id === "work-0") state = { ...state, compactions: [...state.compactions,
				{ eventIndex: received.length * 10 + 1, reason: "threshold", success: true }] };
			state = { ...state, ...options.script?.(step, state) };
			await options.onPrompt?.(step);
			return state;
		},
		snapshot: () => state,
		async abort() { aborted++; options.onAbort?.(); },
		dispose() { disposed = true; },
	};
	return { instance, received, get disposed() { return disposed; }, get aborted() { return aborted; } };
}

export function summaryPresence(workload: Workload): ReadableBlock[] {
	return workload.facts.map(fact => ({ role: "user", kind: "message", text: `${fact.subject}: ${fact.field} = ${fact.value}`,
		compactionEntryId: "fixture-summary" }));
}
