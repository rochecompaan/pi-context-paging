#!/usr/bin/env node
// Runs this package's own gates against a *published* Pi host, not the one pinned in devDependencies.
//
// Why this exists: the package supports every Pi from the peer floor up, while `npm run check`
// typechecks and tests only against the pinned dev host. Drift on the host side — a changed tool-handler
// context, a renamed model tag — is invisible to the pinned suite and shows up in the field. Two such
// defects were found by hand in one session and nothing re-ran the probe, so the probe became this gate.
//
// Usage:
//   node scripts/check-host-compat.mjs                        # latest published Pi
//   ... --host <version|dist-tag|floor>                      # a specific Pi; "floor" = the oldest supported
//   ... --print-floor                                        # print the supported floor and exit
//   ... --dir <path>                                          # use/create this workspace (kept by default)
//   ... --install-only | --typecheck-only | --tests-only | --artifact-only   # one stage in an existing workspace
//   ... --runtime-only                                     # skip the suite: typecheck + artifact + API probe
//   ... --keep                                                # keep a fresh temp workspace
//
// The install stage needs network access. The exit code is 2 for a gate/setup problem and 1 when the
// host build does not typecheck or any test fails.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const HOST_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];
/**
 * Lowest published Pi whose APIs the request path actually finds, measured one version per run with the
 * artifact API probe (scripts/host-api-probe.ts): on 0.86.1 and every older host tested down to 0.74.0,
 * `sessionManager.buildSessionProjection()` is undefined. Until 2dfa0a9 that meant `src/index.ts` threw on the
 * first request that read the session projection — after registration succeeded and the tools appeared. The
 * extension now detects the missing API at session start and keeps paging off, so the floor is enforced in
 * three places: `peerDependencies` declare it (`>=0.87.0`), so npm refuses an install below it; `session_start`
 * turns paging off on a host that cannot provide it, for an installer that bypasses peer checks; and
 * `--host floor` lets CI enforce the same boundary at runtime, where a peer check can be bypassed, instead of
 * testing only latest.
 * README.md states the same number and tests/host-compat-contract.test.ts pins all three together.
 */
const COMPAT_FLOOR = "0.87.0";
const args = process.argv.slice(2);

function takeValue(name, fallback) {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const value = args[i + 1];
	args.splice(i, 2);
	return value === undefined || value.startsWith("--") ? fallback : value;
}
function takeFlag(name) {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
}

const hostArg = takeValue("host", "latest");
const requestedHost = hostArg === "floor" ? COMPAT_FLOOR : hostArg;
const dirArg = takeValue("dir", undefined);
const installOnly = takeFlag("install-only");
const typecheckOnly = takeFlag("typecheck-only");
const testsOnly = takeFlag("tests-only");
const artifactOnly = takeFlag("artifact-only");
// Outside the tested-host range the suite is not the contract: the recall-eval rig resolves models through
// the newest host's registry, so on 0.87.0 it reports 39 failures while `src/` typechecks, the packed
// artifact loads, and every host API the extension calls exists. `--runtime-only` runs exactly the stages
// that define "this host can run the extension": typecheck, packed artifact, host API probe.
const runtimeOnly = takeFlag("runtime-only");
const keep = takeFlag("keep") || dirArg !== undefined;
if (takeFlag("print-floor")) {
	console.log(COMPAT_FLOOR);
	process.exit(0);
}
if (args.length > 0) {
	console.log(`HOST GATE: unexpected argument ${args[0]}\n${"usage: node scripts/check-host-compat.mjs [--host <v>] [--dir <path>] [--install-only|--typecheck-only|--tests-only|--artifact-only] [--keep]"}`);
	process.exit(2);
}

