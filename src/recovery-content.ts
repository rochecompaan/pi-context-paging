import type { AssistantMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { HistoryItem, ModelTurnHistoryItem, UserHistoryItem } from "./history.ts";

export type PublicAssistantBlock = Pick<TextContent, "type" | "text"> | Omit<ToolCall, "thoughtSignature">;

export type RecoveryModelTurnHistoryItem = Omit<ModelTurnHistoryItem, "assistantMessage"> & {
	assistantMessage: Omit<AssistantMessage, "content"> & {
		content: (PublicAssistantBlock | null)[];
	};
};

export type RecoveryHistoryItem = UserHistoryItem | RecoveryModelTurnHistoryItem;

/** Allow only public assistant fields; provider signatures never become tool text. */
export function publicAssistantBlock(block: AssistantMessage["content"][number]): PublicAssistantBlock | null {
	if (block.type === "text") return { type: "text", text: block.text };
	if (block.type === "toolCall") {
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
export function recoveryHistoryItem(item: HistoryItem): RecoveryHistoryItem {
	if (item.kind === "user") return item;
	return {
		...item,
		assistantMessage: {
			...item.assistantMessage,
			content: item.assistantMessage.content.map(publicAssistantBlock),
		},
	};
}
