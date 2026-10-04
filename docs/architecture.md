# Architecture

## Package seam

Pi loads `src/index.ts` through the package manifest.
The extension factory is the only public code seam.
Settings and registered tools form the supported caller interface.

## Raw branch projection

`history.ts` reads only the active session branch.
It creates immutable user items and atomic model-turn items.
A model-turn item owns its contiguous matching tool results.
Projection rejects orphaned, duplicate, and misassigned results.
A normal incomplete older exchange is an error. The newest normal incomplete exchange remains absent until it is complete.
An assistant with `stopReason: "aborted"` or `"error"` remains recoverable with zero, partial, or complete actual results.
Projection retains the original assistant and result objects and marks the turn failed. It does not synthesize results.
Failed text-only responses also remain in raw history.

## History navigation

`navigator.ts` builds compact search records from projected items.
Search serializes large tool output only when a query needs it.
The navigator caches that corpus until visible history IDs change.
Browse uses stable history IDs and sequence numbers.
Load returns complete items atomically.

## Exact output paging

`output-pages.ts` serializes one assistant or tool-result output value.
It returns bounded character pages and an exact next offset.
It never replaces large values with a summary.

## Settings and limits

`settings.ts` resolves pure settings without filesystem access. `index.ts` reads global and trusted-project settings.
The budget defaults to `128_000`. The implicit target is `max(1, floor(tokenBudget * 5 / 8))` after budget resolution.
For the default budget, the target is `80_000`. A `64_000` budget has an implicit `40_000` target.
An explicit trusted-project target takes precedence over a global target. An inherited global target stays explicit with a lower project budget.

Both token settings accept positive safe integers. Invalid values fall through to the next trusted source, then the default.
Direct policy calls instead throw `INVALID_TOKEN_BUDGET` or `INVALID_TRIM_TARGET` for invalid values before eviction.
The existing positive-finite model-window validation remains separate.
Integral scaling and adaptive defaults use exact integer arithmetic near the safe-integer limit.

The effective budget is the smaller of the configured budget and model window, when the window exists.
The effective target is `max(1, floor(trimToTokens * effectiveBudget / tokenBudget))`.
For a target at or above the configured budget, the cut destination is the effective budget instead.
An explicit high target produces one warning per resolved budget/target pair per extension instance.
The frontier remains stable and forward-only, but this setting leaves no headroom between cuts.
Warning state survives model switches but not Pi restart. An implicit target equal to a tiny budget does not produce this warning.

## Context selection

`context-policy.ts` counts the system prompt and active tool definitions once as resident input.
Ordinary message estimates do not count outgoing system metadata a second time.
Before it applies any cut, the selector validates the original exchanges and omits interrupted assistants and their contiguous owned results.
Invalid exchanges outside the retained region still fail. Normalization keeps outgoing-only provenance aligned with retained messages.
The selector groups the remaining conversations into prefix units, completed turns, and active-turn exchanges.
The persistent active request, injected instructions, and latest valid unread tool-result exchange remain protected.
Interrupted exchanges do not receive unread-result protection.

The selector first resolves a remembered frontier in both raw history and current validated groups.
It applies that cut, then compares the calibrated retained estimate, including the frozen notice, with the effective budget.
Only an estimate above the budget triggers an advance. Equality and estimates between target and budget do not advance.
FIFO eviction removes prefix units, completed turns, then eligible active-turn exchanges toward the effective target.
Protected content can prevent the target. The protected floor is the estimate of content that cannot be evicted.
If this floor exceeds the target, one cut evicts every completed turn before any keyless-boundary adjustment.
The active request and unread trailing tool results remain protected.
Existing protected-overflow, recovery, and model-window safety rules still apply.
A failed selection commits no advance. The selector does not mutate canonical or raw history.

## Stable cut state

`context-cut.ts` stores a successful frontier and its frozen normal notice in memory.
It provides prepare, commit, and reset operations without settings, session I/O, or token accounting.
A frontier uses raw `historyId` keys and tool-call IDs where present, never array offsets or message-object identities.
`selection-history.ts` resolves these keys without changing recovery-tool lookup behavior.
Lower estimates never restore excluded units within a frontier lifetime.

A partial turn requires its last excluded model exchange as an anchor. Its user history ID is optional.
This permits custom-started turns whose request envelope has no raw user ID.
After completion, the request and surviving suffix stay intact. A later advance evicts that completed remainder atomically.
The original model anchor also identifies a custom-only remainder. It is not a keyless unit.

