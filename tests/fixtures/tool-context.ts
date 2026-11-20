import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * What current Pi (1.5+) hands a tool handler alongside the extension context: `tools` and `executeTool`, typed
 * by the host as `ExtensionToolContext`. This package supports Pi 0.87.0 and newer
 * (`peerDependencies: ">=0.87.0"`), and the
 * dev host has no such type to import, so both harnesses describe the members structurally — the compiler binds
 * the shape, so a host that renames or reshapes them fails `npm run typecheck` on every Pi version, which is
 * the signal this fixture exists to provide.
 */
export type ToolCallContext = ExtensionContext & {
	readonly tools: readonly never[];
	executeTool(name: string, args: unknown): Promise<never>;
};

/**
 * Gives a fixture context the members a tool handler receives, without naming the host's type.
 * Members are defined on the object passed in, and the same object is returned: the replay tape records the
 * context object it observes, so replacing it with a copy would silently break bound methods and getters.
 */
export function toolCallContext<T extends object>(ctx: T): T & ToolCallContext {
	const extras: Record<string, unknown> = {
		tools: [],
		executeTool: async () => { throw new Error("these fixtures do not run nested tools"); },
	};
	for (const [key, value] of Object.entries(extras)) {
		// Supply only what the context lacks. A real Pi hands a tool handler its own `tools` and `executeTool`,
		// non-configurably, and redefining one throws; the host's members are the ones a handler should use.
		// The members are added for fixture contexts, which predate them.
		if (key in ctx) continue;
		Object.defineProperty(ctx, key, { value, enumerable: false, configurable: true, writable: true });
	}
	// One assertion for what TypeScript cannot infer about a generic; the declared return type binds the shape
	// to whatever the installed host's tool handler expects.
	return ctx as T & ToolCallContext;
}
