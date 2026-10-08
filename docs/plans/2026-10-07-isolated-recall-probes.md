# Isolated Recall Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution. Use superpowers:subagent-driven-development only if the user selects delegation. Follow the checkbox steps task by task.

**Goal:** Measure isolated fact recovery from faithful checkpoint forks, with complete ownership, resource-use, and timing evidence.

**Architecture:** Prepare one baseline source and one paging source for each stage group. Restore a separate checkpoint fork for each question through host-only lifecycle replay. Keep provider observations authoritative for new usage, and join them to fork-local SDK events before aggregation.

**Tech Stack:** TypeScript, Node.js >=22.19.0, `node:test`, and the repository-pinned Pi SDK 0.87.1.

**Spec:** `docs/specs/2026-10-07-isolated-recall-probes-design.md`. Also read its two referenced designs for unchanged requirements.

## Global Constraints

- Use the existing `.worktrees/context-paging-probe-isolation` worktree on `docs/isolated-recall-probes`. The planning base is `7595663`.
- The user approved implementation planning. This plan does not authorize implementation, a paid pilot, or a batch.
- The first implementation-plan task must be an offline feasibility experiment.
- Keep the exact model `openai-codex/gpt-6-luna`, `xhigh` thinking, and full-payload SSE observation.
- Paging stays at 128,000 tokens with an 80,000-token trim target.
- Native model metadata and compaction defaults remain unchanged.
- Production retrieval tools and paging policy remain unchanged. Do not modify `src/` or add a production checkpoint interface.
- Use schema version `3`, workload version `incident-isolated-probes-v3`, and conversation design `stage-checkpoint-probe-forks-v1`.
- Each fork inherits at least 23 successive preparation prompts and receives exactly one probe prompt.
- A and B each require five-of-five qualified known paging probes. The unknown control never contributes to this denominator.
- The defaults remain 64 dispatched user prompts per arm, 12 provider requests per prompt, and 256 provider requests per arm.
- The stage group retains the 120-minute wall-time limit. Its guards cover preparation, forks, retries, and compaction attempts.
- A pilot uses four source sessions and twenty-four probe forks. A batch uses three new groups per stage by default.
- The pilot never contributes to the batch aggregate. No A history, answer, summary, or index enters B.
- Retain `clean-checkout-v1`, source checks before every HTTP attempt, SSE `store: false`, and no cached WebSocket continuation.
- Checkpoints stay in private host memory. Never restore from `PiJournal.entries()` or sanitized report JSON.
- No model tool can access checkpoint storage, sibling files, scoring keys, or host artifacts.
- Use integer token counts, USD for cost, and milliseconds for duration. Use a monotonic clock for durations and UTC timestamps for correlation.
- Unknown measurements stay unknown rather than becoming zero. Catalog estimates are not billed cost.
- No live pilot or batch starts until the offline gate passes, the implementation is approved and committed, and the user authorizes that run.

## Review Focus

1. A restored session has the right messages but the wrong paging calibration or cut. Task 1 compares replay outputs and subsequent request selection against uninterrupted SDK fixtures.
2. A broad lookup returns all five facts. Tasks 2 and 6 prove that siblings and the unknown control inherit none of its results.
3. A retry or abort produces no persisted assistant entry. Tasks 3 and 4 retain its dispatched attempt, usage presence, time, and incomplete totals.
4. SDK statistics include inherited preparation and compaction. Tasks 4 and 8 count preparation once and keep nested subtotals out of total additions.
5. A gate, artifact write, or cleanup fails after earlier successful probes. Tasks 6, 7, and 9 retain partial evidence and prevent dispatch or completion as required.

---

## Starting State and File Boundaries

The current controller sends six probes to each source conversation. `stageOpportunity()` accepts four qualified A targets, and request evidence is scored after dispatch. The usage ledger is indexed by persisted entries, so it cannot cover every failed HTTP attempt. `onHttpAttemptEnd()` currently records receipt of headers, not terminal stream consumption.

`createPiArm()` owns native SDK setup. `PiJournal.entries()` exports sanitized entries. Neither provides a full checkpoint. The paging extension resets its closure state on `session_start`.

Keep the existing small modules. Add focused modules rather than putting all new behavior into `pi-arm.ts`, `pair.ts`, or `report.ts`:

| Path | Responsibility |
| --- | --- |
| `eval/recall/paging-replay.ts` | Capture and replay the real paging lifecycle without provider calls. |
| `eval/recall/checkpoint.ts` | Own private native checkpoints, provenance, copying, and mutation detection. |
| `eval/recall/fork.ts` | Own one probe fork from creation through cleanup. |
| `eval/recall/metrics.ts` | Define ownership, measurement presence, and operation records. |
| `eval/recall/codex-stream.ts` | Observe consumed SSE events, attempt termination, and first deltas. |
| `eval/recall/cost.ts` | Apply native catalog pricing with explicit measurement requirements. |
| `eval/recall/task-metrics.ts` | Record prompt, tool, compaction, restoration, and host-phase intervals. |
| `eval/recall/probe-gate.ts` | Reject an invalid first probe payload before HTTP dispatch. |
| `eval/recall/stage-group.ts` | Prepare sources and schedule guarded, isolated probe forks. |
| `eval/recall/metric-summary.ts` | Reduce records into scoped totals, duration summaries, and paired differences. |
| `eval/recall/report-metrics.ts` | Render metric tables from those summaries. |

Modify the existing adapter, journal, controller, manifest, CLI, artifact writer, and report only at these boundaries. Keep `workload.ts`, `scoring.ts`, and SDK origin conversion as the existing sources of truth.

Tests use the real pinned SDK and `tests/fixtures/eval-recall-provider.ts`. Scripted controller fixtures remain useful, but cannot establish restoration fidelity. All fixture fetches remain local. No test reads real credentials or reaches a provider endpoint.

The existing untracked `node_modules` symlink predates this plan. Leave it untouched during planning. Before implementation, use ignored local dependencies or an excluded dependency link, and make sure that the source-integrity baseline is clean.

## Common Test Cycle

Every production-behavior task follows this cycle:

1. Add the named behavior tests and fixture assertions.
2. Run the task's command and establish a meaningful failure. A missing export can start the cycle, but the regression must also fail with the old behavior.
3. Implement the listed interfaces and requirements.
4. Rerun the task's tests and `npm run typecheck`. Fix relevant existing fixtures and tests in the same task.
5. Review the diff and make the listed focused commit. Stage only that task's files.

