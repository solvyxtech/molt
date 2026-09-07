# Antigravity CLI (`agy`) — protocol notes

Read off `agy 1.1.25` on a live Google AI plan, 2026-09-07. The published docs
do not cover the stream format or the permission rule syntax, and one round of
guessing at the syntax produced rules that parsed, applied, and did nothing —
which is the worst failure mode a security control has. Everything here was
executed.

## Starting it

```
agy --input-format stream-json --output-format stream-json \
    --model <id> --print-timeout 3600s --print=
```

`--print=` with an empty value is required. `--print` takes its prompt as a
flag *value*, so a bare `--print` swallows the next flag:

> `Error: --print took "--input-format" as its prompt, so the intended prompt
> was left as an argument and ignored.`

## The stream

**In** — one NDJSON line per turn, on stdin. The process stays alive and holds
the conversation:

```json
{"event":"user","message":{"role":"user","content":"…"}}
```

Anything else is refused by name: `{"bogus":true}` gives *"stream input message
is missing the \"event\" field"*, and `{"event":"prompt"}` gives *"ignoring
unsupported stream input message event"*. `user` is the only accepted event.

**Out** — three event kinds:

| event | carries |
|---|---|
| `init` | `init.tools` (57 of them), `init.permission_mode`, `init.cwd`, `conversation_id` |
| `step_update` | `step_type` (`user_input` \| `agent_response` \| `tool`), `state` (`ACTIVE` \| `DONE` \| `ERROR`), `text_delta`, `tool_name`, `tool_info.parameters`, `tool_info.error.message` |
| `result` | `status`, `response`, `error`, `usage` |

`usage` is real, not estimated: `input_tokens`, `output_tokens`,
`thinking_tokens`, `cache_read_tokens`, `total_tokens`.

**Context and caching survive across turns in one process.** Turn 1 stored a
word and read 8,122 cached tokens; turn 2 recalled it and read 28,419. A
process per turn would pay for the context again every step.

Not every stdout line is JSON — refusals and warnings arrive as plain text on
the same stream, and they are the most useful lines the CLI produces.

## Permissions — the part that makes this backend possible

Headless **denies by default**. A tool needing permission with no matching rule
cannot prompt anyone, so it is refused:

> `jetski: no output produced — a tool required the "write_file" permission
> that headless mode cannot prompt for, so it was auto-denied. Add an
> allow-rule under permissions.allow in settings.json`

Verified three ways on a live account:

| attempt | outcome |
|---|---|
| `write_to_file` into cwd | **denied**, file never created |
| `run_command: touch <path>` | **denied**, file never created |
| `run_command: echo hi` | ran — read-only shell commands are auto-approved |
| `call_mcp_tool` with no rule | **denied** |
| `call_mcp_tool` with the rule below | **ran**, and the MCP handler really fired |

### Rule syntax

The rule string is exactly what the CLI prints when it refuses:

```
user denied permission for mcp(molttest/molt_ping)
```

so the rule is `mcp(<server>/<tool>)`. Invented glob forms —
`write_file(/path/**)`, `command(*)` — parse without complaint and match
nothing. **Do not guess a pattern; take the literal string from the refusal.**

Actions are `read_file`, `write_file`, `read_url`, `execute_url`, `command`,
`unsandboxed`, `mcp`. Precedence is **Deny > Ask > Allow**.

### Where the rules live

`~/.gemini/antigravity-cli/settings.json`, under a top-level `permissions` key.

- A project-scoped `.gemini/settings.json` in the workspace is **not** read.
- The outer `~/.gemini/settings.json` is **not** read for permissions either.
- Both were tested; only the first works.

## Configuration, and why there is no second sign-in

`agy` has no per-invocation configuration surface. Claude Code takes
`tools: []`, `mcpServers` and `settingSources` as call arguments; Grok takes
them on `session/new`. Antigravity takes rules from one global file and nowhere
else, so molt cannot pass its own for the length of a run.

The first version of this backend answered that with a private `HOME`
(`~/.config/molt/agy-home`). It worked and cost a second sign-in, which is a
strange thing to ask of someone already signed in.

**What it does instead:** molt adds its own rules to the settings file you
already use, strictly additively, and passes the part that changes every
session — the port and the bearer token of its tool server — in the
**environment**. An MCP child spawned by `agy` inherits the environment `agy`
was started with (measured: `MOLT_MCP_URL` and `MOLT_MCP_TOKEN` set on the
`agy` process arrived intact in a stdio MCP server it spawned). So the
registered command line never changes and no per-session rewrite is needed:

```
agy mcp add molt <node> <molt>/mcp-bridge.js     # once
"permissions": { "allow": ["mcp(molt/read_file)", …] }   # once, appended
```

Molt never removes a rule, never writes a `deny`, and never touches
`trustedWorkspaces`. It does not need to: **a trusted workspace does not bypass
the permission check.** A write into a trusted directory was refused exactly
like one outside it — tested, because the whole design rests on it.

What molt adds is inert without molt: `mcp(molt/read_file)` permits a call to a
server that only answers while a session is holding its port and token. When
you run `agy` yourself the bridge finds no session in its environment and
serves an empty tool list rather than failing, so molt's entry never shows up
as a broken server in your own tool list.

The one thing this gives up against the isolated home is `strictMcpConfig`:
the MCP servers your Antigravity IDE registers are in scope for a molt run.
Deny-by-default covers it — they are unusable without allow-rules of their own,
which molt does not write.

## What molt still cannot see

Less than first assumed. `read_file` is gated as well as writes: a live run had
Antigravity's own read auto-denied, and it fell back to molt's `read_file` —
correct, at the cost of one empty step. Safe shell commands (`echo hi`) are the
ones observed to run unasked.

Whatever does get through cannot change the tree, so `tree-accounted` is
unharmed — but molt's ledger may not be a complete record of what the model
*read*. `AgySession.unaccountedTools()` reports those and the session names
them on screen.
