import type { Usage } from "@earendil-works/pi-ai";
import { projectProviderUsage } from "../../eval/recall/codex-usage.ts";
import { createAttemptRecord, type AttemptRecord, type RequestRecord, type SessionOwner } from "../../eval/recall/metrics.ts";
import { fixtureClock } from "./eval-recall-clock.ts";

export const usageOwner: SessionOwner = { runId: "run", stage: "A", seed: "seed", arm: "paging", sessionId: "source", checkpointId: null, forkId: null };
export const completeProviderUsage = { input_tokens: 100, output_tokens: 7,
	input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 3 } };
export function providerAttempt(usage: unknown = completeProviderUsage, owner = usageOwner, requestId = "request", attemptId = `${requestId}-attempt`): AttemptRecord {
	const attempt = createAttemptRecord({ ...owner, requestId, promptId: "prompt", purpose: "conversation" }, attemptId, fixtureClock().clock);
	attempt.providerUsage = projectProviderUsage({ type: "response.completed", response: { usage } }, requestId, attemptId)!;
	attempt.observationComplete = true; attempt.timing.status = "succeeded";
	return attempt;
}
export function requestWith(attempt: AttemptRecord): RequestRecord {
	return { ...attempt, attempts: [attempt], status: attempt.timing.status, requestWallMs: attempt.attemptWallMs };
}
export function sdkUsage(input = 80): Usage {
	return { input, output: 7, reasoning: 3, cacheRead: 20, cacheWrite: 0, totalTokens: 107,
		cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, total: 3996 } };
}
