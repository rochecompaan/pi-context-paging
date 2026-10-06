import type { Usage } from "@earendil-works/pi-ai";
import { convertToLlm, sessionEntryToContextMessages, type AgentSession, type AgentSessionEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { PAGING_TOOL_NAMES } from "../../src/history.ts";
import { decodeCodexPayload, type OriginIndex, type RequestEvidence, type RequestMeta } from "./codex-payload.ts";
import type { ProviderUsageObservation, RequestHooks } from "./codex-runtime.ts";
import type { RecoveryResult } from "./evidence.ts";
import { sanitizeArtifact } from "./safe-artifacts.ts";
import type { Arm, PromptStep } from "./workload.ts";

export type UsageLedgerEntry = {
	entryId: string;
	kind: "assistant" | "explicit" | "compaction";
	requestIds: readonly string[];
	sdkUsage: Usage | null;
	observations: readonly ProviderUsageObservation[];
};
export type CompactionEvent = { eventIndex: number; reason: string; success: boolean; entryId?: string };
export type JournalEvent = { type: string; eventIndex: number; promptId: string | null; requestId?: string; status?: number | null };
export type JournalOptions = {
	arm: Arm;
	eventSink?: (event: JournalEvent) => void;
	requestGuard?: (meta: RequestMeta) => void;
};
function texts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	return Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => String(part.text)) : [];
}
function unknownUsage(requestId: string): ProviderUsageObservation {
	return { requestId, usagePresent: false, error: "no-observation", inputTokens: null, outputTokens: null, cachedTokens: null, cacheWriteTokens: null };
}

