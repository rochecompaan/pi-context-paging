import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	residentTokenEstimate,
	selectContext,
	type ResidentToolDefinition,
} from "./context-policy.ts";
import { ContextUsageTracker } from "./context-usage.ts";
import { ContextCutState } from "./context-cut.ts";
import { isPagingToolTurn, projectActiveBranch, type HistoryItem } from "./history.ts";
import { HistoryNavigator } from "./navigator.ts";
import { registerContextPagingTools, type HistorySnapshot } from "./tools.ts";
import { contextPagingStats, reportedInputTokens, type InputTokenCount } from "./stats.ts";

import {
	resolveContextPagingSettings,
	type ContextPagingSettingsSources,
	type ResolvedContextPagingSettings,
} from "./settings.ts";

export { resolveContextPagingSettings } from "./settings.ts";
export type { ContextPagingSettingsSources, ResolvedContextPagingSettings } from "./settings.ts";

async function readJsonSettings(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return undefined;
		throw error;
	}
}

async function loadSettings(ctx: ExtensionContext): Promise<ContextPagingSettingsSources> {
	const codingAgent = await import("@earendil-works/pi-coding-agent") as {
		CONFIG_DIR_NAME?: string;
		getAgentDir?: () => string;
	};
	const projectTrusted = ctx.isProjectTrusted();
	const configDirectory = codingAgent.CONFIG_DIR_NAME ?? ".pi";
	const agentDirectory = codingAgent.getAgentDir?.() ?? join(process.env.HOME ?? "", ".pi", "agent");
	return {
		globalSettings: await readJsonSettings(join(agentDirectory, "settings.json")),
		projectSettings: projectTrusted
			? await readJsonSettings(join(ctx.cwd, configDirectory, "settings.json"))
			: undefined,
		projectTrusted,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function activeResidentTools(pi: ExtensionAPI): ResidentToolDefinition[] {
	const activeNames = new Set(pi.getActiveTools());
	return pi.getAllTools()
		.filter((tool) => activeNames.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function persistentSessionMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager.buildSessionProjection().messages;
}

/** Registers context paging lifecycle hooks and the four recovery tools. */
export default function contextPagingExtension(
	pi: ExtensionAPI,
	settingsSources?: ContextPagingSettingsSources,
): void {
	let resolvedSettings: ResolvedContextPagingSettings = settingsSources
		? resolveContextPagingSettings(settingsSources)
		: resolveContextPagingSettings({ globalSettings: { contextPaging: { enabled: false } }, projectTrusted: false });
	let sessionEnabled: boolean | undefined;
	const isEnabled = () => sessionEnabled ?? resolvedSettings.enabled;
	const publishStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("context-paging", isEnabled() ? "paging on" : "paging off");
	};
	let allItems: HistoryItem[] = [];
	const navigator = new HistoryNavigator();
	const usageTracker = new ContextUsageTracker();
	const cutState = new ContextCutState();
	let latestInput: InputTokenCount | undefined;
	const warnedSettingPairs = new Set<string>();
	const resetPagingState = () => {
		usageTracker.clear();
		cutState.reset();
		latestInput = undefined;
	};
	const warnAboutTrimTarget = (ctx: ExtensionContext) => {
		const { tokenBudget, trimToTokens, trimToTokensExplicit } = resolvedSettings;
		if (!isEnabled() || !trimToTokensExplicit || trimToTokens < tokenBudget) return;
		const pair = `${tokenBudget}:${trimToTokens}`;
		if (warnedSettingPairs.has(pair)) return;
		warnedSettingPairs.add(pair);
		ctx.ui.notify(`Context paging tokenBudget=${tokenBudget}, trimToTokens=${trimToTokens} leaves no headroom. A smaller trimToTokens restores room between cuts.`, "warning");
	};
	let visibleHistoryIds: string[] = [];
	let invalidatingBranchEntries = new Set<string>();
	let canonicalSessionMessages: AgentMessage[] | undefined;
	const refresh = (ctx: ExtensionContext): HistoryItem[] => {
		const branch = ctx.sessionManager.getBranch();
		const currentInvalidatingEntries = new Set(branch
			.filter((entry) => entry.type === "context_edit" || entry.type === "compaction")
			.map((entry) => entry.id));
		if ([...currentInvalidatingEntries].some((id) => !invalidatingBranchEntries.has(id))) resetPagingState();
		// Keep saved event IDs even before the branch view exposes their entries.
		for (const id of currentInvalidatingEntries) invalidatingBranchEntries.add(id);
		const projected = projectActiveBranch(branch);
		canonicalSessionMessages = persistentSessionMessages(ctx);
		allItems = projected;
		return projected;
	};
	const visibleHistoryChanged = (items: readonly HistoryItem[]): boolean => {
		let index = 0;
		for (const item of items) {
			if (isPagingToolTurn(item)) continue;
			if (item.id !== visibleHistoryIds[index++]) return true;
		}
		return index !== visibleHistoryIds.length;
	};
	const snapshot = (ctx: ExtensionContext): HistorySnapshot => {
		const projected = refresh(ctx);
		if (visibleHistoryChanged(projected)) {
			navigator.rebuild(projected);
			visibleHistoryIds = projected.filter((item) => !isPagingToolTurn(item)).map((item) => item.id);
		}
		return { allItems, navigator };
	};
	const refreshSafely = (ctx: ExtensionContext) => {
		try {
			refresh(ctx);
		} catch (error) {
			usageTracker.clear();
			canonicalSessionMessages = undefined;
			ctx.ui.notify(`Context paging navigation is unavailable: ${errorMessage(error)}`, "error");
		}
	};

	pi.registerCommand("context-paging", {
		description: "Enable or disable context paging for this session, or show status and stats",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "stats") {
				try {
					ctx.ui.notify(await contextPagingStats(ctx, isEnabled(), resolvedSettings.tokenBudget, latestInput), "info");
				} catch (error) {
					ctx.ui.notify(`Context paging stats are unavailable: ${errorMessage(error)}`, "warning");
				}
				return;
			}
			if (action === "on" || action === "off") {
				const enabled = action === "on";
				if (enabled !== isEnabled()) resetPagingState();
				sessionEnabled = enabled;
				publishStatus(ctx);
			} else if (action !== "" && action !== "status") {
				ctx.ui.notify("Usage: /context-paging [on|off|status|stats]", "warning");
				return;
			}
			ctx.ui.notify(`Context paging is ${isEnabled() ? "enabled" : "disabled"} for this session.`, "info");
		},
	});

	registerContextPagingTools(pi, {
		isEnabled,
		snapshot,
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionEnabled = undefined;
		resetPagingState();
		invalidatingBranchEntries = new Set();
		try {
			if (!settingsSources) {
				resolvedSettings = { ...resolvedSettings, enabled: false };
				resolvedSettings = resolveContextPagingSettings(await loadSettings(ctx));
			}
		} finally {
			publishStatus(ctx);
		}
		refreshSafely(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("context-paging", undefined);
	});
	pi.on("turn_end", (event, ctx) => {
		usageTracker.recordResponse(event.message);
		latestInput = reportedInputTokens(event.message) ?? (latestInput?.estimated ? latestInput : undefined);
		refreshSafely(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		resetPagingState();
		invalidatingBranchEntries = new Set();
		refreshSafely(ctx);
	});
	pi.on("model_select", () => {
		resetPagingState();
	});
	pi.on("session_compact", (event) => {
		const id = event.compactionEntry?.id;
		if (id && invalidatingBranchEntries.has(id)) return;
		resetPagingState();
		if (id) invalidatingBranchEntries.add(id);
	});
	pi.on("context", (event, ctx) => {
		if (!isEnabled()) return;
		warnAboutTrimTarget(ctx);

		let rawHistoryItems: readonly HistoryItem[] | undefined;
		try {
			rawHistoryItems = refresh(ctx);
		} catch (error) {
			usageTracker.clear();
			canonicalSessionMessages = undefined;
			ctx.ui.notify(`Context paging history is unavailable: ${errorMessage(error)}`, "error");
		}

		try {
			const systemPrompt = ctx.getSystemPrompt();
			const activeTools = activeResidentTools(pi);
			const residentTokens = residentTokenEstimate({ systemPrompt, activeTools });
			const outgoingOnly = canonicalSessionMessages
				? usageTracker.outgoingOnly(event.messages, canonicalSessionMessages)
				: undefined;
			const contextTokens = usageTracker.prepare(
				event.messages, residentTokens, ctx.getContextUsage()?.tokens, canonicalSessionMessages ?? [],
			);
			const selection = selectContext({
				messages: event.messages,
				systemPrompt,
				activeTools,
				modelContextWindow: ctx.model?.contextWindow,
				tokenBudget: resolvedSettings.tokenBudget,
				trimToTokens: resolvedSettings.trimToTokens,
				cutState: cutState.prepare(rawHistoryItems),
				contextTokens,
				outgoingOnly,
				rawHistoryItems,
			});
			// Unknown canonical provenance is an empty trusted subset, never the outgoing request.
			usageTracker.recordSelection(selection.messages, residentTokens, canonicalSessionMessages ?? []);
			cutState.commit(selection.cutState);
			latestInput = { tokens: selection.estimatedTokens, estimated: true };
			return { messages: selection.messages };
		} catch (error) {
			ctx.abort();
			ctx.ui.notify(`Context paging aborted this provider call: ${errorMessage(error)}`, "error");
			return { messages: event.messages };
		}
	});
	pi.on("session_before_compact", async (event) => {
		if (!isEnabled()) return;
		if (event.reason === "threshold" || event.reason === "overflow") return { cancel: true };
		usageTracker.clear();
	});
}
