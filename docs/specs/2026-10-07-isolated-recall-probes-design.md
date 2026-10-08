# Isolated recall probes

Date: 2026-10-07

Status: Draft for user review. No implementation or paid run is approved by this draft.

This design amends `2026-10-07-independent-recall-stages-design.md` and `2026-10-04-full-budget-recall-eval-design.md`.
It replaces their shared-session probe groups, four-of-five qualification rule, and metrics definitions.
Other model, transport, scoring, source-integrity, artifact-safety, and compaction rules remain in force.

## Purpose

Measure each fact's recovery without help from an earlier probe.
A successful history lookup can return several facts.
Those results must remain useful inside that probe, but must not enter another probe's conversation.

The previous design separated stages A and B, but left each stage's six probes in one conversation.
The first lookup could therefore expose answers for the later probes.
A five-of-five score from that design does not establish five isolated recoveries.

The user approved drafting a checkpoint design before another paid pilot.
A checkpoint is the prepared conversation before any probe.
A probe fork is a separate session restored from that checkpoint.
The draft also defines offline evidence required before those forks can support a live experiment.

## Selected approach and alternatives

Prepare each stage's baseline and paging arms once.
Freeze both arms before any probe or recovery lookup.
Restore a separate fork for each of the five known questions and the unknown control.

All forks in one arm inherit the same prepared conversation.
They do not inherit a sibling's question, answer, tool call, tool result, or compaction.
The host never copies fork entries back into the checkpoint.

This approach avoids repeating the paid preparation for every question.
Its benefit depends on faithful restoration of both stored history and paging runtime state.
Faithful restoration means equivalent policy state and model input, not merely the same user messages.

Two alternatives are not selected:

- Separate fresh conversations can prevent probe contamination, but they repeat preparation and increase cost. They require separate user approval.
- Splitting facts across records cannot guarantee isolation. Broad searches and history reads can still expose several answers.

Retrieval restrictions are not an alternative.
The four production recovery tools retain their normal behavior.
The host must not filter results, hide unrelated facts, narrow tool arguments, or direct the model toward a known source.

## SDK findings and feasibility gate

The pinned SDK is `@earendil-works/pi-coding-agent` 0.87.1.
`SessionManager.inMemory(cwd, options, entries)` accepts native session entries.
`SessionManager.forkFrom(...)` also copies stored history into a new persisted session.
Neither API captures arbitrary extension closures.

An unpaid, temporary `SessionManager` audit passed against the installed SDK.
It made independent managers from deep copies of one active branch.
The audit established these stored-history properties:

- Each fork receives a distinct session ID.
- Raw branch entries and projected messages match the source before a probe.
- Entry IDs, parent links, source records, native compaction entries, and opaque assistant fields survive the copy.
- A broad lookup and its answer in one fork do not appear in a sibling or the source.
- Changes to an inherited object in one fork do not change another fork.

This audit invoked no provider and made zero provider requests.
It did not establish `AgentSession` restoration or paging runtime fidelity.
The fixture's opaque field was synthetic, not a real provider reasoning state.

Paging has additional state in `src/index.ts`, `src/context-cut.ts`, and `src/context-usage.ts`.
Its current cut, selected-request anchor, response calibration, and resident overhead live in memory.
The `session_start` handler resets that state.
Consequently, a plain SDK history copy is not an approved implementation of this design.

The first implementation-plan task must be an offline feasibility experiment.
Its candidate is host-only replay of the paging lifecycle from captured preparation observations.
The adapter can wrap extension registration to retain handlers and their observed inputs.
It must run those original handlers against the corresponding restored branch positions, without invoking a provider.

Replay must use actual observed inputs and responses, not values derived from the scoring key.
It must preserve the original event order, context snapshots, resident inputs, and provider usage.
It must not append replay events to the canonical transcript or record them as new requests, costs, or probe evidence.
The adapter restores the checkpoint leaf and normal SDK state before the probe begins.

