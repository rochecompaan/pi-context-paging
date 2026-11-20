import assert from "node:assert/strict";
import test from "node:test";
import { rmSync, writeFileSync } from "node:fs";
import { contextPagingStats, reportedInputTokens } from "../src/stats.ts";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * The stats command is the only place the user reads what paging costs, so its report is asserted as
 * behaviour: the provider-counted input, the effective budget, and the design rule that a missing
 * measurement says `unavailable` rather than a plausible zero (design 2026-10-05:31,40).
 */
const usage = (counters: Record<string, number>) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...counters });

const assistant = (id: string, counters: Record<string, number>, stopReason = "stop"): SessionEntry =>
	({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: usage(counters), stopReason } }) as unknown as SessionEntry;
const user = (id: string, text: string): SessionEntry =>
	({ type: "message", id, message: { role: "user", content: text } }) as unknown as SessionEntry;
const providerUsage = (id: string, counters: Record<string, unknown>): SessionEntry =>
	({ type: "usage", id, usage: counters }) as unknown as SessionEntry;
const toolResult = (id: string, counters?: Record<string, number>): SessionEntry =>
	({ type: "message", id, message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: "output", ...(counters ? { usage: usage(counters) } : {}) } }) as unknown as SessionEntry;

function contextFor(entries: SessionEntry[], options: { window?: number; file?: string; mode?: "tui" | "cli" } = {}) {
	const theme = { fg: (role: string, text: string) => `[${role}]${text}[/]` };
	return {
		sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionFile: () => options.file },
		model: options.window === undefined ? undefined : { contextWindow: options.window },
		mode: options.mode ?? "cli",
		ui: { theme, notify: () => {} },
	} as unknown as ExtensionContext;
}

/** Rows are `  Label   value`; read them as a map so padding changes stay harmless. */
function rows(report: string): Map<string, string> {
	const parsed = new Map<string, string>();
	for (const line of report.split("\n")) {
		const match = /^ {2}(.+?) {2,}(.*)$/.exec(line);
		if (match) parsed.set(match[1]!, match[2]!);
	}
	return parsed;
}

test("the reported request input is the whole sent context, never the reply", async () => {
	const sent = { role: "assistant", stopReason: "stop", usage: usage({ input: 100, output: 40, cacheRead: 500, cacheWrite: 20 }) };
	assert.deepEqual(reportedInputTokens(sent as never), { tokens: 620, estimated: false }, "input + cacheRead + cacheWrite, output excluded");
	assert.equal(reportedInputTokens({ ...sent, stopReason: "aborted" } as never), undefined, "an aborted request has no measured input");
	assert.equal(reportedInputTokens({ ...sent, stopReason: "error" } as never), undefined);
	assert.equal(reportedInputTokens({ role: "assistant", stopReason: "stop", usage: { input: 10, output: 2 } } as never), undefined, "partial counters are not a measurement");
	assert.equal(reportedInputTokens({ role: "assistant", stopReason: "stop", usage: usage({}) } as never), undefined, "synthetic zero usage is not a measurement");
	assert.equal(reportedInputTokens({ role: "assistant", stopReason: "stop", usage: { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 9, cacheWrite: 9 } } as never), undefined, "an unsafe total is refused");
	assert.equal(reportedInputTokens({ role: "user", content: "hi" } as never), undefined);
});

test("the report shows the latest measured request against the effective budget", async () => {
	const entries = [user("u1", "hello there"), assistant("a1", { input: 100, output: 5, cacheRead: 500, cacheWrite: 20 })];
	const wide = rows(await contextPagingStats(contextFor(entries, { window: 200_000 }), true, 50_000));
	assert.equal(wide.get("Input tokens"), "620");
	assert.equal(wide.get("Paging budget"), "50,000   (1.2% used)");
	assert.equal(wide.get("Model window"), "200,000");
	// A smaller model window is the effective budget, so the utilisation percentage moves with it.
	const tight = rows(await contextPagingStats(contextFor(entries, { window: 1_000 }), true, 50_000));
	assert.equal(tight.get("Paging budget"), "1,000   (62.0% used)");
	assert.equal(tight.get("Model window"), "1,000");
});

