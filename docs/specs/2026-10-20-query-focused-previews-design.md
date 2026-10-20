# Query-focused search previews

The user approved short search excerpts around matching public text.
The current preview always starts with the assistant response or user message.
A search can therefore find a tool result without showing the matching evidence.

## Approved behavior

For a nonempty text query, each search preview shows context around a matching search term.
The excerpt can come from public user text, assistant text, tool arguments, tool output, or indexed file metadata.
Search results keep their existing history IDs, ordering, metadata, and recovery handles.
Browse previews and empty-query search previews stay unchanged.
Private assistant blocks, paging exchanges, and native image data remain unavailable as search text.
Stored history and exact recovery content do not change.

## Implementation choices

These are builder choices within the approved scope, not separate user requirements.
Use the first matching term in the existing public search text.
Use the same lowercasing, punctuation rules, and word boundaries as the search index.
Collapse whitespace for display and keep the original letter case.
Keep each preview within 160 UTF-16 code units, including ellipses that mark clipped ends.
Do not split a Unicode surrogate pair at either clipped end.
Keep enough context on each side when space permits.
A matching term longer than the excerpt budget can itself be clipped.

Retain the public text beside its term counts in the lazy search cache.
This retains more text in memory until the next rebuild, but avoids repeated tool-result serialization.
Keep the formatter private in `src/navigator.ts` while the file remains focused and below about 400 lines.
Do not mutate cached browse references when a query changes its preview.
Do not change ranking, token matching, parameters, dependencies, package versions, or reply limits.

## Verification

Use real `HistoryNavigator.search` calls and watch new excerpt tests fail before changing production code.
Cover late matches in public messages, tool output, and tool arguments.
Cover exact token boundaries, punctuation, Unicode, long terms, clipped ends, and repeated queries.
Make sure that browse references, empty-query previews, and exact loads do not change.
Run existing privacy, paging-exclusion, reply-budget, and lazy-serialization tests.
Run the complete `npm run check` command, including packed-package startup.
Review documentation and tool-description changes directly instead of testing static text.
Leave the feature isolated for the user to choose integration. Do not commit, push, or publish it automatically.
