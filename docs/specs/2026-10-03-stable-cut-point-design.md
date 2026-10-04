# Part 1: stable cut point

## Status and approval boundary

The user approved the written spec at `9fdb22f` as recommended through the roche-pi handoff.
This revision records those decisions as requirements. It is not permission to implement.

Approved decisions:

- Keep an in-memory frontier that moves forward only.
- Reuse a byte-identical paging notice between frontier advances.
- If the calibrated retained-request estimate exceeds the effective budget, trigger an advance.
- Advance in FIFO order toward the effective target.
- Add `contextPaging.trimToTokens`, with a default of `max(1, floor(tokenBudget * 5 / 8))` after budget resolution.
- Scale the target by the same ratio as the effective budget.
- After a partly cut turn completes, preserve its request and surviving exchange suffix.
- Keep the existing protected-overflow and recovery notices as explicit exceptions to prefix stability.
- Reset for branch navigation or fork, session switch, and new session.
- Reset for compaction and every actual model switch, in both window-size directions.
- Lose the in-memory frontier on Pi restart and rebuild it for the resumed request.
- Use stateless budget-only selection without a cut-state commit if provenance cannot establish a new frontier.
- Keep sticky budget-only cuts for an explicit `trimToTokens >= tokenBudget`.
- Warn once per resolved setting pair for each extension instance in that explicit-value case.
- Accept positive safe integers only, with settings fallback and strict direct-input validation.

Section 9 records the approved reset mechanism, settings resolution, and validation requirements.
Writing the implementation plan is authorized. Source work still requires the gates in Section 10.

## 1. Intent and scope

Paging currently recalculates FIFO eviction for every provider request. After the request exceeds the budget, its retained prefix changes frequently.
Calibration changes can also restore previously evicted history. Both effects reduce prefix-cache reuse.
If the retained request is not an append-only extension, the Claude bridge also restarts its query.

Part 1 gives ordinary requests room to grow without repeated cuts. It preserves the same retained prefix until another budget crossing.
It does not promise that every provider call becomes append-only.

Part 2, model-guided eviction, requires a separate spec and plan. Part 1 makes no model call to choose history.
It makes no persistent session writes. Saved history and exact recovery remain unchanged.

Other exclusions:

- No Claude bridge changes.
- No new provider-specific behavior or runtime dependencies.
- No new settings beyond `trimToTokens`.
- No unrelated refactoring or changes to the four history tools.
- No `roche-pi` source changes, dependency pins, release tags, or publication actions.

## 2. Workspace and source evidence

Part 1 worktree:
`/home/roche/projects/pi/extensions/pi-context-paging/.worktrees/stable-cut-point`.

Part 1 branch: `docs/stable-cut-point`.
The initial base is `d9a9cdf1ea75c80ae695fa4a4191c73d4f3a8bac` from `fix/v0.1.1-paging-updates`.
That snapshot contains documentation and v0.1.0 source. It does not contain the v0.1.1 production port.

The other pi-context-paging session owns `fix/v0.1.1-paging-updates` and its worktree.
Part 1 must not change either one.
If the release history changes, rebase this docs branch after the verified integration handoff.

Immutable upstream evidence:
`6cb00cb65c12608fe0236db0b0a60a7d808099d3` in `/home/roche/projects/pi/roche-pi`.
Its `extensions/context-paging/context-policy.ts` and `context-usage.ts` describe the reviewed policy and accounting tracker.
These files are evidence, not completed standalone implementation. Accounting entered upstream in `06f0987`.

No Part 1 source changes can start before v0.1.1 merges.
Before implementation, reconcile this spec and its later plan with the verified standalone port.

## 3. Settings and token limits

The existing `contextPaging.tokenBudget` default remains `128_000`.
Resolve `contextPaging.tokenBudget` before the new `contextPaging.trimToTokens` setting.
The implicit target default is `max(1, floor(tokenBudget * 5 / 8))` of that resolved budget.
It is `80_000` at the default budget and `40_000` at a `64_000` custom budget.
This replaces the earlier fixed `80_000` default for custom budgets.

The setting names the request size that paging tries to reach after a budget crossing.
This document calls that size the target.
The target uses the existing trusted-project-over-global setting precedence.
Section 9 defines invalid-value handling and the explicit at-or-above-budget case.

For an absent model window, the effective budget is `tokenBudget`.
For a present model window, the effective budget is the smaller of `tokenBudget` and `modelWindow`.
The target formula applies in both cases:

```text
effectiveBudget = min(tokenBudget, modelWindow)
effectiveTarget = max(1, floor(trimToTokens * effectiveBudget / tokenBudget))
```