test("missing measurements read as unavailable, not as zero", async () => {
	const entries = [user("u1", "hello there"), assistant("a1", { input: 100, output: 5, cacheRead: 500, cacheWrite: 20 })];
	const empty = rows(await contextPagingStats(contextFor([user("u1", "first turn")], {}), true, 50_000));
	assert.equal(empty.get("Input tokens"), "unavailable", "no measured request yet");
	assert.equal(empty.get("Model window"), "unavailable");
	assert.equal(empty.get("Stored size"), "unavailable");
	const off = rows(await contextPagingStats(contextFor(entries, { window: 200_000 }), false, 50_000, { tokens: 12_345, estimated: true }));
	assert.equal(off.get("Paging budget"), "50,000   (inactive)", "a disabled budget reports no utilisation");
	assert.equal(off.get("Input tokens"), "~12,345", "estimates are marked");
	// A compaction after the last measured request means that measurement describes a previous context.
	const compacted = rows(await contextPagingStats(contextFor([...entries, { type: "compaction", id: "c1", summary: "s", usage: usage({ input: 1 }) } as unknown as SessionEntry], { window: 200_000 }), true, 50_000));
	assert.equal(compacted.get("Input tokens"), "unavailable");
});

test("whole-session cache totals sum every recorded usage and refuse partial records", async () => {
	const entries = [assistant("a1", { input: 100, output: 5, cacheRead: 500, cacheWrite: 20 }),
		providerUsage("us1", usage({ cacheRead: 7, cacheWrite: 3 })), toolResult("t1", { cacheRead: 1 }),
		{ type: "compaction", id: "c1", summary: "s", usage: usage({ cacheRead: 2, cacheWrite: 4 }) } as unknown as SessionEntry, toolResult("t2")];
	const totals = rows(await contextPagingStats(contextFor(entries, { window: 200_000 }), true, 50_000));
	assert.equal(totals.get("Tokens read"), "510");
	assert.equal(totals.get("Tokens written"), "27");
	const partial = rows(await contextPagingStats(contextFor([...entries, providerUsage("us2", { input: 1, output: 1 })], { window: 200_000 }), true, 50_000));
	assert.equal(partial.get("Tokens read"), "unavailable", "an incomplete record makes the whole-session total unavailable, not short");
	assert.equal(partial.get("Tokens written"), "unavailable");
});

test("history tokens follow the content of a context edit's replacement", async () => {
	const base = [user("u1", "short note"), assistant("a1", { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })];
	const edit = (id: string, content: string): SessionEntry =>
		({ type: "context_edit", id, targetId: "u1", replacement: { content } }) as unknown as SessionEntry;
	const tokens = async (entries: SessionEntry[]) => {
		const value = rows(await contextPagingStats(contextFor(entries, { window: 200_000 }), true, 50_000)).get("History tokens")!;
		assert.match(value, /^~[\d,]+$/, "history tokens are reported as an estimate");
		return Number(value.slice(1).replace(/,/g, ""));
	};
	const stored = await tokens(base);
	const editedShort = await tokens([...base, edit("ce1", "brief replacement")]);
	const editedLong = await tokens([...base, edit("ce1", "a very long replacement describing the edited message content in detail, twice over, with room to spare")]);
	assert.ok(editedShort > stored, `an edit stores content (${stored} → ${editedShort})`);
	assert.ok(editedLong > editedShort, `the replacement's own content drives the count (${editedShort} → ${editedLong})`);
});

test("the report is plain text outside the TUI and themed inside it", async () => {
	const entries = [assistant("a1", { input: 10, output: 1, cacheRead: 1, cacheWrite: 1 })];
	const plain = await contextPagingStats(contextFor(entries, { window: 200_000, mode: "cli" }), true, 50_000);
	assert.ok(!plain.includes("[text]") && !plain.includes("[mdHeading]"), "no theme markup leaks into a plain notification");
	const themed = await contextPagingStats(contextFor(entries, { window: 200_000, mode: "tui" }), true, 50_000);
	assert.ok(themed.includes("[mdHeading]") && themed.includes("[mdCode]"), "the TUI renders the report through the theme");
});

test("stored size reports the saved session file, not the paged projection", async () => {
	const path = `/tmp/pi-context-paging-stats-${process.pid}.jsonl`;
	writeFileSync(path, "x".repeat(3000));
	try {
		const report = rows(await contextPagingStats(contextFor([], { window: 200_000, file: path }), true, 50_000));
		assert.equal(report.get("Stored size"), "2.93 KiB");
		const tiny = `/tmp/pi-context-paging-stats-tiny-${process.pid}.jsonl`;
		writeFileSync(tiny, "abc");
		assert.equal(rows(await contextPagingStats(contextFor([], { window: 200_000, file: tiny }), true, 50_000)).get("Stored size"), "3 B");
		rmSync(tiny);
	} finally {
		rmSync(path);
	}
});
