import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";
import contextPagingExtension, { type ContextPagingSettingsSources } from "../src/index.ts";

type Handler = (event: any, ctx: any) => unknown;

function statusHarness(settings?: ContextPagingSettingsSources) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const statuses = new Map<string, string>();
	const writes: Array<{ key: string; text: string | undefined }> = [];
	const ctx = {
		hasUI: true,
		cwd: tmpdir(),
		isProjectTrusted: () => false,
		sessionManager: {
			getBranch: () => [],
			buildSessionProjection: () => ({ messages: [] }),
		},
		ui: {
			notify() {},
			setStatus(key: string, text: string | undefined) {
				writes.push({ key, text });
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
	};
	contextPagingExtension({
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, command);
		},
		registerTool() {},
	} as any, settings);
	return {
		ctx, statuses, writes,
		emit: async (name: string, event = {}) => await handlers.get(name)?.(event, ctx),
		command: async (args: string) => {
			const command = commands.get("context-paging");
			assert.ok(command);
			await command.handler(args, ctx as any);
		},
	};
}

async function settingsFile(t: TestContext): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "context-paging-status-"));
	const previousHome = process.env.HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = join(home, ".pi", "agent");
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(home, { recursive: true, force: true });
	});
	await mkdir(agentDir, { recursive: true });
	return join(agentDir, "settings.json");
}

// These tests catch missing or stale footer publication at the extension boundary.
test("publishes the saved enabled and disabled state at session start", async (t) => {
	const path = await settingsFile(t);
	for (const [enabled, expected] of [[true, "paging on"], [false, "paging off"]] as const) {
		await writeFile(path, JSON.stringify({ contextPaging: { enabled } }));
		const harness = statusHarness();
		await harness.emit("session_start");
		assert.equal(harness.statuses.get("context-paging"), expected);
		assert.deepEqual(await harness.emit("session_before_compact", { reason: "threshold" }),
			enabled ? { cancel: true } : undefined);
	}
});

test("publishes the effective trusted-project state rather than the global state", async () => {
	const harness = statusHarness({
		globalSettings: { contextPaging: { enabled: true } },
		projectSettings: { contextPaging: { enabled: false } },
		projectTrusted: true,
	});
	await harness.emit("session_start");
	assert.equal(harness.statuses.get("context-paging"), "paging off");
	assert.equal(await harness.emit("session_before_compact", { reason: "threshold" }), undefined);
});

test("publishes every on and off command including repeated choices", async () => {
	const harness = statusHarness({ globalSettings: { contextPaging: { enabled: false } }, projectTrusted: false });
	await harness.emit("session_start");
	for (const action of ["on", "on", "off", "off"]) await harness.command(action);
	assert.deepEqual(harness.writes, [
		{ key: "context-paging", text: "paging off" },
		{ key: "context-paging", text: "paging on" },
		{ key: "context-paging", text: "paging on" },
		{ key: "context-paging", text: "paging off" },
		{ key: "context-paging", text: "paging off" },
	]);
});

test("restores the saved status after a session override at each session start", async (t) => {
	const path = await settingsFile(t);
	for (const [enabled, expected] of [[true, "paging on"], [false, "paging off"]] as const) {
		await writeFile(path, JSON.stringify({ contextPaging: { enabled } }));
		const harness = statusHarness();
		await harness.emit("session_start");
		for (const reason of ["new", "resume", "fork", "reload"]) {
			await harness.command(enabled ? "off" : "on");
			assert.equal(harness.statuses.get("context-paging"), enabled ? "paging off" : "paging on");
			await harness.emit("session_start", { reason });
			assert.equal(harness.statuses.get("context-paging"), expected);
		}
	}
});

test("publishes disabled fallback status when saved settings fail to load", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, JSON.stringify({ contextPaging: { enabled: true } }));
	const harness = statusHarness();
	await harness.emit("session_start");
	await harness.command("on");
	await writeFile(path, "{");
	await assert.rejects(() => harness.emit("session_start", { reason: "reload" }), SyntaxError);
	assert.equal(harness.statuses.get("context-paging"), "paging off");
	assert.equal(await harness.emit("session_before_compact", { reason: "threshold" }), undefined);
});

test("clears only its own status at session shutdown", async () => {
	const harness = statusHarness({ globalSettings: {}, projectTrusted: false });
	await harness.emit("session_start");
	harness.statuses.set("context-paging", "paging on");
	harness.statuses.set("another-extension", "keep");
	await harness.emit("session_shutdown");
	assert.equal(harness.statuses.has("context-paging"), false);
	assert.equal(harness.statuses.get("another-extension"), "keep");
	assert.deepEqual(harness.writes.at(-1), { key: "context-paging", text: undefined });
});

test("does not call the status UI during headless lifecycle events and commands", async () => {
	const harness = statusHarness({ globalSettings: {}, projectTrusted: false });
	await harness.emit("session_start");
	assert.equal(harness.statuses.get("context-paging"), "paging on");
	const before = harness.writes.length;
	harness.ctx.hasUI = false;
	harness.ctx.ui.setStatus = () => { throw new Error("Status UI is unavailable in headless mode"); };
	await harness.emit("session_start");
	for (const action of ["on", "on", "off", "off"]) await harness.command(action);
	await harness.emit("session_shutdown");
	assert.equal(harness.writes.length, before);
});

test("status queries and invalid arguments leave published status unchanged", async () => {
	const harness = statusHarness({ globalSettings: {}, projectTrusted: false });
	await harness.emit("session_start");
	await harness.command("off");
	const before = harness.writes.length;
	for (const args of ["", "status", "on off", "invalid"]) await harness.command(args);
	assert.equal(harness.writes.length, before);
	assert.equal(harness.statuses.get("context-paging"), "paging off");
});
