import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryItem } from "../src/history.ts";
import { historyParts, publicHistoryItem, selectHistoryPart, serializeRecoveryPart } from "../src/recovery-parts.ts";

function fixture(): HistoryItem[] {
	return [{
		id: "user", kind: "user", sequence: 0, timestamp: "2026-10-19T00:00:00.000Z",
		userMessage: { role: "user", content: "Exact user request", timestamp: 0 },
	}, {
		id: "turn", kind: "modelTurn", sequence: 1, timestamp: "2026-10-19T00:00:01.000Z",
		assistantMessage: { role: "assistant", content: [
			{ type: "thinking", thinking: "private-thought" },
			{ type: "toolCall", id: "paging", name: "load_history", arguments: { hidden: "paging-argument" } },
			{ type: "text", text: "Public answer", textSignature: "private-signature" },
			{ type: "toolCall", id: "ordinary", name: "read", arguments: { "a/b~c": "exact argument" } },
		], stopReason: "toolUse", timestamp: 1 } as any,
		toolResults: [
			{ role: "toolResult", toolCallId: "paging", toolName: "load_history", content: [{ type: "image", data: "HIDDEN_IMAGE", mimeType: "image/png" }], isError: false, timestamp: 2 },
			{ role: "toolResult", toolCallId: "ordinary", toolName: "read", content: [
				{ type: "text", text: "Result text" },
				{ type: "image", data: "SU1BR0U=", mimeType: "image/png" },
			], isError: false, timestamp: 3 },
		], metadata: { tools: ["load_history", "read"], files: [], failed: false },
	}];
}

test("selects exact user text and escaped argument keys from public items", () => {
	const items = fixture();
	assert.equal(selectHistoryPart(publicHistoryItem(items, "user"), "/userMessage/content"), "Exact user request");
	const item = publicHistoryItem(items, "turn");
	assert.equal(selectHistoryPart(item, "/assistantMessage/content/3/arguments/a~1b~0c"), "exact argument");
	assert.equal(serializeRecoveryPart(item, "/assistantMessage/content/2"), '{"type":"text","text":"Public answer"}');
});

test("lists original public block indices and excludes hidden and paging content", () => {
	const item = publicHistoryItem(fixture(), "turn");
	const pointers = historyParts(item).map((part) => part.part);
	assert.ok(pointers.includes("/assistantMessage/content/2"));
	assert.ok(pointers.includes("/assistantMessage/content/3"));
	assert.ok(pointers.includes("/toolResults/0/content/1"));
	assert.ok(!pointers.includes("/assistantMessage/content/0"));
	assert.ok(!pointers.includes("/assistantMessage/content/1"));
	assert.doesNotMatch(serializeRecoveryPart(item, ""), /private-thought|private-signature|paging-argument|HIDDEN_IMAGE/);
});

test("replaces images with metadata and usable attachment handles in text serialization", () => {
	const items = fixture();
	const before = structuredClone(items);
	const item = publicHistoryItem(items, "turn");
	const text = serializeRecoveryPart(item, "/toolResults/0");
	assert.doesNotMatch(text, /SU1BR0U=|"data"/);
	const image = JSON.parse(text).content[1];
	assert.equal(image.type, "image");
	assert.equal(image.mimeType, "image/png");
	assert.equal(image.bytes, 5);
	assert.deepEqual(image.read, { historyId: "turn", part: "/toolResults/0/content/1", mode: "image" });
	assert.deepEqual(selectHistoryPart(item, image.read.part), { type: "image", data: "SU1BR0U=", mimeType: "image/png" });
	assert.deepEqual(items, before);
});

test("rejects hidden slots, malformed pointers, and inherited property traversal", () => {
	const item = publicHistoryItem(fixture(), "turn");
	for (const pointer of ["/assistantMessage/content/0", "/assistantMessage/content/1", "/__proto__", "/constructor", "/assistantMessage/content/map", "not-a-pointer", "/bad~2escape", "/missing"]) {
		assert.throws(() => selectHistoryPart(item, pointer), /public recovery part|pointer/i);
	}
	assert.throws(() => publicHistoryItem(fixture(), "missing"), /Unknown history ID/);
});

test("keeps application-owned null values readable", () => {
	const items = fixture();
	const raw = items[1];
	if (raw.kind !== "modelTurn") assert.fail("Expected turn");
	const call = raw.assistantMessage.content[3];
	if (call.type !== "toolCall") assert.fail("Expected call");
	call.arguments.optional = null;
	const item = publicHistoryItem(items, "turn");
	assert.equal(serializeRecoveryPart(item, "/assistantMessage/content/3/arguments/optional"), "null");
});

test("image data fields cannot be requested as text parts", () => {
	const item = publicHistoryItem(fixture(), "turn");
	assert.throws(() => selectHistoryPart(item, "/toolResults/0/content/1/data"), /image|public recovery part/i);
});

test("paging-only turns have no public parts", () => {
	const items = fixture();
	const turn = items[1];
	assert.equal(turn.kind, "modelTurn");
	if (turn.kind !== "modelTurn") return;
	turn.assistantMessage.content = turn.assistantMessage.content.slice(0, 2);
	turn.toolResults = turn.toolResults.slice(0, 1);
	assert.throws(() => publicHistoryItem(items, "turn"), /not public recovery output/i);
});
