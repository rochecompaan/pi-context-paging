import type { ImageContent } from "@earendil-works/pi-ai";
import type { HistoryItem } from "./history.ts";
import { recoveryHistoryItem, type RecoveryHistoryItem } from "./recovery-content.ts";

export type HistoryPart = { part: string; value: unknown };
export type PartReadHandle = { historyId: string; part: string; mode?: "image" };
export type HistoryPartDescription = {
	part: string;
	type: string;
	bytes: number;
	preview?: string;
	read: PartReadHandle;
};

export function publicHistoryItem(items: readonly HistoryItem[], historyId: string): RecoveryHistoryItem {
	const raw = items.find((item) => item.id === historyId);
	if (raw === undefined) throw new Error(`Unknown history ID ${historyId}.`);
	const item = recoveryHistoryItem(raw);
	if (item === undefined) throw new Error("History item is not public recovery output.");
	return item;
}

export function isRecoveryImage(value: unknown): value is ImageContent {
	return typeof value === "object" && value !== null
		&& (value as ImageContent).type === "image"
		&& typeof (value as ImageContent).data === "string"
		&& typeof (value as ImageContent).mimeType === "string";
}

const escapeKey = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Select only own public fields; null assistant slots cannot be read around. */
export function selectHistoryPart(item: RecoveryHistoryItem, pointer: string): unknown {
	if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/")) || /~(?![01])/u.test(pointer)) {
		throw new Error("Invalid recovery part pointer.");
	}
	let value: unknown = item;
	for (const segment of pointer === "" ? [] : pointer.slice(1).split("/")) {
		const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (isRecoveryImage(value)) throw new Error("Read image attachments through their image handles, not image fields.");
		if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) {
			throw new Error("Unknown public recovery part.");
		}
		value = (value as Record<string, unknown>)[key];
	}
	if (value === undefined || (value === null && /^\/assistantMessage\/content\/\d+$/u.test(pointer))) {
		throw new Error("Unknown public recovery part.");
	}
	return value;
}

/** List content separately; the root handle also recovers headers and other public fields. */
export function historyParts(item: RecoveryHistoryItem): HistoryPart[] {
	const parts: HistoryPart[] = [];
	const addContent = (content: unknown, path: string) => {
		if (Array.isArray(content)) content.forEach((value, index) => {
			if (value != null) parts.push({ part: `${path}/${index}`, value });
		});
		else parts.push({ part: path, value: content });
	};
	if (item.kind === "user") addContent(item.userMessage.content, "/userMessage/content");
	else {
		addContent(item.assistantMessage.content, "/assistantMessage/content");
		item.toolResults.forEach((result, index) => {
			addContent(result.content, `/toolResults/${index}/content`);
			if (result.details !== undefined) parts.push({ part: `/toolResults/${index}/details`, value: result.details });
		});
		parts.push({ part: "/metadata", value: item.metadata });
	}
	parts.push({ part: "", value: item });
	return parts;
}

function imageMetadata(image: ImageContent, historyId: string, part: string) {
	const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
	return {
		type: "image" as const,
		mimeType: image.mimeType,
		bytes: Math.max(0, Math.floor(image.data.length * 3 / 4) - padding),
		read: { historyId, part, mode: "image" as const },
	};
}

/** Image bytes stay in native attachments, never JSON text, even in aggregate reads. */
export function serializeRecoveryPart(item: RecoveryHistoryItem, pointer: string): string {
	const value = selectHistoryPart(item, pointer);
	const paths = new WeakMap<object, string>();
	if (typeof value === "object" && value !== null) paths.set(value, pointer);
	const text = JSON.stringify(value, function (key, child) {
		const parentPath = paths.get(this);
		const path = parentPath === undefined ? pointer : `${parentPath}/${escapeKey(key)}`;
		if (isRecoveryImage(child)) return imageMetadata(child, item.id, path);
		if (typeof child === "object" && child !== null) paths.set(child, path);
		return child;
	});
	if (text === undefined) throw new Error("Recovery part could not be serialized.");
	return text;
}

export function describeHistoryPart(item: RecoveryHistoryItem, part: HistoryPart): HistoryPartDescription {
	if (isRecoveryImage(part.value)) {
		const metadata = imageMetadata(part.value, item.id, part.part);
		return { part: part.part, type: "image", bytes: metadata.bytes, read: metadata.read };
	}
	const text = serializeRecoveryPart(item, part.part);
	const type = typeof part.value === "object" && part.value !== null && "type" in part.value
		&& (part.value.type === "text" || part.value.type === "toolCall") ? part.value.type : "json";
	return {
		part: part.part,
		type,
		bytes: Buffer.byteLength(text, "utf8"),
		preview: text.slice(0, 160).replace(/[\uD800-\uDBFF]$/u, ""),
		read: { historyId: item.id, part: part.part },
	};
}