Use `node --test --experimental-strip-types <test paths>` for focused commands. Read the `commit` skill before each commit. Do not add tests that assert documentation wording, dependency pins, or static configuration literals.

### Task 1: Prove Host-Only Paging Restoration Offline

This is a blocking feasibility task. Do not begin Task 2 unless its evidence passes. A native history-copy test alone is insufficient.

**Files:**
- Create: `eval/recall/paging-replay.ts`
- Create: `tests/fixtures/eval-recall-checkpoint.ts`
- Create: `tests/eval-recall.paging-replay.test.ts`
- Modify: `tests/fixtures/eval-recall-provider.ts`
- Create: `docs/evals/isolated-recall-restoration.md` for safe offline findings

**Interfaces:**
- Consumes: the real `contextPagingExtension`, `createAgentSession()`, and `SessionManager.inMemory(cwd, options, entries)` from SDK 0.87.1.
- Produces: `createPagingReplay(settings: ContextPagingSettingsSources): PagingReplay`.
- `PagingReplay` exposes `factory: ExtensionFactory`, `freeze(): PagingReplayTape`, and `restore(session: AgentSession, tape: PagingReplayTape): Promise<RestorationEvidence>`.
- `PagingReplayTape` is an opaque host-only value. It contains complete event observations and native branch positions, not sanitized exports.
- `RestorationEvidence` contains `method: "host-lifecycle-replay-v1"`, `passed: boolean`, `checks: readonly { name: string; passed: boolean }[]`, and `failureCode: string | null`.
- Fixture helper: `prepareReplayFixture(caseName: "calibrated-cut" | "context-edit" | "native-summary" | "recovery-followup"): Promise<ReplayFixture>`. Its returned host fixture supplies source and restored sessions, replay tapes, dispatch counters, native comparison views, and an awaited `close()`.

- [ ] **Step 1: Add the failing restoration tests.**

Wrap the real extension factory's registration API. Observe each original handler's actual event, ordered invocation, context inputs, branch leaf, and result. Do not replace its selection algorithm.

The fixture prepares through deterministic local responses. Include an existing cut, nontrivial reported input calibration, resident system/tool overhead, a context edit, native summaries, and opaque assistant fields.

The recovery-followup fixture exercises the real recovery tools and their next request. It is a feasibility fixture, not valid stage preparation. Real source checkpoints still reject preparation with recovery calls.

Name the tests `replay reproduces calibrated selection without dispatch`, `replay preserves native projection and opaque fields`, and `repeated restore follows the same subsequent cut trajectory`. Their core assertions are:

```ts
assert.equal(restoration.passed, true);
assert.equal(dispatchesAfterRestore, dispatchesBeforeRestore);
assert.deepEqual(restoredNativeView, sourceNativeView);
assert.deepEqual(restoredReplayOutputs, capturedReplayOutputs);
assert.deepEqual(restoredNextPayload, uninterruptedNextPayload);
assert.deepEqual(restoredLaterSelections, uninterruptedLaterSelections);
```

Compare complete private values. Ignore only new session IDs, request IDs, and transport timestamps. Preserve message content, tool declarations, entry IDs, parent links, provider fields, context edits, summaries, and policy outputs.

- [ ] **Step 2: Run the red test cycle.**

Run: `node --test --experimental-strip-types tests/eval-recall.paging-replay.test.ts`.

Expected: restoration differs when only native entries are copied. At least one calibrated selection or later cut assertion fails. Record this failure before adding replay.

- [ ] **Step 3: Implement the replay candidate.**

Capture actual observed event and context values with deep copies. The tape records handler registration keys, not source closures. Invoke the corresponding original handlers registered by a fresh extension instance in the restored session.

Replay them in order at their corresponding restored branch positions. Preserve captured context messages, native projections, resident inputs, model metadata, and response usage. Assert that replay changes neither the source session nor its extension behavior.

Do not invoke a provider, score a probe, append an event to native history, or replay through the request journal. Restore the checkpoint leaf and normal SDK state before returning. A replay context facade can supply captured read-only inputs, but must not remain installed for the probe.

Compare each replay result to its captured result. Reject unsupported inputs, changed configuration, incomplete tapes, or any different result. Use a disposable clone for a comparison that calls a mutating handler. Never speculatively select context on the probe-ready session.

Prove policy fidelity through matching replay outputs and matching subsequent selection trajectories. Do not claim direct inspection of inaccessible extension closures or real provider reasoning. Synthetic opaque fixtures establish preservation only.

- [ ] **Step 4: Run the green tests and record the gate outcome.**

Run the focused command and `npm run typecheck`.

The safe findings document records SDK version, fixture cases, commands, zero additional restoration dispatches, passed properties, and limitations. Do not save raw checkpoints, tapes, opaque contents, or credentials there.

If any property fails without a production change, stop. Retain the failing offline evidence and report the exact property. A production checkpoint API or repeated fresh preparation requires a new design and user approval.

- [ ] **Step 5: Commit only the passing experiment or the safe blocked findings.**

Suggested passing subject: `feat(eval): prove host-only paging checkpoint replay`.

A blocked-findings commit does not permit the later tasks.

### Task 2: Own Native Checkpoints and Fork-Local State

