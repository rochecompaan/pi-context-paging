import assert from "node:assert/strict";
import test from "node:test";
import { SelectionHistoryLookup } from "../src/selection-history.ts";
import type { HistoryItem } from "../src/history.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * The cut frontier stores raw history IDs and tool-call IDs, never object identities
 * (architecture.md: “A frontier uses raw `historyId` keys and tool-call IDs where present …
 * `selection-history.ts` resolves these keys”), and the recovery reference the model is handed comes
 * from the same lookup. These are the lookup's own resolution rules: what it resolves for a
 * reconstructed message, and every case where it must refuse rather than guess.
 */
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const call = (id: string, name = "bash") => ({ type: "toolCall", id, name, arguments: {} });
const result = (toolCallId: string, toolName = "bash", content = "output") =>
	({ role: "toolResult", toolCallId, toolName, content, details: {} });

function modelTurn(id: string, content: unknown[], results: unknown[] = []): HistoryItem {
	return { id, kind: "modelTurn", sequence: 1, timestamp: "2026-01-01T00:00:00.000Z",
		assistantMessage: { role: "assistant", content, timestamp: 0 },
		toolResults: results, metadata: { tools: [], files: [], failed: false } } as unknown as HistoryItem;
}
function userItem(id: string, content: string, timestamp = "2026-01-01T00:00:00.000Z"): HistoryItem {
	return { id, kind: "user", sequence: 0, timestamp, userMessage: { role: "user", content, timestamp: 0 } } as unknown as HistoryItem;
}
const messageOf = (item: HistoryItem): AgentMessage =>
	item.kind === "user" ? item.userMessage : item.assistantMessage;
const resultOf = (item: HistoryItem, index = 0): AgentMessage =>
	item.kind === "modelTurn" ? item.toolResults[index]! : (() => { throw new Error("not a model turn"); })();

const stored = [userItem("u1", "first request"),
	modelTurn("t1", [{ type: "text", text: "answer" }, call("c1")], [result("c1")]),
	modelTurn("paging", [call("p1", "search_history")], [result("p1", "search_history", "hits")])];

test("every stored message shape resolves by identity and by content", () => {
	const lookup = new SelectionHistoryLookup(stored);
	assert.equal(lookup.historyId(messageOf(stored[0]!)), "u1");
	assert.equal(lookup.historyId(clone(messageOf(stored[0]!))), "u1", "a reconstructed user message is the same history");
	assert.equal(lookup.historyId(messageOf(stored[1]!)), "t1");
	assert.equal(lookup.historyId(clone(messageOf(stored[1]!))), "t1");
	assert.equal(lookup.historyId(resultOf(stored[1]!)), "t1", "a tool result belongs to its turn");
	assert.equal(lookup.historyId(clone(resultOf(stored[1]!))), "t1");
	// The link is the call ID, so a result re-stamped on the way back into the request still resolves.
	assert.equal(lookup.historyId({ ...clone(resultOf(stored[1]!)), timestamp: 12345 } as AgentMessage), "t1",
		"a tool result is resolved by its call ID, not by its envelope");
	assert.equal(lookup.toolTurn(clone(messageOf(stored[1]!)))?.id, "t1");
	assert.equal(lookup.isLastItem(stored[2]!), true);
	assert.equal(lookup.isLastItem(stored[0]!), false);
	const empty = new SelectionHistoryLookup(undefined);
	assert.equal(empty.historyId(messageOf(stored[0]!)), undefined, "a lookup over no history resolves nothing");
	assert.equal(empty.isLastItem(stored[0]!), false);
});

test("a stored frontier key resolves again through reconstructed messages", () => {
	const lookup = new SelectionHistoryLookup(stored);
	const assistant = messageOf(stored[1]!);
	const key = lookup.cutKey(assistant)!;
	assert.deepEqual(key, { historyId: "t1", toolCallId: "c1" }, "the key is a history ID plus the exchange's call ID");
	assert.deepEqual(lookup.cutKey(clone(assistant)), key, "the same key is produced after the session is re-read");
	assert.deepEqual(lookup.cutKey(messageOf(stored[0]!)), { historyId: "u1" }, "a request envelope has no call ID");
	assert.equal(lookup.matchesCutKey(clone(assistant), key), true);
	assert.equal(lookup.matchesCutKey(clone(assistant), { historyId: "t2", toolCallId: "c9" }), false, "a foreign key never matches");
	assert.equal(lookup.matchesCutKey(clone(resultOf(stored[1]!)), key), false, "a tool result carries no cut provenance");
	// A message that is not a stored message (a text-only slice of a turn) must not resolve to that turn.
	const partial = { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 0 } as AgentMessage;
	assert.equal(lookup.cutKey(partial), undefined);
	assert.equal(lookup.matchesCutKey(partial, key), false, "a turn-level key is not matched by a partial message");
	assert.equal(lookup.matchesCutKey(partial, { historyId: "t1" }), false);
	// A reworded request sharing the stored envelope's timestamp is a different message, not a copy.
	const reworded = { role: "user", content: "a different request", timestamp: 0 } as AgentMessage;
	assert.equal(lookup.historyId(reworded), undefined);
	assert.equal(lookup.cutKey(reworded), undefined, "the only candidate in the envelope bucket is not adopted");
	assert.deepEqual(lookup.cutKey({ role: "user", content: "first request", timestamp: 0 } as AgentMessage), { historyId: "u1" },
		"an exact copy does resolve");
});

