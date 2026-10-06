import type { RequestMeta } from "./codex-payload.ts";
import type { Clock } from "./pi-arm.ts";
import type { Arm } from "./workload.ts";

export type EvalLimits = { maxUserPrompts: number; maxRequestsPerPrompt: number; maxRequestsPerArm: number; maxPairMinutes: number };
export const defaultLimits: Readonly<EvalLimits> = Object.freeze({
	maxUserPrompts: 64, maxRequestsPerPrompt: 12, maxRequestsPerArm: 256, maxPairMinutes: 120,
});
export type RequestGuard = {
	beginPrompt(arm: Arm, promptId: string): void;
	beforeAttempt(meta: RequestMeta): void;
	check(): void;
	stop(reason: string): void;
	readonly sentAttempts: Record<Arm, number>;
	readonly promptCounts: Record<Arm, number>;
	readonly stopReason: string | null;
};

/** Counts physical dispatches, including retries and native summarization. */
export function createRequestGuard(limits: EvalLimits, clock: Clock): RequestGuard {
	for (const key of Object.keys(defaultLimits) as (keyof EvalLimits)[]) {
		const value = limits[key];
		if (!Number.isFinite(value) || value <= 0 || (key !== "maxPairMinutes" && !Number.isSafeInteger(value))
			|| (key === "maxPairMinutes" && value * 60_000 > 2_147_483_647)) {
			throw new Error("Invalid eval limit");
		}
	}
	const start = clock.nowMs();
	const sent = { baseline: 0, paging: 0 }, prompts = { baseline: 0, paging: 0 };
	const perPrompt = new Map<string, number>();
	const current: Partial<Record<Arm, string>> = {};
	let stopped: string | null = null;
	const stop = (reason: string) => { stopped ??= reason; };
	const reject = (reason: string): never => { stop(reason); throw new Error(`Eval stopped: ${stopped}`); };
	const check = () => {
		if (stopped) reject(stopped);
		if (clock.nowMs() - start >= limits.maxPairMinutes * 60_000) reject("max-pair-minutes");
	};
	return {
		get sentAttempts() { return { ...sent }; },
		get promptCounts() { return { ...prompts }; },
		get stopReason() { return stopped; }, stop, check,
		beginPrompt(arm, promptId) {
			check();
			if (prompts[arm] >= limits.maxUserPrompts) reject("max-user-prompts");
			const key = JSON.stringify([arm, promptId]);
			if (perPrompt.has(key)) reject("duplicate-prompt");
			prompts[arm]++;
			current[arm] = promptId;
			perPrompt.set(key, 0);
		},
		beforeAttempt(meta) {
			check();
			if (current[meta.arm] !== meta.promptId) reject("unbound-request");
			const key = JSON.stringify([meta.arm, meta.promptId]), count = perPrompt.get(key)!;
			if (count >= limits.maxRequestsPerPrompt) reject("max-requests-per-prompt");
			if (sent[meta.arm] >= limits.maxRequestsPerArm) reject("max-requests-per-arm");
			perPrompt.set(key, count + 1);
			sent[meta.arm]++;
		},
	};
}
