import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { HistoryItem } from "./history.ts";
import type { ContextCutKey } from "./context-cut.ts";

type ModelTurnHistoryItem = Extract<HistoryItem, { kind: "modelTurn" }>;
type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
type FallbackHistoryMessage = { message: AgentMessage; historyId: string };
type FallbackHistoryBucket = {
	messages: FallbackHistoryMessage[];
	serializedIds?: Map<string, string>;
	uniqueIds?: Map<string, string | undefined>;
};

function isToolCallBlock(block: unknown): block is ToolCallBlock {
	return typeof block === "object" && block !== null
		&& (block as { type?: unknown }).type === "toolCall"
		&& typeof (block as { id?: unknown }).id === "string"
		&& typeof (block as { name?: unknown }).name === "string";
}
function historyFallbackBucket(message: AgentMessage): string {
	return `${message.role}\u0000${message.timestamp}`;
}

function cutBucket(message: AgentMessage): string {
	const calls = message.role === "assistant" ? message.content.filter(isToolCallBlock).map((call) => call.id) : [];
	return `${historyFallbackBucket(message)}\u0000${JSON.stringify(calls)}`;
}

/** Per-selection lookup; never retained by the cross-call cut state. */
export class SelectionHistoryLookup {
	private readonly identities = new Map<AgentMessage, string>();
	private readonly toolTurns = new Map<string, ModelTurnHistoryItem>();
	private readonly fallbackBuckets = new Map<string, FallbackHistoryBucket>();
	private readonly serializations = new Map<AgentMessage, string>();
	private readonly cutBuckets = new Map<string, FallbackHistoryBucket>();
	private readonly uniqueItems = new Map<string, HistoryItem | undefined>();
	private readonly items: readonly HistoryItem[] | undefined;

	constructor(items: readonly HistoryItem[] | undefined) {
		this.items = items;
		for (const item of items ?? []) {
			this.uniqueItems.set(item.id, this.uniqueItems.has(item.id) ? undefined : item);
			if (item.kind === "user") {
				this.addMessage(item.userMessage, item.id);
				continue;
			}
			this.addMessage(item.assistantMessage, item.id);
			for (const call of item.assistantMessage.content.filter(isToolCallBlock)) this.toolTurns.set(call.id, item);
			for (const result of item.toolResults) this.addMessage(result, item.id);
		}
	}

	historyId(message: AgentMessage): string | undefined {
		const identity = this.identities.get(message);
		if (identity !== undefined) return identity;
		const toolTurn = this.toolTurn(message);
		if (toolTurn) return toolTurn.id;
		const bucket = this.fallbackBuckets.get(historyFallbackBucket(message));
		if (!bucket) return undefined;
		const serialized = this.serialize(message);
		return this.serializedIds(bucket).get(serialized);
	}

	/** Unlike recovery lookup, cut provenance never guesses from a reused call ID. */
	cutKey(message: AgentMessage): ContextCutKey | undefined {
		if (message.role !== "user" && message.role !== "assistant") return undefined;
		const bucket = this.cutBuckets.get(cutBucket(message));
		if (!bucket) return undefined;
		const only = bucket.messages.length === 1 ? bucket.messages[0] : undefined;
		const call = message.role === "assistant" ? message.content.find(isToolCallBlock) : undefined;
		// A unique complete call-ID signature identifies cloned exchanges without reading payloads.
		const id = only && (only.message === message || call) ? only.historyId
			: this.uniqueSerializedIds(bucket).get(this.serialize(message));
		if (id === undefined || !this.uniqueItems.get(id)) return undefined;
		return { historyId: id, ...(call ? { toolCallId: call.id } : {}) };
	}

	matchesCutKey(message: AgentMessage, key: ContextCutKey): boolean {
		if (this.cutKey(message)?.historyId !== key.historyId) return false;
		return key.toolCallId === undefined || message.role === "assistant"
			&& message.content.some((block) => isToolCallBlock(block) && block.id === key.toolCallId);
	}

	toolTurn(message: AgentMessage): ModelTurnHistoryItem | undefined {
		if (message.role === "toolResult") return this.toolTurns.get(message.toolCallId);
		if (message.role !== "assistant") return undefined;
		return message.content.filter(isToolCallBlock).map((call) => this.toolTurns.get(call.id))
			.find((turn): turn is ModelTurnHistoryItem => turn !== undefined);
	}

	isLastItem(item: HistoryItem): boolean {
		return this.items?.at(-1) === item;
	}

	private addMessage(message: AgentMessage, historyId: string): void {
		if (!this.identities.has(message)) this.identities.set(message, historyId);
		const key = historyFallbackBucket(message);
		const bucket = this.fallbackBuckets.get(key) ?? { messages: [] };
		bucket.messages.push({ message, historyId });
		this.fallbackBuckets.set(key, bucket);
		if (message.role === "user" || message.role === "assistant") {
			const cutKey = cutBucket(message);
			const cutCandidates = this.cutBuckets.get(cutKey) ?? { messages: [] };
			cutCandidates.messages.push({ message, historyId });
			this.cutBuckets.set(cutKey, cutCandidates);
		}
	}

	private serializedIds(bucket: FallbackHistoryBucket): Map<string, string> {
		if (bucket.serializedIds) return bucket.serializedIds;
		const serializedIds = new Map<string, string>();
		for (const candidate of bucket.messages) {
			const serialized = this.serialize(candidate.message);
			if (!serializedIds.has(serialized)) serializedIds.set(serialized, candidate.historyId);
		}
		bucket.serializedIds = serializedIds;
		return serializedIds;
	}

	private uniqueSerializedIds(bucket: FallbackHistoryBucket): Map<string, string | undefined> {
		if (bucket.uniqueIds) return bucket.uniqueIds;
		const ids = new Map<string, string | undefined>();
		for (const candidate of bucket.messages) {
			const serialized = this.serialize(candidate.message);
			ids.set(serialized, ids.has(serialized) ? undefined : candidate.historyId);
		}
		bucket.uniqueIds = ids;
		return ids;
	}

	private serialize(message: AgentMessage): string {
		const cached = this.serializations.get(message);
		if (cached !== undefined) return cached;
		const serialized = JSON.stringify(message);
		this.serializations.set(message, serialized);
		return serialized;
	}
}
