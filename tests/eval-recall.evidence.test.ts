import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { PAGING_TOOL_NAMES } from "../src/history.ts";
import { buildWorkload, factForProbe } from "../eval/recall/workload.ts";
import { scoreAnswer } from "../eval/recall/scoring.ts";
import { decodeCodexPayload, type OriginIndex, type RequestMeta } from "../eval/recall/codex-payload.ts";
import { analyzeProbe, matchFact, type ProbeEvidenceInput, type RecoveryResult } from "../eval/recall/evidence.ts";
import { sanitizeArtifact } from "../eval/recall/safe-artifacts.ts";
import { evidenceFixture } from "./fixtures/eval-recall.ts";

const w = buildWorkload("evidence");
const probe = w.probes.A[0];
const fact = factForProbe(w, probe)!;
const meta: RequestMeta = { requestId: "r0", promptId: probe.step.id, arm: "paging", purpose: "conversation" };
const basePayload = { model: "gpt-6-luna", instructions: "Recall accurately.", store: false, input: [] };
const source = w.seedSteps.find(s => s.id === fact.sourcePromptId)!;
const origins: OriginIndex = [{ role: "user", texts: [source.text], sourcePromptId: source.id }];
const goodScore = scoreAnswer(probe, fact.value, JSON.stringify({ answer: fact.value }));
function input(overrides: Partial<ProbeEvidenceInput> = {}): ProbeEvidenceInput {
	return { probe, fact, initial: evidenceFixture(), followUps: [], recoveryResults: [], score: goodScore, finalAnswerEventIndex: 3, ...overrides };
}
function recovery(overrides: Partial<RecoveryResult> = {}): RecoveryResult {
	return { promptId: meta.promptId, requestId: "r0", toolCallId: "call", toolName: "search_history", text: `Search reference: ${fact.value}`, isError: false, eventIndex: 2, ...overrides };
}

test("attributes a retained source by exact canonical role and text", () => {
	const initial = decodeCodexPayload({ ...basePayload, input: [{ role: "user", content: [{ type: "input_text", text: source.text }] }] }, meta, origins);
	assert.equal(initial.complete, true);
	assert.equal(initial.blocks.find(b => b.sourcePromptId)?.sourcePromptId, source.id);
	assert.equal(analyzeProbe(input({ initial })).visibility, "resident-original");
	assert.equal(analyzeProbe(input({ initial })).qualified, false);
});

test("attributes SDK-wrapped summaries, never bare summaries or wrong roles", () => {
	const summary = `Keep ${fact.subject}: ${fact.field} = ${fact.value}`;
	const converted = convertToLlm([{ role: "compactionSummary", summary, tokensBefore: 260_000, timestamp: 0 }])[0];
	assert.equal(converted.role, "user");
	assert.ok(Array.isArray(converted.content));
	const text = converted.content[0];
	assert.equal(text.type, "text");
	if (text.type !== "text") throw new Error("Unexpected SDK summary block");
	const index: OriginIndex = [{ role: converted.role, texts: [text.text], compactionEntryId: "compact-1" }];
	const initial = decodeCodexPayload({ ...basePayload, input: [{ role: "user", content: [{ type: "input_text", text: text.text }] }] }, meta, index);
	assert.equal(initial.blocks.find(b => b.compactionEntryId)?.compactionEntryId, "compact-1");
	assert.equal(analyzeProbe(input({ initial })).visibility, "resident-summary");
	for (const [role, value] of [["assistant", text.text], ["user", summary]]) {
		const decoded = decodeCodexPayload({ ...basePayload, input: [{ role, content: [{ type: role === "user" ? "input_text" : "output_text", text: value }] }] }, meta, index);
		assert.ok(decoded.blocks.every(b => !b.compactionEntryId));
		assert.equal(analyzeProbe(input({ initial: decoded })).visibility, "resident-other");
	}
});

test("resident copies and tool quotations cannot become original user messages", () => {
	for (const item of [
		{ role: "assistant", content: [{ type: "output_text", text: source.text }] },
		{ type: "function_call_output", call_id: "call", output: source.text },
	]) {
		const initial = decodeCodexPayload({ ...basePayload, input: [item] }, meta, origins);
		assert.ok(initial.blocks.every(b => !b.sourcePromptId));
		assert.equal(analyzeProbe(input({ initial })).visibility, "resident-other");
	}
});

