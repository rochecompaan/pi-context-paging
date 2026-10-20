import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { HistoryItem, ModelTurnHistoryItem } from "../src/history.ts";
import { HistoryNavigator } from "../src/navigator.ts";

function user(text: string, id = "user"): HistoryItem {
	return {
		id, kind: "user", sequence: 0, timestamp: "2026-10-20T00:00:00.000Z",
		userMessage: { role: "user", content: text, timestamp: 0 },
	};
}

function turn(content: AssistantMessage["content"], resultText?: string): ModelTurnHistoryItem {
	return {
		id: "turn", kind: "modelTurn", sequence: 0, timestamp: "2026-10-20T00:00:00.000Z",
		assistantMessage: {
			role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", content,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: resultText === undefined ? "stop" : "toolUse", timestamp: 0,
		},
		toolResults: resultText === undefined ? [] : [{
			role: "toolResult", toolCallId: "read-call", toolName: "read",
			content: [{ type: "text", text: resultText }], isError: false, timestamp: 1,
		}],
		metadata: { tools: content.flatMap((block) => block.type === "toolCall" ? [block.name] : []), files: [], failed: false },
	};
}

for (const source of ["user", "assistant", "toolResult", "toolArguments"] as const) {
	test(`search previews show a late match in ${source} without changing exact recovery`, () => {
		const text = `${"background ".repeat(80)}Decision:\n Needle approved\tfor release. ${"afterword ".repeat(80)}`;
		const item = source === "user" ? user(text)
			: source === "assistant" ? turn([{ type: "text", text }])
			: source === "toolArguments" ? turn([
				{ type: "text", text: "Opening the file" },
				{ type: "toolCall", id: "read-call", name: "read", arguments: { note: text } },
			]) : turn([
				{ type: "text", text: "Opening the file" },
				{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "decision.txt" } },
			], text);
		const navigator = new HistoryNavigator([item]);
		const references = navigator.search({ query: "NEEDLE" });

		assert.equal(references.length, 1);
		assert.equal(references[0].historyId, item.id);
		assert.match(references[0].preview, /Needle approved/);
		assert.ok(references[0].preview.length <= 160);
		assert.ok(references[0].preview.startsWith("…"));
		assert.ok(references[0].preview.endsWith("…"));
		assert.deepEqual(navigator.load([item.id]), [item]);
	});
}

test("search previews use whole normalized terms, not earlier substring matches", () => {
	const navigator = new HistoryNavigator([user(`needlework ${"background ".repeat(80)} /NEEDLE/ approved for release`)]);
	const preview = navigator.search({ query: "needle" })[0].preview;

	assert.match(preview, /\/NEEDLE\/ approved for release/);
	assert.doesNotMatch(preview, /needlework/);
	assert.ok(preview.startsWith("…"));
	assert.ok(!preview.endsWith("…"));
});

for (const [query, text, want] of [
	["分页", `${"background ".repeat(80)}分页恢复记录 ${"afterword ".repeat(80)}`, "分页恢复记录"],
	["needle", `${"İ ".repeat(300)}Needle approved ${"afterword ".repeat(80)}`, "Needle approved"],
	["stanbul", `${"background ".repeat(80)}İSTANBUL approved ${"afterword ".repeat(80)}`, "İSTANBUL approved"],
] as const) {
	test(`search previews locate ${query} with the index's Unicode matching rules`, () => {
		const preview = new HistoryNavigator([user(text)]).search({ query })[0].preview;

		assert.ok(preview.includes(want), preview);
		assert.ok(preview.length <= 160);
		assert.equal(preview, Buffer.from(preview, "utf8").toString("utf8"));
	});
}

for (const leading of [0, 1]) {
	test(`search excerpt boundaries preserve surrogate pairs with offset ${leading}`, () => {
		const text = `${"😀 ".repeat(100)}${"z ".repeat(leading)}Needle${" z".repeat(leading)} ${"😀 ".repeat(100)}`;
		const preview = new HistoryNavigator([user(text)]).search({ query: "needle" })[0].preview;

		assert.match(preview, /Needle/);
		assert.ok(preview.length <= 160);
		assert.equal(preview, Buffer.from(preview, "utf8").toString("utf8"));
	});
}

for (const length of [140, 200]) {
	test(`search previews keep a ${length}-character matching term within the excerpt budget`, () => {
		const query = "n".repeat(length);
		const preview = new HistoryNavigator([user(`${"background ".repeat(80)}${query} ${"afterword ".repeat(80)}`)])
			.search({ query })[0].preview;

		assert.ok(preview.includes("n".repeat(Math.min(length, 140))));
		assert.ok(preview.length <= 160);
	});
}

test("search previews mark only the clipped end for a match at the start", () => {
	const preview = new HistoryNavigator([user(`Needle approved ${"afterword ".repeat(80)}`)])
		.search({ query: "needle" })[0].preview;

	assert.ok(preview.startsWith("Needle approved"));
	assert.ok(preview.endsWith("…"));
	assert.ok(preview.length <= 160);
});

test("short search previews retain original case and normalize whitespace without ellipses", () => {
	const preview = new HistoryNavigator([user("Decision:\n  Needle approved\tfor release.")])
		.search({ query: "needle" })[0].preview;

	assert.equal(preview, "Decision: Needle approved for release.");
});

test("query-specific previews preserve browse references, empty queries, and exact loads", () => {
	const item = turn([{ type: "text", text: `${"background ".repeat(80)}Needle approved ${"separator ".repeat(80)}Rollback required` }]);
	const navigator = new HistoryNavigator([user("Earlier discussion", "before"), item, user("Later discussion", "after")]);
	const browse = structuredClone(navigator.browse({ direction: "forward" }));
	const loaded = structuredClone(navigator.load(["turn"]));
	const first = navigator.search({ query: "needle" })[0];
	const rollback = navigator.search({ query: "rollback" })[0];

	assert.match(first.preview, /Needle approved/);
	assert.doesNotMatch(first.preview, /Rollback required/);
	assert.match(rollback.preview, /Rollback required/);
	assert.doesNotMatch(rollback.preview, /Needle approved/);
	assert.deepEqual({ ...first, preview: browse[1].preview }, browse[1]);
	assert.deepEqual(navigator.browse({ direction: "forward" }), browse);
	assert.deepEqual(navigator.search({ query: "" }), browse);
	assert.deepEqual(navigator.load(["turn"]), loaded);
	assert.equal(navigator.search({ query: "needle" })[0].preview, first.preview);
});
