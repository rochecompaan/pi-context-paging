# Stable Cut Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the user-approved Native execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve an ordinary outgoing request's prefix until its retained token estimate crosses the budget, then move its cut forward toward the target.

**Architecture:** Keep validation, calibrated accounting, grouping, and FIFO selection in the existing policy. Add a small cut-state module for stable history keys and transactional state, plus a pure settings module. The extension entry module handles lifecycle resets, warnings, successful commits, and accounting calls.

**Tech Stack:** TypeScript, the existing Pi SDK dependencies, Node's test runner with type stripping, and the existing packed-artifact check. No new runtime dependencies.

**Spec:** `docs/specs/2026-10-03-stable-cut-point-design.md`. The original R, C, and V approval is recorded at `d74c106`.
The user approved the custom-turn, backward-snap, and incoming-group amendments on 2026-10-03.
The user approved the Part 1 plan and chose Native execution on 2026-10-03.

## Global Constraints

- This plan covers Part 1 only. Part 2 needs a separate spec and plan.
- The user approved Native execution. Source work waits for the verified v0.1.1 merge/handoff and plan reconciliation.
- Work only in the Part 1 worktree. Do not change the v0.1.1 owner's branch or worktree.
- Preserve the existing `contextPaging.tokenBudget` default of `128_000`.
- Resolve the budget first. An implicit `contextPaging.trimToTokens` is `max(1, floor(tokenBudget * 5 / 8))`.
- A smaller model window scales the target by `effectiveBudget / tokenBudget`, with `max(1, floor(...))`.
- An explicit `trimToTokens >= tokenBudget` keeps sticky budget-only cuts. Warn once per resolved pair per extension instance.
- Settings accept positive safe integers. Invalid settings fall through trusted project, global, then the adaptive default.
- Invalid direct policy inputs throw before eviction. Preserve existing model-window validation and selection errors.
- Validate the original incoming request. Prepare calibration from that original snapshot, never a pre-cut snapshot.
- Use the retained estimate, including the frozen notice, for the budget trigger. Equality does not trigger an advance.
- Keep the frontier forward-only within its lifetime. Store history keys, never array offsets or message-object identities.
- Keep a partly cut turn's request and suffix after completion, including custom-started turns without user history IDs.
- Anchor partial cuts to model exchanges. A user ID is optional, not a requirement for sticky selection.
- Evict each completed remainder atomically, including a custom-only remainder with a valid original model anchor.
- At a keyless endpoint, use the last evicted keyed unit as frontier and retain all keyless units after it.
- Keep that snapped cut only when its calibrated estimate, including the frozen notice, fits the effective budget.
- Count `keyless-no-key` and `keyless-snap-over-budget` fallbacks separately. Do not invent an ID or snap forward to find one.
- Raw keys must also resolve in current normalized groups. Missing group anchors force the same fallback, not a provenance-only abort.
- Preserve existing protected-overflow and recovery behavior as prefix-stability exceptions.
- Unresolved provenance uses current-call stateless budget-only selection, commits no cut state, and still records the outgoing selection for accounting.
- Use approved successful lifecycle events and projected invalidating entries for resets. Do not reset for canceled operations or accounting fallback alone.
- State and warning deduplication remain in memory. Do not write session entries or change saved history.
- Preserve `search_history`, `browse_history`, `load_history`, and `read_context_output` and their existing contracts.
- Do not change the Claude bridge, dependency pins, release tags, publication settings, or `roche-pi` source.
- Private replay scripts and session contents must stay outside the public repository.

## Review Focus

1. Cloned messages with identical payloads can have ambiguous raw identities: use budget-only fallback, not an arbitrary persisted cut. Task 2 owns this test.
2. A canceled compaction can clear accounting without changing history: keep the cut and frozen notice. Task 3 owns this test.
3. An inherited global target can exceed a lower project budget: keep the frontier and warn once, including after model switches. Task 3 owns this test.
4. Provenance can return after a fallback call and provider response: record the fallback selection without trusting a mismatched accounting anchor. Task 3 owns this test.
5. Accepted safe-integer budgets near the numeric limit need an exact adaptive default: avoid rounded multiplication that changes the integer result. Task 1 owns this test.
6. Custom-started turns lack user IDs: use the model-exchange anchor across completion, including a custom-only remainder.
   Task 2 owns selection tests. Task 3 owns canonical SDK-projection integration.
7. Raw keys can disappear from incoming groups without a history reset.
   Task 2 owns filtering/normalization tests. Task 3 owns nonfatal fallback and accounting integration.

## Workspace and evidence

Plan worktree: `/home/roche/projects/pi/extensions/pi-context-paging/.worktrees/stable-cut-point`.

The docs branch is `docs/stable-cut-point`, based on `d9a9cdf1ea75c80ae695fa4a4191c73d4f3a8bac`.
That base has v0.1.0 source, not the completed standalone accounting port.
The upstream reference is immutable commit `6cb00cb65c12608fe0236db0b0a60a7d808099d3` in the separate `roche-pi` repository.
Use it to understand the port, not as a substitute for the verified v0.1.1 handoff.

Before implementation, check the merged port against this file map and the existing interfaces below.
If they differ, revise the plan and obtain review before writing source. Do not recreate the accounting port in Part 1.

### File map

| File | Responsibility and change |
| --- | --- |
| Create `src/settings.ts` | Resolve trusted settings, adaptive defaults, and explicit-target provenance. No filesystem access. |
| Modify `src/index.ts` | Re-export existing settings interfaces; load settings; manage cut state, reset events, warnings, and accounting calls. |
| Modify `src/context-policy.ts` | Validate target inputs; apply a remembered cut; perform calibrated FIFO advances; return a candidate cut snapshot. |
| Create `src/context-cut.ts` | Own stable cut-key types, current state, key validity checks, reset, and successful commit. No provider estimates or session I/O. |
| Read `src/context-usage.ts` | Use the verified v0.1.1 tracker unchanged. Do not duplicate it. |
| Create `tests/settings.test.ts` | Prove adaptive resolution, trust, fallback, and numeric boundary behavior. |
| Create `tests/context-cut.test.ts` | Prove call-sequence selection, partial turns, identity fallback, and state transactions. |
| Create `tests/fixtures/context-cut.ts` | Build valid raw-history fixtures shared by the new sequence tests. |
| Modify `tests/context-policy.test.ts` | Add target validation and limit tests; preserve the existing policy regression suite. |
| Modify `tests/index.test.ts` | Extend the existing extension harness for lifecycle, warnings, and accounting integration tests. |
| Modify `scripts/smoke-packed-artifact.mjs` | Add the new source modules to its exact packed-file list. Verify with the existing command, not new static-list tests. |
| Modify `README.md`, `docs/architecture.md` | Document approved settings, stability guarantees, resets, and exceptions. |
| Read `bench/context-policy.bench.ts` | Compare the existing workload before and after. Do not add unrelated benchmark features. |

