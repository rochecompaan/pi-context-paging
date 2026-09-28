# pi-context-paging Standalone Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `@rochecompaan/pi-context-paging` version `0.1.0` from a public one-commit repository through npm trusted publishing.

**Architecture:** The package publishes raw TypeScript from `src/index.ts`. Local package verification must inspect the packed tarball and load it through the locally installed Pi CLI. GitHub Actions runs this verification for pull requests, `main`, and release tags. The `roche-pi` cutover remains an external handoff until the public release is verified.

**Tech Stack:** TypeScript, Node.js 24, Node test runner, Pi extension API `0.87.1`, npm, GitHub Actions, npm OIDC trusted publishing, GitHub CLI, Nix actionlint package.

---

## Purpose

This plan resumes the standalone release after the completed import and documentation checkpoints. It defines executable work only for Tasks 3 through 7 in this repository. It also records the required external `roche-pi` handoff for Tasks 8 and 9.

## Scope

In scope:

- Finish packed-artifact and real-Pi runtime verification.
- Add CI and tag-driven trusted publishing workflows.
- Replace temporary staging history with one public import commit.
- Create the public GitHub repository.
- Bootstrap npm trusted publishing.
- Publish and verify `@rochecompaan/pi-context-paging@0.1.0`.
- Provide a non-executable external handoff for the later `roche-pi` cutover.

Out of scope:

- Any change to context selection, eviction, search, browsing, loading, paging, settings, or recovery-tool behavior.
- A JavaScript library interface, a command-line interface, a runtime dependency, or a local-checkout runtime dependency.
- Devenv configuration.
- The original Tasks 10 and 11.
- Changes in `roche-pi` from this plan.

## Safety Boundaries

- Use repository-relative paths for all standalone repository work.
- Do not push, publish, create a tag, create the GitHub repository, or start external cutover work before its named task and prerequisite gates pass.
- Do not use the global `/home/roche/.nix-profile/bin/pi` to bypass the packed-artifact smoke test. A user-approved plan change is required before any such substitution.
- Use `./node_modules/.bin/pi` for package smoke checks. This is the Pi package that CI installs with `npm ci`.
- Do not copy interrupted files into a commit before their explicit disposition in Task 3.
- Do not run `rm -rf "$HOME"`. A prior diagnostic set `HOME=$(mktemp -d)` for one command, then removed `$HOME` after Bash restored `/home/roche`. The command ran for 30 seconds before timeout.
- For a temporary home, assign `tmp_home` once. Make sure that it is nonempty and starts with `/tmp/`. Install guarded `EXIT`, `HUP`, `INT`, and `TERM` cleanup traps. Remove only that exact variable. Preserve a failing probe status when cleanup runs.
- The implementation repositories still exist. The source status was clean after the incident. The interrupted standalone files remain in the primary checkout.

## Current State

### Completed context only

- [x] **Task 1 — Port extension.** Commit `6a1be34` (`feat: port context paging extension`) imported the runtime, tests, benchmark, package manifest, lock file, license, and type-only `0.87.1` compatibility annotations. It used the approved `allowImportingTsExtensions` deviation. The review was clean.
- [x] **Task 2 — Public documentation.** Commit `d0193ba` (`docs: document context paging package`) added `README.md` and `docs/architecture.md`. The review was clean. This is the base `HEAD`.

The staging branch is `import-staging`. The plan branch starts at `d0193ba`. No GitHub repository, remote push, npm publication, tag, or release exists yet.

The package identity and supported interface are fixed:

- package: `@rochecompaan/pi-context-paging`
- initial version: `0.1.0`
- raw TypeScript entry point: `pi.extensions = ["./src/index.ts"]`
- default setting: `contextPaging.enabled = true`
- default token budget: `contextPaging.tokenBudget = 128000`
- recovery tools: `search_history`, `browse_history`, `load_history`, `read_context_output`

The package has no independent runtime dependencies. It declares `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` as `"*"` peer dependencies. Development dependencies remain exactly:

```json
{
  "@earendil-works/pi-agent-core": "0.87.1",
  "@earendil-works/pi-ai": "0.87.1",
  "@earendil-works/pi-coding-agent": "0.87.1",
  "@types/node": "24.19.0",
  "typebox": "1.3.34",
  "typescript": "5.9.3"
}
```

The primary checkout has an interrupted, uncommitted Task 3:

| File or change | State | Required Task 3 disposition |
| --- | --- | --- |
| `package.json` | Modified | Keep only the `check:package` and `check` scripts if the repaired smoke test passes. Otherwise remove both changes. |
| `scripts/toolset-probe.ts` | Untracked | Keep only if it remains the minimal real-Pi tool-registration probe. Otherwise remove it. |
| `scripts/smoke-packed-artifact.mjs` | Untracked | Keep only after the local-Pi resource failure has a documented root cause and this script passes. Otherwise replace or remove it. |
| `.gitignore` Devenv entries | Modified | Remove. Devenv is outside the approved scope. |
| `devenv.nix` | Untracked | Remove. It is unapproved template content outside scope. |
| `devenv.yaml` | Untracked | Remove. It is unapproved template content outside scope. |

The mandatory TDD evidence already obtained is:

1. `npm run check:package` failed because `scripts/smoke-packed-artifact.mjs` did not exist. This is the required RED for the new package-smoke command.
2. After the scripts were added, `npm run check:package` packed the artifact, then failed when `node_modules/.bin/pi` started.
3. The observed local Pi error reported the missing resource `/nix/store/ai9szyf9fivph9rdk65gzjiy30sll754-pi-0.87.1/libexec/pi/dist/modes/interactive/theme/dark.json`.
4. `npm ci` reproduced the failure. The global `/home/roche/.nix-profile/bin/pi` version `0.87.1` worked, but it is not an allowed smoke-test substitute.
5. Later inspection found that the store root exists and the npm package contains its own theme JSON files. The root cause remains unconfirmed.
6. This session observed `PI_PACKAGE_DIR=/nix/store/ai9szyf9fivph9rdk65gzjiy30sll754-pi-0.87.1/libexec/pi`. Its expected `dist/modes/interactive/theme/dark.json` file is missing. This is observed environment evidence, not a proven root cause.

