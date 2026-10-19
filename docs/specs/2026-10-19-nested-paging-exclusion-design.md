# Paging-only wrapper exclusion

The user approved excluding wrappers only when a complete nested-call record lists exclusively paging tools.
Mixed, incomplete, and older records stay readable. This does not separate paging output inside mixed wrappers.

## Behavior

Use Pi's host-level `ToolResultMessage.nestedCalls` field. Do not inspect script text or tool-specific `details.calls` previews.
A qualifying record has `complete: true` and a nonempty `calls` array.
Each call must have a nonempty string `id`, a paging-tool `name`, and status `ok`, `error`, or `unfinished`.
The four paging tools are `search_history`, `browse_history`, `load_history`, and `read_context_output`.
Optional argument, duration, and error fields do not affect classification.

Exclude the qualifying outer call and its result through the existing shared recovery policy.
A turn containing only excluded calls stays unavailable through all recovery routes.
A mixed turn retains other outer calls, their results, and public assistant text at the original indices.
Its search metadata describes only retained work. Interrupted-response status remains intact.

The same policy governs search, browse, load, exact output reads, part reads, notices, and emergency output handles.
Raw session items, provider exchanges, eviction boundaries, and frozen notices do not change.

## Compatibility and limits

The implementation reads the optional host field without a dependency update.
Missing, incomplete, empty, and malformed required records stay readable.
A record containing any non-paging tool stays readable as one opaque wrapper exchange.
This rule covers wrappers that use the host protocol, including `codemode`. It is not a blanket wrapper exclusion.

Pi records nested tool metadata, not child results or output-to-call links.
The completeness flag describes nested tool records, not arbitrary script computation or non-tool model work.
The change does not provide output-level tracking or guarantee removal of paging data from mixed wrappers.
No wrapper changes, source parsing, dependency changes, release, publication, commit, or merge are part of this task.

## Verification

Add behavior tests before implementation. They must fail on the existing paging-only wrapper behavior.
Cover all four paging names, mixed outer turns, mixed inner calls, absent and malformed metadata, and exact read rejection.
Cover notices and emergency handles while retaining raw eviction boundaries and tool-call/result pairing.
Run focused tests, type checking, the full test suite, and packed-artifact verification with `npm run check`.
The clean baseline passed 539 tests. Its recall CLI tests need more than three minutes on this host.