Keep new production modules focused, preferably below 200 meaningful lines.
The existing policy is a deliberate size exception: its grouping and selection algorithm remain local.
Keep persistence and settings out of that file. Use named private helpers for cut application and candidate construction.
Do not mix this feature with a broad policy refactor.

## Existing interfaces to preserve

The verified port must provide these interfaces before execution:

```ts
selectContext(input: ContextSelectionInput): ContextSelection;
residentTokenEstimate(input: Pick<ContextSelectionInput, "systemPrompt" | "activeTools">): number;

ContextUsageTracker.prepare(
  messages: readonly AgentMessage[], residentTokens: number,
  contextTokens: unknown, persistentMessages?: readonly AgentMessage[],
): number | undefined;
ContextUsageTracker.outgoingOnly(
  messages: readonly AgentMessage[], persistentMessages: readonly AgentMessage[],
): boolean[];
ContextUsageTracker.recordSelection(
  messages: readonly AgentMessage[], residentTokens: number,
  persistentMessages?: readonly AgentMessage[],
): void;
ContextUsageTracker.recordResponse(message: AgentMessage): void;
ContextUsageTracker.clear(): void;
```

Keep the existing `ContextSelection` fields: `messages`, `estimatedTokens`, `budgetTokens`, and `mode`.
Keep the existing `ContextSelectionInput` fields, including `contextTokens`, `outgoingOnly`, and `rawHistoryItems`.
Use the standalone `@earendil-works` types, not the upstream reference's old `@mariozechner` import paths.

---

### Task 1: Resolve and validate the trimming target

**Files:**
- Create: `src/settings.ts`, `tests/settings.test.ts`.
- Modify: `src/index.ts` settings resolver/re-exports; `src/context-policy.ts` constants, input types, and initial validation.
- Modify: `tests/context-policy.test.ts`; `scripts/smoke-packed-artifact.mjs` packed-file list.
- Private only: create `stable-cut-replay.ts` beside the supplied replay scripts, with baseline mode before any production edits.

**Interfaces:**
- Consumes: the existing `ContextPagingSettingsSources` shape and `ContextSelectionInput`.
- Produces in `src/settings.ts`:

```ts
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 128_000;
export type ContextPagingSettingsSources = {
  globalSettings: unknown; projectSettings?: unknown; projectTrusted: boolean;
};
export type ResolvedContextPagingSettings = {
  enabled: boolean; tokenBudget: number;
  trimToTokens: number; trimToTokensExplicit: boolean;
};
export function defaultTrimToTokens(tokenBudget: number): number;
export function resolveContextPagingSettings(
  sources: ContextPagingSettingsSources,
): ResolvedContextPagingSettings;
```

- Re-export `resolveContextPagingSettings` and its existing types from `src/index.ts`.
- Re-export `DEFAULT_CONTEXT_TOKEN_BUDGET` from `src/context-policy.ts` so existing imports still work.
- Add optional `trimToTokens?: number` to `ContextSelectionInput`; omission uses the adaptive default.
- Produce in `src/context-policy.ts`:

```ts
export type ContextTokenLimits = {
  budgetTokens: number; trimToTokens: number; modelLimit: number;
};
export function contextTokenLimits(
  input: Pick<ContextSelectionInput, "tokenBudget" | "trimToTokens" | "modelContextWindow">,
): ContextTokenLimits;
```

`ContextTokenLimits.trimToTokens` is the effective cut destination.
For the at-or-above-budget case, it is the effective budget instead of a larger computed target.
Add `INVALID_TRIM_TARGET` to `ContextSelectionErrorCode` for invalid explicit direct values.

- Private replay CLI: `stable-cut-replay.ts --mode baseline|candidate --source <worktree> --session-prefix 01a0fc97 --since 2026-10-02T20:11Z --output <private-json-file>`.
- Task 1 implements baseline mode. Task 4 adds candidate mode without changing baseline inputs or reconstruction assumptions.
- The baseline adapter calls the verified port's stateless selector and derives excluded boundaries from selected history.
- Baseline mode never imports `context-cut.ts`. Candidate mode will load it with a conditional dynamic import.

- [x] **Step 1: Confirm user approval and execution choice.** The user approved the revised spec and plan on 2026-10-03.
The user chose Native execution.

- [ ] **Step 2: Obtain and verify the release handoff.** Obtain the verified v0.1.1 merge SHA from its owner.
With `V011_MERGE_SHA` set to that SHA, run:

```sh
test -n "${V011_MERGE_SHA:-}"
test -z "$(git status --porcelain)"
git merge-base --is-ancestor "$V011_MERGE_SHA" main
```

Expected: all checks exit 0. Stop for a missing handoff, dirty tree, or unmerged release.

- [ ] **Step 3: Rebase only the Part 1 commits.** Run `git rebase --onto "$V011_MERGE_SHA" d9a9cdf1ea75c80ae695fa4a4191c73d4f3a8bac docs/stable-cut-point`.

Expected: the docs sit on the exact verified release commit, not unrelated later `main` changes.
Stop on conflicts and reconcile them with the owner, not by guessing.

- [ ] **Step 4: Create the implementation branch.** Run `git switch -c feat/stable-cut-point`.

Expected: a new branch in the Part 1 worktree. Stop if that branch already exists or is owned elsewhere.

- [ ] **Step 5: Check the actual port interfaces.** Confirm the Existing Interfaces section against merged `src/context-usage.ts` and `src/context-policy.ts`.

Also confirm `tests/context-usage.test.ts` exists. Reconcile and review any plan mismatch before source edits.

- [ ] **Step 6: Install the locked baseline dependencies.** Run `npm ci`.

Expected: installation succeeds without changing dependency pins or the lockfile.

- [ ] **Step 7: Run the baseline check.** Run `npm run check`.

Expected: typecheck, all tests, and isolated packed-artifact loading pass.

- [ ] **Step 8: Capture the baseline benchmark.** Run `npm run bench` three times and save outputs outside the public repository.

Expected: the same 300-turn, 15 MiB workload succeeds. Task 4 compares these captured runs, not a rewritten baseline branch.

- [ ] **Step 9: Create the private baseline replay script.** Adapt `replay.ts` or `replay2.ts` into a separate `stable-cut-replay.ts` copy.