Offline tests must make sure that replay reproduces the source's policy state and outgoing request.
They must cover calibration, an existing cut, recovery tools, native summaries, and repeated restoration.
Comparison can ignore new session IDs, request IDs, and transport timestamps.
It cannot ignore model-visible text, tool definitions, opaque fields, or policy differences.
Restored inputs before the probe must match between siblings.
Each question can affect subsequent selection through the normal policy, but another probe cannot affect it.
A passing message-copy test alone does not satisfy this gate.

If replay cannot preserve these properties without production changes, stop.
Report the failed property and retain the offline evidence.
Do not silently reset paging, modify its policy, repeat paid preparation, or call the result a faithful fork.
A production checkpoint interface or a fresh-conversation design then requires separate approval.

## Conversation structure

An arm is one baseline or paging preparation and its six isolated probe forks.
A stage group contains one baseline arm and one paging arm.
A complete pilot contains one A group and one B group with distinct deterministic seeds.
The batch contains three new groups per stage by default.
The pilot never contributes to the batch aggregate.

Each stage group sends identical preparation prompts to both arms.
Both arms receive the same six probe texts, but each text goes to its own fork.
Assistant output can differ between arms, as in the existing experiment.
No A history, answer, summary, or index enters B.

Each group prepares two source sessions and creates twelve probe forks.
A complete pilot therefore uses four source sessions and twenty-four probe forks.
Session count is not a sample count.
The two arms and the six probes remain grouped by stage, seed, and shared preparation.

The first arm alternates across repetitions of each stage.
Probe order is deterministic and recorded.
Changing probe order must not change the inherited checkpoint or permit cross-probe evidence.

## Checkpoint contents and ownership

The host captures checkpoints only after the preparation prompt settles successfully.
The source session must have no pending request, queued message, failed tool batch, or active compaction.
Preparation must contain no recall probe or recovery-tool execution.
If either occurs, the source cannot supply a valid checkpoint.

Each arm's checkpoint includes these private inputs:

- Native active-branch entries, including system messages, context edits, summaries, tool definitions, and complete assistant fields.
- The checkpoint leaf, original source-entry IDs, effective model and thinking level, configuration, and active tools.
- The observations needed to restore paging policy state without a provider request.
- Host provenance for source prompts, inherited compactions, and actual preparation usage.

The host must not restore from `PiJournal.entries()` or sanitized report JSON.
Those exports are not complete runtime snapshots.
The checkpoint must retain provider fields needed for continuation while keeping their contents out of public artifacts.

Checkpoints stay in private host memory for this design.
Reports export an opaque checkpoint ID, its source leaf, configuration fingerprint, and restoration outcome.
They do not export raw checkpoint objects or opaque reasoning contents.
A deterministic private digest detects checkpoint mutation without exposing its fields.

Each fork receives separate mutable entries, session identity, journal, request counters, tool-call joins, and extension state.
Provider continuation state must also remain separate.
An immutable credential source can be shared, but an observed stream wrapper or mutable request registry cannot be shared.
No model tool can access checkpoint storage, sibling files, scoring keys, or host artifacts.

## Stage boundaries

### Stage A

Prepare the paging arm until all five target source records and current answers are outside its readable selected request.
The baseline must retain zero successful native compactions.
Freeze both arms at that boundary, before a probe or recovery lookup.

Each fork inherits at least 23 successive preparation prompts and receives exactly one probe prompt.
Thus each probe's conversation contains at least 24 user prompts.
Sibling probes do not count toward that minimum.
If this prevents a pre-compaction A boundary, A is inconclusive. The controller must not lower a budget or relabel the stage.

The baseline must remain before native compaction through each A fork's complete response.
If a baseline fork compacts before its final answer, the A stage comparison is inconclusive.
The report still retains that fork's observations.

### Stage B

