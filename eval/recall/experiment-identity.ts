import type { SafeModelMetadata } from "./codex-runtime.ts";
import { sanitizeArtifact } from "./safe-artifacts.ts";
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export function publicMetadata(metadata: SafeModelMetadata | null): SafeModelMetadata | null {
	return (sanitizeArtifact({ modelMetadata: metadata }) as { modelMetadata: SafeModelMetadata | null }).modelMetadata;
}
export function sameModelMetadata(a: SafeModelMetadata | null, b: SafeModelMetadata | null): boolean {
	return canonical(publicMetadata(a)) === canonical(publicMetadata(b));
}
