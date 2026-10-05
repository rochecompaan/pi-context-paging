# pi-context-paging

`pi-context-paging` gives Pi a rolling context window with a fixed token budget.
When the window is full, the oldest history leaves the window.
The stored session history does not change.
The model gets tools to find that older history and load it again as exact text.
The extension never summarizes history.

## The problem with compaction and handoff

Every model has a context window with a fixed size.
A long session fills this window.
Then Pi must make room before it sends the next request.

Pi usually makes room with compaction.
Compaction keeps a small recent part of the history as it is. By default, this part is 20,000 tokens.
In a busy session, that part covers only the last few steps.
The model writes a summary of everything before that part. The summary replaces those messages.

A handoff is similar.
You ask the model for a summary note, then you start a new session from that note.

Both methods lose detail.
A summary keeps the main points. It drops exact file paths, error text, tool output, and the state of unfinished work.
The lost detail is often the detail that the model needs most.
The work from the last hour has the files the model read, the errors it saw, and the decisions it made.

Most of that work is older than the small recent part, so the summary replaces it.
After compaction, the model continues from the summary and not from the real history.
The model cannot get the lost detail back.

Compaction also happens at a bad time.
When the window is almost full, Pi starts compaction. This is often in the middle of a task.

A full window also makes the model worse.
When the context is long, many models give worse answers. This happens well before the window is full.
People call this part of the window the dumb zone.
Pi waits for an almost full window before it starts compaction.
As a result, the model works in the dumb zone for a long time before each compaction.

## The idea: a rolling window, not a summary

The session history is like a long document.
The model reads this document through a window.
The window shows only the most recent part.
When the document grows, the window moves forward.
Nothing is cut from the document.

The extension works like this:

- Pi stores the full session history on disk. The extension never changes this history.
- The extension sends the model only the most recent history that fits in the token budget. This part is the rolling window.
- When a request is larger than the budget, the extension removes the oldest history from the window. That history stays in the stored session.
- The model gets a short paging notice at the start of the window. The notice says that older context left the window, and how to get it back.
- The model has four recovery tools. They search, browse, and load the older history as exact text.

This is better than compaction or handoff for these reasons:

- **The model stays out of the dumb zone.** The extension keeps requests at or below the token budget. If you set the budget below the point where the model gets worse, the model always works with a short context.
- **The recent context stays exact.** The newest messages and tool results stay in the window as stored.
- **The oldest history leaves first.** The extension removes whole turns from the start of the history. It does not choose by content.
- **Nothing is lost.** The model can search for any older item and load it again as exact text.
- **Old detail returns on request.** A summary must guess in advance which details matter. A recovery tool returns the exact item that the model asks for.
- **There is no surprise compaction.** The extension cancels automatic compaction while it is enabled. You can still compact by hand.

One behavior is different from compaction.
The model does not see older history until it asks for it.
The paging notice tells the model that older context exists and how to load it.
The model decides when to search.

## Install

From npm:

```sh
pi install npm:@rochecompaan/pi-context-paging@0.3.1
```

From the GitHub release tag:

```sh
pi install git:github.com/rochecompaan/pi-context-paging@v0.3.1
```

After installation, restart Pi.

## Settings

The extension is enabled by default.
The default token budget is 128,000 tokens.
The default trim target is 80,000 tokens.
To change these values, add this object to `~/.pi/agent/settings.json` or to a trusted project `.pi/settings.json`:

```json
{
  "contextPaging": {
    "enabled": true,
    "tokenBudget": 128000,
    "trimToTokens": 80000
  }
}
```

| Setting | Meaning | Default |
| --- | --- | --- |
| `enabled` | Set this to `false` to stop paging and the recovery tools. | `true` |
| `tokenBudget` | The largest request size, in estimated tokens. A larger request causes a cut. | `128000` |
| `trimToTokens` | The request size that a cut trims to. | 5/8 of the budget |

A trusted project setting takes precedence over the global setting.
The extension ignores project settings in untrusted projects.

To keep the model out of the dumb zone, set `tokenBudget` below the context size where the model gets worse.
If your model gets worse before 128,000 tokens, lower the budget.

If you omit `trimToTokens`, the default is `max(1, floor(tokenBudget * 5 / 8))`.
A 64,000-token budget therefore has a 40,000-token default target.
The effective budget never exceeds the context window of the active model.
If the model window is smaller than the budget, the extension scales the target by the same ratio.
The minimum target is one token.

Both token settings accept positive safe integers only.
The extension does not convert strings, fractions, or other invalid values.
An invalid project value does not apply. The extension then uses the global value, or the default.
If a project sets a lower budget, an explicit global target stays explicit.

If you set a target at or above the budget, there is no headroom between cuts.
The extension keeps stable cuts, but it trims to the effective budget instead.
It warns once for each budget and target pair in one Pi process.
A restart can repeat the warning.

## Session command

Use `/context-paging` to change paging for the current session only:

| Command | Effect |
| --- | --- |
| `/context-paging on` | Enable paging and recovery tools. |
| `/context-paging off` | Disable paging and recovery tools. Pi uses its normal context and automatic compaction behavior. |
| `/context-paging` or `/context-paging status` | Show whether paging is enabled or disabled. |

The command does not change saved settings or stored session history.
A state change clears the remembered cut point and token accounting.
Repeating `on` or `off` does not clear this state.

Branch navigation, model changes, and manual compaction keep the session choice.
A new session, a resume, a fork, or an extension reload restores the saved settings.

### Footer status

In UI sessions, the extension publishes its effective state under the `context-paging` status key.
The text is exactly `paging on` or `paging off`, without ANSI styling.
Custom footers can read this value from `footerData.getExtensionStatuses()`.

