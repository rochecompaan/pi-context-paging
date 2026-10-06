import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { SessionManager, Theme, type ExtensionContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import contextPagingExtension from "../src/index.ts";

type Handler = (event: any, ctx: any) => unknown;
const user = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
const usage = (cacheRead = 120, cacheWrite = 20, input = 5, output = 9): Usage => ({
	input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const assistant = (reported: unknown = usage()) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "abcd" }],
	api: "openai-codex-responses" as const, provider: "openai-codex", model: "fixture",
	usage: reported as Usage, stopReason: "stop" as const, timestamp: 0,
});

function statsTheme(light = false): Theme {
	// A real Theme with distinct colours for every role used by the notification.
	return new Theme({
		text: light ? "#111111" : "#eeeeee", dim: "#777777", muted: "#777777", thinkingXhigh: "#777777",
		mdHeading: light ? "#003399" : "#66aaff", mdCode: light ? "#006600" : "#99ff99",
	} as ConstructorParameters<typeof Theme>[0], { selectedBg: "#000000" } as ConstructorParameters<typeof Theme>[1], "truecolor");
}

function statsHarness(manager = SessionManager.inMemory(), enabled = true, tokenBudget = 128_000) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const notifications: Array<{ message: string; level: string }> = [];
	let systemPrompt = "abcd";
	let appends = 0;
	let aborts = 0;
	const ctx = {
		mode: "print" as ExtensionContext["mode"],
		hasUI: false,
		sessionManager: manager,
		model: { contextWindow: 5_000 },
		isIdle: () => true,
		getSystemPrompt: () => systemPrompt,
		getContextUsage: () => ({ tokens: 999_999, contextWindow: 5_000, percent: 100 }),
		ui: {
			theme: statsTheme(),
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
		abort: () => { aborts++; },
	};
	contextPagingExtension({
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) { commands.set(name, command); },
		registerTool() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		appendEntry() { appends++; },
	} as any, { globalSettings: { contextPaging: { enabled, tokenBudget } }, projectTrusted: false });
	const command = async (args: string) => {
		const registered = commands.get("context-paging");
		assert.ok(registered);
		await registered.handler(args, ctx as any);
	};
	return {
		ctx, notifications,
		command,
		report: async () => { await command(" stats "); return notifications.at(-1)!.message; },
		emit: async (name: string, event = {}) => await handlers.get(name)?.(event, ctx),
		setSystem: (value: string) => { systemPrompt = value; },
		appends: () => appends,
		aborts: () => aborts,
	};
}

function field(report: string, label: string): string {
	const match = report.match(new RegExp(`^\\s*${label}\\s{2,}(.+)$`, "m"));
	assert.ok(match, `Missing ${label} in:\n${report}`);
	return match[1]!;
}

test("TUI stats overrides dim notifications with Markdown headings, code on, and text elsewhere", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	const harness = statsHarness(manager);
	const plain = await harness.report();
	harness.ctx.mode = "tui";
	harness.ctx.hasUI = true;
	const theme = harness.ctx.ui.theme;
	assert.ok(theme);
	const report = await harness.report();
	assert.equal(stripVTControlCharacters(report), plain);
	assert.equal(harness.notifications.at(-1)!.level, "info");
	const lines = report.split("\n");
	assert.equal(lines[0], theme.fg("text", "Context paging: ") + theme.fg("mdCode", "on"));
	for (const line of lines.slice(1)) {
		const text = stripVTControlCharacters(line);
		if (!text) continue;
		const isHeading = /^(SESSION|CONTEXT|CACHE) —/.test(text);
		assert.equal(line, theme.fg(isHeading ? "mdHeading" : "text", text));
	}
});

test("TUI stats uses the current theme and keeps off in normal text", async () => {
	const harness = statsHarness(SessionManager.inMemory(), false);
	harness.ctx.mode = "tui";
	harness.ctx.hasUI = true;
	const dark = await harness.report();
	assert.equal(dark.split("\n")[0], harness.ctx.ui.theme.fg("text", "Context paging: off"));
	harness.ctx.ui.theme = statsTheme(true);
	assert.ok(harness.ctx.ui.theme);
	const light = await harness.report();
	assert.notEqual(light, dark);
	assert.equal(stripVTControlCharacters(light), stripVTControlCharacters(dark));
	assert.equal(light.split("\n")[0], harness.ctx.ui.theme.fg("text", "Context paging: off"));
});

test("non-TUI stats notifications remain plain text even when UI is available", async () => {
	const harness = statsHarness();
	for (const mode of ["rpc", "json", "print"] as const) {
		harness.ctx.mode = mode;
		harness.ctx.hasUI = mode === "rpc";
		const report = await harness.report();
		assert.equal(report, stripVTControlCharacters(report));
		assert.match(report, /^Context paging: on\n/);
	}
});

