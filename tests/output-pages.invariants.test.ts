import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryItem, ModelTurnHistoryItem } from "../src/history.ts";
import { contextOutputTexts, readContextOutput } from "../src/output-pages.ts";
import { publicHistoryItem, recoveryPartText } from "../src/recovery-parts.ts";
import { fitsRecoveryText } from "../src/recovery-response.ts";

/**
 * `read_context_output` is how the agent rebuilds a large tool result, and `header.next` is the only continuation
 * handle it gets. The contract is a tiling property, not a shape: pages read in sequence must reproduce the stored
 * part exactly.
 *
 * Every failure mode here is silent and agent-visible: a gap truncates history without saying so, an overlap makes
 * the model read duplicated text and distrust its own context, a non-advancing `nextOffset` is a request-burning
 * loop, and a boundary inside a surrogate pair yields text that no longer matches the stored bytes. The
 * example-based tests in tests/output-pages.test.ts cover representative shapes; this generates content mixing
 * surrogate pairs, combining marks, ZWJ sequences, control characters, and lone surrogates — characters that grow
 * when serialized — and pages it under small limits, where boundary arithmetic and the reply-size budget interact.
 */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// A lone high surrogate is legal in a JS string and reachable from truncated provider output; `é` in both forms,
// `"`, `\` and newlines grow under serialization, which is what squeezes the page budget.
const PIECES = ["a", "b", " ", "\n", "\t", "\"", "\\", "é", "é", "🧠", "𝕏", "👨‍👩‍👧", "\ud800", "\udfffx", "中"];

function sampleText(next: () => number, pieces: number): string {
	let text = "";
	for (let index = 0; index < pieces; index += 1) text += PIECES[Math.floor(next() * PIECES.length)];
	return text;
}

function fixture(text: string): { items: HistoryItem[]; historyId: string; toolCallId: string; part: string } {
	const turn: ModelTurnHistoryItem = {
		id: "turn-generated",
		kind: "modelTurn",
		sequence: 0,
		timestamp: "2026-09-21T00:00:00.000Z",
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text: "assistant lead-in" }],
			stopReason: "toolUse",
			timestamp: 1,
		} as any,
		toolResults: [{
			role: "toolResult",
			toolCallId: "call-generated",
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 2,
		} as any],
		metadata: { tools: ["read"], files: [], failed: false },
	};
	const part = "/toolResults/0";
	return { items: [turn], historyId: turn.id, toolCallId: "call-generated", part };
}

/** The bytes the host actually stores for the part — serialized, with escapes — is what the pages must tile. */
function canonical({ items, historyId, part }: { items: HistoryItem[]; historyId: string; part: string }): string {
	return recoveryPartText(publicHistoryItem(items, historyId), part).text;
}

const LIMITS: (number | undefined)[] = [1, 2, 3, 5, 17, 64, 300, 2000, undefined];

test("pages tile the stored part exactly for every generated content and limit", () => {
	let pages = 0;
	let acceptedTooSmall = 0;
	for (let seed = 1; seed <= 24; seed += 1) {
		const next = random(seed);
		const { items, historyId, toolCallId, part } = fixture(sampleText(next, 4 + Math.floor(next() * 220)));
		const stored = canonical({ items, historyId, part });
		for (const limit of LIMITS) {
			let offset = 0;
			let collected = "";
			let readPages = 0;
			// Every page advances at least one code unit, so this bounds any single read.
			const pageCap = stored.length * 2 + 50;
			let stop: "end" | "too-small" = "end";
			try {
				for (;;) {
					pages += 1;
					readPages += 1;
					assert.ok(readPages <= pageCap, `seed ${seed} limit ${limit}: ${readPages} pages for a ${stored.length}-code-unit part, so paging is not advancing`);
					const page = readContextOutput(items, {
						historyId,
						...(limit === undefined ? {} : { limit }),
						...(offset === 0 ? { source: "toolResult" as const, toolCallId } : { part, offset }),
					});

					// A page has to be returnable: the reply budget caps it, `limit` only asks.
					assert.ok(fitsRecoveryText(contextOutputTexts(page)), `seed ${seed}: page exceeds the reply budget`);
					const { header, text } = page;
					assert.equal(header.part, part, `seed ${seed}: header names the wrong part`);
					assert.equal(header.totalCharacters, stored.length, `seed ${seed}: totalCharacters disagrees with the stored part`);
					assert.equal(header.offset, offset, `seed ${seed}: header offset is not the requested offset`);
					assert.equal(header.offset + text.length, header.nextOffset ?? stored.length, `seed ${seed}: page length disagrees with nextOffset`);
					assert.equal(stored.slice(header.offset, header.offset + text.length), text, `seed ${seed}: page is not the stored slice at its offset`);
					collected += text;

					if (header.nextOffset === null) {
						assert.equal(header.next, undefined, `seed ${seed}: final page offers a continuation`);
						assert.equal(header.offset + text.length, stored.length, `seed ${seed}: paging stopped before the end`);
						break;
					}
					assert.ok(header.next, `seed ${seed}: nextOffset without a next handle`);
					assert.equal(header.next.offset, header.nextOffset, `seed ${seed}: next handle does not continue this page`);
					assert.ok(header.nextOffset > offset, `seed ${seed}: nextOffset does not advance (agent request loop)`);
					assert.ok(header.nextOffset <= stored.length, `seed ${seed}: nextOffset runs past the stored part`);
					if (limit !== undefined) assert.equal(header.next.limit, limit, `seed ${seed}: next handle drops the caller's limit`);
					offset = header.nextOffset;
				}
			} catch (error) {
				// Documented contract: a limit that cannot fit one whole character is an explicit, actionable error
				// rather than a page that silently truncates. What was read before it must still be a clean prefix.
				if (!/too small for the next Unicode character/.test((error as Error).message)) throw error;
				acceptedTooSmall += 1;
				stop = "too-small";
			}
			if (stop === "end") {
				assert.equal(collected, stored, `seed ${seed} limit ${limit}: paged text is not the stored part`);
			} else {
				assert.ok(stored.startsWith(collected), `seed ${seed} limit ${limit}: partial read is not a prefix`);
			}
		}
	}
	assert.ok(pages >= 500, `expected a broad sweep of the boundary maths, read only ${pages} pages`);
	assert.ok(acceptedTooSmall > 0, "expected the documented small-limit contract to be exercised");
});

test("offsets outside the part and inside a character are rejected, not guessed", () => {
	const setup = fixture("x\ud800\udc00y");
	const stored = canonical(setup);
	const { items, historyId, toolCallId, part } = setup;

	assert.throws(
		() => readContextOutput(items, { historyId, part, offset: stored.length + 1 }),
		/Output offset exceeds the output length/,
	);

	// Ask for the middle of the first surrogate pair in the stored text.
	const pair = [...stored].reduce((found, _, index) => {
		if (found >= 0) return found;
		return /[\uD800-\uDBFF]/u.test(stored[index - 1] ?? "") && /[\uDC00-\uDFFF]/u.test(stored[index] ?? "") ? index : found;
	}, -1);
	assert.ok(pair > 0, "fixture must contain a surrogate pair to split");
	assert.throws(
		() => readContextOutput(items, { historyId, part, offset: pair }),
		/Output offset splits a Unicode character/,
	);

	// A limit that cannot fit the whole character at that offset is the documented actionable error; the
	// alternative — an empty page whose nextOffset does not advance — is the request loop this prevents.
	assert.throws(
		() => readContextOutput(items, { historyId, part, offset: pair - 1, limit: 1 }),
		/Output limit is too small for the next Unicode character/,
	);
});