Use new source sessions and a different seed from A.
Send work without A probes until the baseline completes native compaction and excludes all five B target source records.
The paging arm must also reach exclusion of all five B targets.
Freeze both arms after those conditions and the minimum lineage length are satisfied.

The baseline retains its native summaries and can answer correctly from them.
A correct summary-based answer receives credit.
The report distinguishes baseline summary recall from paging recovery rather than requiring baseline answers to be absent.

### Per-probe wire gate

Preparation selects a candidate checkpoint, not final qualification.
The existing provider observer examines each fork's actual initial outgoing SSE payload before its first HTTP attempt.
All five known paging probes must independently satisfy these conditions:

- The payload trace is complete and belongs to this fork and prompt.
- The corresponding original source entry is absent.
- The latest exact answer is absent from all readable request text.
- Quantity evidence has the existing subject, field, and unit boundaries.
- No sibling probe, answer, recovery result, or summary is present.

Host scoring data supplies these tests, but never enters model instructions or tool output.
If a known paging probe fails its wire gate, do not dispatch its provider request.
Mark the stage inconclusive and stop that stage's probe group.
Do not remove a record, rewrite a result, or keep filling in response to a failed probe.

A and B each require five-of-five qualified known paging probes.
Four-of-five is no longer sufficient.
The unknown control never contributes to this denominator and always uses its own fork.

The gate concerns readable text, not the contents of encrypted reasoning.
Preserve opaque state needed by the provider and report its presence.
A plaintext-absent answer does not prove that the provider forgot the fact.

## Evidence, scoring, and reports

Evidence is local to a probe fork.
A successful recovery requires that fork's qualified initial request, a matched recovery result, and a correct final answer.
The result must precede the final answer and join a request and tool call from that same fork.
A result from another fork never supplies recovery credit.

A broad lookup can expose all five facts inside one fork.
That remains valid retrieval behavior.
Its exposure cannot change another fork's initial visibility or answer evidence.

Keep exact-value scoring, stale-decision scoring, and the unknown-answer control.
Wrong answers remain valid observations when the structural requirements pass.
The report must not turn a wrong answer into a harness failure or select only successful forks.

Introduce a new artifact schema and experiment identity:

- Schema version `3`.
- Workload version `incident-isolated-probes-v3`.
- Conversation design `stage-checkpoint-probe-forks-v1`.
- Explicit checkpoint, fork, stage, arm, seed, prompt, request, and tool-call ownership.
- Separate checkpoint-restoration evidence and per-probe visibility evidence.

The fingerprint includes the new identities and the restoration method.
Legacy shared-probe pilots cannot authorize a batch, including schema version 2 independent-stage pilots.
Reports preserve their scores as historical observations without presenting them as isolated-recovery results.
A new completion record requires both stages, offline restoration evidence, successful cleanup, and complete artifacts.

## Metrics contract

The harness must capture resource use and time, not only answer scores.
The following measurements are required in the new JSON schema and Markdown report.
These are implementation requirements, not a claim that the current harness already captures every field.

Each measurement belongs to a run, stage, seed, arm, checkpoint, and preparation prompt or probe fork.
Provider measurements also identify the logical request, HTTP attempt, and request purpose.
An HTTP attempt is one dispatched transport call.
A logical request can contain several attempts because of retries.

Use integer token counts, USD for cost, and milliseconds for duration.
Use a monotonic clock for durations and UTC timestamps for event correlation.
Retain per-attempt and per-task records before producing aggregates.

### Tokens and cache

Provider usage is the source of measured token counts.
SDK usage supplies normalization and a recorded cross-check, not proof that an omitted provider field was zero.
Policy estimates remain separately labeled estimates and cannot replace measured usage.

