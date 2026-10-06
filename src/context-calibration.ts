/** Provider-backed costs aligned with the original, uncut outgoing messages. */
export type ContextTokenEstimates = {
	residentTokens: number;
	messageTokens: readonly number[];
};

export function validTokenEstimates(estimates: ContextTokenEstimates | undefined, messageCount: number): estimates is ContextTokenEstimates {
	return estimates !== undefined && Number.isFinite(estimates.residentTokens) && estimates.residentTokens >= 0
		&& estimates.messageTokens.length === messageCount
		&& estimates.messageTokens.every((tokens) => Number.isFinite(tokens) && tokens >= 0);
}

export type ResponseCalibration = {
	residentOverheadTokens: number;
	messageScale: number;
};

/** Split positive undercount between resident overhead and the measured message snapshot. */
export function calibrateResponse(
	residentTokens: number,
	messageTokens: number,
	reportedTokens: number,
	previousOverhead: number | undefined,
	outgoingTokens = 0,
): ResponseCalibration | undefined {
	const scalableTokens = messageTokens - outgoingTokens;
	const surplus = reportedTokens - residentTokens - messageTokens;
	// Preserve the existing additive correction when heuristics overestimate usage.
	if (surplus <= 0 || residentTokens + scalableTokens === 0) return undefined;
	// One measurement cannot identify fixed overhead. Start with a proportional
	// share, then keep the lower observed overhead rather than making a dense
	// recovery payload's undercount a permanent resident cost.
	const residentOverheadTokens = previousOverhead === undefined
		? surplus * (residentTokens / (residentTokens + scalableTokens))
		: Math.min(previousOverhead, surplus);
	return {
		residentOverheadTokens,
		messageScale: scalableTokens === 0 ? 1 : 1 + (surplus - residentOverheadTokens) / scalableTokens,
	};
}
