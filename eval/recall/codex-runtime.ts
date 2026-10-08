import { createHash } from "node:crypto";
import { join } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model, type Provider, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RequestMeta } from "./codex-payload.ts";
import type { ProviderUsageObservation } from "./codex-usage.ts";
import { observeCodexStream, settleAttempt } from "./codex-stream.ts";
import { createAttemptRecord, elapsed, finishOperation, startOperation, type AttemptRecord, type RequestRecord, type OperationStatus } from "./metrics.ts";
import { realClock, type Clock } from "./clock.ts";
import { sanitizeArtifact } from "./safe-artifacts.ts";
export type { ProviderUsageObservation } from "./codex-usage.ts";

import { EVAL_MODEL } from "./experiment-settings.ts";
export { EVAL_MODEL } from "./experiment-settings.ts";
export type SafeModelMetadata = Pick<Model<Api>, "provider" | "id" | "api" | "contextWindow" | "maxTokens" | "cost" | "reasoning" | "thinkingLevelMap">;
export type RequestHooks = {
	allocateMeta(): RequestMeta;
	onPayload(meta: RequestMeta, payload: unknown, context: TranscriptContext): Promise<void>;
	beforeHttpAttempt(meta: RequestMeta): void | Promise<void>;
	onRequestStart(request: RequestRecord): void;
	onAttemptStart(attempt: AttemptRecord): void;
	onResponseHeaders(attempt: AttemptRecord): void;
	onAttemptSettled(attempt: AttemptRecord): void;
	onRequestSettled(request: RequestRecord): void;
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
export function metadataFor(model: Model<Api>): SafeModelMetadata {
	const { provider, id, api, contextWindow, maxTokens, cost, reasoning, thinkingLevelMap } = model;
	const safe = sanitizeArtifact({ modelMetadata: { provider, id, api, contextWindow, maxTokens, cost, reasoning, thinkingLevelMap } }) as { modelMetadata: SafeModelMetadata };
	return freeze(safe.modelMetadata);
}
export function metadataFingerprint(metadata: SafeModelMetadata): string {
	return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
}

export function observeProvider(base: Provider, hooks: RequestHooks, clock: Clock = realClock): Provider {
	const optionsFor = <T extends StreamOptions | undefined>(context: TranscriptContext, supplied: T) => {
		const options: StreamOptions = supplied ?? {};
		const meta = hooks.allocateMeta();
		const timing = startOperation(clock);
		const request: RequestRecord = { ...meta, timing, attempts: [], status: "censored", requestWallMs: timing.durationMs };
		hooks.onRequestStart(request);
		const fetch = options.fetch ?? globalThis.fetch;
		return { request, options: { ...options, transport: "sse",
			onPayload: async (payload, model) => {
				const replacement = await options.onPayload?.(payload, model);
				await hooks.onPayload(meta, replacement === undefined ? payload : replacement, context);
				return replacement;
			},
			fetch: async (url, init) => {
				await hooks.beforeHttpAttempt(meta);
				const attempt = createAttemptRecord(meta, `${meta.requestId}-attempt-${request.attempts.length + 1}`, clock);
				hooks.onAttemptStart(attempt); request.attempts.push(attempt);
				try {
					const response = await fetch(url, init);
					attempt.httpStatus = response.status;
					attempt.responseHeadersMs = elapsed(attempt.timing.startMs, clock.nowMs());
					hooks.onResponseHeaders(attempt);
					return observeCodexStream(response, { attempt, clock, signal: init?.signal,
						onUsage: observation => hooks.onUsageObservation(meta, observation),
						onSettled: record => hooks.onAttemptSettled(record) });
				} catch (error) {
					const aborted = init?.signal?.aborted || (error instanceof Error && error.name === "AbortError");
					if (settleAttempt(attempt, clock, aborted ? "aborted" : "failed", aborted ? "http-fetch-aborted" : "http-fetch-failed")) hooks.onAttemptSettled(attempt);
					throw error;
				}
			},
		} as T & StreamOptions };
	};
	const observe = (call: () => ReturnType<Provider["stream"]>, request: RequestRecord) => {
		const settle = (status: OperationStatus) => {
			if (request.timing.endMs !== null) return;
			for (const attempt of request.attempts) {
				if (settleAttempt(attempt, clock, status === "aborted" ? "aborted" : "censored", "native-stream-unsettled")) hooks.onAttemptSettled(attempt);
			}
			finishOperation(request.timing, status, clock); request.status = status; request.requestWallMs = request.timing.durationMs;
			hooks.onRequestSettled(request);
		};
		try {
			const stream = call();
			// result() observes the native terminal promise; it does not consume events.
			void stream.result().then(message => settle(message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "failed" : "succeeded"))
				.catch(() => settle("failed"));
			return stream;
		} catch (error) { settle("failed"); throw error; }
	};
	return { ...base,
		stream: (model, context, options) => {
			const prepared = optionsFor(context, options);
			return observe(() => base.stream(model, context, prepared.options), prepared.request);
		},
		streamSimple: (model, context, options) => {
			const prepared = optionsFor(context, options);
			return observe(() => base.streamSimple(model, context, { ...options, ...prepared.options }), prepared.request);
		},
	};
}

const createRuntime: RuntimeFactory = agentDir => ModelRuntime.create({
	authPath: join(agentDir, "auth.json"), modelsPath: null,
	modelsStorePath: join(agentDir, "models-cache.json"), allowModelNetwork: false,
});

export async function prepareCodexRuntime(agentDir: string, hooks: RequestHooks, factory: RuntimeFactory = createRuntime, clock: Clock = realClock): Promise<PreparedRuntime> {
	const runtime = await factory(agentDir);
	const model = runtime.getModel(EVAL_MODEL.provider, EVAL_MODEL.id);
	if (!model || model.api !== "openai-codex-responses") throw Object.assign(new Error("Exact eval model unavailable"), { code: "EVAL_MODEL_UNAVAILABLE" });
	if (!getSupportedThinkingLevels(model).includes(EVAL_MODEL.thinking)) throw Object.assign(new Error("Eval model does not support xhigh"), { code: "EVAL_XHIGH_UNAVAILABLE" });
	const available = await runtime.getAvailable(EVAL_MODEL.provider);
	if (!available.some(candidate => candidate.id === EVAL_MODEL.id)) throw Object.assign(new Error("Eval model credentials unavailable"), { code: "EVAL_CREDENTIALS_UNAVAILABLE" });
	const metadata = metadataFor(model);
	const fingerprint = metadataFingerprint(metadata);
	const assertUnchanged = () => {
		const current = runtime.getModel(EVAL_MODEL.provider, EVAL_MODEL.id);
		if (!current || metadataFingerprint(metadataFor(current)) !== fingerprint) throw Object.assign(new Error("Eval model metadata changed"), { code: "EVAL_METADATA_CHANGED" });
	};
	const provider = runtime.getProvider(EVAL_MODEL.provider);
	if (!provider) throw Object.assign(new Error("Eval provider unavailable"), { code: "EVAL_PROVIDER_UNAVAILABLE" });
	runtime.registerNativeProvider(observeProvider(provider, { ...hooks,
		allocateMeta: () => { assertUnchanged(); return hooks.allocateMeta(); },
		beforeHttpAttempt: meta => { assertUnchanged(); return hooks.beforeHttpAttempt(meta); },
	}, clock));
	assertUnchanged();
	return { runtime, model, metadata, metadataFingerprint: fingerprint, assertUnchanged };
}
