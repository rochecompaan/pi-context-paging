import { performance } from "node:perf_hooks";

export type Clock = {
	nowMs(): number;
	utcNow(): string;
	setTimeout(callback: () => void, milliseconds: number): unknown;
	clearTimeout(handle: unknown): void;
};
export const realClock: Clock = {
	nowMs: () => performance.now(),
	utcNow: () => new Date().toISOString(),
	setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