Examples with the defaults:

| Model window | Effective budget | Effective target |
| --- | ---: | ---: |
| Absent or at least 128,000 | 128,000 | 80,000 |
| 64,000 | 64,000 | 40,000 |

The estimate includes resident input, retained messages, and the outgoing notice.
The target is a cut destination, not a new hard limit for protected content.
The existing budget and model-window safety rules remain in force.

## 4. Selection and accounting

Selection operates on the original incoming request before it applies the remembered cut.
It validates structure and performs the reviewed interrupted-exchange normalization first.
Previously evicted history must not hide an orphan, duplicate, mismatched, or normally incomplete tool exchange.

The accounting tracker prepares the provider-backed estimate from the original incoming snapshot and its existing persistent-session provenance.
The policy preserves that snapshot's calibration adjustment while it removes normalized or evicted messages.
It must not calibrate a smaller retained snapshot against usage that describes the original input.
Resident system input and active tool schemas retain their existing accounting.

A successful selection follows these stages:

1. Resolve the remembered frontier in raw history and the validated incoming groups.
2. Apply that frontier only when both resolutions succeed.
3. Include the frozen paging notice in the retained-request estimate.
4. If that estimate exceeds the effective budget, advance FIFO toward the effective target.
5. Apply existing protection, overflow, recovery, and error rules.
6. Return the selected messages and commit any successful frontier advance.
7. Record the final outgoing selection with the existing accounting tracker.

The trigger compares the request after the remembered cut, not the full incoming history.
Otherwise, old evicted history causes a new cut on every call.
An estimate equal to the budget does not trigger an advance.
An estimate greater than the target but no greater than the budget also does not trigger an advance.

During an advance, preserve the existing FIFO order:

- Prefix units.
- Completed turns.
- Evictable exchanges in the active turn.

Tool calls and their actual results remain one exchange.
The active request, outgoing-only instructions, and the existing latest-result protection keep their reviewed treatment.
When protected content prevents the target, stop at the furthest legal frontier.
A request that fits the budget remains valid without reaching the target.

Lower estimates on later calls never restore evicted units within the same frontier lifetime.
A failed selection must not commit a candidate advance or alter saved history.

## 5. Stable identities and partial turns

Array positions and message-object identities must not key the remembered frontier.
Use raw-history identities from the existing history lookup.
An exchange key includes its raw model-turn `historyId` and tool-call identity where present.
An assistant exchange without a tool call uses its raw model-turn identity.
A partial turn uses its last excluded model exchange as its required anchor.
It also records the owning raw user `historyId` when that ID exists.

Custom messages can start requests, but the existing raw-history projection gives them no history IDs.
A custom-started partial turn therefore needs no user ID.
The policy finds its request in the unique validated group that contains the anchored model exchange.
It retains that entire request envelope and the surviving exchange suffix.
This design does not add custom items to `HistoryItem` or change the recovery tools.

The frontier describes the last excluded keyed unit and, for an active turn, the last excluded exchange.
The exchange position is a stable key, not a stored array index.
Re-created message objects must resolve to the same cut.

When a new request completes a partly cut turn, that turn keeps its request and surviving exchange suffix:

```text
Before completion: [notice] [T.request] [T.surviving exchanges]
After completion:  [notice] [T.request] [T.surviving exchanges] [next request]
```

Completion alone must not restore older exchanges or remove the remainder.
This rule also applies to a custom-started request without a user ID.
At a later budget-triggered advance, that remainder becomes one atomic completed-turn FIFO unit.
It is not eligible for new exchange-by-exchange cuts after completion.

The original turn's model anchor can identify that completed unit even when its retained remainder contains only the custom request.
Such a remainder is not a keyless unit.
A completed or prefix unit is keyless only when its original validated unit has no unique raw-history anchor.
If FIFO removal ends at a keyless unit, move the proposed boundary back to the last evicted keyed unit.
That unit becomes the frontier. All units through that frontier remain excluded, and all keyless units after it stay in the request.
The last evicted keyed unit can come from the remembered frontier or the current advance.
This backward snap changes an uncommitted candidate. It never restores units excluded by a committed frontier.

The policy includes the frozen notice in the snapped request's estimate.
It uses the same original-snapshot calibration adjustment as the budget trigger.
If the snapped estimate fits the effective budget, retain this keyed cut even when it does not reach the target.
If no keyed unit was evicted, use Section 9 R's budget-only fallback with reason `keyless-no-key`.
If the snapped estimate exceeds the effective budget, use that fallback with reason `keyless-snap-over-budget`.
Both fallback cases return no snapshot and have separate replay counts.