There is no Task 3 report or Task 3 commit. `docs/release/0.1.0-verification.md` does not yet exist.

## Prerequisites

Run Task 3 through Task 5 from the standalone repository root. Set this variable before you run a task:

```sh
export PAGING_REPO="$PWD"
```

Before Task 3, make sure that these tools are available:

```sh
node --version
npm --version
git --version
tar --version
nix --version
gh --version
```

Use Node `>=22.19.0`. CI and releases use Node 24. Authenticate `gh` before Task 5. Authenticate npm with an account that can publish under `@rochecompaan` before Task 6.

## Resume Checklist

- [ ] Read this complete plan before editing the interrupted primary checkout.
- [ ] Record `git status --short`, `git diff -- .gitignore package.json`, and `find scripts -maxdepth 1 -type f -print` before changing interrupted files.
- [ ] Preserve the completed Task 1 and Task 2 contents and their approved compatibility annotations.
- [ ] Start Task 3 from the reproduced local-Pi failure. Do not guess a repair.
- [ ] Record Task 3 commands, results, and the root-cause report in `docs/release/0.1.0-verification.md`.
- [ ] Do not use the global Pi binary for `check:package`.
- [ ] Remove the unapproved Devenv files and ignore entries unless a user explicitly approves a scope change.
- [ ] Keep each Task 3 through Task 4 checkpoint commit local on `import-staging`.
- [ ] Complete the Task 5 one-root-commit, reviewer, and CI gates before Task 6.
- [ ] Complete the Task 6 npm trusted-publisher gate before Task 7 creates `v0.1.0`.

## Global Constraints

- Keep the existing extension behavior and its seven focused test files, including all 63 existing tests, unchanged unless a smoke-test repair requires a narrowly scoped test addition.
- Use `@earendil-works/*` imports. Do not restore `@mariozechner/*` imports.
- Keep `allowImportingTsExtensions` in `tsconfig.json`.
- Keep `"type": "module"`, Node `>=22.19.0`, the raw TypeScript Pi entry point, and the exact package identity.
- Include only `src/`, `docs/architecture.md`, `README.md`, and `LICENSE` in the npm artifact, plus npm-required `package.json`.
- Exclude tests, benchmarks, local agent state, workflow files, scripts, and development files from the tarball.
- CI runs `npm ci` and `npm run check` with read-only `contents` permission.
- Publishing uses GitHub Actions OIDC, `npm publish --provenance --access public`, and no npm token.
- The tag must equal `v${package.json.version}`. Never move a published tag. Publish a patch version if an artifact is defective.
- Do not add tests for workflow YAML, dependency versions, Nix literals, documentation text, or this plan text. Directly inspect those static files instead.
- Task 3 requires `superpowers:systematic-debugging`, `superpowers:test-driven-development`, and `superpowers:verification-before-completion`. Use direct syntax, package, and runtime checks for static configuration.
- `docs/release/0.1.0-verification.md` records pre-root Task 3-4 commands, results, and root-cause evidence. It remains outside the npm allowlist. After the root commit is pushed, GitHub workflow records, npm metadata and provenance, and the `v0.1.0` GitHub release body are the durable evidence. Never create or amend a repository commit after that push merely to record release evidence.
- After every independent review, any source, script, manifest, documentation, or workflow amendment requires the full relevant checks and another fresh independent review before push or tag. A prior review or unrelated CI run cannot satisfy that gate.

## File Map

- `scripts/toolset-probe.ts` — a temporary Pi extension that writes registered and active tool names.
- `scripts/smoke-packed-artifact.mjs` — packs the current package, validates the tarball allowlist, loads the packed extension with local Pi, and asserts all four tools.
- `package.json` — exposes `check:package` and `check`.
- `.github/workflows/ci.yml` — read-only CI for pull requests and `main`.
- `.github/workflows/publish.yml` — `v*` tag verification, OIDC npm publication, and GitHub release creation.
- `.gitignore` — retains only existing project ignore entries. It does not receive Devenv entries.
- `docs/release/0.1.0-verification.md` — committed pre-root evidence for Task 3-4 results and root-cause findings. Its post-root evidence policy names the immutable external records.

---

### Task 3: Finish packed-artifact and local-Pi runtime verification

**Required skills:** `superpowers:systematic-debugging`, `superpowers:test-driven-development`, and `superpowers:verification-before-completion`.

**Files:**
- Create: `docs/release/0.1.0-verification.md`
- Create or retain: `scripts/toolset-probe.ts`
- Create or retain: `scripts/smoke-packed-artifact.mjs`
- Modify: `package.json`
- Modify only if needed by dependency metadata: `package-lock.json`
- Modify: `.gitignore` only to remove interrupted Devenv entries
- Remove: `devenv.nix`
- Remove: `devenv.yaml`

**Consumes:** the Task 1 package manifest, tarball allowlist, raw TypeScript entry point, and four registered tools.

**Produces:** `npm run check:package`, `npm run check`, a passing packed-artifact real-Pi smoke test, and a root-cause report in the evidence file.

**Checkpoint commit:** `test: verify packed extension runtime`

- [ ] **Step 1: Capture the interrupted primary-checkout state before creating evidence.**

Run from the dirty primary standalone checkout, before `docs/release/0.1.0-verification.md` exists:

```sh
set -euo pipefail
cd "$PAGING_REPO"
git status --porcelain=v1 -uall
test "$(git status --porcelain=v1 -uall | wc -l)" -eq 6
git diff -- .gitignore package.json
find scripts -maxdepth 1 -type f -print
```

Expected: `git status --porcelain=v1 -uall` reports exactly six file entries: modified `.gitignore` and `package.json`, untracked `scripts/toolset-probe.ts` and `scripts/smoke-packed-artifact.mjs`, plus untracked `devenv.nix` and `devenv.yaml`. Stop if any entry differs.

- [ ] **Step 2: Create the durable pre-root evidence file.**

Create `docs/release/0.1.0-verification.md` with this content. First append the Step 1 command and its six-entry result summary.

```markdown
# v0.1.0 Verification Evidence

This file records the local verification evidence that exists before the public root commit.

After the root commit is pushed, immutable GitHub Actions records, npm metadata and provenance, and the `v0.1.0` GitHub release body record release evidence. Do not add or amend a repository commit after that push only to update this file.
```

