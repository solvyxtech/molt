# molt in an editor: the ACP server

`molt acp` runs molt as an [Agent Client Protocol](https://agentclientprotocol.com)
agent on stdio, so an editor's agent panel can drive it. Zed is the first
target. The editor sends prompts and shows what happens; molt runs the same
turn it runs in the terminal and the window — the same engine, autonomy gate,
ledger, bar and receipts — and reports it back over ACP.

What an editor gets from molt that it does not get from other agents is the
last line of every turn: whether "done" was **proven**.

```
---
**molt · bar met** — done is proven: 5 of 5 checks passed · receipt `.molt/receipts/0012-accepted.md`
- ✓ tests — pass
- ✓ work-landed — pass
…
```

## Register molt in Zed

molt-desktop does not install a `molt` binary; point Zed at the built CLI.
Build it once with `npm run build`, then add this to Zed's `settings.json`
(Agent Settings → External Agents → Add Custom Agent opens the right place):

```json
{
  "agent_servers": {
    "molt": {
      "type": "custom",
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/molt-desktop/dist/cli.js", "acp"],
      "env": {},
      "default_mode": "low"
    }
  }
}
```

- `command` is the absolute path to `node` (`which node`). An editor started
  from the Dock does not have your shell's PATH, so a bare `node` may not be
  found.
- `--acp` works in place of `acp`, for launchers that want a flag.
- If the CLI package is installed (`npm run pack:cli`, `@solvyx/molt`),
  `"command": "molt", "args": ["acp"]` is the same thing.
- `default_mode` is molt's autonomy level: `low`, `medium` or `high` (see
  [autonomy.md](autonomy.md)). It can be changed per thread from the mode
  picker. `--autonomy <level>` or `--yes` in `args` set the starting level too.

### Which model

molt uses the endpoint and model it would use in the terminal: whatever
`/login` and `/model` last stored in `~/.config/molt/`. To pin one for the
editor, put the usual flags in `args`, and the key in `env`:

```json
"args": ["/path/to/dist/cli.js", "acp", "--url", "https://api.x.ai/v1", "--model", "grok-4.6"],
"env": { "MOLT_API_KEY": "…" }
```

Every `molt run` flag that shapes a session works here: `--attempts`, `--for`,
`--budget`, `--commit`, `--revert`, `--map`, `--read`, `--price-in/--price-out`.
With no model configured, opening a thread fails with a message saying how to
set one.

### The bar's commands and PATH

The bar runs `.molt/done.yml`'s commands in the project. If they fail with
exit 127 (`npm: command not found`), the editor's environment has no PATH to
your toolchain: add `"PATH": "…"` to `env`.

### Logs

molt writes diagnostics to stderr, never stdout. In Zed, `dev: open acp logs`
shows the protocol traffic and the agent's stderr.

## What is supported

| ACP | molt |
|---|---|
| `initialize` | protocol version 1. Capabilities are stated as they are: `loadSession: false`; prompts take text and embedded context, not images or audio; no MCP. `authMethods` is empty. |
| `authenticate` | refused: there is nothing to authenticate. molt reads keys from its own config or `MOLT_API_KEY`. |
| `session/new` | `cwd` must be absolute. `mcpServers` are accepted and ignored (logged on stderr): molt does not connect to MCP servers. Returns molt's autonomy levels as the session's modes. |
| `session/set_mode` | sets the autonomy level (`low` / `medium` / `high`). |
| `session/prompt` | `text`, `resource_link` (named inline; the model reads the file if it needs it) and `resource` (the attached text is included). A leading `?` or `/ask` makes the turn a question, as in the terminal; `/ask` is advertised as a command. |
| `session/cancel` | stops the turn wherever it is: the request, the running command (killed), the bar, or a permission question the editor has not answered. Files already written stay written and are named. |
| `session/load`, `session/list`, fork/resume/close | not implemented (`Method not found`). A session lives as long as the process. |

Updates sent during a turn:

| update | from |
|---|---|
| `agent_message_chunk` | the model's streamed text; molt's own notes (a refused completion, a shed, a ceiling) in italics; the verdict last |
| `agent_thought_chunk` | reasoning the provider streams apart from the answer (`reasoning_content` / `reasoning` on the OpenAI shape). The native Anthropic stream and the subscription backends do not surface it. |
| `tool_call`, `tool_call_update` | one row per molt tool call, created once, with `kind` (read / search / edit / execute), `title`, absolute `locations`, `rawInput`, status `pending` → `in_progress` → `completed` / `failed`, and for every write a `diff` with `oldText` (null for a new file) and `newText`. Other results come back as text. |
| `plan` | the bar: one entry per check, `pending` → `in_progress` while the bar runs → `completed` when it passes. A check that failed goes back to `pending` (still to do) and says `FAILED`. Advisory checks are `low` priority. No bar, no plan. |
| `usage_update` | after each step: `used` = the tokens that step sent and received (the size of the conversation), `size` = the context window the endpoint has named, or 0 until it names one — molt does not invent a window — and `cost` = the session's cost so far in USD when a price is known. `_meta.molt` says whether the numbers are estimated. |
| `available_commands_update` | `ask` |

The prompt response also carries `usage` (the turn's tokens, in the schema's
unstable end-turn usage field) and `_meta.molt`:

```json
{ "outcome": "verified", "verdict": "met", "receipt": "/…/.molt/receipts/0012-accepted.md",
  "checks": [{ "name": "tests", "ok": true }], "costUsd": 0.041, "costEstimated": false }
```

`verdict` is one of `met`, `not met`, `undetermined`, `answered`, `unverified`,
`cancelled`, `stopped`.

### Stop reasons

| molt | `stopReason` |
|---|---|
| the turn finished — bar met, bar not met, or no bar | `end_turn` |
| cancelled | `cancelled` |
| the step guard | `max_turn_requests` |
| the session budget or the per-turn ceiling | `max_tokens` |
| the reply was cut off at the output ceiling and could not recover | `max_tokens` |
| the provider failed (bad key, endpoint down) | a JSON-RPC error with molt's message |

`refusal` is never used. In ACP it means the agent declined the prompt, and
the editor drops that prompt from the thread's history. molt refusing a
completion is not that: the conversation stands, the bar said no, and the
verdict says so.

### Permissions

molt asks what its autonomy level would ask in the terminal, no more and no
less, through `session/request_permission`. The question is attached to the
tool call's row, shows the diff a write would make, and says which rule made
it a question. Answers:

- **Allow** / **Reject** — this call.
- **Always allow / Always reject writes in this project** — every
  `write_file`/`edit_file` inside the project for the rest of the session.
- **Always allow / Always reject this command** — that exact `bash` command
  for the rest of the session.

"Always" is not offered for a path outside the project or for a command molt
classifies as irreversible. Those always ask, at every level, and an answer in
an editor does not change that.

When a turn reaches the step guard or a spending ceiling, molt asks whether to
continue on a row of its own ("Keep going?"), the way the window does, rather
than stopping dead.

### Files go through the editor

When the editor offers `fs/read_text_file` and `fs/write_text_file` (Zed
does), molt's `read_file`, `edit_file` and `write_file` go through them, so
the model sees unsaved changes and edits land in the open buffer. The editor
saves the buffer, and molt ledgers what is then on **disk**, because that is
what the bar reads: an editor that formats on save changes the file molt wrote,
and the model is told when it did. A path the editor cannot serve (outside its
project, say), or a write it takes but does not save, falls back to disk.

`list_dir`, `grep`, `bash` and every bar check work on disk. The editor's
terminal capability is not used: commands run in molt's process, under molt's
timeout and output cap, and are killed on cancel.

## Not supported, deliberately or not yet

- MCP servers passed by the editor (molt has its own six tools; MCP is a
  stated non-goal).
- Loading, listing or resuming sessions.
- Images and audio in prompts.
- Task criteria. The window drafts them from the first prompt for a person to
  approve before work starts; ACP has no step for that approval, so an editor
  session is judged against the project's `.molt/done.yml` only.
- The subscription backends (`--url claude-code`, `grok-build`, `gemini-cli`,
  `antigravity`) are selected the same way as any endpoint, but have not been
  exercised behind an editor session yet; the tests drive an OpenAI-shaped
  provider.
