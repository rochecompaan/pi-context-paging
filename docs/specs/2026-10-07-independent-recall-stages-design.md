# Independent recall stages

Date: 2026-10-07

Status: The user approved option 2, separate conversations for stages A and B.
This amendment replaces the shared-conversation rules in `2026-10-04-full-budget-recall-eval-design.md`.
All other model, transport, evidence, source-integrity, scoring, and safety rules remain unchanged.

## Reason for the change

A stage A history search can return stage B facts from the same transcript.
Those results refresh the facts before the stage B probes.
Different target values alone do not prevent this exposure.

## Conversation structure

A matched pair contains one baseline session and one paging session.
Each pair runs exactly one recall stage.
A complete pilot contains one A pair and one B pair, with four fresh Pi sessions in total.
The batch runs three new pairs per stage by default, with twelve fresh sessions in total.
The pilot never contributes to the batch aggregate.

Each pair starts with its own seeded facts and decision revisions.
Both arms receive identical prompts within that pair.
The A and B pairs use distinct deterministic seeds and fresh sessions.
They share no transcript, answer, history index, session manager, or compaction summary.
The first arm alternates across repetitions of each stage.

Stage A sends work until paging excludes the target sources and at least four known answers are absent from readable request text.
The baseline must not complete native compaction before or during the six A probes.
If compaction occurs too early, A is inconclusive. Its conversation does not become a B conversation.

Stage B starts from fresh sessions and sends no A probes.
It sends work until the baseline completes native compaction and excludes the B sources.
The six B probes then test facts from that conversation's beginning.
A summary that retains an exact answer remains valid baseline evidence.

Each complete pair contains at least 24 shared user prompts and exactly six probes for its selected stage.
Each stage contains five known probes and one unknown probe.
Work continues before the probes when the prompt count is too small.
The controller never forces compaction or lowers a context budget.

## Configuration and cost

The exact model remains `openai-codex/gpt-6-luna` with `xhigh` thinking and SSE transport.
The pinned SDK remains 0.87.1. Native model metadata and compaction defaults remain unchanged.
Paging remains at 128,000 tokens, with an 80,000-token trim target.
Production paging code remains unchanged.

The existing prompt, request, and time limits apply separately to each stage pair.
Two pairs can cost more than the old single-pair pilot.
No batch starts automatically after the new pilot.

## Artifacts and eligibility

The manifest records the stage beside each seed and first-arm order.
Schema version 2 and `incident-independent-v2` identify this experiment.
The experiment fingerprint includes the independent-conversation design.
Old shared-conversation pilots cannot authorize a new batch.

A pilot qualifies only when both independent stage pairs pass their structural gates.
Wrong model answers do not invalidate otherwise complete evidence.
Missing stages, mixed-stage probes, incomplete traces, safety stops, source changes, and infrastructure errors block eligibility.
The completion record covers both pairs and follows session cleanup and successful artifact writes.

Reports aggregate A and B separately.
An inconclusive A result does not erase a complete B observation, or the reverse.
Facts from the unused stage returned in A are diagnostic only because B uses a fresh conversation and a different seed.
Reports retain each pair's prompts, evidence, scores, usage, latency, and errors.

## Verification

Regression tests must catch probes from both stages in one conversation and reuse of only two sessions for the pilot.
They must also catch missing-stage pilots, legacy pilots, mixed-stage results, and incorrect stage denominators.
Existing cleanup, source-integrity, request-limit, scoring, and artifact-failure tests remain in use.
Real SDK sessions with a deterministic provider verify both stage boundaries without paid requests.

Run the full repository checks and a provider-free dry run before committing the harness change.
Then run one fresh live pilot from the clean committed checkout.
The live results remain observations until both stage gates and trace requirements pass.
