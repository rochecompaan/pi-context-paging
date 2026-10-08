import { InMemoryCredentialStore, type Api, type Model, type Provider, type TranscriptContext } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type FixtureTurn = {
	text?: string;
	reasoning?: { type: "reasoning"; id: string; encrypted_content: string; summary: unknown[] };
	tool?: { name: string; arguments: Record<string, unknown>; id?: string };
	usage?: unknown;
	status?: number;
	errorText?: string;
	waitForAbort?: boolean;
	response?: Response;
	fetchError?: Error;
	terminal?: boolean;
};
export type FixtureScript = (index: number, context: TranscriptContext) => FixtureTurn;
const fakeJwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.fixture`;

export function sseResponse(turn: FixtureTurn): Response {
	if (turn.status && turn.status !== 200) return new Response(turn.errorText ?? "transient fixture failure", { status: turn.status });
	const item = turn.tool ? {
		type: "function_call", id: "fc_fixture", call_id: turn.tool.id ?? "call-fixture",
		name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments), status: "completed",
	} : { type: "message", id: "msg-fixture", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: turn.text ?? "ack", annotations: [] }] };
	const outputIndex = turn.reasoning ? 1 : 0;
	const response = { id: "resp-fixture", status: "completed", output: [...(turn.reasoning ? [turn.reasoning] : []), item],
		...(Object.hasOwn(turn, "usage") ? { usage: turn.usage } : {}) };
	const events: unknown[] = [
		{ type: "response.created", response: { id: "resp-fixture", status: "in_progress" } },
		...(turn.reasoning ? [
			{ type: "response.output_item.added", output_index: 0, item: turn.reasoning },
			{ type: "response.output_item.done", output_index: 0, item: turn.reasoning },
		] : []),
		{ type: "response.output_item.added", output_index: outputIndex, item },
		...(turn.tool ? [] : [{ type: "response.output_text.delta", output_index: outputIndex, content_index: 0, delta: turn.text ?? "ack" }]),
		{ type: "response.output_item.done", output_index: outputIndex, item },
		...(turn.terminal === false ? [] : [{ type: "response.completed", response }]),
	];
	const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
	let offset = 0;
	return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
		if (offset === bytes.length) { controller.close(); return; }
		const end = Math.min(bytes.length, offset + 37);
		controller.enqueue(bytes.slice(offset, end)); offset = end;
	} }), { headers: { "content-type": "text/event-stream" } });
}

export function makeFixtureProvider(models?: readonly Model<Api>[], configured = true): Provider {
	const base = openaiCodexProvider();
	return { ...base, getModels: () => models ?? base.getModels(),
		auth: { apiKey: { name: "Fixture", resolve: async () => configured ? { auth: { apiKey: fakeJwt } } : undefined } },
	};
}

export async function fixtureRuntime(script: FixtureScript = () => ({ text: "ack" }), models?: readonly Model<Api>[], configured = true, streamOptions: { maxRetries?: number } = {}) {
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(makeFixtureProvider(models, configured));
	const dispatches: { context: TranscriptContext; payload: unknown; signal: AbortSignal | null | undefined }[] = [];
	const stream = runtime.streamSimple.bind(runtime);
	runtime.streamSimple = (model, context, options) => {
		let payload: unknown;
		return stream(model, context, { ...options, ...streamOptions,
			onPayload: async (value, selectedModel) => {
				const replacement = await options?.onPayload?.(value, selectedModel);
				payload = structuredClone(replacement === undefined ? value : replacement);
				return replacement;
			},
			fetch: async (_url, init) => {
				const transcript = { messages: context.messages } as TranscriptContext;
				const index = dispatches.length;
				dispatches.push({ context: transcript, payload, signal: init?.signal });
				const turn = script(index, transcript);
				if (turn.fetchError) throw turn.fetchError;
				if (turn.waitForAbort) {
					await new Promise((_, reject) => {
						const abort = () => reject(new DOMException("Aborted fixture", "AbortError"));
						if (init?.signal?.aborted) abort();
						else init?.signal?.addEventListener("abort", abort, { once: true });
					});
				}
				return turn.response ?? sseResponse(turn);
			} });
	};
	return { runtime, dispatches };
}

export const measuredUsage = { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 20 } };
