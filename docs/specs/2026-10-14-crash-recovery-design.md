# Paging crash recovery

## Approved policy

When a session loads or changes branches, paging treats saved tool calls with missing results as interrupted.
It keeps their recorded history but excludes the incomplete exchanges from provider requests.
Live-session calls still require results.
Duplicate, mismatched, and orphan results still raise errors.
Paging does not change session files.

A tool exchange consists of an assistant message and its recorded tool results.
A crash can leave an exchange incomplete even when the assistant message still has `stopReason: "toolUse"`.
A later user message must not turn that saved exchange into a fatal paging error.

## Restore boundaries

`session_start` and `session_tree` identify incomplete exchanges on the active branch.
This includes startup, resume, reload, fork, and branch navigation.
Classification covers missing results at the branch tail and before later requests.

Each boundary replaces the in-memory set of interrupted assistant entry IDs.
Context refreshes, recovery tools, and `turn_end` use that set without adding new IDs.
Paging toggles, model changes, and compaction do not erase the restore classification.
New live incomplete exchanges keep the existing strict behavior.

## Recorded history

The projection retains the original assistant message and every actual result.
It marks recovered exchanges as failed so that history searches can find them.
It does not change the saved `stopReason`, add synthetic results, or append session entries.
A recovered exchange whose recorded results later become complete no longer needs exclusion.

## Provider requests

Selection excludes a recovered exchange only when it has unambiguous saved-entry evidence.
Cloned messages can match that evidence.
A reused call ID alone is not enough.
Identical candidate exchanges fail closed rather than hiding a new incomplete live call.
The restart prompt and custom instructions remain in the request.
Token accounting subtracts excluded exchanges without recalibrating the original input.

## Validation and tests

Restore recovery does not accept duplicate call IDs, duplicate results, mismatched results, or orphan results.
Automated tests cover missing and partial results, restore events, cloned messages, ambiguous matches, token accounting, and paging toggles.
Integration tests use the real in-memory `SessionManager` and compare recorded entries before and after recovery.
The existing suite, TypeScript typecheck, and packed-package smoke test remain completion gates.
