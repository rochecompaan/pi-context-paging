import { PAGING_TOOL_NAMES, type HistoryItem, type ModelTurnHistoryItem } from "./history.ts";
import { publicAssistantBlock } from "./recovery-content.ts";

export const MAXIMUM_OUTPUT_PAGE_CHARACTERS = 2_000;

export type ContextOutputReadInput = {
	historyId: string;
	source: "assistant" | "toolResult";
	contentIndex?: number;
	toolCallId?: string;
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
	if (input.source === "assistant") {
		if (typeof input.contentIndex !== "number"
			|| !Number.isSafeInteger(input.contentIndex) || input.contentIndex < 0) {
			throw new Error("Assistant output requires a nonnegative integer contentIndex.");
		}
		if (input.toolCallId !== undefined) {
			throw new Error("Assistant output does not accept toolCallId.");
		}
		return;
	}
	if (input.source === "toolResult") {
		if (typeof input.toolCallId !== "string" || input.toolCallId.length === 0) {
			throw new Error("Tool-result output requires toolCallId.");
		}
		if (input.contentIndex !== undefined) {
			throw new Error("Tool-result output does not accept contentIndex.");
		}
		return;
	}
	throw new Error("Output source must be assistant or toolResult.");
}

function pageInput(input: ContextOutputReadInput): { offset: number; limit: number } {
	const offset = input.offset ?? 0;
	const limit = input.limit ?? MAXIMUM_OUTPUT_PAGE_CHARACTERS;
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new Error("Output offset must be a nonnegative integer.");
	}
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

function selectedOutput(turn: ModelTurnHistoryItem, input: ContextOutputReadInput): unknown {
	if (input.source === "assistant") {
		const stored = turn.assistantMessage.content[input.contentIndex!];
		if (stored === undefined) throw new Error(`Unknown assistant content index ${input.contentIndex}.`);
		const block = publicAssistantBlock(stored);
		if (block === null) {
			throw new Error(`Assistant content index ${input.contentIndex} is not public recovery output.`);
		}
		return block;
	}
	const result = turn.toolResults.find((candidate) => candidate.toolCallId === input.toolCallId);
	if (result === undefined) throw new Error(`Unknown tool-result toolCallId ${input.toolCallId}.`);
	// Older saved recovery replies can contain serialized private blocks.
	const call = turn.assistantMessage.content.find((block) => block.type === "toolCall" && block.id === input.toolCallId);
	if (PAGING_TOOL_NAMES.some((name) => name === result.toolName || (call?.type === "toolCall" && name === call.name))) {
		throw new Error("Recovery-tool output is not available. Read the original history item instead.");
	}
	return result;
}

/** Reads exact public JSON pages, using original active-branch block indices. */
export function readContextOutput(
	items: readonly HistoryItem[],
	input: ContextOutputReadInput,
): ContextOutputPage {
	validateDiscriminator(input);
	const { offset, limit } = pageInput(input);
	const value = selectedOutput(modelTurn(items, input.historyId), input);
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("Context output could not be serialized.");
	if (offset > text.length) throw new Error("Output offset exceeds the serialized output length.");

	const end = Math.min(offset + limit, text.length);
	return {
		offset,
		nextOffset: end < text.length ? end : null,
		totalCharacters: text.length,
		text: text.slice(offset, end),
	};
}