/** Host IDs and lifecycle events join wire observations to SDK-owned entries. */
export class PiJournal {
	session!: AgentSession;
	currentPrompt: PromptStep | null = null;
	promptCount = 0;
	requests: RequestEvidence[] = [];
	recoveryResults: RecoveryResult[] = [];
	compactions: CompactionEvent[] = [];
	errors: { code: string; promptId: string | null }[] = [];
	finalAnswerText = "";
	finalAnswerEventIndex = -1;
	private eventIndex = 0;
	private nextRequest = 0;
	private purpose: RequestMeta["purpose"] = "conversation";
	private sourcePrompts = new Map<string, string>();
	private usage = new Map<string, ProviderUsageObservation>();
	private joins = new Map<string, { kind: UsageLedgerEntry["kind"]; requestIds: string[] }>();
	private pending: Record<RequestMeta["purpose"], string[]> = { conversation: [], compaction: [] };
	private callRequests = new Map<string, RequestMeta>();
	private metas = new Map<string, RequestMeta>();
	private options: JournalOptions;
	constructor(options: JournalOptions) { this.options = options; }
	private emit(type: string, details: Pick<JournalEvent, "requestId" | "status"> = {}) {
		const event = { type, eventIndex: ++this.eventIndex, promptId: this.currentPrompt?.id ?? null, ...details };
		this.options.eventSink?.(event);
		return event.eventIndex;
	}
	begin(step: PromptStep) {
		this.currentPrompt = step; this.promptCount++;
		this.finalAnswerText = ""; this.finalAnswerEventIndex = -1;
		this.emit("prompt-start");
	}
	fail(code: string) {
		this.errors.push({ code, promptId: this.currentPrompt?.id ?? null }); this.emit(code);
	}
	private refresh() {
		for (const entry of this.session.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user" && !this.sourcePrompts.has(entry.id)) {
				if (this.currentPrompt && texts(entry.message.content).join("\n") === this.currentPrompt.text) {
					this.sourcePrompts.set(entry.id, this.currentPrompt.id);
				}
			}
			if (this.joins.has(entry.id)) continue;
			if (entry.type === "message" && entry.message.role === "assistant") {
				// One native stream result owns one assistant entry. Ambiguous joins stay unknown.
				const ids = this.pending.conversation.splice(0);
				this.joins.set(entry.id, { kind: "assistant", requestIds: ids.length === 1 ? ids : [] });
				if (ids.length === 1) for (const part of entry.message.content) {
					if (part.type === "toolCall") this.callRequests.set(part.id, this.metas.get(ids[0])!);
				}
			} else if (entry.type === "compaction") {
				this.joins.set(entry.id, { kind: "compaction", requestIds: this.pending.compaction.splice(0) });
			} else if (entry.type === "usage") this.joins.set(entry.id, { kind: "explicit", requestIds: [] });
		}
	}
	origins(): OriginIndex {
		this.refresh();
		return this.session.sessionManager.getBranch().flatMap(entry => {
			if (entry.type !== "compaction" && !this.sourcePrompts.has(entry.id)) return [];
			return convertToLlm(sessionEntryToContextMessages(entry)).map(message => ({
				role: message.role, texts: texts(message.content),
				...(entry.type === "compaction" ? { compactionEntryId: entry.id } : { sourcePromptId: this.sourcePrompts.get(entry.id)! }),
			}));
		});
	}
	hooks(): RequestHooks {
		return {
			allocateMeta: () => {
				if (!this.currentPrompt) throw new Error("Request outside prompt scope");
				const meta: RequestMeta = { requestId: `${this.options.arm}-request-${++this.nextRequest}`,
					promptId: this.currentPrompt.id, arm: this.options.arm, purpose: this.purpose };
				this.metas.set(meta.requestId, meta); this.pending[meta.purpose].push(meta.requestId); return meta;
			},
			onPayload: async (meta, payload) => {
				const evidence = decodeCodexPayload(payload, meta, this.origins());
				this.requests.push(evidence); this.emit("payload", { requestId: meta.requestId });
				if (!evidence.complete || this.errors.some(error => error.code === "extension-error")) throw new Error("Payload observation incomplete");
			},
			beforeHttpAttempt: meta => { this.options.requestGuard?.(meta); this.emit("http-attempt", { requestId: meta.requestId }); },
			onHttpAttemptEnd: (meta, status) => { this.emit("http-attempt-end", { requestId: meta.requestId, status }); },
			onUsageObservation: (meta, observation) => {
				this.usage.set(meta.requestId, observation); this.emit("usage-observation", { requestId: meta.requestId });
			},
		};
	}
	onEvent(event: AgentSessionEvent) {
		const index = this.emit(event.type);
		if (event.type === "compaction_start") {
			this.refresh(); this.purpose = "compaction";
		} else if (event.type === "compaction_end") {
			this.refresh(); this.purpose = "conversation";
			const entry = this.session.sessionManager.getBranch().reverse().find(entry => entry.type === "compaction");
			this.compactions.push({ eventIndex: index, reason: event.reason, success: !!event.result && !event.aborted,
				...(event.result && entry ? { entryId: entry.id } : {}) });
			if (event.errorMessage) this.fail("compaction-error");
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			this.refresh();
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") this.fail(`assistant-${event.message.stopReason}`);
			if (!event.message.content.some(part => part.type === "toolCall")) {
				this.finalAnswerText = texts(event.message.content).join("\n"); this.finalAnswerEventIndex = index;
			}
		} else if (event.type === "tool_execution_end" && PAGING_TOOL_NAMES.some(name => name === event.toolName)) {
			this.refresh();
			const meta = this.callRequests.get(event.toolCallId);
			if (!meta) { this.fail("unjoined-recovery-result"); return; }
			const result = event.result as { content?: unknown };
			this.recoveryResults.push({ ...meta, toolCallId: event.toolCallId, toolName: event.toolName,
				text: texts(result.content).join("\n"), isError: event.isError, eventIndex: index });
		}
	}
	// Extension-level observation also sees attempts canceled before compaction_start.
	beforeCompaction(_reason: string) { this.emit("before-compaction"); }
	afterPrompt() {
		this.refresh();
		const last = this.session.sessionManager.getBranch().reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
		if (last?.type === "message" && last.message.role === "assistant" && last.message.stopReason !== "error" && last.message.stopReason !== "aborted") {
			this.errors = this.errors.filter(error => error.promptId !== this.currentPrompt?.id || error.code !== "assistant-error");
		}
		if (this.purpose === "compaction") this.purpose = "conversation";
		this.emit("prompt-idle");
	}
	ledger(): UsageLedgerEntry[] {
		this.refresh();
		return this.session.sessionManager.getBranch().flatMap(entry => {
			const join = this.joins.get(entry.id);
			if (!join) return [];
			const sdkUsage = entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage
				: entry.type === "compaction" || entry.type === "usage" ? entry.usage ?? null : null;
			return [{ entryId: entry.id, ...join, sdkUsage,
				observations: join.requestIds.map(id => this.usage.get(id) ?? unknownUsage(id)) }];
		});
	}
	entries(): readonly SessionEntry[] {
		return sanitizeArtifact(this.session.sessionManager.getBranch()) as SessionEntry[];
	}
}
