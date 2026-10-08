import { sameOwner, type SessionOwner } from "./metrics.ts";
import { matchFact, type Visibility } from "./evidence.ts";
import type { RequestEvidence } from "./codex-payload.ts";
import type { FactVersion, Probe } from "./workload.ts";

export type ProbeGateInput = {
	owner: SessionOwner; probe: Probe; sourceFacts: readonly FactVersion[]; latestFact: FactVersion | null;
	request: RequestEvidence; sourceProvenance: readonly string[]; siblingProbeTexts?: readonly string[];
};
export type ProbeGateResult = {
	qualified: boolean; failureCode: string | null; visibility: Visibility | null; opaqueReasoningPresent: boolean;
	checkedSourcePromptIds: string[];
};
export function readableAnswerMatch(fact: FactVersion, texts: readonly string[]): "match" | "none" | "ambiguous" {
	const match = matchFact(fact, texts);
	if (match !== "none" || fact.category !== "quantity") return match;
	const number = fact.value.split(" ")[0];
	return texts.some(text => new RegExp(`(^|[^\\d.])${number}(?![\\d.])`).test(text)) ? "ambiguous" : "none";
}

/** Host-only classification of the actual initial wire payload, before HTTP dispatch. */
export function qualifyInitialProbe(input: ProbeGateInput): ProbeGateResult {
	const { request, owner, probe, latestFact: fact } = input;
	const result: ProbeGateResult = { qualified: false, failureCode: null, visibility: null,
		opaqueReasoningPresent: request.opaque.count > 0, checkedSourcePromptIds: [] };
	const fail = (code: string, visibility: Visibility | null = "unclassified") => ({ ...result, failureCode: code, visibility });
	if (!sameOwner(owner, request) || owner.stage !== probe.stage || owner.checkpointId === null || owner.forkId === null
		|| request.purpose !== "conversation" || request.promptId !== probe.step.id) return fail("probe-owner-mismatch");
	if (!request.complete || !request.blocks.some(block => block.role === "user" && block.text === probe.step.text)) return fail("probe-payload-incomplete");
	if (input.siblingProbeTexts?.some(text => request.blocks.some(block => block.text.includes(text)))) return fail("probe-sibling-content");
	if (probe.factId === null) return result;
	if (!fact || fact.factId !== probe.factId || !input.sourceFacts.length
		|| ![1, 2].includes(fact.version) || !input.sourceFacts.some(source => source.version === 1)
		|| (fact.version === 2 && !input.sourceFacts.some(source => source.version === 2))
		|| !input.sourceFacts.some(source => source.sourcePromptId === fact.sourcePromptId && source.value === fact.value)
		|| input.sourceFacts.some(source => source.factId !== probe.factId || !input.sourceProvenance.includes(source.sourcePromptId))) {
		return fail("probe-source-provenance-missing");
	}
	result.checkedSourcePromptIds = input.sourceFacts.map(source => source.sourcePromptId);
	if (input.sourceFacts.some(source => request.blocks.some(block => block.role === "user" && block.sourcePromptId === source.sourcePromptId))) {
		return fail("probe-source-visible", "resident-original");
	}
	const match = readableAnswerMatch(fact, request.blocks.map(block => block.text));
	if (match === "match") return fail("probe-answer-visible", "resident-other");
	if (match === "ambiguous") return fail("probe-answer-ambiguous");
	return { ...result, qualified: true, visibility: "plaintext-absent" };
}