Use `/home/roche/projects/pi/roche-pi/.superpowers/sdd/2026-10-03-stable-cut-point/` for that private copy.
Select exactly one session file with prefix `01a0fc97`, from `2026-10-02T20:11Z` onward.
Reject missing or ambiguous matches. Remove the supplied scripts' hard-coded `01a0fb1f` selection.
Include canonical custom messages in incoming requests, not only the raw `HistoryItem` projection.
Reconstruct accounting with the verified tracker and record resident-input assumptions and unobserved events.
Report that reconstructed calibration can succeed even when live calibration fails.
Persisted-message replay does not reproduce the reported live bridge failure or prove live fingerprint matching.
Implement only the baseline adapter now. Reject candidate mode until Task 4 adds it; do not import a future source module.
The script reads the original session without modifying it. Keep the script and reports outside git and npm artifacts.

- [ ] **Step 10: Verify the private script's syntax.** Run:

```sh
PRIVATE_DIR=/home/roche/projects/pi/roche-pi/.superpowers/sdd/2026-10-03-stable-cut-point
node --check --experimental-strip-types "$PRIVATE_DIR/stable-cut-replay.ts"
```

Expected: exit 0. This private analysis script needs direct verification, not a public script-structure test suite.

- [ ] **Step 11: Capture the pre-edit baseline replay.** Run:

```sh
node --experimental-strip-types "$PRIVATE_DIR/stable-cut-replay.ts" \
  --mode baseline --source "$PWD" --session-prefix 01a0fc97 --since 2026-10-02T20:11Z \
  --output "$PRIVATE_DIR/baseline.json"
```

Expected: a valid report with the source SHA, exact session range, and reconstruction assumptions.
Preserve this output before any production edit. Task 4 compares it with candidate mode on identical reconstructed inputs.
Do not rerun baseline mode against edited candidate source and label that result as the pre-edit baseline.

- [ ] **Step 12: Write failing settings and input tests.** Add these named tests and assertions:

```ts
test("derives the implicit target after budget resolution", () => {
  const defaults = resolveContextPagingSettings({ globalSettings: {}, projectTrusted: false });
  assert.equal(defaults.tokenBudget, 128_000);
  assert.equal(defaults.trimToTokens, 80_000);
  assert.equal(defaults.trimToTokensExplicit, false);
  const project = resolveContextPagingSettings({
    globalSettings: {}, projectTrusted: true,
    projectSettings: { contextPaging: { tokenBudget: 64_000 } },
  });
  assert.equal(project.trimToTokens, 40_000);
});

test("keeps an explicit global target with a lower project budget", () => {
  const settings = resolveContextPagingSettings({
    globalSettings: { contextPaging: { trimToTokens: 80_000 } },
    projectSettings: { contextPaging: { tokenBudget: 64_000 } }, projectTrusted: true,
  });
  assert.equal(settings.tokenBudget, 64_000);
  assert.equal(settings.trimToTokens, 80_000);
  assert.equal(settings.trimToTokensExplicit, true);
});

test("computes the adaptive default exactly for accepted integer boundaries", () => {
  assert.equal(defaultTrimToTokens(1), 1);
  const budget = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(defaultTrimToTokens(budget), Number(BigInt(budget) * 5n / 8n));
});
```

Also test trusted project target precedence, ignored untrusted overrides, invalid-project-to-valid-global fallback, and invalid-global-to-adaptive-default fallback.
Use invalid values `0`, `-1`, `1.5`, `NaN`, `Infinity`, `Number.MAX_SAFE_INTEGER + 1`, `"80000"`, `true`, `null`, arrays, and objects.
For direct policy calls, assert `ContextSelectionError.code === "INVALID_TRIM_TARGET"` for those values.
Test omission separately: it is not an invalid explicit value.

Add `contextTokenLimits` assertions for `(128_000, 80_000, undefined)` and `(128_000, 80_000, 64_000)`.
Their destinations are `80_000` and `40_000`; budgets are `128_000` and `64_000`.
For explicit `160_000` with budget `128_000` and model window `64_000`, the destination must be `64_000`.
For budget `Number.MAX_SAFE_INTEGER`, target one less, and window `64_000`, assert an effective target of `63_999`.
Preserve existing invalid-budget and invalid-model error cases.

- [ ] **Step 13: Run the tests and record the red result.**

Run: `node --test --experimental-strip-types tests/settings.test.ts tests/context-policy.test.ts`.
Expected: the new resolver/limit interface or behavior is missing. Do not count an unrelated fixture or SDK failure as red evidence.

- [ ] **Step 14: Implement the settings and limit interfaces.** Resolve the budget before the target and retain valid-value provenance for warning decisions.

Use exact integer arithmetic for the adaptive default and integral-window scaling; do not round a product before division.
Keep the existing positive-finite model-window domain, including non-integer metadata.
Keep settings I/O in `index.ts`. Keep the dependency direction `context-policy.ts -> settings.ts`, not a runtime import cycle.
Route initial policy validation through `contextTokenLimits`; keep the existing FIFO destination unchanged until Task 2.
In `index.ts`, pass `trimToTokens: settings.tokenBudget` until Task 3 commits returned snapshots.
Keep that override through Task 2 and assert legacy budget-only retention in `tests/index.test.ts`.
Do not expose target-from-scratch behavior between commits. Task 2's direct selector tests still use the real target.
Initialize disabled pre-start settings through the resolver rather than an incomplete settings object.
Add `src/settings.ts` to the packed-file list.

- [ ] **Step 15: Run green verification.** Run `npm run check`.

Expected: the new behavior tests, existing regression tests, typecheck, and packed load all pass.
No new test merely asserts the static packed-file list.

- [ ] **Step 16: Commit the deliverable.**

```sh
git add src/settings.ts src/index.ts src/context-policy.ts tests/settings.test.ts tests/context-policy.test.ts scripts/smoke-packed-artifact.mjs
git commit -m "feat: resolve and validate context trimming targets"
```

---

### Task 2: Implement transactional, forward-only selection

**Files:**
- Create: `src/context-cut.ts`, `tests/context-cut.test.ts`, `tests/fixtures/context-cut.ts`.
- Modify: `src/context-policy.ts` selection input/result, history-key lookup, remembered-cut application, FIFO advance, and notice reuse.
- Modify: `scripts/smoke-packed-artifact.mjs` packed-file list.

**Interfaces:**
- Consumes: Task 1's settings default and `contextTokenLimits`, plus existing `HistoryItem`, `ContextSelectionInput`, and `ContextSelection`.
- Produces in `src/context-cut.ts`:

```ts
export type ContextCutKey = { historyId: string; toolCallId?: string };
export type ContextCutFrontier =
  | { kind: "prefix" | "completedTurn"; lastEvicted: ContextCutKey }
  | { kind: "partialTurn"; userHistoryId?: string; lastEvicted: ContextCutKey };
export type ContextCutFallbackReason =
  | "raw-history-unavailable" | "cut-key-unresolved"
  | "keyless-no-key" | "keyless-snap-over-budget"
  | "frontier-not-in-groups";
export type ContextCutSnapshot = {
  frontier: ContextCutFrontier; notice: UserMessage;
};
export class ContextCutState {
  prepare(rawHistoryItems: readonly HistoryItem[] | undefined): ContextCutSnapshot | undefined;
  commit(snapshot: ContextCutSnapshot | undefined): void;
  reset(): void;
}
```

`prepare` returns the current snapshot unchanged when its raw keys still resolve uniquely.
For partial turns, the model exchange is required and the user key is checked only when present.
It clears state for missing raw provenance or invalid old keys. It does not estimate tokens or advance a cut.
These raw checks do not prove that the frontier exists in the incoming groups. `selectContext` owns that second check.
`commit` stores only a successful candidate, including `undefined` for a successful stateless fallback.
The module never retains the full raw-history array or provider request between calls.

Add optional `cutState?: ContextCutSnapshot` to `ContextSelectionInput`.
Add `cutState: ContextCutSnapshot | undefined` and optional `cutFallbackReason?: ContextCutFallbackReason` to `ContextSelection`.
The reason records the first cause that forces stateless budget-only selection. Ordinary stateful results omit it.
It is internal result metadata, never provider content or a recovery-tool field.
A no-advance result returns the previous snapshot, with the same normal notice.
An advance returns a new snapshot; stateless fallback returns `undefined`.
Treat snapshots as immutable; constructing a candidate must not change the previous frontier or notice.

The new fixture module produces:

```ts
export type PagingFixture = { entries: SessionEntry[]; input: ContextSelectionInput };
export function pagingFixture(kind: "completed" | "active" | "custom-active" | "keyless"): PagingFixture;
export function appendExchange(fixture: PagingFixture, id: string, textTokens: number): PagingFixture;
export function completeTurn(fixture: PagingFixture, nextUserId: string): PagingFixture;
```

Each helper returns new arrays and projects its raw entries with `projectActiveBranch`.

Fixture inputs use budget/window `128_000`, target `80_000`, empty resident input, and calibrated `contextTokens: 128_001`.
The completed fixture has three completed turns `old-A`, `old-B`, `old-C` with 30,000-token text payloads, followed by request `live` and two 10,000-token tool exchanges.
The active fixture has request `live` and four 30,000-token tool exchanges.
The custom-active fixture replaces that user's opener with a canonical custom message backed by a `custom_message` session entry.
Its model exchanges keep the same raw IDs. Its raw projection contains no user item for `live`.
The keyless fixture has keyed turn `old-A` with a 10,000-token answer, then custom-only request `old-custom` with 30,000 tokens, then user `live`.
The custom entry has no model response, so that original completed unit has no raw anchor.
For the over-budget snap fixture, append one 30,000-token `live-1` tool exchange with `appendExchange`.
Keep its latest unread result protected and use `contextTokens: 145_001` for that call.
Custom message timestamps and fields must match the pinned SDK's session-entry conversion.
Use ASCII text bodies of `4 * textTokens` characters and complete call/result pairs.
User markers are `<id> request`; tool-result markers are `<id> payload` before the repeated body.
Entry IDs are `user-<id>`, `turn-<id>`, and `result-<id>`; tool-call IDs are `call-<id>`.
Active exchanges use IDs `live-1` through `live-4` as needed. Completed turn IDs are `old-A`, `old-B`, and `old-C`.
Appending updates the input estimate by the new messages' Pi estimates; completing appends request `next` without restoring old exchanges.

- [ ] **Step 1: Write failing call-sequence tests through `selectContext`.** Use the fixture definitions above and these assertions:

```ts
test("holds a cut and byte-identical notice below the retained budget", () => {
  const f = pagingFixture("completed");
  const first = selectContext(f.input);
  assert.ok(first.cutState);
  assert.ok(first.estimatedTokens <= 80_000);
  assert.ok(JSON.stringify(first.messages).includes("old-C"));
  const next = appendExchange(f, "live-3", 2_000);
  const second = selectContext({ ...next.input, cutState: first.cutState });
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.equal(JSON.stringify(second.cutState?.notice), JSON.stringify(first.cutState.notice));
  assert.deepEqual(second.cutState?.frontier, first.cutState.frontier);
});

test("does not use the full-history crossing or the target as a new trigger", () => {
  const f = pagingFixture("completed");
  const first = selectContext(f.input);
  const second = selectContext({ ...f.input, contextTokens: 158_001, cutState: first.cutState });
  assert.ok(second.estimatedTokens > 80_000 && second.estimatedTokens <= 128_000);
  assert.deepEqual(second.cutState, first.cutState);
});

test("uses budget-only selection and commits no cut when provenance is absent", () => {
  const f = pagingFixture("completed");
  const result = selectContext({ ...f.input, rawHistoryItems: undefined });
  assert.equal(result.cutState, undefined);
  assert.equal(result.cutFallbackReason, "raw-history-unavailable");
  assert.ok(result.estimatedTokens > 80_000 && result.estimatedTokens <= 128_000);
  assert.ok(JSON.stringify(result.messages).includes("old-B"));
});
```

Add `exactly at budget does not advance`: `contextTokens: 128_000` with no existing cut returns no paging notice and no snapshot.
Add `retained over-budget estimate advances FIFO`: after the first cut, use `contextTokens: 190_001`; the frontier advances and the request fits `128_000`.
Add `prefix units are evicted before completed turns`: prepend a 30,000-token assistant prefix to the completed fixture and its raw entries.
At `128_001`, assert the prefix and `old-A` are absent while `old-B` remains.
Add `prefix-only cut can stop below budget before reaching an impossible target`: use only the completed fixture's `old-A` assistant entry, with `contextTokens: 128_001`.
Assert a `prefix` snapshot and a paged estimate above `80_000` but below `128_000`.
Repeat with `110_001` and that snapshot; the excluded assistant remains absent and the normal notice stays unchanged.
Add `lower calibration never restores history`: use `110_001` after the first cut; the same cut and notice remain and `old-A`/`old-B` stay absent.
Add `scales target with the model window`: use window `64_000` and `contextTokens: 80_001`; `old-B` is absent because the destination is `40_000`.
Add `includes the outgoing notice in the target destination`: sum Pi estimates for the first two completed turns.
Set `contextTokens` to that sum plus `80_000`; without the notice, two removals land exactly on the target.
Assert `old-C` is also absent and the final estimate fits `80_000`. The notice requires that third removal.
Do not stub Pi's estimator with a constant.

