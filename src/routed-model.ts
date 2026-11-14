import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi does not tell the `context` hook which physical model a virtual model routed the
 * request to. A router can say so on this channel from `route()`, which Pi calls before
 * the hook for the same request:
 *
 *     pi.events.emit("context-paging:route", { version: 1, provider: model.provider, id: model.id });
 */
export const ROUTE_CHANNEL = "context-paging:route";

type RouteReport = { provider: string; id: string };

export type RequestLimits = {
	/** The context window to page against; `undefined` means unknown. */
	contextWindow: number | undefined;
	/** Identifies the model whose limits apply, so a change can reset paging state. */
	key: string;
};

function parseRouteReport(data: unknown): RouteReport | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const { version, provider, id } = data as Record<string, unknown>;
	if (version !== 1 || typeof provider !== "string" || typeof id !== "string") return undefined;
	return { provider, id };
}

/** Identifies a model, for matching a selection or a change of limits. */
export function modelKey(model: ExtensionContext["model"]): string {
	return `${model?.provider}/${model?.id}`;
}

/**
 * Binds route reports to one request. Pi emits `turn_start` before every request, then
 * calls `route()`, then the `context` hook. A request that ends before the hook ends with
 * an assistant `message_end`, so a report never outlives the request that made it.
 */
export class RouteReports {
	#request: { selection: string; report?: RouteReport } | undefined;

	constructor(pi: ExtensionAPI) {
		pi.events.on(ROUTE_CHANNEL, (data) => {
			// The newest report wins; one this version cannot read clears an older one.
			if (this.#request) this.#request.report = parseRouteReport(data);
		});
	}

	/** Starts accepting a report for a request through `selection`. */
	open(selection: string): void {
		this.#request = { selection };
	}

	/** Stops accepting reports until the next request starts. */
	close(): void {
		this.#request = undefined;
	}

	/** Returns the report for this request if it was made under `selection`, and closes the request. */
	take(selection: string): RouteReport | undefined {
		const request = this.#request;
		this.#request = undefined;
		return request?.selection === selection ? request.report : undefined;
	}
}

/** Resolves the limits of the model the current request uses. */
export function requestLimits(ctx: ExtensionContext, report: RouteReport | undefined): RequestLimits {
	const model = ctx.model;
	if (model?.api !== "pi-virtual") return { contextWindow: model?.contextWindow, key: modelKey(model) };
	if (report) {
		const routed = ctx.modelRegistry.find(report.provider, report.id);
		if (!routed || routed.api === "pi-virtual") {
			throw new Error(`The router reported ${report.provider}/${report.id}, which is not a physical model in the registry.`);
		}
		// Invalid physical windows reach context selection and fail closed there.
		return { contextWindow: routed.contextWindow, key: modelKey(routed) };
	}
	// Pi reports an unset virtual-model window as 0. That window is unknown, so the
	// configured budget applies.
	const unknown = model.contextWindow === 0 || model.contextWindow === undefined;
	return { contextWindow: unknown ? undefined : model.contextWindow, key: modelKey(model) };
}
