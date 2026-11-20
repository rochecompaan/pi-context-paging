import assert from "node:assert/strict";
import test from "node:test";
import { copyPrivate, equalPrivate, recordFacade, replayFacades } from "../eval/recall/paging-replay-input.ts";
import type { ReplayInputs } from "../eval/recall/paging-replay-input.ts";

/**
 * The paging arm of the experiment is only the product's behaviour if replay reproduces the exact
 * host interaction that was recorded. These tests pin the two directions of that guarantee: the
 * recorder refuses to capture a surface it cannot replay, and the replay refuses to accept a
 * changed interaction — a silent pass there would publish a measurement of something that never ran.
 */
type Host = {
	mode: string;
	model: { contextWindow: number };
	sessionManager: { getEntries(): unknown[]; getBranch(name: string): { id: string }[]; appendEntry(entry: unknown): unknown };
	ui: { notify(message: string, level: string): void };
	isProjectTrusted(): boolean;
	getContextUsage(): { tokens: number };
};

function liveHost(notices: string[]): Host {
	return {
		mode: "rpc",
		model: { contextWindow: 131_072 },
		sessionManager: {
			getEntries: () => [{ id: "u1" }, { id: "t1" }],
			getBranch: (name: string) => [{ id: `branch:${name}` }],
			appendEntry: (entry: unknown) => entry,
		},
		ui: { notify: (message: string) => { notices.push(message); } },
		isProjectTrusted: () => true,
		getContextUsage: () => ({ tokens: 1234 }),
	};
}

/** The interaction a paging handler performs: reads, one argument-carrying read, one effect. */
function handler(ctx: Host): { summary: string; trusted: boolean } {
	const window = ctx.model.contextWindow;
	const entries = ctx.sessionManager.getEntries();
	const branch = ctx.sessionManager.getBranch("main");
	const usage = ctx.getContextUsage();
	ctx.ui.notify(`${entries.length} entries, window ${window}, tokens ${usage.tokens}, branch ${branch[0]!.id}`, "info");
	return { summary: `${entries.length}/${window}`, trusted: ctx.isProjectTrusted() };
}

function record(): { input: ReplayInputs; notices: string[]; result: { summary: string; trusted: boolean } } {
	const notices: string[] = [];
	const input: ReplayInputs = { reads: [], effects: [] };
	const result = handler(recordFacade(liveHost(notices), "ctx", input) as Host);
	return { input, notices, result };
}

test("recording captures the reads and effects the handler actually performed", () => {
	const { input, notices, result } = record();
	assert.deepEqual(result, { summary: "2/131072", trusted: true });
	assert.deepEqual(input.reads.map(read => read.path), ["ctx.model", "ctx.sessionManager.getEntries",
		"ctx.sessionManager.getBranch", "ctx.getContextUsage", "ctx.isProjectTrusted"]);
	assert.deepEqual(input.reads[2]!.args, ["main"], "arguments are part of the recorded interaction");
	assert.deepEqual(input.effects, [{ path: "ctx.ui.notify", args: ["2 entries, window 131072, tokens 1234, branch branch:main", "info"] }]);
	assert.equal(notices.length, 1, "an effect is performed, not suppressed");
	const values = new Map(input.reads.map(read => [read.path, read.value]));
	assert.deepEqual(values.get("ctx.model"), { contextWindow: 131_072 });
	assert.deepEqual(values.get("ctx.getContextUsage"), { tokens: 1234 });
});

test("replaying the recorded interaction reproduces the live run exactly", () => {
	const { input, result } = record();
	const replay = replayFacades(input);
	assert.deepEqual(handler(replay.at<Host>("ctx")), result);
	replay.assertConsumed();
});

test("a changed host interaction is refused, never reinterpreted", () => {
	const mismatch = "Replay host-read mismatch";
	const runs: [string, (ctx: Host, replay: { assertConsumed(): void }) => void][] = [
		["a skipped read", (ctx, replay) => { ctx.sessionManager.getEntries(); ctx.getContextUsage(); ctx.isProjectTrusted(); replay.assertConsumed(); }],
		["a reordered read", (ctx) => { ctx.isProjectTrusted(); }],
		["an unused recorded read", (ctx, replay) => { ctx.mode; replay.assertConsumed(); }],
	];
	for (const [label, run] of runs) {
		const { input } = record();
		const replay = replayFacades(input);
		assert.throws(() => run(replay.at<Host>("ctx"), replay), { message: mismatch }, label);
	}
	const { input } = record();
	const shifted = replayFacades(input).at<Host>("ctx");
	shifted.model.contextWindow;
	shifted.sessionManager.getEntries();
	assert.throws(() => shifted.sessionManager.getBranch("other"), { message: mismatch }, "the same method with different arguments");
	assert.throws(() => shifted.sessionManager.getEntries(), { message: mismatch }, "a repeated call is not assumed replayable");
});

