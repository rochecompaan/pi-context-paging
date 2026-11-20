import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	contextTokenLimits,
	residentTokenEstimate,
	selectContext,
	type ContextSelection,
	type ResidentToolDefinition,
} from "./context-policy.ts";
import { ContextUsageTracker } from "./context-usage.ts";
import { ContextCutState } from "./context-cut.ts";
import { isInterruptedAssistantMessage, projectActiveBranchIncremental, type HistoryItem, type ProjectionWatermark } from "./history.ts";
import { historyItemKeyResolver, MessageCostCache } from "./context-costs.ts";
import { isRecoverableHistoryItem } from "./recovery-content.ts";
import { HistoryNavigator } from "./navigator.ts";
import { registerContextPagingTools, type HistorySnapshot } from "./tools.ts";
import { contextPagingStats, reportedInputTokens, type InputTokenCount } from "./stats.ts";
import { modelKey, requestLimits, RouteReports, type RequestLimits } from "./routed-model.ts";

import {
	inspectContextPagingSettings,
	resolveContextPagingSettings,
	type ContextPagingSettingsSources,
	type ResolvedContextPagingSettings,
} from "./settings.ts";

export { inspectContextPagingSettings, resolveContextPagingSettings } from "./settings.ts";
export type { ContextPagingSettingsSources, ResolvedContextPagingSettings } from "./settings.ts";

function notifySafely(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "warning"): void {
	// One reporting primitive for the whole extension. A lifecycle path can run with no UI surface at all
	// (a headless host has no ctx.ui), and a host whose notify call throws must not turn a report into a
	// rejected event handler: the report is what the user needs when something else already failed.
	// Capability, not `hasUI`, is the right test — a non-TUI host still receives notifications.
	if (typeof (ctx.ui as { notify?: unknown } | undefined)?.notify !== "function") return;
	try {
		ctx.ui.notify(message, level);
	} catch {}
}

function reportSettingsProblem(report: (message: string) => void, path: string, scope: string, error: unknown): void {
	report(`${scope} settings in ${path} are unusable (${errorMessage(error)})`);
}

async function readJsonSettings(path: string, report: (message: string) => void, scope: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return undefined;
		// A hand-edited settings file (a trailing comma, a comment, a directory in its place) must not take
		// down session start. The parse error alone never names a file, so the report has to.
		reportSettingsProblem(report, path, scope, error);
		return undefined;
	}
}

function isRecordLike(value: unknown): value is { contextPaging: Record<string, unknown> } {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		&& typeof (value as { contextPaging?: unknown }).contextPaging === "object"
		&& (value as { contextPaging?: unknown }).contextPaging !== null
		&& !Array.isArray((value as { contextPaging?: unknown }).contextPaging);
}

function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value === "string" ? `the string "${value}"` : `a ${typeof value} ${String(value)}`;
}

function reportUnreadSettings(notice: (message: string) => void, path: string, scope: string, settings: unknown): void {
	// A key the parser never reads is a silent no-op: the user edited a file and nothing changed. Report it, and
	// leave paging on — the rest of the configuration is valid, unlike a file that cannot be parsed at all.
	const { ignored, unusable, malformed } = inspectContextPagingSettings(settings);
	const section = isRecordLike(settings) ? settings.contextPaging : undefined;
	for (const { key, expected } of unusable) {
		// Resolution deliberately falls through an unusable value to the next source or the default; what was
		// missing is the report. `enabled` matters most, because falling through to the default turns an
		// intrusive feature ON when the user's file appears to say otherwise.
		notice(`${scope} settings in ${path} have a "contextPaging" "${key}" value that is not ${expected} `
			+ `(received ${describeValue(section ? section[key] : undefined)}), so it is not read. ${key === "enabled"
				? `Write "enabled": false to keep paging off, or "enabled": true to turn it on.`
				: `Write ${key} as a number, for example ${key}: 64000.`}`);
	}
	if (malformed) {
		notice(`${scope} settings in ${path} have a "contextPaging" value that is not an object, so its settings`
			+ " are not read.");
		return;
	}
	if (ignored.length > 0) {
		notice(`${scope} settings in ${path} contain "contextPaging" key(s) that context paging does not read: `
			+ `${ignored.join(", ")}. The keys are enabled, tokenBudget, trimToTokens.`);
	}
}

