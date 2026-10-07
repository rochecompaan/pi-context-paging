# Full-budget recall evaluation

This development harness compares fresh baseline and paging sessions with identical prompts in each matched pair.
Stages A and B use separate pairs and do not share conversation history.
The baseline uses native compaction. The paging session uses the real extension and its four history tools.
Production paging code does not change.

## Fixed configuration

The harness uses `openai-codex/gpt-6-luna`, `xhigh` thinking, and the repository-pinned Pi SDK 0.87.1.
Both sessions use the same native model metadata and compaction configuration.
The paging budget is 128,000 tokens. The trim target is 80,000 tokens.
The harness never replaces an unavailable model or lowers either budget.

Server-Sent Events (SSE) is the required transport for each model request.
The harness observes the native Codex adapter. It does not construct a replacement request or use WebSocket transport.
Sessions have no file or shell tools, unrelated extensions, skills, or context files.
Only the paging session receives recovery tools.

## Preparation

Use Node.js 22.19 or later and install the repository dependencies:

```sh
npm ci --ignore-scripts
npm run check
npm run eval:recall -- --dry-run
```

The default invocation is also a dry run. Neither command reads credentials, creates model sessions, or sends model requests.
Authenticate through Pi with your existing Codex account before a live run.
The harness uses Pi's model runtime and the active agent directory. It does not copy credentials into artifacts.
An unavailable model, missing credentials, or unsupported thinking level stops the run without a substitute.

Commit all harness changes before a live run.
The entry-point checkout must contain tracked live sources and have no staged edits, unstaged edits, or non-ignored untracked files.
The manifest records the full Git revision and the `clean-checkout-v1` source policy.
The harness makes sure that the checkout still matches before live imports, every HTTP attempt, and finalization.
Retries receive the same source check. Keep source files unchanged throughout the run.

The default output directory is `.pi/evals/full-budget-recall`, which Git ignores.
A custom output directory must be outside the source checkout or in an ignored path.
A source change stops further requests and removes verified source-policy evidence from writable artifacts.
After a harness fix, rerun automated verification, commit the fix, and run a new pilot.

## Pilot and batch

A matched pair contains one baseline session and one paging session.
Start with one pilot containing one fresh pair per stage, or four sessions:

```sh
npm run eval:recall -- --pilot --seed pilot-independent-v2
```

The CLI prints its artifact directory. Read that directory's `report.md`, `manifest.json`, and `results.json` before a batch.
The pilot must finish both independent stage pairs, each with at least 24 shared prompts and six probes.
Both arms receive the facts and decision revisions at the start of their pair.
Stage A requires paging source exclusion and four qualified known probes before any successful baseline compaction.
Stage B starts fresh and requires successful native baseline compaction before its first probe.
The B conversations receive no A probes, answers, recovery results, or summaries.
Distinct seeds and fresh session managers keep the stages separate.

A qualified probe has an exact answer absent from the readable first request.
The original source entries must also be outside that request.
A summary that retains an exact answer is resident evidence, not a qualified recovery success.
Encrypted reasoning is opaque, which means that the host cannot read it.
Plaintext absence does not prove that the model forgot a fact.

A structurally complete pilot can qualify even when model answers are wrong.
Contamination, incomplete traces, missing stages, safety stops, source changes, or infrastructure errors block the batch.
The source revision, Node.js version, SDK version, model metadata, transport, and configuration must match the pilot.
`completion.json` records successful finalization after session cleanup and artifact writes.
Without this file, stale complete summaries cannot authorize a batch after a write failure.
Schema version 2 identifies the independent-stage experiment. Old shared-conversation pilots cannot authorize this batch.

Use the eligible pilot manifest to run three new pairs per stage, or twelve sessions:

```sh
npm run eval:recall -- --batch --pilot-manifest .pi/evals/full-budget-recall/<pilot-run-id>/manifest.json
```

Batch seed roots default to `batch-v1-1`, `batch-v1-2`, and `batch-v1-3`.
Each root produces distinct `-stage-A` and `-stage-B` seeds.
The first arm for A alternates baseline, paging, baseline. The first arm for B alternates paging, baseline, paging.
`--pairs` sets the number of repetitions per stage, not the combined pair count.
The pilot never contributes to the batch aggregate.
For later repetitions, use `--seed` and `--pairs` without changing the fixed model or budgets.
Invalid or incomplete pairs remain in the report. The harness does not silently replace them.

## Limits and exit codes

The default safety limits are 64 user prompts, 12 requests per prompt, 256 requests per session, and 120 minutes per stage pair.
The A and B pairs have separate limits. The pilot can therefore run longer and cost more than the old single-conversation pilot.
Request limits count actual HTTP attempts, including retries, recovery follow-ups, and native compaction calls.
These flags accept positive integers:

- `--max-user-prompts`
- `--max-requests-per-prompt`
- `--max-requests-per-arm`
- `--max-pair-minutes`

The harness aborts both sessions when a limit stops a pair.
It retains available evidence after a provider, source, or artifact error.
Unknown flags, conflicting modes, malformed numbers, and model or budget overrides are errors.

| Exit code | Meaning |
| --- | --- |
| `0` | Dry run or structurally complete results, including wrong model answers |
| `2` | Argument, authentication, provider, source, trace, or artifact error |
| `3` | Inconclusive stages or a safety limit |

## Artifacts and interpretation

Run and pair directories have mode `0700`. Artifact files have mode `0600`.
Artifacts are private and can contain exact workload facts and model answers.
Do not publish them without review. Keep them outside the package and Git history.

Each run contains the manifest, JSON results, and Markdown report.
Failed runs retain error codes in results or a separate failure record when writable.
Each pair contains the shared prompts and their hash, progress records, scored probes, and per-session evidence.
Session evidence includes transcripts, safe request traces, recovery results, events, model metadata, and a usage ledger.
The usage ledger joins raw measurement presence to normalized SDK usage by persisted entry ID.
Credentials, raw provider bodies, and encrypted signatures are not exported.
Partial artifacts remain useful even when no completion record exists.

Reports separate stage A and stage B, known facts and unknown controls, categories, revised decisions, and qualified-probe counts.
They retain individual pairs and paired score differences.
An inconclusive stage does not remove the other stage's valid independent observations.
Facts from the unused stage returned during A are diagnostic only. They do not refresh B's separate conversation.
Recovery attribution requires a matching successful history-tool result before a correct final answer.
The usage report counts each persisted entry once and shows compaction as a subtotal, not an extra charge.
Missing token measurements remain unknown rather than zero.
SDK session statistics are a separate cross-check.

Costs are catalog estimates from SDK usage, not Codex invoices.
Long sessions can consume substantial tokens even when the request limit is not reached.
Latency includes the session lifecycle. The report records actual HTTP attempt counts.
Three pairs per stage provide preliminary evidence, not a general claim that paging improves recall.
Do not call an incomplete or contaminated pair a winner.
