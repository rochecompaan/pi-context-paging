# Full-Budget Recall Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Delegation requires the owner's execution choice. Direct execution is the default.

**Goal:** Compare exact historical recall in real Pi sessions with native compaction and with 128K context paging.

**Architecture:** A seeded workload feeds two isolated Pi SDK sessions in a shared prompt sequence. Pure scoring and trace analysis distinguish readable resident facts from observed tool recovery. A controller gates the two recall stages, and a host-only report records complete and incomplete runs.

**Tech Stack:** TypeScript, Node.js 22.19.0 or newer, `node:test`, and the repository-pinned Pi SDK 0.87.1. Use existing dependencies and Node.js standard libraries.

**Spec:** `docs/specs/2026-10-04-full-budget-recall-eval-design.md`

## Global Constraints

- Work in `.worktrees/context-paging-recall-eval` on `eval/context-paging-recall`.
- The design commit is `6c14333`. Read the complete spec before implementation.
- Do not change production files under `src/`, package versions, dependencies, or the lockfile.
- Use `openai-codex/gpt-6-luna` and effective `xhigh` thinking without fallback.
- Preserve the native model window and native compaction defaults: 16,384 reserve tokens and 20,000 recent tokens.
- Use the real paging factory with `tokenBudget: 128000` and `trimToTokens: 80000`.
- Disable built-in tools and unrelated extensions, skills, prompt templates, and context files in both arms.
- Use full-payload SSE requests with `store: false`. Disable cached WebSocket continuation in both arms.
- Keep encrypted reasoning in the live sessions. Export only its counts and hashes, not encrypted signatures.
- Describe absence from readable text, not absence from all model state or proof that the model forgot a fact.
- Send identical user prompts to both arms. Wait for Pi's idle boundary after every prompt.
- Each valid pair contains at least 24 user prompts per arm and both recall stages.
- Each stage contains five known probes and one unknown probe. The stage target sets are disjoint.
- Work packets target 8,000 to 12,000 estimated tokens. Do not fill packets with repeated paragraphs.
- Keep answer keys and artifacts outside both model contexts. No LLM judge, file tool, shell tool, or alternate recovery tool is allowed.
- Default limits: 64 user prompts per arm, 12 provider requests per prompt, 256 provider requests per arm, 120 minutes per pair.
- Use one separate valid pilot before a batch of three matched pairs. Alternate the first arm between pairs.
- Require the `clean-checkout-v1` policy before live preflight. Keep the full recorded Git revision and checkout unchanged throughout each run.
- Store results under `.pi/evals/full-budget-recall/<run-id>/`. This directory is already ignored.
- Label costs as catalog estimates. Unknown usage is not zero, and Codex estimates are not invoices or quota guarantees.
- Fake-provider and pure-unit fixtures are not effectiveness evidence. No small-budget live runs are part of this plan.
- Do not launch workers or reviewers until the owner selects an execution method.

## Review Focus

1. Unknown Codex input items or opaque signatures must not produce false absence claims. Pin this in Task 3.
2. A broad stage A recovery can expose a stage B target. Record contamination and exclude invalid comparisons in Task 5.
3. HTTP retries and compaction calls can bypass a simple request counter. Count actual attempts before dispatch in Tasks 4 and 5.
4. Model metadata changes or stale pilot artifacts must not authorize a mismatched batch. Pin this in Tasks 4 and 6.
5. Baseline compaction can occur during the first probe group. Preserve the actual timing and mark stage A inconclusive in Task 5.
6. Summary origins must use canonical SDK conversion, including the wrapper and outgoing role. Pin this in Tasks 3 and 4.
7. SDK usage normalization erases missing-field presence. Capture that presence at the transport boundary in Task 4 and aggregate it in Task 6.
8. Uncommitted source changes at unchanged HEAD must block live preflight and stale pilot eligibility. Pin this in Task 6.

---

## File Structure and Dependency Order

| File | Responsibility |
| --- | --- |
| `eval/recall/workload.ts` | Private fact versions, seed prompts, and public probe steps |
| `eval/recall/packets.ts` | Coherent incident work packets with measured sizes |
| `eval/recall/scoring.ts` | Strict JSON answer parsing and exact scoring |
| `eval/recall/codex-payload.ts` | Read-only Codex payload decoding and opaque-item metadata |
| `eval/recall/evidence.ts` | Readable visibility, contamination matching, and recovery evidence |
| `eval/recall/safe-artifacts.ts` | Safe copies for artifact export |
| `eval/recall/codex-runtime.ts` | Exact-model preflight and observed SSE provider dispatch |
| `eval/recall/pi-arm.ts` | One real Pi session, its events, snapshots, and cleanup |
| `eval/recall/pair.ts` | Shared prompt sequence, stage gates, limits, and pair outcomes |
| `eval/recall/usage.ts` | Complete or unknown totals from the typed usage ledger |
| `eval/recall/report.ts` | Manifests, eligibility fingerprints, private artifacts, and reports |
| `eval/recall/cli.ts` | Argument parsing and pilot or batch orchestration |
| `eval/recall/source-integrity.ts` | Clean-checkout verification at a fixed Git revision |
| `scripts/recall-eval.ts` | Thin executable entry point |
| `tests/fixtures/eval-recall.ts` | Pure fixtures and a scripted arm for controller tests |
| `tests/fixtures/eval-recall-provider.ts` | A deterministic native provider for real-SDK tests |
| `tests/eval-recall.*.test.ts` | Focused tests for the modules above |
| `docs/evals/full-budget-recall.md` | Operating guide and result interpretation |

Tasks 1 and 2 establish the workload and scoring contracts.
Task 3 consumes those contracts.
Task 4 supplies the real session adapter.
Task 5 connects the workload, evidence, and adapters.
Task 6 adds a usable CLI and durable output.
Task 7 supplies full-budget live evidence.

Keep modules focused and preferably smaller than 200 meaningful lines.
If a module exceeds 400 meaningful lines, split an independent responsibility before its task commit.
Do not add barrel files or generic utility modules.

## Task 1: Seeded Incident Workload

**Files:**
- Create: `eval/recall/workload.ts`
- Create: `eval/recall/packets.ts`
- Create: `tests/eval-recall.workload.test.ts`
- Modify: `tsconfig.json` to include `eval/**/*.ts`

