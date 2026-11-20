import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAXIMUM_LINK_HOPS = 64;

function entry(path: string): Stats | undefined {
	return lstatSync(path, { throwIfNoEntry: false });
}

/** Deepest path that exists as a directory entry; a dangling symlink is an entry, so it counts. */
function deepestEntry(path: string): string {
	let current = path;
	while (!entry(current) && dirname(current) !== current) current = dirname(current);
	return current;
}

/** Resolves a symlink whose target does not exist yet, because the run creates it after the check. */
function realEntry(path: string): string {
	let current = path;
	for (let hop = 0; hop < MAXIMUM_LINK_HOPS; hop++) {
		const info = entry(current);
		// Nothing on disk to resolve beyond here, so the rest of the path is text the run will create.
		if (info === undefined) return current;
		if (!info.isSymbolicLink()) return realpathSync(current);
		current = resolve(dirname(current), readlinkSync(current));
	}
	throw new Error("Unsafe artifact location");
}

/** Fully resolves the leading links of a path and keeps the not-yet-created tail as text. */
function resolveOutput(root: string, directory: string): string {
	let current = resolve(root, directory);
	for (let hop = 0; hop < MAXIMUM_LINK_HOPS; hop++) {
		const existing = deepestEntry(current);
		const next = join(realEntry(existing), relative(existing, current));
		if (next === current) return next;
		current = next;
	}
	throw new Error("Unsafe artifact location");
}

/** Resolve symlinks, including links whose target the run creates, before judging the checkout. */
export function assertOutputLocation(repoRoot: string, directory: string): string {
	const root = realpathSync(repoRoot), output = resolveOutput(root, directory);
	const local = relative(root, output);
	if (local === "" || local === ".git" || local.startsWith(`.git${sep}`)) throw new Error("Unsafe artifact location");
	if (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)) {
		try { execFileSync("git", ["check-ignore", "-q", "--", join(local, ".recall-output-check")], { cwd: root, stdio: "ignore" }); }
		catch { throw Object.assign(new Error("Artifact output must be outside the checkout or ignored"), { code: "UNIGNORED_ARTIFACT_OUTPUT" }); }
	}
	return output;
}
