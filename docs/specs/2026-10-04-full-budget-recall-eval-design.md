# Full-budget Pi recall eval

Date: 2026-10-04

Status: Written spec approved for implementation planning on 2026-10-05.

## Purpose

This eval compares Pi with and without `pi-context-paging` during one long session per arm.
Later prompts ask for exact facts from earlier prompts.
The eval measures whether the model answers correctly after context paging or native compaction.

The user rejected small-budget tests.
The eval therefore uses the real 128,000-token paging budget and the 80,000-token trim target.
The baseline keeps its native context window and compaction settings.

The eval records three kinds of answer evidence:

- An original message that remains in the outgoing request.
- A summary or other resident message that retains the answer.
- A recovery tool result that returns an answer absent from the readable initial request.

Codex can retain encrypted reasoning that the host cannot inspect.
The eval does not claim to prove that the model forgot a fact.

The eval does not assume that paging improves recall.
A baseline summary that preserves an exact answer is a valid baseline success.

## Approved scope

- At least 24 successive user prompts in each session.
- The exact model `openai-codex/gpt-6-luna` with `xhigh` thinking.
- Two isolated Pi sessions with identical user prompts and common instructions.
- An unchanged native-compaction baseline.
- A paging arm with the four recovery tools.
- Substantive work packets rather than repeated filler.
- Separate recall stages after paging and after baseline compaction.
- Hidden exact-value scoring without an LLM judge.
- Request traces, recovery traces, usage, latency, and cost estimates.
- One pilot pair before a batch of three matched pairs.
- Automated tests for reusable scoring, trace analysis, and stage control.

Production paging behavior stays unchanged.
This eval does not compare `billion-context-pi`.
It does not measure file recovery, coding-tool performance, or general engineering quality.

## Experiment settings

| Item | Baseline | Paging |
| --- | --- | --- |
| Pi SDK | Repository-pinned `@earendil-works/pi-coding-agent` 0.87.1 | Same version |
| Provider | `openai-codex` | `openai-codex` |
| Model ID | `gpt-6-luna` | `gpt-6-luna` |
| Thinking | `xhigh` | `xhigh` |
| Model context window | Native catalog value | Same native value |
| Auto-compaction | Native defaults | Enabled in settings, canceled by the real paging extension |
| Compaction reserve | Native default: 16,384 tokens | Same setting |
| Recent compaction history | Native default: 20,000 tokens | Same setting |
| Paging budget | No paging extension | 128,000 tokens |
| Paging trim target | No paging extension | 80,000 tokens |
| Recovery tools | None | Four tools from the real extension |
| Built-in file and shell tools | Disabled | Disabled |
| Other resources | No unrelated extensions, skills, or context files | Same exclusions |

The current catalog advertises a 272,000-token window for this provider and model.
The corresponding native compaction threshold is 255,616 tokens.
This threshold is not a new baseline limit.

The harness records the resolved catalog metadata before each pair.
Both arms use the same resolved model metadata.
A metadata change must not silently change one arm during a pair.

The harness checks that the provider exposes the exact model and supports `xhigh`.
An unavailable model or a lower effective thinking level stops the run.
The harness never substitutes another model, provider, or thinking level.

The harness uses the existing Codex credentials through Pi's model runtime.
It does not copy credentials into fixtures or result files.
It does not change the user's default model or global settings.

These are minimal Pi SDK sessions, not sessions with the user's complete interactive extension collection.
The baseline still uses Pi's real session lifecycle, provider implementation, token accounting, and native compaction.

## Workload

### Scenario

The workload is a fictional incident investigation.
Each work packet contains coherent source excerpts, deployment records, settings, or logs.
Each prompt asks for a concrete analysis, such as a causal comparison or an incident timeline update.

The packets are substantial enough to create long-session pressure.
They do not repeat a paragraph to fill the context window.
The workload generator uses a seed and produces reproducible packets.
Each work packet targets 8,000 to 12,000 estimated tokens, with its actual size recorded.
This packet-size target is not a new session budget.