**Interfaces:**

`workload.ts` owns these exported domain types:

```ts
type Arm = "baseline" | "paging";
type Stage = "A" | "B";
type FactCategory = "id" | "path" | "error" | "quantity" | "decision";
type PromptStep = {
  id: string;
  kind: "seed" | "revision" | "work" | "probe";
  text: string;
  stage?: Stage;
  probeId?: string;
};
type FactVersion = {
  factId: string;
  category: FactCategory;
  version: 1 | 2;
  value: string;
  sourcePromptId: string;
  subject: string;
  field: string;
  uniqueLiteral: boolean;
};
type Probe = { id: string; stage: Stage; factId: string | null; step: PromptStep };
type Workload = {
  seed: string;
  seedSteps: readonly PromptStep[];
  facts: readonly FactVersion[];
  probes: Readonly<Record<Stage, readonly Probe[]>>;
};
```

- Produces: `buildWorkload(seed: string): Workload`.
- Produces: `factForProbe(workload: Workload, probe: Probe): FactVersion | null`.
- Produces: `buildWorkStep(seed: string, index: number): PromptStep`.
- `packets.ts` produces `renderWorkPacket(seed: string, index: number): { text: string; estimatedTokens: number }`.
- `PromptStep` contains only public prompt data. It never contains expected answers or a serialized private fact table.

- [ ] **Step 1: Write failing workload tests.** Use these assertions and complete the fact-isolation cases described afterward.

```ts
test("generates reproducible, disjoint probe groups", () => {
  const a = buildWorkload("pilot-v1");
  assert.deepEqual(a, buildWorkload("pilot-v1"));
  assert.notDeepEqual(a, buildWorkload("batch-v1-0"));
  for (const stage of ["A", "B"] as const) {
    assert.equal(a.probes[stage].length, 6);
    assert.equal(a.probes[stage].filter(p => p.factId === null).length, 1);
  }
  const ids = a.probes.A.map(p => p.factId).filter(Boolean);
  assert.ok(a.probes.B.every(p => p.factId === null || !ids.includes(p.factId)));
});
```

Add cases for latest-version lookup, all five fact categories, no target answers in probe text, and no target field records in later work packets.
Unknown probes must return no fact from `factForProbe()`.
Stage A and stage B facts must occupy different seed messages, not one shared message that a history load returns atomically.
A generated work packet must fit the estimated size range and contain related source, settings, and incident records.

- [ ] **Step 2: Run the tests and record the expected missing-module failure.**

Run: `node --test --experimental-strip-types tests/eval-recall.workload.test.ts`

Expected: The new modules are missing. A fixture syntax error is not the intended red result.

- [ ] **Step 3: Implement the workload contracts.** Generate fixed-width opaque values with Node.js `createHash()` and stable seed labels.

Use ten known facts: one fact from each category in each stage.
Use one fact per seed message to prevent atomic loads from coupling the probe groups.
Add one early revision message per stage for its decision fact.
All twelve seed and revision prompts precede stage A pressure control.
The host selects the latest version after those messages, and it never revises a target during a probe group.

Probe text requests exactly `{"answer": "..."}` or `{"answer": null}` without supplying the answer value.
Quantities require the field name and unit for evidence matching.
The stage subject labels must differ, so keyword search does not intentionally retrieve both groups.

- [ ] **Step 4: Implement `renderWorkPacket()` and `buildWorkStep()`.** Use deterministic log records, source excerpts, and related settings.

Each packet asks for a causal comparison, a configuration difference, or a timeline update.
Use Pi's existing `estimateTokens()` for packet measurement.
Grow the packet with distinct incident records until it reaches 8,000 estimated tokens, without exceeding 12,000.
Include no private answer table, previous target field record, or repeated filler paragraph.

- [ ] **Step 5: Add `eval/**/*.ts` to the existing typecheck scope.** Do not change compiler behavior or dependencies.

- [ ] **Step 6: Run the workload tests and `npm run typecheck`.** Expected: both commands exit zero.

- [ ] **Step 7: Commit the workload deliverable.**

Run: `git add eval/recall/workload.ts eval/recall/packets.ts tests/eval-recall.workload.test.ts tsconfig.json`

Run: `git commit -m "test(eval): add seeded long-session workload"`

## Task 2: Exact Answer Scoring

**Files:**
- Create: `eval/recall/scoring.ts`
- Create: `tests/eval-recall.scoring.test.ts`

**Interfaces:**
- Consumes: `Probe`, `FactVersion`, and `factForProbe()` from Task 1.
- Produces: `scoreAnswer(probe: Probe, expected: string | null, finalText: string): ProbeScore`.
- `ProbeScore` contains `probeId`, `expected`, `actual: string | null`, `correct`, and `reason`.
- `reason` is `correct`, `wrong-answer`, `invalid-json`, or `invalid-shape`.
- An invalid answer has `correct: false`; it cannot become a correct unknown response.

- [ ] **Step 1: Write the failing parser and scoring tests.**

```ts
test("scores exact values and explicit unknowns", () => {
  const probe = buildWorkload("pilot-v1").probes.A[0];
  assert.equal(scoreAnswer(probe, "opaque-X", '{"answer":"opaque-X"}').correct, true);
  assert.equal(scoreAnswer(probe, "opaque-X", '{"answer":"opaque-x"}').correct, false);
  assert.equal(scoreAnswer(probe, null, '{"answer":null}').correct, true);
  assert.equal(scoreAnswer(probe, null, '{}').correct, false);
  assert.equal(scoreAnswer(probe, "17 ms", '{"answer":17}').reason, "invalid-shape");
});
```

Add cases for one complete optional `json` code fence, surrounding whitespace, JSON escapes, extra properties, multiple objects, and extra prose.
A superseded decision must score zero.
A value buried in arbitrary prose must not count as an answer.

- [ ] **Step 2: Run `node --test --experimental-strip-types tests/eval-recall.scoring.test.ts`.** Expected: a missing-module failure.

- [ ] **Step 3: Implement `scoreAnswer()`.** Parse one complete JSON object with only an `answer` property.

Accept a string or `null` as its value.
Accept a single complete code fence with no language tag or the `json` tag.
Do not trim the decoded value, change case, rewrite paths, or search for expected substrings.
Do not call a model or import the session runner.