Expected: the file is repository-relative and absent from the npm artifact because `package.json` lists only `docs/architecture.md` from `docs/`.

- [ ] **Step 3: Reproduce the known failure through the local dependency.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
npm ci
npm run check:package 2>&1 | tee /tmp/pi-context-paging-check-package.log
```

Expected: `npm pack` succeeds, then `./node_modules/.bin/pi` fails before the probe writes JSON. Preserve the exact missing-resource error in the evidence file. Stop if the failure changes to an extension-load error, a module-resolution error, or a tarball allowlist mismatch. Investigate that observed failure instead.

- [ ] **Step 4: Gather resource and environment evidence before the first hypothesis.**

Run this evidence collection. It does not start the global Pi binary:

```sh
set -euo pipefail
cd "$PAGING_REPO"
local_pi=$(readlink -f node_modules/.bin/pi)
local_pi_root=$(cd "$(dirname "$local_pi")/../.." && pwd)
printf 'local_pi=%s\nlocal_pi_root=%s\n' "$local_pi" "$local_pi_root"
printf 'PI_PACKAGE_DIR=%s\n' "${PI_PACKAGE_DIR-<unset>}"
node -e 'const p = require(process.argv[1]); console.log(JSON.stringify({ name: p.name, version: p.version, bin: p.bin, files: p.files }, null, 2));' "$local_pi_root/package.json"
find "$local_pi_root/dist" -path '*modes/interactive/theme/dark.json' -print
if [ -n "${PI_PACKAGE_DIR-}" ]; then
  test -d "$PI_PACKAGE_DIR"
  test ! -e "$PI_PACKAGE_DIR/dist/modes/interactive/theme/dark.json"
