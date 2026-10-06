import { createHash } from "node:crypto";
import { join } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type Provider, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RequestMeta } from "./codex-payload.ts";
import { observeSseUsage, type ProviderUsageObservation } from "./codex-usage.ts";
import { sanitizeArtifact } from "./safe-artifacts.ts";
export type { ProviderUsageObservation } from "./codex-usage.ts";

export const EVAL_MODEL = { provider: "openai-codex", id: "gpt-6-luna", thinking: "xhigh" } as const;
export type SafeModelMetadata = Pick<Model<Api>, "provider" | "id" | "api" | "contextWindow" | "maxTokens" | "cost" | "reasoning" | "thinkingLevelMap">;
export type RequestHooks = {
	allocateMeta(): RequestMeta;
	onPayload(meta: RequestMeta, payload: unknown, context: TranscriptContext): Promise<void>;
	beforeHttpAttempt(meta: RequestMeta): void;
	onHttpAttemptEnd(meta: RequestMeta, status: number | null): void;
	onUsageObservation(meta: RequestMeta, observation: ProviderUsageObservation): void;
};
export type RuntimeFactory = (agentDir: string) => Promise<ModelRuntime>;
export type PreparedRuntime = {
	runtime: ModelRuntime;
	model: Model<Api>;
	metadata: SafeModelMetadata;
	metadataFingerprint: string;
	assertUnchanged(): void;
};

function freeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		Object.values(value).forEach(freeze); Object.freeze(value);
	}
	return value;
}
function metadataFor(model: Model<Api>): SafeModelMetadata {
	const { provider, id, api, contextWindow, maxTokens, cost, reasoning, thinkingLevelMap } = model;
	const safe = sanitizeArtifact({ modelMetadata: { provider, id, api, contextWindow, maxTokens, cost, reasoning, thinkingLevelMap } }) as { modelMetadata: SafeModelMetadata };
	return freeze(safe.modelMetadata);
}
export function metadataFingerprint(metadata: SafeModelMetadata): string {
	return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
}

export function observeProvider(base: Provider, hooks: RequestHooks): Provider {
	const optionsFor = <T extends StreamOptions | undefined>(context: TranscriptContext, supplied: T): T & StreamOptions => {
		const options: StreamOptions = supplied ?? {};
		const meta = hooks.allocateMeta();
		const fetch = options.fetch ?? globalThis.fetch;
		let observed = false;
		return { ...options, transport: "sse",
			onPayload: async (payload, model) => {
				const replacement = await options.onPayload?.(payload, model);
				await hooks.onPayload(meta, replacement === undefined ? payload : replacement, context);
				return replacement;
			},
			fetch: async (url, init) => {
				hooks.beforeHttpAttempt(meta);
				let response: Response;
				try { response = await fetch(url, init); }
				catch (error) { hooks.onHttpAttemptEnd(meta, null); throw error; }
				hooks.onHttpAttemptEnd(meta, response.status);
				return observeSseUsage(response, meta, observation => {
					if (!observed) { observed = true; hooks.onUsageObservation(meta, observation); }
				});
			},
		} as T & StreamOptions;
	};
	return { ...base,
		stream: (model, context, options) => base.stream(model, context, optionsFor(context, options)),
		streamSimple: (model, context, options) => base.streamSimple(model, context, { ...options, ...optionsFor(context, options) }),
	};
}

const createRuntime: RuntimeFactory = agentDir => ModelRuntime.create({
	authPath: join(agentDir, "auth.json"), modelsPath: null,
	modelsStorePath: join(agentDir, "models-cache.json"), allowModelNetwork: false,
});

export async function prepareCodexRuntime(agentDir: string, hooks: RequestHooks, factory: RuntimeFactory = createRuntime): Promise<PreparedRuntime> {
	const runtime = await factory(agentDir);
	const model = runtime.getModel(EVAL_MODEL.provider, EVAL_MODEL.id);
	if (!model || model.api !== "openai-codex-responses") throw new Error("Exact eval model unavailable");
	if (!getSupportedThinkingLevels(model).includes(EVAL_MODEL.thinking)) throw new Error("Eval model does not support xhigh");
	const available = await runtime.getAvailable(EVAL_MODEL.provider);
	if (!available.some(candidate => candidate.id === EVAL_MODEL.id)) throw new Error("Eval model credentials unavailable");
	const metadata = metadataFor(model);
	const fingerprint = metadataFingerprint(metadata);
	const assertUnchanged = () => {
		const current = runtime.getModel(EVAL_MODEL.provider, EVAL_MODEL.id);
		if (!current || metadataFingerprint(metadataFor(current)) !== fingerprint) throw new Error("Eval model metadata changed");
	};
	const provider = runtime.getProvider(EVAL_MODEL.provider);
	if (!provider) throw new Error("Eval provider unavailable");
	runtime.registerNativeProvider(observeProvider(provider, { ...hooks,
		allocateMeta: () => { assertUnchanged(); return hooks.allocateMeta(); },
		beforeHttpAttempt: meta => { assertUnchanged(); hooks.beforeHttpAttempt(meta); },
	}));
	assertUnchanged();
	return { runtime, model, metadata, metadataFingerprint: fingerprint, assertUnchanged };
}
