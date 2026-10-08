import { isDeepStrictEqual } from "node:util";

export type ReplayRead = { path: string; args: unknown[]; value: unknown };
export type ReplayEffect = { path: string; args: unknown[] };
export type ReplayInputs = { reads: ReplayRead[]; effects: ReplayEffect[] };

/** Private copies are never sanitized or converted through JSON. */
export function copyPrivate<T>(value: T): T {
	// Primitive values are immutable; cloning large text repeatedly adds no isolation.
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
	if (value instanceof AbortSignal) {
		const controller = new AbortController();
		if (value.aborted) controller.abort(copyPrivate(value.reason));
		return controller.signal as T;
	}
	if (Array.isArray(value)) return value.map(copyPrivate) as T;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyPrivate(child)])) as T;
	}
	return structuredClone(value);
}

/** Normalize only host abort-signal state for comparison, not messages or opaque blocks. */
export function equalPrivate(left: unknown, right: unknown): boolean {
	const comparable = (value: unknown): unknown => {
		if (value instanceof AbortSignal) return { aborted: value.aborted, reason: comparable(value.reason) };
		if (Array.isArray(value)) return value.map(comparable);
		if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
			return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, comparable(child)]));
		}
		return value;
	};
	return isDeepStrictEqual(comparable(left), comparable(right));
}

const nested = new Set(["ctx.sessionManager", "ctx.ui"]);
const effects = new Set(["ctx.ui.notify"]);

/** Records exactly the host reads the real handler uses, including call arguments. */
export function recordFacade<T extends object>(target: T, root: string, input: ReplayInputs): T {
	return new Proxy(target, {
		get(object, property) {
			if (typeof property !== "string") throw new Error("Unsupported symbolic host read");
			const path = `${root}.${property}`;
			const value = Reflect.get(object, property);
			if (nested.has(path)) {
				if (typeof value !== "object" || value === null) throw new Error("Unsupported nested host surface");
				return recordFacade(value, path, input);
			}
			if (typeof value !== "function") {
				input.reads.push({ path, args: [], value: copyPrivate(value) });
				return value;
			}
			return (...args: unknown[]) => {
				if (effects.has(path)) {
					input.effects.push({ path, args: copyPrivate(args) });
					return Reflect.apply(value, object, args);
				}
				// Unknown host actions are not reinterpreted as pure replayable reads.
				if (!/^ctx\.(?:isProjectTrusted|isIdle|hasPendingMessages|getContextUsage|getSystemPrompt)$/.test(path)
					&& !/^ctx\.sessionManager\.(?:get\w+|buildSessionProjection|buildContextEntries)$/.test(path)
					&& !/^pi\.(?:getActiveTools|getAllTools)$/.test(path)) throw new Error(`Unsupported host action ${path}`);
				const result = Reflect.apply(value, object, args);
				input.reads.push({ path, args: copyPrivate(args), value: copyPrivate(result) });
				return result;
			};
		},
	});
}

/** A strict read-only host, with no session writes, tool dispatch or provider surface. */
export function replayFacades(input: ReplayInputs): { at<T extends object>(root: string): T; assertConsumed(): void } {
	let cursor = 0;
	const observedEffects: ReplayEffect[] = [];
	const next = (path: string, args: unknown[]) => {
		const expected = input.reads[cursor++];
		if (!expected || expected.path !== path || !equalPrivate(expected.args, args)) throw new Error("Replay host-read mismatch");
		return copyPrivate(expected.value);
	};
	const proxy = (prefix: string): object => new Proxy({}, {
		get(_object, property) {
			if (typeof property !== "string") throw new Error("Unsupported symbolic replay read");
			const path = `${prefix}.${property}`;
			if (nested.has(path)) return proxy(path);
			if (effects.has(path)) return (...args: unknown[]) => { observedEffects.push({ path, args: copyPrivate(args) }); };
			const expected = input.reads[cursor];
			if (!expected || expected.path !== path) throw new Error("Replay host-read mismatch");
			// The handler calls known methods; other captured values are properties.
			if (/\.(?:get\w+|is\w+|hasPendingMessages|buildSessionProjection|buildContextEntries)$/.test(path)) return (...args: unknown[]) => next(path, args);
			return next(path, []);
		},
	});
	return {
		at: <T extends object>(root: string) => proxy(root) as T,
		assertConsumed() {
			if (cursor !== input.reads.length || !equalPrivate(observedEffects, input.effects)) throw new Error("Replay host observations incomplete");
		},
	};
}
