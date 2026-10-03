# pi-context-paging

`pi-context-paging` gives Pi a bounded rolling context and exact access to older session history.
It evicts coherent completed exchanges when a request exceeds the configured budget.
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

The extension is enabled by default with a 128,000-token budget.
Add this object to `~/.pi/agent/settings.json` or a trusted project `.pi/settings.json`:

```json
{
  "contextPaging": {
    "enabled": true,
    "tokenBudget": 128000
  }
}
```

A trusted project setting takes precedence over the global setting.
Set `enabled` to `false` to disable selection and recovery-tool execution.
The effective budget never exceeds the active model context window.

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
Before selection, it omits aborted or errored assistant exchanges from provider input.
Those exchanges and their actual results remain available through the recovery tools.
If the remaining request fits, the extension sends it without paging.
If it does not fit, the extension removes the oldest complete eligible exchange first.
The active request and unread trailing tool results remain protected.
A paging notice gives recovery references for removed history.

The extension cancels automatic compaction while it is enabled.
Manual compaction remains available.

Read [the architecture document](docs/architecture.md) for module and lifecycle details.

## Changes in 0.1.1

- Provider-backed accounting handles restored raw history and outgoing-only instructions without counting resident input twice.
- Raw history retains interrupted turns and actual results. Provider requests omit those exchanges after validating their results.
- Normal incomplete exchanges and malformed results retain strict validation.

The installation examples still target the published `0.1.0` release. Publication of the `0.1.1` candidate requires separate approval.

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
