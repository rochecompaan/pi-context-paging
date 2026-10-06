import { PAGING_TOOL_NAMES } from "../../src/history.ts";
import type { RequestEvidence } from "./codex-payload.ts";
import type { ProbeScore } from "./scoring.ts";
import type { FactVersion, Probe } from "./workload.ts";

export type Visibility = "resident-original" | "resident-summary" | "resident-other" | "plaintext-absent" | "unclassified";
export type RecoveryResult = {
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
		&& request.promptId === input.probe.step.id && request.purpose === "conversation" && request.arm === input.initial.arm);
	const recovered = input.recoveryResults.some(result => !result.isError && result.toolCallId.length > 0
		&& result.eventIndex >= 0 && result.eventIndex < input.finalAnswerEventIndex
		&& result.promptId === input.probe.step.id
		&& requests.some(request => request.requestId === result.requestId)
		&& PAGING_TOOL_NAMES.some(name => name === result.toolName) && matchFact(fact, [result.text]) === "match");
	return { probeId: input.probe.id, visibility: label, opaqueReasoningPresent,
		qualified, recoverySuccess: qualified && recovered && input.score.correct };
}