**Files:**
- Create: `eval/recall/checkpoint.ts`, `eval/recall/fork.ts`, `eval/recall/metrics.ts` (ownership types only)
- Create: `tests/eval-recall.checkpoint.test.ts`
- Modify: `eval/recall/pi-arm.ts`, `eval/recall/pi-journal.ts`, `eval/recall/codex-payload.ts`, `eval/recall/evidence.ts`, `eval/recall/live-dependencies.ts`
- Modify: `eval/recall/pair.ts`, `eval/recall/cli.ts` for ownership plumbing only
- Modify: `tests/fixtures/eval-recall.ts`, `tests/fixtures/eval-recall-checkpoint.ts`
- Test: `tests/eval-recall.pi-arm.test.ts`, `tests/eval-recall.evidence.test.ts`
- Update ownership fixtures in: `tests/eval-recall.artifacts.test.ts`, `tests/eval-recall.cli.test.ts`, `tests/eval-recall.limits.test.ts`, `tests/eval-recall.pair-sdk.test.ts`, `tests/eval-recall.pair.test.ts`, `tests/eval-recall.report.test.ts`, `tests/eval-recall.codex-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1's replay factory, tape, and restoration evidence.
- Produces: opaque `PrivateCheckpoint`, `checkpointDigest(checkpoint: PrivateCheckpoint): string`, and safe `CheckpointEvidence`.
- Extend `EvalArm` with `captureCheckpoint(): Promise<PrivateCheckpoint>`.
- Extend `PiArmOptions` with `owner: SessionOwner` and `checkpoint?: PrivateCheckpoint`.
- Define `SessionOwner` in `metrics.ts`: `{ runId: string; stage: Stage; seed: string; arm: Arm; sessionId: string; checkpointId: string | null; forkId: string | null }`.
- The controller allocates `sessionId`. Pass it as `NewSessionOptions.id` to the native manager. Attach the eventual checkpoint ID to preparation through a safe source/checkpoint relationship without copying charged records.
- Extend `RequestMeta` with the owner fields. `promptId`, `requestId`, and `purpose` remain required.
- Add `runId` and the owner-bearing factory arguments to existing `PairOptions` and `LiveEval`. Keep the old controller's behavior until Task 7 connects the new controller.
- Define `ArmFactoryOptions`: `{ arm: Arm; owner: SessionOwner; checkpoint?: PrivateCheckpoint; requestGuard(meta: RequestMeta): void | Promise<void>; clock: Clock; eventSink?: (event: JournalEvent) => void }`.
- `runProbeFork(options: ProbeForkOptions): Promise<ProbeForkResult>` creates one fork, restores it, sends one `PromptStep`, captures its public snapshot, and awaits cleanup.
- `ProbeForkOptions` contains `checkpoint`, `owner`, `step`, `createArm: (options: ArmFactoryOptions) => Promise<EvalArm>`, `requestGuard`, `clock`, and `cleanupSession: (owner: SessionOwner) => Promise<void>`.
- `ProbeForkResult` contains safe checkpoint/restoration evidence, fork ownership, `inheritedPromptCount`, `snapshot: ArmSnapshot | null`, and `cleanup: { complete: boolean; failureCode: string | null }`.

- [ ] **Step 1: Add fork-isolation and capture-refusal tests.**

A settled source provides raw `getBranch()` entries, leaf, model/thinking/configuration, active tools, replay tape, and source-entry provenance. Capture refuses pending messages, streaming, retrying, compaction, a failed tool batch, prompt failure, a probe, or a recovery-tool execution during preparation.

Add `baseline restore retains native compaction without paging tools`. Compare native defaults, summaries, and selected input. Assert that none of the four paging tools appears in the baseline fork.

Restore two separate SDK sessions. Send one broad `search_history` call in the first fork through the real tool. Make its result expose multiple facts. Assert:

```ts
assert.notEqual(first.sessionId, second.sessionId);
assert.equal(checkpointDigest(checkpoint), originalDigest);
assert.deepEqual(secondInheritedInput, originalInheritedInput);
assert.equal(secondNewRequests.length, 0);
assert.equal(secondRecoveryResults.length, 0);
assert.equal(secondNewUsageRecords.length, 0);
```

Mutate an inherited nested object in one fork and make sure that the checkpoint and sibling remain unchanged. Repeat with an answer, tool error, compaction, and journal entry. Preserve revised-decision source IDs and quantity provenance.

Add `another fork cannot satisfy a recovery join`, with identical request and tool-call strings in different owners. Recovery credit requires the same run, stage, seed, arm, checkpoint, fork, prompt, request, and observed tool call before the final answer.

- [ ] **Step 2: Run the red test cycle.**

Run: `node --test --experimental-strip-types tests/eval-recall.checkpoint.test.ts tests/eval-recall.evidence.test.ts`.

Expected: sanitized capture, shared mutable state, or cross-fork joins fail their assertions.

- [ ] **Step 3: Implement private capture and fork creation.**

Capture inside `createPiArm()` where the native session is available. Never use `snapshot.entries` as restoration input. Deep-copy the complete active branch and tape per fork. Keep the digest private.

Each fork gets a new `SessionManager`, `AgentSession`, extension instance, observed runtime wrapper, journal, request registry, tool-call joins, and mutable continuation state. Share only immutable credential access. Enforce checkpoint configuration and restore the native leaf.

Keep the effective system prompt and tool definitions identical despite separate host resource directories. Run replay before normal journaling begins. A later source `session_shutdown` must not change its already captured tape.

Import source provenance and inherited successful compactions for origin and stage evidence. Mark them inherited. Do not import source request counters, recovery events, or charged usage into the fork's new-execution ledger. `promptCount` records lineage, while the shared guard counts actual dispatched user prompts.

Expose only checkpoint ID, source leaf, configuration fingerprint, restoration outcome, and inherited provenance in safe snapshots. Keep checkpoint handles and tapes out of result types passed to writers. Await abort, dispose, and resource cleanup even after setup or restoration fails.

- [ ] **Step 4: Run the green tests and typecheck.**

Run the focused command plus `tests/eval-recall.pi-arm.test.ts`, then `npm run typecheck`. Existing source/session setup tests must still pass.

- [ ] **Step 5: Commit.**

Suggested subject: `feat(eval): isolate checkpoint probe sessions and ownership`.

### Task 3: Observe Every HTTP Attempt Through Stream Termination

**Files:**
- Create: `eval/recall/codex-stream.ts`
- Modify: `eval/recall/metrics.ts`
- Modify: `eval/recall/codex-usage.ts`, `eval/recall/codex-runtime.ts`, `eval/recall/pi-journal.ts`, `eval/recall/pi-arm.ts`, `eval/recall/live-dependencies.ts`
- Modify: `tests/fixtures/eval-recall-provider.ts`
- Create: `tests/eval-recall.codex-stream.test.ts`
- Test: `tests/eval-recall.codex-runtime.test.ts`
- Modify deterministic clocks in: `tests/fixtures/eval-recall.ts`, `tests/eval-recall.pi-arm.test.ts`, `tests/eval-recall.limits.test.ts`, `tests/eval-recall.pair.test.ts`, `tests/eval-recall.cli.test.ts`

`metrics.ts` starts in Task 2 with ownership only. This task adds measurement and transport record types.

**Interfaces:**
- Consumes: Task 2 ownership and the pinned native Codex provider.
- Produces: `Measurement<T> = { value: T | null; status: MeasurementStatus; reason: string | null }`.
- `MeasurementStatus` is `"observed" | "derived" | "not-reported" | "not-supported" | "invalid" | "incomplete" | "not-applicable"`.
- Extend `Clock` with `utcNow(): string`. `nowMs()` remains monotonic and its timeout methods remain unchanged. Update deterministic clocks accordingly.
- Define `OperationStatus = "succeeded" | "failed" | "aborted" | "canceled" | "censored"` and `TimedOperation = { startedAtUtc: string; endedAtUtc: string | null; startMs: number; endMs: number | null; durationMs: Measurement<number>; status: OperationStatus }`.
- `AttemptRecord` includes complete owner/request identity, `attemptId`, purpose, HTTP status, a `TimedOperation`, `attemptWallMs`, `responseHeadersMs`, `timeToFirstModelDeltaMs`, `timeToFirstTextMs`, and safe provider-usage presence.
- `RequestRecord` includes owner, prompt, purpose, `requestId`, attempts, terminal status, and `requestWallMs`.
- Add `onRequestStart`, `onAttemptStart`, `onResponseHeaders`, `onAttemptSettled`, and `onRequestSettled` hooks in place of header-only completion. Give attempts separate IDs under their logical request.
- Preserve `onPayload` and `beforeHttpAttempt` as awaited pre-dispatch gates. An observation never bypasses those gates.
- `observeCodexStream(response: Response, options: StreamObservationOptions): Response` observes consumed bytes without replacement. Options contain owner/request/attempt IDs, clock, and usage/delta/settlement callbacks.

- [ ] **Step 1: Add deterministic stream and retry tests.**

Use chunked SSE fixture responses, a fake monotonic clock, and captured UTC timestamps. Include successful, non-2xx, throwing-fetch, tool-only, aborted, unterminated, and reader-error cases.

For one fixture, dispatch at `0`, headers at `3`, lifecycle events at `4`, a nonempty tool-argument delta at `7`, text at `11`, and terminal consumption at `19`:

```ts
assert.equal(attempt.responseHeadersMs.value, 3);
assert.equal(attempt.timeToFirstModelDeltaMs.value, 7);
assert.equal(attempt.timeToFirstTextMs.value, 11);
assert.equal(attempt.attemptWallMs.value, 19);
```

For a tool-only response, first-model-delta remains measured and first-text remains `null` with a reason. Empty deltas, lifecycle events, and usage events do not start either delta metric.

Script two attempts under one logical request. Make sure that both survive, the failed attempt's usage remains attached to it, and request duration includes backoff. A wire-gate rejection creates no dispatched attempt.

- [ ] **Step 2: Run the red test cycle.**

Run: `node --test --experimental-strip-types tests/eval-recall.codex-stream.test.ts tests/eval-recall.codex-runtime.test.ts`.

Expected: the old observer ends at headers, drops retry-level usage, and lacks first-delta measurements.

- [ ] **Step 3: Implement transport observations.**

Start an attempt immediately before actual fetch dispatch, after source, artifact, limit, and wire checks. Finish it on terminal consumption, failure, or abort, not receipt of headers. Finish the logical request when the native stream settles.

Keep the native adapter's bytes, headers, cancellation, backpressure, errors, and retry policy unchanged. Do not clone or read ahead. Retain only allowlisted numeric usage fields and safe event metadata. Bound observer buffering and report an incomplete observation instead of a fabricated zero.

Capture reasoning-token presence from `output_tokens_details.reasoning_tokens` when reported. Preserve omitted versus explicit zero and invalid numeric fields. A failed or aborted attempt remains recorded even without a successful assistant entry.

- [ ] **Step 4: Run the green tests and typecheck.**

Run both focused test files and `npm run typecheck`. Make sure that raw response bodies and opaque signatures do not enter observations.

- [ ] **Step 5: Commit.**

Suggested subject: `feat(eval): measure attempts retries and streamed response time`.

### Task 4: Normalize Measured Tokens and Native Catalog Cost

**Files:**
- Create: `eval/recall/cost.ts`
- Modify: `eval/recall/usage.ts`, `eval/recall/metrics.ts`, `eval/recall/codex-usage.ts`, `eval/recall/pi-journal.ts`
- Create: `tests/eval-recall.cost.test.ts`
- Modify: `tests/eval-recall.usage.test.ts`

**Interfaces:**
- Consumes: attempt records and safe provider usage from Task 3, SDK `Usage`, and the exact pinned model.
- Produces: `normalizeAttemptUsage(attempt: AttemptRecord, sdkUsage: Usage | null): NormalizedUsage`.
- `NormalizedUsage` requires measurements named `totalInputTokens`, `uncachedInputTokens`, `outputTokens`, `reasoningTokens`, `totalTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `cacheReadFraction`.
- Produce `describePricing(model: Model<Api>): PricingEvidence` and `priceAttempt(usage: NormalizedUsage, model: Model<Api>, evidence: PricingEvidence): CostMeasurements`.
- `CostMeasurements` requires `uncachedInputCostUsd`, `outputCostUsd`, `cacheReadCostUsd`, `cacheWriteCostUsd`, `estimatedCostUsd`, `knownCostSubtotalUsd`, and `actualCostUsd` measurements.
- `PricingEvidence` records USD, catalog pricing units, tiers, metadata fingerprint, pinned provider mapping, applicable charges, and missing requirements. Use the native `calculateCost(model, usage)` rather than a replacement pricing formula.
- Produce `ExecutionUsageLedger` keyed by owner plus logical request and attempt, independent of persisted assistant entries. SDK assistant, explicit-usage, and compaction entries provide joins and cross-checks, not extra charges.
- Keep the historical `aggregateUsage(ledger: readonly UsageLedgerEntry[]): UsageSummary` available while the old controller remains wired. Task 7 replaces those consumers. It never supplies the new actual-dispatch totals.

