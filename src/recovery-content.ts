import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { isPagingToolTurn, metadataFor, PAGING_TOOL_NAMES, type HistoryItem, type ModelTurnHistoryItem, type UserHistoryItem } from "./history.ts";

export type PublicAssistantBlock = Pick<TextContent, "type" | "text"> | Omit<ToolCall, "thoughtSignature">;

export type RecoveryModelTurnHistoryItem = Omit<ModelTurnHistoryItem, "assistantMessage"> & {
	assistantMessage: Omit<AssistantMessage, "content"> & {
		content: (PublicAssistantBlock | null)[];
	};
};

export type RecoveryHistoryItem = UserHistoryItem | RecoveryModelTurnHistoryItem;
const pagingNames = new Set<string>(PAGING_TOOL_NAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Host provenance is optional on older Pi versions; tool-owned details are not equivalent. */
function hasOnlyNestedPagingCalls(result: ToolResultMessage): boolean {
	const nested = "nestedCalls" in result ? result.nestedCalls : undefined;
	if (!isRecord(nested) || nested.complete !== true || !Array.isArray(nested.calls) || nested.calls.length === 0) return false;
	return nested.calls.every((call: unknown) => isRecord(call)
		&& typeof call.id === "string" && call.id.length > 0
		&& typeof call.name === "string" && pagingNames.has(call.name)
		&& (call.status === "ok" || call.status === "error" || call.status === "unfinished"));
}

/** Both sides identify direct paging activity; complete paging-only wrappers are excluded too. */
export function pagingToolCallIds(message: AssistantMessage, results: readonly ToolResultMessage[]): Set<string> {
	const ids = new Set(results.filter((result) => pagingNames.has(result.toolName) || hasOnlyNestedPagingCalls(result))
		.map((result) => result.toolCallId));
	for (const block of message.content) {
		if (block.type === "toolCall" && pagingNames.has(block.name)) ids.add(block.id);
	}
	return ids;
}

function hasRecoverableTurnContent(item: ModelTurnHistoryItem, excludedIds: ReadonlySet<string>): boolean {
	if (excludedIds.size === 0 && !isPagingToolTurn(item)) return true;
	return item.assistantMessage.content.some((block) => block.type === "toolCall" && !excludedIds.has(block.id))
		|| item.toolResults.some((result) => !excludedIds.has(result.toolCallId));
}

/** Paging-only turns are hidden; mixed turns retain their ordinary work. */
export function isRecoverableHistoryItem(item: HistoryItem): boolean {
	return item.kind === "user" || hasRecoverableTurnContent(item, pagingToolCallIds(item.assistantMessage, item.toolResults));
}

/** Allow only public assistant fields; provider signatures never become tool text. */
export function publicAssistantBlock(block: AssistantMessage["content"][number]): PublicAssistantBlock | null {
	if (block.type === "text") return { type: "text", text: block.text };
	if (block.type === "toolCall" && !pagingNames.has(block.name)) {
		const call: PublicAssistantBlock = {
			type: "toolCall",
			id: block.id,
			name: block.name,
			arguments: block.arguments,
		};
		if (block.namespace !== undefined) call.namespace = block.namespace;
		return call;
	}
	return null;
}

/** Keep null slots so output-page contentIndex values still address the raw history. */
export function recoveryHistoryItem(item: HistoryItem): RecoveryHistoryItem | undefined {
	if (item.kind === "user") return item;
	const excludedIds = pagingToolCallIds(item.assistantMessage, item.toolResults);
	if (!hasRecoverableTurnContent(item, excludedIds)) return undefined;
	const content = item.assistantMessage.content.map((block) =>
		block.type === "toolCall" && excludedIds.has(block.id) ? null : publicAssistantBlock(block));
	const toolResults = item.toolResults.filter((result) => !excludedIds.has(result.toolCallId));
	const metadata = excludedIds.size === 0 ? item.metadata : metadataFor({
		...item.assistantMessage,
		content: content.filter((block): block is PublicAssistantBlock => block !== null),
	}, toolResults, item.interruptedByRestore);
	return {
		...item,
		assistantMessage: { ...item.assistantMessage, content },
		toolResults,
		metadata,
	};
}
