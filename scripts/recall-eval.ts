import { fileURLToPath } from "node:url";
import { EVAL_USAGE, isHelpRequest, parseEvalArgs, runEval } from "../eval/recall/cli.ts";
import { safeError } from "../eval/recall/safe-artifacts.ts";

// `--help` is a first-class result, not an invalid argument. Measured reason: `npm run eval:recall -- --help` used to
// print `{"name":"Error","code":"INVALID_EVAL_ARGUMENTS"}` and exit 2, so the nine flags and five structural rules were
// discoverable only by reading the source. EVAL_USAGE is generated from the parser's own flag table (see cli-options.ts).
const argv = process.argv.slice(2);
if (isHelpRequest(argv)) {
	console.log(EVAL_USAGE);
} else {
	try {
		process.exitCode = await runEval(parseEvalArgs(argv), {
			repoRoot: fileURLToPath(new URL("../", import.meta.url)),
			loadLive: async () => (await import("../eval/recall/live-dependencies.ts")).loadLiveEval(),
			log: line => console.log(line),
		});
	} catch (error) {
		// Relay the sanitized record's fields into one actionable line. safeError deliberately omits Error#message, so
		// argument failures carry a validated `flag`/`reason` (see safe-artifacts.ts and cli-options.ts).
		const record = safeError(error);
		const where = record.flag ? ` (in ${record.flag})` : "";
		const detail = record.reason ?? record.code ?? record.name;
		const hint = record.code === "INVALID_EVAL_ARGUMENTS" ? " Run with --help for the flag list." : "";
		console.error(`Recall evaluation failed: ${detail}${where}.${hint}`);
		process.exitCode = 2;
	}
}