Add `explicit high target still retains a sticky cut`: select with `trimToTokens: 160_000`, then with `contextTokens: 110_001` and the returned snapshot.
Assert the snapshot and notice persist and `old-A` stays absent, although the full second input fits the budget.

- [ ] **Step 2: Write failing partial-turn, identity, and transaction tests.**

```ts
for (const kind of ["active", "custom-active"] as const) {
  test(`${kind} keeps its partial cut after completion and later evicts the remainder atomically`, () => {
    const f = pagingFixture(kind);
    const first = selectContext(f.input);
    const point = first.cutState?.frontier;
    assert.ok(point?.kind === "partialTurn");
    assert.equal(point.userHistoryId, kind === "active" ? "user-live" : undefined);
    assert.equal(point.lastEvicted.historyId, "turn-live-2");
    assert.equal(first.cutFallbackReason, undefined);
    const completed = completeTurn(f, "next");
    const second = selectContext({ ...completed.input, cutState: first.cutState });
    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    assert.deepEqual(second.cutState, first.cutState);
    const third = selectContext({ ...completed.input, contextTokens: 190_001, cutState: second.cutState });
    assert.ok(!JSON.stringify(third.messages).includes("live request"));
    assert.ok(!JSON.stringify(third.messages).includes("live-3 payload"));
    assert.ok(JSON.stringify(third.messages).includes("next request"));
    assert.equal(third.cutState?.frontier.kind, "completedTurn");
    assert.equal(third.cutState?.frontier.lastEvicted.historyId, "turn-live-4");
  });
}

test("keyless target endpoint snaps backward and stays byte-identical below budget", () => {
  const f = pagingFixture("keyless");
  const first = selectContext(f.input);
  assert.ok(first.cutState);
  assert.equal(first.cutState.frontier.kind, "completedTurn");
  assert.equal(first.cutState.frontier.lastEvicted.historyId, "turn-old-A");
  assert.equal(first.cutFallbackReason, undefined);
  assert.ok(first.estimatedTokens > 80_000 && first.estimatedTokens <= 128_000);
  assert.ok(JSON.stringify(first.messages).includes("old-custom request"));
  assert.ok(!JSON.stringify(first.messages).includes("old-A request"));
  assert.deepEqual(first.messages[0], first.cutState.notice);
  const second = selectContext({ ...f.input, contextTokens: 110_001, cutState: first.cutState });
  assert.equal(second.cutFallbackReason, undefined);
  assert.deepEqual(second.cutState, first.cutState);
  assert.equal(JSON.stringify(second.messages), JSON.stringify(first.messages));
  assert.equal(JSON.stringify(second.messages[0]), JSON.stringify(first.cutState.notice));
});

test("keyless backward snap over budget uses its own budget-only fallback", () => {
  const f = appendExchange(pagingFixture("keyless"), "live-1", 30_000);
  const result = selectContext({ ...f.input, contextTokens: 145_001 });
  assert.equal(result.cutState, undefined);
  assert.equal(result.cutFallbackReason, "keyless-snap-over-budget");
  assert.equal(result.mode, "paged");
  assert.ok(result.estimatedTokens > 80_000 && result.estimatedTokens <= 128_000);
  assert.ok(!JSON.stringify(result.messages).includes("old-A request"));
  assert.ok(!JSON.stringify(result.messages).includes("old-custom request"));
  assert.ok(JSON.stringify(result.messages).includes("live-1 payload"));
});

test("next trigger removes retained keyless units and cannot return an over-budget no-op", () => {
  const f = pagingFixture("keyless");
  const first = selectContext(f.input);
  assert.ok(first.cutState);
  const triggerContextTokens = f.input.contextTokens! + 128_001 - first.estimatedTokens;
  const second = selectContext({ ...f.input, contextTokens: triggerContextTokens, cutState: first.cutState });
  assert.equal(second.cutState, undefined);
  assert.equal(second.cutFallbackReason, "keyless-snap-over-budget");
  assert.equal(second.mode, "paged");
  assert.ok(second.estimatedTokens <= 128_000);
  assert.ok(!JSON.stringify(second.messages).includes("old-custom request"));
  assert.ok(!JSON.stringify(second.messages).includes("old-A request"));
  assert.ok(JSON.stringify(second.messages).includes("live request"));
});
```

Also replace the custom-active tool exchanges with one 30,000-token plain assistant answer and its raw model entry.
At `128_001`, that unprotected answer is evicted. Its model ID anchors the custom-only remainder.
Complete the turn and repeat below budget: that remainder and the frozen notice must persist.
For the later crossing, increase the full estimate by `128_001 - second.estimatedTokens`, not an arbitrary calibration jump.
Evict the small completed remainder atomically using its original model anchor with `kind: "completedTurn"`.
Assert a final estimate greater than `127_000` and no greater than `128_000`, with no fallback reason.
Removing this tiny remainder must not subtract the already excluded answer again. Keep unread-tool-result protection unchanged.

Add `zero-key prefix reports its own budget-only fallback`: use only `old-custom` and `live` from the keyless fixture.
Project only their raw entries and set `outgoingOnly: [true, false]` so the custom message is a prefix unit.
Assert no snapshot, reason `keyless-no-key`, and a budget-safe result that excludes the custom prefix but retains `live`.
This stateless call has no cross-call prefix-stability guarantee.

Add a notice-cost boundary variant to the snapped-cut test.
Calibrate the request after the `old-A` exclusion to `128_000` before the notice's cost, using Pi's actual estimates.
The notice makes the snap exceed the budget. Assert `keyless-snap-over-budget`, no snapshot, and a budget-safe fallback.
This case rejects a budget check that omits the frozen notice or recalibrates from a smaller snapshot.

Test independently cloned incoming messages and raw-history messages with stable IDs: the cut and normal notice stay unchanged.
For identical cloned exchanges with distinct raw IDs but identical timestamps, payloads, and call IDs, assert budget-only fallback and no snapshot.
Assert reason `cut-key-unresolved` for that ambiguous new anchor.
Do not choose the newest matching raw entry merely because a tool-call lookup overwrote an earlier entry.
Test multiple tool calls in one assistant exchange: all calls/results remain atomic, and tool names alone never identify the cut.

