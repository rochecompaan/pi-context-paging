import { createHash } from "node:crypto";
import { renderWorkPacket } from "./packets.ts";

export type Arm = "baseline" | "paging";
export type Stage = "A" | "B";
export type FactCategory = "id" | "path" | "error" | "quantity" | "decision";
export type PromptStep = {
	id: string;
	kind: "seed" | "revision" | "work" | "probe";
	text: string;
	stage?: Stage;
	probeId?: string;
};
export type FactVersion = {
	factId: string;
	category: FactCategory;
	version: 1 | 2;
	value: string;
	sourcePromptId: string;
	subject: string;
	field: string;
	uniqueLiteral: boolean;
};
export type Probe = { id: string; stage: Stage; factId: string | null; step: PromptStep };
export type Workload = {
	seed: string;
	seedSteps: readonly PromptStep[];
	facts: readonly FactVersion[];
	probes: Readonly<Record<Stage, readonly Probe[]>>;
};

const fields: Record<FactCategory, string> = {
	id: "recovery_token",
	path: "route_path",
	error: "last_error",
	quantity: "cutover_wait_ms",
	decision: "rollback_target",
};

function literal(seed: string, stage: Stage, category: FactCategory, version: number): string {
	const digest = createHash("sha256").update(JSON.stringify([seed, stage, category, version])).digest("hex");
	switch (category) {
		case "id": return `recovery-${digest.slice(0, 24)}`;
		case "path": return `/srv/checkpoints/${digest.slice(0, 24)}/routes.json`;
		case "error": return `E_CHECKPOINT_${digest.slice(0, 16)}: upstream lease rejected`;
		case "quantity": return `${50_000 + Number.parseInt(digest.slice(0, 8), 16) % 50_000} ms`;
		case "decision": return `rollback-${digest.slice(0, 24)}`;
	}
}

function probeStep(id: string, stage: Stage, question: string): PromptStep {
	return {
		id, kind: "probe", stage, probeId: id,
		text: `${question}\nReturn only one JSON object: {"answer": "exact value"} or {"answer": null} if the value was never supplied or cannot be determined. Do not infer an unsupported value.`,
	};
}

export function buildWorkload(seed: string): Workload {
	const facts: FactVersion[] = [];
	const seedSteps: PromptStep[] = [];
	const probes: Record<Stage, Probe[]> = { A: [], B: [] };
	for (const stage of ["A", "B"] as const) {
		const subject = `${stage === "A" ? "Atlas" : "Boreal"}-${createHash("sha256").update(JSON.stringify([seed, stage])).digest("hex").slice(0, 12)}`;
		for (const category of Object.keys(fields) as FactCategory[]) {
			const factId = `${stage}-${category}`;
			for (const version of (category === "decision" ? [1, 2] : [1]) as (1 | 2)[]) {
				const sourcePromptId = `seed-${factId}-v${version}`;
				const fact: FactVersion = {
					factId, category, version, sourcePromptId, subject, field: fields[category],
					value: literal(seed, stage, category, version), uniqueLiteral: category !== "quantity",
				};
				facts.push(fact);
				seedSteps.push({
					id: sourcePromptId, kind: version === 1 ? "seed" : "revision",
					text: `Incident checkpoint for ${subject}.\n${subject}: ${fact.field} = ${fact.value}\n${version === 2 ? "This decision replaces the earlier value for this field. " : ""}Acknowledge this record without copying its value.`,
				});
			}
			const id = `probe-${factId}`;
			const question = `What is the latest recorded ${fields[category]} for incident ${subject}?${category === "quantity" ? " Include the ms unit in the answer string." : ""}`;
			probes[stage].push({ id, stage, factId, step: probeStep(id, stage, question) });
		}
		const id = `probe-${stage}-unknown`;
		probes[stage].push({
			id, stage, factId: null,
			step: probeStep(id, stage, `What is the recorded ${stage === "A" ? "archive_unlock_token" : "forensic_export_path"} for incident ${subject}?`),
		});
	}
	return { seed, seedSteps, facts, probes };
}

export function factForProbe(workload: Workload, probe: Probe): FactVersion | null {
	if (probe.factId === null) return null;
	const versions = workload.facts.filter(fact => fact.factId === probe.factId);
	const latest = versions.reduce<FactVersion | null>((value, fact) => !value || fact.version > value.version ? fact : value, null);
	if (!latest) throw new Error(`No fact for known probe ${probe.id}`);
	return latest;
}

export function buildWorkStep(seed: string, index: number): PromptStep {
	return { id: `work-${index}`, kind: "work", text: renderWorkPacket(seed, index).text };
}
