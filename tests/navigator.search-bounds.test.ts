import assert from "node:assert/strict";
import test from "node:test";
import { HistoryNavigator } from "../src/navigator.ts";
import type { HistoryItem, ModelTurnHistoryItem } from "../src/history.ts";

/**
 * `search_history` exists to hand the agent a *bounded* slice of history, and the bound is enforced twice: the tool
 * schema (`src/tools.ts:33`, `minimum: 1, maximum: 10, default: 5`) and the navigator itself
 * (`src/navigator.ts:253`, `boundedInteger(input.limit, "limit", 1, 10)`.
 *
 * Only the schema is pinned. Measured: widening the navigator's own maximum to 1000 leaves the whole suite green, so
 * the second line of defence — the one that holds for every caller of `HistoryNavigator`, not just the schema-bound
 * tool path — can be erased silently. A search that returns hundreds of references is the failure this tool exists to
 * prevent: it re-inflates the context it was added to shrink.
 *
 * The equal-score ordering pin below is deliberately framed as order-preservation, not as "the tie-break is
 * load-bearing": `rebuild` assigns `sequence` by position (`src/navigator.ts:239`), so removing
 * `|| left.item.sequence - right.item.sequence` is an **equivalent mutant** — ES2019 mandates a stable sort, so
 * equal scores keep history order either way. What the pin defends is any future tie-break that is not history
 * order (a Map-iteration or recency-based one), which would make the same query return a different order to the same
 * agent between turns.
 */
function matchingTurn(index: number): HistoryItem {
	const turn: ModelTurnHistoryItem = {
		id: `turn-${index}`,
		kind: "modelTurn",
		sequence: 0,
		timestamp: `2026-09-21T00:00:${String(index).padStart(2, "0")}Z`,
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text: "planning the needle" }],
			stopReason: "toolUse",
			timestamp: index * 2,
		} as any,
		toolResults: [{
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "read",
			content: [{ type: "text", text: "the needle appears here once" }],
			isError: false,
			timestamp: index * 2 + 1,
		} as any],
		metadata: { tools: ["read"], files: [], failed: false },
	};
	return turn;
}

function navigatorWith(items: number): HistoryNavigator {
	return new HistoryNavigator(Array.from({ length: items }, (_, index) => matchingTurn(index)));
}

test("search caps its reply at the documented default and maximum", () => {
	const navigator = navigatorWith(14);
	const all = navigator.search({ query: "needle", limit: 10 });
	assert.equal(all.length, 10, "limit 10 is the documented maximum reply size");
	assert.equal(navigator.search({ query: "needle" }).length, 5, "the documented default reply size is 5");

	for (const limit of [11, 12, 0, -3, 2.5, Number.NaN, "7"]) {
		assert.throws(
			() => navigator.search({ query: "needle", limit: limit as number }),
			/limit must be an integer from 1 to 10/,
			`limit ${String(limit)} must be refused by the navigator, not just by the tool schema`,
		);
	}
});

test("every accepted limit is honoured exactly", () => {
	const navigator = navigatorWith(14);
	for (const limit of [1, 2, 5, 9, 10]) {
		assert.equal(navigator.search({ query: "needle", limit }).length, limit, `limit ${limit} must be honoured`);
	}
});

test("equally relevant results come back in history order, and stay that way", () => {
	const navigator = navigatorWith(12);
	const first = navigator.search({ query: "needle", limit: 10 });
	assert.equal(first.length, 10);
	const sequences = first.map((reference) => reference.sequence);
	assert.deepEqual(sequences, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "equal scores must keep history order");
	const ids = first.map((reference) => reference.historyId);
	assert.deepEqual(ids, Array.from({ length: 10 }, (_, index) => `turn-${index}`));

	// Same history, rebuilt: the agent re-running one query between turns must not see a reshuffled answer.
	const rebuilt = navigatorWith(12);
	assert.deepEqual(rebuilt.search({ query: "needle", limit: 10 }).map((reference) => reference.historyId), ids);
});