Add `raw frontier absent from incoming groups falls back without throwing`: seed the active fixture's cut at `turn-live-2`.
Keep raw history unchanged, but filter that exchange's assistant and all matching results from the next incoming request.
Assert `prepare(rawHistoryItems)` still returns the seeded snapshot. Then select at `128_001` with that snapshot.
Assert no snapshot, reason `frontier-not-in-groups`, and a result greater than `80_000` but no greater than `128_000`.
The budget-only result retains `live-3 payload`; it must not reuse a pre-cut or over-trimmed target result.

Add `normalization removes a raw-valid frontier without a provenance error`: keep the same raw history and snapshot.
In the incoming request only, set the anchored assistant's `stopReason` to `"aborted"` and remove its tool results.
At `150_001`, assert successful budget-only output, no snapshot, reason `frontier-not-in-groups`, and retained `live-3 payload`.
These cases preserve genuine original-structure errors rather than swallow them.

For `ContextCutState`, test valid-key preparation, missing-key reset, `reset()`, and fresh construction after restart.
Seed a valid snapshot, force an invalid-original-structure selection, and assert the prepared state remains unchanged because no candidate is committed.
Include an orphan or normally incomplete exchange before the remembered cut: validation must still throw `INVALID_MESSAGE_STRUCTURE`.
Retain the v0.1.1 interrupted-exchange normalization and exact raw recovery cases.
Add `minimum target cannot bypass a fractional model limit`: an empty request with window `0.5` and `contextTokens: 0.75` must fail safely.
Assert `RESIDENT_INPUT_TOO_LARGE`, not a normal selection above that model limit. This preserves the existing positive-finite metadata domain.

Add these protected-mode sequence tests using the active fixture:

```ts
test("an unreachable target below budget is valid", () => {
  const f = pagingFixture("active");
  const result = selectContext({ ...f.input, contextTokens: 180_001 });
  assert.equal(result.mode, "paged");
  assert.ok(result.estimatedTokens > 80_000 && result.estimatedTokens <= 128_000);
});

for (const [window, mode] of [[256_000, "protected-overflow"], [128_000, "recovery"]] as const) {
  test(`${mode} preserves the frozen normal notice when normal paging resumes`, () => {
    const f = pagingFixture("active");
    const exceptional = selectContext({ ...f.input, contextTokens: 240_001, modelContextWindow: window });
    assert.equal(exceptional.mode, mode);
    assert.ok(exceptional.cutState);
    const resumed = selectContext({ ...f.input, contextTokens: 180_001,
      modelContextWindow: window, cutState: exceptional.cutState });
    assert.equal(resumed.mode, "paged");
    assert.deepEqual(resumed.messages[0], exceptional.cutState.notice);
    assert.deepEqual(resumed.cutState?.frontier, exceptional.cutState.frontier);
  });
}
```

- [ ] **Step 3: Run red verification.**

Run: `node --test --experimental-strip-types tests/context-cut.test.ts tests/context-policy.test.ts tests/context-policy.regression.test.ts`.
Expected: new cut/state behavior fails for the named requirements. Correct test setup failures before implementation.

- [ ] **Step 4: Implement the state and selection interfaces.**

Normalize and validate the original request before applying any remembered exclusions.
Preserve the original accounting adjustment when subtracting normalized or evicted messages.
Resolve stable keys through the existing history lookup. Add a strict cut-key path that rejects ambiguous matches.
Locate a partial frontier by its model exchange in exactly one validated active or completed group.
Retain that group's request envelope, including a custom opener. If an owning user ID exists, validate it against that group.
Do not add custom history items or change the four recovery tools.
Do not turn unavailable cut provenance into a new provider-abort condition.

Resolve the remembered key in the current normalized groups before applying it or measuring the trigger.
If the frontier cannot resolve uniquely in the expected normalized group, use the budget-only fallback from the original groups.
Return no snapshot and reason `frontier-not-in-groups`. That resolution failure itself must never throw.
Keep genuine original-validation and safety errors unchanged.
Otherwise apply the old cut before measuring the trigger. Reuse the frozen normal notice, including its timestamp.
When over budget, advance in existing FIFO order toward the effective destination, respecting all existing protections and final budget checks.
Keep the owning request when applying a partial frontier to a now-completed turn.
At a later advance, evict that completed remainder as one unit before entering the next active turn.

Resolve the proposed new anchor before finalizing a target cut.
A completed unit can use an anchor from its full original group, including an exchange already excluded by a partial cut.
If its retained remainder contains only a custom request, change the anchored frontier kind to `completedTurn` when that remainder is evicted.
A unit with no original raw anchor is truly keyless.
If FIFO ends at such a unit, move the uncommitted boundary back to the last evicted keyed unit.
Retain every keyless unit after that frontier. Do not merely attach the earlier key to a cut that still excludes those units.
Use the remembered frontier as the rollback bound when the current advance evicts no newer keyed unit.
Keep all exclusions from that committed frontier. Never snap forward or evict extra units merely to find an anchor.

Include the frozen notice in the snapped request's estimate. Preserve the original calibration adjustment used by the budget trigger.
If that estimate fits the effective budget, return the snapped snapshot without a fallback reason, even above the target.
If no keyed unit was evicted and no remembered frontier exists, use reason `keyless-no-key`.
If the snapped estimate exceeds the effective budget, use reason `keyless-snap-over-budget`.
A budget-triggered attempt that snaps to the same remembered frontier still requires this over-budget fallback, not a no-op.
For either cause, select from the original normalized groups with the budget-only destination and return no snapshot.
If other required provenance is unavailable, use that same route with its distinct existing cause.
Reuse the selector logic. Do not duplicate validation or retain an already over-trimmed target result as the fallback.

Keep the normal frozen notice in the snapshot even when overflow or recovery substitutes the outgoing notice.
Do not commit within `selectContext`; it only returns the candidate.
Preserve linear passes and existing weak caches. Add `src/context-cut.ts` to the packed-file list.

- [ ] **Step 5: Run green verification.** Run `npm run check`.

Expected: all new sequence tests and existing regressions pass, including unreachable targets and exceptional-mode transitions.

- [ ] **Step 6: Commit the deliverable.**

```sh
git add src/context-cut.ts src/context-policy.ts tests/context-cut.test.ts tests/fixtures/context-cut.ts scripts/smoke-packed-artifact.mjs
git commit -m "feat: preserve forward-only paging cuts across requests"
```

