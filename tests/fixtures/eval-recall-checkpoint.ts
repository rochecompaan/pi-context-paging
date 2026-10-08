import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, estimateTokens, SessionManager, SettingsManager,
	type AgentSession, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createPagingReplay, type PagingReplayTape, type RestorationEvidence } from "../../eval/recall/paging-replay.ts";
import type { ContextPagingSettingsSources } from "../../src/index.ts";
import { PAGING_SETTINGS, EVAL_MODEL } from "../../eval/recall/experiment-settings.ts";
import { fixtureRuntime, measuredUsage } from "./eval-recall-provider.ts";

export type ReplayCase = "calibrated-cut" | "context-edit" | "native-summary" | "recovery-followup";
type NativeView = {
	branch: SessionEntry[];
	projection: ReturnType<SessionManager["buildSessionProjection"]>;
	residentSystemPrompt: string;
	tools: { name: string; description: string; parameters: unknown }[];
	autoCompactionEnabled: boolean;
};
type FixtureArm = { session: AgentSession; nativeView(): NativeView; next(): Promise<unknown> };
export type ReplayFixture = {
	source: FixtureArm;
	checkpointView: NativeView;
	frozenView(): NativeView;
	dispatchCount(): number;
	tape: PagingReplayTape;
	restore(options?: { tape?: PagingReplayTape; settings?: ContextPagingSettingsSources; mutate?: (session: AgentSession) => void }): Promise<FixtureArm & { restoration: RestorationEvidence }>;
	close(): Promise<void>;
};

/** Real SDK and paging tools with local SSE and fixture-controlled future identities. */
export async function prepareReplayFixture(caseName: ReplayCase): Promise<ReplayFixture> {
	const root = await mkdtemp(join(tmpdir(), "recall-replay-"));
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	const sessions: AgentSession[] = [];
	const fixtures: Awaited<ReturnType<typeof fixtureRuntime>>[] = [];
	let searchNext = false;
	let summarizeNext = false;
	const opaque = { type: "reasoning" as const, id: "rs-fixture", encrypted_content: "SYNTHETIC_PRIVATE_CONTINUATION", summary: [] };
	async function make(entries?: SessionEntry[], configuration?: ContextPagingSettingsSources) {
		const replay = createPagingReplay(configuration ?? { globalSettings: { contextPaging: { ...PAGING_SETTINGS } }, projectTrusted: false });
		const provider = await fixtureRuntime((_index, context) => {
			const usage = { ...measuredUsage,
				input_tokens: Math.ceil(context.messages.reduce((sum, message) => sum + estimateTokens(message), 0) * 1.35) + 8_000 };
			if (searchNext) {
				searchNext = false;
				return { tool: { name: "search_history", arguments: { query: "record", load: true } }, usage, reasoning: opaque };
			}
			if (summarizeNext) { summarizeNext = false; return { text: "Native incident summary with preserved facts.", usage, reasoning: opaque }; }
			return { text: "Noted.", usage, reasoning: opaque };
		});
		fixtures.push(provider);
		const settingsManager = SettingsManager.inMemory({ transport: "sse", cacheWarming: "off", packages: [] });
		const agentDir = join(root, `agent-${sessions.length}`);
		await mkdir(agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [replay.factory], systemPromptOverride: () => "Offline incident fixture. Resident instructions. ".repeat(250),
		});
		await resourceLoader.reload();
		if (resourceLoader.getExtensions().errors.length) throw new Error("Fixture extension failed");
		const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager,
			modelRuntime: provider.runtime, model: provider.runtime.getModel(EVAL_MODEL.provider, EVAL_MODEL.id),
			thinkingLevel: EVAL_MODEL.thinking, noTools: "builtin", sessionManager: SessionManager.inMemory(cwd, undefined, entries),
		});
		sessions.push(session);
		const errors: string[] = [];
		await session.bindExtensions({ onError: error => errors.push(error.error) });
		let followup = 0;
		return {
			session, replay,
			nativeView: (): NativeView => structuredClone({ branch: session.sessionManager.getBranch(),
				projection: session.sessionManager.buildSessionProjection(), residentSystemPrompt: session.systemPrompt,
				tools: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
				autoCompactionEnabled: session.autoCompactionEnabled }),
			async prompt(text: string) {
				const before = provider.dispatches.length;
				await session.prompt(text, { expandPromptTemplates: false });
				await session.waitForIdle();
				if (errors.length) throw new Error("Fixture lifecycle failed");
				if (provider.dispatches.length === before) throw new Error(`Fixture never dispatched: ${JSON.stringify(session.agent.state.messages.filter(message => message.role === "assistant").map(message => message.errorMessage))}`);
				const payload = structuredClone(provider.dispatches.at(-1)!.payload) as Record<string, unknown>;
				// Native transport session identity may differ; no model-visible block changes.
				if (payload.prompt_cache_key !== session.sessionManager.getSessionId()) throw new Error("Unexpected transport cache identity");
				delete payload.prompt_cache_key;
				return payload;
			},
			async next() {
				const step = followup++;
				let counter = (step + 1) * 1_000;
				const existing = new Set(session.sessionManager.getEntries().map(entry => entry.id));
				// Fixture input to the SDK's random ID primitive, not an ID rewrite.
				// Exact future payload comparison needs identical future event identities.
				const generator = mock.method(crypto, "randomUUID", () => {
					let id: string;
					do { id = (++counter).toString(16).padStart(8, "0"); } while (existing.has(id));
					existing.add(id);
					return `${id}-0000-4000-8000-000000000000` as ReturnType<typeof crypto.randomUUID>;
				});
				syncBuiltinESMExports();
				try { return await this.prompt(`Next incident record ${step}. ` + "new observations. ".repeat(4_000)); }
				finally { generator.mock.restore(); syncBuiltinESMExports(); }
			},
		};
	}
	try {
		const source = await make();
		for (let i = 0; i < 9; i++) await source.prompt(`Incident record ${i}: evidence. ` + "Service record details. ".repeat(4_000));
		if (caseName === "context-edit") {
			const target = source.session.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!;
			source.session.sessionManager.appendContextEdit(target.id, { content: "Corrected incident record." });
			await source.prompt("Record the correction.");
		}
		if (caseName === "native-summary") {
			summarizeNext = true;
			await source.session.compact("Keep the incident evidence.");
			await source.prompt("Continue from the native summary.");
		}
		if (caseName === "recovery-followup") {
			searchNext = true;
			await source.prompt("Recover the earlier incident records.");
		}
		const checkpointView = source.nativeView();
		const tape = source.replay.freeze();
		return {
			source, checkpointView, tape,
			frozenView: () => structuredClone(checkpointView),
			dispatchCount: () => fixtures.reduce((sum, fixture) => sum + fixture.dispatches.length, 0),
			async restore(options = {}) {
				const restored = await make(structuredClone(checkpointView.branch), options.settings);
				options.mutate?.(restored.session);
				const restoration = await restored.replay.restore(restored.session, options.tape ?? tape);
				return { ...restored, restoration };
			},
			async close() {
				for (const session of sessions) { await session.abort(); session.dispose(); }
				await rm(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		for (const session of sessions) { await session.abort(); session.dispose(); }
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