test("opaque reasoning records only a digest and never proves forgetting", () => {
	const encrypted = "ENCRYPTED_PRIVATE_SENTINEL";
	const payload = Object.freeze({ ...basePayload, input: [Object.freeze({ type: "reasoning", summary: [], encrypted_content: encrypted })] });
	const initial = decodeCodexPayload(payload, meta, origins);
	assert.deepEqual(initial.opaque, { count: 1, hashes: [createHash("sha256").update(encrypted).digest("hex")] });
	assert.ok(!JSON.stringify(initial).includes(encrypted));
	assert.equal(payload.input[0].encrypted_content, encrypted);
	const result = analyzeProbe(input({ initial }));
	assert.equal(result.visibility, "plaintext-absent");
	assert.equal(result.opaqueReasoningPresent, true);
	assert.equal(result.qualified, true);
	assert.equal(result.recoverySuccess, false);
});

test("decodes readable reasoning, calls, outputs, and declarations without unknown fields", () => {
	const initial = decodeCodexPayload({ ...basePayload,
		input: [
			{ type: "reasoning", summary: [{ type: "summary_text", text: "readable reasoning" }] },
			{ type: "function_call", call_id: "call", name: "search_history", arguments: '{"query":"record"}' },
			{ type: "function_call_output", call_id: "call", output: "public result" },
		],
		tools: [{ type: "function", name: "search_history", description: "Search past records", parameters: { type: "object" }, secret: "PRIVATE" }],
	}, meta, []);
	assert.equal(initial.complete, true);
	for (const value of ["readable reasoning", "record", "public result", "Search past records"]) {
		assert.ok(initial.blocks.some(b => b.text.includes(value)));
	}
	assert.ok(!JSON.stringify(initial).includes("PRIVATE"));
});

test("unsupported or incomplete requests never establish readable absence", () => {
	for (const payload of [
		{ ...basePayload, input: [{ type: "unknown_item", text: fact.value }] },
		{ ...basePayload, input: [{ role: "user", content: [{ type: "input_image", image_url: "unknown" }] }] },
		{ ...basePayload, previous_response_id: "prior" }, { ...basePayload, store: true },
		{ ...basePayload, input: null }, { ...basePayload, instructions: null },
	]) {
		const initial = decodeCodexPayload(payload, meta, origins);
		assert.equal(initial.complete, false);
		assert.equal(analyzeProbe(input({ initial })).visibility, "unclassified");
		assert.equal(analyzeProbe(input({ initial })).qualified, false);
	}
	assert.equal(analyzeProbe(input({ initial: evidenceFixture({ complete: false }) })).visibility, "unclassified");
	assert.equal(analyzeProbe(input({ initial: evidenceFixture({ purpose: "compaction" }) })).visibility, "unclassified");
});

test("ambiguous converted origins cannot silently select a source", () => {
	const initial = decodeCodexPayload({ ...basePayload, input: [{ role: "user", content: source.text }] }, meta,
		[...origins, { role: "user", texts: [source.text], compactionEntryId: "also-matches" }]);
	assert.equal(initial.complete, false);
	assert.ok(initial.blocks.every(b => !b.sourcePromptId && !b.compactionEntryId));
	assert.equal(analyzeProbe(input({ initial })).visibility, "unclassified");
});

test("quantities require value, subject, and field in one record", () => {
	const quantity = w.facts.find(f => f.category === "quantity")!;
	assert.equal(matchFact(quantity, [`${quantity.subject}: ${quantity.field} = ${quantity.value}`]), "match");
	assert.equal(matchFact(quantity, [`Unrelated delay: ${quantity.value}`]), "ambiguous");
	assert.equal(matchFact(quantity, [quantity.subject, quantity.field, quantity.value]), "ambiguous");
	assert.equal(matchFact(quantity, [`${quantity.subject}\n${quantity.field}\n${quantity.value}`]), "ambiguous");
	assert.equal(matchFact(quantity, ["no relevant number"]), "none");
	const p = w.probes.A.find(p => factForProbe(w, p)?.category === "quantity")!;
	assert.equal(analyzeProbe(input({ probe: p, fact: quantity, initial: evidenceFixture({ promptId: p.step.id, blocks: [{ role: "assistant", text: quantity.value }] }) })).visibility, "unclassified");
});

test("unique literal matching rejects longer identifiers and path suffixes", () => {
	assert.equal(matchFact(fact, [`${fact.value}-other`]), "none");
	assert.equal(matchFact(fact, [`prefix-${fact.value}`]), "none");
	assert.equal(matchFact(fact, [`Exact: ${fact.value}.`]), "match");
	const path = w.facts.find(f => f.category === "path")!;
	assert.equal(matchFact(path, [`${path.value}.bak`]), "none");
	assert.equal(matchFact(path, [`Path: "${path.value}"`]), "match");
});