- [ ] **Step 1: Add token, pricing, and deduplication tests.**

For provider input `100`, cached input `20`, output `7`, and reasoning subset `3`, assert:

```ts
assert.equal(usage.totalInputTokens.value, 100);
assert.equal(usage.uncachedInputTokens.value, 80);
assert.equal(usage.outputTokens.value, 7);
assert.equal(usage.reasoningTokens.value, 3);
assert.equal(usage.totalTokens.value, 107);
assert.equal(usage.cacheReadFraction.value, 0.2);
assert.equal(usage.cacheWriteTokens.value, null);
assert.equal(usage.cacheWriteTokens.status, "not-reported");
```

Repeat with explicit cache-write `0`, zero input, inconsistent cached input, invalid fields, omitted reasoning, and missing input. Unknown required operands propagate to derived values.

Compare priced components with native `calculateCost()` for complete usage, including a catalog tier boundary. Missing prices or applicable usage leave the complete estimate unknown but retain a labeled partial subtotal. Actual billed cost remains `null` without attributable billing evidence.

Add `failed attempts survive without SDK entries` and `SDK joins do not duplicate dispatched usage`. One preparation attempt plus two new fork attempts contributes three attempts, not three copies of preparation. Two compaction requests joined to one entry count twice as requests, once each as usage, and only as a subtotal of scope totals.

