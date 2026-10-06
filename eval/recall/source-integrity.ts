import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type CleanSourceSnapshot = { sourceRevision: string; sourceIntegrity: "clean-checkout-v1" };
export const SOURCE_INTEGRITY = "clean-checkout-v1" as const;

function reject(code: string): never {
	throw Object.assign(new Error("Source checkout is not verified"), { code });
}

/** No live imports or credential access. Inspect the checkout containing the CLI. */
export function assertCleanSource(repoRoot: string, expectedRevision?: string): CleanSourceSnapshot {
	const git = (...args: string[]) => execFileSync("git", args, {
		cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024,
	});
	try {
		if (realpathSync(git("rev-parse", "--show-toplevel").trim()) !== realpathSync(repoRoot)) reject("SOURCE_ROOT_MISMATCH");
		const revision = git("rev-parse", "--verify", "HEAD").trim();
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) reject("MISSING_SOURCE_REVISION");
		if (expectedRevision && revision !== expectedRevision) reject("SOURCE_REVISION_CHANGED");
		const clean = () => { if (git("status", "--porcelain=v1", "-z", "--untracked-files=all").length) reject("DIRTY_SOURCE"); };
		clean();
		const index = git("ls-files", "-v", "-z").split("\0").filter(Boolean);
		if (index.some(entry => /^(?:[a-z]|S) /.test(entry))) reject("SOURCE_UNVERIFIABLE_INDEX");
		const tracked = new Set(index.map(entry => entry.slice(2)));
		const checkFile = (path: string) => {
			if (lstatSync(path).isSymbolicLink()) reject("SYMLINK_SOURCE");
			if (!tracked.has(relative(repoRoot, path).split(sep).join("/"))) reject("UNTRACKED_LIVE_SOURCE");
		};
		const walk = (path: string) => {
			if (lstatSync(path).isSymbolicLink()) reject("SYMLINK_SOURCE");
			for (const entry of readdirSync(path, { withFileTypes: true })) {
				const child = join(path, entry.name);
				if (entry.isSymbolicLink()) reject("SYMLINK_SOURCE");
				if (entry.isDirectory()) walk(child);
				else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) checkFile(child);
			}
		};
		for (const path of ["src/index.ts", "eval/recall/source-integrity.ts", "eval/recall/codex-runtime.ts", "scripts/recall-eval.ts"]) checkFile(join(repoRoot, path));
		for (const directory of ["src", "eval/recall"]) walk(join(repoRoot, directory));
		clean();
		if (git("rev-parse", "HEAD").trim() !== revision) reject("SOURCE_REVISION_CHANGED");
		return { sourceRevision: revision, sourceIntegrity: SOURCE_INTEGRITY };
	} catch (error) {
		if (error instanceof Error && "code" in error && typeof error.code === "string" && /^(?:SOURCE_|MISSING_SOURCE_|DIRTY_SOURCE|SYMLINK_SOURCE|UNTRACKED_LIVE_SOURCE)/.test(error.code)) throw error;
		return reject("SOURCE_GIT_UNAVAILABLE");
	}
}
