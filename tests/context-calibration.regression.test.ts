import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { ContextSelectionError, selectContext } from "../src/context-policy.ts";
import { ContextUsageTracker } from "../src/context-usage.ts";
import { ContextCutState } from "../src/context-cut.ts";
import { projectActiveBranch } from "../src/history.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const call = (id: string, totalTokens?: number) => ({
	role: "assistant" as const,
	content: [{ type: "toolCall" as const, id, name: "read", arguments: { path: id } }],
	timestamp: 0,
	stopReason: "toolUse",
	usage: totalTokens === undefined ? undefined : { totalTokens },
});
const result = (id: string, text: string) => ({
	role: "toolResult" as const, toolCallId: id, toolName: "read",
	content: [{ type: "text" as const, text }], isError: false, timestamp: 0,
});

function session() {
	const tracker = new ContextUsageTracker();
	const cut = new ContextCutState();
	const entries: any[] = [];
	const resident = 37_806;
	const append = (...messages: object[]) => {
		for (const message of messages) entries.push({
			type: "message", id: `entry-${entries.length}`, timestamp: "2026-10-06T00:00:00Z", message,
		});
	};
	const select = () => {
		const messages = entries.map((entry) => entry.message);
		const rawHistoryItems = projectActiveBranch(entries);
		let responseIndex = messages.length - 1;
		while (responseIndex >= 0 && !(messages[responseIndex].usage?.totalTokens > 0)) responseIndex--;
		const contextUsage = responseIndex < 0 ? undefined : messages[responseIndex].usage.totalTokens
			+ messages.slice(responseIndex + 1).reduce((n, message) => n + estimateTokens(message), 0);
		const contextTokens = tracker.prepare(messages, resident, contextUsage, messages);
		const selected = selectContext({
			messages, systemPrompt: "s".repeat(151_222), activeTools: [],
			modelContextWindow: 1_000_000, tokenBudget: 128_000, contextTokens,
			tokenEstimates: tracker.tokenEstimates,
			rawHistoryItems, cutState: cut.prepare(rawHistoryItems),
		} as any);
		tracker.recordSelection(selected.messages, resident, messages);
		cut.commit(selected.cutState);
		return selected;
	};
	const respond = (message: object) => { append(message); tracker.recordResponse(message as any); };
	return { append, respond, select, entries };
}

// Catches treating undercounted, evictable recovery text as permanent provider overhead.
for (const warmup of [true, false]) test(`evicts consumed opaque recovery without aborting (warmup: ${warmup})`, () => {
	const s = session();
	const request = user("r".repeat(6_880));
	s.append(request);
	if (warmup) {
		s.select();
		s.respond(call("warmup", 58_000));
		s.append(result("warmup", "small result"));
	}
	s.append(call("load_history"), result("load_history", "OPAQUE_RECOVERY " + "x".repeat(300_277)));
	const recovery = s.select();
	assert.ok(recovery.messages.some((message: any) => message.toolCallId === "load_history"), "new unread recovery stays available");
	s.respond(call("after_recovery", 249_006));
	s.append(result("after_recovery", "NEWEST_RESULT " + "y".repeat(2_572)));
	const saved = JSON.stringify(s.entries);
	const selected = s.select();
	assert.equal(selected.mode, "paged");
	assert.ok(selected.estimatedTokens <= 128_000);
	assert.ok(selected.messages.includes(request));
	assert.equal(JSON.stringify(selected.messages).includes("OPAQUE_RECOVERY"), false);
	assert.equal(selected.messages.filter((message: any) => message.toolCallId === "after_recovery").length, 1);
	assert.equal(JSON.stringify(s.entries), saved, "selection does not rewrite stored history");

	s.respond(call("after_cut", 58_000));
	s.append(result("after_cut", "small next result"));
	const next = s.select();
	assert.equal(JSON.stringify(next.messages).includes("OPAQUE_RECOVERY"), false, "later usage cannot restore the evicted payload");
	assert.ok(next.estimatedTokens <= 128_000);
});

test("still rejects provider-measured resident overflow without evictable input", () => {
	const s = session();
	s.select();
	s.respond({ role: "assistant", content: [], timestamp: 0, stopReason: "stop", usage: { totalTokens: 200_000 } });
	assert.throws(() => s.select(), (error: unknown) => error instanceof ContextSelectionError
		&& error.code === "RESIDENT_INPUT_TOO_LARGE");
});

test("still rejects a genuinely oversized active request after measured recovery", () => {
	const s = session();
	s.append(user("small request"));
	s.select();
	s.respond(call("small", 58_000));
	s.append(result("small", "small result"), user("LARGE_ACTIVE_REQUEST " + "z".repeat(520_000)));
	assert.throws(() => s.select(), (error: unknown) => error instanceof ContextSelectionError
		&& error.code === "ACTIVE_REQUEST_TOO_LARGE");
});
