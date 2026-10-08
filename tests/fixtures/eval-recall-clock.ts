import type { Clock } from "../../eval/recall/pi-arm.ts";

export function fixtureClock() {
	let now = 0;
	const clock: Clock = {
		nowMs: () => now,
		utcNow: () => new Date(Date.UTC(2026, 0, 1) + now).toISOString(),
		setTimeout: (callback, delay) => setTimeout(callback, delay),
		clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	return { clock, at(ms: number) { now = ms; } };
}
