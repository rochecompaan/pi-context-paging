import { PAGING_TOOL_NAMES } from "../../src/history.ts";
import { sameOwner, type SessionOwner } from "./metrics.ts";
import type { ReadableBlock, RequestEvidence, RequestMeta } from "./codex-payload.ts";
import type { ProbeScore } from "./scoring.ts";
import type { FactVersion, Probe } from "./workload.ts";

export type Visibility = "resident-original" | "resident-summary" | "resident-other" | "plaintext-absent" | "unclassified";
export type ObservedToolCall = RequestMeta & { toolCallId: string; toolName: string; eventIndex: number };
export type RecoveryResult = SessionOwner & {
	promptId: string;
	requestId: string;
	toolCallId: string;
	toolName: string;
	text: string;
	isError: boolean;
	eventIndex: number;
};
export type ProbeEvidenceInput = {
	probe: Probe;
	fact: FactVersion | null;
	initial: RequestEvidence;
	followUps: readonly RequestEvidence[];
	recoveryResults: readonly RecoveryResult[];
	observedCalls?: readonly ObservedToolCall[];
	score: ProbeScore;
	finalAnswerEventIndex: number;
};
export type ProbeEvidence = {
	probeId: string;
	visibility: Visibility | null;
	opaqueReasoningPresent: boolean;
	qualified: boolean;
	recoverySuccess: boolean | null;
};

function containsLiteral(fact: FactVersion, text: string): boolean {
	const continuation = fact.category === "path" ? /[A-Za-z0-9_./-]/ : /[A-Za-z0-9_-]/;
	let start = text.indexOf(fact.value);
	while (start >= 0) {
		const before = start > 0 ? text[start - 1] : "";
		const after = text[start + fact.value.length] ?? "";
		if (!continuation.test(before) && !continuation.test(after)) return true;
		start = text.indexOf(fact.value, start + 1);
	}
	return false;
}

export function matchFact(fact: FactVersion, texts: readonly string[]): "match" | "none" | "ambiguous" {
	const matching = texts.filter(text => containsLiteral(fact, text));
	if (!matching.length) return "none";
	if (fact.uniqueLiteral) return "match";
	// A newline is a record boundary. Never combine subjects, fields, and values
	// from separate records to manufacture field-specific quantity evidence.
	return matching.some(text => text.split(/\r?\n/).some(record => containsLiteral(fact, record)
		&& record.includes(fact.subject) && record.includes(fact.field))) ? "match" : "ambiguous";
}

function visibility(input: ProbeEvidenceInput, fact: FactVersion): Visibility {
	const { initial, probe } = input;
	if (!initial.complete || initial.purpose !== "conversation" || initial.promptId !== probe.step.id) return "unclassified";
	const matches = initial.blocks.filter(block => matchFact(fact, [block.text]) === "match");
	if (matches.some(block => block.role === "user" && block.sourcePromptId === fact.sourcePromptId)) return "resident-original";
	if (matches.some(block => block.compactionEntryId !== undefined)) return "resident-summary";
	if (matches.length) return "resident-other";
	if (initial.blocks.some(block => matchFact(fact, [block.text]) === "ambiguous")) return "unclassified";
	return "plaintext-absent";
}

/** The native Responses adapter represents a call as call_id|item_id. */
function sameToolIdentity(block: ReadableBlock, nativeId: string): boolean {
	if (block.toolCallId === nativeId) return true;
	const [callId, itemId, ...extra] = nativeId.split("|");
	return extra.length === 0 && !!itemId && block.toolCallId === callId && block.toolItemId === itemId;
}

export function analyzeProbe(input: ProbeEvidenceInput): ProbeEvidence {
	const opaqueReasoningPresent = input.initial.opaque.count > 0;
	const fact = input.fact;
	if (!fact || input.probe.factId === null) return {
		probeId: input.probe.id, visibility: null, opaqueReasoningPresent, qualified: false, recoverySuccess: null,
	};
	const label = visibility(input, fact);
	const requests = [input.initial, ...input.followUps];
	const sourceExcluded = !input.initial.blocks.some(block => block.role === "user" && block.sourcePromptId === fact.sourcePromptId);
	const qualified = label === "plaintext-absent" && sourceExcluded && requests.every(request => request.complete
		&& request.promptId === input.probe.step.id && request.purpose === "conversation" && sameOwner(request, input.initial));
	const recovered = input.recoveryResults.some(result => !result.isError && result.toolCallId.length > 0
		&& result.eventIndex >= 0 && result.eventIndex < input.finalAnswerEventIndex
		&& result.promptId === input.probe.step.id
		&& sameOwner(result, input.initial)
		&& requests.some(request => request.requestId === result.requestId && sameOwner(request, result))
		&& input.observedCalls?.some(call => sameOwner(call, result) && call.requestId === result.requestId
			&& call.promptId === result.promptId && call.toolCallId === result.toolCallId && call.toolName === result.toolName
			&& call.eventIndex >= 0 && call.eventIndex <= result.eventIndex)
		&& requests.some(request => request.blocks.some(block => block.kind === "tool-call" && sameToolIdentity(block, result.toolCallId) && block.text === result.toolName))
		&& PAGING_TOOL_NAMES.some(name => name === result.toolName) && matchFact(fact, [result.text]) === "match");
	return { probeId: input.probe.id, visibility: label, opaqueReasoningPresent,
		qualified, recoverySuccess: qualified && recovered && input.score.correct };
}
