import assert from "node:assert/strict";
import test from "node:test";
import { boundedHistoryReply, historyPartsPage } from "../src/recovery-loads.ts";
import { MAXIMUM_PAGE_LIMIT, MAXIMUM_RECOVERY_REPLY_BYTES, fitsRecoveryResponse } from "../src/recovery-response.ts";
import { historyParts } from "../src/recovery-parts.ts";
import type { RecoveryHistoryItem } from "../src/recovery-content.ts";
import type { HistoryReference } from "../src/navigator.ts";
import type { UserHistoryItem } from "../src/history.ts";

/**
 * Recovery is the flow that hands cut context back, and one reply is all the model gets: 16 KiB,
 * serialized. Two promises matter to a user — a part list pages through every part exactly once, and
 * a crowded reply keeps every identifier it was given, deferring content instead of dropping rows.
 */
const userItem = (id: string, content: string | { type: "text"; text: string }[], sequence = 1): UserHistoryItem => ({
	id, kind: "user", sequence, timestamp: "2026-01-01T00:00:00.000Z", userMessage: { role: "user", timestamp: 0, content },
});

function imageItem(id: string, dataCharacters = 9_000): RecoveryHistoryItem {
	return {
		id, kind: "modelTurn", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z",
		assistantMessage: { role: "assistant", content: [{ type: "image", data: "A".repeat(dataCharacters), mimeType: "image/png" }] },
		toolResults: [], metadata: { tools: [], files: [], failed: false },
	} as unknown as RecoveryHistoryItem;
}

const reference = (historyId: string, preview: string): HistoryReference => ({
	historyId, sequence: 1, kind: "user", timestamp: "2026-01-01T00:00:00.000Z", preview, tools: [], files: [],
	failed: false, previousHistoryId: null, nextHistoryId: null,
});

const replyBytes = (reply: { content: { text: string }[] }) => Buffer.byteLength(reply.content[0]!.text, "utf8");
type ReplyShape = {
	items: { id: string; kind: string; deferred?: boolean; totalParts?: number; nextPartOffset?: number | null;
		parts?: { part: string }[]; readParts?: { historyId: string; mode: string; offset: number } }[];
	references: { historyId: string; preview?: string; detailsDeferred?: boolean }[];
	unloadedHistoryIds?: string[];
};
const replyPayload = (reply: { content: { text: string }[] }) => JSON.parse(reply.content[0]!.text) as ReplyShape;

function manyParts(itemCount: number): UserHistoryItem {
	return userItem("many-parts", Array.from({ length: itemCount }, (_, index) => ({
		type: "text" as const, text: `part ${index}: ${"content".repeat(28)}`,
	})));
}

test("part pages tile the whole list exactly once, each page inside the reply budget", () => {
	const item = manyParts(400);
	const expected = historyParts(item).map(part => part.part);
	assert.ok(expected.length > 1, "the fixture must produce multiple parts");
	const seen: string[] = [];
	let offset = 0, pages = 0;
	for (;;) {
		const page = historyPartsPage(item, offset);
		assert.ok(fitsRecoveryResponse(page), `the page starting at ${offset} must fit the reply budget`);
		assert.ok(page.parts.length >= 1, `a non-terminal page at ${offset} must show at least one part`);
		seen.push(...page.parts.map(part => part.part));
		pages += 1;
		if (page.nextOffset === null) break;
		assert.ok(page.nextOffset > offset, "each page must advance, or paging never terminates");
		offset = page.nextOffset;
		assert.ok(pages < 200, "paging must terminate");
	}
	assert.ok(pages > 1, "the budget must actually cut this part list into several pages");
	assert.deepEqual(seen, expected);
	// The offset past the last part is a valid, empty terminal page.
	const terminal = historyPartsPage(item, expected.length);
	assert.deepEqual(terminal.parts, []);
	assert.equal(terminal.nextOffset, null);
	assert.equal(terminal.totalParts, expected.length);
});

test("a limit caps the descriptions per page and paging still covers every part", () => {
	const item = manyParts(60);
	const expected = historyParts(item).map(part => part.part);
	const seen: string[] = [];
	let offset = 0, pages = 0;
	for (;;) {
		const page = historyPartsPage(item, offset, 3);
		assert.ok(page.parts.length <= 3, `a limit of 3 must cap the page, got ${page.parts.length}`);
		seen.push(...page.parts.map(part => part.part));
		pages += 1;
		if (page.nextOffset === null) break;
		offset = page.nextOffset;
		assert.ok(pages < 200, "paging must terminate");
	}
	assert.deepEqual(seen, expected);
});