- [ ] **Step 2: Run the red test cycle.**

Run: `node --test --experimental-strip-types tests/eval-recall.usage.test.ts tests/eval-recall.cost.test.ts`.

Expected: the old ledger mislabels uncached input as total input and loses unpersisted attempts.

- [ ] **Step 3: Implement provider-presence normalization and cost.**

Retain safe provider fields and their exact normalized mapping. Use SDK normalization only when provider evidence supports its inputs. Independently observed total input remains available when a cache component is missing.

Cache reads/writes are input components. Reasoning is an output subset. Never add either to their total again. Never infer reasoning from opaque fields or text length.

Establish charge applicability from the pinned provider mapping and catalog, not omission. An unsupported cache-write usage field remains `null` even if documented as a non-applicable charge. Only that evidence can remove it as a complete-estimate requirement.

Deduplicate equivalent provider observations by full attempt ownership. Conflicting observations remain invalid. Join persisted records for diagnostics without summing them again. Keep SDK session statistics separate, including inherited preparation.

- [ ] **Step 4: Run the green tests and typecheck.**

Run both focused files and `npm run typecheck`.

- [ ] **Step 5: Commit.**

Suggested subject: `feat(eval): preserve measured usage and native cost components`.

### Task 5: Record Prompt, Probe, and Host-Phase Time

**Files:**
- Create: `eval/recall/task-metrics.ts`
- Modify: `eval/recall/metrics.ts`, `eval/recall/pi-arm.ts`, `eval/recall/pi-journal.ts`, `eval/recall/fork.ts`, `eval/recall/checkpoint.ts`
- Create: `tests/eval-recall.task-metrics.test.ts`
- Test: `tests/eval-recall.pi-arm.test.ts`

**Interfaces:**
- Consumes: Task 3's clock, ownership, operation statuses, and request records.
- Produces: `createTaskRecorder(clock: Clock): TaskRecorder` with `begin(phase: PhaseName, owner: OperationOwner): string`, `end(operationId: string, status: OperationStatus): void`, and `records(): readonly PhaseRecord[]`.
- `OperationOwner` extends session ownership with nullable `promptId`, `requestId`, and `toolCallId`. Every row identifies its task and phase.
- Define `PhaseName = "source-setup" | "prompt" | "tool" | "compaction" | "fork-setup" | "checkpoint-restore" | "checkpoint-capture" | "scoring" | "artifact-write" | "cleanup" | "probe" | "stage-group" | "run"`.
- `PhaseRecord` includes identity, tool name when applicable, interval, terminal status, and measurement presence.
- Add `promptTaskMs`, `toolWallMs`, `compactionWallMs`, `forkSetupMs`, `checkpointRestoreMs`, and `probeTaskMs` to their respective records. Later reducers produce preparation/arm totals and group/run wall durations.

- [ ] **Step 1: Add deterministic boundary tests.**

A prompt starts at `10`, its provider request runs from `12` to `20`, a tool runs from `20` to `25`, and final idle occurs at `40`. Assert prompt duration `30` and tool duration `5`, without adding either nested duration again.

A fork starts at `0`. SDK setup ends at `5`, and restoration ends at `8`. The prompt settles at `40`, and scoring ends at `42`. Artifact writes end at `47`, and cleanup ends at `50`:

```ts
assert.equal(metrics.forkSetupMs.value, 5);
assert.equal(metrics.checkpointRestoreMs.value, 3);
assert.equal(metrics.probeTaskMs.value, 50);
```

Add successful, failed, canceled-before-start, and aborted compaction cases. Count attempts observed at `session_before_compact`, including paging cancellations, without treating cancellations as native successes.

Make sure that overlapping host intervals remain available and are not added as wall time. A missing required start or end produces incomplete timing evidence. Failures carry their terminal status instead of successful-completion labels.

- [ ] **Step 2: Run the red test cycle.**

Run: `node --test --experimental-strip-types tests/eval-recall.task-metrics.test.ts tests/eval-recall.pi-arm.test.ts`.

Expected: cumulative `latencyMs` alone cannot satisfy these per-operation assertions.

- [ ] **Step 3: Instrument the defined boundaries.**

Wrap `session.prompt()` through `waitForIdle()` or failure. Join SDK tool execution starts/ends by call ID and owner. Track compaction attempts from the extension boundary through success, cancellation, or failure.

Separate fork resource/SDK setup from replay. Keep checkpoint capture, scoring, artifact writes, and cleanup as host phases. Keep a probe open until cleanup and its artifact writes settle.

A fork can write its evidence through an awaited callback before it returns. Finalize the probe duration after cleanup, then persist that final timing record. Mark the run incomplete if either write fails. Do not recurse by counting the timing-record write as another probe artifact task.

Source preparation active time includes setup, preparation prompt tasks, and checkpoint capture. Exclude waits for the other arm. Keep stage and run intervals open until their required cleanup and artifacts settle.

- [ ] **Step 4: Run the green tests and typecheck.**

Run both focused files and `npm run typecheck`.

- [ ] **Step 5: Commit.**

Suggested subject: `feat(eval): record task restoration and cleanup timing`.

### Task 6: Run Stage Groups With Five Independent Wire Gates

**Files:**
- Create: `eval/recall/probe-gate.ts`, `eval/recall/stage-group.ts`
- Modify: `eval/recall/pair-stages.ts`, `eval/recall/request-guard.ts`, `eval/recall/pi-journal.ts`, `eval/recall/evidence.ts`
- Modify: `tests/eval-recall.limits.test.ts`, `tests/eval-recall.evidence.test.ts`, `tests/fixtures/eval-recall.ts`
- Create: `tests/eval-recall.stage-group.test.ts`, `tests/eval-recall.probe-gate.test.ts`

