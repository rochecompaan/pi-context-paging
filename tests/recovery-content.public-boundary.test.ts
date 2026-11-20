import assert from "node:assert/strict";
import test from "node:test";
import { isRecoverableHistoryItem, publicAssistantBlock, recoveryHistoryItem, pagingToolCallIds } from "../src/recovery-content.ts";
import { PAGING_TOOL_NAMES } from "../src/history.ts";
import type { HistoryItem, ModelTurnHistoryItem } from "../src/history.ts";
import type { RecoveryHistoryItem, RecoveryModelTurnHistoryItem } from "../src/recovery-content.ts";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/**
 * The README promises the model gets back "public content": only assistant text and ordinary
 * tool-call blocks, with the paging machinery hidden. That boundary is a privacy claim about what
 * leaves the extension, so it is asserted directly — including that provider-private fields are
 * absent from the serialized view, not merely omitted from the type.
 */
type PublicBlock = AssistantMessage["content"][number];

const pagingTool = PAGING_TOOL_NAMES[0];

/** Fixtures carry provider-private fields the public types do not model; that is the point. */
const block = (value: Record<string, unknown>): PublicBlock => value as unknown as PublicBlock;

const privateCall = block({ type: "toolCall", id: "call-bash", name: "bash", arguments: { cmd: "ls" },
	thoughtSignature: "THOUGHT-SIGNATURE-PRIVATE", providerMetadata: { hidden: "PROVIDER-PRIVATE-METADATA" } });
const pagingCall = block({ type: "toolCall", id: "call-paging", name: pagingTool, arguments: {} });
const privateThinking = block({ type: "thinking", thinking: "PRIVATE-CHAIN-OF-THOUGHT", signature: "THINKING-SIGNATURE" });

function turn(content: PublicBlock[], results: ToolResultMessage[], tools: string[]): ModelTurnHistoryItem {
	return {
		id: "turn-1", kind: "modelTurn", sequence: 3, timestamp: "2026-01-01T00:00:00.000Z",
		assistantMessage: { role: "assistant", content, api: "test", provider: "test", model: "model-x", usage: {}, stopReason: "stop", timestamp: 0 },
		toolResults: results, metadata: { tools, files: [], failed: false },
	} as unknown as ModelTurnHistoryItem;
}

const result = (toolCallId: string, toolName: string, content: string, extra: Record<string, unknown> = {}): ToolResultMessage =>
	({ role: "toolResult", toolCallId, toolName, content, details: {}, ...extra }) as unknown as ToolResultMessage;

const mixedTurn = (): ModelTurnHistoryItem => turn(
	[{ type: "text", text: "public answer" }, privateCall, pagingCall, privateThinking],
	[result("call-bash", "bash", "file listing"), result("call-paging", pagingTool, "paged out"),
		result("call-wrapper", "codemode", "wrapper output", { nestedCalls: { complete: true, calls: [{ id: "n1", name: pagingTool, status: "ok" }] } })],
	["bash", pagingTool, "codemode"],
);

function modelView(item: RecoveryHistoryItem | undefined): RecoveryModelTurnHistoryItem {
	assert.ok(item !== undefined && item.kind === "modelTurn", "expected a model-turn recovery view");
	return item;
}

test("an ordinary tool call enters the view as public call data only", () => {
	assert.deepEqual(publicAssistantBlock(privateCall), { type: "toolCall", id: "call-bash", name: "bash", arguments: { cmd: "ls" } });
	// Paging's own calls are the machinery being hidden, so the filter itself must refuse them.
	for (const name of PAGING_TOOL_NAMES) {
		assert.equal(publicAssistantBlock(block({ type: "toolCall", id: `call-${name}`, name, arguments: {} })), null, name);
	}
	assert.equal(JSON.stringify(publicAssistantBlock(block({ type: "text", text: "hello", signature: "TEXT-SIGNATURE" }))),
		'{"type":"text","text":"hello"}');
});

test("provider-private blocks and signatures never reach the serialized recovery view", () => {
	for (const privateBlock of [privateThinking, block({ type: "redactedThinking", data: "REDACTED-BLOB" }),
		block({ type: "image", data: "QUJD", mimeType: "image/png" })]) {
		assert.equal(publicAssistantBlock(privateBlock), null, String(privateBlock.type));
	}
	const serialized = JSON.stringify(recoveryHistoryItem(mixedTurn()));
	for (const privateValue of ["THOUGHT-SIGNATURE-PRIVATE", "PROVIDER-PRIVATE-METADATA", "PRIVATE-CHAIN-OF-THOUGHT", "THINKING-SIGNATURE"]) {
		assert.ok(!serialized.includes(privateValue), `${privateValue} must not leave the extension`);
	}
	assert.ok(serialized.includes("public answer") && serialized.includes("file listing"), "public content must survive the filter");
});

test("hidden blocks keep their slots so output-page indices still address raw history", () => {
	const raw = mixedTurn();
	const view = modelView(recoveryHistoryItem(raw));
	assert.equal(view.assistantMessage.content.length, raw.assistantMessage.content.length);
	assert.deepEqual(view.assistantMessage.content.map(entry => (entry === null ? "hidden" : entry.type)), ["text", "toolCall", "hidden", "hidden"]);
	assert.deepEqual([...pagingToolCallIds(raw.assistantMessage, raw.toolResults)], ["call-paging", "call-wrapper"]);
	assert.deepEqual(view.toolResults.map(row => row.toolCallId), ["call-bash"], "paging results and paging-only wrappers are hidden");
	assert.deepEqual(view.metadata.tools, ["bash"], "recovery metadata describes only the public work");
});

test("a paging-only turn is hidden, mixed turns keep their ordinary work", () => {
	const pagingOnly = turn([pagingCall], [result("call-paging", pagingTool, "paged out")], [pagingTool]);
	assert.equal(isRecoverableHistoryItem(pagingOnly), false);
	assert.equal(recoveryHistoryItem(pagingOnly), undefined);
	assert.equal(isRecoverableHistoryItem(mixedTurn()), true);
	const user = { id: "user-1", kind: "user", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z",
		userMessage: { role: "user", content: "please page", timestamp: 0 } } as unknown as HistoryItem;
	assert.equal(isRecoverableHistoryItem(user), true);
	assert.equal(recoveryHistoryItem(user), user, "a user item is returned as stored");
});

test("an incomplete nested wrapper is ordinary work, not a paging wrapper in disguise", () => {
	const wrapperCall = block({ type: "toolCall", id: "call-wrap", name: "codemode", arguments: {} });
	const incomplete = turn([{ type: "text", text: "answer" }, wrapperCall],
		[result("call-wrap", "codemode", "mixed output", { nestedCalls: { complete: false, calls: [{ id: "n1", name: pagingTool, status: "ok" }] } })],
		["codemode"]);
	assert.equal(pagingToolCallIds(incomplete.assistantMessage, incomplete.toolResults).size, 0);
	assert.deepEqual(modelView(recoveryHistoryItem(incomplete)).toolResults.map(row => row.toolCallId), ["call-wrap"]);
	// A non-paging nested call makes the wrapper ordinary work even when it reports complete.
	const mixedWrapper = turn([{ type: "text", text: "answer" }, wrapperCall],
		[result("call-wrap", "codemode", "mixed output", { nestedCalls: { complete: true, calls: [
			{ id: "n1", name: pagingTool, status: "ok" }, { id: "n2", name: "bash", status: "ok" }] } })],
		["codemode"]);
	assert.equal(pagingToolCallIds(mixedWrapper.assistantMessage, mixedWrapper.toolResults).size, 0);
});