Early packets introduce exact facts from these categories:

- Opaque deployment IDs and recovery tokens.
- File paths and exact error strings.
- Numeric values with named fields and units.
- Decisions that select a named deployment or rollback target.

Some early decisions change before the recall stages.
A later probe asks for the latest applicable value, not the superseded value.

The harness also asks about facts never supplied in the session.
The correct answer for these probes is an explicit unknown value.
This negative control measures unsupported answers.

The prompts use neutral instructions.
They do not tell only the paging arm to search history.
The extension's own notice and tool descriptions provide the recovery instructions.

### Fact isolation

The host stores the answer key outside both model contexts.
The model cannot read fixture files, the harness source, or result files.
Neither arm has a file, shell, or network tool for alternate recovery.

Work packets do not intentionally repeat earlier target values.
The model can repeat a value in its own answer.
The trace analyzer therefore checks actual requests instead of assuming that a fact disappeared.

The two recall stages use disjoint target facts.
An answer in the first stage must not expose a target from the second stage.
The analyzer also checks for accidental cross-stage exposure.

Each stage contains six probes: five known facts and one unknown fact.
Across both stages, the known probes cover each fact category and at least one revised decision.
The unknown probes ask about different absent facts.

Opaque, unique values provide the strongest evidence of exact recovery.
For common numbers or words, the analyzer requires field-specific evidence.
An unrelated occurrence of the same number does not prove meaningful visibility.
An ambiguous occurrence remains unclassified.

### Shared prompt sequence

Both arms receive the same user text in the same order within a pair.
Assistant responses and tool calls can differ.
The host records the exact shared prompt sequence in the pair artifacts.

The controller sends each prompt to both sessions and waits for both sessions to become idle.
It then decides whether to send another work packet or the next probe group.
A tool follow-up is not an additional user prompt.

The first arm alternates between pairs.
Within a pair, the prompts run sequentially across the two arms.
Independent session IDs prevent transcript sharing.
The report retains provider cache measurements because request order can affect cache use.

## Recall stages

### Stage A: after paging, before baseline compaction

The controller sends work packets until the paging arm excludes the relevant early source messages.
The baseline must have no successful compaction at this stage.
The first probe group then asks for the stage A facts.

Each probe has a separate visibility classification from its initial outgoing provider request.
A visible answer is a resident-recall case, not proof of paging recovery.
The stage needs at least four known probes with source messages excluded and answers absent from readable initial request text.
The unknown probe does not contribute to this minimum.

The report preserves the exact number of qualified probes.
It does not hide visible or ambiguous cases.

### Stage B: after native baseline compaction

The controller resumes substantive work after stage A.
It continues until the baseline completes native compaction and excludes the stage B original source messages.
The second probe group then asks for the stage B facts.

A summary can retain a fact after its original message disappears.
The baseline receives credit for a correct answer from that summary.
The report distinguishes summary recall from an answer absent from the initial request.

The second group must bring each arm to at least 24 user prompts.
The controller adds work packets before this group if the prompt count is too small.

### Stage validity

The controller does not force manual compaction or lower either budget to reach a stage.
A canceled compaction attempt is not a successful compaction.
A paging notice alone does not prove that a target answer is absent.

If baseline compaction occurs before stage A qualifies, the pair cannot establish the intended stage A comparison.
The report marks that stage inconclusive.
It does not relabel a post-compaction probe as a pre-compaction probe.

If a safety limit prevents stage completion, the report marks the pair incomplete or inconclusive.
A missing stage never becomes a passing recall result.

## Scoring

Each probe requests one JSON object with a documented answer field.
Known answers use string values with exact identifiers, paths, error text, or numeric representations.
Unknown answers use JSON `null`.

The scorer parses the final assistant answer after the session becomes idle.
It accepts surrounding whitespace and one complete Markdown code fence.
It rejects malformed JSON, missing fields, multiple answer objects, and incorrect value types.
The scorer does not search arbitrary prose for an expected substring.