| Field | Meaning |
| --- | --- |
| `totalInputTokens` | All provider-reported input tokens, including cached input. |
| `uncachedInputTokens` | Input tokens charged at the ordinary input rate, using native SDK normalization with sufficient provider evidence. |
| `outputTokens` | All provider-reported output tokens, including reasoning when the provider includes it. |
| `reasoningTokens` | The provider's reasoning-token subset, when reported. Do not infer it from opaque data or text length. |
| `totalTokens` | `totalInputTokens + outputTokens`, when both are known. Record that this total is derived. |
| `cacheReadTokens` | Input tokens served from the provider's cache. |
| `cacheWriteTokens` | Input tokens written to the provider's cache, when reported. |
| `cacheReadFraction` | `cacheReadTokens / totalInputTokens`, when both are known and input is greater than zero. |

Cache reads and writes are input components, not additional tokens to add to `totalInputTokens`.
Reasoning tokens are an output subset, not additional tokens to add to `outputTokens`.
The report must not label uncached input as total input.

Retain the safe provider usage fields and their mapping to the normalized fields.
If cache-write usage is omitted, report `null` with a reason, not zero.
An explicit valid zero remains zero.
If a required component is unknown, derived values that depend on it also remain unknown.

### Cost

Capture cost separately for ordinary input, output, cache reads, and cache writes.
The SDK calculation uses the exact pinned model catalog and its native pricing rules.
The manifest records currency, pricing units, applicable tiers, and the model-metadata fingerprint.

| Field | Meaning |
| --- | --- |
| `uncachedInputCostUsd` | Catalog cost of measured uncached input. |
| `outputCostUsd` | Catalog cost of measured output, including its reported reasoning subset only once. |
| `cacheReadCostUsd` | Catalog cost of measured cache reads. |
| `cacheWriteCostUsd` | Catalog cost of measured cache writes. |
| `estimatedCostUsd` | Complete catalog estimate from known usage and prices, using native SDK calculation. |
| `knownCostSubtotalUsd` | Sum of cost components supported by available measurements. Label it partial when any component is unknown. |
| `actualCostUsd` | Billed cost only when a billing source supports attribution to these requests. Otherwise `null`. |

A catalog estimate is not an invoice or a subscription charge.
There is no new billing integration in this scope.
Missing billing data must not erase available catalog estimates or measured cost components.
Billing evidence must identify its source and request attribution.

The provider usage mapping records which components are chargeable.
A documented, non-applicable charge does not block the estimate, but its unsupported usage field remains `null`.
Omission alone cannot establish that a charge is non-applicable.
The report must expose assumptions and missing components beside the cost values.
If a required usage field or price is missing, the complete estimate remains unknown.
A partial subtotal must not be presented as the full cost or used to claim cost savings.

### Response and task time

Response time measures a provider interaction.
Task time measures completion of the whole prompt or probe.
A task can contain compaction, several provider responses, recovery tools, and retries.

| Field | Start and end |
| --- | --- |
| `attemptWallMs` | Immediately before HTTP dispatch through terminal stream consumption, failure, or abort. Receiving headers is not completion. |
| `responseHeadersMs` | HTTP dispatch through receipt of response headers. |
| `timeToFirstModelDeltaMs` | HTTP dispatch through the first nonempty text, reasoning, or tool-argument delta. Lifecycle and usage events do not qualify. |
| `timeToFirstTextMs` | HTTP dispatch through the first nonempty text delta. It can be absent for a tool-only response. |
| `requestWallMs` | Logical provider-request start through its final settlement, including retry attempts and backoff. |
| `promptTaskMs` | Immediately before `session.prompt(...)` through the final `waitForIdle()` boundary or failure. |
| `toolWallMs` | Tool execution start through tool execution end, identified by tool name and call ID. |
| `compactionWallMs` | Native compaction attempt start through its success, cancellation, or failure. |
| `forkSetupMs` | Fork resource creation through SDK initialization, excluding checkpoint restoration. |
| `checkpointRestoreMs` | Restoration start through the offline fidelity gate and probe-ready state. |
| `probeTaskMs` | Fork setup start through restoration, prompt completion, scoring, artifact writes, and fork cleanup. |
| `preparationActiveMs` | Sum of source setup, its preparation prompt tasks, and checkpoint capture. Exclude time spent waiting for the other arm. |
| `armActiveMs` | `preparationActiveMs` plus this arm's six `probeTaskMs` values. |
| `stageGroupWallMs` | Stage-controller start through both arms' cleanup and stage artifact completion. |
| `runWallMs` | Run start through preflight, all stages, cleanup, and final artifact completion. |