- [ ] **Step 4: Run the scoring tests and `npm run typecheck`.** Expected: both commands exit zero.

- [ ] **Step 5: Commit the scoring deliverable.**

Run: `git add eval/recall/scoring.ts tests/eval-recall.scoring.test.ts`

Run: `git commit -m "test(eval): add strict historical answer scoring"`

## Task 3: Readable Request Evidence and Safe Exports

**Files:**
- Create: `eval/recall/codex-payload.ts`
- Create: `eval/recall/evidence.ts`
- Create: `eval/recall/safe-artifacts.ts`
- Create: `tests/eval-recall.evidence.test.ts`
- Create: `tests/fixtures/eval-recall.ts`

**Interfaces:**
- Consumes: Task 1 facts and probes, plus Task 2 `ProbeScore`.
- Produces: `decodeCodexPayload(payload: unknown, meta: RequestMeta, origins: OriginIndex): RequestEvidence`.
- `RequestMeta` contains `requestId`, `promptId`, `arm`, and `purpose: "conversation" | "compaction"`.
- `OriginIndex` contains canonical SDK-converted roles and text blocks, tagged with original prompt IDs or compaction entry IDs.
- The Task 4 session runner owns origin construction with the pinned SDK's `convertToLlm()`. The payload decoder consumes that index without wrapping raw summaries.
- `RequestEvidence` contains the metadata, `complete`, optional `error`, readable blocks, and opaque-item counts and hashes.
- Each readable block records text, role, and an optional original prompt ID or compaction entry ID.
- Produces: `matchFact(fact: FactVersion, texts: readonly string[]): "match" | "none" | "ambiguous"`.
- Produces: `analyzeProbe(input: ProbeEvidenceInput): ProbeEvidence`.
- `ProbeEvidenceInput` contains a probe, its fact or `null`, its initial request, follow-up requests, recovery results, and score.
- `RecoveryResult` contains `promptId`, `requestId`, `toolCallId`, `toolName`, readable result text, `isError`, and monotonic `eventIndex`.
- `ProbeEvidenceInput` also contains `finalAnswerEventIndex` to reject late recovery results.
- `ProbeEvidence` contains `probeId`, `visibility`, `opaqueReasoningPresent`, `qualified`, and `recoverySuccess`.
- `visibility` is a spec label, or `null` for an unknown probe. `recoverySuccess` is also `null` for an unknown probe.
- Produces: `sanitizeArtifact(value: unknown): unknown`. It returns a safe copy and never changes the live value.
- The fixture module produces `evidenceFixture(overrides: Partial<RequestEvidence>): RequestEvidence` for later tasks.

- [ ] **Step 1: Write failing protocol and evidence tests.**

Test original source retention, summary retention, resident assistant copies, readable absence, and unknown probes.
Build summary fixtures through the real SDK's `convertToLlm()`, then decode their provider payloads.
Require `resident-summary` for a retained answer inside the SDK-wrapped `user` message, with the correct compaction entry ID.
A bare stored summary or a wrong role must not match that origin.
Test ambiguous converted origins without choosing one arbitrarily.
Test correct recovery through each registered history tool, including an answer in a search reference.
An error result, a bare tool call, or a result after the final answer must not establish successful recovery.
Wrong final answers remain wrong even after correct recovery.

```ts
test("does not mistake opaque reasoning for proof of forgetting", () => {
  const w = buildWorkload("pilot-v1");
  const probe = w.probes.A[0];
  const fact = factForProbe(w, probe)!;
  const initial = evidenceFixture({ blocks: [], opaque: { count: 1, hashes: ["digest"] } });
  const score = scoreAnswer(probe, fact.value, JSON.stringify({ answer: fact.value }));
  const result = analyzeProbe({ probe, fact, initial, followUps: [], recoveryResults: [], score, finalAnswerEventIndex: 3 });
  assert.equal(result.visibility, "plaintext-absent");
  assert.equal(result.opaqueReasoningPresent, true);
  assert.equal(result.recoverySuccess, false);
});
```

Add cases for an unknown input item, an incomplete trace, a prior-response continuation, `store: true`, and ambiguous source attribution.
Unknown shapes must produce `unclassified`, not `plaintext-absent`.
An unrelated number must not establish a quantity's field-specific evidence.

- [ ] **Step 2: Add failing export tests.** Freeze an input object with headers, cookies, credential fields, encrypted content, and a thinking signature.

The safe copy must retain useful plaintext and opaque hashes without those private values.
Decoding and export must leave the frozen object unchanged.
A tool result that quotes an entire seed packet must not become a resident original user message.

- [ ] **Step 3: Run `node --test --experimental-strip-types tests/eval-recall.evidence.test.ts`.** Expected: missing-module failures.

- [ ] **Step 4: Implement `decodeCodexPayload()`.** Decode Codex `instructions`, input messages, function calls, function outputs, readable reasoning summaries, and tool declarations.

Validate the selected API's known shapes, `store: false`, and absence of `previous_response_id`.
Match exact roles and text blocks from the SDK-converted origin index, with conservative handling of ambiguous matches.
Do not match raw compaction summary text or duplicate the SDK's prefixes, tags, or role conversion in the decoder.
An opaque item contributes a count and SHA-256 digest, never readable answer evidence.
Do not serialize arbitrary unknown payload fields into artifacts.

- [ ] **Step 5: Implement `matchFact()` and `analyzeProbe()`.** Unique literals use exact matching.

Quantities and common values need their subject, field, and value in one contextual record.
A common value without sufficient context is ambiguous.
Apply the spec labels in order: resident original, resident summary, resident other, plaintext absent, or unclassified.
Unknown probes have no visibility or recovery-success classification.

Use only the first conversation request for initial visibility.
Use later tool results for recovery evidence, without promoting failed or late results.
A qualified known probe needs a complete trace, excluded source, and readable absence.
Recovery success additionally needs a matching valid tool result and a correct score.
Do not infer that recovery was necessary, or that a correct answer without recovery was a guess.

- [ ] **Step 6: Implement `sanitizeArtifact()`.** Drop structured authorization, header, cookie, API-key, environment, encrypted-content, and thinking-signature fields recursively.