---

### Task 3: Wire lifecycle, warnings, and accounting without stale state

**Files:**
- Modify: `src/index.ts` refresh, context handler, successful lifecycle hooks, and warning state.
- Modify: `tests/index.test.ts` existing harness and behavior tests.
- Read: `src/context-usage.ts`; its behavior remains the verified port's behavior.

**Interfaces:**
- Consumes: Task 1's resolved settings, Task 2's `ContextCutState` and candidate result, and the existing tracker interfaces.
- Produces: the unchanged default entry interface:

```ts
export default function contextPagingExtension(
  pi: ExtensionAPI, settingsSources?: ContextPagingSettingsSources,
): void;
```
- Keep a `ContextCutState` instance and a separate warning-pair `Set<string>` inside each extension instance.
- No cut state or grouping details are exposed through the recovery tools.

- [ ] **Step 1: Write failing integration tests using the existing `createHarness` and `emit`.**

Seed a paged call with real projected entries and repeat it with cloned outgoing messages.
Repeat with a custom-started active turn whose canonical persistent projection includes the custom opener.
Extend the test harness's fake projection with the pinned SDK's `custom_message` conversion, not the raw-history projection.
Complete that turn through `turn_end`, then append a user request below budget. Assert the same prefix and no abort.
Spy on `ContextCutState.commit` and assert a defined snapshot for both successful custom-turn calls, not a stateless fallback.
Assert the notice is unchanged, excluded history stays excluded, `appendCalls() === 0`, and `abortCalls() === 0`.
Use `t.mock.method(ContextUsageTracker.prototype, "prepare")` to assert its input is the original `event.messages`, not selected messages.
Keep the existing provider-response/status tests for calibrated anchors and outgoing-only instructions.

Add reset tests for `session_start` reasons `new`, `resume`, and `fork`, successful `session_tree`, and `session_compact`.
After each reset, use a current projection whose below-budget selection retains formerly excluded history.
For model switches, use the same history with window `64_000`, switch to `128_000`, then back to `64_000`.
Emit `model_select` for both actual switches; the larger window can retain more, and the smaller one selects safely again.
A new harness has no prior cut or warning set: this proves the restart lifetime.

Add new projected `context_edit` and compaction entries using the existing v0.1.1 fixtures.
After the first new selection, repeating the same invalidation entry must keep the new frontier and frozen notice.
Exercise both event-first and entry-first compaction orderings, with a successful selection between the two signals.
Use `t.mock.method(ContextCutState.prototype, "reset")`: the later signal for the same compaction-entry ID must not add a reset call.
A new compaction-entry ID must still reset. Do not add an invented `context_edit` event handler.

- [ ] **Step 2: Write the Review Focus integration tests.**

`canceled compaction accounting fallback does not reset the cut`: seed a cut and emit automatic-compaction cancellation.
Assert `{ cancel: true }` and an unchanged cut-derived prefix.
Then emit manual `session_before_compact`, which clears accounting in the port, but do not emit successful `session_compact`.
Repeat the unchanged request: assert the same prefix, no restoration, and no abort despite accounting fallback.
Also test partial-turn completion through `turn_end`: it must not reset cut state.

`warns once for an inherited high target across calls and model switches`: use a trusted project budget `64_000` and explicit global target `80_000`.
Assert one warning containing both setting names and values, a sticky cut, and no additional warning after repeated contexts or `model_select`.
For settings reloads, reuse the filesystem-backed temporary-HOME pattern in the existing tests.
Load one resolved pair, a second pair, then the first pair again; warning counts must be `1`, `2`, then `2` for that instance.
Restore the environment and delete the temporary HOME in `finally`.
The implicit budget-1 target does not warn; disabled paging remains inert even with an explicit high target.

`records a provenance-fallback selection and recovers accounting safely`: force raw projection failure after a paged call.
Use `t.mock.method(ContextUsageTracker.prototype, "recordSelection")` to assert the final fallback messages are recorded.
Assert budget-only retained output, no cut-state carryover, and no abort merely for unavailable cut provenance.
Also filter a remembered exchange only from `event.messages` while leaving canonical/raw history intact.
Assert no abort and final fallback output passed to `recordSelection`.
Spy on `ContextCutState.commit`: successful fallback clears state with `undefined`, and the next `prepare` returns no old snapshot.
A later successful selection can create a fresh snapshot, even if its key matches the old one.
Emit a provider response, restore raw projection, and continue the existing measured-anchor scenario.
Assert accounting either establishes a valid measured anchor or falls back safely; it must not calibrate against a mismatched retained snapshot.

- [ ] **Step 3: Run red verification.**

Run: `node --test --experimental-strip-types tests/index.test.ts`.
Expected: missing cut wiring, reset handling, warning deduplication, or fallback recording fails the new behavior tests.

- [ ] **Step 4: Implement the extension integration.**

Keep `usageTracker.prepare`, resident estimates, and outgoing-only provenance based on the original incoming request.
Replace the temporary budget-only override with the prepared cut snapshot, resolved target, original history, and existing accounting inputs to `selectContext`.
Commit the returned cut snapshot only after selection succeeds. Record the final outgoing selection in the tracker, including stateless fallback calls.
Use the tracker's optional persistent-provenance argument when canonical session messages are unavailable; never invent trusted provenance.
Preserve the existing catch/abort behavior for genuine selection errors, with no candidate advance committed.

Reset cut state on successful `session_start`, `session_tree`, `session_compact`, and `model_select`.
Use the existing invalidating-entry detection for both tracker and cut invalidation, without conflating ordinary tracker fallback with a cut reset.
Observe saved invalidating-entry IDs before rebuilding a cut so event/entry duplication cannot clear that new cut on the next request.
Do not clear cut state in `session_before_compact` merely because accounting clears there.

Warn only when paging is enabled and the resolved target is explicit and at or above the configured budget.
The warning must identify `tokenBudget`, `trimToTokens`, their values, and the lack of room between cuts.
Keep the pair set across session/model resets within the instance; do not serialize it.

- [ ] **Step 5: Run green verification.** Run `npm run check`.

Expected: all integration tests, prior tracker regressions, tool tests, typecheck, and packed load pass.

- [ ] **Step 6: Commit the deliverable.**

```sh
git add src/index.ts tests/index.test.ts
git commit -m "feat: reset paging frontiers on approved lifecycle changes"
```

---

### Task 4: Verify the complete behavior and document its limits

**Files:**
- Modify: `README.md`, `docs/architecture.md`.
- Read: all affected tests, `bench/context-policy.bench.ts`, and the packed-artifact check.
- Private only: extend Task 1's `stable-cut-replay.ts` with candidate mode.