test("part-page arguments from the model are refused, not clamped", () => {
	const item = manyParts(4);
	const parts = historyParts(item).length;
	assert.throws(() => historyPartsPage(item, -1), /Invalid part-list offset/);
	assert.throws(() => historyPartsPage(item, parts + 1), /Invalid part-list offset/);
	assert.throws(() => historyPartsPage(item, 1.5), /Invalid part-list offset/);
	assert.throws(() => historyPartsPage(item, 0, 0), /Invalid part-list limit/);
	assert.throws(() => historyPartsPage(item, 0, MAXIMUM_PAGE_LIMIT + 1), /Invalid part-list limit/);
	assert.throws(() => historyPartsPage(item, 0, 2.5), /Invalid part-list limit/);
});

test("a crowded reply keeps every identifier and spends the freed budget on the smallest content", () => {
	const items: RecoveryHistoryItem[] = [
		userItem("item-huge", "u".repeat(5_000)),
		...Array.from({ length: 12 }, (_, index) => userItem(`item-m-${index}`, "m".repeat(1_500))),
	];
	// One fat preview is worth more than a dozen cheap ones, so giving it up is what frees the budget.
	const references = [reference("item-huge", "F".repeat(14_000)),
		...Array.from({ length: 12 }, (_, index) => reference(`item-m-${index}`, "s".repeat(60)))];
	const reply = boundedHistoryReply(items, references);
	assert.ok(replyBytes(reply) <= MAXIMUM_RECOVERY_REPLY_BYTES, `reply used ${replyBytes(reply)} bytes`);
	const payload = replyPayload(reply) as ReplyShape;
	assert.deepEqual(payload.items.map(item => item.id), items.map(item => item.id), "every item keeps a row");
	assert.deepEqual(payload.references.map(row => row.historyId), references.map(row => row.historyId), "every reference keeps a row");
	const inlined = payload.items.filter(item => !item.deferred).map(item => item.id);
	assert.ok(inlined.length > 0 && inlined.length < items.length, `the budget must bind, not truncate: ${inlined.length} inlined`);
	assert.ok(!inlined.includes("item-huge"), "the largest item gives way so more items get content");
	assert.ok(inlined.length >= 2, "several smaller items must be served, not one large one");
	assert.ok(payload.references.some(row => row.detailsDeferred === true), "reference previews are given up before item content is dropped");
	assert.ok(payload.references.slice(1).every(row => typeof row.preview === "string"), "only the fat preview pays; the cheap ones survive");
});

test("reference metadata is compacted largest-first, so cheap rows keep their detail", () => {
	const references = [reference("ref-fat", "F".repeat(14_000)),
		...Array.from({ length: 39 }, (_, index) => reference(`ref-s-${index}`, "s".repeat(60)))];
	const reply = boundedHistoryReply([], references);
	assert.ok(replyBytes(reply) <= MAXIMUM_RECOVERY_REPLY_BYTES, `reply used ${replyBytes(reply)} bytes`);
	const rows = (replyPayload(reply) as ReplyShape).references;
	assert.deepEqual(rows.map(row => row.historyId), references.map(row => row.historyId), "every reference keeps a row");
	assert.equal(rows[0]?.detailsDeferred, true, "the fattest preview is the one given up");
	assert.ok(rows.slice(1).every(row => typeof row.preview === "string"), "cheap previews survive when one fat one can pay");
});

test("an image is always deferred, however small, and arrives with a read handle", () => {
	const reply = boundedHistoryReply([imageItem("item-image", 8)]);
	const payload = replyPayload(reply) as ReplyShape;
	const row = payload.items[0]!;
	assert.equal(row.deferred, true, "base64 in a text reply is not content the model can use");
	assert.ok((row.totalParts ?? 0) >= 1, "a deferred row must report its parts");
	assert.deepEqual(row.readParts, { historyId: "item-image", mode: "parts", offset: 0 });
	assert.ok(replyBytes(reply) <= MAXIMUM_RECOVERY_REPLY_BYTES);
});

test("history ids with no matching item are named as unloaded, with a usable continuation", () => {
	const items = [userItem("item-a", "alpha"), userItem("item-b", "beta")];
	const references = [reference("item-a", "a"), reference("item-b", "b"), reference("item-c", "c"), reference("item-d", "d")];
	const payload = replyPayload(boundedHistoryReply(items, references));
	assert.deepEqual(payload.unloadedHistoryIds, ["item-c", "item-d"]);
	for (const item of payload.items ?? []) {
		if (!item.deferred) continue;
		assert.ok(Array.isArray(item.parts), `${item.id} must describe its parts so the model can ask for one`);
		if (item.nextPartOffset === null) assert.equal(item.parts!.length, item.totalParts);
		else assert.equal(item.readParts?.offset, item.nextPartOffset, "the read handle must point at the first undescribed part");
	}
});

test("a reference list whose reserved identifiers alone exceed the budget fails closed", () => {
	// Tool callers are capped (historyIds ≤ 3, navigator results ≤ 10), so this exercises the guard
	// itself: reserving every identifier must not be silently truncated into a partial reply.
	const references = Array.from({ length: 400 }, (_, index) => reference(`item-${index}`, "x"));
	assert.throws(() => boundedHistoryReply([], references), /16 KiB/);
});