The answer key defines exact expected values.
The scorer does not change case, rewrite paths, paraphrase errors, or accept a superseded decision.
A response with the wrong answer scores zero, even if a recovery tool returned the correct value.

Each probe receives one point or zero points.
The report shows known-fact accuracy and unknown-fact accuracy separately.
It also shows stage totals, fact-category totals, and revised-decision accuracy.

The report retains all probe outcomes.
Qualified recovery accuracy uses known probes with excluded source messages and answers absent from readable initial request text.
The report includes its denominator beside that metric.

## Request and recovery evidence

A common read-only observer runs in both arms.
It observes the outgoing provider payload after context transformation.
It does not replace messages, payloads, tools, headers, or compaction results.

Both arms use stateless SSE requests with complete payloads and `store: false`.
The harness disables cached WebSocket continuation for both arms.
This shared transport setting prevents connection state from obscuring the request evidence.
It does not change either arm's context budget or thinking level.

The observer records readable provider input, prompt identity, request identity, and model identity.
It records no authorization headers, cookies, credentials, or environment dumps.
The payload parser targets the pinned Codex response API.
An unsupported payload shape produces an explicit trace error.

Codex requests can contain encrypted reasoning items from earlier responses.
The observer records their presence, counts, and hashes, not their encrypted contents.
The artifact writer removes encrypted signatures from exported transcripts without changing the live session.

An answer absent from readable text can still exist in encrypted reasoning.
Every probe therefore records `opaqueReasoningPresent` separately from its readable visibility label.
The report never describes readable absence as proof of absence from all model state.

The harness also records session events and compaction entries.
These events identify source-message removal, successful compaction, recovery tool calls, and recovery tool results.
The original prompts remain available to the host for source-ID matching.
They are not available as an extra model tool.

The session runner builds the origin index from the pinned SDK's `convertToLlm()` output.
Each origin retains its original prompt ID or compaction entry ID alongside the converted role and text blocks.
Compaction summaries therefore match their outgoing `user` role and SDK wrapper, not the raw stored summary text.
The payload parser does not copy the SDK's wrapping rules.
If converted origins match ambiguously, the analyzer returns `unclassified`.

Each known probe receives one initial visibility label:

| Label | Evidence |
| --- | --- |
| `resident-original` | The original source message remains in the initial outgoing request. |
| `resident-summary` | The source is absent, but a resident compaction summary retains the answer. |
| `resident-other` | Another resident message retains the answer. |
| `plaintext-absent` | The readable request contains no answer evidence, and the original source message is excluded. |
| `unclassified` | The trace is incomplete, unsupported, or ambiguous. |

The analyzer checks the first request for a probe before any probe-triggered recovery.
Later requests can contain recovered content and therefore need separate records.

An observed recovery success requires all three conditions:

1. The source message was excluded, and the answer was absent from readable initial request text.
2. An observed paging tool result returned answer evidence before the final answer.
3. The final answer matched the hidden answer key.

This evidence proves successful tool recovery, not that the tool was necessary for the model to answer.
Encrypted reasoning prevents that stronger causal claim.

A search reference that contains the answer can establish recovery.
A tool call without answer evidence in its result cannot establish recovery.

A correct answer without readable evidence or an observed recovery remains a separate outcome.
The report does not assume that such an answer came from a paging tool or a guess.
Unknown probes have no answer-presence or recovery-success classification.

## Harness structure

The eval uses the real exported extension factory.
It does not replace context selection or history recovery with a test double during live runs.

The implementation separates these modules:

- A workload generator owns packets, fact versions, probe groups, and seeds.
- A session runner owns explicit Pi resources, provider access, tracing, and cleanup.
- A pair controller owns the shared prompt sequence, stage gates, and safety limits.
- A scorer owns exact JSON scoring without provider access.
- A trace analyzer owns answer visibility and recovery evidence.
- A report writer owns manifests, JSON results, and the Markdown summary.

