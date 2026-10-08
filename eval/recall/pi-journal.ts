import type { Usage } from "@earendil-works/pi-ai";
import { convertToLlm, sessionEntryToContextMessages, type AgentSession, type AgentSessionEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { PAGING_TOOL_NAMES } from "../../src/history.ts";
import { decodeCodexPayload, type OriginIndex, type RequestEvidence, type RequestMeta } from "./codex-payload.ts";
import type { ProviderUsageObservation, RequestHooks } from "./codex-runtime.ts";
import type { RecoveryResult, ObservedToolCall } from "./evidence.ts";
import { sanitizeArtifact } from "./safe-artifacts.ts";
import type { Arm, PromptStep } from "./workload.ts";
import { completeRequestMeasurements, type SessionOwner, type RequestRecord, type OperationStatus } from "./metrics.ts";
import { unknownProviderUsage } from "./codex-usage.ts";
import { ExecutionUsageLedger, type ExecutionUsageRow } from "./usage.ts";
import { createTaskRecorder, type TaskRecorder } from "./task-metrics.ts";
import { realClock } from "./clock.ts";
import { SessionTiming } from "./session-timing.ts";

export type UsageLedgerEntry = {
	entryId: string;
	kind: "assistant" | "explicit" | "compaction";
	requestIds: readonly string[];
	catalogPricesKnown: boolean;
	sdkUsage: Usage | null;
	observations: readonly ProviderUsageObservation[];
};
export type CompactionEvent = { eventIndex: number; reason: string; success: boolean; entryId?: string; inherited?: boolean };
export type JournalEvent = SessionOwner & { type: string; eventIndex: number; promptId: string | null; requestId?: string; attemptId?: string; status?: number | null; operationStatus?: OperationStatus };
export type JournalOptions = {
	taskRecorder?: TaskRecorder;
	arm: Arm;
	owner: SessionOwner;
	eventSink?: (event: JournalEvent) => void;
	requestGuard?: (meta: RequestMeta) => void | Promise<void>;
	payloadGuard?: (evidence: RequestEvidence) => void | Promise<void>;
};
function texts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	return Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => String(part.text)) : [];
}
function unknownUsage(requestId: string): ProviderUsageObservation {
	return unknownProviderUsage(requestId, "no-observation");
}