Keep opaque hashes separately.
Use explicit allowlists for exported model metadata and errors.
Do not export credential resolution objects or provider error headers.

- [ ] **Step 7: Run evidence tests, Tasks 1–2 tests, and `npm run typecheck`.** Expected: all commands exit zero.

- [ ] **Step 8: Commit the evidence deliverable.**

Run: `git add eval/recall/codex-payload.ts eval/recall/evidence.ts eval/recall/safe-artifacts.ts tests/eval-recall.evidence.test.ts tests/fixtures/eval-recall.ts`

Run: `git commit -m "test(eval): trace readable evidence without opaque-state claims"`

## Task 4: Real Pi Session Adapter and Observed Codex Transport

**Files:**
- Create: `eval/recall/codex-runtime.ts`
- Create: `eval/recall/pi-arm.ts`
- Create: `tests/eval-recall.pi-arm.test.ts`
- Create: `tests/fixtures/eval-recall-provider.ts`

**Interfaces:**
- Consumes: Task 1 `Arm` and `PromptStep`, plus Task 3 payload decoding and export contracts.
- Produces: `prepareCodexRuntime(agentDir: string, hooks: RequestHooks, createRuntime?: RuntimeFactory): Promise<PreparedRuntime>`.
- `RuntimeFactory` is `(agentDir: string) => Promise<ModelRuntime>`. Tests inject a credential-free fixture runtime.
- `PreparedRuntime` contains a runtime, the pinned resolved model, safe metadata, and a metadata fingerprint.
- `SafeModelMetadata` is an explicit projection of `provider`, `id`, `api`, `contextWindow`, `maxTokens`, `cost`, `reasoning`, and `thinkingLevelMap`.
- Produces: `observeProvider(base: Provider, hooks: RequestHooks): Provider` for per-runtime registration.
- `RequestHooks` has `allocateMeta(): RequestMeta`, `onPayload(meta: RequestMeta, payload: unknown, context: TranscriptContext): Promise<void>`, `beforeHttpAttempt(meta: RequestMeta): void`, and `onHttpAttemptEnd(meta: RequestMeta, status: number | null): void`.
- It also has `onUsageObservation(meta: RequestMeta, observation: ProviderUsageObservation): void` for incoming usage before SDK normalization.
- `ProviderUsageObservation` contains `requestId`, `usagePresent`, optional `error`, and nullable `inputTokens`, `outputTokens`, `cachedTokens`, and `cacheWriteTokens` from allowlisted raw usage fields.
- A missing field is `null`. An explicit numeric zero is `0`. Invalid numeric fields produce an observation error, not measured zero.
- `UsageLedgerEntry` contains `entryId`, `kind`, `requestIds`, nullable normalized `sdkUsage`, and all contributing `ProviderUsageObservation` records.
- `kind` distinguishes assistant messages, explicit usage entries, and native compaction entries. SDK normalization and cost calculation remain SDK-owned.
- Produces: `createPiArm(options: PiArmOptions): Promise<EvalArm>`.
- `PiArmOptions` contains `arm`, the real credential `agentDir`, a private temporary resource directory, event sink, request guard, clock, and an optional injected `RuntimeFactory`.
- `createPiArm()` owns its request scope and calls `prepareCodexRuntime()` before session creation.
- `EvalArm` has `runPrompt(step: PromptStep): Promise<ArmSnapshot>`, `snapshot(): ArmSnapshot`, `abort(): Promise<void>`, and `dispose(): void`.
- `ArmSnapshot` contains prompt count, request evidence, completed recovery results, final answer text and event index, source origins, compactions, and entries.
- It also contains `usageLedger: readonly UsageLedgerEntry[]`, latency, errors, and safe model metadata.
- `Clock` supplies `nowMs(): number`, `setTimeout(callback: () => void, milliseconds: number): unknown`, and `clearTimeout(handle: unknown): void`.
- Production uses a monotonic clock and real timers. Tests inject a fake clock with controllable timers.
- The provider fixture produces `makeFixtureProvider(script: FixtureScript): Provider` and an observable dispatch log. It never reads real credentials or uses a network.

- [ ] **Step 1: Write failing runtime preflight tests.** Missing model, unavailable credentials, unsupported `xhigh`, and changed metadata must stop without a substitute model.

Use fixture runtimes and in-memory credentials.
A model with a different native window must retain that window, not receive a forced eval window.
Version validation uses direct package inspection, not a test that restates dependency pins.

- [ ] **Step 2: Write failing real-SDK session tests.** Load the actual paging factory in the treatment and no paging factory in the baseline.

The baseline must expose no tools, and the treatment must expose exactly `PAGING_TOOL_NAMES` from `src/history.ts`.
Both must exclude file tools, shell tools, skills, and project instructions.
A successful fake-native compaction must retain normal summaries and the default recent-history policy.
Require its observed provider message to match the SDK-converted origin and retain the compaction entry ID.
The treatment must cancel threshold and overflow compaction but not claim those cancellations as successful compactions.

- [ ] **Step 3: Add transport and cleanup tests.** Exercise ordinary prompts, a tool follow-up, native compaction, and a retried HTTP dispatch.

Every dispatch must receive SSE options and a full, `store: false` payload without a previous-response reference.
A caller's existing payload callback must run before observation and keep its original return behavior.
A request guard must run before each HTTP attempt, including a retry.
No credentials or encrypted signatures can enter the recorded artifacts.
A failed second-arm startup must permit cleanup of the first arm.
Waiting only for the first `agent_end` must not complete a scripted tool continuation.

Inject fake HTTP SSE responses through the real pinned Codex adapter, not a provider that fabricates normalized usage.
Omit the entire usage object, then omit individual input, output, and cache fields in separate cases.
Compare those cases with explicit numeric zeros in the same fields.
The SDK can persist identical zeros, but the transport observations and resulting ledger must retain the difference.
Cover ordinary and native-compaction requests, including a compaction entry that combines two requests.
Retry or duplicate observations must not count one measurement twice.
A missing terminal response or usage observation must leave measurement presence unknown.

- [ ] **Step 4: Run `node --test --experimental-strip-types tests/eval-recall.pi-arm.test.ts`.** Expected: missing adapter modules or functions.

- [ ] **Step 5: Implement `prepareCodexRuntime()` and `observeProvider()`.** Use `ModelRuntime` and the user's existing Codex credential store.

