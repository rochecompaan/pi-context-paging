import type { Probe } from "./workload.ts";

export type ProbeScore = {
	probeId: string;
	expected: string | null;
	actual: string | null;
	correct: boolean;
	reason: "correct" | "wrong-answer" | "invalid-json" | "invalid-shape";
};

// JSON.parse validates escaping; this shape check also rejects duplicate keys,
// which parsing alone would silently replace with the last value.
const singleField = /^\{\s*"(?:[^"\\]|\\.)*"\s*:\s*(?:null|"(?:[^"\\]|\\.)*")\s*\}$/s;

export function scoreAnswer(probe: Probe, expected: string | null, finalText: string): ProbeScore {
	let text = finalText.trim();
	const fence = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/.exec(text);
	if (fence) text = fence[1].trim();
	const invalid = (reason: "invalid-json" | "invalid-shape"): ProbeScore => ({
		probeId: probe.id, expected, actual: null, correct: false, reason,
	});
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return invalid("invalid-json");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
		|| Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "answer") || !singleField.test(text)) {
		return invalid("invalid-shape");
	}
	const actual: unknown = (parsed as { answer: unknown }).answer;
	if (actual !== null && typeof actual !== "string") return invalid("invalid-shape");
	const correct = actual === expected;
	return { probeId: probe.id, expected, actual, correct, reason: correct ? "correct" : "wrong-answer" };
}