**Interfaces:**
- Consumes: `runProbeFork()`, private source checkpoints, shared request guards, and existing workload/scoring functions.
- Produces: `runStageGroup(options: StageGroupOptions): Promise<StageGroupResult>` in `stage-group.ts`.
- Add `checkpointOpportunity(workload: Workload, stage: Stage, snapshots: Snapshots): { ready: boolean; qualifiedKnown: number; reason: string | null }` to `pair-stages.ts`. It uses all-five candidate exclusion without changing the legacy `stageOpportunity()` until Task 7.
- `StageGroupOptions` contains `runId`, `seed`, `stage`, `firstArm`, optional workload/limits/clock, `createArm(options: ArmFactoryOptions): Promise<EvalArm>`, `cleanupSession(owner: SessionOwner): Promise<void>`, and awaited progress/ready callbacks.
- `StageGroupResult` contains stage/seed/order, preparation steps, safe source snapshots, checkpoint evidence, twelve fork results, six paired probe outcomes, five-of-five stage evidence, counters, phase/usage records, errors, stop reason, cleanup evidence, and status.
- Produce `qualifyInitialProbe(input: ProbeGateInput): ProbeGateResult`. Input contains owner, probe, `sourceFacts: readonly FactVersion[]`, latest fact, request evidence, and checkpoint source provenance. Result contains `qualified`, a safe failure code, and visibility evidence.
- Preserve existing `createRequestGuard()` values and flag names. Its one instance spans both source preparations and all forks in a stage group.

- [ ] **Step 1: Add controller, gate, and shared-limit regressions.**

Make preparation checkpoints available after at least 23 prompts. Assert two sources plus twelve forks per complete group. Each fork's lineage includes preparation plus exactly one probe. Neither source receives a probe. Both arms receive identical preparation and probe text.

For A, require zero successful baseline compactions throughout each complete fork response. For B, require a fresh seed and native baseline compaction/source exclusion, while accepting a correct answer from its inherited summary. Both candidate checkpoints exclude all five paging sources and current answers.

Add `visible fifth paging answer blocks dispatch`, `missing source provenance blocks qualification`, and `incomplete payload blocks dispatch`. Also cover ambiguous quantities, wrong units, tool declarations containing an answer, and opaque presence with no readable answer.

For the fifth-answer fixture, make sure that the rejected fork has zero HTTP dispatches and the stage stops instead of sending more work. Previously completed forks remain in results. Wrong final answers do not stop a structurally sound group.

Run probe-order permutations, including the unknown control first and last:

```ts
assert.deepEqual(perProbeInheritedInputs(orderOne), perProbeInheritedInputs(orderTwo));
assert.equal(checkpointDigest(checkpoint), originalDigest);
assert.equal(result.stageEvidence.qualifiedKnown, 5);
assert.equal(result.probes.filter(row => row.probe.factId === null).length, 1);
```

Preparation followed by a fork retry must consume the same arm allowance. Reserve six dispatched probe prompts per arm. At the minimum, the guard counts `23 + 6 = 29`, while each lineage counts `23 + 1 = 24`. Restoration consumes no prompt/request allowance and cannot clear a latched stop.

- [ ] **Step 2: Run the red test cycle.**

Run: `node --test --experimental-strip-types tests/eval-recall.stage-group.test.ts tests/eval-recall.limits.test.ts tests/eval-recall.probe-gate.test.ts tests/eval-recall.evidence.test.ts`.

Expected: six probes in one conversation, four-of-five qualification, and post-dispatch-only checks fail.

- [ ] **Step 3: Replace group execution and enforce the wire gate.**

Prepare both arms in the recorded first-arm order with shared prompts. Select the boundary from observed preparation evidence, not scores. Require 23 preparation prompts, all-five paging exclusion, and the selected stage's native-compaction condition before capture.

At A's early compaction boundary, report inconclusive. Do not lower a budget, force compaction, or relabel A. At B, retain native summaries and start with fresh A-independent sources.

Freeze both checkpoints before any probe. Create one fork per arm for each of the six deterministic probe texts. Stop the stage's probe group on a failed known paging gate or restoration. Do not rebuild the checkpoint or continue filling to repair it.

Run the gate on the actual first outgoing conversation SSE payload before the first HTTP attempt. Require complete matching ownership, original source evidence/exclusion, exact latest-answer absence across all readable blocks, and no sibling content.

Include every supplied source version for the target, especially both decision records. Preserve the quantity's subject, field, and `ms` unit checks. Opaque presence alone cannot establish readable absence. Use host scoring data only inside this gate. Forward the native payload unchanged after it passes.

Keep recovery tools unrestricted. Broad results remain useful within the requesting fork. Tighten recovery joins to the same observed tool call, request, and owner. Unknown controls have no recovery denominator or host-supported answer.

Return structural status separately from scores. Always retain observations and settle every created resource, including setup that completes after a deadline.

- [ ] **Step 4: Run the green tests and typecheck.**

Run the focused command and `npm run typecheck`. Existing source-drift and artifact-guard behavior must remain fail-closed.

- [ ] **Step 5: Commit.**

Suggested subject: `feat(eval): gate five isolated probes per stage checkpoint`.

### Task 7: Version Artifacts and Require Restoration for Eligibility

**Files:**
- Modify: `eval/recall/experiment-settings.ts`, `eval/recall/manifest.ts`, `eval/recall/artifacts.ts`, `eval/recall/safe-artifacts.ts`, `eval/recall/cli.ts`, `eval/recall/live-dependencies.ts`
- Modify: `eval/recall/report.ts`, `eval/recall/pair-stages.ts` for new result types and removal of legacy controller helpers
- Delete: `eval/recall/pair.ts`
- Modify: `tests/eval-recall.artifacts.test.ts`, `tests/eval-recall.cli.test.ts`, `tests/eval-recall.source-integrity.test.ts`, `tests/eval-recall.pair.test.ts`, `tests/eval-recall.pair-sdk.test.ts`, `tests/eval-recall.report.test.ts`

**Interfaces:**
- Consumes: safe `StageGroupResult`, ownership/metric records, restoration evidence, and clean-source snapshots.
- Produces: schema-v3 `RunManifest`, `completeStageGroup(result: StageGroupResult): boolean`, and the updated `isEligiblePilot()` using stage groups.
- Manifest adds restoration method, pricing evidence, deterministic probe order, source/fork counts, and stage/checkpoint configuration identities to the experiment fingerprint.
- Artifact results use `{ stageGroups: StageGroupResult[] }`. Each group has separate `preparation/<arm>/` and `probes/<probe-id>/<arm>/` evidence directories.
- Update `LiveEval` to expose `runStageGroup`, owned source/fork creation, and awaited per-session plus whole-run cleanup.
- Writer `finish()` accepts one stage group. Completion identifies schema, run/hash, both pilot stages, offline gate evidence, resource cleanup, mandatory harness timing, and finalized artifacts.