Disable custom model-file overrides and create-time network catalog refresh.
Resolve the exact available model and effective `xhigh`, then freeze a safe metadata snapshot for the pair.
Register the observed native provider only on each private runtime, not in a global compatibility registry.
Preserve native authentication, model listing, reasoning, retry, and signal behavior.

Wrap both `stream()` and `streamSimple()`.
Compose `onPayload` after any caller callback, observe its effective payload without changing it, and force only `transport: "sse"`.
Wrap the request's existing fetch function or `globalThis.fetch` to count each actual model HTTP attempt before dispatch.
Do not count OAuth or catalog traffic as model inference.
Preserve abort signals and do not read or export request headers.

Observe incoming terminal SSE usage before forwarding it to the native adapter's normalization path.
Use a pass-through observer that preserves response bytes, chunk order, backpressure, cancellation, and errors.
Capture only the allowlisted usage projection and its field presence, keyed by request ID.
Do not retain or export raw response bodies, encrypted reasoning, or headers.
Do not infer measurement presence from the SDK's normalized zeros.

- [ ] **Step 6: Implement `createPiArm()` with the real SDK.** Use independent `SessionManager.inMemory()` instances and in-memory settings.

Pass the prepared model and `thinkingLevel: "xhigh"` to `createAgentSession()`.
Verify the selected session model and thinking level after extension binding.
Set common transport to `sse` and disable cache warming to prevent idle model calls.
Leave compaction and retry settings at their native defaults.
Use a private temporary `cwd` and resource directory, separate from the real credential location.

Use `DefaultResourceLoader` with discovery disabled and explicit inline factories.
The treatment inline factory calls `contextPagingExtension(pi, { globalSettings: { contextPaging: { enabled: true, tokenBudget: 128000, trimToTokens: 80000 } }, projectTrusted: false })`.
Both arms register a read-only lifecycle observer.
Use `noTools: "builtin"`, so the real recovery tools remain active only in the treatment.
Bind extensions explicitly before the first prompt and record loading errors through the SDK error callback.

- [ ] **Step 7: Implement `EvalArm.runPrompt()` and cleanup.** Supply only `step.text` to `session.prompt()`.

Track the current prompt and conversation or compaction purpose for every request.
Record successful compaction events separately from canceled attempts.
Correlate tool calls and results by tool-call ID and request order.
Build source origins by converting the corresponding SDK context messages with `convertToLlm()` and retaining their host-side IDs.
Keep raw summaries in session entries, but use only converted roles and text blocks for payload attribution.
Join transport usage observations to persisted assistant, explicit usage, and compaction entries in `usageLedger`.
For a combined compaction entry, retain every contributing request's presence metadata.
Missing or ambiguous joins remain unknown rather than assuming that normalized zeros were measured.
Await `session.waitForIdle()` after prompting, then capture the final answer and snapshot.
An error keeps partial evidence but does not silently advance to another prompt.
Guard startup, prompting, abort, and disposal with cleanup paths.

- [ ] **Step 8: Run the adapter tests and `npm run typecheck`.** Include a no-network real-SDK integration that uses the full live budgets and native window.

Do not shrink live settings to make this integration finish quickly.
The fake provider can generate deterministic responses and usage without paid inference.
Expected: no network access, both real context-management paths exercised, and zero test failures.

- [ ] **Step 9: Commit the session-adapter deliverable.**

Run: `git add eval/recall/codex-runtime.ts eval/recall/pi-arm.ts tests/eval-recall.pi-arm.test.ts tests/fixtures/eval-recall-provider.ts`

Run: `git commit -m "test(eval): run isolated Pi arms with observed Codex SSE"`

## Task 5: Paired Stage Controller and Safety Limits

**Files:**
- Create: `eval/recall/pair.ts`
- Create: `tests/eval-recall.pair.test.ts`
- Modify: `tests/fixtures/eval-recall.ts` with a scripted `EvalArm`

**Interfaces:**
- Consumes: Tasks 1–4 workload, scoring, evidence, and `EvalArm` contracts.
- Produces: `runPair(options: PairOptions): Promise<PairResult>`.
- `PairOptions` contains pair ID, workload, first arm, limits, clock, arm factory, abort signal, readiness callback, and progress callback.
- `onReady(snapshots: Readonly<Record<Arm, ArmSnapshot>>): Promise<void>` runs before the first prompt, after matching both metadata fingerprints.
- `PairProgress` contains pair ID, completed shared step, both snapshots, and current stage results.
- `PairResult` contains seed, first arm, shared steps, both final snapshots, probe scores and evidence, stage results, contamination, and errors.
- Pair status is `complete`, `inconclusive`, or `incomplete`. It is not a correctness pass or fail.
- `StageResult` contains actual probe timing, known qualified count, completion, and an explicit invalidity reason.
- Produces: `createRequestGuard(limits: EvalLimits, clock: Clock): RequestGuard`.
- `EvalLimits` contains `maxUserPrompts`, `maxRequestsPerPrompt`, `maxRequestsPerArm`, and `maxPairMinutes`.
- `RequestGuard` exposes `beforeAttempt(meta: RequestMeta): void`, `beginPrompt(arm: Arm, promptId: string): void`, sent-attempt counts, and a latched stop reason.
- The scripted fixture produces `makeScriptedArm(script: ArmScript): EvalArm` with received-prompt and disposal records.

- [ ] **Step 1: Write failing shared-sequence and stage tests.**

The two arms must receive identical text in the same order, with the selected first arm called first.
All seed and revision messages precede pressure work.
Stage A needs no successful baseline compaction and at least four qualified known probes.
Stage B needs successful baseline compaction and exclusion of its original source messages.
A baseline summary that preserves an answer must score correctly and carry the `resident-summary` label.
Wrong answers must not change stage qualification or become infrastructure errors.

- [ ] **Step 2: Add failure and contamination tests.**

Baseline compaction during stage A must make that stage inconclusive, not silently change the stage label.
A stage A answer or recovered result with a stage B target must record cross-stage exposure.
Keep the raw scores, but do not include an exposed stage B case in an independent comparison.
A contaminated pair must not become an eligible pilot.
A source-bearing tool result must not count as the original resident user message.

