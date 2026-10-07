# Calibration during history eviction

## Scope

Fix the false `ACTIVE_REQUEST_TOO_LARGE` error after an oversized history recovery.
Keep the 128,000-token budget, resident checks, protected request checks, and newest tool exchange protection.
Do not change raw history, recovery APIs, dependencies, or deployment configuration.

## Cause

The selector adds the full difference between provider usage and local estimates to every retained selection.
This treats undercounted, removable recovery text as a permanent cost.
The saved session reaches a false minimum of 172,194 tokens before the selector can remove that text.

## Accounting model

Keep the successful provider response linked to its selected request.
When the provider count exceeds local estimates, separate the excess into two parts:

- A resident overhead estimate that remains after eviction.
- Additional costs assigned to the measured persistent messages and response.

A single measurement cannot identify the exact fixed overhead.
For the first observation, allocate the excess in proportion to resident and persistent message estimates.
Later observations can lower the resident overhead estimate. A larger total does not raise this fixed floor.
Distribute the remaining excess across the measured persistent messages in proportion to their local estimates.

Outgoing-only instructions and notices keep their local estimates.
New messages and restored, unselected history also keep their local estimates.
Match measured messages backwards from the response so identical restored prefixes do not receive the retained request's costs.

The tracker keeps the existing scalar `prepare()` result and also exposes costs aligned with its original input messages.
The selector uses these costs before normalization, remembered cuts, and FIFO eviction.
Removing a message removes its assigned cost. It does not add that cost to the active request.
Invalid or misaligned costs fall back to the existing accounting.

Keep the existing additive correction for negative excess.
Do not reuse message costs when the status total disagrees with the tracked response.
Clear prepared costs on the next preparation and on lifecycle reset.

## Safety and limits

These costs are estimates. They do not prove the provider token count for a reduced request.
The resident floor, active request, protected exchange, and hard model limit still use the existing safety checks.
A new unread recovery exchange can exceed the paging budget under the existing protected-overflow policy.
After consumption, that exchange becomes eligible for eviction.

## Verification

Use synthetic regressions with and without an earlier usage observation.
Keep oversized resident input and active request rejection regressions.
Cover runtime extension wiring, duplicate message attribution, invalid weights, and lifecycle reset.
Run `npm run check` for type checking, the full test suite, and packed-extension startup.
Replay the original saved session without model calls. Compare the old and new failing boundary and hash the session before and after.
Do not store the private session contents in the repository.