`promptTaskMs` includes tools, compaction, retries, and backoff inside that prompt.
`probeTaskMs` also includes host work and restoration overhead.
The report must show both, rather than calling either one only latency.

Keep host timing for checkpoint capture, scoring, artifact writes, and cleanup as separate phase records.
If those phases overlap, retain their intervals and do not sum overlapping wall time.
Nested tool, request, and compaction durations explain task time. They are not added to it again.

Record termination status for every timed operation.
If an operation stops early, label its observed duration failed, aborted, or censored rather than a successful completion time.
If no qualifying delta arrives, first-delta and first-text metrics remain `null` with a reason.

### Counts, scope, and comparison

Capture dispatched prompts, logical requests, HTTP attempts, retries, provider errors, and recovery-tool calls by name.
Record native compaction attempts, successes, failures, and cancellations.
Report these counts beside token, cost, and time measurements so additional recovery work remains visible.

Show metrics separately for preparation and each probe.
Within either scope, show conversation usage and compaction subtotals.
Compaction is already included in the scope's total, not an extra charge to add afterward.

Arm usage equals preparation usage once plus newly executed usage from its six forks.
Stage totals include both arms, and run totals include each executed stage group once.
Inherited checkpoint entries and host replay create no new provider usage.
They do create restoration time, which belongs to the fork's task duration.

Preserve all dispatched attempts, including failed and aborted attempts.
A failure can consume tokens even when the SDK appends no successful assistant entry.
Missing usage for that attempt remains unknown, not evidence of zero cost.
Deduplicate provider observations against SDK assistant, explicit-usage, and compaction records.
SDK session statistics remain a separate cross-check because fork statistics can include inherited preparation.
They are never added to the actual-dispatch totals.

For each stage, seed, and probe, report paired differences as paging minus baseline.
Include total input, output, cache reads and writes, catalog cost, request counts, and prompt and probe task time.
Show preparation differences and whole-arm differences separately.
Cache-hit fractions are recomputed from aggregate token counts, not averaged across requests.

The summary shows individual values, totals, and mean, median, and range for response and task durations.
Separate ordinary response timings from compaction response timings.
Show sample counts and measurement coverage beside every aggregate.
Keep stages A and B separate and preserve their seed groups.
Sibling forks do not become independent preparation samples or justify a stronger statistical claim.

### Missing data and artifacts

Every required field must be present, even when its value is `null`.
Record whether a value is observed, derived, not reported, not supported, invalid, incomplete, or not applicable.
A missing optional provider field differs from a lost harness measurement.

If any required observation for a total is missing, label the complete total unknown.
Show the measured subtotal with observed and missing counts instead of silently treating missing values as zero.
Paired differences require complete comparable values. Otherwise their result is `null` with the missing reason.

Machine-readable artifacts retain request, attempt, prompt, tool, compaction, restoration, and host-phase records with their ownership IDs.
The Markdown report includes token and cache tables, cost component tables, response and task timing tables, and paired comparison tables.
Both formats expose measurement coverage and failures without exposing credentials or opaque reasoning contents.

Provider omissions do not invalidate otherwise complete recall evidence when they are explicitly reported.
Loss of mandatory harness timing or ownership evidence blocks a complete run record.
No report can claim cost, cache, or speed gains from missing measurements.

## Cost and safety

Keep the exact model `openai-codex/gpt-6-luna`, `xhigh` thinking, and full-payload SSE observation.
Paging stays at 128,000 tokens with an 80,000-token trim target.
Native model metadata and compaction defaults remain unchanged.
Production retrieval tools and paging policy remain unchanged.