Test missing traces, canceled compaction, limit exhaustion, provider errors, and a malformed model answer.
A provider error aborts the pair, whereas malformed answer JSON scores zero.
Both arms must abort or dispose on all exit paths.

- [ ] **Step 3: Add boundary tests for minimum prompts and request limits.**

Use scripted snapshots to reach both stages before 24 user prompts, then require extra work before stage B.
A tool follow-up must not increment the user-prompt count.
With a per-prompt limit of 12, the guard must block attempt 13 before its fetch function runs.
With a per-arm limit of 256, it must block attempt 257.
Count native compaction and retry dispatches against the same attempt limits.
A fake clock past 120 minutes must stop work and preserve the partial result.

- [ ] **Step 4: Run `node --test --experimental-strip-types tests/eval-recall.pair.test.ts`.** Expected: missing controller and guard functions.

- [ ] **Step 5: Implement `createRequestGuard()` and `runPair()`.** Use one shared step list and the injected clock.

Send a step to each arm sequentially and wait for both snapshots before the next decision.
Use complete current request evidence to choose a stage A opportunity, not only a paging notice.
Score each actual first probe request and recalculate qualification afterward.
Stage A validity checks baseline compaction before, during, and after the probe group.

After stage A, continue work until native baseline compaction removes stage B source messages.
Reserve room for the six final probes within the user-prompt cap.
Insert work before that group until its completion will meet the 24-prompt minimum.
Never force compaction, lower the budget, or pick another model to satisfy a gate.

- [ ] **Step 6: Implement outcome preservation and cleanup.** Limits and failed stages preserve all observations with explicit reasons.

Stage A invalidity can still permit a separately labeled stage B observation, but the pair remains inconclusive.
Infrastructure errors stop further prompts and make the pair incomplete.
The controller never invents missing answers, trace evidence, usage, or successful compaction.
Schedule the pair deadline at startup, so it can abort an active stream without waiting for another request.
Use final cleanup to clear that timer, abort active work, and dispose every created arm, including partial startup.

- [ ] **Step 7: Run controller tests and the no-network real-SDK integration.** Expected: shared prompts, both stage paths, correct limit boundaries, and complete cleanup.

- [ ] **Step 8: Commit the paired-controller deliverable.**

Run: `git add eval/recall/pair.ts tests/eval-recall.pair.test.ts tests/fixtures/eval-recall.ts`

Run: `git commit -m "test(eval): gate paired recall stages and enforce limits"`

## Task 6: Reports, Safe CLI, and Pilot Eligibility

**Files:**
- Create: `eval/recall/usage.ts`
- Create: `eval/recall/report.ts`
- Create: `eval/recall/cli.ts`
- Create: `eval/recall/source-integrity.ts`
- Create: `scripts/recall-eval.ts`
- Create: `tests/eval-recall.report.test.ts`
- Create: `tests/eval-recall.cli.test.ts`
- Create: `docs/evals/full-budget-recall.md`
- Modify: `package.json` scripts only
- Modify: `README.md` with a short eval-guide link

**Interfaces:**
- Consumes: Task 5 `PairResult`, Task 4 snapshots, and Task 3 safe exports.
- Consumes: Task 4 `UsageLedgerEntry`, including captured measurement presence for every contributing request.
- Produces: `aggregateUsage(ledger: readonly UsageLedgerEntry[]): UsageSummary`.
- `UsageSummary` contains nullable input, output, cache-read, cache-write, and estimated cost totals, plus compaction subtotals and missing-field records.
- Missing-field records identify the persisted entry, contributing request, and missing component or observation. Normalized SDK usage alone cannot establish presence.
- `source-integrity.ts` produces `assertCleanSource(repoRoot: string, expectedRevision?: string): CleanSourceSnapshot`.
- `CleanSourceSnapshot` contains the full `sourceRevision` and `sourceIntegrity: "clean-checkout-v1"`. A dirty checkout, missing Git evidence, or revision mismatch throws before live preflight.
- The check includes staged changes, unstaged changes, and non-ignored untracked files. Live eval and extension modules must be tracked in that checkout.
- Produces: `buildManifest(input: ManifestInput): RunManifest` and `experimentFingerprint(manifest: RunManifest): string`.
- The fingerprint includes source revision, source-integrity policy, SDK and Node.js versions, model metadata, thinking, baseline and paging settings, transport, limits, and workload version.
- It excludes run IDs, timestamps, seeds, pair order, and measured results.
- Produces: `isEligiblePilot(pilot: RunManifest, result: PairResult, next: RunManifest): { eligible: boolean; reason: string | null }`.
- Produces: `createArtifactWriter(directory: string, manifest: RunManifest): Promise<ArtifactWriter>`.
- `ArtifactWriter` exposes `appendProgress(progress: PairProgress): Promise<void>` and `finish(result: PairResult): Promise<void>`.
- After successful session cleanup, source verification, and artifact writes, `complete(): Promise<void>` writes a run-bound `completion.json`. Batch startup requires this record so stale complete summaries cannot authorize a batch after a final write failure.
- Produces: `renderReport(manifest: RunManifest, pairs: readonly PairResult[]): string`.
- Produces: `parseEvalArgs(argv: readonly string[]): EvalCliOptions` and `runEval(options: EvalCliOptions, dependencies: EvalCliDependencies): Promise<number>`.
- `EvalCliOptions` contains `mode: "dry-run" | "pilot" | "batch"`, `seed`, `outputDirectory`, `pairs`, optional `pilotManifestPath`, and `limits`.
- CLI dependencies inject source inspection, clocks, runtime factories, arm factories, artifact I/O, and console output for provider-free tests.
- `RunManifest` names its fields `schemaVersion`, `runId`, `mode`, `sourceRevision`, `sourceIntegrity`, `sdkVersion`, `nodeVersion`, `modelMetadata`, `thinking`, `baseline`, `paging`, `transport`, `limits`, `workloadVersion`, `seeds`, `firstArms`, and `experimentHash`.
- `sourceIntegrity` is `"clean-checkout-v1"` only after source verification. It is `null` for unverified or failed source checks. Pilot eligibility requires the verified policy in both manifests.
- `sourceRevision` is the full checked Git commit ID, not a branch name. It can be `null` only in an incomplete preflight artifact with no verified Git evidence.
- A loaded pilot without verified source-integrity evidence or a full source revision must fail eligibility.
- `modelMetadata` can be `null` only for an incomplete preflight artifact. It is required for pilot eligibility.
- The workload version starts as `incident-v1`. The manifest schema version starts as `1`.