Do not retain a keyless exclusion merely by labeling it with an earlier key. Move the boundary itself.
Do not snap forward or evict extra units merely to find an anchor.
This restriction also applies when the next keyed unit is unprotected but FIFO already reached the target.
An over-budget backward snap still uses `keyless-snap-over-budget` in that case.
If normal FIFO removal already ends at a later keyed unit, that unit can represent the cut, including earlier keyless units.
The next budget trigger removes retained keyless units first, before later keyed units, in the existing FIFO order.
If the proposed boundary snaps back to the same remembered frontier, its over-budget estimate requires fallback, not a no-op result.

At most one retained partial turn is necessary.
To reach exchanges in a later active turn, FIFO must first remove the earlier completed remainder.
This rule avoids arbitrary partial cuts in multiple completed turns.

## 6. Frozen notice and cache guarantees

The first normal eviction creates the paging notice.
A frontier advance updates its eviction references and freezes the resulting notice again.
Without an advance or reset, normal paging reuses the entire notice unchanged, including its content and timestamp.

The evicted `historyId` and tool-recovery reference change only with a frontier advance or reset.
A retained-request estimate decrease must not remove the notice or return the full incoming history.

For append-only incoming history, stable resident input, and normal paging, the next outgoing request preserves the previous request as its prefix.
The active-to-completed transition in Section 5 is part of this guarantee.
This guarantee does not cover other extensions that rewrite outgoing messages.

Approved exceptions preserve the existing protected-overflow and recovery behavior:

- Protected-overflow substitutes its existing leading notice.
- Recovery substitutes its existing leading notice and recoverable tool-result payloads.
- Entry into or exit from either mode can change the request prefix without an additional frontier advance.
- When normal paging resumes, the same frozen normal paging notice returns unchanged.

Putting a mode notice immediately after the frozen notice does not solve the prefix change.
Everything after that extra notice still shifts.
Part 1 accepts these exceptional changes rather than change the model-facing guidance.

Lifecycle resets, missing history identities, and non-append input changes also fall outside the ordinary guarantee.
Section 9 defines the approved reset mechanism and unresolved-provenance fallback.

### Approved reset cases

A reset discards the frontier, partial-turn state, and frozen notice.
The next request starts from the current projected history and can retain previously excluded content again.
Resetting on a model switch also permits more history after a switch back to a larger window.
The provider cache changes with the model switch anyway.

- Branch navigation or fork, session switch, and new session change the active history.
- Compaction changes the projected history.
- Every actual model switch resets state, in both window-size directions.
- On Pi restart, the in-memory state is lost. The first request reconstructs its cut without restoring persisted frontier state.

The SDK provides `session_start`, `session_tree`, `session_compact`, and `model_select` for these cases.
Section 9 specifies successful-event handling, projection checks, and unresolved-provenance behavior.

## 7. Module responsibilities

A small internal cut-state module owns the frontier, partial-turn identity, and frozen paging notice.
It provides a narrow seam for reading state, resetting state, and committing a successful advance.
It does not load settings, read sessions, estimate provider usage, or call a model.

The selection policy owns validation, grouping, token accounting, FIFO selection, and protection rules.
It returns the selected messages and a candidate state update without exposing grouping details to the extension entry module.
The entry module owns settings, lifecycle hooks, and successful state commits.

Keep cut state separate from `ContextUsageTracker`.
A missing provider-usage anchor does not by itself justify restoring evicted history.
Do not clear the frontier whenever the tracker falls back to its lifecycle estimate.

The new state behavior needs focused tests through its selection seam.
Do not expand the already-large policy file with unrelated responsibilities.
Retain the reviewed linear selection work and weak-cache behavior.

## 8. Verification and acceptance

### Automated behavior tests

Apply TDD during implementation. The relevant regression cases must fail before the production change.
No source tests are added during this documentation stage.

Call-sequence tests must prove these behaviors:

- Below-budget appends retain the same frontier and byte-identical normal paging notice.
- A request exactly at the budget does not advance.
- A request over the budget advances toward the target, including the notice's token cost.
- No call between the target and budget advances merely to reach the target.
- Reduced calibration never restores excluded messages.
- The target scales with a smaller model window.
- A partly cut turn keeps its request and suffix after completion, including custom-started turns without user IDs.
- A later trigger evicts that completed remainder atomically, including a custom-only retained remainder with an original model anchor.
- A keyless endpoint snaps back to the last evicted keyed unit and retains the following keyless units without a fallback reason.
- The snapped cut and its frozen notice remain byte-identical on the next call below the budget.
- A zero-key prefix uses budget-only selection without a snapshot and reports `keyless-no-key`.
- An over-budget backward snap uses budget-only selection without a snapshot and reports `keyless-snap-over-budget`.
- A later trigger removes retained keyless units first. A snap to the same over-budget frontier requires fallback, not a no-op.
- A raw key absent from the incoming or normalized groups uses the same nonfatal fallback.
- Stable history keys work across cloned message objects and repeated tool names.
- Notice eviction references change only on an advance or reset.
- Protected content can prevent the target without causing an error below the budget.
- Existing protected-overflow, recovery, and genuine budget errors retain their behavior.
- Interrupted exchanges remain omitted from provider replay but recoverable in raw history.
- Invalid original exchanges still fail, including exchanges outside the retained region.
- A failed selection does not commit an advance.

Reset tests must cover successful branch navigation, fork, session switch, new session, compaction, and model switches in both directions.
They must also cover missing identities, restart without persisted state, canceled operations, and duplicate invalidation notifications.
The unresolved-provenance test must prove the exact current-call destination and absence of a cut-state commit.

Test lower project budgets with no target override and inherited explicit global targets.
Also cover sticky budget-only cuts, no backward movement, and warning deduplication.
Existing settings tests must cover target precedence, project trust, and the adaptive default.
Section 9 supplies the invalid-value cases and direct-input error requirements.
Run the existing typecheck, complete tests, and packed-artifact load check against the actual standalone port.
No new tests merely assert documentation text or static package-check lists.

### Session replay

The peer supplied evidence from session `01a0fc97` after `2026-10-02T20:11Z`:

- 57 of 118 Claude bridge calls were rebuilds.
- Rebuilds produced 97% of cache writes.
- Append-only requests grew by about 2,000 tokens per call.

These are supplied observations, not results of a Part 1 replay.
The original session remains read-only.

The private replay scripts are in:
`/home/roche/projects/pi/roche-pi/.superpowers/sdd/2026-10-03-stable-cut-point/`.
Adapt `replay.ts` or `replay2.ts` there to the verified standalone policy and accounting tracker.
Both copies currently hard-code session `01a0fb1f`, so the replay must select `01a0fc97` explicitly.
The directory is git-excluded. Do not copy these scripts or private session contents into the public repository.
Use the same session range and stated resident-input assumptions for the baseline and candidate.
Report reconstruction limits rather than present estimates as real provider billing.

The report must include:

- Total replayed calls and the exact session range.
- Frontier changes before and after Part 1.
- Rebuild-equivalent prefix changes before and after Part 1.
- Calls that enter or leave overflow/recovery, including recovery-payload substitutions.
- Protected-target-unreachable calls and their repeated cuts.
- Reset and unresolved-identity calls, with the reason.
- Fallback calls by cause: raw history unavailable, unresolved cut key, or frontier absent from incoming groups.
- Separate counts for `keyless-no-key` and `keyless-snap-over-budget`, not one combined keyless-boundary count.

Both replay adapters include custom messages from the SDK's canonical session projection.
The raw-history projection alone is not a complete incoming request because it omits custom messages.
The baseline script and baseline mode must exist before the pre-edit replay runs.
Candidate mode loads the cut-state module only after that module exists.

If the previous outgoing request is not a prefix of the next request, the replay counts a rebuild-equivalent change.
Use the provider-visible message representation, not object identity or total token counts, for that comparison.
If multiple causes explain one prefix change, count that request once.
Show overlapping causes separately.

The replay must show no backward frontier movement within a lifetime.
Ordinary append-only calls that stay below the budget must show no paging-caused prefix change.
No fixed reduction percentage is a release requirement before the reconstruction assumptions are reviewed.

## 9. Approved detailed requirements

The user approved R, C, and V as recommended. Rejected alternatives are not implementation options.

### R: reset mechanism and unresolved provenance

Use successful `session_start`, `session_tree`, `session_compact`, and `model_select` events for the approved reset cases.
The `session_start` reasons `new`, `resume`, and `fork` cover successful session replacements in the pinned SDK.

Use the accounting port's invalidating-entry detection for new `context_edit` and compaction entries.
The pinned SDK has no named `context_edit` lifecycle event.
Also reset a frontier or partial-turn key that no longer resolves uniquely in projected raw history.

Do not reset on canceled branch, fork, session-switch, or automatic-compaction attempts.
Do not reset merely because a partial turn completes or provider accounting falls back.
Lifecycle notification and branch-entry detection must not reset a newly established frontier twice for the same invalidation.
Replay counts must identify each reset reason.

