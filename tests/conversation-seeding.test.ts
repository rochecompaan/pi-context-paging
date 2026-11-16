import assert from "node:assert/strict";
import test from "node:test";
import { selectContext, type ContextSelection } from "../src/context-policy.ts";
import type { ContextSelectionInput } from "../src/context-policy.ts";
import type { ContextCutSnapshot } from "../src/context-cut.ts";
import { appendExchange, completeTurn, pagingFixture } from "./fixtures/context-cut.ts";

const coldCutState = (cutState: ContextCutSnapshot | undefined): ContextCutSnapshot | undefined =>
	cutState ? { ...cutState, conversation: undefined } : undefined;

/** Everything a request can observe; the conversation cache itself is not observable state. */
const observable = (selection: ContextSelection): ContextSelection => ({
	...selection,
	cutState: selection.cutState ? { ...selection.cutState, conversation: undefined } : undefined,
});

const reselect = (input: ContextSelectionInput, cutState: ContextCutSnapshot | undefined): ContextSelection =>
	selectContext({ ...input, cutState });

test("a seeded conversation record produces the same selection as a cold rebuild", () => {
	const fixture = pagingFixture("completed");
	const first = selectContext(fixture.input);
	assert.ok(first.cutState?.conversation, "a cut snapshot carries conversation records");

	const seeded = reselect(fixture.input, first.cutState);
	const cold = reselect(fixture.input, coldCutState(first.cutState));
	assert.deepEqual(observable(seeded), observable(cold), "seeding changes nothing observable");
	assert.ok(seeded.cutState?.conversation);
	assert.equal(seeded.cutState.conversation.evictedTurns, first.cutState.conversation.evictedTurns);
});

test("a seeded conversation grows as the cut advances into new completed turns", () => {
	const fixture = pagingFixture("completed");
	const first = selectContext(fixture.input);
	assert.ok(first.cutState?.conversation);
	assert.ok(first.cutState.conversation.evictedTurns >= 1, "the first cut evicted completed turns");

	const grown = appendExchange(completeTurn(fixture, "user-next"), "next-1", 30_000);
	const seeded = reselect(grown.input, first.cutState);
	const cold = reselect(grown.input, coldCutState(first.cutState));
	assert.deepEqual(observable(seeded), observable(cold));
	assert.ok(seeded.cutState?.conversation, "an advancing cut still carries conversation records");
	assert.ok(seeded.cutState.conversation.evictedTurns >= first.cutState.conversation.evictedTurns,
		"evicted turn count never regresses");
});

test("a mismatched conversation record count falls back to the cold rebuild", () => {
	const fixture = pagingFixture("completed");
	const first = selectContext(fixture.input);
	assert.ok(first.cutState?.conversation);
	const stale = { ...first.cutState, conversation: { ...first.cutState.conversation, evictedTurns: 99 } };
	const seeded = reselect(fixture.input, stale);
	const cold = reselect(fixture.input, coldCutState(first.cutState));
	assert.deepEqual(observable(seeded), observable(cold), "a stale seed changes nothing observable");
});

test("conversation records survive structuredClone like the rest of the snapshot", () => {
	const fixture = pagingFixture("completed");
	const first = selectContext(fixture.input);
	assert.ok(first.cutState);
	assert.deepEqual(structuredClone(first.cutState), first.cutState);
});

test("seeded records render the same section as a cold rebuild at every boundary", async () => {
	const { EvictedConversation } = await import("../src/paging-notice.ts");
	const ids = new Map<object, string>();
	const history = { recoveryHistoryId: (message: object) => ids.get(message) };
	// Many short requests: far more than a section showed under the old fixed cap.
	const turns = Array.from({ length: 1_000 }, (_, turn) => {
		const request = { role: "user" as const, content: `r${turn}`, timestamp: 0 };
		const reply = { role: "assistant" as const, content: [{ type: "text" as const, text: `a${turn}` }], timestamp: 0 } as any;
		ids.set(request, `u${turn}`);
		// One long id only on an old reply, which later drops out of the recent replies.
		ids.set(reply, turn === 5 ? `reply-with-a-much-longer-history-id-${turn}` : `a${turn}`);
		return [request, reply];
	});
	const cold = (count: number) => {
		const conversation = new EvictedConversation(history);
		for (const messages of turns.slice(0, count)) conversation.addTurn(messages);
		return conversation;
	};
	const render = (conversation: InstanceType<typeof EvictedConversation>) =>
		[32_000, 4_000].map((limit) => conversation.sectionLines(limit).join("\n"));

	// Seed past the stored-request cap, keep evicting, and capture records behind the live turn count.
	const seeded = EvictedConversation.fromRecords(cold(900).recordsAt(900), history);
	for (const messages of turns.slice(900)) seeded.addTurn(messages);
	for (const count of [900, 901, 950, 998, 1_000]) {
		const rebuilt = EvictedConversation.fromRecords(seeded.recordsAt(count), history);
		assert.deepEqual(render(rebuilt), render(cold(count)), `boundary ${count}`);
	}
	assert.match(render(cold(1_000))[0]!, /earlier user messages are/, "the section omits older requests");
});