- [ ] **Step 1: Write failing usage and report tests.**

Sum ledger usage once per persisted entry ID across assistant messages, explicit usage entries, and native compaction entries.
A compaction subtotal of 100 tokens inside a 1,000-token session total must remain a subtotal, not produce 1,100 tokens.
Duplicate observations of one compaction entry must not count twice.
Use ledger fixtures with measured zeros, missing raw fields, and missing transport observations.
A missing component in any contributing request must make that component's total unknown, not zero.
Input requires reported input tokens and both cache components because the SDK subtracts those components from provider input tokens.
Output, cache-read, and cache-write totals each require their corresponding provider field.
Estimated cost requires complete token components and catalog prices.
Keep the real-adapter omitted-field versus explicit-zero regression in Task 4. Fabricated `undefined` SDK fields do not replace that test.

Keep per-stage known and unknown accuracy, category and revised-decision accuracy, and qualified denominators.
Keep individual pairs and paired differences alongside aggregate summaries.
Do not call an incomplete or contaminated pair a winner.
Reports must retain opaque-reasoning caveats and label costs as catalog estimates.

- [ ] **Step 2: Write failing artifact and CLI tests.**

A default invocation or `--dry-run` must never resolve credentials, create sessions, or dispatch a request.
A failed or mismatched pilot must block batch startup before any model request.
A changed native window, source revision, thinking level, or settings fingerprint must invalidate pilot eligibility.
Use a temporary Git repository to test source integrity through the real Git inspection path.
After a valid clean pilot, change an eval file without changing HEAD. Batch startup must fail before live imports, credentials, or sessions.
Also cover staged edits, dirty extension or transport files, non-ignored untracked source files, missing policy evidence, and changed clean revisions.
Ignored artifact files must not invalidate a clean source snapshot.
A source change during a run must block the next HTTP attempt and make the pilot ineligible at finalization.
Use temporary artifact directories and prove that exported files contain no secret or encrypted-signature sentinels.
Artifact errors and provider errors must retain available partial evidence and close sessions.

- [ ] **Step 3: Run the report and CLI tests.** Expected: missing modules or functions.

Run: `node --test --experimental-strip-types tests/eval-recall.report.test.ts tests/eval-recall.cli.test.ts`

- [ ] **Step 4: Implement usage aggregation, source integrity, and eligibility.** Consume the typed usage ledger, deduplicated by entry ID.

Use `session.getSessionStats()` as a recorded cross-check, not a second source to add to the ledger.
Use normalized SDK values only when the transport observations establish presence for every contributing request.
Do not infer presence from persisted zeros or recompute the SDK's usage and cost normalization.
Track missing fields explicitly, and show compaction usage separately without adding it twice.

Implement `assertCleanSource()` with Git status and full HEAD inspection in the checkout that contains the entry point.
Do not inspect either session's private temporary `cwd` as the source checkout.
Reject dirty or untracked live sources before credential resolution, runtime creation, or model dispatch.
Treat complete pair structure, safe evidence, and matching verified source integrity as pilot eligibility, not perfect model accuracy.
A complete pilot with wrong answers can authorize a batch.
A pilot with missing stages, contamination, unsupported traces, unverified sources, or mismatched fingerprints cannot authorize it.

- [ ] **Step 5: Implement manifests and private artifacts.** Create the run directory with mode `0700` and files with mode `0600`.

Reject an existing run directory instead of overwriting another run.
Write a manifest, shared prompts with a hash, safe per-arm transcripts and traces, events, scored probes, JSON results, and a Markdown report.
Persist progress after each shared prompt and serialize writes before finalization.
Use temporary files and rename for final summaries.
Artifact write errors stop further model work.
Keep custom artifact directories outside the checkout or in ignored paths, so artifact writes do not dirty verified sources.

- [ ] **Step 6: Implement argument parsing and orchestration.** Use these commands and fixed live model settings.

```sh
npm run eval:recall -- --dry-run
npm run eval:recall -- --pilot --seed pilot-v1
npm run eval:recall -- --batch --pilot-manifest .pi/evals/full-budget-recall/<pilot-run-id>/manifest.json
```

The default mode is dry run.
`--pilot` runs one pair. `--batch` requires an eligible pilot and runs three different seeds by default.
Accept `--seed`, `--output-dir`, `--pairs`, and positive-integer safety-limit arguments.
`--pairs` applies only to batch mode and supports later repetitions without changing the model or budgets.
Reject conflicting modes, unknown flags, malformed numbers, and model or budget override flags.

For live modes, capture a clean source snapshot before loading workload, transport, or extension modules.
Load live dependencies only after that check. The source verifier itself has no live-module imports.
Pass the checked revision and policy to manifest construction.
Recheck against that revision before each pair, each model HTTP attempt including retries, and successful finalization.
If a source check fails, stop further requests.
Clear verified policy evidence.
Retain partial artifacts with the source error.
Never authorize a batch solely because a dirty checkout still reports the pilot's HEAD.

Use these exit codes: `0` for dry run or structurally complete results, `2` for arguments or infrastructure errors, and `3` for inconclusive stages or safety limits.
A wrong model answer does not require a nonzero process exit.
An authenticated unavailable model is an infrastructure error, not a scored wrong answer.

- [ ] **Step 7: Add the entry point and documentation.** Add `eval:recall` as `node --experimental-strip-types scripts/recall-eval.ts`.

Keep the script as a thin bootstrap with an exit code and no eager live-module imports.
Use the source verifier before dynamic live imports, while keeping dry run provider-free.
Keep eval sources and result files outside the package's published `files` list.
Do not change dependencies or the lockfile.
The guide must explain authentication, the two stages, SSE tracing, opaque reasoning, safety limits, costs, artifacts, and pilot eligibility.
It must explain clean-checkout preflight, committing harness changes before a new pilot, and keeping sources unchanged during live runs.
Add one README link to that guide.

- [ ] **Step 8: Run all tests, typecheck, dry run, and package verification.**

Run: `npm run check`

Run: `npm run eval:recall -- --dry-run`

