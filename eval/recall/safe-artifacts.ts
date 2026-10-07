const privateFields = new Set([
	"authorization", "proxyauthorization", "headers", "requestheaders", "responseheaders", "cookie", "cookies",
	"setcookie", "apikey", "accesskey", "secretkey", "accesstoken", "refreshtoken", "idtoken", "token",
	"credential", "credentials", "credentialresolution", "auth", "authentication", "authstorage",
	"environment", "env", "encryptedcontent", "thinkingsignature", "signature", "secret", "password", "errormessage", "stack", "stacktrace", "rawerror",
]);
const modelFields = new Set(["provider", "id", "api", "contextWindow", "maxTokens", "cost", "reasoning", "thinkingLevelMap"]);
const costFields = new Set(["input", "output", "cacheRead", "cacheWrite", "total", "tiers"]);
const tierFields = new Set(["input", "output", "cacheRead", "cacheWrite", "inputTokensAbove"]);
const thinkingFields = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const errorNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "AggregateError"]);
const safeErrorCodes = new Set(["EACCES", "EPERM", "ENOENT", "EEXIST", "EIO", "EISDIR", "ENOTDIR", "ENOSPC", "EROFS",
	"ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ABORT_ERR", "ERR_PROVIDER",
	"SOURCE_ROOT_MISMATCH", "MISSING_SOURCE_REVISION", "SOURCE_REVISION_CHANGED", "DIRTY_SOURCE", "SOURCE_UNVERIFIABLE_INDEX",
	"SYMLINK_SOURCE", "UNTRACKED_LIVE_SOURCE", "SOURCE_GIT_UNAVAILABLE", "SOURCE_RUN_ALREADY_BLOCKED",
	"INVALID_EVAL_ARGUMENTS", "INVALID_PILOT_RESULTS", "INELIGIBLE_PILOT", "PILOT_EXPERIMENT_CHANGED", "ARM_MODEL_CHANGED",
	"UNIGNORED_ARTIFACT_OUTPUT", "UNSUPPORTED_EVAL_SDK", "EVAL_MODEL_UNAVAILABLE", "EVAL_XHIGH_UNAVAILABLE",
	"EVAL_CREDENTIALS_UNAVAILABLE", "EVAL_METADATA_CHANGED", "EVAL_PROVIDER_UNAVAILABLE"]);
const scopedErrorCodes = new Set(["pair-error", "abort-error", "snapshot-error", "dispose-error", "extension-error", "prompt-error",
	"assistant-error", "assistant-aborted", "compaction-error", "unjoined-recovery-result", "artifact-error", "source-error",
	"max-user-prompts", "max-requests-per-prompt", "max-requests-per-arm", "max-pair-minutes"]);
const diagnosticCodes = new Set(["ambiguous-origin", "invalid-content", "unsupported-content", "invalid-tools", "invalid-tool",
	"unsupported-tool", "invalid-input-item", "invalid-opaque-state", "invalid-reasoning-summary", "invalid-tool-call",
	"invalid-tool-output", "unsupported-input-item", "invalid-payload", "store-not-false", "prior-response-reference",
	"invalid-model", "invalid-instructions", "invalid-input", "no-observation", "invalid-usage", "invalid-input-details",
	"invalid-input_tokens", "invalid-output_tokens", "invalid-cached_tokens", "invalid-cache_write_tokens"]);

export function safeError(error: unknown): { name: string; code?: string } {
	const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
	const name = typeof record.name === "string" && errorNames.has(record.name) ? record.name : "Error";
	return { name, ...(typeof record.code === "string" && safeErrorCodes.has(record.code) ? { code: record.code } : {}) };
}

/** Copy structured artifacts, never credential resolution objects or raw errors. */
export function sanitizeArtifact(value: unknown): unknown {
	const ancestors = new WeakSet<object>();
	function copy(current: unknown, field = ""): unknown {
		if (typeof current === "string" && field === "error") return current.split(",").every(code => diagnosticCodes.has(code)) ? current : { name: "Error" };
		if (current === null || typeof current === "string" || typeof current === "boolean") return current;
		if (typeof current === "number") return Number.isFinite(current) ? current : null;
		if (!current || typeof current !== "object") return null;
		if (ancestors.has(current)) return "[Circular]";
		if (current instanceof Error) return safeError(current);
		if ((field === "error" || field === "errors") && !Array.isArray(current)) {
			const error = current as Record<string, unknown>;
			if (typeof error.code === "string" && scopedErrorCodes.has(error.code)) return {
				code: error.code, ...(error.arm === "baseline" || error.arm === "paging" ? { arm: error.arm } : {}),
				...(typeof error.promptId === "string" || error.promptId === null ? { promptId: error.promptId } : {}),
			};
			return safeError(current);
		}
		ancestors.add(current);
		let result: unknown;
		if (Array.isArray(current)) result = current.map(item => copy(item, field));
		else {
			const allowed = field === "modelMetadata" ? modelFields : field === "cost" ? costFields
				: field === "tiers" ? tierFields : field === "thinkingLevelMap" ? thinkingFields : null;
			result = Object.fromEntries(Object.entries(current).filter(([key]) =>
				!privateFields.has(key.toLowerCase().replace(/[-_]/g, "")) && (!allowed || allowed.has(key)))
				.map(([key, item]) => [key, copy(item, key)]));
		}
		ancestors.delete(current);
		return result;
	}
	return copy(value);
}
