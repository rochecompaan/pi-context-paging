import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { HistoryItem } from "./history.ts";

/** Per-message costs stored under entry-derived keys; each field is filled lazily. */
export type MessageCosts = {
	fingerprint?: string;
	estimate?: number;
};

type KeyedCosts = MessageCosts & { readonly signature: string };

/** Characters taken from each end of every string; bounds the signature cost per string. */
const SIGNATURE_SAMPLE = 32;

function mix(hash: number, value: number): number {
	return Math.imul(hash ^ value, 0x01000193) >>> 0;
}

function mixString(hash: number, value: string): number {
	hash = mix(hash, value.length);
	const head = Math.min(value.length, SIGNATURE_SAMPLE);
	for (let index = 0; index < head; index++) hash = mix(hash, value.charCodeAt(index));
	for (let index = Math.max(head, value.length - SIGNATURE_SAMPLE); index < value.length; index++) {
		hash = mix(hash, value.charCodeAt(index));
	}
	return hash;
}

/**
 * A cheap content check for keyed costs. It hashes the message's shape, every key, every
 * string's length, and the ends of every string, so its cost grows with the number of
 * values, not their size. It catches a message rewritten under the same key, such as a
 * recovered tool result or another extension's `context` rewrite. Only a same-shaped edit
 * that keeps every string's length and ends unchanged would go unnoticed.
 */
export function contentSignature(value: unknown): string {
	let nodes = 0;
	let characters = 0;
	const walk = (current: unknown, hash: number): number => {
		nodes++;
		if (typeof current === "string") {
			characters += current.length;
			return mixString(mix(hash, 1), current);
		}
		if (Array.isArray(current)) {
			hash = mix(mix(hash, 2), current.length);
			for (const item of current) hash = walk(item, hash);
			return hash;
		}
		if (typeof current === "object" && current !== null) {
			hash = mix(hash, 3);
			for (const key in current) {
				if (Object.hasOwn(current, key)) hash = walk((current as Record<string, unknown>)[key], mixString(hash, key));
			}
			return hash;
		}
		return mixString(mix(hash, 4), `${typeof current}:${String(current)}`);
	};
	const hash = walk(value, 0x811c9dc5);
	return `${nodes}:${characters}:${hash.toString(36)}`;
}

/**
 * Cross-request cost cache for journal-backed messages. Pi clones the outgoing messages for
 * every `context` hook, so identity alone never matches across requests. An entry-derived key
 * addresses stable costs until an edit entry invalidates them (see the extension's paging-state
 * reset). Each keyed entry also stores a content signature: a message rewritten under the same
 * key falls back to the per-object WeakMap and leaves the journal message's costs intact.
 *
 * Keyed entries keep each journal message's fingerprint until the paging state resets, so memory
 * grows with the session, roughly by the serialized size of the messages that were measured.
 */
export class MessageCostCache {
	private readonly byKey = new Map<string, KeyedCosts>();
	private byObject = new WeakMap<object, MessageCosts>();

	fingerprint(message: object, key: string | undefined, compute: () => string): string {
		const costs = this.costsFor(message, key);
		if (costs.fingerprint !== undefined) return costs.fingerprint;
		const fingerprint = compute();
		costs.fingerprint = fingerprint;
		return fingerprint;
	}

	estimate(message: object, key: string | undefined, compute: () => number): number {
		const costs = this.costsFor(message, key);
		if (costs.estimate !== undefined) return costs.estimate;
		const estimate = compute();
		costs.estimate = estimate;
		return estimate;
	}

	clear(): void {
		this.byKey.clear();
		this.byObject = new WeakMap();
	}

	private costsFor(message: object, key: string | undefined): MessageCosts {
		const byObject = this.byObject.get(message);
		if (byObject) return byObject;
		if (key !== undefined) {
			const signature = contentSignature(message);
			const keyed = this.byKey.get(key);
			if (keyed?.signature === signature) {
				this.byObject.set(message, keyed);
				return keyed;
			}
			if (!keyed) {
				const created: KeyedCosts = { signature };
				this.byKey.set(key, created);
				this.byObject.set(message, created);
				return created;
			}
			// Rewritten under a journal key: cost this object alone and keep the journal's entry.
		}
		const created: MessageCosts = {};
		this.byObject.set(message, created);
		return created;
	}
}

export type MessageKeyResolver = (message: AgentMessage) => string | undefined;

type ToolCallLike = { id: string };

function toolCallIds(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		if (typeof block === "object" && block !== null
			&& (block as { type?: unknown }).type === "toolCall"
			&& typeof (block as { id?: unknown }).id === "string") {
			return [(block as ToolCallLike).id];
		}
		return [];
	});
}

/**
 * Binds outgoing messages to entry-derived keys without serialization: an assistant message
 * binds through its tool-call ids to the owning turn's entry id, a tool result binds by its
 * toolCallId. User and transient messages return undefined and stay on the WeakMap fallback.
 */
export function historyItemKeyResolver(items: readonly HistoryItem[]): MessageKeyResolver {
	const turnsByCallId = new Map<string, string>();
	for (const item of items) {
		if (item.kind !== "modelTurn") continue;
		for (const call of [...item.assistantMessage.content, ...item.toolResults]) {
			if (typeof call === "object" && call !== null) {
				const ids = toolCallIds([call]);
				if (ids.length === 0 && (call as { toolCallId?: unknown }).toolCallId !== undefined) {
					ids.push((call as { toolCallId: string }).toolCallId);
				}
				for (const id of ids) turnsByCallId.set(id, item.id);
			}
		}
	}
	return (message: AgentMessage): string | undefined => {
		if (message.role === "toolResult") {
			const turn = turnsByCallId.get(message.toolCallId);
			return turn === undefined ? undefined : `${turn}#${message.toolCallId}`;
		}
		if (message.role === "assistant") {
			for (const id of toolCallIds(message.content)) {
				const turn = turnsByCallId.get(id);
				if (turn !== undefined) return turn;
			}
		}
		return undefined;
	};
}
