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

## Context selection

`context-policy.ts` counts the system prompt and active tool definitions once as resident input.
Ordinary message estimates do not count outgoing system metadata a second time.
Before grouping, the selector validates every actual result and omits interrupted assistants and their contiguous owned results.
This normalization applies even when the request fits the budget. It keeps outgoing-only provenance aligned with retained messages.
It groups the remaining complete conversations into eviction units.
If input exceeds the effective budget, it removes the oldest eligible unit first.
The persistent active request, injected instructions, and latest valid unread tool-result exchange remain protected.
Interrupted exchanges do not receive unread-result protection.
The selector does not mutate canonical or raw history.

## Provider-backed usage

`context-usage.ts` links a successful provider response to the exact selected request snapshot.
It matches that snapshot against the projected persistent session and separates outgoing-only instructions.
It subtracts the full persistent tail from Pi's status total, including system updates absent from outgoing messages.
Resident prompt and tool schemas contribute once. Weak caches reuse message fingerprints and estimates.
When no valid response anchor exists, selection uses the heuristic fallback.
Calibration uses the original incoming estimate. Omitted interrupted exchanges reduce the estimate without losing the provider offset.
The default budget remains `128_000`, capped by the active model context window.

## Paging notices

A transient paging notice appears before retained canonical messages after eviction.
The notice reports the effective budget and gives stable recovery references.
The notice is counted in the same selection pass.
It is not written into stored session history.

## Lifecycle

`index.ts` resolves global and trusted-project settings at session start.
It refreshes projected history after turns and session-tree changes.
It reuses the navigator until the visible branch IDs change.
The `context` event prepares usage, applies the pure selector, and records the outgoing snapshot.
The `turn_end` event records response usage.
Session start, session-tree changes, model changes, and compaction clear the usage anchor.
New compaction or context-edit branch entries and projection errors also clear the anchor.
The extension cancels threshold and overflow compaction while paging is enabled. Manual compaction remains available.

## Failure behavior

A settings read error disables paging for the session.
A history-navigation error does not stop context selection.
A context-selection error aborts the provider request and preserves its original messages.
Recovery tools reject execution while paging is disabled.

## Storage and trust

The extension does not create a second history ledger.
Stable IDs come from stored session entries.
The extension reads project settings only after Pi grants project trust.
The extension runs with the same operating-system permissions as Pi.