async function loadSettings(
	ctx: ExtensionContext,
	report: (message: string) => void,
	notice: (message: string) => void,
): Promise<ContextPagingSettingsSources> {
	const codingAgent = await import("@earendil-works/pi-coding-agent") as {
		CONFIG_DIR_NAME?: string;
		getAgentDir?: () => string;
	};
	const projectTrusted = ctx.isProjectTrusted();
	const configDirectory = codingAgent.CONFIG_DIR_NAME ?? ".pi";
	const agentDirectory = codingAgent.getAgentDir?.() ?? join(process.env.HOME ?? "", ".pi", "agent");
	const globalPath = join(agentDirectory, "settings.json");
	const globalSettings = await readJsonSettings(globalPath, report, "Global");
	reportUnreadSettings(notice, globalPath, "Global", globalSettings);
	if (!projectTrusted) return { globalSettings, projectSettings: undefined, projectTrusted };
	// The project path is built only for a trusted project, as before: an untrusted session must not read, stat,
	// or name the project file at all, and a context without a cwd must not reach the join.
	const projectPath = join(ctx.cwd, configDirectory, "settings.json");
	const projectSettings = await readJsonSettings(projectPath, report, "Project");
	reportUnreadSettings(notice, projectPath, "Project", projectSettings);
	return { globalSettings, projectSettings, projectTrusted };
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

/**
 * The oldest Pi whose APIs the paging path can find. `sessionManager.buildSessionProjection()` arrived in
 * 0.87.0 — measured 0.86.1 has no such method, 0.87.0 and every later host tested do. Older hosts load the
 * extension and register all four tools, and before this guard existed their first request that read the
 * session projection threw and aborted the provider call, invisibly until the user was mid-conversation. The
 * check below runs once at session start against the real host object, and is kept in step with
 * `COMPAT_FLOOR` in
 * `scripts/check-host-compat.mjs` by tests/host-compat-contract.test.ts.
 */
const MINIMUM_PI_VERSION = "0.87.0";

/**
 * Probed by calling the API itself. The recall replay rig records host interactions by path and arguments and
 * replays them in order, so a property read of `buildSessionProjection` is an interaction no recording ever
 * made; the call is the boundary the rig already knows (`eval/recall/paging-replay-input.ts:61`).
 */
/**
 * The one wording for "this host cannot page history". Both places that need to say it -- the session-start
 * report and a refused `/context-paging on` -- use it, so the requirement a user is told never drifts.
 */
function capabilityReport(): string {
	return `Context paging: this Pi has no sessionManager.buildSessionProjection(), so history paging requires Pi ${MINIMUM_PI_VERSION} or newer, and context paging stays off for this session.`;
}

function hostSupportsSessionProjection(ctx: ExtensionContext): boolean {
	try {
		ctx.sessionManager.buildSessionProjection();
		return true;
	} catch {
		return false;
	}
}

function persistentSessionMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager.buildSessionProjection().messages;
}

type BranchEdits = { invalidating: string[]; omittedFailures: string[] };
type RotateCommand = { kind: "none" } | { kind: "invalid" } | { kind: "rotate"; trimToTokens?: number };

const COMMAND_USAGE = "Usage: /context-paging [on|off|rotate [tokens]|status|stats]";

function parseRotateCommand(action: string): RotateCommand {
	const parts = action.split(/\s+/u);
	if (parts[0] !== "rotate") return { kind: "none" };
	if (parts.length === 1) return { kind: "rotate" };
	if (parts.length > 2 || !/^[1-9]\d*$/u.test(parts[1]!)) return { kind: "invalid" };
	const trimToTokens = Number(parts[1]!);
	return Number.isSafeInteger(trimToTokens) ? { kind: "rotate", trimToTokens } : { kind: "invalid" };
}