A missing old key clears the previous state.
If current raw history supports a new unambiguous frontier, normal selection can commit that new state.
If provenance for the new frontier is unavailable or ambiguous, use this current-call budget-only fallback:

1. Clear cut state and start with no remembered frontier.
2. Validate and account for the complete incoming request using the existing policy.
3. If the estimate fits the effective budget, return the normalized request without a paging notice.
4. If it exceeds the budget, use today's stateless FIFO policy toward the effective budget, not the target.
5. Preserve existing protection, overflow, recovery, and error behavior.
6. Do not commit a frontier, partial-turn state, or frozen notice for this call.
7. Still record the final outgoing selection in the accounting tracker.

This fallback is stateless for cut state and uses today's budget-only destination.
The fallback shares the selection policy without duplicating validation or FIFO logic.
These calls cannot claim cross-call prefix stability.
A missing cut identity must not itself create a new provider-abort condition.

Raw-key validity is not sufficient to apply a remembered frontier.
The key must also identify the expected unit or exchange in the current validated groups.
If an earlier context handler filters the anchored exchange, or normalization removes it, use the current-call budget-only fallback.
Do not guess its group position or reuse the previous frozen notice for that call.
The missing group anchor itself must never throw. Genuine structure and safety errors keep their existing treatment.
Section 5 requires the same fallback when a keyless endpoint has no evicted key or its backward snap exceeds the budget.
Report `keyless-no-key` and `keyless-snap-over-budget` separately. A budget-safe backward snap uses normal sticky selection without a fallback reason.
An over-budget snap cannot qualify as a successful no-op merely because its candidate frontier equals the remembered frontier.
Forward snapping is not part of this design. If candidate replay records over-budget snaps, review that option separately before any behavior change.

### C: default resolution and target at or above budget

For an unset target:

- Resolve `tokenBudget` first.
- If neither trusted-project nor global settings supplies a valid target, use `max(1, floor(tokenBudget * 5 / 8))`.
- This default is `80_000` for a `128_000` budget and `40_000` for a `64_000` budget.
- Preserve explicit target precedence, including an inherited global value.
- Apply the approved model-window scaling formula after settings resolution.

This adaptive default supersedes the fixed `80_000` default for custom budgets.

For an explicit `trimToTokens >= tokenBudget`:

- Keep the sticky frontier and frozen normal paging notice.
- Trigger only above the effective budget.
- Use the effective budget as the cut destination instead of the computed target.
- Never enlarge the budget or bypass the model-window limit.
- Warn once per resolved `(tokenBudget, trimToTokens)` pair during an extension instance's lifetime.
- Explain that the target leaves no headroom and that a smaller target restores room between cuts.

The warning applies to explicit targets from either the trusted project or global settings.
Repeated context calls and model switches with the same resolved pair do not repeat it.
A restart can emit the warning again because warning state is also in memory.
Sticky budget-only cuts prevent backward movement but can still advance frequently because there is no headroom.
They use the same selection policy, not a separate legacy stateless path.
For the smallest budgets, the adaptive default can equal the budget. Use the same budget-only destination without an explicit-value warning.

### V: invalid-value validation

Accept only a positive safe integer for `trimToTokens`.
Reject strings, booleans, null, zero, negative values, fractions, non-finite numbers, and unsafe integers as setting values.
Do not coerce them or silently clamp them.

For settings resolution, ignore invalid values.
Use the next valid source, then the adaptive default from Section 9 C.
An invalid trusted-project value falls through to the global value.
An untrusted project never overrides the global value.
This rule matches the existing `tokenBudget` resolution behavior.

For invalid direct policy inputs, throw an explicit selection error before target calculation or eviction.
Do not apply the settings fallback to invalid direct inputs.
Section 9 C governs valid integers at or above the budget. They are not invalid values.

## 10. Review and implementation gates

The original R, C, and V approval remains recorded at `d74c106`.
The user approved the custom-turn anchor, backward-snap, and incoming-group fallback amendments on 2026-10-03.
The backward-snap amendment includes separate zero-key and over-budget fallback reasons.
The user approved the Part 1 plan and chose Native execution on 2026-10-03.
Source work still requires the verified release handoff and plan reconciliation.

Completed: the roche-pi peer reviewed the original approval record and the revised amendments. The separate Part 1 implementation plan is written.

Remaining gates:

1. Before source work, obtain the v0.1.1 merge and verified integration handoff from its owner.
2. Reconcile the approved plan with that standalone source before execution.
3. If reconciliation changes behavior or task scope, report the change before any source edit.

Native implementation is authorized only after these gates. Merge, publication, and Part 2 remain outside this approval.