test("only observed successful timely paging results with correct answers establish recovery", () => {
	for (const toolName of PAGING_TOOL_NAMES) {
		const result = analyzeProbe(input({ recoveryResults: [recovery({ toolName })] }));
		assert.equal(result.visibility, "plaintext-absent");
		assert.equal(result.recoverySuccess, true, toolName);
	}
	for (const result of [
		recovery({ isError: true }), recovery({ eventIndex: 3 }), recovery({ eventIndex: 4 }),
		recovery({ text: "Reference only; load to see content" }), recovery({ toolName: "unrelated" }),
		recovery({ promptId: "other" }), recovery({ requestId: "unobserved" }),
	]) assert.equal(analyzeProbe(input({ recoveryResults: [result] })).recoverySuccess, false);
	assert.equal(analyzeProbe(input({ recoveryResults: [] })).recoverySuccess, false);
	assert.equal(analyzeProbe(input({ recoveryResults: [recovery()], score: scoreAnswer(probe, fact.value, '{"answer":"wrong"}') })).recoverySuccess, false);
	assert.equal(analyzeProbe(input({ recoveryResults: [recovery()], followUps: [evidenceFixture({ requestId: "r1", complete: false })] })).qualified, false);
});

test("qualification requires excluded source records and one arm's complete trace", () => {
	const retainedSource = evidenceFixture({ blocks: [{ role: "user", text: "source record without readable value", sourcePromptId: fact.sourcePromptId }] });
	assert.equal(analyzeProbe(input({ initial: retainedSource })).qualified, false);
	assert.equal(analyzeProbe(input({ followUps: [evidenceFixture({ requestId: "r1", arm: "baseline" })] })).qualified, false);
});

test("unknown probes have no visibility or recovery classification", () => {
	const unknown = w.probes.A.find(p => p.factId === null)!;
	const result = analyzeProbe(input({ probe: unknown, fact: null, score: scoreAnswer(unknown, null, '{"answer":null}') }));
	assert.equal(result.visibility, null);
	assert.equal(result.recoverySuccess, null);
	assert.equal(result.qualified, false);
});

test("safe exports allowlist model metadata and structured errors", () => {
	const value = {
		modelMetadata: { provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses", contextWindow: 272_000,
			maxTokens: 32_000, reasoning: true, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, raw: "SECRET_COST" },
			thinkingLevelMap: { xhigh: "xhigh", vendorNote: "SECRET_MAP" }, unknown: "SECRET_MODEL" },
		error: { name: "TypeError", code: "ERR_PROVIDER", message: "SECRET_ERROR", unknown: "SECRET_EXTRA" },
	};
	const safe = sanitizeArtifact(value) as typeof value;
	assert.deepEqual(safe.modelMetadata.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 });
	assert.deepEqual(safe.modelMetadata.thinkingLevelMap, { xhigh: "xhigh" });
	assert.deepEqual(safe.error, { name: "TypeError", code: "ERR_PROVIDER" });
	assert.ok(!JSON.stringify(safe).includes("SECRET"));
});

test("safe model metadata retains price tiers and all known reasoning levels", () => {
	const safe = sanitizeArtifact({ modelMetadata: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0,
		tiers: [{ inputTokensAbove: 100, input: 3, output: 4, cacheRead: 0, cacheWrite: 0, privateNote: "SECRET" }] },
		thinkingLevelMap: { xhigh: "xhigh", max: "max" } } });
	assert.deepEqual(safe, { modelMetadata: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0,
		tiers: [{ inputTokensAbove: 100, input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }] },
		thinkingLevelMap: { xhigh: "xhigh", max: "max" } } });
});

test("safe exports drop private structured fields recursively without changing frozen input", () => {
	const live = Object.freeze({
		text: "useful plaintext", opaque: Object.freeze({ count: 1, hashes: Object.freeze(["hash"]) }),
		headers: Object.freeze({ authorization: "SECRET_HEADER" }), cookies: "SECRET_COOKIE",
		credentials: Object.freeze({ accessToken: "SECRET_CREDENTIAL" }), environment: "SECRET_ENV",
		items: Object.freeze([Object.freeze({ text: "keep", encrypted_content: "SECRET_ENCRYPTED", thinkingSignature: "SECRET_THINKING", api_key: "SECRET_KEY" })]),
		error: Object.assign(new Error("SECRET_ERROR_MESSAGE"), { headers: { authorization: "SECRET_ERROR_HEADER" } }),
	});
	const safe = sanitizeArtifact(live);
	assert.deepEqual(safe, { text: "useful plaintext", opaque: { count: 1, hashes: ["hash"] }, items: [{ text: "keep" }], error: { name: "Error" } });
	assert.ok(!JSON.stringify(safe).includes("SECRET"));
	assert.equal(live.items[0].encrypted_content, "SECRET_ENCRYPTED");
	assert.notEqual(safe, live);
});