test("stats includes inactive history and cache usage but reports only the latest request input", async () => {
	const manager = SessionManager.inMemory();
	const root = manager.appendMessage(user("x".repeat(400)));
	manager.appendMessage(assistant(usage(120, 20)));
	manager.branch(root);
	manager.appendMessage(user("y".repeat(80)));
	manager.appendMessage(assistant(usage(200, 30, 5, 999)));
	const harness = statsHarness(manager);
	const report = await harness.report();
	assert.equal(harness.notifications.at(-1)!.level, "info");
	assert.equal(field(report, "History tokens"), "~122");
	assert.equal(field(report, "Input tokens"), "235");
	assert.equal(field(report, "Paging budget"), "5,000   (4.7% used)");
	assert.equal(field(report, "Tokens read"), "320");
	assert.equal(field(report, "Tokens written"), "50");
	assert.match(report, /Context paging: on/);
});

test("history size includes original and context-edit replacement content without duplicating provider usage", async () => {
	const manager = SessionManager.inMemory();
	const root = manager.appendMessage(user("abcd"));
	manager.appendMessage(assistant());
	manager.appendContextEdit(root, { content: "x".repeat(40) });
	const report = await statsHarness(manager).report();
	assert.equal(field(report, "History tokens"), "~12");
	assert.equal(field(report, "Tokens read"), "120");
	assert.equal(field(report, "Tokens written"), "20");
});

test("stats measures the actual session file without rewriting it", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "context-paging-stats-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage(user("é".repeat(512)));
	manager.appendMessage(assistant());
	const path = manager.getSessionFile()!;
	const before = await readFile(path);
	const bytes = (await stat(path)).size;
	const report = await statsHarness(manager).report();
	assert.equal(field(report, "Stored size"), `${(bytes / 1024).toFixed(2)} KiB`);
	assert.deepEqual(await readFile(path), before);
});

test("stats counts tool, warming, compaction, and branch-summary cache usage once", async () => {
	const manager = SessionManager.inMemory();
	const root = manager.appendMessage(user("abcd"));
	manager.appendMessage(assistant());
	manager.appendMessage({
		role: "toolResult", toolCallId: "fixture", toolName: "read", content: [{ type: "text", text: "abcd" }],
		isError: false, timestamp: 0, usage: usage(7, 1),
	} as any);
	manager.appendUsage("cache_warm", "openai-codex", "fixture", usage(11, 2));
	manager.appendCompaction("abcd", root, 1_000, undefined, false, usage(13, 3));
	manager.branchWithSummary(root, "abcd", undefined, false, usage(17, 4));
	const report = await statsHarness(manager).report();
	assert.equal(field(report, "Tokens read"), "168");
	assert.equal(field(report, "Tokens written"), "30");
});

test("missing cache components make only their whole-session total unavailable", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	const partial = { ...usage(30, 0) } as any;
	delete partial.cacheWrite;
	manager.appendMessage(assistant(partial));
	const report = await statsHarness(manager).report();
	assert.equal(field(report, "Tokens read"), "150");
	assert.equal(field(report, "Tokens written"), "unavailable");
	assert.equal(field(report, "Input tokens"), "unavailable");
});

test("recorded cache totals start at zero like the footer", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant(usage(0, 0)));
	const known = await statsHarness(manager).report();
	assert.equal(field(known, "Tokens read"), "0");
	assert.equal(field(known, "Tokens written"), "0");
	const absent = await statsHarness().report();
	assert.equal(field(absent, "Tokens read"), "0");
	assert.equal(field(absent, "Tokens written"), "0");
	assert.equal(field(absent, "Stored size"), "unavailable");
});

test("a successful response with default zero usage contributes zero cache tokens but no input measurement", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant(usage(0, 0, 0, 0)));
	const report = await statsHarness(manager).report();
	assert.equal(field(report, "Input tokens"), "unavailable");
	assert.equal(field(report, "Tokens read"), "0");
	assert.equal(field(report, "Tokens written"), "0");
});

test("failed responses with synthetic zero usage do not hide recorded cache totals", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	for (let i = 0; i < 6; i++) {
		manager.appendMessage({ ...assistant(usage(0, 0, 0, 0)), stopReason: i % 2 ? "error" : "aborted" });
	}
	let report = await statsHarness(manager).report();
	assert.equal(field(report, "Tokens read"), "120");
	assert.equal(field(report, "Tokens written"), "20");
	assert.equal(field(report, "Input tokens"), "unavailable");
	manager.appendMessage(assistant(usage(200, 30)));
	report = await statsHarness(manager).report();
	assert.equal(field(report, "Tokens read"), "320");
	assert.equal(field(report, "Tokens written"), "50");
});

