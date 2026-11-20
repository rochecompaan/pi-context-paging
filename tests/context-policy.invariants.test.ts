import assert from "node:assert/strict";
import test from "node:test";
import { selectContext, type ContextSelection } from "../src/context-policy.ts";
import { rawCutFrontierResolves, type ContextCutSnapshot } from "../src/context-cut.ts";
import { appendExchange, completeTurn, fixtureFromEntries, type PagingFixture } from "./fixtures/context-cut.ts";

/**
 * The paging contracts that scenario tests check one situation at a time, checked across a
 * deterministic session: every request stays inside the budget, real messages keep their order,
 * a committed frontier resolves against raw history, and an advanced cut never resurrects what it
 * evicted. Seeded so a failure reproduces exactly.
 */
const SEED = 0x5eed2026;

function randomGenerator(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state = state + 0x6D2B79F5 | 0;
		let mixed = Math.imul(state ^ state >>> 15, 1 | state);
		mixed = mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed) ^ mixed;
		return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
	};
}

/** Raw items are the provenance the frontier is addressed by; item order is eviction order. */
function ownerId(items: PagingFixture["input"]["rawHistoryItems"], message: unknown): number {
	const list = items ?? [];
	return list.findIndex((item) => item.kind === "user"
		? item.userMessage === message
		: item.assistantMessage === message || item.toolResults.some((result) => result === message));
}

function runSession(steps: number, limits: { tokenBudget: number, trimToTokens: number, modelContextWindow: number }): void {
	const next = randomGenerator(SEED);
	let fixture = fixtureFromEntries([]);
	let cutState: ContextCutSnapshot | undefined;
	let rotated = 0;

	for (let step = 0; step < steps; step++) {
		fixture = completeTurn(fixture, `u${step}`);
		fixture = appendExchange(fixture, `t${step}`, 40 + Math.floor(next() * 700));
		if (next() < 0.4) fixture = appendExchange(fixture, `f${step}`, 40 + Math.floor(next() * 400));
		const input = fixture.input;
		const rotate = next() < 0.2;
		if (rotate) rotated++;
		let selection: ContextSelection;
		try {
			selection = selectContext({
				...input,
				tokenBudget: limits.tokenBudget,
				trimToTokens: limits.trimToTokens,
				modelContextWindow: limits.modelContextWindow,
				contextTokens: limits.tokenBudget + 1,
				rotate,
				cutState,
			});
		} catch (error) {
			// Only the documented budget rejections are legal: nothing older can be evicted.
			assert.ok(["ACTIVE_REQUEST_TOO_LARGE", "RESIDENT_INPUT_TOO_LARGE"].includes(String((error as { code?: string }).code ?? "")),
				`step ${step}: unexpected failure ${(error as Error).message}`);
			continue;
		}

		const outgoing = selection.messages;
		if (selection.mode === "paged" || selection.mode === "within-budget") {
			assert.ok(selection.estimatedTokens <= limits.tokenBudget,
				`step ${step}: mode ${selection.mode} estimate ${selection.estimatedTokens} exceeds budget ${limits.tokenBudget}`);
		}

		// Injected notices and recovery replacements are new objects; history messages keep their order.
		let cursor = 0;
		for (const message of outgoing) {
			const at = outgoing === input.messages ? 0 : input.messages.indexOf(message, cursor);
			if (at >= 0) cursor = at + 1;
			else assert.ok(!input.messages.includes(message), `step ${step}: outgoing request reorders incoming messages (mode ${selection.mode})`);
		}

		const committed = selection.cutState;
		if (committed) {
			assert.ok(rawCutFrontierResolves(input.rawHistoryItems, committed.frontier),
				`step ${step}: committed frontier does not resolve against raw history`);
		}
		if (cutState && (selection.mode === "paged" || selection.mode === "within-budget")) {
			const ids = (input.rawHistoryItems ?? []).map((item) => item.id);
			const evictedIndex = ids.indexOf(cutState.frontier.lastEvicted.historyId);
			// A partialTurn frontier evicts the completed part of an exchange and keeps its request.
			const kept = cutState.frontier.kind === "partialTurn" ? cutState.frontier.userHistoryId : undefined;
			for (const message of outgoing) {
				const at = ownerId(input.rawHistoryItems, message);
				assert.ok(at < 0 || at > evictedIndex || ids[at] === kept,
					`step ${step}: mode ${selection.mode} resurrects evicted item ${ids[at]} behind frontier ${cutState.frontier.lastEvicted.historyId}`);
			}
		}
		if (committed) cutState = committed;
	}
	assert.ok(rotated > 0, "the seeded session issued no rotations, so rotation is untested here");
}

test("stateful paging keeps every request inside the budget, ordered, and behind its cut", () => {
	runSession(120, { tokenBudget: 4000, trimToTokens: 2500, modelContextWindow: 120_000 });
});

test("the same contracts hold when a smaller model window scales the budget and the trim target", () => {
	runSession(120, { tokenBudget: 4000, trimToTokens: 2500, modelContextWindow: 3000 });
});
