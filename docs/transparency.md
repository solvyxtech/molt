# What molt records, and how to check it

molt makes claims: that a check passed, that a file changed, that context was
shed. Every one of those is backed by an artifact on disk that you can read
without trusting molt's summary of it.

```
.molt/
  done.yml        what "done" means here — you write this
  log/<id>.jsonl  append-only, hash-chained record of everything that happened
  receipts/       one per completion attempt, refusals included
  exuviae/        full unabridged context that left the working set
```

None of it costs tokens. All four are disk only and never enter a prompt.

## The session log

```bash
molt log            # what the model actually did
molt log --raw      # the JSONL, unmodified
molt log --json     # parsed entries
molt verify         # recompute the hash chain
```

One entry per event: session start, each user message, each request, each
response, every tool call and its result, every permission decision, every bar
run with per-check exit codes, every shed, every receipt, every error.

Example:

```
04:33:49  session 6ce0972f · ollama/qwen2.5-coder:7b · bar: 1 check(s)
04:33:49  user: fix the failing test
04:33:49  → request · 2 msgs · ~301 tok · streaming
04:33:49  ← response · 300 in / 50 out · 0 tool call(s)
04:33:49  bar FAIL 0/1 · failed: work-landed · 0ms
04:33:49  receipt refused → .molt/receipts/0000-refused.md
04:33:49  → request · 4 msgs · ~405 tok · streaming
04:33:49  ← response · 300 in / 50 out · 1 tool call(s)
04:33:49  permission granted: write_file fix.txt [autonomy low]
04:33:49  tool write_file: fix.txt
04:33:49    24 bytes
04:33:49  bar PASS 1/1 · 1ms
04:33:49  session end · bar met
```

Every line is recomputed from entries. Nothing in that output is narration.

## Watching it happen

The log answers "what did it do?" after the fact. During a turn, the same
facts are on screen.

Every step closes with one line — printed whether or not anyone asked for it,
in the TUI and headlessly:

```
  step 2 · read_file, bash · 3.4k in (2.1k cached) · 412 out · $0.0072 · 6.2s
```

Press **shift+V** while a turn is running to open the live view (`ctrl+V` any
time, `/verbose` as a command, `--verbose` headlessly):

```
── what the model is doing ─────────────────────────────  shift+V closes
  job 3 · rewrite the auth guard · 2 step(s) · 8.0k in (3.0k cached) · 45 out · $0.012 · 4.2s
  · read_file src/auth.ts  12ms
      args {"path":"src/auth.ts"}
      → 1841 bytes
      │ import { verify } from "./jwt.js";
    ↳ session 16k tokens · $0.024 · finish: tool_calls

  job 1 verified · 2 step(s) · 4.8k in · 90 out · $0.0074 · 1.2s
  job 2 not proven · 4 step(s) · 11k in · 210 out · $0.017 · 3.6s
```

Four properties make it worth trusting:

- **Verbatim.** Arguments and results are shown as they were sent and
  received, truncated but never reworded. A view that paraphrases is one more
  claim to check, and molt does not summarize with a model anywhere else.
- **Recorded regardless.** Feed lines are written whether or not the view is
  open, so shift+V reveals what already happened rather than starting a
  recording.
- **Bounded.** It is a panel of fixed height over a transcript that is printed
  once and never redrawn. A view that grows the region a terminal has to
  repaint is a view that eventually tears its own output.
- **The same facts as the log.** Nothing on screen is derived from anything
  the log does not also record — with the exception that the log stores
  digests where the screen shows content, deliberately (see below).

When a bar is narrowed for a turn — asking a question with `?` or `/ask` drops
the checks that require a file to change — the panel and the transcript both
say how many were dropped, and the receipt lists only the checks that actually
ran. A narrowed bar is stated; it is never quietly applied.

Verification is narrated the same way: the checks are named before they run,
and the result leads with the count, the duration, and what failed.

```
  checking 3 condition(s) from .molt/done.yml: types, tests, work-landed
  2 of 3 checks passed · 4.1s · failed: tests
  the failures above go back to the model; it keeps working
```

## What a turn cost

Cost is a claim like any other, so molt says where each part of it came from.

- **Token counts** come from the provider's usage block. Streaming responses
  omit that block unless it is asked for, so molt sends
  `stream_options: {include_usage: true}`; a server that rejects the field is
  retried once without it, and the resulting counts are marked as estimates.
- **Cached prompt tokens** are counted separately and billed at the cache rate
  when the provider publishes one, because they are not billed at the full
  rate by anybody.
- **Prices** are read from the endpoint that will do the billing — xAI's
  `/language-models` and OpenRouter's `/models` publish them — and stored
  against the model they belong to, so a rate can never follow a model switch.
  `/price` shows the figure and its source, and sets one by hand where nothing
  is published.
- **The dollar amount itself**, when the provider reports one (OpenRouter's
  `usage.cost`), is used instead of molt's arithmetic — but only when every
  step of the session reported one.