test("summary entries without optional usage do not hide the footer's recorded cache totals", async () => {
	const manager = SessionManager.inMemory();
	const root = manager.appendMessage(user("abcd"));
	manager.appendMessage(assistant());
	manager.appendCompaction("abcd", root, 1_000);
	manager.branchWithSummary(root, "abcd");
	const report = await statsHarness(manager).report();
	assert.equal(field(report, "Tokens read"), "120");
	assert.equal(field(report, "Tokens written"), "20");
});

test("invalid cache counts do not become plausible totals", async () => {
	for (const cacheRead of [-1, 1.5, NaN, Infinity, "17", Number.MAX_SAFE_INTEGER + 1]) {
		const manager = SessionManager.inMemory();
		manager.appendMessage(assistant({ ...usage(0, 0), cacheRead }));
		const report = await statsHarness(manager).report();
		assert.equal(field(report, "Tokens read"), "unavailable");
		assert.equal(field(report, "Tokens written"), "0");
	}
});

test("stats uses the outgoing selection estimate including resident input when usage is unavailable", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(user("abcd"));
	const harness = statsHarness(manager);
	await harness.emit("context", { messages: manager.buildSessionProjection().messages });
	const report = await harness.report();
	// Four system characters plus the two-character [] schema estimate to two tokens; the user adds one.
	assert.equal(field(report, "Input tokens"), "~3");
	assert.match(field(report, "Paging budget"), /^5,000/);
	assert.equal(field(report, "Model window"), "5,000");
});

test("a provider response replaces an estimate with input plus cache reads and writes, not output", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(user("abcd"));
	const harness = statsHarness(manager);
	await harness.emit("context", { messages: manager.buildSessionProjection().messages });
	const response = assistant(usage(100, 20, 5, 999));
	manager.appendMessage(response);
	await harness.emit("turn_end", { message: response });
	assert.equal(field(await harness.report(), "Input tokens"), "125");
});

test("a totalTokens-only response does not fabricate measured input", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(user("abcd"));
	const harness = statsHarness(manager);
	await harness.emit("context", { messages: manager.buildSessionProjection().messages });
	const response = assistant({ totalTokens: 50 });
	manager.appendMessage(response);
	await harness.emit("turn_end", { message: response });
	assert.equal(field(await harness.report(), "Input tokens"), "~3");
});

test("session, branch, and model resets do not retain unrelated request estimates", async () => {
	for (const event of ["session_start", "session_tree", "model_select"]) {
		const manager = SessionManager.inMemory();
		manager.appendMessage(user("abcd"));
		const harness = statsHarness(manager);
		await harness.emit("context", { messages: manager.buildSessionProjection().messages });
		harness.ctx.sessionManager = SessionManager.inMemory();
		await harness.emit(event);
		assert.equal(field(await harness.report(), "Input tokens"), "unavailable");
	}
});

test("stats is read-only and preserves a committed cut even when lower estimates would otherwise restore history", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(user("x".repeat(900)));
	manager.appendMessage(assistant());
	manager.appendMessage(user("y".repeat(40)));
	const harness = statsHarness(manager, true, 300);
	harness.ctx.hasUI = true;
	(harness.ctx.ui as any).setStatus = () => assert.fail("Stats must not publish footer status");
	harness.setSystem("s".repeat(400));
	const messages = manager.buildSessionProjection().messages;
	const first = await harness.emit("context", { messages }) as any;
	assert.equal(first.messages.includes(messages[0]), false);
	harness.setSystem("abcd");
	const before = structuredClone(manager.getEntries());
	assert.match(await harness.report(), /Context paging: on/);
	await harness.report();
	const second = await harness.emit("context", { messages }) as any;
	assert.deepEqual(second.messages, first.messages);
	assert.deepEqual(manager.getEntries(), before);
	assert.equal(harness.appends(), 0);
	assert.equal(harness.aborts(), 0);
});

test("stats reflects the session override and marks the budget inactive when paging is off", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	const harness = statsHarness(manager, false);
	assert.match(await harness.report(), /Context paging: off/);
	assert.match(field(await harness.report(), "Paging budget"), /inactive/);
	await harness.command("on");
	assert.match(await harness.report(), /Context paging: on/);
	await harness.command("off");
	assert.match(await harness.report(), /Context paging: off/);
	assert.equal(field(await harness.report(), "Input tokens"), "145");
});
