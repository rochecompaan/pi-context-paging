import { defaultLimits, type EvalLimits } from "./request-guard.ts";

export type EvalCliOptions = {
	mode: "dry-run" | "pilot" | "batch"; seed: string; outputDirectory: string; pairs: number;
	pilotManifestPath?: string; limits: EvalLimits;
};

/**
 * One table describes every accepted argument, and `EVAL_USAGE` is generated from it, so the flag list a developer
 * reads can never drift from the flags the parser accepts. Measured reason: `--help` was rejected as an invalid
 * argument, and every argument error printed `{"name":"Error","code":"INVALID_EVAL_ARGUMENTS"}` -- nine flags, five
 * structural rules, and no way to discover them short of reading this file.
 */
const modeFlags = ["--dry-run", "--pilot", "--batch"] as const;
const limitFlags: Record<string, keyof EvalLimits> = {
	"--max-user-prompts": "maxUserPrompts", "--max-requests-per-prompt": "maxRequestsPerPrompt",
	"--max-requests-per-arm": "maxRequestsPerArm", "--max-pair-minutes": "maxPairMinutes",
};
const flagHelp: ReadonlyArray<readonly [string, string]> = [
	["(no flags)", `dry run: prints the plan, inspects no credentials, creates no sessions, requests, or artifacts`],
	...modeFlags.map(flag => [flag, `${flag.slice(2)} evaluation; one mode at a time`] as const),
	["--seed <value>", "experiment seed (max 256 characters); defaults to pilot-v1 for --pilot and batch-v1 for --batch"],
	["--output-dir <path>", "where artifacts go (default .pi/evals/full-budget-recall)"],
	["--pairs <n>", "pairs to run; --batch only (default 3 for --batch, 1 otherwise)"],
	["--pilot-manifest <path>", "pilot results file; required for --batch, rejected for other modes"],
	...Object.entries(limitFlags).map(([flag, key]) => [flag, `request-guard limit, default ${defaultLimits[key]}`] as const),
	["--help", "print this list and exit"],
];

/** Every accepted flag, in the order the usage text lists them; tests assert the list stays complete. */
export const evalFlags: readonly string[] = Object.freeze(flagHelp.map(([flag]) => flag));

export const EVAL_USAGE: string = Object.freeze([
	"Usage: npm run eval:recall -- [flags]",
	"",
	...flagHelp.map(([flag, description]) => `  ${flag.padEnd(24)}${description}`),
	"",
	"Rules: at most one mode; each flag at most once; a flag that takes a value needs a non-flag value after it.",
].join("\n"));

/** True when the caller asked for help instead of running an evaluation. */
export function isHelpRequest(argv: readonly string[]): boolean {
	return argv[0] === "--help" || argv[0] === "-h";
}

/**
 * Argument failures carry the flag that caused them. The message is for direct API consumers; the `flag` field is what
 * reaches the terminal, because the console relay in ../../scripts/recall-eval.ts prints a sanitized record and must
 * not relay arbitrary error text (see safeError in ./safe-artifacts.ts).
 */
function invalid(reason: string, flag?: string): never {
	// `reason` is enumerable and therefore relayable; Error#message is not, which is why the console relay in
	// ../../scripts/recall-eval.ts printed only {name, code}. The relay re-validates the shape (see safeError).
	throw Object.assign(new Error(reason), { code: "INVALID_EVAL_ARGUMENTS", reason, ...(flag ? { flag } : {}) });
}
function positive(value: string, flag: string): number {
	if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) invalid(`${flag} needs a positive whole number, got "${value}".`, flag);
	return Number(value);
}

export function parseEvalArgs(argv: readonly string[]): EvalCliOptions {
	let mode: EvalCliOptions["mode"] = "dry-run", selected = false;
	let seed: string | undefined, outputDirectory = ".pi/evals/full-budget-recall", pairs: number | undefined, pilotManifestPath: string | undefined;
	const limits = { ...defaultLimits }, seen = new Set<string>();
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (seen.has(flag)) invalid(`${flag} was given more than once.`, flag);
		seen.add(flag);
		if ((modeFlags as readonly string[]).includes(flag)) {
			if (selected) invalid("Choose one mode: --dry-run, --pilot, and --batch cannot be combined.", flag);
			selected = true; mode = flag.slice(2) as EvalCliOptions["mode"]; continue;
		}
		if (!["--seed", "--output-dir", "--pairs", "--pilot-manifest", ...Object.keys(limitFlags)].includes(flag)) {
			invalid(`"${flag}" is not a flag this evaluation accepts.`, flag);
		}
		const value = argv[++index];
		if (!value?.trim() || value.startsWith("--")) invalid(`${flag} needs a value.`, flag);
		if (flag === "--seed") {
			if (value.length > 256) invalid("--seed is limited to 256 characters.", flag);
			seed = value;
		} else if (flag === "--output-dir") outputDirectory = value;
		else if (flag === "--pilot-manifest") pilotManifestPath = value;
		else if (flag === "--pairs") pairs = positive(value, flag);
		else limits[limitFlags[flag]] = positive(value, flag);
	}
	if (limits.maxPairMinutes * 60_000 > 2_147_483_647) invalid("--max-pair-minutes is too large to time a pair.", "--max-pair-minutes");
	if (pairs !== undefined && mode !== "batch") invalid("--pairs only applies to --batch.", "--pairs");
	if (mode === "batch" && !pilotManifestPath) invalid("--batch needs --pilot-manifest <path> to the pilot results it scores.", "--batch");
	if (mode !== "batch" && pilotManifestPath !== undefined) invalid("--pilot-manifest only applies to --batch.", "--pilot-manifest");
	return { mode, seed: seed ?? (mode === "pilot" ? "pilot-v1" : "batch-v1"), outputDirectory,
		pairs: pairs ?? (mode === "batch" ? 3 : 1), ...(pilotManifestPath ? { pilotManifestPath } : {}), limits };
}
