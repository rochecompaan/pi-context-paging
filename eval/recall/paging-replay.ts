import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import contextPagingExtension, { type ContextPagingSettingsSources } from "../../src/index.ts";
import { copyPrivate, equalPrivate, recordFacade, replayFacades, type ReplayInputs } from "./paging-replay-input.ts";

export const PAGING_RESTORATION_METHOD = "host-lifecycle-replay-v1" as const;
export type RestorationEvidence = {
	method: typeof PAGING_RESTORATION_METHOD;
	passed: boolean;
	checks: readonly { name: string; passed: boolean }[];
	failureCode: string | null;
};
export type PagingReplayTape = Readonly<{ method: typeof PAGING_RESTORATION_METHOD }>;
export type PagingReplay = {
	factory: ExtensionFactory;
	freeze(): PagingReplayTape;
	restore(session: AgentSession, tape: PagingReplayTape): Promise<RestorationEvidence>;
};
type Handler = (event: any, ctx: ExtensionContext) => unknown;

/**
 * Mirrors `tests/fixtures/tool-context.ts`: the members current Pi (1.5+) gives a tool handler beyond the
 * extension context. The eval harness keeps its own copy because `eval/` does not import from `tests/`; the
 * compiler binds both to the installed host, so a host-side rename fails the gate on every supported Pi.
 */
type ToolCallContext = ExtensionContext & {
	readonly tools: readonly never[];
	executeTool(name: string, args: unknown): Promise<never>;
};

function withToolContext(ctx: ExtensionContext): ToolCallContext {
	// Defined on the observed context and returned as the same object: the tape records the context object it
	// observes, and a copy loses the bound methods and getters the tool call depends on.
	const extras: Record<string, unknown> = { tools: [], executeTool: async () => { throw new Error("replay does not run nested tools"); } };
	for (const [key, value] of Object.entries(extras)) {
		// Only members the context lacks. A current Pi hands the tool handler its own `tools`/`executeTool`,
		// non-configurably, and redefining one throws inside the observed call — which the tape would then
		// report as an incomplete lifecycle instead of the real failure.
		if (key in ctx) continue;
		Object.defineProperty(ctx, key, { value, enumerable: false, configurable: true, writable: true });
	}
	return ctx as ToolCallContext;
}

type ResidentInputs = {
	model: ExtensionContext["model"];
	systemPrompt: string;
	tools: { name: string; description: string; parameters: unknown }[];
};
type Observation = {
	resident: ResidentInputs;
	kind: "event" | "tool";
	name: string;
	event: unknown;
	inputs: ReplayInputs;
	output: unknown;
	branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
	projection: ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>;
};
type FrozenTape = { settings: ContextPagingSettingsSources; observations: Observation[] };
// Opaque host-only handles. Neither the tape nor its private data enters model context/artifacts.
const tapes = new WeakMap<PagingReplayTape, FrozenTape>();

