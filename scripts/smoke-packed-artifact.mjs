import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const piCommand = process.platform === "win32" ? ".\\node_modules\\.bin\\pi.cmd" : "./node_modules/.bin/pi";
const expectedFiles = [
  "LICENSE",
  "README.md",
  "docs/architecture.md",
  "docs/evals/full-budget-recall.md",
  "docs/evals/isolated-recall-restoration.md",
  "package.json",
  "src/context-calibration.ts",
  "src/context-costs.ts",
  "src/context-cut.ts",
  "src/context-policy.ts",
  "src/context-usage.ts",
  "src/history.ts",
  "src/index.ts",
  "src/navigator.ts",
  "src/output-pages.ts",
  "src/paging-notice.ts",
  "src/recovery-content.ts",
  "src/recovery-loads.ts",
  "src/recovery-parts.ts",
  "src/recovery-response.ts",
  "src/routed-model.ts",
  "src/selection-history.ts",
  "src/settings.ts",
  "src/stats.ts",
  "src/tools.ts",
].sort();
const requiredTools = [
  "search_history",
  "browse_history",
  "load_history",
  "read_context_output",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with ${result.status}`,
        result.stdout,
        result.stderr,
      ].join("\n"),
    );
  }

  return result.stdout;
}

function createPiEnvironment(homeDirectory, toolsetOutput, hostApiOutput) {
  const environment = {
    ...process.env,
    HOME: homeDirectory,
    PI_TOOLSET_PROBE_OUTPUT: toolsetOutput,
    PI_HOST_API_PROBE_OUTPUT: hostApiOutput,
  };
  delete environment.PI_PACKAGE_DIR;
  return environment;
}

function assertTemporaryPath(path) {
  assert(path.length > 0, "temporary path is empty");
  assert(path.startsWith("/tmp/"), `refusing to remove non-/tmp path: ${path}`);
}

/**
 * Markdown links inside shipped files have to resolve inside the tarball. README.md is the npm landing page, so a
 * link to a repository file that `files` omits is a 404 for every reader — and the harness docs link each other, so
 * shipping half of docs/evals breaks it the same way. Prose naming a dev path in backticks is not a link and is not
 * a promise to ship it, so this checks links only.
 */
async function findBrokenMarkdownLinks(packageDir, packedFiles) {
  const packed = new Set(packedFiles);
  const broken = [];
  for (const file of packedFiles.filter((path) => path.endsWith(".md"))) {
    const text = await readFile(join(packageDir, file), "utf8");
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (target === "" || /^(https?:|mailto:)/i.test(target)) continue;
      const resolved = normalize(join(dirname(file), target));
      if (packed.has(resolved)) continue;
      if (packedFiles.some((path) => path.startsWith(`${resolved}/`))) continue;
      broken.push(`${file} -> ${match[1]}`);
    }
  }
  return broken;
}

async function removeTemporaryPath(path) {
  assertTemporaryPath(path);
  await rm(path, { recursive: true, force: false });
}

let workDirectory;
let homeDirectory;
let cleanupStarted = false;

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const errors = [];

  for (const path of [homeDirectory, workDirectory]) {
    if (!path) continue;
    try {
      await removeTemporaryPath(path);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) throw errors[0];
}

for (const [signal, status] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    cleanup()
      .catch((error) => console.error(error))
      .finally(() => process.exit(status));
  });
}

let failure;
try {
  workDirectory = await mkdtemp("/tmp/pi-context-paging-pack-");
  assertTemporaryPath(workDirectory);

  const packOutput = run(npmCommand, [
    "pack",
    "--json",
    "--pack-destination",
    workDirectory,
  ]);
  const [packed] = JSON.parse(packOutput);
  const actualFiles = packed.files.map((file) => file.path).sort();
  assert.deepEqual(actualFiles, expectedFiles);

  const tarball = join(workDirectory, packed.filename);
  run("tar", ["-xzf", tarball, "-C", workDirectory]);

  // README.md is the npm landing page: a markdown link inside a shipped file must resolve inside the tarball.
  const brokenLinks = await findBrokenMarkdownLinks(join(workDirectory, "package"), actualFiles);
  assert(
    brokenLinks.length === 0,
    `shipped markdown links to files the tarball does not contain: ${brokenLinks.join(", ")}`,
  );

  homeDirectory = await mkdtemp("/tmp/pi-context-paging-home.");
  const hostApiOutput = join(workDirectory, "host-apis.json");
  assertTemporaryPath(homeDirectory);
  const toolsetOutput = join(workDirectory, "tools.json");
  const piEnvironment = createPiEnvironment(homeDirectory, toolsetOutput, hostApiOutput);

  run(piCommand, ["--version"], { env: piEnvironment });
  run(
    piCommand,
    [
      "--no-session",
      "--no-builtin-tools",
      "-e",
      join(workDirectory, "package"),
      "--extension",
      join(repoRoot, "scripts", "toolset-probe.ts"),
      "-p",
      "/write-toolset-probe",
    ],
    { env: piEnvironment },
  );

  const tools = JSON.parse(await readFile(toolsetOutput, "utf8"));
  for (const name of requiredTools) {
    assert(tools.all.includes(name), `${name} is not registered`);
    assert(tools.active.includes(name), `${name} is not active`);
  }

  // Registration is the easy half: the host transpiles .ts with jiti, so a missing session-manager method or host
  // export is a TypeError on the request path, not a load failure. Run the APIs the extension actually calls.
  run(
    piCommand,
    [
      "--no-session",
      "--no-builtin-tools",
      "-e",
      join(workDirectory, "package"),
      "--extension",
      join(repoRoot, "scripts", "host-api-probe.ts"),
      "-p",
      "/host-api-probe",
    ],
    { env: piEnvironment },
  );
  const hostApis = JSON.parse(await readFile(hostApiOutput, "utf8"));
  assert(
    hostApis.ok,
    `the packed extension calls host APIs this host does not provide: ${hostApis.missing.join("; ")}`,
  );

  // Guarded members are named, never failed: src/ reaches them through `?.`, a capability test, or a failure
  // path, so a host without one is a fact to record, not a reason to block a release.
  const guarded = hostApis.optionalMissing.length === 0
	? ""
	: `; guarded members absent on this host: ${hostApis.optionalMissing.join(", ")}`;
  console.log(`verified ${packed.filename} and ${requiredTools.length} history tools, and ${hostApis.checked.length} host APIs the extension calls${guarded}`);
} catch (error) {
  failure = error;
}

let cleanupFailure;
try {
  await cleanup();
} catch (error) {
  cleanupFailure = error;
}

if (failure) {
  if (cleanupFailure) console.error("cleanup also failed:", cleanupFailure);
  throw failure;
}
if (cleanupFailure) throw cleanupFailure;