- [ ] **Step 1: Add artifact, eligibility, and failure tests.**

A new pilot contains A and B with distinct seeds, four sources, and twenty-four forks. A default batch schedules three new groups per stage, alternates first arm within each stage, and excludes pilot seeds/results from aggregation.

Reject schema 1 and 2 pilots, missing restoration evidence, and mismatched restoration method/configuration. Also reject visible fifth probes, mixed-stage forks, dirty sources, missing stages, incomplete trace ownership, and lost mandatory harness timing. Preserve structurally sound wrong answers.

Missing optional provider usage does not block recall eligibility if explicitly recorded. A missing host timer or ownership join does block a complete record.

Add failure injection for restoration, the last artifact write, fork cleanup, and final resource cleanup. Assert:

```ts
assert.equal(await exists(completionPath), false);
assert.equal(batchProviderDispatches, 0);
assert.equal(partialEvidenceRetained, true);
```

Make sure that artifact JSON retains safe reason codes and owner IDs but contains no checkpoint/tape object, private digest, credentials, raw provider body, or opaque signature content. Retain existing permission and output-location tests.

- [ ] **Step 2: Run the red test cycle.**

Run: `node --test --experimental-strip-types tests/eval-recall.artifacts.test.ts tests/eval-recall.cli.test.ts tests/eval-recall.source-integrity.test.ts`.

Expected: old pilot structures, incomplete finalization, and unsafe fork exports cannot pass.

- [ ] **Step 3: Implement schema, scheduling, and eligibility.**

Set the three exact experiment identities from Global Constraints. Include restoration and pricing mapping evidence in fingerprints. Keep source revision and native model metadata matching at all existing preflight and dispatch boundaries.

Connect `runStageGroup()` to the CLI and remove shared-probe `runPair()`. Migrate its consumers and tests in this task. Keep existing score rendering working with the new result type. Task 8 adds the metric tables.

Schedule one A group and one B group for the pilot. Preserve `--pairs` as repetitions per stage and existing limit flags. Record probe order explicitly. Never start a batch automatically.

Serialize public records only. Keep raw checkpoint storage outside all writer inputs. Use allowlisted diagnostic codes for measurement reasons, gate failures, and restoration failures. Never copy an exception message into those fields.

Retain historical shared-probe scores as historical observations, never isolated recovery evidence or batch authorization.

Completion follows successful cleanup and finalized mandatory records. Measure report/artifact work before publishing completion. Write the final run timing through one bounded finalization step, not recursive self-timing. If the completion write fails, no successful run record exists.

Keep safe partial results after errors. Do not catch a writer or source failure and continue provider work.

- [ ] **Step 4: Run the green tests and typecheck.**

Run the focused command and `npm run typecheck`. Run existing report tests after adapting their structural fixtures to schema 3.

- [ ] **Step 5: Commit.**

Suggested subject: `feat(eval): version isolated artifacts and restoration eligibility`.

### Task 8: Aggregate Metrics and Render Paired Comparisons

**Files:**
- Create: `eval/recall/metric-summary.ts`, `eval/recall/report-metrics.ts`
- Modify: `eval/recall/report.ts`, `eval/recall/artifacts.ts`, `eval/recall/metrics.ts`
- Create: `tests/eval-recall.metric-summary.test.ts`
- Modify: `tests/eval-recall.report.test.ts`

**Interfaces:**
- Consumes: execution usage/cost records, timed operations, dispatch counts, stage groups, and manifest metadata.
- Produces: `summarizeMetrics(manifest: RunManifest, groups: readonly StageGroupResult[]): RunMetricsSummary`.
- `RunMetricsSummary` contains per-preparation, per-probe, per-arm, per-stage-group, per-stage, and run summaries, plus paired paging-minus-baseline rows by stage/seed/probe.
- Each aggregate retains `value`, status/reason, measured subtotal, observed/missing counts, and sample count. Never turn a measured subtotal into a complete total.
- Produce `pairedMeasurement(paging: Measurement<number>, baseline: Measurement<number>): Measurement<number>` and `summarizeDurations(records: readonly TimedOperation[]): DurationSummary`.
- Duration summaries retain individual values, total, mean, median, minimum, maximum, terminal-status counts, and measurement coverage. Separate conversation and compaction responses.
- `renderMetricTables(summary: RunMetricsSummary): string[]` renders token/cache, cost components, response/task timing, counts, missing-data, and paired-comparison tables.

- [ ] **Step 1: Add scope and arithmetic tests.**

Use complete records with preparation input `100`, baseline fork inputs `10` and `20`, paging fork inputs `15` and `25`, plus inherited SDK statistics of `100` in every fork.

```ts
assert.equal(baselineArm.totalInputTokens.value, 130);
assert.equal(pagingArm.totalInputTokens.value, 140);
assert.equal(armInputDifference.value, 10);
assert.equal(firstProbeInputDifference.value, 5);
```

Restore/replay adds time but no usage. Compaction and tools remain nested explanatory subtotals. Stage totals include both arms once, and run totals include each executed stage group once.

Use cache reads/input of `9/10` and `0/90`. The aggregate cache-read fraction is `9/100 = 0.09`, not the mean `0.45`.

Use response durations `10`, `20`, and `60`. Assert total `90`, mean `30`, median `20`, range `10..60`, and sample count `3`. Failed/aborted observations remain visible and separate from successful response summaries.

Remove one required usage measurement. Assert complete total and paired delta are `null`, while measured subtotal and coverage remain available. Do not infer cost/cache/speed gains from unknown values.

- [ ] **Step 2: Run the red test cycle.**

Run: `node --test --experimental-strip-types tests/eval-recall.metric-summary.test.ts tests/eval-recall.report.test.ts`.

Expected: entry-based arm totals, cumulative latency, and the old report cannot satisfy these scopes.

- [ ] **Step 3: Implement reductions and report tables.**

Reduce actual dispatched records only. Count preparation once per arm plus new fork execution. Recompute fractions from token totals. Calculate differences only from complete comparable operands.