fi
rg -n '/nix/store|PI_PACKAGE_DIR|dark\.json|theme/dark|fileURLToPath|createRequire' "$local_pi_root/dist" --glob '!**/*.map' || true
printf '\n--- exact smoke error ---\n'
tail -n 80 /tmp/pi-context-paging-check-package.log
```

Expected: the output records the local executable, package resource location, `PI_PACKAGE_DIR` value, and missing file under that value. This is observed evidence. It does not prove that `PI_PACKAGE_DIR` causes the resource resolution.

- [ ] **Step 5: Inspect precedence and run one-variable experiment.**

Inspect the local CLI and installed package. Do not start the global Pi binary:

```sh
set -euo pipefail
cd "$PAGING_REPO"
local_pi=$(readlink -f node_modules/.bin/pi)
local_pi_root=$(cd "$(dirname "$local_pi")/../.." && pwd)
sed -n '1,120p' "$local_pi"
sed -n '1,120p' "$local_pi_root/dist/bundle/cli-runtime.js"
rg -n -C 3 'PI_PACKAGE_DIR|process\.env|package.*dir|dark\.json|theme/dark' "$local_pi_root/dist" --glob '!**/*.map' || true
find "$local_pi_root" -type l -printf '%p -> %l\n' | sort
```

Only if this inspection proves that `PI_PACKAGE_DIR` takes precedence over the npm package resource path, run this smallest one-variable experiment:

```sh
set -euo pipefail
cd "$PAGING_REPO"
env -u PI_PACKAGE_DIR npm run check:package 2>&1 | tee /tmp/pi-context-paging-check-package-without-pi-package-dir.log
```

Expected: the experiment changes only `PI_PACKAGE_DIR`. Record the exact command, result, and conclusion in the evidence file. Do not adopt `env -u PI_PACKAGE_DIR` as the smoke-script repair unless this experiment proves the hypothesis. If inspection does not prove precedence, stop and continue systematic tracing from the observed component boundary.

- [ ] **Step 6: Apply only the proven repair and define GREEN.**

Keep the initial missing-script RED and the runtime RED in `docs/release/0.1.0-verification.md`. Add or retain this minimal probe:

```ts
// scripts/toolset-probe.ts
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function toolsetProbe(pi: ExtensionAPI): void {
  pi.registerCommand("write-toolset-probe", {
    description: "Write registered and active tools for package verification",
    handler: async () => {
      const output = process.env.PI_TOOLSET_PROBE_OUTPUT;
      if (!output) throw new Error("PI_TOOLSET_PROBE_OUTPUT is required");
      writeFileSync(output, JSON.stringify({
        all: pi.getAllTools().map((tool) => tool.name).sort(),
        active: pi.getActiveTools().sort(),
      }));
    },
  });
}
```

Implement only the repair that Step 5 proved. The final smoke script must pack the artifact, assert this exact allowlist, extract it, start `./node_modules/.bin/pi`, load the extracted `package` with `-e`, load `scripts/toolset-probe.ts` with `--extension`, and invoke `-p /write-toolset-probe`:

```text
LICENSE
README.md
docs/architecture.md
package.json
src/context-policy.ts
src/history.ts
src/index.ts
src/navigator.ts
src/output-pages.ts
src/tools.ts
```

The smoke script must run the local Pi invocation with a guarded temporary home. Use this shell-equivalent cleanup structure. Preserve an original command failure. Do not hide a cleanup failure after a successful probe:

```sh
set -euo pipefail
tmp_home=$(mktemp -d /tmp/pi-context-paging-home.XXXXXX)
test -n "$tmp_home"
case "$tmp_home" in /tmp/*) ;; *) exit 1 ;; esac
cleanup() {
  status=${1:-$?}
  trap - EXIT HUP INT TERM
  cleanup_status=0
  if [ -n "${tmp_home-}" ]; then
    case "$tmp_home" in /tmp/*) rm -rf -- "$tmp_home" || cleanup_status=$? ;; *) cleanup_status=1 ;; esac
  fi
  if [ "$status" -ne 0 ]; then exit "$status"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM
HOME="$tmp_home" ./node_modules/.bin/pi --version
```

GREEN means the local Pi command exits zero and the probe JSON parses. Both `all` and `active` contain `search_history`, `browse_history`, `load_history`, and `read_context_output`. The command must not reach or require a provider stage.

- [ ] **Step 7: Run the complete package gate and append results.**

Set these `package.json` scripts exactly:

```json
{
  "check:package": "node scripts/smoke-packed-artifact.mjs",
  "check": "npm run typecheck && npm test && npm run check:package"
}
```

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
npm install --package-lock-only
npm run check:package
npm run check
git diff --check
```

Expected: `check:package` exits zero, reports a verified tarball, and produces valid probe JSON with all four tools in both lists. Type checking and all 63 tests pass. Append concise commands, results, the proven root cause, and repair evidence to `docs/release/0.1.0-verification.md`.

- [ ] **Step 8: Apply interrupted-file dispositions and commit the evidence.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
git restore --source=HEAD -- .gitignore
rm -f -- devenv.nix devenv.yaml
git add package.json package-lock.json scripts/toolset-probe.ts scripts/smoke-packed-artifact.mjs .gitignore docs/release/0.1.0-verification.md
git diff --cached --check
git commit -m "test: verify packed extension runtime"
test -z "$(git status --short)"
```

Expected: the commit contains the accepted smoke implementation and the Task 3 evidence. It contains no Devenv file or Devenv ignore rule. Stop if the evidence file omits the root-cause conclusion or the GREEN result.


### Task 4: Add CI and tag-driven trusted publishing

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/publish.yml`
- Modify: `docs/release/0.1.0-verification.md`

**Consumes:** `npm run check` from Task 3.

**Produces:** read-only CI for pull requests and `main`, plus OIDC publication and GitHub releases for `v*` tags.

**Checkpoint commit:** `ci: publish verified package tags`

- [ ] **Step 1: Create the read-only CI workflow.**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v6

      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Check package
        run: npm run check
```

Expected: CI has no write, token, or publication permission.

- [ ] **Step 2: Create the tag-driven publish workflow.**

Create `.github/workflows/publish.yml`:

```yaml
name: Publish

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v6

      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          package-manager-cache: false

      - name: Match tag and package versions
        env:
          RELEASE_TAG: ${{ github.ref_name }}
        run: |
          set -euo pipefail
          node <<'NODE'
          const packageJson = require("./package.json");
          const expected = `v${packageJson.version}`;
          if (process.env.RELEASE_TAG !== expected) {
            throw new Error(`tag ${process.env.RELEASE_TAG} does not match ${expected}`);
          }
          NODE

      - name: Install dependencies
        run: npm ci

      - name: Check package
        run: npm run check

      - name: Publish to npm when absent
        run: |
          set -euo pipefail
          package_name=$(node -p 'require("./package.json").name')
          package_version=$(node -p 'require("./package.json").version')
          if npm view "$package_name@$package_version" version >/dev/null 2>&1; then
            echo "$package_name@$package_version is already published"
          else
            npm publish --provenance --access public
          fi

      - name: Create GitHub release when absent
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
            echo "$GITHUB_REF_NAME release already exists"
          else
            gh release create "$GITHUB_REF_NAME" \
              --verify-tag \
              --generate-notes \
              --title "$GITHUB_REF_NAME"
          fi
```

Expected: the workflow filename is exactly `publish.yml`. It disables package-manager caching and has only `contents: write` and `id-token: write` permissions. It stores no npm token.

- [ ] **Step 3: Validate the static workflows directly.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
nix run nixpkgs#actionlint -- .github/workflows/ci.yml .github/workflows/publish.yml
npm run check
git diff --check
```

Append the actionlint and `npm run check` commands and results to `docs/release/0.1.0-verification.md` before Step 4.

Expected: `actionlint`, the local package check, and whitespace validation pass. Do not add a test that reads workflow YAML.

- [ ] **Step 4: Commit the workflow checkpoint.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
git add .github/workflows/ci.yml .github/workflows/publish.yml docs/release/0.1.0-verification.md
git commit -m "ci: publish verified package tags"
git status --short
```

Expected: the worktree is clean. Do not push the staging branch.

### Task 5: Replace staging history with one import commit and create the public repository

**Files:**
- Verify: every tracked repository file

**Consumes:** the clean local Task 1 through Task 4 staging checkpoints, including their committed pre-root evidence file.

**Produces:** a public `main` branch with exactly one root commit and a successful CI run for that exact commit.

**Does not produce:** an npm publication or a release tag.

**Checkpoint commit:** root commit `feat: publish context paging extension`

- [ ] **Step 1: Run the full local pre-publication gate from a clean staging tree.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
npm ci
npm run check
npm run bench
nix run nixpkgs#actionlint -- .github/workflows/*.yml
git diff --check
test -z "$(git status --short)"
```

Expected: all commands pass and the staging worktree is clean. Task 3 and Task 4 already committed their evidence-file updates. Do not edit `docs/release/0.1.0-verification.md` in Task 5.

- [ ] **Step 2: Create the one-root-commit `main` branch from the complete clean tree.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
git checkout --orphan squashed-main
git add -A
git commit -m "feat: publish context paging extension"
git branch -D import-staging
git branch -m main
test "$(git rev-list --count HEAD)" -eq 1
test -z "$(git status --short)"
git log --oneline --decorate
```

Expected: `main` has one root commit. The committed Task 3-4 evidence file is inside this root snapshot. No staging history is pushed.

- [ ] **Step 3: Review the exact root commit and close the review loop without an evidence-file edit.**

Request the canonical fresh reviewer for the current standalone checkout. This committed plan is the sole requirements authority. The reviewer can also read repository-relative `README.md` and `docs/architecture.md`. Do not give the reviewer an external extraction design document.

Give the reviewer base `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, head `git rev-parse HEAD`, and this checklist:

- package identity `@rochecompaan/pi-context-paging`, version `0.1.0`, raw TypeScript entry `pi.extensions = ["./src/index.ts"]`, settings `contextPaging.enabled` and `contextPaging.tokenBudget`, and exactly `search_history`, `browse_history`, `load_history`, and `read_context_output`;
- no behavior change; seven focused test files and all 63 preserved tests;
- no independent runtime dependency, JavaScript library API, or command-line interface;
- exact tarball allowlist: `LICENSE`, `README.md`, `docs/architecture.md`, `package.json`, and the six listed `src/*.ts` files;
- extension trust warning, trusted-project settings behavior, and storage/error isolation remain documented;
- OIDC trusted publishing uses `publish.yml`, `npm publish --provenance --access public`, and no npm token;
- one-root public history before `v0.1.0`;
- local Pi packed-artifact probe exits zero and reports all four tools in both `all` and `active`.

If the reviewer requires a repository change, apply the smallest correction, run all relevant checks, amend the root commit, make sure that it remains one commit and clean, and request a fresh reviewer review of the new exact `HEAD`:

```sh
set -euo pipefail
cd "$PAGING_REPO"
npm run check
npm run bench
nix run nixpkgs#actionlint -- .github/workflows/*.yml
git diff --check
git add -A
git commit --amend --no-edit
test "$(git rev-list --count HEAD)" -eq 1
test -z "$(git status --short)"
```

Repeat this step until the reviewer has no unresolved Important or Critical finding for the exact root SHA. Retain the final reviewer run or reference for Task 7. Do not change any repository file after that approval and before the initial push. The Task 7 GitHub release body records the final reviewer reference and post-root evidence.

- [ ] **Step 4: Create and push the public GitHub repository.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
gh repo create rochecompaan/pi-context-paging \
  --public \
  --source=. \
  --remote=origin \
  --push \
  --description="Bounded rolling context and exact history recovery for Pi"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

Expected: the repository is public, `origin` points to `rochecompaan/pi-context-paging`, and pushed `main` equals local `HEAD`. This is the first allowed repository creation and push.

- [ ] **Step 5: Wait for CI and bind it to the pushed head.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
head_sha=$(git rev-parse HEAD)
ci_run_id=""
for _attempt in $(seq 1 20); do
  ci_json=$(gh run list \
    --repo rochecompaan/pi-context-paging \
    --workflow CI \
    --commit "$head_sha" \
    --limit 1 \
    --json databaseId,headSha,conclusion,url)
  ci_run_id=$(printf '%s' "$ci_json" | jq -r '.[0].databaseId')
  test "$ci_run_id" != "null" && break
  sleep 3
done
test -n "$ci_run_id"
test "$ci_run_id" != "null"
ci_head_sha=$(printf '%s' "$ci_json" | jq -r '.[0].headSha')
test "$ci_head_sha" = "$head_sha"
gh run watch "$ci_run_id" --repo rochecompaan/pi-context-paging --exit-status
ci_result=$(gh run view "$ci_run_id" --repo rochecompaan/pi-context-paging --json conclusion,headSha,url)
test "$(printf '%s' "$ci_result" | jq -r '.conclusion')" = "success"
test "$(printf '%s' "$ci_result" | jq -r '.headSha')" = "$head_sha"
git fetch origin main
test "$head_sha" = "$(git rev-parse origin/main)"
```

Expected: the successful CI record has `headSha == HEAD == origin/main`. Preserve its URL for the Task 7 GitHub release body. Do not amend the repository merely to add this post-root evidence.

If CI fails before a release exists, inspect the failed log. Then complete the repair sequence below.

- [ ] **Step 5a: Correct and amend the failed exact root without pushing.**

After the smallest root-cause correction from its failing reproduction, run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
gh run view "$ci_run_id" --repo rochecompaan/pi-context-paging --log-failed
npm run check
npm run bench
nix run nixpkgs#actionlint -- .github/workflows/*.yml
git diff --check
git add -A
git commit --amend --no-edit
test "$(git rev-list --count HEAD)" -eq 1
test -z "$(git status --short)"
git rev-parse HEAD
```

Expected: the amended root is clean and remains one commit. Stop here. Do not force-push.

- [ ] **Step 5b: Review the amended exact root before force-pushing.**

Request the canonical fresh reviewer for the `git rev-parse HEAD` value from Step 5a. Give it the same Task 5 Step 3 checklist. Resolve every Important or Critical finding with the Step 5a sequence, then request another fresh review of the new exact root SHA. Only after the reviewer approves this exact `HEAD`, run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
test "$(git rev-list --count HEAD)" -eq 1
test -z "$(git status --short)"
git push --force-with-lease origin main
```

Then rerun Task 5 Step 5 from its first command. The new successful CI run must have `headSha == origin/main == HEAD`. Do not use a prior review, a prior CI run, or an unrelated latest run to satisfy this gate. Do not force-push after `v0.1.0` exists.

- [ ] **Step 6: Verify the public repository state.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
test "$(git rev-list --count origin/main)" -eq 1
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
gh repo view rochecompaan/pi-context-paging \
  --json nameWithOwner,visibility,defaultBranchRef,url \
  --jq '{nameWithOwner, visibility, defaultBranch: .defaultBranchRef.name, url}'
```

Expected: the repository is public, its default branch is `main`, and remote history contains one root commit. Do not create `v0.1.0` in this task.


### Task 6: Bootstrap npm trusted publishing

**Files:**
- Read: `docs/release/0.1.0-verification.md`
- Create temporarily outside this repository: a minimal `0.0.0` npm package
- Configure externally: npm trusted publisher for `.github/workflows/publish.yml`

**Consumes:** the public repository and the Task 5 CI result bound to `origin/main`.

**Produces:** a deprecated `@rochecompaan/pi-context-paging@0.0.0` reservation and the GitHub Actions OIDC trust relation.

**Durable evidence:** Task 7 appends npm bootstrap metadata to the `v0.1.0` GitHub release body. Do not create or amend a repository commit after the root push to record it.

- [ ] **Step 1: Confirm npm authority and package absence.**

Run interactively:

```sh
set -euo pipefail
npm whoami
npm view @rochecompaan/pi-context-paging version
```

Expected: `npm whoami` identifies an account authorized for the `@rochecompaan` scope. The package query returns `E404`. Stop if an unexpected package owns the name.

- [ ] **Step 2: Create, publish, deprecate, and remove the bootstrap package safely.**

Run interactively:

```sh
set -euo pipefail
bootstrap_dir=$(mktemp -d /tmp/pi-context-paging-npm-bootstrap.XXXXXX)
test -n "$bootstrap_dir"
case "$bootstrap_dir" in /tmp/*) ;; *) exit 1 ;; esac
cleanup() {
  status=${1:-$?}
  trap - EXIT HUP INT TERM
  cleanup_status=0
  case "$bootstrap_dir" in /tmp/*) rm -rf -- "$bootstrap_dir" || cleanup_status=$? ;; *) cleanup_status=1 ;; esac
  if [ "$status" -ne 0 ]; then exit "$status"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM
cat > "$bootstrap_dir/package.json" <<'JSON'
{
  "name": "@rochecompaan/pi-context-paging",
  "version": "0.0.0",
  "description": "Bootstrap placeholder for pi-context-paging trusted publishing",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/rochecompaan/pi-context-paging.git"
  },
  "publishConfig": {
    "access": "public"
  }
}
JSON
cat > "$bootstrap_dir/README.md" <<'MARKDOWN'
# Bootstrap placeholder

This version exists only to configure npm trusted publishing.
Install version 0.1.0 or later.
MARKDOWN
npm publish --access public --prefix "$bootstrap_dir"
npm deprecate \
  "@rochecompaan/pi-context-paging@0.0.0" \
  "Bootstrap-only placeholder. Install version 0.1.0 or later."
npm view @rochecompaan/pi-context-paging@0.0.0 version deprecated repository --json
```

Expected: npm publishes and deprecates `0.0.0`. The guarded trap removes only `bootstrap_dir` even when a command fails. Preserve the command output for the Task 7 release body.

- [ ] **Step 3: Configure and verify npm trusted publishing.**

In the npm package settings, add a GitHub Actions trusted publisher with these exact fields:

```text
Organization or user: rochecompaan
Repository: pi-context-paging
Workflow filename: publish.yml
Environment: none
Allowed action: npm publish
```

Expected: npm saves the configuration. This is a required human checkpoint. Stop and obtain user confirmation if npm cannot display or save these exact values. Do not create or push `v0.1.0` before this gate passes.

### Task 7: Publish and verify `v0.1.0`

**Files and artifacts:**
- Read: `docs/release/0.1.0-verification.md`
- Create: immutable Git tag `v0.1.0`
- Create: GitHub release `v0.1.0`, including the durable post-root evidence body
- Publish: `@rochecompaan/pi-context-paging@0.1.0` with provenance

**Consumes:** the Task 5 CI result for exact `origin/main`, the confirmed Task 6 trusted publisher, and the pre-root evidence file.

**Produces:** the first supported immutable npm and GitHub release.

**Checkpoint:** `v0.1.0` exists in GitHub and npm. The release body records the root/tag SHA, verified CI and publish runs, npm evidence, tool probe result, and review summary.

- [ ] **Step 1: Run the release preflight.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
head_sha=$(git rev-parse HEAD)
test "$(node -p 'require("./package.json").version')" = "0.1.0"
test "$(git rev-list --count HEAD)" -eq 1
test -z "$(git status --short)"
git fetch origin main --tags
test "$head_sha" = "$(git rev-parse origin/main)"
! git rev-parse -q --verify refs/tags/v0.1.0 >/dev/null
! git ls-remote --exit-code --tags origin refs/tags/v0.1.0 >/dev/null 2>&1
if npm view @rochecompaan/pi-context-paging@0.1.0 version >/dev/null 2>&1; then
  echo "version 0.1.0 is already published" >&2
  exit 1
fi
npm ci
npm run check
ci_json=$(gh run list \
  --repo rochecompaan/pi-context-paging \
  --workflow CI \
  --commit "$head_sha" \
  --limit 1 \
  --json databaseId,headSha,conclusion,url)
ci_run_id=$(printf '%s' "$ci_json" | jq -r '.[0].databaseId')
ci_head_sha=$(printf '%s' "$ci_json" | jq -r '.[0].headSha')
ci_conclusion=$(printf '%s' "$ci_json" | jq -r '.[0].conclusion')
test -n "$ci_run_id"
test "$ci_conclusion" = "success"
test "$ci_head_sha" = "$head_sha"
test "$head_sha" = "$(git rev-parse origin/main)"
```

Expected: `HEAD == origin/main`, both tag names are absent, and the successful `main` CI run has `headSha == HEAD`. Stop if any condition fails. A source, script, manifest, documentation, or workflow amendment after this review requires the full relevant checks and a fresh independent review before a push or tag.

- [ ] **Step 2: Create, verify, and push the immutable annotated tag.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
head_sha=$(git rev-parse HEAD)
git tag -a v0.1.0 -m "Release v0.1.0"
test "$(git rev-parse v0.1.0^{commit})" = "$head_sha"
git push origin v0.1.0
```

Expected: the local annotated tag resolves to `HEAD` before push. GitHub starts the `Publish` workflow. Never move this tag.

- [ ] **Step 3: Watch and bind the publish workflow to the release head.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
head_sha=$(git rev-parse HEAD)
publish_run_id=""
for _attempt in $(seq 1 20); do
  publish_json=$(gh run list \
    --repo rochecompaan/pi-context-paging \
    --workflow Publish \
    --commit "$head_sha" \
    --limit 1 \
    --json databaseId,headSha,conclusion,url)
  publish_run_id=$(printf '%s' "$publish_json" | jq -r '.[0].databaseId')
  test "$publish_run_id" != "null" && break
  sleep 3
done
test -n "$publish_run_id"
test "$publish_run_id" != "null"
gh run watch "$publish_run_id" --repo rochecompaan/pi-context-paging --exit-status
publish_result=$(gh run view "$publish_run_id" --repo rochecompaan/pi-context-paging --json conclusion,headSha,url)
test "$(printf '%s' "$publish_result" | jq -r '.conclusion')" = "success"
test "$(printf '%s' "$publish_result" | jq -r '.headSha')" = "$head_sha"
```

Expected: the workflow verifies, publishes with OIDC provenance, and creates the GitHub release. If it fails, inspect only failed logs and stop before changing source. Do not move the tag. A rerun can use the same immutable tag only when its source is correct. A published artifact defect requires a new patch version.

- [ ] **Step 4: Verify metadata, probe the published package, and update durable release evidence.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
head_sha=$(git rev-parse HEAD)
ci_json=$(gh run list \
  --repo rochecompaan/pi-context-paging \
  --workflow CI \
  --commit "$head_sha" \
  --limit 1 \
  --json databaseId,headSha,conclusion,url)
ci_run_id=$(printf '%s' "$ci_json" | jq -r '.[0].databaseId')
ci_result=$(gh run view "$ci_run_id" --repo rochecompaan/pi-context-paging --json conclusion,headSha,url)
test "$(printf '%s' "$ci_result" | jq -r '.conclusion')" = "success"
test "$(printf '%s' "$ci_result" | jq -r '.headSha')" = "$head_sha"
publish_json=$(gh run list \
  --repo rochecompaan/pi-context-paging \
  --workflow Publish \
  --commit "$head_sha" \
  --limit 1 \
  --json databaseId,headSha,conclusion,url)
publish_run_id=$(printf '%s' "$publish_json" | jq -r '.[0].databaseId')
publish_result=$(gh run view "$publish_run_id" --repo rochecompaan/pi-context-paging --json conclusion,headSha,url)
test "$(printf '%s' "$publish_result" | jq -r '.conclusion')" = "success"
test "$(printf '%s' "$publish_result" | jq -r '.headSha')" = "$head_sha"
final_review_reference=${FINAL_REVIEW_REFERENCE:?Set FINAL_REVIEW_REFERENCE to the final canonical reviewer run or reference for this exact root SHA.}
release_metadata=$(gh release view v0.1.0 --repo rochecompaan/pi-context-paging --json tagName,isDraft,isPrerelease,url)
node - "$release_metadata" <<'NODE'
const release = JSON.parse(process.argv[2]);
if (release.tagName !== "v0.1.0") throw new Error(`unexpected release tag: ${release.tagName}`);
if (release.isDraft !== false) throw new Error("release is a draft");
if (release.isPrerelease !== false) throw new Error("release is a prerelease");
if (typeof release.url !== "string" || release.url.length === 0) throw new Error("release URL is empty");
NODE
npm_metadata=$(npm view @rochecompaan/pi-context-paging@0.1.0 \
  name version license repository dist --json)
node - "$npm_metadata" <<'NODE'
const pkg = JSON.parse(process.argv[2]);
const expectedRepository = "git+https://github.com/rochecompaan/pi-context-paging.git";
if (pkg.name !== "@rochecompaan/pi-context-paging") throw new Error(`unexpected package name: ${pkg.name}`);
if (pkg.version !== "0.1.0") throw new Error(`unexpected package version: ${pkg.version}`);
if (pkg.license !== "MIT") throw new Error(`unexpected license: ${pkg.license}`);
if (pkg.repository?.url !== expectedRepository) throw new Error(`unexpected repository URL: ${pkg.repository?.url}`);
if (typeof pkg.dist?.integrity !== "string" || pkg.dist.integrity.length === 0) throw new Error("dist.integrity is empty");
const attestations = pkg.dist?.attestations;
if (!attestations || JSON.stringify(attestations).length <= 2) throw new Error("dist.attestations is empty");
NODE
bootstrap_metadata=$(npm view @rochecompaan/pi-context-paging@0.0.0 \
  version deprecated repository --json)
tmp_home=$(mktemp -d /tmp/pi-context-paging-release-home.XXXXXX)
test -n "$tmp_home"
case "$tmp_home" in /tmp/*) ;; *) exit 1 ;; esac
release_body=$(mktemp /tmp/pi-context-paging-release-body.XXXXXX)
cleanup() {
  status=${1:-$?}
  trap - EXIT HUP INT TERM
  cleanup_status=0
  case "$tmp_home" in /tmp/*) rm -rf -- "$tmp_home" || cleanup_status=$? ;; *) cleanup_status=1 ;; esac
  case "$release_body" in /tmp/*) rm -f -- "$release_body" || cleanup_status=$? ;; *) cleanup_status=1 ;; esac
  if [ "$status" -ne 0 ]; then exit "$status"; fi
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'cleanup 129' HUP
trap 'cleanup 130' INT
trap 'cleanup 143' TERM
HOME="$tmp_home" ./node_modules/.bin/pi install npm:@rochecompaan/pi-context-paging@0.1.0
HOME="$tmp_home" PI_TOOLSET_PROBE_OUTPUT="$tmp_home/tools.json" \
  ./node_modules/.bin/pi --no-session --no-builtin-tools \
  --extension scripts/toolset-probe.ts -p /write-toolset-probe
node - "$tmp_home/tools.json" <<'NODE'
const fs = require("node:fs");
const tools = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const name of ["search_history", "browse_history", "load_history", "read_context_output"]) {
  if (!tools.all.includes(name) || !tools.active.includes(name)) {
    throw new Error(`${name} is missing from the published package`);
  }
}
NODE
gh release view v0.1.0 --repo rochecompaan/pi-context-paging --json body --jq .body > "$release_body"
cat >> "$release_body" <<EOF

## Verification evidence

- Root and tag commit: $head_sha
- Main CI: $(printf '%s' "$ci_result" | jq -r '.url') (head SHA $(printf '%s' "$ci_result" | jq -r '.headSha'))
- Publish workflow: $(printf '%s' "$publish_result" | jq -r '.url') (head SHA $(printf '%s' "$publish_result" | jq -r '.headSha'))
- npm bootstrap metadata: $bootstrap_metadata
- npm v0.1.0 metadata and provenance: $npm_metadata
- Published-package tool probe: exit zero; all and active contained search_history, browse_history, load_history, and read_context_output.
- Final exact-root review: $final_review_reference
- Review summary: docs/release/0.1.0-verification.md records the pre-root Task 3-4 evidence. The final canonical reviewer had no unresolved Important or Critical finding.
EOF
gh release edit v0.1.0 --repo rochecompaan/pi-context-paging --notes-file "$release_body"
```

Expected: GitHub release metadata, npm metadata and provenance, and the clean-home probe pass. The release body contains all listed durable evidence. The cleanup trap removes only its guarded `/tmp/` paths. The release is incomplete if the body update or any verification fails.

- [ ] **Step 5: Run the final immutable-artifact gate.**

Run:

```sh
set -euo pipefail
cd "$PAGING_REPO"
test -z "$(git status --short)"
test "$(git rev-list --count origin/main)" -eq 1
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(git rev-parse v0.1.0^{commit})" = "$(git rev-parse HEAD)"
release_metadata=$(gh release view v0.1.0 --repo rochecompaan/pi-context-paging --json tagName,isDraft,isPrerelease,url,body)
node - "$release_metadata" <<'NODE'
const release = JSON.parse(process.argv[2]);
if (release.tagName !== "v0.1.0" || release.isDraft !== false || release.isPrerelease !== false) throw new Error("release metadata is incorrect");
if (typeof release.url !== "string" || release.url.length === 0) throw new Error("release URL is empty");
if (typeof release.body !== "string" || !release.body.includes("## Verification evidence")) throw new Error("release evidence body is absent");
NODE
npm_metadata=$(npm view @rochecompaan/pi-context-paging@0.1.0 \
  name version license repository dist --json)
node - "$npm_metadata" <<'NODE'
const pkg = JSON.parse(process.argv[2]);
if (pkg.name !== "@rochecompaan/pi-context-paging" || pkg.version !== "0.1.0" || pkg.license !== "MIT") throw new Error("npm package identity metadata is incorrect");
if (pkg.repository?.url !== "git+https://github.com/rochecompaan/pi-context-paging.git") throw new Error("npm repository URL is incorrect");
if (typeof pkg.dist?.integrity !== "string" || pkg.dist.integrity.length === 0) throw new Error("dist.integrity is empty");
if (!pkg.dist?.attestations || JSON.stringify(pkg.dist.attestations).length <= 2) throw new Error("dist.attestations is empty");
NODE
printf '%s\n' "$npm_metadata"
```

Expected: the worktree is clean, public `main` has one root commit, the immutable tag resolves to it, npm shows provenance, and the release body contains the durable evidence. Do not change `roche-pi` before this gate passes.

## External roche-pi Handoff — Non-executable from this plan

**Status:** This section summarizes original Tasks 8 and 9. Do not run these steps from this standalone plan. Use a separately approved `roche-pi` execution plan after Task 7 passes.

**Prerequisites:**

- `rochecompaan/pi-context-paging` is public, one-root-commit, and its `main` CI passes.
- `@rochecompaan/pi-context-paging@0.1.0` is published with provenance.
- GitHub `v0.1.0` exists.
- A clean Pi home installed the published package and registered all four recovery tools.
- The immutable commit behind `v0.1.0` is available for Nix pinning.

### External Task 8: Replace the in-tree source with an immutable Nix source package

**Affected roche-pi areas:**

- Create `nix/packages/pi-context-paging.nix`.
- Create `modules/packages/pi-context-paging.nix`.
- Modify `modules/packages/pi-config.nix`.
- Remove `extensions/context-paging/` only after the public release gates pass.
- Preserve current `settings.json` values.

**Required implementation outcome:** A Nix source package fetches the exact GitHub commit behind `v0.1.0` with a fixed SRI hash. It copies `src`, `docs`, `package.json`, `README.md`, and `LICENSE` without npm installation. `packages.pi-context-paging` exposes it. `pi-config` links `${piContextPaging}/src` to `$out/extensions/context-paging`. It removes the old copy-and-clean logic and has no local-path fallback or duplicate implementation.

**Acceptance evidence:**

```sh
nix build .#packages.x86_64-linux.pi-context-paging --no-link
nix build .#packages.x86_64-linux.pi-config --no-link
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

The package output contains `src/`. The `pi-config` link resolves to that source. The extension-load check registers all four tools.

### External Task 9: Mark historical roche-pi documents

**Affected roche-pi areas:**

- `docs/plans/2026-02-25-context-paging-performance-fix.md`
- `docs/plans/2026-09-21-context-paging.md`
- `docs/plans/2026-09-24-context-paging-token-budget.md`
- `docs/specs/2026-09-21-context-paging-design.md`
- `docs/specs/2026-09-24-context-paging-token-budget-design.md`

**Required implementation outcome:** Add a short historical-record notice after each top-level heading. The notice links to `https://github.com/rochecompaan/pi-context-paging` and states that paths under `extensions/context-paging/` describe the pre-extraction layout. Preserve all original content and commit references.

**Acceptance evidence:** Directly inspect all five notices, run `git diff --check`, and retain the Task 8 Nix and runtime evidence. Do not add automated tests for documentation text.

## Final Standalone Completion Gate

Before claiming standalone release completion, make sure that:

```sh
set -euo pipefail
cd "$PAGING_REPO"
test -z "$(git status --short)"
test "$(git rev-list --count origin/main)" -eq 1
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(git rev-parse v0.1.0^{commit})" = "$(git rev-parse HEAD)"
release_metadata=$(gh release view v0.1.0 --repo rochecompaan/pi-context-paging --json tagName,isDraft,isPrerelease,url,body)
node - "$release_metadata" <<'NODE'
const release = JSON.parse(process.argv[2]);
if (release.tagName !== "v0.1.0" || release.isDraft !== false || release.isPrerelease !== false) throw new Error("release metadata is incorrect");
if (typeof release.url !== "string" || release.url.length === 0) throw new Error("release URL is empty");
if (typeof release.body !== "string" || !release.body.includes("## Verification evidence")) throw new Error("release evidence body is absent");
NODE
npm_metadata=$(npm view @rochecompaan/pi-context-paging@0.1.0 \
  name version license repository dist --json)
node - "$npm_metadata" <<'NODE'
const pkg = JSON.parse(process.argv[2]);
if (pkg.name !== "@rochecompaan/pi-context-paging" || pkg.version !== "0.1.0" || pkg.license !== "MIT") throw new Error("npm package identity metadata is incorrect");
if (pkg.repository?.url !== "git+https://github.com/rochecompaan/pi-context-paging.git") throw new Error("npm repository URL is incorrect");
if (typeof pkg.dist?.integrity !== "string" || pkg.dist.integrity.length === 0) throw new Error("dist.integrity is empty");
if (!pkg.dist?.attestations || JSON.stringify(pkg.dist.attestations).length <= 2) throw new Error("dist.attestations is empty");
NODE
printf '%s\n' "$npm_metadata"
```

Expected: the worktree is clean, public `main` has one commit, npm shows `0.1.0` with provenance, and GitHub shows a published release. The external `roche-pi` work remains outside this plan.