test("a frontier keyed on any call of a multi-call exchange matches that exchange", () => {
	const multi = modelTurn("t9", [call("cA"), call("cB")]);
	const lookup = new SelectionHistoryLookup([multi]);
	assert.deepEqual(lookup.cutKey(messageOf(multi)), { historyId: "t9", toolCallId: "cA" }, "the key names one call canonically");
	assert.equal(lookup.matchesCutKey(messageOf(multi), { historyId: "t9", toolCallId: "cB" }), true, "membership, not position");
	assert.equal(lookup.matchesCutKey(clone(messageOf(multi)), { historyId: "t9", toolCallId: "cB" }), true);
	assert.equal(lookup.matchesCutKey(clone(messageOf(multi)), { historyId: "t9", toolCallId: "cZ" }), false);
});

test("recovery lookup accepts a reused call ID where cut provenance refuses it", () => {
	const reused = [modelTurn("a", [call("shared")], [result("shared", "bash", "one")]),
		modelTurn("b", [call("shared")], [result("shared", "bash", "two")])];
	const lookup = new SelectionHistoryLookup(reused);
	assert.notEqual(lookup.historyId(clone(messageOf(reused[0]!))), undefined, "recovery lookup resolves the reused call");
	assert.equal(lookup.cutKey(clone(messageOf(reused[0]!))), undefined, "cut provenance never guesses from a reused call ID");
	assert.equal(lookup.cutKey(messageOf(reused[0]!)), undefined, "not even for the stored object itself");
	assert.equal(lookup.matchesCutKey(clone(messageOf(reused[0]!)), { historyId: "b", toolCallId: "shared" }), false,
		"a frontier written for one exchange must not land on the other");
});

test("ambiguous history resolves to nothing instead of picking a side", () => {
	const timestamp = "2026-02-02T00:00:00.000Z";
	const twins = new SelectionHistoryLookup([userItem("ta", "alpha", timestamp), userItem("tb", "beta", timestamp)]);
	assert.equal(twins.historyId(clone(messageOf(userItem("tb", "beta", timestamp)))), "tb",
		"same-role, same-timestamp messages are told apart by content");
	assert.deepEqual(twins.cutKey(clone(messageOf(userItem("ta", "alpha", timestamp)))), { historyId: "ta" });
	const identical = new SelectionHistoryLookup([userItem("ta", "alpha", timestamp), userItem("tb", "alpha", timestamp)]);
	assert.equal(identical.historyId(clone(messageOf(userItem("ta", "alpha", timestamp)))), "ta", "an exact duplicate resolves to the first stored item");
	assert.equal(identical.cutKey(clone(messageOf(userItem("ta", "alpha", timestamp)))), undefined,
		"an exact duplicate is never a cut anchor, so the selector falls back rather than evicting the wrong history");
	// A history ID used by two items is not a stable reference at all.
	const duplicateIds = [userItem("dup", "text"), modelTurn("dup", [call("c1")], [result("c1")])];
	const dup = new SelectionHistoryLookup(duplicateIds);
	assert.equal(dup.recoverableId("dup"), undefined);
	assert.equal(dup.cutKey(messageOf(duplicateIds[1]!)), undefined);
});

test("recovery references refuse paging activity and keep the ordinary work", () => {
	const lookup = new SelectionHistoryLookup(stored);
	assert.equal(lookup.recoveryHistoryId(messageOf(stored[1]!)), "t1", "ordinary work is recoverable");
	assert.equal(lookup.recoveryHistoryId(messageOf(stored[2]!)), undefined, "a paging-only turn is not public history");
	assert.equal(lookup.recoverableId("paging"), undefined);
	assert.equal(lookup.recoverableId("no-such-id"), undefined);
	assert.equal(lookup.recoverableId(undefined), undefined);
	const mixed = modelTurn("mix", [call("p2", "browse_history"), call("b2", "bash")],
		[result("p2", "browse_history", "hits"), result("b2", "bash", "listing")]);
	const mixedLookup = new SelectionHistoryLookup([mixed]);
	assert.equal(mixedLookup.recoveryToolTurn(resultOf(mixed, 1) as never)?.id, "mix", "the ordinary call in a mixed turn keeps its reference");
	assert.equal(mixedLookup.recoveryToolTurn(resultOf(mixed, 0) as never), undefined, "the paging call keeps none");
	// A call with no stored result is not recoverable output, even though the call is known.
	const noResult = modelTurn("t3", [call("cA")]);
	assert.equal(new SelectionHistoryLookup([noResult]).recoveryToolTurn(result("cA") as never), undefined);
});
