import { stat } from "node:fs/promises";
import { estimateTokens, sessionEntryToContextMessages, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type InputTokenCount = { tokens: number; estimated: boolean };

function counter(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageField(usage: unknown, key: string): number | undefined {
	return usage !== null && typeof usage === "object"
		? counter((usage as Record<string, unknown>)[key]) : undefined;
}

function hasMeasurement(usage: unknown): boolean {
	return ["input", "output", "cacheRead", "cacheWrite"].some((key) => (usageField(usage, key) ?? 0) > 0);
}

/** Pi input excludes cache counters. Output is not part of the sent input. */
export function reportedInputTokens(message: AgentMessage | undefined): InputTokenCount | undefined {
	if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return undefined;
	if (!hasMeasurement(message.usage)) return undefined;
	const parts = ["input", "cacheRead", "cacheWrite"].map((key) => usageField(message.usage, key));
	if (parts.some((part) => part === undefined)) return undefined;
	const tokens = parts.reduce<number>((total, part) => total + part!, 0);
	return counter(tokens) === undefined ? undefined : { tokens, estimated: false };
}

function latestBranchInput(entries: readonly SessionEntry[]): InputTokenCount | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "model_change") return undefined;
		if (entry.type === "message" && entry.message.role === "assistant") return reportedInputTokens(entry.message);
	}
	return undefined;
}

function savedHistoryTokens(entries: readonly SessionEntry[]): number {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let total = 0;
	for (const entry of entries) {
		let messages = sessionEntryToContextMessages(entry);
		if (entry.type === "context_edit" && entry.replacement) {
			const target = byId.get(entry.targetId);
			messages = target ? sessionEntryToContextMessages(target)
				.map((message) => ({ ...message, content: entry.replacement!.content } as AgentMessage)) : [];
		}
		for (const message of messages) total += estimateTokens(message);
	}
	return total;
}

function recordedUsage(entries: readonly SessionEntry[]): unknown[] {
	const records: unknown[] = [];
	for (const entry of entries) {
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") records.push(entry.usage);
		else if (entry.type === "message") {
			if (entry.message.role === "assistant") records.push(entry.message.usage);
			else if (entry.message.role === "toolResult" && entry.message.usage !== undefined) records.push(entry.message.usage);
		}
	}
	return records;
}

function totalCounter(records: readonly unknown[], key: string): number | undefined {
	if (records.length === 0) return undefined;
	let total = 0;
	for (const record of records) {
		// SDK defaults can be all zero even when the provider supplies no usage.
		if (!hasMeasurement(record)) return undefined;
		const value = usageField(record, key);
		if (value === undefined || counter(total + value) === undefined) return undefined;
		total += value;
	}
	return total;
}

async function storedBytes(path: string | undefined): Promise<number | undefined> {
	if (!path) return undefined;
	try {
		const file = await stat(path);
		return file.isFile() ? file.size : undefined;
	} catch {
		return undefined;
	}
}

function number(value: number | undefined): string {
	return value === undefined ? "unavailable" : value.toLocaleString("en-US");
}

function bytes(value: number | undefined): string {
	if (value === undefined) return "unavailable";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KiB`;
	return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function field(label: string, value: string): string {
	return `  ${label.padEnd(21)}${value}`;
}

/** Reads raw saved entries, not the paged branch projection or cumulative API input. */
export async function contextPagingStats(
	ctx: ExtensionContext,
	enabled: boolean,
	configuredBudget: number,
	latestInput?: InputTokenCount,
): Promise<string> {
	const entries = ctx.sessionManager.getEntries();
	const historyTokens = savedHistoryTokens(entries);
	const records = recordedUsage(entries);
	const input = latestInput ?? latestBranchInput(ctx.sessionManager.getBranch());
	const window = ctx.model?.contextWindow;
	const modelWindow = typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
	const budget = Math.min(configuredBudget, modelWindow ?? configuredBudget);
	const percent = input ? (input.tokens / budget * 100).toFixed(1) : undefined;
	const budgetNote = !enabled ? "   (inactive)" : percent === undefined ? "" : `   (${percent}% used)`;
	const size = await storedBytes(ctx.sessionManager.getSessionFile());
	return [
		`Context paging: ${enabled ? "on" : "off"}`,
		"",
		"SESSION — complete saved history",
		field("Stored size", bytes(size)),
		field("History tokens", `~${number(historyTokens)}`),
		"",
		"CONTEXT — latest model request",
		field("Input tokens", input ? `${input.estimated ? "~" : ""}${number(input.tokens)}` : "unavailable"),
		field("Paging budget", `${number(budget)}${budgetNote}`),
		field("Model window", number(modelWindow)),
		"",
		"CACHE — whole-session totals",
		field("Tokens read", number(totalCounter(records, "cacheRead"))),
		field("Tokens written", number(totalCounter(records, "cacheWrite"))),
	].join("\n");
}
