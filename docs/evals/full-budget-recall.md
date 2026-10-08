# Full-budget isolated recall evaluation

This development harness compares baseline recall with paging recovery through separate questions.
A checkpoint is the prepared conversation before any recall question.
A fork is an independent session restored from that checkpoint.
Stages A and B use separate preparation histories and deterministic seeds.
Production paging code and dependency pins do not change.

## Fixed configuration

The harness uses `openai-codex/gpt-6-luna`, `xhigh` thinking, and the repository-pinned Pi SDK 0.87.1.
Both arms use identical native model metadata and compaction defaults.
The paging budget is 128,000 tokens, with an 80,000-token trim target.
The harness never substitutes a model or lowers these budgets.

Server-Sent Events (SSE) carries every model request.
The harness observes the native Codex adapter without replacing its request construction.
Sessions contain no file tools, shell tools, unrelated extensions, skills, or context files.
Only paging sessions receive the four unchanged history tools.
Tools cannot access checkpoints, sibling sessions, scoring keys, or host artifacts.

## Offline preparation and source integrity

Use Node.js 22.19 or later.
From the source checkout, install dependencies and run the offline commands:

```sh
npm ci --ignore-scripts
npm run check
npm run eval:recall -- --dry-run
npm run eval:recall
```

Both eval commands report a dry run.
Neither reads credentials, creates source sessions or forks, or sends provider requests.
Runtime restoration tests use local provider fixtures at the full budgets.
Read [the offline findings](isolated-recall-restoration.md) before requesting a live run.
A dry run alone does not establish restoration fidelity, which means equivalent history, paging state, and outgoing model input.

Do not run a live pilot or batch without separate user authorization for that run.
First obtain implementation approval and commit all harness changes.
Then authenticate through Pi with the existing Codex account.
The harness uses Pi's model runtime and active agent directory without copying credentials into artifacts.
Missing credentials, unavailable models, or unsupported thinking levels stop the run without a substitute.

The entry-point checkout must contain tracked live sources.
It must contain no staged edits, unstaged edits, or non-ignored untracked files.
The manifest records the full Git revision and the `clean-checkout-v1` source policy.
The harness enforces this policy before live imports, every HTTP attempt, and finalization.
Retries receive the same source check.
Keep source files unchanged throughout the run.

Git ignores the default output directory, `.pi/evals/full-budget-recall`.
A custom output directory must be outside the checkout or inside an ignored path.
Source drift stops further requests and removes verified source-policy evidence from writable artifacts.
After a fix, rerun offline verification and commit the changed harness.
A replacement pilot requires fresh user authorization.

## Sources, checkpoints, and isolated questions

An arm contains one baseline or paging source and six probe forks.
A probe is one recall question, with its own answer and evidence.
A stage group contains both arms, with two sources and twelve forks.
Each arm receives five known questions and one unknown control.
Both arms receive identical preparation prompts and probe texts.

Each source must complete at least 23 successive preparation prompts before capture.
Each fork then receives exactly one probe prompt, so its lineage contains at least 24 user prompts.
Sibling probes do not contribute to that minimum.
Preparation contains no recall probes or history-tool execution.
The source must settle without pending requests, queued messages, failed tools, or active compaction.

Checkpoints remain private host objects, not sanitized transcript exports.
They retain native entries, parent links, source provenance, summaries, configuration, and provider continuation fields.
Paging restoration uses `host-lifecycle-replay-v1` to replay observed lifecycle inputs through a fresh extension instance.
Baseline restoration copies native history and keeps native compaction defaults without paging tools.
Restoration makes zero provider requests.

Each fork has separate mutable history, paging state, request counters, journal, and tool-call joins.
Reports contain checkpoint IDs, source leaves, configuration fingerprints, and restoration outcomes, not private checkpoints or replay tapes.
A lookup can return all five target facts inside one fork.
The harness does not narrow tool arguments or filter returned facts.
That result cannot enter another fork or alter its checkpoint.

## Stage boundaries and qualification

Stage A freezes its sources after paging excludes all five target sources and latest exact answers from readable selected input.
The baseline must retain zero successful native compactions before capture and through each A probe response.
If the minimum lineage prevents this boundary, A is inconclusive.
The controller does not lower budgets to force a result.

Stage B starts with new sources and a different seed.
The baseline must complete native compaction and exclude all five target sources before capture.
Paging must also exclude all five target sources and latest answers.
No A question, answer, recovery result, summary, or index enters B.
A baseline answer from its retained summary receives normal scoring credit.

The initial outgoing payload supplies final qualification, not the candidate checkpoint alone.
Before HTTP dispatch, each known paging probe must have a complete trace with the correct fork and prompt ownership.
Its original source and latest exact answer must be absent from every readable part of that payload.
Quantity evidence retains subject, field, and unit boundaries.
The gate also rejects sibling questions, answers, recovery results, and summaries.
A rejected payload is not dispatched, and the controller stops that probe group.

Each stage requires five-of-five qualified known paging probes.
The unknown control uses its own fork and never contributes to that denominator.
Exact-value and stale-decision scoring remain unchanged.
Wrong answers remain scored observations, not infrastructure failures.
Successful recovery requires a matched same-fork history-tool result before a correct final answer.

Encrypted reasoning is opaque: the host cannot read it.
The checkpoint preserves required opaque fields, while reports expose only their presence and safe digests.
A plaintext-absent answer does not prove that the provider forgot the fact.
Synthetic offline reasoning fixtures establish preservation, not real provider reasoning continuity.

## Authorized pilot and later batch

A complete pilot contains one A group and one B group.
It uses four sources and twenty-four forks.
Only after offline verification, implementation approval, a clean commit, and explicit pilot authorization, run:

```sh
npm run eval:recall -- --pilot --seed pilot-isolated-v3
```

Read the printed directory's `report.md`, `manifest.json`, `results.json`, and `completion.json` before requesting a batch.
Pilot eligibility requires both complete stages, faithful restoration, complete ownership and host timing, successful cleanup, and complete artifact writes.
Optional provider omissions remain explicit but do not invalidate otherwise complete recall evidence.
Wrong answers do not prevent eligibility.
Contamination, incomplete traces, missing stages, safety stops, source drift, and infrastructure failures prevent eligibility.

Schema version `3` identifies workload `incident-isolated-probes-v3` and design `stage-checkpoint-probe-forks-v1`.
The experiment fingerprint includes these identities and restoration methods.
Schema versions 1 and 2 remain historical observations and cannot authorize a batch.
The source revision, Node.js version, SDK version, model metadata, transport, and configuration must match the new pilot.
`completion.json` supplies final evidence after cleanup and artifact completion.
A stale summary without that file cannot authorize a batch.

A batch requires its own user authorization after pilot review.
The default batch contains three new groups per stage, twelve sources, and seventy-two forks.
Only after that separate authorization, run:

```sh
npm run eval:recall -- --batch --pilot-manifest .pi/evals/full-budget-recall/<pilot-run-id>/manifest.json
```

Batch seed roots default to `batch-v1-1`, `batch-v1-2`, and `batch-v1-3`.
Each root produces distinct `-stage-A` and `-stage-B` seeds.
The first A arm alternates baseline, paging, baseline.
The first B arm alternates paging, baseline, paging.
`--pairs` sets repetitions per stage, not the combined group count.
The pilot never enters the batch aggregate.
Invalid or incomplete groups remain in the report without replacement.

## Shared limits and exit codes

Each arm shares its limits across source preparation and all six forks.
The defaults are 64 dispatched user prompts, 12 HTTP attempts per prompt, and 256 HTTP attempts per arm.
Each stage group has a separate 120-minute wall-time limit.
Retries, recovery follow-ups, and native compaction calls consume the shared HTTP allowance.
Restoration does not reset an allowance or erase a safety stop.
These flags accept positive integers:

- `--max-user-prompts`
- `--max-requests-per-prompt`
- `--max-requests-per-arm`
- `--max-pair-minutes`

A safety stop aborts and disposes active source and fork sessions.
The harness retains available evidence after provider, restoration, source, artifact, and cleanup failures.
Unknown flags, conflicting modes, malformed numbers, and model or budget overrides are errors.

| Exit code | Meaning |
| --- | --- |
| `0` | Dry run or structurally complete results, including wrong answers |
| `2` | Argument, authentication, provider, restoration, source, trace, artifact, or cleanup error |
| `3` | Inconclusive stage or safety limit |

## Private artifacts and metric interpretation

Run, stage-group, preparation, and probe directories have mode `0700`.
Artifact files have mode `0600`.
Artifacts can contain exact workload facts and model answers.
Do not publish them without review.
Keep them outside the package and Git history.

Each run contains `manifest.json`, `results.json`, `report.md`, and final `run-timing.json`.
Only a successfully finalized run contains `completion.json`.
Writable failures retain error codes in results or `failure.json`.
Each stage group contains shared prompts and their hash, progress, scored probes, preparation snapshots, and probe snapshots.
Snapshots retain safe transcripts, request traces, events, recovery results, usage records, and phase records.
Credentials, raw provider bodies, private checkpoints, and encrypted signatures are not exported.

Metrics retain ownership for run, stage, seed, arm, checkpoint, fork, prompt, request, and HTTP attempt.
A logical request can contain several HTTP attempts because of retries.
Tokens, cache counts, catalog costs, and durations appear separately for preparation, each probe, arms, stage groups, stages, and the run.
Arm usage counts preparation once, then only new requests from its forks.
Inherited entries and replay create no provider usage.
Inherited SDK session statistics remain a separate cross-check, not an additional charge.

Total input includes cached input, while reasoning is a subset of output.
Neither subset is added to its total again.
Cache fractions use aggregate cache reads divided by aggregate input, not an average of request fractions.
Omitted fields remain `null` with reasons and measurement coverage.
An explicit valid zero remains zero.
Incomplete totals remain unknown and retain measured subtotals with observed and missing counts.

The pinned SDK catalog supplies ordinary input, output, cache-read, and cache-write cost estimates.
Reports retain pricing units, tiers, metadata fingerprints, charge applicability, and missing components.
A catalog estimate is not a Codex invoice or subscription charge.
No billing integration exists, so attributable billed cost remains unknown.
Partial cost subtotals cannot support cost-savings claims.

Response timing extends from dispatch through consumed-stream completion, failure, or abort, not merely response headers.
The report separates headers, first model delta, first text, attempt duration, and logical request duration with retries and backoff.
Task timing includes whole prompt or probe work, with setup, restoration, capture, scoring, artifact, tool, compaction, and cleanup phases.
Nested provider, tool, and compaction intervals explain task time and are not added to it again.
Run and stage-group wall times differ from per-arm active time.

Reports preserve individual values, duration distributions, coverage, statuses, and paired differences as paging minus baseline.
Incomplete operands prevent complete paired comparisons.
Conversation and compaction timings remain separate, with compaction usage included once in scope totals.
The report keeps A and B, seeds, known facts, unknown controls, categories, and revisions separate.
Sibling forks share preparation and are not independent preparation samples.
Three groups per stage provide preliminary evidence, not a general recall, cost, cache, or speed claim.
