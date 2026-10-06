import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { buildWorkload, buildWorkStep, factForProbe } from "../eval/recall/workload.ts";
import { renderWorkPacket } from "../eval/recall/packets.ts";

test("generates reproducible, disjoint probe groups", () => {
	const a = buildWorkload("pilot-v1");
	assert.deepEqual(a, buildWorkload("pilot-v1"));
	assert.notDeepEqual(a, buildWorkload("batch-v1-0"));
	for (const stage of ["A", "B"] as const) {
		assert.equal(a.probes[stage].length, 6);
		assert.equal(a.probes[stage].filter(p => p.factId === null).length, 1);
		assert.deepEqual(a.probes[stage].filter(p => p.factId !== null)
			.map(p => factForProbe(a, p)!.category).sort(), ["decision", "error", "id", "path", "quantity"]);
	}
	const ids = a.probes.A.map(p => p.factId).filter(Boolean);
	assert.ok(a.probes.B.every(p => p.factId === null || !ids.includes(p.factId)));
});

test("selects latest decisions rather than superseded values", () => {
	const w = buildWorkload("versions");
	assert.equal(w.seedSteps.length, 12);
	for (const stage of ["A", "B"] as const) {
		const probe = w.probes[stage].find(p => factForProbe(w, p)?.category === "decision")!;
		const latest = factForProbe(w, probe)!;
		assert.equal(latest.version, 2);
		const original = w.facts.find(f => f.factId === latest.factId && f.version === 1)!;
		assert.notEqual(latest.value, original.value);
		assert.equal(w.seedSteps.find(s => s.id === latest.sourcePromptId)!.kind, "revision");
		assert.ok(w.seedSteps.findIndex(s => s.id === original.sourcePromptId)
			< w.seedSteps.findIndex(s => s.id === latest.sourcePromptId));
		assert.equal(factForProbe({ ...w, facts: [...w.facts].reverse() }, probe)!.value, latest.value);
	}
});

test("keeps one fact per source prompt and stage subjects separate", () => {
	const w = buildWorkload("isolation");
	assert.equal(new Set(w.facts.map(f => f.sourcePromptId)).size, 12);
	const aSubjects = new Set(w.probes.A.filter(p => p.factId !== null).map(p => factForProbe(w, p)!.subject));
	for (const probe of w.probes.B.filter(p => p.factId !== null)) {
		assert.ok(!aSubjects.has(factForProbe(w, probe)!.subject));
	}
	for (const fact of w.facts) {
		const source = w.seedSteps.find(s => s.id === fact.sourcePromptId)!;
		assert.ok(source.text.includes(fact.subject));
		assert.ok(source.text.includes(fact.field));
		assert.ok(source.text.includes(fact.value));
		assert.equal(w.facts.filter(f => source.text.includes(f.value)).length, 1);
	}
});

test("public probes disclose no answer key and unknown probes have no fact", () => {
	const w = buildWorkload("blind");
	const unknownSubjects: string[] = [];
	for (const stage of ["A", "B"] as const) {
		for (const probe of w.probes[stage]) {
			assert.equal(probe.step.kind, "probe");
			assert.equal(probe.step.probeId, probe.id);
			assert.deepEqual(Object.keys(probe.step).sort(), ["id", "kind", "probeId", "stage", "text"]);
			for (const fact of w.facts) assert.ok(!probe.step.text.includes(fact.value));
			assert.ok(probe.step.text.includes('"answer": null'));
			if (probe.factId === null) {
				assert.equal(factForProbe(w, probe), null);
				unknownSubjects.push(probe.step.text);
			}
		}
	}
	assert.notEqual(unknownSubjects[0], unknownSubjects[1]);
});

test("work packets do not grow by repeating explanatory paragraphs", () => {
	const packet = renderWorkPacket("no-filler", 0);
	const paragraphs = packet.text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 100);
	assert.equal(new Set(paragraphs).size, paragraphs.length);
});

test("substantive packets fit measured size bounds without later target records", () => {
	const w = buildWorkload("packet-seed");
	for (const index of [0, 1, 40]) {
		const packet = renderWorkPacket(w.seed, index);
		assert.ok(packet.estimatedTokens >= 8_000 && packet.estimatedTokens <= 12_000);
		assert.equal(packet.estimatedTokens, estimateTokens({ role: "user", content: packet.text, timestamp: 0 }));
		assert.deepEqual(packet, renderWorkPacket(w.seed, index));
		assert.match(packet.text, /source/i);
		assert.match(packet.text, /settings/i);
		assert.match(packet.text, /incident/i);
		const records = packet.text.split("\n## Incident record ").slice(1);
		assert.ok(records.length > 1);
		assert.equal(new Set(records).size, records.length);
		for (const fact of w.facts) {
			assert.ok(!packet.text.includes(fact.value));
			assert.ok(!packet.text.includes(fact.subject));
			assert.ok(!packet.text.includes(fact.field));
		}
		const step = buildWorkStep(w.seed, index);
		assert.equal(step.kind, "work");
		assert.equal(step.text, packet.text);
		assert.deepEqual(Object.keys(step).sort(), ["id", "kind", "text"]);
	}
	assert.notEqual(renderWorkPacket(w.seed, 0).text, renderWorkPacket(w.seed, 1).text);
	assert.notEqual(renderWorkPacket(w.seed, 0).text, renderWorkPacket("other", 0).text);
});
