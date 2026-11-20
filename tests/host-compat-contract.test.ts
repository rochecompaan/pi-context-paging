import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The supported-host boundary exists in three places that have to agree: the floor the gate resolves for
 * `--host floor`, the CI matrix that runs it, and the README that promises it to users.
 *
 * Drift here is user-visible, not cosmetic. Before the floor was enforced, `peerDependencies` was `"*"`, so
 * `pi install` succeeded on Pi 0.86.1 and the four history tools registered — and then the first request that
 * reads the session projection threw, because that host has no `sessionManager.buildSessionProjection()`. The
 * peer range is what stops that install today; the capability guard in src/index.ts is the backstop for an
 * installer that bypasses peer checks. Measured: 0.74.0, 0.80.1, 0.84.2, 0.86.0 and 0.86.1
 * fail; 0.87.0 and every newer host tested (1.0.4, 1.3.0, 1.5.2) pass.
 *
 * These tests pin the version token and the matrix entry, not the prose: the README can be reworded freely, and a
 * floor raised for a real reason passes, while silently dropping the floor check from CI or promising a host the
 * gate does not enforce fails.
 */
const repo = join(import.meta.dirname, "..");
const read = (relative: string): string => readFileSync(join(repo, relative), "utf8");

function printedFloor(): string {
	const result = spawnSync(process.execPath, [join(repo, "scripts", "check-host-compat.mjs"), "--print-floor"], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `--print-floor exited ${result.status}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function compareSemver(a: string, b: string): number {
	const parts = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10));
	const [left, right] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i += 1) {
		if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0) ? -1 : 1;
	}
	return 0;
}

test("the gate resolves --host floor to a publishable version", () => {
	const floor = printedFloor();
	assert.match(floor, /^\d+\.\d+\.\d+$/, `floor must be an exact published version, got ${JSON.stringify(floor)}`);
});

test("the extension's own capability floor is the version the gate enforces", () => {
	// src/index.ts refuses to page on a host without the session-projection API and quotes this version to the
	// user. If the gate's floor moves and the runtime message does not, users are told the wrong thing.
	const source = read("src/index.ts");
	const declared = source.match(/const MINIMUM_PI_VERSION = "(\d+\.\d+\.\d+)"/);
	assert.ok(declared, "src/index.ts must declare MINIMUM_PI_VERSION for the capability guard");
	assert.equal(declared[1], printedFloor(), "the runtime capability floor and the gate floor must agree");
});

test("publishing runs the checks from every path, not only from CI", () => {
	// publish.yml runs the gates, and check-release-metadata.mjs counts on that: "publish.yml already refuses to
	// publish". A tag pushed and published from a laptop, or a plain `npm publish`, reaches the registry with no
	// typecheck, no suite, no packed-artifact smoke and no release-pin check -- every gate in this repo is
	// bypassable through that path. npm runs `prepublishOnly` for the package being published, and only there:
	// `npm pack` (the host gate) and consumer installs are untouched.
	const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
	assert.ok(scripts.prepublishOnly, "package.json must gate the publish path itself");
	assert.match(scripts.prepublishOnly, /npm run check\b/, "the hook must run the same chain CI runs");
	assert.ok(!scripts.prepublishOnly.includes("check:host"), "the hook cannot install published hosts: offline publishing must stay possible");
	// The suite's own precondition chain. check-node-typescript.mjs has run as `pretest` since the strip-types build
	// trap; check-test-environment.mjs joined it after 15 output-location tests failed on a full temp filesystem with a
	// report that blamed output-path validation. Dropping a hook from `pretest` removes the named cause, not the failure.
	assert.ok(scripts.pretest, "package.json must gate the suite with its preconditions");
	assert.match(scripts.pretest, /check-node-typescript\.mjs/, "pretest must keep the Node and strip-types precondition");
	assert.match(scripts.pretest, /check-test-environment\.mjs/, "pretest must keep the temporary-filesystem precondition");
});

test("the manifest refuses to install on a host below the floor", () => {
	// The floor is a measured API boundary, so it has to reach the installer. With "*" peers npm places this
	// extension on a host that cannot page history at all, the four tools register, and the failure surfaces on
	// the user's first provider request. A peer range is the one surface that stops it before it is installed.
	const peers = JSON.parse(read("package.json")).peerDependencies as Record<string, string>;
	const want = ">=" + printedFloor();
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"]) {
		assert.equal(peers[name], want, name + " must be declared " + want + ", the measured floor");
	}
	// typebox is a peer because the host provides it, not because the paging API needs a version of it.
	assert.equal(peers.typebox, "*", "typebox has no measured floor and stays permissive");
});

test("the floor is at or above the oldest host measured to provide the paging path", () => {
	// 0.87.0 is the lowest host on which the artifact API probe passes. Lowering the gate's floor below it would
	// re-admit hosts where the extension registers and then throws on the request path.
	assert.ok(
		compareSemver(printedFloor(), "0.87.0") >= 0,
		`floor ${printedFloor()} is below 0.87.0, measured as the first host with sessionManager.buildSessionProjection()`,
	);
});

test("the README promises exactly the floor the gate enforces", () => {
	const readme = read("README.md");
	// Anchored on the section heading, not on sentences: the prose around the floor is free to change, the
	// version it tells users is not.
	const start = readme.search(/^### .*Pi versions?$/im);
	assert.notEqual(start, -1, "README must keep a supported-Pi-versions section heading");
	const section = readme.slice(start);
	const body = section.slice(0, section.search(/^## (?!#)/m) === -1 ? section.length : section.search(/^## (?!#)/m));
	const versions = [...body.matchAll(/\d+\.\d+\.\d+/g)].map((match) => match[0]);
	const floor = printedFloor();
	assert.ok(
		versions.includes(floor),
		`README must name the floor the gate enforces (${floor}); the section names ${versions.join(", ") || "no version"}`,
	);
	// The permissive range is a fact about the manifest, and the README stated it in a second place (the host-gate
	// section) where the section-anchored check above could not see it. One sentence said peers were "*" long after
	// the manifest declared the floor, so a reader debugging an install was pointed at the extension, not the range.
	assert.ok(
		!/peerDependencies[\s\S]{0,140}?is\s+`"\*"`/.test(readme),
		"the README must not claim the peer range is permissive while the manifest declares a floor",
	);
	const lower = versions.filter((version) => compareSemver(version, floor) < 0);
	assert.deepEqual(
		lower,
		[],
		`README must not advertise a Pi older than the enforced floor ${floor}: ${lower.join(", ")}`,
	);
});

test("CI enforces the floor as a runtime contract and latest as the full suite", () => {
	const workflow = read(".github/workflows/ci.yml");
	const job = workflow.slice(workflow.indexOf("  host-compat:"));
	assert.ok(job.length > 0, "ci.yml must keep a host-compat job");
	const legs = [...job.matchAll(/- pi: (\S+)\n\s+stages: (\S*)/g)].map((match) => ({
		pi: match[1],
		stages: match[2].replace(/^["']|["']$/g, ""),
	}));
	const names = legs.map((leg) => leg.pi).sort();
	assert.ok(names.includes("floor") && names.includes("latest"), `host-compat must cover floor and latest, got ${names.join(", ")}`);
	const floor = legs.find((leg) => leg.pi === "floor");
	assert.equal(
		floor?.stages,
		"--runtime-only",
		"the floor leg must run the runtime contract: the suite resolves models through the newest host registry and cannot pass on older hosts",
	);
	const latest = legs.find((leg) => leg.pi === "latest");
	assert.equal(latest?.stages, "", "the latest leg must run the whole gate, suite included");
	// The CI flag is only half the contract; the gate has to honour it, or the floor leg runs a suite that
	// cannot pass there (39 eval-harness failures on 0.87.0).
	assert.match(
		read("scripts/check-host-compat.mjs"),
		/!runtimeOnly\) failed = tests\(\)/,
		"--runtime-only must skip the suite stage in the gate, not just in the workflow",
	);
	assert.match(
		job,
		/check-host-compat\.mjs --host \$\{\{ matrix\.pi \}\} \$\{\{ matrix\.stages \}\}/,
		"the host-compat step must pass both the matrix host and its stage flags to the gate",
	);
});

test("the published-artifact gate compares the registry's build against the contract", () => {
	// A token search in the gate script proves nothing: its header names the tokens it greps for, so "the script
	// mentions MINIMUM_PI_VERSION" is satisfied by prose -- measured, neutering the pattern left such a pin green.
	// So run the gate. PUBLISHED_ARTIFACT_DIR is its seam for an extracted tarball root, which keeps this offline and
	// deterministic: the real registry copy of 0.3.11 (peers "*", no guard) is exactly fixture A.
	const workspace = mkdtempSync(join(tmpdir(), "published-contract-"));
	try {
		const manifest = JSON.parse(read("package.json"));
		const write = (dir: string, peers: Record<string, string>, source: string) => {
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: manifest.name, version: manifest.version, peerDependencies: peers }),
			);
			writeFileSync(join(dir, "src", "index.ts"), source);
		};
		const run = (dir: string, readmePath?: string) =>
			spawnSync(process.execPath, [join(repo, "scripts", "check-published-artifact.mjs")], {
				cwd: repo,
				env: { ...process.env, PUBLISHED_ARTIFACT_DIR: dir, ...(readmePath ? { PUBLISHED_CONTRACT_README: readmePath } : {}) },
				encoding: "utf8",
			});

		// A: the build on npm today -- permissive peers and no capability guard.
		const stale = join(workspace, "stale");
		write(stale, { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-agent-core": "*", "@earendil-works/pi-ai": "*", typebox: "*" }, "export default function paging() {}");
		const staleRun = run(stale);
		assert.equal(staleRun.status, 1, "a published build with permissive peers and no guard must fail the gate");
		const staleReport = staleRun.stdout + staleRun.stderr;
		// Semantic, not phrasing: the report has to name the range the repository contracts (read from the manifest, so a
		// floor bump keeps working) and the range the registry serves, plus the missing guard.
		const wanted = manifest.peerDependencies["@earendil-works/pi-coding-agent"] as string;
		assert.ok(staleReport.includes(wanted), `the report must name the contracted peer range ${wanted}, got: ${staleReport}`);
		assert.match(staleReport, /\"\*\"/, "the report must show the range the registry serves for the peer");
		assert.match(staleReport, /guard/i, "the report must name the missing capability guard");
		for (const peer of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"]) {
			assert.ok(staleReport.includes(peer), `the report must name every host peer, missing ${peer}`);
		}

		// B: a build that carries the contract -- same peer ranges, guard present.
		const current = join(workspace, "current");
		write(current, manifest.peerDependencies, "const MINIMUM_PI_VERSION = \"0.87.0\";\nexport default function paging() {}");

		// The README is the install contract, so the disclosure of a stale published build is checked in both
		// directions: required while the registry copy lacks the contract, forbidden once it carries it (a note about a
		// build that is now fine is its own false statement). Marker, not sentence: the prose is free to change.
		const marker = "<!-- published-contract-disclosure -->";
		const readme = read("README.md");
		assert.ok(readme.includes(marker), "the README must disclose the stale published build next to the install commands while the registry copy lacks the contract");
		const bareReadme = join(workspace, "README-bare.md");
		writeFileSync(bareReadme, readme.replace(marker, "<!-- no disclosure -->"));

		const staleWithDisclosure = run(stale);
		assert.ok(!(staleWithDisclosure.stdout + staleWithDisclosure.stderr).includes(marker), "a disclosed divergence must not also report the missing disclosure");
		const staleWithout = run(stale, bareReadme);
		assert.equal(staleWithout.status, 1, "a divergence the README does not mention must fail the gate");
		assert.ok((staleWithout.stdout + staleWithout.stderr).includes(marker), "the report must name the disclosure the README is missing");
		// Precision: the bare fixture removed the Install marker only, so the changelog section is disclosed and must
		// not be reported as missing.
		assert.ok(!(staleWithout.stdout + staleWithout.stderr).includes(`"Changes in ${manifest.version}"`), "a section that does disclose must not be reported as missing it");

		// The changelog section for this version is the other place a reader acts on: it is where people look up what
		// the release they are installing does, and the 0.3.11 section claimed the manifest refuses unsupported installs.
		const changelogAt = readme.indexOf(`## Changes in ${manifest.version}`);
		assert.ok(changelogAt > 0, "the README must keep a changelog section for the advertised version");
		const changelogBare = join(workspace, "README-changelog-bare.md");
		writeFileSync(changelogBare, readme.slice(0, changelogAt) + readme.slice(changelogAt).replace(marker, "<!-- none -->"));
		const changelogRun = run(stale, changelogBare);
		assert.equal(changelogRun.status, 1, "an undisclosed changelog section must fail the gate");
		const changelogReport = changelogRun.stdout + changelogRun.stderr;
		assert.ok(changelogReport.includes(`"Changes in ${manifest.version}"`), "the report must name the changelog section that lacks the disclosure");
		assert.ok(!changelogReport.includes("Install section"), "the Install section does disclose and must not be reported");

		// Nothing disclosed at all: both places are named.
		const noneReadme = join(workspace, "README-none.md");
		writeFileSync(noneReadme, readme.replaceAll(marker, "<!-- none -->"));
		const noneRun = run(stale, noneReadme);
		const noneReport = noneRun.stdout + noneRun.stderr;
		assert.equal(noneRun.status, 1, "a README with no disclosure anywhere must fail the gate");
		assert.ok(noneReport.includes("Install section") && noneReport.includes(`"Changes in ${manifest.version}"`), `the report must name both places, got: ${noneReport}`);

		// The post-release flow, which is the case this gate used to get wrong. Once a release carries the contract, the
		// Install disclosure is removed -- and the note inside the older release's section stays, because "the published
		// 0.3.11 predates the floor" is a true record of 0.3.11 forever. The gate used to fire on that marker and tell the
		// maintainer to delete a true historical note, with the publish remedy attached.
		const historic = join(workspace, "README-historic.md");
		const currentSectionAt = readme.indexOf(`## Changes in ${manifest.version}`);
		const olderAt = readme.indexOf("## Changes in 0.3.10");
		assert.ok(olderAt > 0, "the README must keep prior releases for this case");
		const withoutMarkers = readme.slice(0, currentSectionAt).replace(marker, "") + readme.slice(currentSectionAt).replace(marker, "");
		const olderHeading = "## Changes in 0.3.10\n";
		writeFileSync(historic, withoutMarkers.slice(0, olderAt + olderHeading.length) + "\n" + marker + "\n" + withoutMarkers.slice(olderAt + olderHeading.length));
		const historicRun = run(current, historic);
		assert.equal(historicRun.status, 0, `a released build with the disclosure removed and the historical note kept must pass: ${historicRun.stdout}${historicRun.stderr}`);
		const historicStale = run(stale, historic);
		assert.equal(historicStale.status, 1, "the same README against a stale published build must fail");
		const historicStaleReport = historicStale.stdout + historicStale.stderr;
		assert.ok(historicStaleReport.includes("[contract]"), "the missing contract must be reported as a contract problem");
		assert.ok(historicStaleReport.includes("[docs]"), "the missing disclosure must be reported as a documentation problem");

		writeFileSync(join(workspace, "README-current.md"), readme);
		const good = run(current, join(workspace, "README-current.md"));
		assert.equal(good.status, 1, "a disclosure left in place after the published build became current must fail the gate");
		const goodReport = good.stdout + good.stderr;
		assert.ok(goodReport.includes(marker), "the report must say the disclosure is no longer true");
		assert.ok(!goodReport.includes("[contract]"), "a current published build has no contract problem, so the report must not claim one");
		const clean = run(current, noneReadme);
		assert.equal(clean.status, 0, `a current published build with no disclosure must pass: ${clean.stdout}${clean.stderr}`);

		// Tolerance: the disclosure reworded, marker kept -- same verdict, no disclosure problem.
		const reworded = join(workspace, "README-reworded.md");
		writeFileSync(reworded, readme.replace("Both commands above install the **published release**", "The commands above fetch the **published build**"));
		const rewordedRun = run(stale, reworded);
		assert.equal(rewordedRun.status, 1, "rewording the disclosure must not change the verdict");
		assert.ok(!(rewordedRun.stdout + rewordedRun.stderr).includes(marker), "a reworded disclosure is still a disclosure");

		// The release tag is the repository's claim about what a version number ships, and npm records the commit the
		// published build came from. Measured reason to check the two against each other: the registry's 0.3.11 sat 65
		// commits away from the source carrying the same number, and a local `git tag -f v0.3.11` during this loop moved
		// the very tag the comparison relies on (restored and verified) -- a tag is evidence, and nothing checked it.
		const withHeads = (dir: string, gitHead: string, tagCommit: string) =>
			spawnSync(process.execPath, [join(repo, "scripts", "check-published-artifact.mjs")], {
				cwd: repo,
				env: {
					...process.env,
					PUBLISHED_ARTIFACT_DIR: dir,
					PUBLISHED_CONTRACT_README: join(workspace, "README-none.md"),
					PUBLISHED_GIT_HEAD: gitHead,
					PUBLISHED_TAG_COMMIT: tagCommit,
				},
				encoding: "utf8",
			});
		const head = "1111111111111111111111111111111111111111";
		const moved = "2222222222222222222222222222222222222222";
		const sameHead = withHeads(current, head, head);
		assert.equal(sameHead.status, 0, `a tag that matches the published commit must pass: ${sameHead.stdout}${sameHead.stderr}`);
		const movedTag = withHeads(current, head, moved);
		assert.equal(movedTag.status, 1, "a tag that does not match the published commit must fail the gate");
		const movedReport = movedTag.stdout + movedTag.stderr;
		assert.ok(movedReport.includes("[contract]"), "a moved tag is a contract problem, not a documentation one");
		assert.ok(movedReport.includes(`v${manifest.version}`), "the report must name the tag that disagrees with the registry");
		const unverifiable = withHeads(current, head, "");
		assert.equal(unverifiable.status, 0, "a repository that cannot resolve its release tag must not be reported as a mismatch");

		// The gate needs a registry read in the real path, so it belongs to CI and not to the offline publish hook.
		assert.match(
			read(".github/workflows/ci.yml"),
			/check-published-artifact\.mjs/,
			"the gate must run in CI: it reads the registry, so it cannot live in the offline publish hook",
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("publishing cannot report success when the registry's copy of the version is other content", () => {
	// Measured on the live registry: @rochecompaan/pi-context-paging@0.3.11 is published from 4409e5e, and this repo
	// carries version 0.3.11 65 commits later. The publish step read that state as "already published", exited 0, and
	// the next step created a GitHub release whose npm artifact does not exist -- a green release job for content npm
	// never saw. npm records gitHead for a publish from a git checkout, so the registry can say which commit a version
	// number was made from (measured: 0.3.11's gitHead equals `git rev-list -n1 v0.3.11`). A re-run of content that is
	// genuinely out must stay a no-op; a collision must fail.
	const publish = read(".github/workflows/publish.yml");
	const step = publish.slice(publish.indexOf("Publish to npm"));
	assert.ok(step.length > 0, "publish.yml must keep the npm publish step");
	assert.match(
		step,
		/npm view "\$package_name@\$package_version" gitHead/,
		"the step must ask the registry which commit the published version came from",
	);
	assert.match(step, /TAG_COMMIT/, "the step must compare that commit against the tag's own commit");
	assert.match(step, /exit 1/, "content the registry does not hold under this number must fail the job, not print and continue");
});

test("publishing checks the advertised floor before it publishes", () => {
	// A tag needs no green CI to exist, and this workflow's own comment says a tag from a release branch gets no
	// host-compat coverage from CI -- which is why the job runs the gate at all. It ran the gate against the latest
	// published Pi only, so a release could reach the registry while the extension could not load on the version
	// `peerDependencies` advertises: users on the floor install a release that promises to support them and get
	// paging turned off for the whole session. The floor leg is the one that protects that promise.
	const publish = read(".github/workflows/publish.yml");
	const gate = publish.indexOf("node scripts/check-host-compat.mjs");
	assert.ok(gate !== -1, "the publish workflow must run the host-compat gate: CI does not cover a tag");
	const floor = publish.indexOf("--host floor");
	assert.ok(floor !== -1, "the publish workflow must check the floor the manifest advertises, not only the latest Pi");
	// Pinned through the `--host floor` alias, not a version literal, so raising COMPAT_FLOOR keeps working here.
	assert.match(
		publish.slice(gate, floor + 60),
		/check-host-compat\.mjs --host floor --runtime-only/,
		"the floor leg must run the runtime contract stages: typecheck, packed artifact, host API probe",
	);
	const release = publish.indexOf("npm publish");
	assert.ok(
		release !== -1 && floor < release,
		"the floor check must run before npm publish, not after the release is out",
	);
});