export function createPagingReplay(settings: ContextPagingSettingsSources): PagingReplay {
	const observations: Observation[] = [];
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, ToolDefinition>();
	let activeApi: ExtensionAPI | undefined;
	let restoring = false;
	let attached = false;
	let captureFailure = false;
	let captureCause: unknown;
	const capturedSettings = copyPrivate(settings);

	async function observe(kind: Observation["kind"], name: string, event: unknown, ctx: ExtensionContext, invoke: Handler) {
		if (restoring || activeApi) throw new Error("Concurrent paging observation is unsupported");
		const inputs: ReplayInputs = { reads: [], effects: [] };
		try {
			const activeNames = new Set(realApi!.getActiveTools());
			const resident = copyPrivate({ model: ctx.model, systemPrompt: ctx.getSystemPrompt(),
				tools: realApi!.getAllTools().filter(tool => activeNames.has(tool.name))
					.map(({ name, description, parameters }) => ({ name, description, parameters })) });
			const observation: Observation = { resident, kind, name, event: copyPrivate(event), inputs, output: undefined,
				branch: copyPrivate(ctx.sessionManager.getBranch()), projection: copyPrivate(ctx.sessionManager.buildSessionProjection()) };
			activeApi = recordFacade(realApi!, "pi", inputs);
			const output = await invoke(event, recordFacade(ctx, "ctx", inputs));
			observation.output = copyPrivate(output);
			observations.push(observation);
			return output;
		} catch (error) { captureFailure = true; captureCause = error; throw error; }
		finally { activeApi = undefined; }
	}
	let realApi: ExtensionAPI | undefined;
	const factory: ExtensionFactory = async pi => {
		if (attached) throw new Error("Paging replay factory must own exactly one SDK session");
		attached = true;
		realApi = pi;
		const intercepted = new Proxy(pi, {
			get(target, property) {
				if (property === "on") return (name: string, handler: Handler) => {
					if (handlers.has(name)) throw new Error("Duplicate paging lifecycle handler");
					handlers.set(name, handler);
					return pi.on(name as "context", (event, ctx) => observe("event", name, event, ctx, handler) as any);
				};
				if (property === "registerTool") return (tool: ToolDefinition) => {
					tools.set(tool.name, tool);
					pi.registerTool({ ...tool, execute: (id, args, signal, update, ctx) =>
						observe("tool", tool.name, { id, args, signal }, ctx,
							(event, host) => tool.execute(event.id, event.args, event.signal, update, withToolContext(host))) as any });
				};
				if (property === "getActiveTools" || property === "getAllTools") {
					const api = activeApi ?? target;
					return api[property].bind(api);
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await contextPagingExtension(intercepted, capturedSettings);
	};
	return {
		factory,
		freeze() {
			if (!attached || captureFailure || activeApi || restoring) {
				// The lifecycle flags say the tape is unusable; the captured error says why, and without it every
				// handler failure reads as the same opaque tape problem.
				const cause = captureCause instanceof Error ? `${captureCause.name}: ${captureCause.message}` : String(captureCause);
				throw new Error(`Incomplete paging lifecycle tape (attached=${attached}, captureFailure=${captureFailure}, ` +
					`activeApi=${activeApi !== undefined}, restoring=${restoring}${captureFailure ? `; captured failure: ${cause}` : ""})`);
			}
			const tape = Object.freeze({ method: PAGING_RESTORATION_METHOD,
				toJSON() { throw new Error("Private paging tape must not be serialized"); } });
			tapes.set(tape, { settings: copyPrivate(capturedSettings), observations: copyPrivate(observations) });
			return tape;
		},
		async restore(session, tape) {
			const checks: { name: string; passed: boolean }[] = [];
			const check = (name: string, passed: boolean) => { checks.push({ name, passed }); if (!passed) throw new Error(name); };
			const entriesBefore = copyPrivate(session.sessionManager.getEntries());
			const projectionBefore = copyPrivate(session.sessionManager.buildSessionProjection());
			try {
				check("target-idle", session.isIdle);
				check("target-fresh", attached && !captureFailure && observations.every(item => item.name === "session_start"));
				const frozen = tapes.get(tape);
				check("private-tape-present", !!frozen);
				check("settings-match", equalPrivate(frozen!.settings, capturedSettings));
				const last = frozen!.observations.at(-1);
				check("checkpoint-history-match", !!last && equalPrivate(last.branch, session.sessionManager.getBranch()));
				check("checkpoint-projection-match", !!last && equalPrivate(last.projection, projectionBefore));
				check("resident-configuration-match", !!last && equalPrivate(last.resident, copyPrivate({ model: session.model,
					systemPrompt: session.systemPrompt, tools: session.agent.state.tools
						.map(({ name, description, parameters }) => ({ name, description, parameters })) })));
				restoring = true;
				for (const [index, observation] of frozen!.observations.entries()) {
					const host = replayFacades(observation.inputs);
					activeApi = host.at<ExtensionAPI>("pi");
					const event = copyPrivate(observation.event);
					let output: unknown;
					if (observation.kind === "event") {
						const handler = handlers.get(observation.name);
						check(`handler-present-${index}`, !!handler);
						output = await handler!(event, host.at<ExtensionContext>("ctx"));
					} else {
						const tool = tools.get(observation.name);
						check(`tool-present-${index}`, !!tool);
						const call = event as { id: string; args: any; signal: AbortSignal | undefined };
						output = await tool!.execute(call.id, call.args, call.signal, undefined, withToolContext(host.at<ExtensionContext>("ctx")));
					}
					host.assertConsumed();
					check(`handler-output-match-${index}`, equalPrivate(output, observation.output));
				}
				check("native-history-unchanged", equalPrivate(entriesBefore, session.sessionManager.getEntries()));
				check("native-projection-unchanged", equalPrivate(projectionBefore, session.sessionManager.buildSessionProjection()));
				observations.splice(0, observations.length, ...copyPrivate(frozen!.observations));
				return { method: PAGING_RESTORATION_METHOD, passed: true, checks, failureCode: null };
			} catch {
				checks.push({ name: "restoration-complete", passed: false });
				captureFailure = true;
				return { method: PAGING_RESTORATION_METHOD, passed: false, checks, failureCode: "paging-replay-fidelity-failed" };
			} finally { activeApi = undefined; restoring = false; }
		},
	};
}
