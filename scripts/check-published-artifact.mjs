#!/usr/bin/env node
// Fails when the version this repository advertises is on npm as a build that does not carry this repository's
// compatibility contract.
//
// Why this exists — measured on the live registry, not inferred:
//   npm view @rochecompaan/pi-context-paging@0.3.11 gitHead  -> 4409e5e4ffa0b626c11e72afe666f0b6e55a0e5f
//   git rev-list -n1 v0.3.11                                 -> 4409e5e4ffa0b626c11e72afe666f0b6e55a0e5f
//   git rev-list --count v0.3.11..HEAD                       -> 65, and package.json still says 0.3.11
// The published tarball declares `"*"` for every host peer and has no capability guard (0 matches for
// MINIMUM_PI_VERSION / hostSupportsSessionProjection in its src/index.ts). So a reader following the README's pinned
// `pi install npm:@rochecompaan/pi-context-paging@0.3.11` on a Pi below the floor gets a build that installs happily
// and then dies on the first request that reads the session projection — the exact failure the peer floor and the
// session_start guard exist to prevent, and the README section that pins that install command promises the floor is
// enforced. Every gate in this repository reads the source, so nothing could see the published copy disagreeing.
//
// What it compares, inside the artifact the registry serves for the advertised version:
//   - each host peer range against the repository's manifest (the floor the README promises installers),
//   - the capability guard against the published source (the guard the status command and README describe).
// A version that is not on the registry is a pre-release state, not a defect: exit 0, the tag publishes it.
//
// Network: read-only registry reads. This runs in CI, not in `npm run check` — the publish hook has to work offline
// (pinned in tests/host-compat-contract.test.ts), and a registry read does not.
// Test seam: PUBLISHED_ARTIFACT_DIR points at an extracted tarball root and skips the registry, so the pass path and
// the missing-guard path are checkable offline and deterministically.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_PEERS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];
const GUARD_PATTERN = /MINIMUM_PI_VERSION|hostSupportsSessionProjection/;
// A machine-checked anchor, not a sentence: the README has to disclose a stale published build where readers install
// it, and has to stop disclosing it once the published build is current. The prose around the marker is free; the
// marker's presence is the fact, so a rewording cannot break this and a forgotten note cannot quietly become a lie.
const CONTRACT_MARKER = "<!-- published-contract-disclosure -->";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

