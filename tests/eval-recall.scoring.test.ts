import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkload, factForProbe } from "../eval/recall/workload.ts";
import { scoreAnswer } from "../eval/recall/scoring.ts";

const probe = buildWorkload("score").probes.A[0];

test("scores exact strings without normalization", () => {
	assert.deepEqual(scoreAnswer(probe, "opaque-X", '{"answer":"opaque-X"}'), {
		probeId: probe.id, expected: "opaque-X", actual: "opaque-X", correct: true, reason: "correct",
	});
	for (const [expected, actual] of [
		["opaque-X", "opaque-x"], ["value", " value "], ["/a/b", "/a//b"], ["17 ms", "17"],
	]) {
		const result = scoreAnswer(probe, expected, JSON.stringify({ answer: actual }));
		assert.equal(result.reason, "wrong-answer");
		assert.equal(result.correct, false);
		assert.equal(result.actual, actual);
	}
});

test("accepts surrounding whitespace, a complete optional JSON fence, and JSON escapes", () => {
	for (const text of [
		' \n {"answer":"exact"}\t ',
		'```json\n{"answer":"exact"}\n```',
		'```\n{"answer":"exact"}\n```',
		'  ```json\r\n{"answer":"exact"}\r\n```  ',
	]) assert.equal(scoreAnswer(probe, "exact", text).correct, true, text);
	assert.equal(scoreAnswer(probe, 'path\\x\n"quoted"', '{"answer":"path\\\\x\\n\\\"quoted\\\""}').correct, true);
	assert.equal(scoreAnswer(probe, "exact", '{"ans\\u0077er":"ex\\u0061ct"}').correct, true);
});

test("only explicit null is a correct unknown response", () => {
	assert.equal(scoreAnswer(probe, null, '{"answer":null}').correct, true);
	for (const text of ['{}', '{"answer":"unknown"}', '', 'null', '{"answer":false}']) {
		assert.equal(scoreAnswer(probe, null, text).correct, false, text);
	}
	assert.equal(scoreAnswer(probe, "known", '{"answer":null}').reason, "wrong-answer");
});

test("rejects extra properties, duplicate fields, missing fields, and non-answer types", () => {
	for (const text of [
		'{}', '{"answer":17}', '{"answer":true}', '{"answer":[]}', '{"answer":{}}',
		'{"answer":"exact","note":"extra"}', '{"answer":"wrong","answer":"exact"}',
		'{"answer":"wrong","ans\\u0077er":"exact"}', '[{"answer":"exact"}]', 'null', '"exact"',
	]) {
		const result = scoreAnswer(probe, "exact", text);
		assert.equal(result.reason, "invalid-shape", text);
		assert.equal(result.correct, false);
	}
});

test("rejects multiple objects, partial fences, extra prose, and malformed JSON", () => {
	for (const text of [
		'{"answer":"exact"}\n{"answer":"exact"}', 'The answer is exact.',
		'Answer: {"answer":"exact"}', '{"answer":"exact"} Done.',
		'```json\n{"answer":"exact"}', '```js\n{"answer":"exact"}\n```',
		'```json\n{"answer":"exact"}\n```\n```json\n{"answer":"exact"}\n```',
		'{"answer":"exact",}', '',
	]) assert.equal(scoreAnswer(probe, "exact", text).reason, "invalid-json", text);
});

test("a superseded decision is wrong even when it appeared in the session", () => {
	const w = buildWorkload("revised");
	const p = w.probes.A.find(p => factForProbe(w, p)?.category === "decision")!;
	const latest = factForProbe(w, p)!;
	const earlier = w.facts.find(f => f.factId === p.factId && f.version === 1)!;
	assert.equal(scoreAnswer(p, latest.value, JSON.stringify({ answer: earlier.value })).correct, false);
	assert.equal(scoreAnswer(p, latest.value, JSON.stringify({ answer: latest.value })).correct, true);
});