**Interfaces:**
- Consumes: the completed extension and all earlier task interfaces.
- Produces: fresh verification evidence and an aggregate replay summary. No new production interface or release action.
- Consumes Task 1's private replay CLI, baseline script, and preserved pre-edit `baseline.json`.
- The candidate adapter passes and commits returned snapshots and applies observed reset events.
- Both adapters use the same original inputs, including canonical custom messages, and the same accounting reconstruction.
- The candidate report counts `cutFallbackReason` by cause, independently of the reset and prefix-change counts.

- [ ] **Step 1: Update public documentation.** Document the `128_000` budget, adaptive 5/8 target, model-window scaling, explicit high-target warning, and safe-integer fallback rules.

Describe forward-only cuts, frozen notices, custom-started partial turns, lifecycle resets, provenance fallback, and overflow/recovery prefix exceptions.
Explain budget-safe backward snaps and their sticky cuts.
Explain the separate zero-key, over-budget-snap, and missing-group fallbacks without promising sticky cuts for those calls.
Do not claim that all provider calls become append-only or that the replay measures real provider billing.
Do not add tests for documentation text or the static file list.

- [ ] **Step 2: Run fresh full verification.**

Run: `npm run check` and `git diff --check`.
Expected: typecheck, the complete test suite, exact packed-file verification, and isolated packed-Pi tool loading pass; no whitespace errors.
Use the existing smoke check, not `pi --help` as extension-load evidence.

- [ ] **Step 3: Compare the existing benchmark.** Run `npm run bench` three times against the candidate.

Use the three baseline runs captured in Task 1, with the same 300-turn, 15 MiB workload.
Compare median selection time and retained-message counts.
Inspect new loops for repeated full-history scans or serialization inside eviction loops.
Investigate a large regression before claiming completion; one timing measurement alone does not prove linear complexity.
Store raw output privately and report the workload and results, not an unsupported performance guarantee.

- [ ] **Step 4: Add candidate mode to the existing private script.** Keep Task 1's baseline adapter and input reconstruction unchanged.

Only candidate mode dynamically imports `src/context-cut.ts` from `--source` and constructs `ContextCutState`.
Prepare its snapshot against current raw history, pass it to selection, and commit only successful results.
Apply observed reset events and count `cutFallbackReason` using the exact Task 2 union values.
When fallback clears state, end the cut lifetime.
A later fresh cut does not count as backward movement within that old lifetime.
Do not infer a missing reset or fallback cause from a prefix change alone.

- [ ] **Step 5: Run the private candidate replay.** Run the existing script with Node's type-stripping support:

```sh
PRIVATE_DIR=/home/roche/projects/pi/roche-pi/.superpowers/sdd/2026-10-03-stable-cut-point
node --check --experimental-strip-types "$PRIVATE_DIR/stable-cut-replay.ts"
node --experimental-strip-types "$PRIVATE_DIR/stable-cut-replay.ts" \
  --mode candidate --source "$PWD" --session-prefix 01a0fc97 --since 2026-10-02T20:11Z \
  --output "$PRIVATE_DIR/candidate.json"
```

Compare with Task 1's preserved pre-edit report. Record source SHAs in both reports.
Expected: a valid report for the same evidence session and range, with no original-session writes.
Treat it as a private analysis script: direct verification is enough, not a new public script-structure test suite.

Count total calls, frontier changes, rebuild-equivalent prefix changes, exceptional-mode transitions, recovery substitutions, unreachable-target cuts, and reset reasons.
Report separate fallback counts for every `ContextCutFallbackReason` value:

- `raw-history-unavailable`.
- `cut-key-unresolved`.
- `keyless-no-key`.
- `keyless-snap-over-budget`.
- `frontier-not-in-groups`.

Do not combine the two keyless causes. Budget-safe snapped cuts are not fallback calls.
If replay records over-budget snaps, report them for separate review. Do not introduce forward snapping during execution.
An unprotected next key does not permit extra eviction solely to find an anchor after FIFO reaches its destination.
Identify custom-started turns and custom-only boundary units in those aggregate counts. Baseline stateless calls are not Part 1 provenance fallbacks.
Compare provider-visible message representations, including the notice, not object identity or token totals.
Count each changed request once, while reporting overlapping causes separately.
Assert no backward frontier movement within a lifetime and no paging-caused prefix change for ordinary below-budget appends.
Identify unobserved lifecycle events and other reconstruction limits explicitly; do not infer missing events as facts.
Keep the original session read-only. Keep scripts, raw output, and private payloads out of git and npm artifacts.
No fixed cache-reduction percentage is required by the spec.

- [ ] **Step 6: Check spec coverage and the complete diff.** Confirm every Section 8 acceptance case has a passing behavior test or the required replay evidence.

Review unchanged recovery-tool contracts, validation-before-cut ordering, weak-cache behavior, failure atomicity, and absence of persistent session writes.
If a behavior gap needs a correction, first add its failing test, then make the minimal change and rerun `npm run check`.
A parent-run fresh canonical `reviewer` review follows the selected execution workflow before integration.
Pass the spec, plan, baseline/head SHAs, acceptance criteria, and verification evidence; resolve the active role's model/thinking when available.
Ordinary writing workers do not launch reviewers themselves.

- [ ] **Step 7: Commit documentation and present the branch for review.**

```sh
git add README.md docs/architecture.md
git commit -m "docs: describe stable paging cuts and token targets"
```

Do not tag, publish, bump a dependency pin, or merge as part of this plan.
If the user later chooses local integration, offer a squash merge into `main`, not a regular merge.

## Plan handoff

The roche-pi peer completed review of the revised amendments. The user approved all three amendments on 2026-10-03.
The user approved the Part 1 plan and chose **Native** execution on 2026-10-03.
Source work still waits for the verified v0.1.1 merge/handoff and reconciliation with that source.
Present the approved custom-turn, backward-snap, and incoming-group details explicitly.
If reconciliation changes behavior or task scope, report it before any source edit.
Native execution uses this session as the sole writer and one fresh whole-branch review under the parent's orchestration.
A writing child must receive `test-driven-development` and `verification-before-completion`; reviewers remain read-only and use fresh context.

Obtain the release handoff from its owner, then reconcile the plan and execute its tasks in order.
Before Task 3, investigate the reported live-calibration failure read-only and report evidence plus proposed fix placement to the parent.
Do not add an accounting fix to Part 1 without user direction.
Do not start source work before the release and reconciliation gates pass.
