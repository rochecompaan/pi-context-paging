import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";
import contextPagingExtension, { type ContextPagingSettingsSources } from "../src/index.ts";

type Handler = (event: any, ctx: any) => unknown;

function statusHarness(settings?: ContextPagingSettingsSources, options: { cwd?: string; projectTrusted?: boolean; sessionProjection?: boolean } = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const statuses = new Map<string, string>();
	const writes: Array<{ key: string; text: string | undefined }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		hasUI: true,
		cwd: options.cwd ?? tmpdir(),
		isProjectTrusted: () => options.projectTrusted ?? false,
		sessionManager: {
			getBranch: () => [],
			// sessionProjection: false reproduces a Pi older than 0.87.0, which has no such method at all.
			...(options.sessionProjection === false ? {} : { buildSessionProjection: () => ({ messages: [] }) }),
		},
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			setStatus(key: string, text: string | undefined) {
				writes.push({ key, text });
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
	};
	contextPagingExtension({
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		events: { on: () => () => {} },
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, command);
		},
		registerTool() {},
	} as any, settings);
	return {
		ctx, statuses, writes, notifications,
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
	// Loading reports and continues: the parse error alone never names the file, and a rejecting
	// session_start skipped the refresh. The requirement here is the fallback, not the crash.
	await harness.emit("session_start", { reason: "reload" });
	assert.equal(harness.statuses.get("context-paging"), "paging off");
	const warnings = harness.notifications.filter(note => note.message.includes("are unusable"));
	assert.equal(warnings.length, 1, "the reload reports the broken file once");
	assert.ok(warnings[0]!.message.includes(`Global settings in ${path} are unusable`),
		"the warning names the file the user has to fix");
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

// A hand-edited settings file is the most likely way the settings path fails in the field, and a JSON parse
// error names no file. Session start has to survive it and say which file is unusable.
test("a malformed settings file leaves the session running and names the file", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, `{ "contextPaging": { "enabled": true }, }`);
	const harness = statusHarness();
	await harness.emit("session_start");
	assert.equal(harness.statuses.get("context-paging"), "paging off", "an unusable config never turns the feature on");
	assert.equal(harness.notifications.length, 1, "one report, not a stack of retries");
	assert.equal(harness.notifications[0]!.level, "warning");
	assert.match(harness.notifications[0]!.message, /Global settings in .*settings\.json are unusable/);
	assert.match(harness.notifications[0]!.message, /context paging stays off for this session/);
});

test("a directory in the settings file's place is reported, not thrown", async (t) => {
	const path = await settingsFile(t);
	await rm(path, { force: true });
	await mkdir(path, { recursive: true });
	const harness = statusHarness();
	await harness.emit("session_start");
	assert.equal(harness.statuses.get("context-paging"), "paging off");
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!.message, /Global settings in .*settings\.json are unusable/);
});

test("a missing settings file is silent and a readable one is applied without comment", async (t) => {
	const path = await settingsFile(t);
	const absent = statusHarness();
	await absent.emit("session_start");
	assert.deepEqual(absent.notifications, [], "no file is the normal case, not a problem to report");
	assert.equal(absent.statuses.get("context-paging"), "paging on", "the documented default is enabled");
	await writeFile(path, JSON.stringify({ contextPaging: { enabled: true } }));
	const harness = statusHarness();
	await harness.emit("session_start");
	assert.deepEqual(harness.notifications, [], "a readable file produces no warning");
	assert.equal(harness.statuses.get("context-paging"), "paging on");
});

test("a malformed project file is named, the global settings survive, and an untrusted project is not read", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, JSON.stringify({ contextPaging: { enabled: true } }));
	const cwd = await mkdtemp(join(tmpdir(), "context-paging-project-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(cwd, ".pi", "settings.json"), "{ oops }");
	const trusted = statusHarness(undefined, { cwd, projectTrusted: true });
	await trusted.emit("session_start");
	assert.equal(trusted.statuses.get("context-paging"), "paging off", "a broken project file never turns the feature on");
	assert.equal(trusted.notifications.length, 1);
	assert.match(trusted.notifications[0]!.message, /Project settings in .*\.pi\/settings\.json are unusable/);
	const untrusted = statusHarness(undefined, { cwd, projectTrusted: false });
	await untrusted.emit("session_start");
	assert.deepEqual(untrusted.notifications, [], "an untrusted project's file is never opened");
	assert.equal(untrusted.statuses.get("context-paging"), "paging on", "the global settings apply untouched");
});

test("a session whose host has no notification surface survives an unusable settings file", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, "{");
	const harness = statusHarness();
	// A headless host: no UI surface at all, and `hasUI` false.
	harness.ctx.hasUI = false;
	(harness.ctx as { ui?: unknown }).ui = undefined;
	await harness.emit("session_start");
	assert.equal(harness.statuses.get("context-paging"), undefined, "no UI means no published status");
});

