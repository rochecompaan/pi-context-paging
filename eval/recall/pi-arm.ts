import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory, type SessionEntry, type SessionStats } from "@earendil-works/pi-coding-agent";
import contextPagingExtension from "../../src/index.ts";
import { prepareCodexRuntime, EVAL_MODEL, type RuntimeFactory, type SafeModelMetadata } from "./codex-runtime.ts";
import type { OriginIndex, RequestEvidence, RequestMeta } from "./codex-payload.ts";
import type { RecoveryResult } from "./evidence.ts";
import { PiJournal, type CompactionEvent, type JournalEvent, type UsageLedgerEntry } from "./pi-journal.ts";
import type { Arm, PromptStep } from "./workload.ts";
import { PAGING_SETTINGS } from "./experiment-settings.ts";
export type { UsageLedgerEntry } from "./pi-journal.ts";

export type Clock = {
	nowMs(): number;
	setTimeout(callback: () => void, milliseconds: number): unknown;
	clearTimeout(handle: unknown): void;
};
export const realClock: Clock = {
	nowMs: () => performance.now(),
	setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export type ArmSnapshot = {
	arm: Arm;
	promptCount: number;
	requests: readonly RequestEvidence[];
	recoveryResults: readonly RecoveryResult[];
	finalAnswerText: string;
	finalAnswerEventIndex: number;
	origins: OriginIndex;
	compactions: readonly CompactionEvent[];
	entries: readonly SessionEntry[];
	usageLedger: readonly UsageLedgerEntry[];
	latencyMs: number;
	statsCrossCheck: Pick<SessionStats, "tokens" | "cost">;
	errors: readonly { code: string; promptId: string | null }[];
	modelMetadata: SafeModelMetadata;
	metadataFingerprint: string;
};
export type EvalArm = {
	runPrompt(step: PromptStep): Promise<ArmSnapshot>;
	snapshot(): ArmSnapshot;
	abort(): Promise<void>;
	dispose(): void;
};
export type PiArmOptions = {
	arm: Arm;
	agentDir: string;
	resourceDir: string;
	eventSink?: (event: JournalEvent) => void;
	requestGuard?: (meta: RequestMeta) => void | Promise<void>;
	clock?: Clock;
	createRuntime?: RuntimeFactory;
};
const systemPrompt = "You are investigating a service incident. Use the supplied conversation records as evidence. Follow each prompt's requested answer format. Never invent an unrecorded setting.";

/** Independent native SDK sessions differ only in their paging extension. */
export async function createPiArm(options: PiArmOptions): Promise<EvalArm> {
	const clock = options.clock ?? realClock;
	const cwd = join(options.resourceDir, "workspace");
	const resources = join(options.resourceDir, "agent");
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(resources, { recursive: true })]);
	const journal = new PiJournal(options);
	const prepared = await prepareCodexRuntime(options.agentDir, journal.hooks(), options.createRuntime);
	const settingsManager = SettingsManager.inMemory({ transport: "sse", cacheWarming: "off", packages: [] });
	const observer: ExtensionFactory = pi => {
		pi.on("session_before_compact", event => { journal.beforeCompaction(event.reason); });
	};
	const factories: ExtensionFactory[] = [observer];
	if (options.arm === "paging") factories.push(pi => contextPagingExtension(pi, {
		globalSettings: { contextPaging: { ...PAGING_SETTINGS } }, projectTrusted: false,
	}));
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: resources, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: factories, systemPromptOverride: () => systemPrompt,
	});
	await resourceLoader.reload();
	if (resourceLoader.getExtensions().errors.length) throw new Error("Eval extension loading failed");
	const { session } = await createAgentSession({ cwd, agentDir: resources, modelRuntime: prepared.runtime,
		model: prepared.model, thinkingLevel: EVAL_MODEL.thinking, noTools: "builtin",
		settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd),
	});
	journal.session = session;
	const unsubscribe = session.subscribe(event => journal.onEvent(event));
	try {
		await session.bindExtensions({ onError: () => journal.fail("extension-error") });
		prepared.assertUnchanged();
		if (journal.errors.length || session.model?.id !== EVAL_MODEL.id
			|| session.model?.provider !== EVAL_MODEL.provider || session.thinkingLevel !== EVAL_MODEL.thinking) {
			throw new Error("Eval session selection mismatch");
		}
	} catch (error) {
		await session.abort(); unsubscribe(); session.dispose(); throw error;
	}
	let latencyMs = 0;
	let disposed = false;
	const snapshot = (): ArmSnapshot => ({
		arm: options.arm, promptCount: journal.promptCount, requests: [...journal.requests],
		recoveryResults: [...journal.recoveryResults], finalAnswerText: journal.finalAnswerText,
		finalAnswerEventIndex: journal.finalAnswerEventIndex, origins: journal.origins(),
		compactions: [...journal.compactions], entries: journal.entries(), usageLedger: journal.ledger(),
		latencyMs, statsCrossCheck: { tokens: session.getSessionStats().tokens, cost: session.getSessionStats().cost },
		errors: [...journal.errors], modelMetadata: prepared.metadata, metadataFingerprint: prepared.metadataFingerprint,
	});
	return {
		snapshot,
		runPrompt: async step => {
			if (disposed || journal.errors.length) throw new Error("Eval arm is unavailable");
			journal.begin(step);
			const started = clock.nowMs();
			try {
				prepared.assertUnchanged();
				await session.prompt(step.text, { expandPromptTemplates: false });
				await session.waitForIdle();
			} catch { journal.fail("prompt-error"); }
			finally { latencyMs += clock.nowMs() - started; journal.afterPrompt(); }
			return snapshot();
		},
		abort: () => session.abort(),
		dispose: () => { if (!disposed) { disposed = true; unsubscribe(); session.dispose(); } },
	};
}
