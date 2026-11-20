import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryItem, ModelTurnHistoryItem } from "../src/history.ts";
import { publicHistoryItem, selectHistoryPart } from "../src/recovery-parts.ts";
import { readContextOutput } from "../src/output-pages.ts";

/**
 * `part` is a read handle the model supplies, and `selectHistoryPart` walks it into the history object graph. The
 * guard is deny-by-default: a segment is followed only when it is an **own** property
 * (`src/recovery-parts.ts:81`, `Object.hasOwn`).
 *
 * That single primitive is what keeps a model-crafted handle off the prototype chain. `/constructor` and
 * `/__proto__` are the obvious ones; `/toolResults/0/constructor` is the one that matters, because the value it
 * would return serializes into a tool result and reaches the model. Swapping `Object.hasOwn(value, key)` for the
 * shorter and very natural `key in value` keeps every legitimate read working and reopens the whole chain — and
 * nothing else in the suite fails. The pointer syntax guard (leading `/`, RFC 6901 `~0`/`~1` escapes only) and the
 * image-field guard are pinned here for the same reason: they are named, model-facing contracts.
 */
const turn: ModelTurnHistoryItem = {
	id: "turn-boundary",
	kind: "modelTurn",
	sequence: 0,
	timestamp: "2026-09-21T00:00:00.000Z",
	assistantMessage: {
		role: "assistant",
		content: [
			{ type: "text", text: "assistant text" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		],
		stopReason: "toolUse",
		timestamp: 1,
	} as any,
	toolResults: [{
		role: "toolResult",
		toolCallId: "call-boundary",
		toolName: "read",
		content: [{ type: "text", text: "tool output" }],
		isError: false,
		timestamp: 2,
	} as any],
	metadata: { tools: ["read"], files: [], failed: false },
};
const items: HistoryItem[] = [turn];
const item = () => publicHistoryItem(items, turn.id);

const PROTOTYPE_POINTERS = [
	"/__proto__",
	"/constructor",
	"/prototype",
	"/constructor/prototype",
	"/toolResults/0/constructor",
	"/toolResults/0/__proto__",
	"/assistantMessage/content/0/text/constructor",
	"/assistantMessage/content/0/constructor",
	"/metadata/constructor",
];

const MALFORMED_POINTERS = [
	"__proto__", // no leading slash
	"~2x", // an escape RFC 6901 does not define
	"/toolResults/~2",
	"toolResults/0",
];

const TRAVERSAL_POINTERS = [
	"/../secret",
	"/%2e%2e/secret",
	"/toolResults/-1",
	"/toolResults/0.5",
	"/toolResults/0/content/99",
];

test("model-supplied handles cannot reach the prototype chain", () => {
	for (const pointer of PROTOTYPE_POINTERS) {
		assert.throws(
			() => selectHistoryPart(item(), pointer),
			/Unknown public recovery part/,
			`${pointer} must not resolve`,
		);
		// The refusal names the item's own public parts; it must not echo the probe or any value.
		const message = (() => {
			try {
				selectHistoryPart(item(), pointer);
				return "";
			} catch (error) {
				return (error as Error).message;
			}
		})();
		assert.ok(message.length > 0, `${pointer} did not throw`);
		assert.ok(!message.includes(pointer), `refusal for ${pointer} echoes the handle back: ${message.slice(0, 120)}`);
	}
});

test("the same refusals reach the model through the read tool", () => {
	for (const pointer of ["/constructor", "/toolResults/0/constructor", "/__proto__"]) {
		assert.throws(
			() => readContextOutput(items, { historyId: turn.id, part: pointer }),
			/Unknown public recovery part/,
			`${pointer} must not be readable through read_context_output`,
		);
	}
});

test("pointer syntax is RFC 6901 shaped, and the syntax error is the named one", () => {
	for (const pointer of MALFORMED_POINTERS) {
		assert.throws(
			() => selectHistoryPart(item(), pointer),
			/Invalid recovery part pointer/,
			`${pointer} must be refused as malformed`,
		);
	}
});

test("path traversal segments are refused as unknown parts", () => {
	for (const pointer of TRAVERSAL_POINTERS) {
		assert.throws(
			() => selectHistoryPart(item(), pointer),
			/Unknown public recovery part/,
			`${pointer} must not resolve`,
		);
	}
});

test("image bytes stay behind image handles", () => {
	// The public projection drops image blocks (see the mode "parts" listing), so this guard is
	// defence-in-depth for a value that is an image: fields under it are not readable by pointer.
	const withImage = {
		id: "x",
		kind: "modelTurn",
		assistantMessage: { role: "assistant", content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
	} as unknown as Parameters<typeof selectHistoryPart>[0];
	assert.throws(
		() => selectHistoryPart(withImage, "/assistantMessage/content/0/data"),
		/Read image attachments through their image handles/,
	);
});

test("legitimate own-property handles keep resolving, so the guards are not blanket refusals", () => {
	const root = selectHistoryPart(item(), "") as Record<string, unknown>;
	assert.equal(root.id, turn.id, "the root handle is the documented way to read headers and public fields");
	const result = selectHistoryPart(item(), "/toolResults/0") as Record<string, unknown>;
	assert.equal(result.toolCallId, "call-boundary");
	assert.equal(selectHistoryPart(item(), "/toolResults/0/content/0/text"), "tool output");
	assert.equal(selectHistoryPart(item(), "/assistantMessage/content/0/text"), "assistant text");
	// `length` is an own property of the results array, so it is a legitimate read, not a chain escape.
	assert.equal(selectHistoryPart(item(), "/toolResults/length"), 1);
});

test("RFC 6901 escapes name keys that contain a slash or a tilde", () => {
	// `~1` and `~0` decode to characters inside one key; they are not path separators.
	const exotic = { "a/b": "slash value", "a~b": "tilde value", plain: "plain value" } as unknown as Parameters<typeof selectHistoryPart>[0];
	assert.equal(selectHistoryPart(exotic, "/a~1b"), "slash value");
	assert.equal(selectHistoryPart(exotic, "/a~0b"), "tilde value");
	assert.equal(selectHistoryPart(exotic, "/plain"), "plain value");
	assert.throws(
		() => selectHistoryPart(item(), "/assistantMessage/content/0/text/extra"),
		/Unknown public recovery part/,
		"segments are keys, and a string has no keys beneath it",
	);
});;
