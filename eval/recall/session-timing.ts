import type { AgentSessionEvent, ExtensionFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RequestMeta } from "./codex-payload.ts";
import type { OperationStatus, SessionOwner } from "./metrics.ts";
import { operationOwner, type TaskRecorder } from "./task-metrics.ts";

/** SDK event joins are task-local; tool IDs never determine session ownership. */
export class SessionTiming {
	private promptId: string | null = null;
	private promptOperation: string | null = null;
	private compactionOperation: string | null = null;
	private compactionCanceled = false;
	private tools = new Map<string, string>();
	private owner: SessionOwner;
	private recorder: TaskRecorder;
	constructor(owner: SessionOwner, recorder: TaskRecorder) { this.owner = owner; this.recorder = recorder; }
	private scope(meta?: RequestMeta, toolCallId: string | null = null, toolName: string | null = null) {
		return operationOwner(this.owner, { promptId: this.promptId, requestId: meta?.requestId ?? null, toolCallId, toolName });
	}
	beginPrompt(promptId: string): void {
		this.promptId = promptId;
		this.promptOperation = this.recorder.begin("prompt", this.scope());
	}
	endPrompt(status: OperationStatus): void {
		if (this.promptOperation) this.recorder.end(this.promptOperation, status);
		this.promptOperation = null;
	}
	beforeCompaction(): void {
		this.compactionCanceled = false;
		this.compactionOperation = this.recorder.begin("compaction", this.scope());
	}
	compactionDecision(canceled: boolean): void { this.compactionCanceled ||= canceled; }
	onEvent(event: AgentSessionEvent, meta?: RequestMeta): void {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			const key = JSON.stringify([this.promptId, meta?.requestId ?? null, event.toolCallId]);
			const scope = this.scope(meta, event.toolCallId, event.toolName);
			if (event.type === "tool_execution_start") {
				if (!this.tools.has(key)) this.tools.set(key, this.recorder.begin("tool", scope));
			} else {
				const id = this.tools.get(key);
				if (id) this.recorder.end(id, event.isError ? "failed" : "succeeded");
				else this.tools.set(key, this.recorder.endWithoutStart("tool", scope, event.isError ? "failed" : "succeeded"));
			}
		} else if (event.type === "compaction_end") {
			const status = this.compactionCanceled ? "canceled" : event.aborted ? "aborted" : event.result ? "succeeded" : "failed";
			if (this.compactionOperation) this.recorder.end(this.compactionOperation, status);
			else this.recorder.endWithoutStart("compaction", this.scope(), status);
			this.compactionOperation = null; this.compactionCanceled = false;
		}
	}
}

/** Observe the actual decision; the SDK uses `aborted` for both cancellation and abort. */
export function observeCompactionDecision(factory: ExtensionFactory, observe: (canceled: boolean) => void): ExtensionFactory {
	return pi => factory(new Proxy(pi, {
		get(target, property) {
			if (property === "on") return (name: string, handler: (event: any, ctx: ExtensionContext) => any) => {
				if (name !== "session_before_compact") return pi.on(name as "context", handler);
				return pi.on("session_before_compact", async (event, ctx) => {
					const result = await handler(event, ctx);
					observe(result?.cancel === true);
					return result;
				});
			};
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}));
}
