import assert from "node:assert/strict";
import test from "node:test";
import { qualifyInitialProbe, type ProbeGateInput } from "../eval/recall/probe-gate.ts";
import { buildWorkload, factForProbe } from "../eval/recall/workload.ts";
import { evidenceFixture, ownerFixture } from "./fixtures/eval-recall.ts";

const workload = buildWorkload("gate");
function input(index = 0): ProbeGateInput {
	const probe = workload.probes.A[index], owner = ownerFixture("paging", { checkpointId: "checkpoint", forkId: "fork" });
	return { owner, probe, sourceFacts: workload.facts.filter(fact => fact.factId === probe.factId),
		latestFact: factForProbe(workload, probe), sourceProvenance: workload.facts.map(fact => fact.sourcePromptId),
		request: evidenceFixture({ ...owner, promptId: probe.step.id, blocks: [{ role: "user", text: probe.step.text }] }),
		siblingProbeTexts: workload.probes.A.filter(other => other.id !== probe.id).map(other => other.step.text) };
}
test("each of five known gates requires all source versions and complete owned readable evidence", () => {
	for (let index = 0; index < 5; index++) {
		const good = input(index);
		assert.equal(qualifyInitialProbe(good).qualified, true);
		for (const source of good.sourceFacts) {
			assert.equal(qualifyInitialProbe({ ...good, sourceProvenance: good.sourceProvenance.filter(id => id !== source.sourcePromptId) }).qualified, false);
			assert.equal(qualifyInitialProbe({ ...good, request: { ...good.request, blocks: [...good.request.blocks,
				{ role: "user", text: "hidden value", sourcePromptId: source.sourcePromptId }] } }).qualified, false);
		}
		assert.equal(qualifyInitialProbe({ ...good, request: { ...good.request, complete: false } }).qualified, false);
		assert.equal(qualifyInitialProbe({ ...good, request: { ...good.request, sessionId: "foreign" } }).qualified, false);
	}
});
test("a visible fifth answer in any readable block or declaration blocks dispatch qualification", () => {
	const good = input(4), value = good.latestFact!.value;
	for (const role of ["assistant", "system", "developer", "tool-declaration", "toolResult"]) {
		const request = { ...good.request, blocks: [...good.request.blocks, { role, text: value }] };
		assert.equal(qualifyInitialProbe({ ...good, request }).failureCode, "probe-answer-visible");
	}
});
test("omitting the superseded decision source cannot turn retained originals into absence", () => {
	const good = input(4);
	assert.equal(qualifyInitialProbe({ ...good, sourceFacts: [good.latestFact!] }).qualified, false);
});
test("quantities require their subject, field, and ms unit in one record", () => {
	const good = input(3), fact = good.latestFact!;
	for (const text of [fact.value, `${fact.subject}\n${fact.field}\n${fact.value}`,
		`${fact.subject}: ${fact.field} = ${fact.value.replace("ms", "s")}`]) {
		assert.equal(qualifyInitialProbe({ ...good, request: { ...good.request, blocks: [...good.request.blocks, { role: "assistant", text }] } }).failureCode,
			"probe-answer-ambiguous");
	}
});
test("opaque state is informational, never a substitute for readable absence; sibling input is forbidden", () => {
	const good = input();
	assert.equal(qualifyInitialProbe({ ...good, request: { ...good.request, opaque: { count: 1, hashes: ["hash"] } } }).qualified, true);
	assert.equal(qualifyInitialProbe({ ...good, request: { ...good.request, blocks: [], opaque: { count: 1, hashes: ["hash"] } } }).qualified, false);
	assert.equal(qualifyInitialProbe({ ...good, request: { ...good.request, blocks: [...good.request.blocks,
		{ role: "user", text: good.siblingProbeTexts![0] }] } }).failureCode, "probe-sibling-content");
	const unknown = input(5);
	const result = qualifyInitialProbe(unknown);
	assert.equal(result.qualified, false);
	assert.equal(result.failureCode, null);
	assert.equal(result.visibility, null);
});