Two rules govern how it is shown, and they are in tension:

- **No long runs of zeros.** `$0.000024` is a number you count rather than
  read, and the meter has to be legible at a glance.
- **Never change unit.** Quoting small sums in cents made the meter read
  `0.9¢` and then `$0.029` — which looks like it went *down*. A running total
  must be comparable against its own previous value without arithmetic, so
  cost is always in dollars and only the decimals move.

A cost resting on an estimate anywhere is prefixed `~`.

The bottom line is the session meter and only ever climbs. **Per-job** figures
— what one question cost — live in the view, measured as a delta against the
session meter rather than by resetting it.

## Work that goes nowhere

A tool call that returns exactly what it returned before has taught the model
nothing, and resending that answer costs what it cost the first time. molt says
so instead:

```
· read_file  README.md  [repeat]  0ms
  that step repeated calls molt had already answered — nothing new came back
```

The result handed back is a pointer to the earlier one, not the payload. Two
consecutive steps of nothing but repeats end the turn, with what it spent
stated, and `loop_stop` in the log naming the step. A long file is read with
`offset`, and every partial result says how many lines remain and which offset
continues it — so "read it again" is never the only move available.

## Estimated versus measured

molt distinguishes the two rather than blurring them.

- **Measured:** exit codes, byte counts, durations, file hashes, message
  counts, and token usage when the provider reports it.
- **Estimated:** request size before sending, and token counts when the
  provider returns no usage block. Estimates use characters÷4 and are marked
  `~` in output and `"estimated": true` in the log.

A number without a `~` came from something molt counted. A number with one is
molt's arithmetic, and it says so.

## Who approved it

Every tool call carries the permission decision that let it through, and
whether a human was asked at all:

```
04:33:49  permission granted: write_file fix.txt [autonomy low]
04:33:50  permission granted (auto): bash grep -rn verify src/ [autonomy medium]
04:33:52  autonomy medium → high · runs everything except what cannot be undone
```

`(auto)` means autonomy allowed it without a prompt — the entry an audit most
needs to be able to find — and the level in force is recorded beside it.
Changing the level is journalled too, because a record that does not say when
the ceiling moved cannot explain why a command ran unattended. See
[autonomy.md](autonomy.md).

## The hash chain

Each entry stores the SHA-256 of the entry before it. Altering, deleting, or
inserting a line breaks every hash after that point, and `molt verify` reports
where:

```
FAIL  6ce0972f.jsonl  16 entries
      entry 4 was modified after it was written

FAIL  6ce0972f.jsonl  15 entries
      entry 9 points at a4c05a5fb88b but the previous entry hashes to
      f01a8a4e81c4 — an entry was altered or removed
```

**This is tamper evidence, not tamper prevention.** Anyone with write access
can rewrite a whole log and re-chain it. What it rules out is a *silent* edit —
changing one bar result from FAIL to pass and hoping nobody recomputes. If you
need stronger guarantees, commit the logs, or ship the final hash somewhere
molt cannot write.

## Credentials

Masked before anything is written, and before anything scrolls.

```
04:33:49  tool bash: curl -H "authorization: Bearer [redacted]" https://api.x.ai/v1/models
```

Two kinds of pattern. The **exact** kind: values molt actually holds — the
session's API key — masked with no false negatives possible. The **shape** kind:
provider key prefixes (`sk-`, `sk-ant-`, `xai-`, `gsk_`, `ghp_`, `AKIA`, …),
bearer and `x-api-key` headers, JWTs, private-key blocks, and assignments to
something named secret/token/password. The field name survives the mask, so the
record still says *what* was hidden.

It applies to the log, to receipts, to the transcript on screen, and to the
model's own final answer — because every one of those is a distribution
channel. A transcript gets pasted into a bug report; a receipt is handed to
someone who does not trust you.

**The permission prompt is the one exception**, deliberately: it shows the
command in full, because you are being asked to judge it and a redacted command
is one you cannot judge.

This is a filter with a stated shape, not a guarantee. The durable protection is
still not to paste a key into a prompt.

## What is deliberately not logged

Message content. The log records a user message's length, a 120-character
preview, and a SHA-256 prefix — not the text. Tool results are recorded by byte
count and digest, not contents.

Prompts contain credentials, customer data, and private code. A verbose audit
log is exactly the file that quietly accumulates all of it, and there is a test
asserting a secret in a prompt never reaches the log. Full content lives in
`.molt/exuviae/` when it is shed, which is a deliberate act with a visible
artifact rather than an automatic side effect.

## Reconstructing a claim

Given `molt` said a task was complete:

```bash
molt verify                          # is the record intact?
molt log | grep "bar "               # which bar runs happened, and their results
molt receipts                        # every completion attempt and verdict
molt receipts --show 0001            # the full evidence for the accepted one
rg "exit:" .molt/receipts            # every check's exit code
molt archive --grep "auth"           # anything shed out of context
```

That chain answers "why should I believe this finished?" without taking
molt's word for any step.