/** Host IDs and lifecycle events join wire observations to SDK-owned entries. */
export class PiJournal {
	session!: AgentSession;
	currentPrompt: PromptStep | null = null;
	promptCount = 0;
	requests: RequestEvidence[] = [];
	recoveryResults: RecoveryResult[] = [];
	toolCalls: ObservedToolCall[] = [];
	compactions: CompactionEvent[] = [];
	errors: { code: string; promptId: string | null }[] = [];
	finalAnswerText = "";
	finalAnswerEventIndex = -1;
	private eventIndex = 0;
	requestRecords: RequestRecord[] = [];
	private nextRequest = 0;
	private purpose: RequestMeta["purpose"] = "conversation";
	private sourcePrompts = new Map<string, string>();
	private inheritedIds = new Set<string>();
	checkpointEligible = true;
	private usage = new Map<string, ProviderUsageObservation>();
	private execution = new ExecutionUsageLedger();
	private joins = new Map<string, { kind: UsageLedgerEntry["kind"]; requestIds: string[] }>();
	private pending: Record<RequestMeta["purpose"], string[]> = { conversation: [], compaction: [] };
	private callRequests = new Map<string, RequestMeta>();
	private metas = new Map<string, RequestMeta>();
	private options: JournalOptions;
	readonly timing: SessionTiming;
	constructor(options: JournalOptions) {
		this.options = options;
		this.timing = new SessionTiming(options.owner, options.taskRecorder ?? createTaskRecorder(realClock));
	}
	private emit(type: string, details: Pick<JournalEvent, "requestId" | "attemptId" | "status" | "operationStatus"> = {}) {
		const event = { ...this.options.owner, type, eventIndex: ++this.eventIndex, promptId: this.currentPrompt?.id ?? null, ...details };
		this.options.eventSink?.(event);
		return event.eventIndex;
	}
	begin(step: PromptStep) {
		this.currentPrompt = step; this.promptCount++;
		this.timing.beginPrompt(step.id);
		if (step.kind === "probe") this.checkpointEligible = false;
		this.finalAnswerText = ""; this.finalAnswerEventIndex = -1;
		this.emit("prompt-start");
	}
	fail(code: string) {
		this.checkpointEligible = false;
		this.errors.push({ code, promptId: this.currentPrompt?.id ?? null }); this.emit(code);
	}
	private refresh() {
		for (const entry of this.session.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "user" && !this.sourcePrompts.has(entry.id)) {
				if (this.currentPrompt && texts(entry.message.content).join("\n") === this.currentPrompt.text) {
					this.sourcePrompts.set(entry.id, this.currentPrompt.id);
				}
			}
			if (this.inheritedIds.has(entry.id) || this.joins.has(entry.id)) continue;
			if (entry.type === "message" && entry.message.role === "assistant") {
				// One native stream result owns one assistant entry. Ambiguous joins stay unknown.
				const ids = this.pending.conversation.splice(0);
				this.joins.set(entry.id, { kind: "assistant", requestIds: ids.length === 1 ? ids : [] });
				this.execution.joinSdkEntry({ owner: this.options.owner, entryId: entry.id, kind: "assistant", requestIds: ids, sdkUsage: entry.message.usage });
				if (ids.length === 1) for (const part of entry.message.content) {
					if (part.type === "toolCall") {
						const meta = this.metas.get(ids[0])!;
						this.callRequests.set(part.id, meta);
						this.toolCalls.push({ ...meta, toolCallId: part.id, toolName: part.name, eventIndex: this.eventIndex });
					}
				}
			} else if (entry.type === "compaction") {
				const requestIds = this.pending.compaction.splice(0);
				this.joins.set(entry.id, { kind: "compaction", requestIds });
				this.execution.joinSdkEntry({ owner: this.options.owner, entryId: entry.id, kind: "compaction", requestIds, sdkUsage: entry.usage ?? null });
			} else if (entry.type === "usage") {
				this.joins.set(entry.id, { kind: "explicit", requestIds: [] });
				this.execution.joinSdkEntry({ owner: this.options.owner, entryId: entry.id, kind: "explicit", requestIds: [], sdkUsage: entry.usage });
			}
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
				const meta: RequestMeta = { ...this.options.owner, requestId: `${this.options.owner.sessionId}-request-${++this.nextRequest}`,
					promptId: this.currentPrompt.id, purpose: this.purpose };
				this.metas.set(meta.requestId, meta); this.pending[meta.purpose].push(meta.requestId); return meta;
			},
			onPayload: async (meta, payload) => {
				const evidence = decodeCodexPayload(payload, meta, this.origins());
				this.requests.push(evidence); this.emit("payload", { requestId: meta.requestId });
				await this.options.payloadGuard?.(evidence);
				if (!evidence.complete || this.errors.some(error => error.code === "extension-error")) throw new Error("Payload observation incomplete");
			},
			beforeHttpAttempt: async meta => { await this.options.requestGuard?.(meta); },
			onRequestStart: request => { this.requestRecords.push(request); this.execution.recordRequest(request); this.emit("request-start", { requestId: request.requestId }); },
			onAttemptStart: attempt => { this.emit("http-attempt", { requestId: attempt.requestId, attemptId: attempt.attemptId }); },
			onResponseHeaders: attempt => { this.emit("response-headers", { requestId: attempt.requestId, attemptId: attempt.attemptId, status: attempt.httpStatus }); },
			onAttemptSettled: attempt => { this.emit("http-attempt-end", { requestId: attempt.requestId, attemptId: attempt.attemptId, status: attempt.httpStatus, operationStatus: attempt.timing.status }); },
			onRequestSettled: request => { this.emit("request-end", { requestId: request.requestId, operationStatus: request.status }); },
			onUsageObservation: (meta, observation) => {
				this.usage.set(meta.requestId, observation); this.emit("usage-observation", { requestId: meta.requestId });
			},
		};
	}
	onEvent(event: AgentSessionEvent) {
		const index = this.emit(event.type);
		if (event.type === "tool_execution_start") this.refresh();
		this.timing.onEvent(event, event.type === "tool_execution_start" || event.type === "tool_execution_end" ? this.callRequests.get(event.toolCallId) : undefined);
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
			this.checkpointEligible = false;
			this.refresh();
			const meta = this.callRequests.get(event.toolCallId);
			if (!meta) { this.fail("unjoined-recovery-result"); return; }
			const result = event.result as { content?: unknown };
			this.recoveryResults.push({ ...meta, toolCallId: event.toolCallId, toolName: event.toolName,
				text: texts(result.content).join("\n"), isError: event.isError, eventIndex: index });
		}
	}
	// Count at the extension boundary, even when paging cancels before provider dispatch.
	beforeCompaction(_reason: string) { this.emit("before-compaction"); this.timing.beforeCompaction(); }
	compactionDecision(canceled: boolean) { this.timing.compactionDecision(canceled); }
	afterPrompt() {
		this.refresh();
		const last = this.session.sessionManager.getBranch().reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
		if (last?.type === "message" && last.message.role === "assistant" && last.message.stopReason !== "error" && last.message.stopReason !== "aborted") {
			this.errors = this.errors.filter(error => error.promptId !== this.currentPrompt?.id || error.code !== "assistant-error");
		}
		if (this.purpose === "compaction") this.purpose = "conversation";
		if (this.requestRecords.some(request => request.promptId === this.currentPrompt?.id && !completeRequestMeasurements(request))) {
			this.fail("mandatory-observation-incomplete");
		}
		this.emit("prompt-idle");
		const errors = this.errors.filter(error => error.promptId === this.currentPrompt?.id);
		this.timing.endPrompt(errors.some(error => error.code === "assistant-aborted") ? "aborted" : errors.length ? "failed" : "succeeded");
	}
	ledger(): UsageLedgerEntry[] {
		this.refresh();
		return this.session.sessionManager.getBranch().flatMap(entry => {
			const join = this.joins.get(entry.id);
			if (!join) return [];
			const sdkUsage = entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage
				: entry.type === "compaction" || entry.type === "usage" ? entry.usage ?? null : null;
			const prices = this.session.model?.cost;
			const catalogPricesKnown = !!prices && [prices.input, prices.output, prices.cacheRead, prices.cacheWrite]
				.every(price => typeof price === "number" && Number.isFinite(price) && price >= 0);
			return [{ entryId: entry.id, ...join, sdkUsage, catalogPricesKnown,
				observations: join.requestIds.map(id => this.usage.get(id) ?? unknownUsage(id)) }];
		});
	}
	executionLedger(): ExecutionUsageRow[] { this.refresh(); return this.execution.snapshot(); }
	provenance(): [string, string][] { this.refresh(); return [...this.sourcePrompts]; }
	inherit(promptCount: number, provenance: [string, string][], compactions: readonly CompactionEvent[]) {
		if (this.promptCount || this.requests.length) throw new Error("Journal must inherit before execution");
		this.promptCount = promptCount;
		this.sourcePrompts = new Map(provenance);
		this.inheritedIds = new Set(this.session.sessionManager.getBranch().map(entry => entry.id));
		this.compactions = compactions.map(event => ({ ...event, inherited: true }));
	}
	entries(): readonly SessionEntry[] {
		return sanitizeArtifact(this.session.sessionManager.getBranch()) as SessionEntry[];
	}
}
