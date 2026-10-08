import { SessionManager } from "@earendil-works/pi-coding-agent";
import { freezeCheckpoint, restoreCheckpointData, checkpointDigest, type PrivateCheckpoint } from "../../eval/recall/checkpoint.ts";
import { decodeCodexPayload, type RequestEvidence, type RequestMeta } from "../../eval/recall/codex-payload.ts";
import type { ArmFactoryOptions } from "../../eval/recall/fork.ts";
import type { ArmSnapshot, Clock, EvalArm } from "../../eval/recall/pi-arm.ts";
import { buildWorkload, factForProbe, type PromptStep, type Workload } from "../../eval/recall/workload.ts";
import { makeScriptedArm } from "./eval-recall.ts";
import { createAttemptRecord, finishOperation, startOperation, type RequestRecord } from "../../eval/recall/metrics.ts";
import { operationOwner, ownedTaskRecords } from "../../eval/recall/task-metrics.ts";
import { PAGING_RESTORATION_METHOD } from "../../eval/recall/paging-replay.ts";

export function groupClock() {
	let time = 0;
	const timers = new Map<object, { deadline: number; callback: () => void }>();
	const clock: Clock = { nowMs: () => time, utcNow: () => new Date(Date.UTC(2026, 0, 1) + time).toISOString(),
		setTimeout(callback, delay) { const key = {}; timers.set(key, { deadline: time + delay, callback }); return key; },
		clearTimeout(handle) { timers.delete(handle as object); } };
	return { clock, advance(ms: number) { time += ms; for (const [key, timer] of timers) if (timer.deadline <= time) {
		timers.delete(key); timer.callback();
	} }, get activeTimers() { return timers.size; } };
}
export function stageFixture(workload: Workload = buildWorkload("stage"), controls: {
	visibleFifth?: boolean; wrongAnswers?: boolean; failRestoration?: boolean; compactDuringA?: boolean;
	onCreate?(options: ArmFactoryOptions): Promise<void>;
	onPrompt?(options: ArmFactoryOptions, step: PromptStep): Promise<void>;
	attempts?: number;
} = {}) {
	const sessions: { options: ArmFactoryOptions; received: PromptStep[]; inherited: string[]; disposed: boolean; aborted: number }[] = [];
	const dispatches: RequestMeta[] = [], cleaned: string[] = [], checkpoints: { checkpoint: PrivateCheckpoint; digest: string }[] = [];
	return { workload, sessions, dispatches, cleaned, checkpoints,
		async cleanupSession(owner: ArmFactoryOptions["owner"]) { cleaned.push(owner.sessionId); },
		async createArm(options: ArmFactoryOptions): Promise<EvalArm> {
			await controls.onCreate?.(options);
			const clock = options.clock!, recorder = options.taskRecorder!;
			const hostPhase = (name: Parameters<typeof recorder.begin>[0], promptId: string | null = null) => {
				const phase = recorder.begin(name, operationOwner(options.owner, { promptId })); recorder.end(phase, "succeeded");
			};
			hostPhase(options.checkpoint ? "fork-setup" : "source-setup");
			if (options.checkpoint) hostPhase("checkpoint-restore");
			const inherited = options.checkpoint ? restoreCheckpointData(options.checkpoint) : null;
			const manager = SessionManager.inMemory("/fixture", { id: options.owner.sessionId }, inherited?.entries);
			const row = { options, received: [] as PromptStep[], inherited: manager.getBranch().filter(e => e.type === "message" && e.message.role === "user")
				.map(e => e.type === "message" && e.message.role === "user" ? e.message.content : "") as string[], disposed: false, aborted: 0 };
			sessions.push(row);
			const base = makeScriptedArm({ arm: options.arm, owner: options.owner, workload, beforeAttempt: options.requestGuard, order: [] }).instance.snapshot();
			let state: ArmSnapshot = { ...base, promptCount: inherited?.promptCount ?? 0,
				compactions: inherited?.compactions.map(event => ({ ...event, inherited: true })) ?? [],
				...(inherited ? { restoration: { method: options.arm === "paging" ? PAGING_RESTORATION_METHOD : "baseline-native-history-v1", passed: !controls.failRestoration,
					checks: [{ name: "native-history-match", passed: true }], failureCode: controls.failRestoration ? "test-restore" : null } } : {}) };
			const provenance = new Map(inherited?.provenance ?? []);
			return {
				snapshot: () => structuredClone(state),
				async runPrompt(step) {
					const promptPhase = recorder.begin("prompt", operationOwner(options.owner, { promptId: step.id }));
					row.received.push(step); state.promptCount++;
					const id = manager.appendMessage({ role: "user", content: step.text, timestamp: 0 });
					provenance.set(id, step.id);
					state.origins = [...provenance].map(([entryId, sourcePromptId]) => ({ role: "user", texts: [], sourcePromptId }));
					const originals = options.arm === "baseline" && !state.compactions.some(event => event.success);
					const blocks = originals ? workload.facts.filter(fact => provenance.has([...provenance].find(([, p]) => p === fact.sourcePromptId)?.[0] ?? ""))
						.map(fact => ({ role: "user", content: `${fact.subject}: ${fact.field} = ${fact.value}` })) : [];
					const summaryText = workload.facts.map(fact => `${fact.subject}: ${fact.field} = ${fact.value}`).join("\n");
					if (options.arm === "baseline" && !originals) blocks.push({ role: "user", content: summaryText });
					blocks.push({ role: "user", content: step.text });
					const probe = workload.probes[options.owner.stage].find(probe => probe.id === step.probeId);
					if (controls.visibleFifth && options.arm === "paging" && probe?.factId?.endsWith("decision")) blocks.push({ role: "assistant", content: factForProbe(workload, probe)!.value });
					const meta: RequestMeta = { ...options.owner, promptId: step.id, requestId: `${options.owner.sessionId}:${step.id}`, purpose: "conversation" };
					const request: RequestEvidence = decodeCodexPayload({ model: "fixture", store: false, instructions: "Recall accurately", input: blocks }, meta,
						originals ? workload.facts.map(fact => ({ role: "user", texts: [`${fact.subject}: ${fact.field} = ${fact.value}`], sourcePromptId: fact.sourcePromptId }))
						: options.arm === "baseline" ? [{ role: "user", texts: [summaryText], compactionEntryId: "fixture-compaction" }] : []);
					state.requests = [...state.requests, request];
					const requestRecord: RequestRecord = { ...meta, timing: startOperation(clock), attempts: [], status: "censored", requestWallMs: { value: null, status: "incomplete", reason: "operation-active" } };
					state.requestRecords = [...state.requestRecords, requestRecord];
					try {
						await options.payloadGuard?.(request);
						for (let attempt = 0; attempt < (controls.attempts ?? 1); attempt++) {
							await options.requestGuard(meta); dispatches.push(meta);
							const measured = createAttemptRecord(meta, `${meta.requestId}:attempt-${attempt}`, clock); measured.httpStatus = 200;
							finishOperation(measured.timing, "succeeded", clock); measured.attemptWallMs = measured.timing.durationMs;
							measured.responseHeadersMs = { value: 0, status: "observed", reason: null }; measured.observationComplete = true;
							measured.timeToFirstModelDeltaMs = { value: null, status: "not-reported", reason: "no-model-delta" };
							measured.timeToFirstTextMs = { value: null, status: "not-reported", reason: "no-text-delta" };
							requestRecord.attempts.push(measured);
						}
					} catch { state.errors = [...state.errors, { code: "test-wire-stopped", promptId: step.id }];
						finishOperation(requestRecord.timing, "failed", clock); requestRecord.status = "failed"; recorder.end(promptPhase, "failed"); return structuredClone(state); }
					finishOperation(requestRecord.timing, "succeeded", clock); requestRecord.status = "succeeded"; requestRecord.requestWallMs = requestRecord.timing.durationMs;
					state.finalAnswerText = probe ? JSON.stringify({ answer: controls.wrongAnswers ? "wrong" : factForProbe(workload, probe)?.value ?? null }) : "Noted.";
					state.finalAnswerEventIndex = row.received.length * 10;
					if (options.arm === "baseline" && ((!inherited && options.owner.stage === "B" && state.promptCount === 20)
						|| (inherited && controls.compactDuringA))) { state.compactions = [...state.compactions, { eventIndex: state.finalAnswerEventIndex + 1, reason: "threshold", success: true }]; hostPhase("compaction", step.id); }
					state.entries = manager.getBranch();
					await controls.onPrompt?.(options, step);
					recorder.end(promptPhase, "succeeded"); state.taskRecords = ownedTaskRecords(recorder, options.owner);
					return structuredClone(state);
				},
				async captureCheckpoint() {
					hostPhase("checkpoint-capture");
					const checkpoint = freezeCheckpoint({ owner: options.owner, entries: manager.getBranch(), leafId: manager.getLeafId(), projection: manager.buildSessionProjection(),
						configuration: { cwd: "/fixture", model: undefined, metadataFingerprint: "fixture-model", tools: [], thinkingLevel: "xhigh", systemPrompt: "test", autoCompactionEnabled: true },
						promptCount: state.promptCount, provenance: [...provenance], compactions: [...state.compactions], tape: null });
					checkpoints.push({ checkpoint, digest: checkpointDigest(checkpoint) }); return checkpoint;
				},
				async abort() { row.aborted++; }, dispose() { row.disposed = true; },
			};
		} };
}
