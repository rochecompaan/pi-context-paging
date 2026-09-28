# Architecture

## Package seam

Pi loads `src/index.ts` through the package manifest.
The extension factory is the only public code seam.
Settings and registered tools form the supported caller interface.

## Raw branch projection

`history.ts` reads only the active session branch.
It creates immutable user items and atomic model-turn items.
A model-turn item owns its contiguous matching tool results.
Projection rejects orphaned, duplicate, misassigned, or incomplete older results.
The newest incomplete assistant exchange remains absent until it is complete.

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

`context-policy.ts` counts the system prompt, active tool definitions, and canonical messages.
It groups complete conversations into eviction units.
If input exceeds the effective budget, it removes the oldest eligible unit first.
The active request and unread trailing tool-result exchange remain protected.
The selector returns new arrays and does not mutate canonical or raw history.

## Paging notices

A transient custom notice appears before retained canonical messages after eviction.
The notice reports the effective budget and gives stable recovery references.
The notice is counted in the same selection pass.
It is not written into stored session history.

## Lifecycle

`index.ts` resolves global and trusted-project settings at session start.
It refreshes projected history after turns and session-tree changes.
It reuses the navigator until the visible branch IDs change.
The `context` event applies the pure selector to one provider request.
The extension cancels threshold and overflow compaction while paging is enabled.

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
