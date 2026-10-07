import { defaultLimits, type EvalLimits } from "./request-guard.ts";

export type EvalCliOptions = {
	mode: "dry-run" | "pilot" | "batch"; seed: string; outputDirectory: string; pairs: number;
	pilotManifestPath?: string; limits: EvalLimits;
};
function invalid(): never { throw Object.assign(new Error("Invalid recall evaluation arguments"), { code: "INVALID_EVAL_ARGUMENTS" }); }
function positive(value: string): number {
	if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) invalid();
	return Number(value);
}

export function parseEvalArgs(argv: readonly string[]): EvalCliOptions {
	let mode: EvalCliOptions["mode"] = "dry-run", selected = false;
	let seed: string | undefined, outputDirectory = ".pi/evals/full-budget-recall", pairs: number | undefined, pilotManifestPath: string | undefined;
	const limits = { ...defaultLimits }, seen = new Set<string>();
	const limitFlags: Record<string, keyof EvalLimits> = { "--max-user-prompts": "maxUserPrompts", "--max-requests-per-prompt": "maxRequestsPerPrompt",
		"--max-requests-per-arm": "maxRequestsPerArm", "--max-pair-minutes": "maxPairMinutes" };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index]; if (seen.has(flag)) invalid(); seen.add(flag);
		if (["--dry-run", "--pilot", "--batch"].includes(flag)) {
			if (selected) invalid(); selected = true; mode = flag.slice(2) as EvalCliOptions["mode"]; continue;
		}
		if (!["--seed", "--output-dir", "--pairs", "--pilot-manifest", ...Object.keys(limitFlags)].includes(flag)) invalid();
		const value = argv[++index]; if (!value?.trim() || value.startsWith("--")) invalid();
		if (flag === "--seed") { if (value.length > 256) invalid(); seed = value; }
		else if (flag === "--output-dir") outputDirectory = value;
		else if (flag === "--pilot-manifest") pilotManifestPath = value;
		else if (flag === "--pairs") pairs = positive(value);
		else limits[limitFlags[flag]] = positive(value);
	}
	if (limits.maxPairMinutes * 60_000 > 2_147_483_647 || (pairs !== undefined && mode !== "batch")
		|| (mode === "batch" ? !pilotManifestPath : pilotManifestPath !== undefined)) invalid();
	return { mode, seed: seed ?? (mode === "pilot" ? "pilot-v1" : "batch-v1"), outputDirectory,
		pairs: pairs ?? (mode === "batch" ? 3 : 1), ...(pilotManifestPath ? { pilotManifestPath } : {}), limits };
}
