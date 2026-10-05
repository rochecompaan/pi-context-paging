# Read-only context-paging stats

Date: 2026-10-05
Layout: approved by the user after the terminal preview.
Branch: `feat/context-paging-stats`

## Goal

`/context-paging stats` separates saved session size, latest request input, and cumulative cache traffic.
The command works with paging on or off. It does not publish a release.

## Report

The report uses three sections:

- **SESSION:** actual stored-file bytes and estimated history tokens.
- **CONTEXT:** latest conversation-request input, effective paging budget, and model window.
- **CACHE:** whole-session cache reads and writes from saved usage.

The header shows the effective session choice as `Context paging: on` or `Context paging: off`.
`~` marks estimates. Missing measurements show `unavailable`, not zero.
A disabled budget shows `inactive`.

## Measurement sources

File metadata supplies stored bytes. An absent or unreadable file has no byte measurement.
Raw entries from `getEntries()` supply history across all branches, including paged-out content.
Pi's estimator counts saved messages, summaries, and edit replacements. Originals remain part of the estimate.
Metadata and opaque signatures contribute to stored bytes, not estimated message tokens.

Complete provider usage supplies input through `input + cacheRead + cacheWrite`. Output does not contribute.
Before complete usage arrives, the latest successful paging selection supplies an estimate.
The estimate includes resident input and the paging notice.
After resume, the latest saved assistant on the active branch can supply measured input.
Lifecycle changes clear the transient measurement. Summary and model-change boundaries prevent reuse of an older response count.
The report does not estimate the next request after the latest response.

Each saved usage record contributes once to cache totals across all branches.
Records include assistant responses, tool results with usage, warming entries, compaction, and branch summaries.
A missing or invalid component makes its whole-session total unavailable. Unsafe totals also show `unavailable`.
Records with only zero or missing counters supply no measurement.
Explicit zero cache counters remain zero when the record contains other measured token counts.
These totals describe Pi's saved usage, not provider invoices or unrecorded extension calls.

## Read-only boundary

The stats action does not call a provider, append session entries, or write settings.
It does not refresh navigation, reset calibration, move a cut, or publish footer status.
The UI notification does not enter saved history or model context.
Existing paging, recovery, and compaction behavior remain unchanged.

## Implementation and verification

`src/stats.ts` owns collection and formatting. `src/index.ts` owns command dispatch and transient request measurements.
Command regression tests use real SDK session managers, saved files, branches, usage records, and context edits.
A cut-stability regression checks that stats cannot restore removed history when estimates decrease.
The package smoke check includes the new runtime module.

The final gate is `npm run check`: typecheck, all tests, and packed-artifact extension loading.
Documentation and the package file list need direct verification, not new static-content tests.
Version 0.3.1, dependency pins, and the eval worktree remain unchanged.
The user selected local squash integration into `main` on 2026-10-05.
This choice does not authorize a push or release.
