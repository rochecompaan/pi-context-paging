# pi-context-paging

`pi-context-paging` gives Pi a bounded rolling context and exact access to older session history.
It evicts coherent history units when the retained estimate exceeds the effective budget.
It does not summarize or modify the stored session transcript.

> [!WARNING]
> Pi extensions run inside the Pi process and can read prompts, tool calls, files, and session history.
> Review extension source before installation.

## Install

From npm:

```sh
pi install npm:@rochecompaan/pi-context-paging@0.1.0
```

From the GitHub release tag:

```sh
pi install git:github.com/rochecompaan/pi-context-paging@v0.1.0
```

Restart Pi after installation.

## Settings

The extension is enabled by default with a 128,000-token budget and an 80,000-token trim target.
Add this object to `~/.pi/agent/settings.json` or a trusted project `.pi/settings.json`:

```json
{
  "contextPaging": {
    "enabled": true,
    "tokenBudget": 128000,
    "trimToTokens": 80000
  }
}
```

A trusted project setting takes precedence over the global setting.
Set `enabled` to `false` to disable selection and recovery-tool execution.

The example sets an explicit target. If you omit `trimToTokens`, its default is `max(1, floor(tokenBudget * 5 / 8))`.
A 64,000-token budget therefore has a 40,000-token default target.
The effective budget never exceeds the active model context window.
A smaller window scales the target by `effectiveBudget / tokenBudget`, with a minimum of one token.

Both token settings accept positive safe integers only. Invalid project values fall through to valid global values, then defaults.
The extension ignores untrusted project settings. It does not coerce strings, fractions, or other invalid values.
An inherited explicit global target remains explicit, even with a lower project budget.

An explicit target at or above the budget leaves no headroom between cuts.
The extension keeps stable cuts but trims toward the effective budget instead.
It warns once per resolved budget/target pair per extension instance. A restart can repeat the warning.

## Recovery tools

| Tool | Purpose |
| --- | --- |
| `search_history` | Find compact history references by text, file, tool, or failure state. |
| `browse_history` | Move backward, forward, or around an exact history anchor. |
| `load_history` | Load complete stored history items by stable ID. |
| `read_context_output` | Read exact pages from large assistant or tool-result output. |

Search and browse return compact references.
Load tools return exact stored content without automatic replacement.

## How context selection works

The extension uses tracked provider usage when it has a valid response anchor. Otherwise, it estimates the request.
Resident prompt input and tool schemas contribute once.
The extension validates the original request before any cut, then omits aborted or errored assistant exchanges from provider input.
Those exchanges and their actual results remain available through the recovery tools.

Without a remembered cut, a request within the budget needs no paging notice.
After eviction, the extension remembers a frontier: the last excluded history unit or model exchange.
It reuses that cut and the exact same notice until the retained estimate exceeds the budget.
Equality does not trigger a cut. A request between the target and budget does not trigger a cut either.
On a budget crossing, FIFO eviction moves the frontier forward toward the target, including the notice's token cost.
Lower estimates do not restore excluded messages. Protected content can prevent the target without causing an error below the budget.
The protected floor is the estimate of content that cannot be evicted.
If this floor exceeds the target, one cut evicts every completed turn before any keyless-boundary adjustment.
The active request and unread trailing tool results remain protected.

A partly cut turn keeps its request and surviving exchanges after completion.
This rule includes custom-started turns without user history IDs. A later cut removes the completed remainder as one unit.
If eviction ends at a unit without a stable key, the boundary snaps back to the last excluded keyed unit.
The request retains the following keyless units. This cut stays stable only if its estimate, including the notice, fits the budget.

Missing or ambiguous history keys use stateless selection toward the budget, without a remembered cut for that call.
The same fallback applies without an excluded key, after an over-budget backward snap, or without the anchor in current request groups.
These calls cannot promise a stable prefix. The extension never removes extra history merely to find a later key.

Successful session changes, branch navigation, forks, compaction, context edits, and model switches reset the cut.
A Pi restart loses the in-memory cut. Canceled operations and accounting fallback alone do not reset it.
For ordinary append-only history with stable resident input, the cut preserves the outgoing prefix between budget crossings.
Protected-overflow and recovery modes can replace the leading notice or tool-result payloads.
These exceptions, resets, and other extensions' message edits prevent a guarantee that every provider call is append-only.

After legal eviction, `RESIDENT_INPUT_TOO_LARGE` can report `Resident and retained request estimate`.
That wording includes the retained request and paging notice, not only resident input.
The resident-only precheck still reports `Resident input estimate`. The wording does not change the accounting or recovery policy.

The extension cancels automatic compaction while it is enabled.
Manual compaction remains available.

Read [the architecture document](docs/architecture.md) for module and lifecycle details.

## Changes in 0.1.1

- Provider-backed accounting handles restored raw history and outgoing-only instructions without counting resident input twice.
- Raw history retains interrupted turns and actual results. Provider requests omit those exchanges after validating their results.
- Normal incomplete exchanges and malformed results retain strict validation.

The installation examples still target the published `0.1.0` release. Publication of the `0.1.1` candidate requires separate approval.
The stable-cut settings and behavior described here are candidate changes, not a newly published release.

## Development

Requirements:

- Node.js 22.19.0 or newer
- npm

Run all checks:

```sh
npm ci
npm run typecheck
npm test
npm run check:package
```

Run the performance benchmark:

```sh
npm run bench
```

## Upgrade and removal

Upgrade installed packages:

```sh
pi update --extensions
```

Remove the package:

```sh
pi remove npm:@rochecompaan/pi-context-paging@0.1.0
```

## License

MIT
