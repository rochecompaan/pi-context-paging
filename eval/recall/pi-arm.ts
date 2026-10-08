import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { realClock, type Clock } from "./clock.ts";
export { realClock, type Clock } from "./clock.ts";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory, type SessionEntry, type SessionStats } from "@earendil-works/pi-coding-agent";
import { createPagingReplay } from "./paging-replay.ts";
import { copyPrivate, equalPrivate } from "./paging-replay-input.ts";
import { assertOwner, type SessionOwner, type RequestRecord } from "./metrics.ts";
import { checkpointEvidence, freezeCheckpoint, restoreCheckpointData, type PrivateCheckpoint, type CheckpointEvidence, type CheckpointRestoration } from "./checkpoint.ts";
import { prepareCodexRuntime, EVAL_MODEL, type RuntimeFactory, type SafeModelMetadata } from "./codex-runtime.ts";
import type { OriginIndex, RequestEvidence, RequestMeta } from "./codex-payload.ts";
import type { RecoveryResult, ObservedToolCall } from "./evidence.ts";
import { PiJournal, type CompactionEvent, type JournalEvent, type UsageLedgerEntry } from "./pi-journal.ts";
import type { Arm, PromptStep } from "./workload.ts";
import type { ExecutionUsageRow } from "./usage.ts";
import { PAGING_SETTINGS } from "./experiment-settings.ts";
import { createTaskRecorder, operationOwner, ownedTaskRecords, type TaskRecorder, type PhaseRecord } from "./task-metrics.ts";
import { observeCompactionDecision } from "./session-timing.ts";
export type { UsageLedgerEntry } from "./pi-journal.ts";

export type ArmSnapshot = {
	arm: Arm;
	owner: SessionOwner;
	checkpoint?: CheckpointEvidence;
	restoration?: CheckpointRestoration;
	promptCount: number;
	requests: readonly RequestEvidence[];
	requestRecords: readonly RequestRecord[];
	taskRecords: readonly PhaseRecord[];
	recoveryResults: readonly RecoveryResult[];
	toolCalls: readonly ObservedToolCall[];
	finalAnswerText: string;
	finalAnswerEventIndex: number;
	origins: OriginIndex;
	compactions: readonly CompactionEvent[];
	entries: readonly SessionEntry[];
	usageLedger: readonly UsageLedgerEntry[];
	executionUsage: readonly ExecutionUsageRow[];
	latencyMs: number;
	statsCrossCheck: Pick<SessionStats, "tokens" | "cost">;
	errors: readonly { code: string; promptId: string | null }[];
	modelMetadata: SafeModelMetadata;
	metadataFingerprint: string;
};
export type EvalArm = {
	captureCheckpoint(): Promise<PrivateCheckpoint>;
	runPrompt(step: PromptStep): Promise<ArmSnapshot>;
	snapshot(): ArmSnapshot;
	abort(): Promise<void>;
	dispose(): void;
};
export type PiArmOptions = {
	arm: Arm;
	owner: SessionOwner;
	checkpoint?: PrivateCheckpoint;
	agentDir: string;
	resourceDir: string;
	eventSink?: (event: JournalEvent) => void;
	requestGuard?: (meta: RequestMeta) => void | Promise<void>;
	payloadGuard?: (evidence: RequestEvidence) => void | Promise<void>;
	clock?: Clock;
	createRuntime?: RuntimeFactory;
	taskRecorder?: TaskRecorder;
};
const systemPrompt = "You are investigating a service incident. Use the supplied conversation records as evidence. Follow each prompt's requested answer format. Never invent an unrecorded setting.";