const workspace = dirArg ?? mkdtempSync(join(tmpdir(), "host-compat-"));
mkdirSync(workspace, { recursive: true });
const dev = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies ?? {};
const installedVersion = () => {
	try {
		return JSON.parse(readFileSync(join(workspace, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")).version;
	} catch {
		return "unknown";
	}
};

function run(command, commandArgs, options = {}) {
	try {
		return { code: 0, out: execFileSync(command, commandArgs, { cwd: options.cwd ?? workspace, encoding: "utf8", stdio: "pipe", maxBuffer: 64 << 20 }) };
	} catch (error) {
		return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
	}
}

/** Installs the published host plus the repo's own toolchain, so the host is the only variable. */
function install() {
	// A private stub: the repo's package.json pins dev hosts in devDependencies and must not drive this install.
	writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ name: "host-compat-workspace", private: true, type: "module" }, null, 2)}\n`);
	const resolved = run("npm", ["view", `${HOST_PACKAGES[0]}@${requestedHost}`, "version"]);
	if (resolved.code !== 0) {
		console.log(`HOST GATE: cannot resolve ${HOST_PACKAGES[0]}@${requestedHost}: ${resolved.out.trim().split("\n").at(-1)}`);
		process.exit(2);
	}
	const version = resolved.out.trim().split("\n").at(-1);
	const specs = [
		...HOST_PACKAGES.map((name) => `${name}@${version}`),
		`typebox@${dev.typebox ?? "*"}`,
		`typescript@${dev.typescript ?? "*"}`,
		`@types/node@${dev["@types/node"] ?? "*"}`,
	];
	const installed = run("npm", ["install", "--silent", "--no-audit", "--no-fund", "--package-lock=false", ...specs]);
	if (installed.code !== 0) {
		console.log(`HOST GATE ${version}: install failed\n${installed.out.split("\n").slice(-12).join("\n")}`);
		process.exit(2);
	}
	console.log(`HOST GATE: installed ${HOST_PACKAGES[0]}@${version} with ${specs.slice(-3).join(", ")}`);
}

function sync() {
	// The dev surface, plus exactly what package.json ships: `scripts/smoke-packed-artifact.mjs` asserts the
	// packed file list, so a workspace that omits README.md/LICENSE/docs packs an unfaithful artifact and the
	// artifact stage fails for the wrong reason.
	const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
	// .github is part of the surface the suite reads: tests/host-compat-contract.test.ts pins the CI host matrix.
	for (const entry of ["src", "tests", "eval", "scripts", "bench", "docs", ".github", ...(manifest.files ?? [])]) {
		const from = join(repo, entry);
		const to = join(workspace, entry);
		// Prune before copying. A staged `--dir` run reuses a workspace, and additive copying would leave a
		// file the source no longer has — the packed artifact would then look complete while the tree is not.
		rmSync(to, { recursive: true, force: true });
		if (existsSync(from)) cpSync(from, to, { recursive: true });
	}
	for (const file of ["tsconfig.json", "package.json", "LICENSE", "README.md"]) {
		if (existsSync(join(repo, file))) cpSync(join(repo, file), join(workspace, file));
	}
}

function typecheck() {
	const tsc = join(workspace, "node_modules", "typescript", "bin", "tsc");
	if (!existsSync(tsc)) {
		console.log("HOST GATE: no typescript in the workspace; run the install stage first");
		process.exit(2);
	}
	const result = run(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.json"]);
	const errors = result.out.split("\n").filter((line) => line.includes("error TS"));
	console.log(`HOST GATE: typecheck ${errors.length === 0 ? "clean" : `${errors.length} error(s)`}`);
	for (const line of errors.slice(0, 12)) console.log(`  ${line}`);
	return errors.length > 0;
}

/** Loads the packed tarball in the real host CLI: the artifact is what ships, and it is what a user's Pi loads. */
function artifact() {
	const smoke = join(workspace, "scripts", "smoke-packed-artifact.mjs");
	if (!existsSync(smoke)) {
		console.log("HOST GATE: no scripts/smoke-packed-artifact.mjs in the workspace; the artifact was not checked");
		return true;
	}
	const result = run(process.execPath, ["scripts/smoke-packed-artifact.mjs"]);
	const verdict = result.out.split("\n").filter((line) => /verified .*\.tgz|AssertionError|Error:/.test(line)).slice(-3);
	const failed = result.code !== 0;
	console.log(`HOST GATE: artifact ${failed ? "FAILED" : "OK"}`);
	for (const line of verdict) console.log(`  ${line.trim()}`);
	return failed;
}

function tests() {
	// A Node build compiled without TypeScript support throws ERR_NO_TYPESCRIPT for every .ts file, which arrives as
	// a wall of failing test files sharing one internal cause. Name the build and stop.
	if (!process.features.typescript) {
		console.log(`HOST GATE: Node ${process.version} at ${process.execPath} has no TypeScript support, so the suite `+
			"cannot run here (see scripts/check-node-typescript.mjs). Use a nodejs.org/nvm build for the host gate.");
		return true;
	}
	// The same file set `npm test` runs, enumerated rather than globbed: execFileSync does not expand globs,
	// and handing the runner a directory reports one opaque failing entry instead of the suite.
	const files = readdirSync(join(repo, "tests")).filter((name) => name.endsWith(".test.ts")).sort().map((name) => join("tests", name));
	if (files.length === 0) {
		console.log("HOST GATE: no test files found; the gate is not measuring anything");
		return true;
	}
	const result = run(process.execPath, ["--test", "--experimental-strip-types", "--test-reporter=tap", ...files]);
	const summary = Object.fromEntries([...result.out.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
	const failing = result.out.split("\n").filter((line) => /^not ok \d+ -/.test(line)).slice(0, 12);
	const broken = (summary.fail ?? 1) + (summary.cancelled ?? 0) > 0;
	console.log(`HOST GATE: tests ${summary.pass ?? "?"} pass, ${summary.fail ?? "?"} fail, ${summary.skipped ?? 0} skipped, ${summary.cancelled ?? 0} cancelled (of ${summary.tests ?? "?"})`);
	for (const line of failing) console.log(`  ${line}`);
	if (broken && summary.tests === undefined) console.log("  (no TAP summary: the suite did not run to completion)");
	return broken;
}

let failed = false;
// --typecheck-only/--tests-only/--artifact-only are staged probes of an already-installed workspace.
if (!testsOnly && !typecheckOnly && !artifactOnly) install();
sync();
if (!testsOnly && !artifactOnly) failed = typecheck() || failed;
if (!installOnly && !typecheckOnly && !artifactOnly && !runtimeOnly) failed = tests() || failed;
if (!installOnly && !typecheckOnly && !testsOnly) failed = artifact() || failed;
// The suite is written against the newest host: `eval/recall` resolves models through that host's registry. On a host
// at or below the compatibility floor it can fail for harness reasons while the extension itself is fine — which is
// why the floor CI leg passes `--runtime-only`. Say so, or a contributor chases 39 phantom product bugs; measured:
// a full `--host floor` run reports `39 fail` and `artifact OK` in the same pass.
const suiteRan = !installOnly && !typecheckOnly && !artifactOnly && !runtimeOnly;
if (failed && suiteRan) {
	const compare = (left, right) => {
		const parts = (value) => value.split(".").map((part) => Number.parseInt(part, 10));
		const [a, b] = [parts(left), parts(right)];
		for (let index = 0; index < 3; index += 1) {
			if (a[index] !== b[index]) return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1;
		}
		return 0;
	};
	const host = installedVersion();
	if (/^\d+\.\d+\.\d+$/.test(host) && compare(host, COMPAT_FLOOR) <= 0) {
		console.log(`HOST GATE: hosts at or below the floor ${COMPAT_FLOOR} can fail the suite on the eval/recall model registry, `
			+ "not on the extension. The floor CI leg runs --runtime-only (typecheck + packed artifact + host API probe) for that reason.");
	}
}
if (!keep) rmSync(workspace, { recursive: true, force: true });
console.log(`HOST GATE ${failed ? "FAILED" : "OK"} on Pi ${installedVersion()} (${workspace})`);
process.exit(failed ? 1 : 0);
