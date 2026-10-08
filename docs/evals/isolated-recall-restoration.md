# Offline checkpoint restoration and isolated flow

This experiment uses Pi SDK 0.87.1 and the unchanged paging extension.
It uses local SSE provider fixtures, not a live provider.
It does not read real credentials or send paid requests.
The fixtures retain native model metadata, compaction defaults, and the 128,000/80,000 paging configuration.

## Restoration method

`host-lifecycle-replay-v1` records original handler events, host reads, results, native projections, and resident configuration.
A fresh extension instance receives these observations through a read-only host facade.
The facade ends before the next native request.
Baseline restoration copies native history without loading paging tools.

The tape is a private in-memory handle.
Its serialization method throws.
Reports do not contain native checkpoints, tapes, or opaque continuation content.
A private digest detects checkpoint mutation without exporting checkpoint fields.

Restoration compares every observed handler result.
It also compares the native branch, projection, model metadata, resident system prompt, and tool declarations.
Unknown tapes and changed configuration fail before replay.
Restoration causes zero additional provider dispatches.

## Feasibility evidence

The native-history-copy control failed all three original restoration tests.
A fresh paging instance lost calibrated selection and subsequent cut behavior despite preserving native entries.
The host replay implementation passed the five focused restoration tests.
Those tests cover these cases:

- A calibrated cut with reported input use and resident overhead.
- A context edit that changes an inherited record.
- A native compaction summary.
- A recovery call and its subsequent request.
- Independent restores followed through eight further requests.
- A restore after the source and earlier restores advance.
- Changed model, tool, and paging configuration.
- An unknown tape and a serialization attempt.

Native entries, parent links, projections, synthetic opaque fields, and resident declarations remain equal.
The next request and later request selections match the uninterrupted fixture.
Advancing a source or sibling does not change the frozen tape.
Preparation captures refuse pending messages, active continuation, failed prompts, recall probes, and preparation recovery.

## Identity controls

The SDK creates random IDs for new native entries.
Without fixture controls, the fifth subsequent request differs only in the ID inside the paging notice.
Both IDs identify the same new assistant entry at the same branch position.

The trajectory fixture supplies deterministic UUID values during matched subsequent prompts.
It restores the normal UUID generator after each prompt and fixes the clock.
Inherited IDs remain unchanged.
The comparison removes only the transport cache key after making sure that it equals the session ID.
It does not rewrite model-visible notices, entry IDs, opaque fields, or tool declarations.

The native adapter represents a tool identity as `call_id|item_id`.
The observer retains the separate wire IDs to join recovery evidence against that exact identity.
A regression rejects a foreign call ID, foreign item ID, and extra identity segment.
Same-fork ownership and observed execution remain required.

## Full SDK and CLI evidence

The full-budget integration uses the real native SDK, Codex transport adapter, paging extension, stage controller, CLI, and artifact writer.
Only provider responses come from local fixtures.
The pilot fixture prepares four sources and restores twenty-four independent forks with distinct A/B seeds.
Every fork inherits at least 23 preparation prompts and receives one question.
Both stages qualify all five known paging probes before dispatch.

One real `search_history` lookup returns all five latest target facts in its fork.
The fixture includes revised decision and quantity records.
Sibling forks contain no inherited lookup result and answer `null` without recovery.
The unknown control also answers `null` without receiving a supported host value.
Baseline B retains native compaction, while baseline A retains zero successful compactions through its responses.

The integration counts actual source and fork dispatches against their usage records and shared allowances.
Inherited history does not multiply preparation usage.
Session creation and restoration cause zero provider dispatches.
All source and fork sessions are aborted and disposed at cleanup.
Wrong answers remain observations, and the otherwise complete pilot produces `completion.json`.

The retry fixture dispatches two failed HTTP attempts but retains only one SDK assistant entry.
Both attempts remain in execution accounting with missing usage reported as unknown.
The logical request and attempted streams retain their failure status.
No completion marker exists for that run.

The real writer also receives scripted restoration, source-drift, artifact-write, session-cleanup, and global-cleanup failures.
These controls preserve writable partial evidence and block completion.
Optional reasoning usage remains `null` with missing coverage in a structurally complete run.
Billed cost remains `null` without attributable billing evidence.
Credentials, provider error bodies, checkpoints, replay tapes, and opaque contents remain outside public artifacts.

## Verification commands

Run these commands from the task worktree:

```sh
node --test --experimental-strip-types tests/eval-recall.paging-replay.test.ts
node --test --experimental-strip-types tests/eval-recall.pair-sdk.test.ts tests/eval-recall.cli.test.ts
npm run check
npm run eval:recall -- --dry-run
npm run eval:recall
git diff --check
git diff 7595663 -- src/ package.json package-lock.json
```

The focused SDK and CLI integration suite passed all 24 tests.
Both eval invocations reported a provider-free dry run.
Whitespace verification passed, and the production-source and dependency-pin diff was empty.
Documentation and dry-run wording receive direct review, not static content-assertion tests.
The full repository check remains required before implementation approval or a live run.

## Limits and next authorization

These results establish fidelity for the pinned SDK and observed lifecycle, not direct inspection of private paging state.
Unknown host actions and incomplete observations fail closed.
The recovery trajectory fixture is not valid source preparation for an evaluation stage.
The full-flow fixture uses separate valid source preparation before isolated probing.

Synthetic opaque fields establish preservation, not real provider reasoning continuity.
Fixture-controlled identities do not establish production randomness or cache behavior.
Local responses do not measure real recall effectiveness, provider caching, billed cost, or speed gains.
A checkpoint is not a provider cache guarantee.

This evidence does not authorize a live pilot or batch.
First obtain implementation review and approval, with a committed clean checkout.
A fresh pilot requires explicit user authorization, and a later batch requires separate authorization after pilot review.
See [the run guide](full-budget-recall.md) for schema 3 identities, shared limits, private artifacts, and measurement scopes.
