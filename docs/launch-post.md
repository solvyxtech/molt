# Auto-compact is lossy compression on your work. I built the lossless version.

*Draft launch post for molt v0.5 — edit voice to taste, numbers are real.*

---

Every AI coding CLI eventually does the same thing to you. You're deep in
a session — the agent has the stack trace, the narrowed hypothesis, the
exact files — and the context window fills up. So the tool "compacts":
it asks the model to summarize your history, throws the original away,
and continues from the summary.

Users have been screaming about this for over a year. On Claude Code's
own tracker: auto-compact "causes context loss and degraded performance"
(#13112). It "triggers mid-task causing hallucinations and task
derailment," with no user control (#10948). Post-mortems describe
repeated compaction as lossy compression stacked on lossy compression
until critical information is permanently gone. The requests in those
threads are consistent: let me control when it happens, and stop
destroying my history.

Every vendor's answer has been a *better summary*. That's the wrong
axis. A summary written by a model costs tokens, can hallucinate what
happened, and replaces the source of truth with an approximation. Making
the approximation 20% better doesn't change what it is.

## The lossless version

When an arthropod outgrows its shell, it doesn't summarize the old one.
It sheds it whole, and the shed skin — the exuvia — stays intact.

molt is a tiny agent harness (~1,000 lines, 2 runtime deps, any
OpenAI-compatible endpoint) built around that idea. Its `/shed` command
is compaction with every failure mode inverted:

- **You trigger it.** Never automatic, never mid-task.
- **It's mechanical.** The digest that stays in context is deterministic
  verbatim excerpts — your requests, the results, the actions taken.
  Zero model calls, so zero tokens spent and zero hallucination surface.
- **Nothing is destroyed.** The full unabridged history is written to
  `.molt/exuviae/<timestamp>.md`. `/regrow` re-attaches it whole.
- **You see the diff:** `shed 94 messages · history 8036→6017 tok · 0
  tokens spent · full copy: .molt/exuviae/...`
- **It refuses bad sheds.** If shedding wouldn't shrink context, molt
  declines and changes nothing.

## Measured, not claimed

I don't want to add to the vibes-marketing pile, so molt ships its own
stress kit. A lab run simulating 120-turn sessions:

```
shed cycles: −25% to −75% history tokens per shed, <3ms, 0 model calls
fact audit:  120/120 seeded facts recoverable afterward — 0 lost
perf:        bom() 0.18ms avg on a 1000+ message history
```

The integration suite runs the real engine over real HTTP against an
adversarial provider: 200KB unicode payloads, missing usage fields,
non-JSON 200s, 429s/500s, sockets destroyed mid-response, tool-spam
loops. A red-team pass also produced three fixes worth stealing for any
harness: bash children get an env scrubbed of API keys (a
prompt-injected `env` can't read your key back into context), file
reads outside the working directory hit the permission gate, and bash
timeouts are enforced and reported.

## The rest of the receipt

The same philosophy — never hide, never destroy — runs through the
whole tool: `/bom` prints the context bill of materials before you
spend it; every turn ends with a token receipt; `/budget` is a hard
stop enforced inside the loop; `/wire` dumps the exact JSON of the last
request to disk; `/race modelA modelB` runs your next prompt on two
models with side-by-side receipts. Pointed at a local Ollama/llama.cpp
server — the default — the receipt reads $0.

## What it is not

molt is not a Claude Code replacement: no subagents, no MCP, no
streaming yet. If you want maximum capability, use the big tools — and
if you want maximum minimalism, Pi got there first and is excellent.
molt occupies one specific spot neither of them does: the harness where
nothing about your context is hidden, capped, or compacted without your
consent — and nothing is ever lost.

Repo: github.com/solvyxtech/molt · MIT · `npm i && npm start`