Show preparation differences, probe differences, and whole-arm differences separately. Include total input, output, cache reads/writes, catalog cost, request counts, prompt time, and probe time. Include tool counts by name, retries, provider errors, and native compaction attempts/successes/failures/cancellations.

Keep `promptTaskMs` distinct from `probeTaskMs`. Show `preparationActiveMs`, `armActiveMs`, `stageGroupWallMs`, and `runWallMs`. Preserve overlapping host intervals without adding them twice.

Render component costs, partial subtotals, complete catalog estimates, and unsupported actual billing separately. Include pricing assumptions, missing-field reasons, and coverage beside aggregates in JSON and Markdown.

Retain stage/seed groups and score categories. Six sibling forks are not six independent preparation samples. Keep A/B separate and all invalid or wrong observations visible. Preserve the opaque-reasoning caveat and unrestricted-retrieval interpretation.

- [ ] **Step 4: Run the green tests and typecheck.**

Run both focused files and `npm run typecheck`. Report tests prove computed behavior and safe rendering, not exact documentation wording.

- [ ] **Step 5: Commit.**

Suggested subject: `feat(eval): report paired token cost cache and task metrics`.

### Task 9: Prove the Whole Offline Flow and Update the Run Guide

**Files:**
- Modify: `tests/eval-recall.pair-sdk.test.ts`, `tests/eval-recall.cli.test.ts`, `tests/fixtures/eval-recall-provider.ts`, `tests/fixtures/eval-recall-checkpoint.ts`
- Modify: `docs/evals/full-budget-recall.md`, `docs/evals/isolated-recall-restoration.md`
- Modify: `eval/recall/cli.ts` for accurate provider-free dry-run output

**Interfaces:**
- Consumes: the completed real SDK adapter, stage controller, writer, report, and schema-v3 eligibility checks.
- Produces: permanent offline integration evidence, updated operating instructions, and a provider-free dry run. It produces no live recall-effectiveness claim.

- [ ] **Step 1: Add full-budget SDK integration regressions.**

Run A and B with distinct deterministic seeds, actual native metadata, 128,000/80,000 paging, and native compaction defaults. Use local SSE fixtures rather than reduced live budgets.

Make one real history lookup return all five target facts. A sibling and the unknown control must still start from the uncontaminated checkpoint. Make the unknown control answer `null` without receiving a host value. Include a revised decision and quantity source.

Assert four source sessions, twenty-four forks, five qualified known paging probes in each stage, at least 24 user prompts per fork lineage, and source/fork disposal. Assert source and fork usage counts against actual local dispatches, with replay dispatch delta zero.

Exercise the real CLI/writer with a missing optional provider field, an unpersisted failed attempt, restoration failure, source drift, artifact failure, and cleanup failure. Only otherwise complete runs can emit completion. Wrong answers remain scored observations, not infrastructure failures.

- [ ] **Step 2: Run the red test cycle.**

Run: `node --test --experimental-strip-types tests/eval-recall.pair-sdk.test.ts tests/eval-recall.cli.test.ts`.

Expected: any remaining mismatch between scripted controller behavior and the real restored SDK path fails.

- [ ] **Step 3: Fix integration seams and update the guide.**

The guide explains source preparation, checkpoint fidelity, independent forks, A/B gates, five-of-five qualification, and the unknown control. Update pilot/batch counts, schema identity, artifacts, shared guard scope, metrics, and opaque-state limits.

Remove the former guide's automatic live-pilot execution assumption. Explain that a fresh pilot and a later batch each need separate user authorization. Preserve clean-source and permission instructions.

Keep `--dry-run` provider-free: no credentials, source/fork sessions, or requests. Print the new conversation structure, minimum lineage, shared limits, counts, metric scopes, and offline-gate requirement. Do not test its prose as static content.

- [ ] **Step 4: Run final offline verification.**

Run from the task worktree:

```sh
npm run check
npm run eval:recall -- --dry-run
npm run eval:recall
git diff --check
git diff 7595663 -- src/ package.json package-lock.json
```

Expected: typecheck, all tests, and packed-artifact smoke checks pass. Both eval commands report a dry run and make zero provider requests. Whitespace checking passes. The last diff is empty because production code and dependency pins are unchanged.

Retain the focused replay/SDK test outcomes in the safe offline findings. Review required observation coverage and failure reporting against the spec. Documentation/static configuration receive direct review and these commands, not new content-assertion tests.

- [ ] **Step 5: Commit and stop for user review.**

Suggested subject: `test(eval): verify isolated SDK flow and document run gates`.

Present the final diff, offline gate evidence, verification results, residual limitations, and source revision. Do not run `--pilot` or `--batch`. Ask for implementation review and separate paid-run authorization only after all offline checks pass.

## Self-Review and Handoff

Before presenting this plan, make sure that every spec requirement has an owner:

| Spec requirement | Tasks |
| --- | --- |
| Native history, opaque fields, lifecycle replay, calibration, cuts, repeated restoration | 1, 2, 9 |
| Settled capture, private checkpoints, distinct mutable state and provenance | 2 |
| No sibling/unknown contamination, unrestricted broad recovery, order independence | 2, 6, 9 |
| A/B boundaries, minimum lineage, five-of-five pre-dispatch qualification | 6, 9 |
| Same-fork recovery joins and unchanged exact/stale/unknown scoring | 2, 6, 9 |
| Attempt usage, retries, failed requests, first deltas, stream termination | 3, 4 |
| Token/cache definitions, native costs, presence, partial totals, billed-cost limits | 4, 8 |
| Prompt/tool/compaction/setup/restore/probe/preparation/arm/group/run time | 3, 5, 7, 8 |
| Ownership, counts, coverage, paired comparisons, stage/seed sample structure | 2, 3, 5, 8 |
| Schema/fingerprint, historical pilots, artifact privacy, completion eligibility | 7 |
| Shared guards, source integrity, cleanup, partial failure evidence | 2, 6, 7, 9 |
| Repository checks, provider-free dry run, no paid execution without approval | 1, 9 |

Then scan each task for exact interface names, checkable steps, meaningful test failures, and unsupported assumptions. Read the plan against the spec, not only against its tests. Fix gaps before handoff.

Recommend native execution because the nine tasks share restoration, ownership, and measurement interfaces. It avoids repeated handoff costs while keeping the offline feasibility gate first. If the user chooses delegated execution, the parent owns orchestration and keeps one writer active in a shared checkout.

Ask the user to review this plan and select native or subagent-driven execution. Do not begin implementation during this planning request.
