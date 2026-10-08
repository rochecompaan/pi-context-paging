import { createHash } from "node:crypto";
import type { SessionOwner } from "./metrics.ts";

export type RequestMeta = SessionOwner & {
	requestId: string;
	promptId: string;
	purpose: "conversation" | "compaction";
};
export type OriginIndex = readonly {
	role: string;
	texts: readonly string[];
	sourcePromptId?: string;
	compactionEntryId?: string;
}[];
export type ReadableBlock = {
	role: string;
	text: string;
	kind?: "message" | "reasoning" | "tool-call" | "tool-result" | "tool-declaration";
	sourcePromptId?: string;
	compactionEntryId?: string;
	toolCallId?: string;
	toolItemId?: string;
};
export type RequestEvidence = RequestMeta & {
	complete: boolean;
	error?: string;
	blocks: readonly ReadableBlock[];
	opaque: { count: number; hashes: readonly string[] };
};

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only provider-visible content enters this projection. Unknown fields and
// opaque state are never serialized as readable text.
export function decodeCodexPayload(payload: unknown, meta: RequestMeta, origins: OriginIndex): RequestEvidence {
	const blocks: ReadableBlock[] = [];
	const hashes: string[] = [];
	const errors = new Set<string>();
	const fail = (code: string) => { errors.add(code); };
	const add = (role: string, texts: string[], kind: ReadableBlock["kind"] = "message", toolCallId?: string, toolItemId?: string) => {
		const matches = kind === "message" && role === "user" ? origins.filter(origin => origin.role === role
			&& origin.texts.length === texts.length && origin.texts.every((text, i) => text === texts[i])) : [];
		if (matches.length > 1) fail("ambiguous-origin");
		const origin = matches.length === 1 ? matches[0] : undefined;
		for (const text of texts) blocks.push({ role, text, kind,
			...(origin?.sourcePromptId ? { sourcePromptId: origin.sourcePromptId } : {}),
			...(origin?.compactionEntryId ? { compactionEntryId: origin.compactionEntryId } : {}),
			...(toolCallId ? { toolCallId } : {}),
			...(toolItemId ? { toolItemId } : {}),
		});
	};
	const contentTexts = (content: unknown, types: readonly string[]): string[] => {
		if (typeof content === "string") return [content];
		if (!Array.isArray(content)) { fail("invalid-content"); return []; }
		const texts: string[] = [];
		for (const part of content) {
			if (!object(part) || !types.includes(String(part.type)) || typeof part.text !== "string") fail("unsupported-content");
			else texts.push(part.text);
		}
		return texts;
	};
	const declarations = (tools: unknown) => {
		if (!Array.isArray(tools)) { fail("invalid-tools"); return; }
		for (const tool of tools) {
			if (!object(tool) || typeof tool.name !== "string"
				|| (tool.description !== undefined && typeof tool.description !== "string")) { fail("invalid-tool"); continue; }
			if (tool.type === "function" && object(tool.parameters)) {
				add("tool-declaration", [JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })], "tool-declaration");
			} else if (tool.type === "custom" && object(tool.format) && tool.format.type === "grammar"
				&& typeof tool.format.syntax === "string" && typeof tool.format.definition === "string") {
				add("tool-declaration", [JSON.stringify({ name: tool.name, description: tool.description,
					format: { type: "grammar", syntax: tool.format.syntax, definition: tool.format.definition } })], "tool-declaration");
			} else fail("unsupported-tool");
		}
	};
	const item = (value: unknown) => {
		if (!object(value)) { fail("invalid-input-item"); return; }
		if (value.type === "reasoning") {
			if (value.encrypted_content !== undefined) {
				if (typeof value.encrypted_content !== "string") fail("invalid-opaque-state");
				else hashes.push(createHash("sha256").update(value.encrypted_content).digest("hex"));
			}
			if (Array.isArray(value.summary)) add("assistant", contentTexts(value.summary, ["summary_text"]), "reasoning");
			else fail("invalid-reasoning-summary");
		} else if (value.type === "function_call" || value.type === "custom_tool_call") {
			const argumentsText = value.type === "function_call" ? value.arguments : value.input;
			if (typeof value.call_id !== "string" || typeof value.name !== "string" || typeof argumentsText !== "string") fail("invalid-tool-call");
			else if (value.id !== undefined && (typeof value.id !== "string" || !value.id || value.id.includes("|"))) fail("invalid-tool-item-id");
			else add("assistant", [value.name, argumentsText], "tool-call", value.call_id, value.id as string | undefined);
		} else if (value.type === "function_call_output" || value.type === "custom_tool_call_output") {
			if (typeof value.call_id !== "string") fail("invalid-tool-output");
			else add("toolResult", contentTexts(value.output, ["input_text"]), "tool-result", value.call_id);
		} else if (value.type === "additional_tools" && value.role === "developer") {
			declarations(value.tools);
		} else if ((value.type === undefined || value.type === "message")
			&& ["user", "assistant", "system", "developer"].includes(String(value.role))) {
			const role = String(value.role);
			add(role, contentTexts(value.content, role === "assistant" ? ["output_text"] : ["input_text"]));
		} else fail("unsupported-input-item");
	};
	if (!object(payload)) fail("invalid-payload");
	else {
		if (payload.store !== false) fail("store-not-false");
		if (Object.hasOwn(payload, "previous_response_id")) fail("prior-response-reference");
		if (typeof payload.model !== "string") fail("invalid-model");
		if (typeof payload.instructions !== "string") fail("invalid-instructions");
		else add("system", [payload.instructions]);
		if (!Array.isArray(payload.input)) fail("invalid-input");
		else payload.input.forEach(item);
		if (payload.tools !== undefined) declarations(payload.tools);
	}
	return { ...meta, complete: errors.size === 0,
		...(errors.size ? { error: [...errors].join(",") } : {}), blocks, opaque: { count: hashes.length, hashes } };
}
