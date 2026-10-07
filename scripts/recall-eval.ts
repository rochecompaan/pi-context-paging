import { fileURLToPath } from "node:url";
import { parseEvalArgs, runEval } from "../eval/recall/cli.ts";
import { safeError } from "../eval/recall/safe-artifacts.ts";

try {
	process.exitCode = await runEval(parseEvalArgs(process.argv.slice(2)), {
		repoRoot: fileURLToPath(new URL("../", import.meta.url)),
		loadLive: async () => (await import("../eval/recall/live-dependencies.ts")).loadLiveEval(),
		log: line => console.log(line),
	});
} catch (error) {
	console.error(`Recall evaluation failed: ${JSON.stringify(safeError(error))}`);
	process.exitCode = 2;
}
