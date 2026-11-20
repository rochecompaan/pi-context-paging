#!/usr/bin/env node
// A release moves five version references in lockstep — package.json, the git tag, and three lines of the README that
// users copy. `publish.yml` already refuses to publish when the tag and `package.json` disagree, and
// `scripts/smoke-packed-artifact.mjs` proves the artifact loads. What nothing checked is the human-facing half:
// README.md:78/84/672 pin exact versions in the install and uninstall commands, and the changelog head names the
// version the notes describe.
//
// That drift is silent. A README pinning an older version still installs — the reader just installs an older build
// and never learns; a stale `pi remove` line cannot remove the package they have. This gate is the counterpart of the
// tag check: it verifies the instructions match the release the repository is preparing.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const readme = readFileSync(join(repo, "README.md"), "utf8");
const version = pkg.version;
const problems = [];

if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
	problems.push(`package.json version ${JSON.stringify(version)} is not X.Y.Z`);
}

const repositoryUrl = String(pkg.repository?.url ?? "");
const slug = (repositoryUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/) ?? [])[1];
if (!slug) {
	problems.push(`package.json repository.url does not name a GitHub slug: ${repositoryUrl || "(missing)"}`);
}

const commands = [
	[`pi install npm:${pkg.name}@${version}`, "npm install command"],
	...(slug ? [[`pi install git:github.com/${slug}@v${version}`, "git tag install command"]] : []),
	[`pi remove npm:${pkg.name}@${version}`, "uninstall command"],
];
for (const [needle, label] of commands) {
	if (!readme.includes(needle)) problems.push(`README is missing the ${label}: ${needle}`);
}

// Any install/uninstall command naming a different version is a stale instruction, even if the current one exists.
const lineOf = (index) =>
	index === undefined ? "README" : `README.md:${readme.slice(0, index).split("\n").length}`;
for (const match of readme.matchAll(/^pi (?:install|remove) \S*@v?(\d+\.\d+\.\d+)/gm)) {
	if (match[1] !== version) problems.push(`${lineOf(match.index)} pins ${match[1]}, package.json is ${version}`);
}

// The changelog is newest-first; its leading section must describe the version being released.
const head = readme.match(/^## Changes in (\d+\.\d+\.\d+)/m);
if (!head) {
	problems.push('README has no "## Changes in X.Y.Z" section');
} else if (head[1] !== version) {
	problems.push(`README changelog leads with ${head[1]}, package.json is ${version}`);
}

if (problems.length > 0) {
	console.log(`RELEASE METADATA: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
	process.exit(1);
}

console.log(`RELEASE METADATA: README install, uninstall, and changelog pins match ${pkg.name}@${version}`);