test("a read-only interaction replays with no effects and refuses partial consumption", () => {
	const input: ReplayInputs = { reads: [], effects: [] };
	const host = { model: { contextWindow: 8 }, sessionManager: { getEntries: () => [1, 2] }, isProjectTrusted: () => true };
	const ctx = recordFacade(host, "ctx", input) as typeof host;
	assert.equal(ctx.model.contextWindow + ctx.sessionManager.getEntries().length + (ctx.isProjectTrusted() ? 1 : 0), 11);
	assert.deepEqual(input.effects, [], "a selection pass that notifies nothing records no effects");
	const full = replayFacades(input);
	const replayed = full.at<typeof host>("ctx");
	assert.equal(replayed.model.contextWindow, 8);
	assert.equal(replayed.sessionManager.getEntries().length, 2);
	assert.equal(replayed.isProjectTrusted(), true);
	full.assertConsumed();
	const partial = replayFacades(input);
	void partial.at<typeof host>("ctx").model.contextWindow;
	assert.throws(() => partial.assertConsumed(), { message: "Replay host observations incomplete" },
		"reads the handler never made mean the recording no longer describes this run");
});

test("effects are part of the replayed contract", () => {
	const { input } = record();
	const extra = replayFacades(input);
	const ctx = extra.at<Host>("ctx");
	ctx.model.contextWindow;
	ctx.sessionManager.getEntries();
	ctx.sessionManager.getBranch("main");
	ctx.getContextUsage();
	ctx.ui.notify("an notice the product never sent", "info");
	ctx.isProjectTrusted();
	assert.throws(() => extra.assertConsumed(), { message: "Replay host observations incomplete" }, "an invented effect is a mismatch");

	const missing = replayFacades(record().input);
	const quiet = missing.at<Host>("ctx");
	quiet.model.contextWindow;
	quiet.sessionManager.getEntries();
	quiet.sessionManager.getBranch("main");
	quiet.getContextUsage();
	quiet.isProjectTrusted();
	assert.throws(() => missing.assertConsumed(), { message: "Replay host observations incomplete" }, "a dropped effect is a mismatch");
});

test("the recorder refuses host surfaces it cannot replay", () => {
	const input: ReplayInputs = { reads: [], effects: [] };
	const ctx = recordFacade(liveHost([]), "ctx", input) as Host;
	assert.throws(() => ctx.sessionManager.appendEntry({ type: "message" }), { message: "Unsupported host action ctx.sessionManager.appendEntry" },
		"a session write must not be captured as a replayable read");
	assert.throws(() => (recordFacade(liveHost([]), "ctx", input) as unknown as Record<symbol, unknown>)[Symbol.iterator],
		{ message: "Unsupported symbolic host read" });
	assert.deepEqual(input.reads, [], "a refused action records nothing");
	const replay = replayFacades(record().input);
	assert.throws(() => (replay.at<Host>("ctx") as unknown as Record<symbol, unknown>)[Symbol.iterator],
		{ message: "Unsupported symbolic replay read" });
});

test("private copies keep host types and never alias the live host", () => {
	const aborted = new AbortController();
	aborted.abort(new Error("provider stream closed"));
	const original = { text: "body", at: new Date(1_700_000_000_000), tags: new Set(["a"]), sizes: new Map([["x", 10n]]),
		bytes: new Uint8Array([1, 2]), nested: { list: [{ deep: true }] }, signal: aborted.signal };
	const copy = copyPrivate(original);
	copy.nested.list[0]!.deep = false;
	copy.tags.add("b");
	assert.equal(original.nested.list[0]!.deep, true, "the recorded copy is private");
	assert.equal(original.tags.size, 1);
	assert.equal(copy.at.getTime(), 1_700_000_000_000, "records are copied, not JSON-converted");
	assert.ok(copy.tags instanceof Set && copy.sizes instanceof Map && copy.bytes instanceof Uint8Array);
	assert.equal(copy.sizes.get("x"), 10n, "BigInt survives the copy");
	assert.equal(copy.signal.aborted, true, "abort state is carried as state, not as a live signal");
	assert.equal(copyPrivate("text"), "text");
	assert.equal(copyPrivate(undefined), undefined);
});

test("replay comparison normalizes only abort-signal state", () => {
	const open = new AbortController().signal;
	assert.equal(equalPrivate(open, copyPrivate(open)), true, "an open signal matches its copy");
	const aborted = new AbortController();
	aborted.abort(new Error("closed"));
	assert.equal(equalPrivate(aborted.signal, copyPrivate(aborted.signal)), true, "aborted state and reason compare");
	assert.equal(equalPrivate(open, aborted.signal), false, "abort state is not ignored");
	assert.equal(equalPrivate(new Map([["a", 1]]), { a: 1 }), false, "host types are not flattened for comparison");
	assert.equal(equalPrivate({ a: [1, { b: 2 }] }, copyPrivate({ a: [1, { b: 2 }] })), true);
});
