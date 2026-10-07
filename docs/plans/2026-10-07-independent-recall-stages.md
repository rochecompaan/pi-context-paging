# Independent recall stages implementation plan

The user approved separate matched conversations for stages A and B.
Work uses the existing `.worktrees/context-paging-recall-eval` checkout on `eval/context-paging-recall`.
The design is `docs/specs/2026-10-07-independent-recall-stages-design.md`.

## Steps

1. Add regression tests for one stage per conversation and four fresh pilot sessions.
   Run the tests against the old controller and confirm failures for twelve probes and two sessions.
2. Make the pair controller select one stage, preserve its gates, and close both sessions before returning.
   Keep at least 24 shared prompts and six probes in each complete stage pair.
3. Schedule one fresh pair per stage in the pilot and three pairs per stage in the default batch.
   Record stage identities, use distinct seeds, and alternate first-arm order across each stage's repetitions.
4. Require both independent pairs for pilot eligibility and reject old shared-conversation artifacts.
   Keep private artifacts and completion records separate from model-visible resources.
5. Aggregate stage results independently and update the operating guide.
   Update controller, CLI, report, artifact, limit, and real-SDK tests for the new conversation structure.
6. Run `npm run check`, the provider-free dry run, and `git diff --check`.
   Review the diff for unchanged production code, model configuration, paging budgets, and compaction defaults.
7. Commit only the harness, tests, and documentation changes.
   Run one fresh live pilot from the clean checkout and retain its private artifacts.
   Do not start the batch without further user approval.

## Testing value

The new tests cover reusable stage control, isolation, result validation, and failure handling.
Documentation and static configuration receive direct review and command verification instead of new text-assertion tests.