function npmView(spec, field) {
	try {
		return execFileSync("npm", ["view", spec, field], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function extractPublished(name, version) {
	const workspace = mkdtempSync(join(tmpdir(), "published-artifact-"));
	try {
		const tarball = execFileSync("npm", ["pack", `${name}@${version}`, "--silent", "--pack-destination", workspace], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim().split("\n").at(-1);
		const file = join(workspace, tarball.includes("/") ? tarball.split("/").pop() : tarball);
		execFileSync("tar", ["xzf", file, "-C", workspace], { stdio: "ignore" });
		return { dir: join(workspace, "package"), cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
	} catch (error) {
		rmSync(workspace, { recursive: true, force: true });
		throw new Error(`cannot read the published artifact for ${name}@${version}: ${error.message}`);
	}
}

const fixture = process.env.PUBLISHED_ARTIFACT_DIR;
let published;
if (fixture) {
	published = { dir: fixture, cleanup: () => {} };
} else {
	const exists = npmView(`${manifest.name}@${manifest.version}`, "version");
	if (!exists) {
		console.log(`PUBLISHED ARTIFACT: ${manifest.name}@${manifest.version} is not on the registry yet — nothing to compare.`);
		process.exit(0);
	}
	published = extractPublished(manifest.name, manifest.version);
}

try {
	const publishedManifest = JSON.parse(readFileSync(join(published.dir, "package.json"), "utf8"));
	// Two kinds of problem, kept apart because they have different remedies. [contract]: the published build does
	// not provide what this repository promises installers. [docs]: only the README's disclosure state is out of
	// step. Measured reason: with a release that was current and a marker left in an older release's section, this
	// gate printed the publish remedy -- "bump package.json, tag it" -- for a problem that needed a marker deleted,
	// and called a true historical note a lie. Conflating the two sends a maintainer to ship a release to fix a note.
	const contract = [];
	const docs = [];
	for (const peer of HOST_PEERS) {
		const wanted = manifest.peerDependencies?.[peer];
		const got = publishedManifest.peerDependencies?.[peer];
		if (wanted === got) continue;
		contract.push(`${peer}: registry says ${JSON.stringify(got)}, this repository's contract is ${JSON.stringify(wanted)}`);
	}
	let guardSource;
	try {
		guardSource = readFileSync(join(published.dir, "src", "index.ts"), "utf8");
	} catch {
		guardSource = "";
		contract.push("src/index.ts is missing from the published artifact, so the host-capability guard cannot be verified");
	}
	if (guardSource && !GUARD_PATTERN.test(guardSource)) {
		contract.push("the published src/index.ts has no host-capability guard (no MINIMUM_PI_VERSION / hostSupportsSessionProjection): an install below the floor registers the tools and dies on the first request that reads the session projection");
	}

	// The release tag is the repository's claim about what a version number ships, and npm records the commit the
	// published build was made from. Measured reason this is checked here: this repository's source and the registry's
	// 0.3.11 were 65 commits apart with the same version number, and a tag force-move is easy to do by accident -- a
	// local `git tag -f v0.3.11` silently destroys the comparison, which is why the tag is treated as evidence and this
	// check reads it. Both sides need a seam so the rule is testable offline.
	const publishedHead = process.env.PUBLISHED_GIT_HEAD ?? (fixture ? "" : npmView(`${manifest.name}@${manifest.version}`, "gitHead"));
	const tagRef = `v${manifest.version}`;
	const tagCommit = process.env.PUBLISHED_TAG_COMMIT ?? (() => {
		try {
			return execFileSync("git", ["rev-list", "-n", "1", tagRef], { encoding: "utf8", cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return ""; // Shallow clone, or tags not fetched: nothing to compare, and guessing here would be worse.
		}
	})();
	if (publishedHead && tagCommit && publishedHead !== tagCommit) {
		contract.push(`the registry built ${manifest.version} from ${publishedHead}, but this repository's ${tagRef} points at ${tagCommit}: the advertised version is not the source it claims to ship -- the tag moved, or the release was made from other content`);
	}

	// The README is the install contract, so its honesty about the published build is part of this check, in the two
	// places a reader acts on: where the install commands are, and the changelog section for this version, which is
	// where people look up what the release they are about to install does. Seam: a README path, so the rule is
	// testable without touching the document.
	const readme = readFileSync(process.env.PUBLISHED_CONTRACT_README ?? join(repo, "README.md"), "utf8");
	const section = (heading) => {
		const start = readme.indexOf(heading);
		if (start === -1) return null;
		const rest = readme.slice(start + heading.length);
		const next = rest.search(/^## /m);
		return next === -1 ? rest : rest.slice(0, next);
	};
	const regions = [
		{ where: "the Install section, where the install commands are", body: section("## Install") },
		{ where: `the "Changes in ${manifest.version}" section, where readers look up what this release does`, body: section(`## Changes in ${manifest.version}`) },
	];
	const undisclosed = regions.filter((region) => region.body === null || !region.body.includes(CONTRACT_MARKER));
	const marked = regions.filter((region) => region.body !== null && region.body.includes(CONTRACT_MARKER));
	// The mirror-image rule covers the two sections whose marker states the current relationship to the registry. A
	// marker inside an older release's section is the record of that release -- "the published 0.3.11 predates the
	// floor" stays true forever -- so it is not a claim about today and is deliberately not inspected.
	if (contract.length > 0 && undisclosed.length > 0) {
			docs.push(`the README advertises an install command for this version while the published build lacks the contract, and ${undisclosed.map((region) => region.where).join(" and ")} do not say so: add a note there marked ${CONTRACT_MARKER} naming what the published build does on an unsupported host`);
	}
	if (contract.length === 0 && marked.length > 0) {
			docs.push(`the published build carries the contract, so the disclosure markers in ${marked.map((region) => region.where).join(" and ")} describe a stale published build that no longer exists: remove the ${CONTRACT_MARKER} marker from those sections. A note inside an older release's section is that release's record and stays as it is`);
	}

	const problems = [...contract.map((problem) => ({ kind: "contract", problem })), ...docs.map((problem) => ({ kind: "docs", problem }))];
	if (problems.length === 0) {
		console.log(`PUBLISHED ARTIFACT: ${publishedManifest.name}@${publishedManifest.version} carries the peer floor and the capability guard.`);
		process.exit(0);
	}

	console.log(`PUBLISHED ARTIFACT: ${publishedManifest.name}@${publishedManifest.version} does not match what this repository promises${contract.length === 0 ? ", and the only problem is the README's disclosure state" : ""}:`);
	for (const { kind, problem } of problems) console.log(`  - [${kind}] ${problem}`);
	if (contract.length > 0) {
		console.log("The README pins an install command for this version, so readers are sent to a build whose guarantees are the old ones.");
		console.log("Fix: publish a version that carries the contract (bump package.json, keep README and CHANGELOG in step, tag it), or correct the contract in the source if the published build is the intended one.");
	} else {
		console.log("Nothing is missing from the published build: fix the disclosure state, not the release.");
	}
	process.exit(1);
} finally {
	published.cleanup();
}
