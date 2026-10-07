import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve existing symlinks before deciding whether output can dirty the checkout. */
export function assertOutputLocation(repoRoot: string, directory: string): string {
	const root = realpathSync(repoRoot), output = resolve(root, directory);
	let parent = output;
	while (!existsSync(parent)) parent = dirname(parent);
	const actual = resolve(realpathSync(parent), relative(parent, output)), local = relative(root, actual);
	if (local === "" || local === ".git" || local.startsWith(`.git${sep}`)) throw new Error("Unsafe artifact location");
	if (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)) {
		try { execFileSync("git", ["check-ignore", "-q", "--", join(local, ".recall-output-check")], { cwd: root, stdio: "ignore" }); }
		catch { throw Object.assign(new Error("Artifact output must be outside the checkout or ignored"), { code: "UNIGNORED_ARTIFACT_OUTPUT" }); }
	}
	return actual;
}