Expected: zero failures, zero live requests during tests or dry run, and the existing package smoke check still passes.
Use direct command verification for package scripts and documentation instead of static-content assertion tests.

- [ ] **Step 9: Commit the usable harness.**

Run: `git add eval/recall/usage.ts eval/recall/report.ts eval/recall/cli.ts eval/recall/source-integrity.ts scripts/recall-eval.ts tests/eval-recall.report.test.ts tests/eval-recall.cli.test.ts docs/evals/full-budget-recall.md package.json README.md`

Run: `git commit -m "feat(eval): add full-budget recall runner and reports"`

## Task 7: Full-Budget Live Evidence and Final Handoff

**Files:**
- Modify: `docs/evals/full-budget-recall.md` only if live evidence changes operating instructions
- Create at runtime: `.pi/evals/full-budget-recall/<pilot-run-id>/...`
- Create at runtime: `.pi/evals/full-budget-recall/<batch-run-id>/...`

**Interfaces:**
- Consumes: the Task 6 CLI, eligible-pilot check, and durable reports.
- Produces: one valid pilot report and a separate three-pair batch report, or an explicit blocked result with evidence.
- No new automated test is needed solely to assert a live report's prose or static settings.

- [ ] **Step 1: Run the full verification suite from the feature worktree.**

Run: `npm run check`

Run: `npm run eval:recall -- --dry-run`

Expected: all existing and new tests pass, the packed artifact check passes, and the dry run makes no live request.
Commit all harness changes before live preflight. The CLI must accept only a clean checkout at that full revision.
Keep source files unchanged during the pilot and batch.

- [ ] **Step 2: Run exact-model preflight and the pilot through the CLI.**

Run: `npm run eval:recall -- --pilot --seed pilot-v1`

Do not substitute another model after an authentication, catalog, or provider error.
If the pilot fails a stage or trace requirement, retain the report and stop before the batch.
Diagnose the observed cause instead of lowering the paging budget.
After a harness fix, rerun automated verification and commit the fix.
Run a fresh pilot from the clean new source revision.

- [ ] **Step 3: Review pilot evidence.** Require at least 24 shared prompts, four qualified stage A probes, and successful native baseline compaction before stage B.

Require source exclusion, safe request traces, independent stage targets, effective `xhigh`, and 128,000/80,000 paging settings.
Check correctness scores without requiring either arm to win.
Check encrypted-reasoning disclosures, transport measurement presence, and usage completeness.
Require verified `clean-checkout-v1` evidence and the same source revision for batch startup.
The pilot result must remain separate from batch aggregate scores.

- [ ] **Step 4: Run the three-pair batch using the eligible pilot artifact.**

Run: `npm run eval:recall -- --batch --pilot-manifest .pi/evals/full-budget-recall/<pilot-run-id>/manifest.json`

Expected: three distinct recorded seeds, alternating first-arm order, identical prompts within each pair, and explicit per-pair outcomes.
If a pair is invalid or incomplete, report it without silently replacing its seed or hiding it from the summary.
The CLI must not report a full effectiveness conclusion unless the required live evidence exists.

- [ ] **Step 5: Synthesize the measured result.** Report stage-specific exact recall, unknown answers, recovery evidence, costs, latency, and errors.

Show each pair and the paired differences.
State that three pairs are preliminary evidence.
Do not describe catalog estimates as Codex invoices or claim absence from encrypted model state.
Link the pilot and batch manifests, raw scored results, and readable reports.

- [ ] **Step 6: Perform the selected execution method's final review.** Use the actual diff, approved spec, plan, and measured evidence.

The parent implements fixes and reruns the affected tests.
A delegated final reviewer requires the owner's selected method and uses the canonical fresh-context `reviewer` role.
Do not dispatch a review subagent solely because this plan exists.

- [ ] **Step 7: Record completion without committing private runtime artifacts.** Commit guide changes only if they are necessary and verified.

Confirm that production `src/` and dependency pins remain unchanged.
Confirm that artifacts remain ignored and the worktree has no unexplained tracked changes.
Offer local squash integration into `main`, a PR, or keeping the branch, after the implementation and live gates complete.
Do not push or merge without the user's choice.

## Plan Self-Review and Acceptance Map

| Spec requirement | Owning task and verification |
| --- | --- |
| Seeded substantive packets and fact revisions | Task 1 generator tests and pilot packet review |
| Exact known and unknown answers | Task 2 strict parser and scoring tests |
| Initial readable visibility and opaque-state limits | Task 3 protocol and evidence tests |
| SDK-wrapped summary attribution with its outgoing role | Tasks 3 and 4 canonical-conversion and real-SDK tests |
| Safe host-only answer keys and artifacts | Tasks 1, 3, 4, and 6 isolation and export tests |
| Actual extension, native baseline, exact model, and SSE | Task 4 real-SDK tests and Task 7 preflight |
| Identical prompts, both stages, and minimum count | Task 5 controller tests and Task 7 pilot |
| Limits, errors, retries, and complete cleanup | Tasks 4–6 guarded dispatch and failure tests |
| Usage presence before normalization and no duplicate compaction costs | Task 4 real-adapter SSE tests, Task 6 typed-ledger tests, and live cross-check |
| Pilot before three different batch seeds | Task 6 eligibility tests and Task 7 live evidence |
| Clean executed sources and rejection of dirty edits at unchanged HEAD | Task 6 real-Git eligibility tests and Task 7 clean-source gates |
| No production changes or package growth | Task 6 package smoke check and Task 7 diff review |

The plan pins all eight Review Focus cases to owning tests.
The public interfaces use the same names across task boundaries.
Static documentation and script settings use direct verification instead of maintenance-only tests.

## Execution Handoff

Implementation has not started, and no live eval request ran during planning.
The owner must review this plan and choose an execution method.

- **Native, recommended:** the parent implements the coupled tasks in this session, then one fresh-context reviewer checks the whole branch.
- **Subagent-driven:** one writer implements each task, with a fresh review gate before the next task.

Native execution reduces repeated context setup for the shared trace, session, and controller interfaces.
If the owner chooses delegation, use one top-level asynchronous workflow and one writing child at a time.
Neither choice permits a smaller live budget, another model, or an invalid pilot to bypass the batch gate.