test("a reporting failure cannot take down session start", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, "{");
	const harness = statusHarness();
	harness.ctx.ui.notify = () => { throw new Error("Notify is unavailable in this host"); };
	await harness.emit("session_start");
	assert.equal(harness.statuses.get("context-paging"), "paging off", "the status still publishes and the session continues");
});

// Reporting is what the user needs when something else has already failed, so the report itself must
// never be the thing that breaks the session: hosts differ in what UI surface they provide.
function failingRefresh(harness: ReturnType<typeof statusHarness>) {
	harness.ctx.sessionManager.getBranch = () => { throw new Error("BRANCH_READ_FAILURE"); };
	return harness;
}

test("a refresh failure with no notification surface on a headless host is survived", async () => {
	const harness = failingRefresh(statusHarness());
	harness.ctx.hasUI = false;
	(harness.ctx as { ui?: unknown }).ui = undefined;
	for (const event of ["session_start", "turn_end", "session_tree"] as const) await harness.emit(event);
	assert.equal(harness.statuses.get("context-paging"), undefined, "a host with no UI gets no status");
});

test("a host that exposes a UI object without a notify function is survived", async () => {
	const harness = failingRefresh(statusHarness());
	(harness.ctx.ui as { notify?: unknown }).notify = undefined;
	for (const event of ["turn_end", "session_tree"] as const) await harness.emit(event);
	assert.ok(true, "the report is skipped, not thrown");
});

test("a host whose notify call throws cannot turn a report into an event failure", async () => {
	const harness = failingRefresh(statusHarness());
	harness.ctx.ui.notify = () => { throw new Error("NOTIFY_UNAVAILABLE"); };
	for (const event of ["session_start", "turn_end", "session_tree"] as const) await harness.emit(event);
	assert.equal(harness.writes.length > 0, true, "status publication still ran, so the session keeps working");
});

test("a non-TUI host still receives the report", async () => {
	const harness = failingRefresh(statusHarness());
	harness.ctx.hasUI = false;
	await harness.emit("turn_end");
	assert.equal(harness.notifications.length, 1, "notifications are about the host's capability, not the TUI flag");
	assert.match(harness.notifications[0]!.message, /Context paging navigation is unavailable: BRANCH_READ_FAILURE/);
});

// A key the parser never reads is a silent no-op: the user edited settings.json and nothing changed. Unlike a file
// that cannot be parsed, this configuration was read successfully, so the fix is to name the key and keep paging on.
test("an unread contextPaging key is named and paging stays on", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, JSON.stringify({ contextPaging: { enabled: true, tokenbudget: 64_000 } }));
	const harness = statusHarness();
	await harness.emit("session_start");
	const notice = harness.notifications.find(note => note.message.includes("tokenbudget"));
	assert.ok(notice, `the unread key is named, got ${JSON.stringify(harness.notifications.map(n => n.message))}`);
	assert.equal(notice!.level, "warning");
	assert.match(notice!.message, /Global settings in .*settings\.json/);
	assert.match(notice!.message, /tokenBudget/);
	assert.equal(harness.statuses.get("context-paging"), "paging on", "an extra key is not a broken configuration");
});

test("a contextPaging value that is not an object is named, and defaults still start the session", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, `{ "contextPaging": 128000 }`);
	const harness = statusHarness();
	await harness.emit("session_start");
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!.message, /Global settings in .*settings\.json have a "contextPaging" value that is not an object/);
	assert.equal(harness.statuses.get("context-paging"), "paging on", "the defaults are a legitimate configuration");
});

test("documented keys produce no report, in global and in trusted project settings", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, JSON.stringify({ contextPaging: { enabled: true, tokenBudget: 64_000, trimToTokens: 40_000 } }));
	const global = statusHarness();
	await global.emit("session_start");
	assert.deepEqual(global.notifications, [], "the documented keys are the contract; naming them would be noise");
	const project = statusHarness(undefined, { cwd: "/tmp", projectTrusted: true });
	await project.emit("session_start");
	assert.deepEqual(project.notifications, []);
});

// Session start re-reads settings on reload, resume, fork and extension reload. A key the user has not renamed yet
// is the same fact every time, so it is reported once — the same contract as the trim-target warning.
test("an unread key is reported once across settings reloads, and a new key is reported again", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, JSON.stringify({ contextPaging: { enabled: true, tokenbudget: 64_000 } }));
	const harness = statusHarness();
	await harness.emit("session_start");
	await harness.emit("session_start", { reason: "reload" });
	await harness.emit("session_start", { reason: "resume" });
	const first = harness.notifications.filter(note => note.message.includes("tokenbudget"));
	assert.equal(first.length, 1, `one report per distinct problem, got ${first.length}`);
	await writeFile(path, JSON.stringify({ contextPaging: { enabled: true, maxTokens: 1 } }));
	await harness.emit("session_start", { reason: "reload" });
	const keys = harness.notifications.filter(note => note.message.includes("maxTokens") || note.message.includes("tokenbudget"));
	assert.equal(keys.length, 2, "a different unread key is a different problem and is reported");
	assert.equal(harness.statuses.get("context-paging"), "paging on");
});