Apply existing limits across an entire arm, not separately to every fork.
The defaults remain 64 dispatched user prompts per arm, 12 provider requests per prompt, and 256 provider requests per arm.
The stage group retains the 120-minute wall-time limit.
Preparation, fork requests, compaction streams, retries, and HTTP attempts all consume their existing shared limits.
Restoration cannot reset an allowance or remove a safety stop.

The metrics contract defines token, cache, cost, and time accounting.
Count actual preparation usage once per arm and only newly executed requests for each probe fork.
Inherited assistant and compaction entries retain provenance but do not create new billed usage.
Unknown measurements stay unknown rather than becoming zero.

A checkpoint is not a provider cache guarantee.
Report observed cache usage and actual requests without claiming savings from session count alone.
No live pilot or batch starts until the offline gate passes, the implementation is approved and committed, and the user authorizes that run.

## Required offline evidence

Use the real pinned SDK and deterministic provider fixtures.
A provider-free dry run cannot replace runtime restoration tests.
The permanent tests belong to implementation, not this documentation change.

The tests must cover these behaviors:

- Restored native history and projections match the checkpoint, including summaries, context edits, tool definitions, and opaque-field preservation.
- Paging restoration reproduces an existing cut, calibration, resident overhead, and subsequent cut behavior without additional provider calls.
- Baseline restoration retains native compaction and defaults without carrying paging tools.
- One lookup returns several target facts. Only that fork receives them, and all sibling initial payloads remain uncontaminated.
- Sibling answers, tool calls, errors, compactions, and journal entries never enter the checkpoint or another fork.
- Source provenance remains correct after restoration, including revised decisions and quantity records.
- Recovery joins reject another fork's matching request ID, tool-call ID, or result.
- Probe-order permutations preserve checkpoint digests and each probe's inherited input.
- Five-of-five gates reject a visible fifth answer, missing source evidence, and incomplete payload traces. Opaque presence alone cannot establish plaintext absence.
- The unknown control inherits no known probe's result and receives no supported value from the host.
- Shared guards and usage totals do not reset or multiply inherited preparation costs across forks.
- Token totals do not double-count cache components or reasoning. Missing cache-write usage differs from an explicit zero.
- Native pricing, cost components, partial subtotals, and complete estimates preserve measurement presence and unknown prices.
- Attempt, request, prompt, probe, restoration, and host-phase timers use deterministic clock fixtures and their defined boundaries.
- First-delta timers ignore lifecycle events, and tool-only responses do not fabricate a first-text measurement.
- Failed attempts retain counts, timing, and available usage. Nested compaction and tool records do not duplicate total cost or time.
- Paired differences, cache fractions, and measurement coverage use the correct scopes and reject unknown operands.
- Restoration failure, failed artifact writes, source drift, and cleanup failure block pilot and batch eligibility.

Run repository checks and a provider-free dry run after implementation.
Retain offline evidence before requesting a paid pilot.
No automated test of documentation wording is required for this draft.

## Acceptance and next decision

The experiment can claim isolated paging recovery only when both stages contain five separately qualified known paging probes.
Each probe must use its own faithfully restored checkpoint fork.
Tool results remain unrestricted, but cannot cross fork boundaries.
The report must preserve missing evidence, wrong answers, unknown usage, and opaque-state limits.
It must also expose the required token, cost, cache, response-time, and task-time metrics at each defined scope.
Shared preparation and nested compaction must not inflate totals.
Missing provider measurements remain explicit, and lost mandatory harness timing blocks a complete run record.

SDK stored-history isolation is supported by the temporary unpaid audit.
Full runtime restoration remains a blocking implementation prerequisite, not an established capability.
User approval of this written design permits an implementation plan whose first task proves that prerequisite offline.
If it fails, the task stops for a new design and cost decision before any paid work.