Both sessions use independent in-memory session managers.
Both use explicit in-memory settings and explicit resource loading.
The paging factory receives explicit paging settings for the treatment arm.
This prevents global or project resource discovery from changing the experiment.

The harness waits for Pi's idle boundary after each prompt.
It does not treat the first `agent_end` event as final completion.
Automatic recovery, retries, compaction, and tool follow-ups can continue after that event.

The harness disposes both sessions in a final cleanup path.
It records extension-loading errors and provider errors separately from wrong model answers.

## Safety limits and failures

The following defaults bound the initial implementation:

| Limit | Default |
| --- | --- |
| User prompts per arm | 64 |
| Provider requests per prompt | 12 |
| Provider requests per arm | 256 |
| Wall time per pair | 120 minutes |

Each limit is configurable and appears in the manifest.
A limit stops further work and aborts active work where Pi supports cancellation.
The report preserves completed prompts, usage, and failure evidence.
A limit does not trigger a smaller context budget or another model.

A provider error or an extension-loading error makes the affected pair incomplete.
The controller does not silently advance past a failed prompt.
The native retry policy remains equal in both arms.
Retries remain visible in the request counts and latency.

Malformed or incorrect probe answers are model outcomes, not infrastructure errors.
Missing trace evidence prevents qualified recovery claims but does not erase observed answer scores.

## Results and usage

Result artifacts use the ignored directory `.pi/evals/full-budget-recall/<run-id>/`.
The host writes these artifacts, but the model cannot read them.

Each run contains:

- A manifest with versions, source revision, source-integrity policy, model metadata, thinking level, settings, seeds, and safety limits.
- The exact prompt sequence and a hash of that sequence.
- Separate session transcripts and request traces for both arms.
- Compaction and recovery events.
- A scored record for every probe.
- A JSON summary and a readable Markdown report.

The report includes per-arm and paired measurements:

- Exact known-fact accuracy and correct unknown responses.
- Stage completion and qualified recovery coverage.
- Readable answer visibility, opaque reasoning presence, and observed recovery success.
- Recovery call counts by tool and successful baseline compactions.
- Provider request counts, retries, and operational errors.
- Input, output, cache-read, and cache-write tokens where Pi reports them.
- Reported compaction usage, without double counting session totals.
- Per-prompt latency and total pair duration.
- Catalog-estimated cost and missing usage fields.

Codex subscription use is not necessarily direct API billing.
The report labels monetary values as catalog estimates, not invoices or quota guarantees.
A missing cost or usage field is unknown, not zero.
The pinned SDK replaces omitted provider token fields with zero before persistence.
The transport observer therefore captures field presence from incoming terminal SSE responses before the SDK normalizes usage.
It records only allowlisted numeric usage fields, not raw response bodies or private values.
An omitted field remains missing, while an explicit numeric zero remains measured zero.

The session runner joins these observations to persisted usage-bearing entries in a typed usage ledger.
A compaction entry can combine several requests, so its ledger record retains every contributing request's measurement presence.
Missing observations or components make the affected totals unknown.
Input totals require all components of the SDK's input calculation to be present.
Cost estimates require complete usage components and catalog prices.
The report uses normalized SDK values only where the captured presence supports them.

The ledger counts each persisted usage-bearing entry once.
Compaction usage remains a subtotal, not a second addition to the session total.
The session statistics remain a cross-check, not another source to sum.
Cache-sensitive latency and cost comparisons remain descriptive.

## Execution and interpretation

The pilot runs one matched pair with a recorded seed.
It checks stage completion, payload tracing, fact isolation, answer parsing, and cleanup.
The pilot is not part of the three-pair batch score.

Live runs use the `clean-checkout-v1` source-integrity policy.
Before live preflight, the CLI requires a clean checkout and records its full Git commit ID.
The check rejects staged changes, unstaged changes, and non-ignored untracked files.
The eval and extension modules must be tracked files from that checkout.
The entry point performs this check before loading the live eval modules, resolving credentials, or creating sessions.