If FIFO ends at a genuinely keyless unit, the candidate boundary moves back to the last excluded keyed unit.
All keyless units after that boundary stay in the request. This snap never restores units beyond an already committed cut.
The snapped request includes the frozen notice and the same original-input calibration adjustment.
If it fits the budget, the keyed cut stays stable even above the target. A safe snap is not a fallback.
The next advance removes the retained keyless units first. The policy never evicts extra units solely to find a later key.

Without usable provenance, the current call uses stateless FIFO selection toward the budget, not the target.
It records the final outgoing request for accounting but commits no frontier or notice.
A fallback ends the previous frontier lifetime. Its cause is one of:

| Cause | Meaning |
| --- | --- |
| `raw-history-unavailable` | Raw history is unavailable for a new frontier. |
| `cut-key-unresolved` | A raw cut identity is missing or ambiguous. |
| `keyless-no-key` | FIFO ends at a keyless unit without an excluded keyed anchor. |
| `keyless-snap-over-budget` | The backward snap, including its notice, exceeds the effective budget. |
| `frontier-not-in-groups` | A raw anchor is absent from the current incoming or normalized groups. |

Missing anchors alone do not abort a provider call. Genuine structure and budget-safety errors retain their strict behavior.
A snap to the same remembered frontier still requires fallback if its request exceeds the budget.
These stateless calls cannot promise prefix stability.

## Provider-backed usage

`context-usage.ts` links a successful provider response to the exact selected request snapshot.
It matches that snapshot against the projected persistent session and separates outgoing-only instructions.
It subtracts the full persistent tail from Pi's status total, including system updates absent from outgoing messages.
Resident prompt and tool schemas contribute once. Weak caches reuse message fingerprints and estimates.
When no valid response anchor exists, selection uses the heuristic fallback.
Calibration uses the original incoming snapshot, before any remembered cut.
Omitted interrupted exchanges and evicted messages reduce the estimate without losing that snapshot's provider offset.
The final outgoing request is recorded only after successful selection, including stateless provenance-fallback calls.
Accounting fallback alone does not reset cut state. Part 1 leaves the existing usage tracker unchanged.

## Paging notices

A transient paging notice appears before retained canonical messages after eviction.
The notice reports the effective budget and gives stable recovery references.
Normal selection reuses its exact content and timestamp until a frontier advance or reset changes its references.
The notice contributes to both the budget trigger and the cut destination. It is not written into stored session history.

For append-only history and stable resident input, ordinary requests preserve the previous outgoing request as a prefix between advances.
This guarantee includes the completion of a partial turn. It excludes other extensions' message edits and non-append input changes.
Protected-overflow replaces the leading notice. Recovery also replaces recoverable tool-result payloads.
Entry into or exit from these modes can change the prefix without a frontier advance.
When normal paging resumes, its frozen notice returns unchanged. Part 1 does not make every provider call append-only.

## Lifecycle

`index.ts` resolves global and trusted-project settings at session start.
It refreshes projected history after turns and session-tree changes.
It reuses the navigator until the visible branch IDs change.
The `context` event prepares usage from the original request, applies the selector, records the outgoing snapshot, and commits successful cut state.
The `turn_end` event records response usage.
Successful `session_start` events cover new sessions, resumes, and forks. Successful `session_tree` events cover branch navigation.
These events reset cut state and accounting. Every actual `model_select` resets both, in either window-size direction.
Successful `session_compact` events and newly projected compaction or `context_edit` entries also reset both.
The entry module deduplicates an event and its later saved-entry notification, so they cannot reset a newly established frontier twice.

Missing raw frontier keys clear old cut state. Valid current provenance can establish a fresh cut without a provider abort.
Canceled branch, fork, session-switch, and compaction attempts do not reset a cut.
A manual-compaction attempt clears accounting, but its cut survives until successful invalidation.
The extension cancels threshold and overflow compaction while paging is enabled. Manual compaction remains available.
On Pi restart, in-memory cut and warning state disappear. No frontier is restored from stored session entries.

## Failure behavior

A settings read error disables paging for the session.
A history-navigation error does not stop context selection.
A context-selection error aborts the provider request and preserves its original messages.
Recovery tools reject execution while paging is disabled.

The resident-only precheck reports `RESIDENT_INPUT_TOO_LARGE` with `Resident input estimate`.
After legal eviction, the final retained-request check uses `Resident and retained request estimate`.
This estimate includes the retained request and paging notice, not only resident input.
The final check uses `ACTIVE_REQUEST_TOO_LARGE` with an active turn and `RESIDENT_INPUT_TOO_LARGE` without one.
This wording change does not change the accounting, eviction, or recovery policy.

## Storage and trust

The extension does not create a second history ledger.
Stable IDs come from stored session entries.
The extension reads project settings only after Pi grants project trust.
The extension runs with the same operating-system permissions as Pi.
