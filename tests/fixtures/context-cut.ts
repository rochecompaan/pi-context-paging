import { buildSessionProjection, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ContextSelectionInput } from "../../src/context-policy.ts";
import { projectActiveBranch } from "../../src/history.ts";

export type PagingFixture = { entries: SessionEntry[]; input: ContextSelectionInput };
const timestamp = Date.parse("2026-01-01T00:00:00.000Z");
const date = new Date(timestamp).toISOString();
const payload = (id: string, tokens: number) => `${id} payload ${"x".repeat(4 * tokens)}`;
const user = (id: string): UserMessage => ({ role: "user", content: `${id} request`, timestamp });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(id: string, tokens?: number): AssistantMessage {
	return {
		role: "assistant", timestamp, api: "openai-completions", provider: "fixture", model: "fixture",
		usage, stopReason: tokens === undefined ? "toolUse" : "stop",
		content: tokens === undefined
			? [{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { path: `${id}.txt` } }]
			: [{ type: "text", text: payload(id, tokens) }],
	};
}
function result(id: string, tokens: number): ToolResultMessage {
	return { role: "toolResult", toolCallId: `call-${id}`, toolName: "read", timestamp,
		isError: false, content: [{ type: "text", text: payload(id, tokens) }] };
}
function messageEntry(id: string, message: UserMessage | AssistantMessage | ToolResultMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: date, message };
}

/** Rebuilds canonical custom messages and fresh raw projection after each fixture change. */
export function fixtureFromEntries(entries: readonly SessionEntry[], contextTokens = 128_001): PagingFixture {
	const linked = entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1]!.id : null }));
	return { entries: linked, input: {
		messages: buildSessionProjection(linked).messages.filter((message) => message.role !== "system"),
		rawHistoryItems: projectActiveBranch(linked), systemPrompt: "", activeTools: [],
		tokenBudget: 128_000, trimToTokens: 80_000, modelContextWindow: 128_000, contextTokens,
	} };
}

export function pagingFixture(kind: "completed" | "active" | "custom-active" | "keyless"): PagingFixture {
	const entries: SessionEntry[] = [];
	if (kind === "completed" || kind === "keyless") {
		for (const id of kind === "completed" ? ["old-A", "old-B", "old-C"] : ["old-A"]) {
			entries.push(messageEntry(`user-${id}`, user(id)), messageEntry(`turn-${id}`, assistant(id, kind === "keyless" ? 10_000 : 30_000)));
		}
	}
	if (kind === "keyless") entries.push({
		type: "custom_message", id: "custom-old-custom", parentId: null, timestamp: date,
		customType: "cut-fixture", display: true, details: {},
		content: `old-custom request ${"x".repeat(4 * 30_000)}`,
	});
	if (kind === "custom-active") entries.push({
		type: "custom_message", id: "custom-live", parentId: null, timestamp: date,
		customType: "cut-fixture", display: true, details: {}, content: "live request",
	});
	else entries.push(messageEntry("user-live", user("live")));
	const exchanges = kind === "completed" ? 2 : kind === "keyless" ? 0 : 4;
	for (let index = 1; index <= exchanges; index++) {
		const id = `live-${index}`;
		entries.push(messageEntry(`turn-${id}`, assistant(id)), messageEntry(`result-${id}`, result(id, kind === "completed" ? 10_000 : 30_000)));
	}
	return fixtureFromEntries(entries);
}

export function appendExchange(fixture: PagingFixture, id: string, textTokens: number): PagingFixture {
	const messages = [assistant(id), result(id, textTokens)];
	const entries = [...fixture.entries, messageEntry(`turn-${id}`, messages[0]!), messageEntry(`result-${id}`, messages[1]!)];
	const added = messages.reduce((total, message) => total + estimateTokens(message), 0);
	return fixtureFromEntries(entries, fixture.input.contextTokens! + added);
}

export function completeTurn(fixture: PagingFixture, nextUserId: string): PagingFixture {
	const message = user(nextUserId);
	return fixtureFromEntries([...fixture.entries, messageEntry(`user-${nextUserId}`, message)],
		fixture.input.contextTokens! + estimateTokens(message));
}
