import type { HistoryItem, ModelTurnHistoryItem } from "./history.ts";
import { recoveryHistoryItem, type RecoveryHistoryItem } from "./recovery-content.ts";
import { publicHistoryItem, serializeRecoveryPart } from "./recovery-parts.ts";
import { fitsRecoveryResponse } from "./recovery-response.ts";

export const MAXIMUM_OUTPUT_PAGE_CHARACTERS = 2_000;

export type ContextOutputReadInput = {
	historyId: string;
	source?: "assistant" | "toolResult";
	contentIndex?: number;
	toolCallId?: string;
	part?: string;
	mode?: "text" | "parts" | "image";
	offset?: number;
	limit?: number;
};

export type ContextOutputPage = {
	offset: number;
	nextOffset: number | null;
	totalCharacters: number;
	text: string;
};

function validateDiscriminator(input: ContextOutputReadInput): void {
	if (input.part !== undefined) {
		if (input.source !== undefined || input.contentIndex !== undefined || input.toolCallId !== undefined) {
			throw new Error("A part handle cannot be combined with legacy output selectors.");
		}
		return;
	}
	if (input.source === "assistant") {
		if (!Number.isSafeInteger(input.contentIndex) || input.contentIndex! < 0) {
			throw new Error("Assistant output requires a nonnegative integer contentIndex.");
		}
		if (input.toolCallId !== undefined) throw new Error("Assistant output does not accept toolCallId.");
		return;
	}
	if (input.source === "toolResult") {
		if (typeof input.toolCallId !== "string" || input.toolCallId.length === 0) throw new Error("Tool-result output requires toolCallId.");
		if (input.contentIndex !== undefined) throw new Error("Tool-result output does not accept contentIndex.");
		return;
	}
	throw new Error("Output requires a part handle or an assistant/toolResult source.");
}

function pageInput(input: ContextOutputReadInput): { offset: number; limit: number } {
	const offset = input.offset ?? 0;
	const limit = input.limit ?? MAXIMUM_OUTPUT_PAGE_CHARACTERS;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Output offset must be a nonnegative integer.");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_OUTPUT_PAGE_CHARACTERS) {
		throw new Error(`Output limit must be an integer from 1 to ${MAXIMUM_OUTPUT_PAGE_CHARACTERS}.`);
	}
	return { offset, limit };
}

function modelTurn(items: readonly HistoryItem[], historyId: string): ModelTurnHistoryItem {
	const item = items.find((candidate) => candidate.id === historyId);
	if (item === undefined) throw new Error(`Unknown history ID ${historyId}.`);
	if (item.kind !== "modelTurn") throw new Error(`History ID ${historyId} is not a model turn.`);
	return item;
}

function selectedPart(items: readonly HistoryItem[], input: ContextOutputReadInput): { item: RecoveryHistoryItem; part: string } {
	if (input.part !== undefined) return { item: publicHistoryItem(items, input.historyId), part: input.part };
	const turn = modelTurn(items, input.historyId);
	const item = recoveryHistoryItem(turn);
	const recovery = item?.kind === "modelTurn" ? item : undefined;
	if (input.source === "assistant") {
		if (turn.assistantMessage.content[input.contentIndex!] === undefined) throw new Error(`Unknown assistant content index ${input.contentIndex}.`);
		if (recovery?.assistantMessage.content[input.contentIndex!] == null) {
			throw new Error(`Assistant content index ${input.contentIndex} is not public recovery output.`);
		}
		return { item: recovery, part: `/assistantMessage/content/${input.contentIndex}` };
	}
	if (!turn.toolResults.some((result) => result.toolCallId === input.toolCallId)) throw new Error(`Unknown tool-result toolCallId ${input.toolCallId}.`);
	const index = recovery?.toolResults.findIndex((result) => result.toolCallId === input.toolCallId) ?? -1;
	if (recovery === undefined || index < 0) throw new Error("Recovery-tool output is not available. Read the original history item instead.");
	return { item: recovery, part: `/toolResults/${index}` };
}

function splitsSurrogate(text: string, index: number): boolean {
	return index > 0 && index < text.length
		&& /[\uD800-\uDBFF]/u.test(text[index - 1]) && /[\uDC00-\uDFFF]/u.test(text[index]);
}

/** Exact public JSON ranges; image blocks become metadata with explicit attachment handles. */
export function readContextOutput(items: readonly HistoryItem[], input: ContextOutputReadInput): ContextOutputPage {
	if (input.mode !== undefined && input.mode !== "text") throw new Error("Text output requires text mode.");
	validateDiscriminator(input);
	const { offset, limit } = pageInput(input);
	const { item, part } = selectedPart(items, input);
	const text = serializeRecoveryPart(item, part);
	if (offset > text.length) throw new Error("Output offset exceeds the serialized output length.");
	if (splitsSurrogate(text, offset)) throw new Error("Output offset splits a Unicode character.");
	const pageAt = (end: number): ContextOutputPage => ({ offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length, text: text.slice(offset, end) });
	let low = offset;
	let high = Math.min(offset + limit, text.length);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fitsRecoveryResponse(pageAt(middle))) low = middle;
		else high = middle - 1;
	}
	if (splitsSurrogate(text, low)) low--;
	if (low === offset && offset < text.length) throw new Error("Output limit is too small for the next Unicode character. Increase limit.");
	return pageAt(low);
}
