const privateFields = new Set([
	"authorization", "proxyauthorization", "headers", "requestheaders", "responseheaders", "cookie", "cookies",
	"setcookie", "apikey", "accesskey", "secretkey", "accesstoken", "refreshtoken", "idtoken", "token",
	"credential", "credentials", "credentialresolution", "auth", "authentication", "authstorage",
	"environment", "env", "encryptedcontent", "thinkingsignature", "signature", "secret", "password",
]);
const modelFields = new Set(["provider", "id", "api", "contextWindow", "maxTokens", "cost", "reasoning", "thinkingLevelMap"]);
const costFields = new Set(["input", "output", "cacheRead", "cacheWrite", "total"]);
const thinkingFields = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const errorNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "AggregateError"]);

export function safeError(error: unknown): { name: string; code?: string } {
	const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
	const name = typeof record.name === "string" && errorNames.has(record.name) ? record.name : "Error";
	return { name, ...(typeof record.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(record.code) ? { code: record.code } : {}) };
}

/** Copy structured artifacts, never credential resolution objects or raw errors. */
export function sanitizeArtifact(value: unknown): unknown {
	const ancestors = new WeakSet<object>();
	function copy(current: unknown, field = ""): unknown {
		if (current === null || typeof current === "string" || typeof current === "boolean") return current;
		if (typeof current === "number") return Number.isFinite(current) ? current : null;
		if (!current || typeof current !== "object") return null;
		if (ancestors.has(current)) return "[Circular]";
		if (current instanceof Error || field === "error" || field === "errors" && !Array.isArray(current)) return safeError(current);
		ancestors.add(current);
		let result: unknown;
		if (Array.isArray(current)) result = current.map(item => copy(item, field));
		else {
			const allowed = field === "modelMetadata" ? modelFields : field === "cost" ? costFields
				: field === "thinkingLevelMap" ? thinkingFields : null;
			result = Object.fromEntries(Object.entries(current).filter(([key]) =>
				!privateFields.has(key.toLowerCase().replace(/[-_]/g, "")) && (!allowed || allowed.has(key)))
				.map(([key, item]) => [key, copy(item, key)]));
		}
		ancestors.delete(current);
		return result;
	}
	return copy(value);
}