The status reflects saved settings at session start and the current session choice after every `on` or `off` command.
Repeated choices also publish the status.
If settings fail to load, the status shows `paging off`.
Session shutdown removes the status key. Headless sessions do not call the status UI.

## Recovery tools

| Tool | Purpose |
| --- | --- |
| `search_history` | Find compact references to history by text, file, tool, or failure state. |
| `browse_history` | Move backward, forward, or around one history item. |
| `load_history` | Load complete stored history items by stable ID. |
| `read_context_output` | Read exact pages of large assistant or tool-result output. |

Search and browse return compact references.
Load and read return the exact stored content.
The tools never summarize.
When paging is disabled, the tools refuse to run.

## How the extension selects the window

**Measurement.** If the provider reported token usage for the previous response, the extension uses that usage.
Otherwise, it estimates the request.
The system prompt and tool definitions count once.

**Validation.** Before any cut, the extension validates the request.
It does not send aborted or errored assistant exchanges to the model.
Those exchanges and their actual results stay in the stored history and the recovery tools.

**The cut point.** A request within the budget needs no cut and no notice.
When a request exceeds the budget, the extension removes the oldest history until the request is at or below the target.
The size of the paging notice counts as part of the request.
The extension then remembers the cut point (the architecture document calls it the frontier).

The extension reuses the same cut point and the same notice until the request exceeds the budget again.
A request that is equal to the budget, or between the target and the budget, does not move the cut point.
A lower estimate never brings removed history back.

**Why the cut point is stable.** The same cut point means that each request starts with the same messages as the last one.
This keeps the provider prompt cache useful between cuts.
The guarantee holds for ordinary append-only history with stable resident input.

Two special cases exist for very large tool results.
When the newest tool result is too large for the budget, the extension keeps it in full for one call. It also changes the notice.
When it is too large for the model window, the extension replaces it with a recovery reference.
These two cases, resets, and message edits by other extensions can change the start of the request.

**Protected content.** The extension never removes the active request or the newest unread tool results.
Protected content can keep the request above the target.
That is not an error while the request is within the budget.
If the protected content alone is above the target, one cut removes every completed turn.

**Whole units.** The extension removes whole completed turns, oldest first.
Inside the active turn, it can remove older model exchanges, but never the current request or the unread tool results.
A partly cut turn keeps its request and the exchanges that survived the cut.
A later cut removes that completed remainder as one unit.

**Stable keys.** Each cut point uses stable history IDs, not positions in a list.
A few history items have no stable key.
If a cut ends at such an item, the cut point moves back to the last removed item that has a key.
The items after that point stay in the request.
If the request and the notice together fit the budget, this moved-back cut stays stable.

Two cases have no stable cut point.
The first case is a missing or ambiguous history key.
The second case is a moved-back cut that does not fit the budget.
In these cases, the extension selects history for that one request only, toward the budget.
It does not remember that selection.
It never removes extra history only to find a key.

**Resets.** These events reset the cut point: a session change, branch navigation, a fork, compaction, a context edit, or a model switch.
A Pi restart also loses the cut point, because the cut point lives only in memory.
Canceled operations do not reset it.
A fallback in token accounting does not reset it either.

**Error wording.** After a legal cut, `RESIDENT_INPUT_TOO_LARGE` can report `Resident and retained request estimate`.
That wording means the retained request and the paging notice, not only resident input.
The resident-only precheck still reports `Resident input estimate`.
The wording does not change the accounting or the recovery policy.

**Compaction.** The extension cancels automatic compaction while it is enabled.
Manual compaction remains available.
A successful manual compaction resets the cut point.

Read [the architecture document](docs/architecture.md) for module and lifecycle details.

## Changes in 0.3.1

- The `context-paging` extension status reports the effective state as plain `paging on` or `paging off` text.
- Session start and every `on` or `off` command publish the status, including repeated choices.
- A new session restores the saved state in the status. A settings read error publishes `paging off`.
- Session shutdown removes the status. Headless sessions do not call the status UI.
- Paging, recovery, and compaction behavior stay unchanged.

## Changes in 0.3.0

- `/context-paging on` and `/context-paging off` change paging for the current session only.
- `/context-paging` and `/context-paging status` show the current state.
- The command leaves saved settings and stored history unchanged.
- A new session, a resume, a fork, or an extension reload restores saved settings. Branch navigation keeps the session choice.
- Actual state changes clear the remembered cut point and token accounting. Repeated choices and status queries keep both.

## Changes in 0.2.1

- The README now explains context paging in simple English. It describes why compaction and handoff lose recent detail, and how a bounded window keeps the model out of the dumb zone.
- The runtime source is unchanged from 0.2.0.

## Changes in 0.2.0

- The cut point and the paging notice stay the same between budget crossings. A lower estimate does not bring removed history back.
- `trimToTokens` defaults to 5/8 of the budget. Token settings accept positive safe integers and scale for smaller model windows.
- Custom-started turns and partly cut turns keep valid cut points after completion.
- A cut point without a stable key moves back only within the budget. Missing or ambiguous keys use stateless selection toward the budget.
- Successful lifecycle changes reset the cut point. Canceled navigation keeps it.
- Outgoing-only instructions no longer hide an earlier valid turn anchor.
- Error wording now separates resident input from the retained request and the paging notice.

### Earlier fixes in this release

- Provider-backed accounting handles restored raw history and outgoing-only instructions. It does not count resident input twice.
- Raw history keeps interrupted turns and their actual results. Provider requests omit those exchanges after the extension validates their results.
- Normal incomplete exchanges and malformed results keep strict validation.

This release does not change the accounting further.
The extension does not yet let the model choose which history to remove.

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
pi remove npm:@rochecompaan/pi-context-paging@0.3.1
```

## License

MIT
