export const MAXIMUM_RECOVERY_REPLY_BYTES = 16_384;
export const MAXIMUM_INLINE_PART_BYTES = 4_096;

function response<T>(details: T) {
	const text = JSON.stringify(details);
	if (text === undefined) throw new Error("Context paging response could not be serialized.");
	return { content: [{ type: "text" as const, text }], details };
}

export function fitsRecoveryResponse(details: unknown): boolean {
	return Buffer.byteLength(JSON.stringify(response(details)), "utf8") <= MAXIMUM_RECOVERY_REPLY_BYTES;
}

/** Count both text and details, including their different levels of JSON escaping. */
export function recoveryResponse<T>(details: T) {
	const result = response(details);
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAXIMUM_RECOVERY_REPLY_BYTES) {
		throw new Error("Context paging text reply exceeds the 16 KiB byte limit.");
	}
	return result;
}