/** Reports what a consumed rotation did, because the queue notice cannot know whether the cut will move. */
function rotationOutcome(selection: ContextSelection, targetTokens: number): { message: string; level: "info" | "warning" } {
	if (selection.advanced) {
		const tokens = selection.estimatedTokens.toLocaleString("en-US");
		return { message: `Context paging rotated to ${tokens} tokens.`, level: "info" };
	}
	// An unmoved cut above the target means only the active request or a protected exchange remains.
	const reason = selection.cutFallbackReason ?? (selection.estimatedTokens > targetTokens
		? "nothing older can be evicted" : "context is already below the rotation target");
	return { message: `Context paging skipped the rotation: ${reason}.`, level: "warning" };
}

/** Separates history-changing edits from Pi retry edits that omit failed responses no request sent. */
function branchEdits(branch: readonly SessionEntry[]): BranchEdits {
	const failedResponseIds = new Set(branch
		.filter((entry) => entry.type === "message" && entry.message.role === "assistant"
			&& isInterruptedAssistantMessage(entry.message))
		.map((entry) => entry.id));
	const edits: BranchEdits = { invalidating: [], omittedFailures: [] };
	for (const entry of branch) {
		if (entry.type === "compaction") edits.invalidating.push(entry.id);
		else if (entry.type !== "context_edit") continue;
		else if (entry.replacement === null && failedResponseIds.has(entry.targetId)) edits.omittedFailures.push(entry.id);
		else edits.invalidating.push(entry.id);
	}
	return edits;
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
	// Set when the host cannot provide the session-projection API; the paging path then stays
	// untouched for the session, so the capability gap is reported once, not as a TypeError per refresh.
	let hostPagingUnsupported = false;
	const isEnabled = () => sessionEnabled ?? resolvedSettings.enabled;
	const publishStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("context-paging", isEnabled() ? "paging on" : "paging off");
	};
	let allItems: HistoryItem[] = [];
	const navigator = new HistoryNavigator();
	const messageCosts = new MessageCostCache();
	const usageTracker = new ContextUsageTracker(messageCosts);
	const cutState = new ContextCutState();
	let projectionWatermark: ProjectionWatermark | undefined;
	let latestInput: InputTokenCount | undefined;
	let pendingRotation: { trimToTokens?: number } | undefined;
	const routeReports = new RouteReports(pi);
	let limitsKey: string | undefined;
	const warnedSettingPairs = new Set<string>();
	const reportedSettingNotices = new Set<string>();
	const resetPagingState = () => {
		usageTracker.clear();
		cutState.reset();
		messageCosts.clear();
		projectionWatermark = undefined;
		latestInput = undefined;
		pendingRotation = undefined;
	};
	const reportSettingsNotice = (ctx: ExtensionContext, message: string): void => {
		// Settings are re-read on every session start (reload, resume, fork, extension reload), and a key the user
		// has not renamed is the same fact each time: one report per distinct message, as with the trim-target
		// warning, so a static configuration problem does not become recurring notification noise.
		if (reportedSettingNotices.has(message)) return;
		reportedSettingNotices.add(message);
		notifySafely(ctx, message);
	};
	const warnAboutTrimTarget = (ctx: ExtensionContext) => {
		const { tokenBudget, trimToTokens, trimToTokensExplicit } = resolvedSettings;
		if (!isEnabled() || !trimToTokensExplicit || trimToTokens < tokenBudget) return;
		const pair = `${tokenBudget}:${trimToTokens}`;
		if (warnedSettingPairs.has(pair)) return;
		warnedSettingPairs.add(pair);
		notifySafely(ctx, `Context paging tokenBudget=${tokenBudget}, trimToTokens=${trimToTokens} leaves no headroom. A smaller trimToTokens restores room between cuts.`, "warning");
	};
	let visibleHistoryIds: string[] = [];
	let invalidatingBranchEntries = new Set<string>();
	let omittedFailureEntries = new Set<string>();
	let canonicalSessionMessages: AgentMessage[] | undefined;
	let restoredInterruptedEntryIds = new Set<string>();
	const refresh = (ctx: ExtensionContext, restoring = false): HistoryItem[] => {
		if (restoring) restoredInterruptedEntryIds = new Set();
		const branch = ctx.sessionManager.getBranch();
		const edits = branchEdits(branch);
		if (edits.invalidating.some((id) => !invalidatingBranchEntries.has(id))) resetPagingState();
		// The omitted response was never sent, so the cut stands. Pi's usage status estimates
		// the whole projection after any edit until the next measured response, so drop the anchor.
		else if (edits.omittedFailures.some((id) => !omittedFailureEntries.has(id))) usageTracker.clear();
		// Keep saved event IDs even before the branch view exposes their entries.
		for (const id of edits.invalidating) invalidatingBranchEntries.add(id);
		for (const id of edits.omittedFailures) omittedFailureEntries.add(id);
		const projection = projectActiveBranchIncremental(branch, projectionWatermark, {
			recoverIncomplete: restoring, interruptedEntryIds: restoredInterruptedEntryIds,
		});
		projectionWatermark = projection.watermark;
		const projected = projection.items;
		if (restoring) restoredInterruptedEntryIds = new Set(projected
			.filter((item) => item.kind === "modelTurn" && item.interruptedByRestore)
			.map((item) => item.id));
		canonicalSessionMessages = persistentSessionMessages(ctx);
		allItems = projected;
		return projected;
	};
	const visibleHistoryChanged = (items: readonly HistoryItem[]): boolean => {
		let index = 0;
		for (const item of items) {
			if (!isRecoverableHistoryItem(item)) continue;
			if (item.id !== visibleHistoryIds[index++]) return true;
		}
		return index !== visibleHistoryIds.length;
	};
	const snapshot = (ctx: ExtensionContext): HistorySnapshot => {
		const projected = refresh(ctx);
		if (visibleHistoryChanged(projected)) {
			navigator.rebuild(projected);
			visibleHistoryIds = projected.filter(isRecoverableHistoryItem).map((item) => item.id);
		}
		return { allItems, navigator };
	};
	const refreshSafely = (ctx: ExtensionContext, restoring = false) => {
		// A disabled feature does not reach for host APIs it cannot have: on a pre-0.87.0 host this path is a
		// TypeError, and stacking "navigation is unavailable" on the named capability report tells the user twice
		// in the wrong words. Status is published by the caller.
		if (hostPagingUnsupported) return;
		try {
			refresh(ctx, restoring);
		} catch (error) {
			usageTracker.clear();
			canonicalSessionMessages = undefined;
			notifySafely(ctx, `Context paging navigation is unavailable: ${errorMessage(error)}`, "error");
		}
	};

	pi.registerCommand("context-paging", {
		description: "Enable, disable, or rotate context paging for this session, or show status and stats",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "stats") {
				try {
					notifySafely(ctx, await contextPagingStats(ctx, isEnabled(), resolvedSettings.tokenBudget, latestInput), "info");
				} catch (error) {
					notifySafely(ctx, `Context paging stats are unavailable: ${errorMessage(error)}`, "warning");
				}
				return;
			}
			const rotateCommand = parseRotateCommand(action);
			if (rotateCommand.kind === "invalid") {
				notifySafely(ctx, COMMAND_USAGE, "warning");
				return;
			}
			if (rotateCommand.kind === "rotate") {
				if (!isEnabled()) {
					notifySafely(ctx, "Context paging is disabled for this session.", "warning");
					return;
				}
				const { tokenBudget } = resolvedSettings;
				const requested = rotateCommand.trimToTokens ?? resolvedSettings.trimToTokens;
				// selectContext caps the target at the budget, so a target at or above it would rotate nothing.
				if (tokenBudget <= requested) {
					notifySafely(ctx, `Rotation target must be below the ${tokenBudget.toLocaleString("en-US")}-token budget.`, "warning");
					return;
				}
				let effective: number;
				try {
					// A model window below tokenBudget scales the target down, so we show the target selection will use.
					effective = contextTokenLimits({
						tokenBudget, trimToTokens: requested, modelContextWindow: ctx.model?.contextWindow,
					}).trimToTokens;
				} catch (error) {
					notifySafely(ctx, `Context paging cannot rotate: ${errorMessage(error)}`, "warning");
					return;
				}
				pendingRotation = { trimToTokens: rotateCommand.trimToTokens };
				notifySafely(ctx, `Context paging will rotate to ${effective.toLocaleString("en-US")} tokens on the next request.`, "info");
				return;
			}
			if (action === "on" || action === "off") {
				const enabled = action === "on";
				// The per-session switch outranks the settings default, so it has to honour the capability check too.
				// Reporting success on a host that cannot page leaves the user trusting a status line that protects
				// nothing: paging would page nothing, silently. Refuse, name the requirement, keep the status honest.
				if (enabled && hostPagingUnsupported) {
					notifySafely(ctx, capabilityReport(), "warning");
					publishStatus(ctx);
					return;
				}
				if (enabled !== isEnabled()) resetPagingState();
				sessionEnabled = enabled;
				publishStatus(ctx);
			} else if (action !== "" && action !== "status") {
				notifySafely(ctx, COMMAND_USAGE, "warning");
				return;
			}
			notifySafely(ctx, `Context paging is ${isEnabled() ? "enabled" : "disabled"} for this session.`, "info");
		},
	});

	registerContextPagingTools(pi, {
		isEnabled,
		snapshot,
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionEnabled = undefined;
		routeReports.close();
		resetPagingState();
		invalidatingBranchEntries = new Set();
		omittedFailureEntries = new Set();
		try {
			if (!settingsSources) {
				resolvedSettings = { ...resolvedSettings, enabled: false };
				const problems: string[] = [];
				const notices: string[] = [];
				resolvedSettings = resolveContextPagingSettings(await loadSettings(
					ctx,
					problem => problems.push(problem),
					message => notices.push(message),
				));
				// Unread keys are reported as they are found: paging stays on, because the settings that do exist
				// were read successfully and the user needs to hear about the key, not lose the feature.
				for (const message of notices) reportSettingsNotice(ctx, message);
				if (problems.length) {
					// Never enable an intrusive feature from a configuration the user did not successfully express.
					resolvedSettings = { ...resolvedSettings, enabled: false };
					notifySafely(ctx, `Context paging: ${problems.join("; ")}, and context paging stays off for this session.`);
				}
			}

			// A host that predates the session-projection API cannot page history at all. Turn the feature off for
			// the session and name the requirement, instead of letting the first provider call die with a TypeError.
			hostPagingUnsupported = !hostSupportsSessionProjection(ctx);
			if (hostPagingUnsupported) {
				resolvedSettings = { ...resolvedSettings, enabled: false };
				notifySafely(ctx, capabilityReport());
			}
		} catch (error) {
			// Settings loading is best effort: the session is never blocked and the failure is reported once. The flag
			// was cleared above, before any file was read, so a load that explodes cannot leave paging enabled on values
			// the user did not express. Pinned by the reload test in tests/index-status.test.ts.
			notifySafely(ctx, `Context paging settings are unavailable: ${errorMessage(error)}`);
		} finally {
			publishStatus(ctx);
		}
		refreshSafely(ctx, true);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		routeReports.close();
		if (ctx.hasUI) ctx.ui.setStatus("context-paging", undefined);
	});
	pi.on("turn_start", (_event, ctx) => {
		routeReports.open(modelKey(ctx.model));
	});
	// A request that ends before the context hook, such as a failed route, ends here.
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") routeReports.close();
	});
	pi.on("agent_end", () => {
		routeReports.close();
	});
	pi.on("turn_end", (event, ctx) => {
		usageTracker.recordResponse(event.message);
		latestInput = reportedInputTokens(event.message) ?? (latestInput?.estimated ? latestInput : undefined);
		refreshSafely(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		routeReports.close();
		resetPagingState();
		invalidatingBranchEntries = new Set();
		omittedFailureEntries = new Set();
		refreshSafely(ctx, true);
	});
	pi.on("model_select", () => {
		routeReports.close();
		resetPagingState();
	});
	pi.on("session_compact", (event) => {
		const id = event.compactionEntry?.id;
		if (id && invalidatingBranchEntries.has(id)) return;
		resetPagingState();
		if (id) invalidatingBranchEntries.add(id);
	});
	pi.on("context", (event, ctx) => {
		// Take the report even when disabled, so it cannot apply to a later request.
		const routeReport = routeReports.take(modelKey(ctx.model));
		if (!isEnabled()) return;
		warnAboutTrimTarget(ctx);

		let limits: RequestLimits;
		try {
			limits = requestLimits(ctx, routeReport);
		} catch (error) {
			ctx.abort();
			notifySafely(ctx, `Context paging aborted this provider call: ${errorMessage(error)}`, "error");
			return { messages: event.messages };
		}
		// A virtual model can route each request to a different model, which is a model switch.
		if (limitsKey !== undefined && limitsKey !== limits.key) resetPagingState();
		limitsKey = limits.key;

		let rawHistoryItems: readonly HistoryItem[] | undefined;
		try {
			rawHistoryItems = refresh(ctx);
		} catch (error) {
			usageTracker.clear();
			canonicalSessionMessages = undefined;
			notifySafely(ctx, `Context paging history is unavailable: ${errorMessage(error)}`, "error");
		}
		usageTracker.bindKeys(rawHistoryItems ? historyItemKeyResolver(rawHistoryItems) : undefined);

		// The rotation stays queued until selection succeeds, so an aborted provider call does not lose it.
		const rotation = pendingRotation;
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
			const selectionLimits = {
				modelContextWindow: limits.contextWindow,
				tokenBudget: resolvedSettings.tokenBudget,
				trimToTokens: rotation?.trimToTokens ?? resolvedSettings.trimToTokens,
			};
			const selection = selectContext({
				messages: event.messages,
				systemPrompt,
				activeTools,
				...selectionLimits,
				rotate: rotation !== undefined,
				cutState: cutState.prepare(rawHistoryItems),
				contextTokens,
				tokenEstimates: usageTracker.tokenEstimates,
				outgoingOnly,
				rawHistoryItems,
			});
			// Unknown canonical provenance is an empty trusted subset, never the outgoing request.
			usageTracker.recordSelection(selection.messages, residentTokens, canonicalSessionMessages ?? []);
			cutState.commit(selection.cutState);
			if (rotation) {
				// Cleared alongside the commit: this handler is synchronous, so later tool calls in the turn do not rotate again.
				pendingRotation = undefined;
				const outcome = rotationOutcome(selection, contextTokenLimits(selectionLimits).trimToTokens);
				notifySafely(ctx, outcome.message, outcome.level);
			}
			latestInput = { tokens: selection.estimatedTokens, estimated: true };
			return { messages: selection.messages };
		} catch (error) {
			ctx.abort();
			notifySafely(ctx, `Context paging aborted this provider call: ${errorMessage(error)}`, "error");
			return { messages: event.messages };
		}
	});
	pi.on("session_before_compact", async (event) => {
		if (!isEnabled()) return;
		if (event.reason === "threshold" || event.reason === "overflow") return { cancel: true };
		usageTracker.clear();
	});
}
