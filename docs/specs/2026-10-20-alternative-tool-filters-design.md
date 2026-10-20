# Alternative tool filters for history search

The user approved treating multiple names in `search_history.tools` as alternatives.
An agent can name several possible tools when it does not remember which tool it used.

## Search behavior

A nonempty `tools` list matches a public model turn when its tool metadata contains at least one listed name.
For example, `tools: ["bash", "codemode"]` matches a turn with either tool, or both tools.
Each result must still match the text query and every other supplied filter.
The `files` filter continues to require every listed file, and `failed` retains its current behavior.

Omitting `tools`, or supplying an empty list, adds no tool restriction.
Single-tool searches and exact tool-name matching remain unchanged.
An unknown tool name does not prevent another listed name from matching.
A nonempty list excludes user messages and turns without tools.

## Scope

Keep the existing input fields and validation limits.
Do not add a matching-mode parameter or retain an explicit match-all mode.
Do not change ranking, previews, file-filter semantics, history projection, or indexing of nested tool names.
Update the parameter description and README to explain the behavior.
Do not change dependencies, publish a release, or integrate into `main` as part of implementation.

## Verification

Use real `HistoryNavigator.search` calls to test alternatives, unknown names, and empty lists.
Include a combined-filter case that rejects a wrong query, a missing file, the wrong failure state, and an unrelated tool.
Watch the new alternative-filter cases fail before changing production code.
Run the focused navigator tests and the complete `npm run check` command after the change.
Use direct review for documentation and parameter-description changes, not new tests of static text.