The checkout must remain unchanged during the run.
The CLI rechecks cleanliness and the recorded commit before each pair, each model HTTP attempt, and successful finalization.
A failed source check stops further requests, preserves partial artifacts, and prevents pilot eligibility.
Custom artifact directories must be outside the checkout or ignored by Git.

The experiment fingerprint includes the source revision and source-integrity policy with the existing experiment settings.
Batch startup requires an eligible pilot with the same fingerprint and verified source integrity.
Missing source-integrity evidence cannot authorize a batch.
An uncommitted eval edit at unchanged HEAD must fail before any live preflight or model request.
A committed harness change requires a fresh pilot at the new revision.

The batch runs three matched pairs with different fact seeds.
The first-arm order alternates between pairs.
The report shows individual pairs and paired differences, not only aggregate averages.

Three pairs provide an initial comparison, not a strong statistical claim.
The report does not declare a winner from an invalid pair, missing stage, or leaked answer.
Additional repetitions can use the same harness without changing the experiment settings.

## Verification

The implementation includes automated tests for reusable behavior:

- Seeded packets, fact revisions, and disjoint probe groups.
- Exact answer parsing, unknown answers, and superseded answers.
- Source, SDK-wrapped summary with its outgoing role, resident-copy, plaintext-absent, and ambiguous visibility.
- Opaque reasoning flags and safe artifact exports.
- Full-payload SSE transport in both ordinary and compaction requests.
- Recovery evidence across initial and follow-up requests.
- Stage control, shared prompt order, minimum prompt count, and safety limits.
- Session cleanup and partial reports after errors.
- Real-adapter handling of omitted usage fields versus explicit zero, including compaction requests.
- Usage aggregation with measurement presence and without duplicate compaction costs.
- Pilot rejection for dirty sources at unchanged HEAD, changed revisions, and missing source-integrity evidence.

A deterministic fake provider supports harness tests without paid model calls.
A provider-free dry run shows the workload, settings, and expected artifacts.
Neither path substitutes for the full-budget live pilot.

The existing test suite remains a regression check for production paging behavior.
Documentation and static settings receive direct review instead of new content-assertion tests.

## Acceptance criteria

The harness is ready for use when these conditions hold:

1. Both arms run real Pi sessions with the exact selected model and effective `xhigh` thinking.
2. Both arms receive identical user prompts within each pair.
3. The treatment uses 128,000/80,000 paging settings without production code changes.
4. The baseline retains its native window and default compaction behavior.
5. A valid live pair contains at least 24 user prompts per arm and both required recall stages.
6. The result distinguishes resident recall, summary recall, and observed paging recovery, with explicit opaque-state limits.
7. No model tool exposes answer keys, fixture files, or host artifacts.
8. All limits, incomplete stages, errors, and unknown measurements appear in the report.
9. Automated harness tests and the existing paging tests pass.
10. One valid pilot precedes the separate three-pair batch at the same verified clean source revision.
11. Summary origins use canonical SDK conversion, and unknown usage survives provider normalization through transport-level presence records.

An inconclusive live pair can prove that failure reporting works.
It cannot satisfy the live-stage acceptance criterion or support an effectiveness conclusion.

## Evidence used for this design

- `bench/context-policy.bench.ts`: the existing benchmark measures synthetic policy and navigation performance.
- `src/index.ts`: paging uses the context hook and cancels only automatic compaction.
- `src/settings.ts`: the normal budget and trim target are 128,000 and 80,000 tokens.
- The pinned SDK declarations expose provider-payload observation, session events, idle waiting, and compaction usage.
- The pinned SDK native compaction predicate is `contextTokens > contextWindow - reserveTokens`.
- The local catalog supports `xhigh` for `openai-codex/gpt-6-luna` and advertises a 272,000-token context window.
- The pinned Codex provider requests encrypted reasoning and can use cached WebSocket continuation even with `store: false`.

No live eval ran during the design step.