/** Setup and private restoration are disjoint host phases, not model requests. */
export async function createPiArm(options: PiArmOptions): Promise<EvalArm> {
	assertOwner(options.owner);
	const clock = options.clock ?? realClock, recorder = options.taskRecorder ?? createTaskRecorder(clock);
	const scope = operationOwner(options.owner);
	let phase: string | null = null;
	try {
		if (options.checkpoint) phase = recorder.begin("checkpoint-restore", scope);
		const inherited = options.checkpoint ? restoreCheckpointData(options.checkpoint) : null;
		if (phase) recorder.end(phase, "succeeded");
		phase = recorder.begin(inherited ? "fork-setup" : "source-setup", scope);
		const arm = await buildPiArm(options, clock, recorder, inherited, () => {
			recorder.end(phase!, "succeeded");
			phase = inherited ? recorder.begin("checkpoint-restore", scope) : null;
		});
		if (phase) recorder.end(phase, "succeeded");
		return arm;
	} catch (error) { if (phase) recorder.end(phase, "failed"); throw error; }
}

/** Independent native SDK sessions differ only in their paging extension. */
async function buildPiArm(options: PiArmOptions, clock: Clock, recorder: TaskRecorder,
	inherited: ReturnType<typeof restoreCheckpointData> | null, setupComplete: () => void): Promise<EvalArm> {
	const owner = copyPrivate(options.owner);
	if (owner.arm !== options.arm || (inherited ? owner.checkpointId !== options.checkpoint!.id || !owner.forkId
		|| owner.runId !== inherited.owner.runId || owner.seed !== inherited.owner.seed || owner.stage !== inherited.owner.stage
		|| owner.arm !== inherited.owner.arm || owner.sessionId === inherited.owner.sessionId : owner.forkId !== null)) {
		throw new Error("Checkpoint ownership mismatch");
	}
	const workspace = join(options.resourceDir, "workspace");
	const cwd = inherited?.configuration.cwd ?? workspace;
	const resources = join(options.resourceDir, "agent");
	await Promise.all([mkdir(workspace, { recursive: true, mode: 0o700 }), mkdir(resources, { recursive: true, mode: 0o700 })]);
	const journal = new PiJournal({ ...options, owner, taskRecorder: recorder });
	const replay = options.arm === "paging" ? createPagingReplay({
		globalSettings: { contextPaging: { ...PAGING_SETTINGS } }, projectTrusted: false,
	}) : null;
	const prepared = await prepareCodexRuntime(options.agentDir, journal.hooks(), options.createRuntime, clock);
	const settingsManager = SettingsManager.inMemory({ transport: "sse", cacheWarming: "off", packages: [] });
	const observer: ExtensionFactory = pi => {
		pi.on("session_before_compact", event => { journal.beforeCompaction(event.reason); });
	};
	const factories: ExtensionFactory[] = [observer];
	if (replay) factories.push(observeCompactionDecision(replay.factory, canceled => journal.compactionDecision(canceled)));
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: resources, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: factories, systemPromptOverride: () => systemPrompt,
	});
	await resourceLoader.reload();
	if (resourceLoader.getExtensions().errors.length) throw new Error("Eval extension loading failed");
	const { session } = await createAgentSession({ cwd, agentDir: resources, modelRuntime: prepared.runtime,
		model: prepared.model, thinkingLevel: EVAL_MODEL.thinking, noTools: "builtin",
		settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd, { id: owner.sessionId }, inherited?.entries),
	});
	journal.session = session;
	let unsubscribe = () => {};
	let restoration: CheckpointRestoration | undefined;
	const configuration = () => copyPrivate({ metadataFingerprint: prepared.metadataFingerprint, model: session.model, cwd,
		thinkingLevel: session.thinkingLevel, systemPrompt: session.systemPrompt,
		tools: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
		autoCompactionEnabled: session.autoCompactionEnabled });
	try {
		await session.bindExtensions({ onError: () => journal.fail("extension-error") });
		prepared.assertUnchanged();
		if (journal.errors.length || session.model?.id !== EVAL_MODEL.id
			|| session.model?.provider !== EVAL_MODEL.provider || session.thinkingLevel !== EVAL_MODEL.thinking) {
			throw new Error("Eval session selection mismatch");
		}
		setupComplete();
		if (inherited) {
			const checks = { configuration: equalPrivate(configuration(), inherited.configuration),
				branch: equalPrivate(session.sessionManager.getBranch(), inherited.entries),
				projection: equalPrivate(session.sessionManager.buildSessionProjection(), inherited.projection),
				leaf: session.sessionManager.getLeafId() === inherited.leafId };
			const failed = Object.entries(checks).find(([, passed]) => !passed);
			if (failed) throw Object.assign(new Error("Native checkpoint fidelity mismatch"), { code: `checkpoint-native-${failed[0]}-mismatch` });
			restoration = replay && inherited.tape ? await replay.restore(session, inherited.tape)
				: { method: "baseline-native-history-v1", passed: !replay && !inherited.tape,
					checks: [{ name: "native-history-match", passed: true }], failureCode: null };
			if (!restoration.passed) throw new Error("Paging checkpoint restoration failed");
			journal.inherit(inherited.promptCount, inherited.provenance, inherited.compactions);
		}
		unsubscribe = session.subscribe(event => journal.onEvent(event));
	} catch (error) {
		try { await session.abort(); } finally { unsubscribe(); session.dispose(); }
		throw error;
	}
	let latencyMs = 0;
	let disposed = false, running = false, forkPromptSent = false;
	let captured: PrivateCheckpoint | undefined;
	const snapshot = (): ArmSnapshot => ({
		arm: options.arm, owner: copyPrivate(owner),
		...((captured ?? options.checkpoint) ? { checkpoint: checkpointEvidence((captured ?? options.checkpoint)!) } : {}),
		...(restoration ? { restoration: copyPrivate(restoration) } : {}),
		promptCount: journal.promptCount, requests: copyPrivate(journal.requests), requestRecords: copyPrivate(journal.requestRecords),
		taskRecords: ownedTaskRecords(recorder, owner),
		recoveryResults: copyPrivate(journal.recoveryResults), toolCalls: copyPrivate(journal.toolCalls), finalAnswerText: journal.finalAnswerText,
		finalAnswerEventIndex: journal.finalAnswerEventIndex, origins: journal.origins(),
		compactions: copyPrivate(journal.compactions), entries: journal.entries(), usageLedger: copyPrivate(journal.ledger()), executionUsage: journal.executionLedger(),
		latencyMs, statsCrossCheck: { tokens: session.getSessionStats().tokens, cost: session.getSessionStats().cost },
		errors: [...journal.errors], modelMetadata: prepared.metadata, metadataFingerprint: prepared.metadataFingerprint,
	});
	return {
		snapshot,
		async captureCheckpoint() {
			const phase = recorder.begin("checkpoint-capture", operationOwner(owner));
			try {
				if (disposed || running || inherited || !session.isIdle || session.isStreaming || session.isRetrying || session.isCompacting
					|| session.hasPendingBashMessages || session.getSteeringMessages().length || session.getFollowUpMessages().length
					|| !journal.checkpointEligible || journal.errors.length || journal.recoveryResults.length || journal.promptCount < 23) {
					throw new Error("Source is not eligible for a private checkpoint");
				}
				if (captured) { recorder.end(phase, "succeeded"); return captured; }
				prepared.assertUnchanged();
				captured = freezeCheckpoint({ owner, entries: session.sessionManager.getBranch(), leafId: session.sessionManager.getLeafId(),
					projection: session.sessionManager.buildSessionProjection(), configuration: configuration(), promptCount: journal.promptCount,
					provenance: journal.provenance(), compactions: journal.compactions, tape: replay?.freeze() ?? null });
				recorder.end(phase, "succeeded");
				return captured;
			} catch (error) { recorder.end(phase, "failed"); throw error; }
		},
		runPrompt: async step => {
			if (disposed || running || captured || journal.errors.length || (inherited && (forkPromptSent || step.kind !== "probe"))) throw new Error("Eval arm is unavailable");
			running = true;
			if (inherited) forkPromptSent = true;
			journal.begin(step);
			const started = clock.nowMs();
			try {
				prepared.assertUnchanged();
				await session.prompt(step.text, { expandPromptTemplates: false });
				await session.waitForIdle();
			} catch { journal.fail("prompt-error"); }
			finally { latencyMs += clock.nowMs() - started; journal.afterPrompt(); running = false; }
			return snapshot();
		},
		abort: () => session.abort(),
		dispose: () => { if (!disposed) { disposed = true; unsubscribe(); session.dispose(); } },
	};
}