// A quoted "false" is the most common way this file says nothing: resolution falls through to the default (the
// documented contract, tested in tests/index.test.ts), so the report is the only signal the user gets.
test("an unusable enabled value is reported by key, file and expectation, and says how to write it", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, JSON.stringify({ contextPaging: { enabled: "false" } }));
	const harness = statusHarness();
	await harness.emit("session_start");
	const notice = harness.notifications.find(note => note.message.includes("enabled"));
	assert.ok(notice, `the key is named, got ${JSON.stringify(harness.notifications.map(n => n.message))}`);
	assert.match(notice!.message, /Global settings in .*settings\.json/);
	assert.match(notice!.message, /true or false/);
	assert.match(notice!.message, /"false"/, "the received value is named so the user sees their own quote");
	assert.match(notice!.message, /"enabled": false/);
	assert.equal(notice!.level, "warning");
	assert.equal(harness.statuses.get("context-paging"), "paging on",
		"an unusable value falls through to the documented default; the report is the fix");
});

test("an unusable token value is reported with the key that needs it", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, JSON.stringify({ contextPaging: { tokenBudget: "64000", trimToTokens: 80_000.5 } }));
	const harness = statusHarness();
	await harness.emit("session_start");
	const keys = harness.notifications.filter(note => note.message.includes("tokenBudget") || note.message.includes("trimToTokens"));
	assert.equal(keys.length, 2, `one report per key, got ${JSON.stringify(keys.map(n => n.message))}`);
	assert.ok(keys.every(note => /64000|80000\.5/.test(note.message)), "the received values are named");
});

test("a boolean enabled and whole-number tokens produce no report", async (t) => {
	const path = await settingsFile(t);
	await writeFile(path, JSON.stringify({ contextPaging: { enabled: false } }));
	const harness = statusHarness();
	await harness.emit("session_start");
	assert.deepEqual(harness.notifications, [], "a valid file is never commented on");
	assert.equal(harness.statuses.get("context-paging"), "paging off", "false is false");
});

test("a host without the session-projection API keeps paging off and names what it needs", async () => {
	// The user-visible failure this removes: on a pre-0.87.0 host the four tools registered normally and the first
	// provider request died in persistentSessionMessages. Paging must now be off, explained, and the session survives.
	const harness = statusHarness(undefined, { sessionProjection: false });
	await harness.emit("session_start");
	const notes = harness.notifications.filter((note) => note.message.includes("buildSessionProjection"));
	assert.equal(notes.length, 1, "one report per session, got " + JSON.stringify(notes.map((note) => note.message)));
	assert.match(notes[0].message, /0\.87\.0/, "the report names the Pi version the extension requires");
	assert.match(notes[0].message, /stays off/, "the report says what happens to paging");
	assert.equal(harness.statuses.get("context-paging"), "paging off");
});

test("a host that provides the session-projection API gets no capability report", async () => {
	const harness = statusHarness();
	await harness.emit("session_start");
	assert.deepEqual(
		harness.notifications.filter((note) => note.message.includes("buildSessionProjection")),
		[],
		"a capable host is never lectured about capabilities",
	);
	assert.notEqual(harness.statuses.get("context-paging"), "paging off");
});

test("paging cannot be turned on for a host that cannot page, and the reason is named", async () => {
	// The failure this removes: `/context-paging on` on a pre-0.87.0 host answered "Context paging is enabled for
	// this session." and the status line read `paging on`, while the extension knew the host has no session-projection
	// API. The user trusted a status line that protected nothing -- paging silently paged nothing.
	const harness = statusHarness(undefined, { sessionProjection: false });
	await harness.emit("session_start");
	await harness.command("on");
	assert.ok(
		!harness.notifications.some((note) => note.message.includes("is enabled")),
		"never report success for a state this host cannot honour: " + JSON.stringify(harness.notifications.map((note) => note.message)),
	);
	const last = harness.notifications[harness.notifications.length - 1]!;
	assert.match(last.message, /0\.87\.0/, "the refusal names the Pi version the extension requires");
	assert.equal(harness.statuses.get("context-paging"), "paging off", "the status line stays honest");
});

test("a capable host still turns paging on with the plain report", async () => {
	const harness = statusHarness();
	await harness.emit("session_start");
	await harness.command("on");
	assert.match(
		harness.notifications[harness.notifications.length - 1]!.message,
		/Context paging is enabled for this session\./,
		"the capability refusal must not leak onto hosts that can page",
	);
	assert.equal(harness.statuses.get("context-paging"), "paging on");
});
