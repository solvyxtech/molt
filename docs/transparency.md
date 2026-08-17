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
04:33:49  permission granted: write_file fix.txt
04:33:49  tool write_file: fix.txt
04:33:49    24 bytes
04:33:49  bar PASS 1/1 · 1ms
04:33:49  session end · bar met
```

Every line is recomputed from entries. Nothing in that output is narration.

## Estimated versus measured

molt distinguishes the two rather than blurring them.

- **Measured:** exit codes, byte counts, durations, file hashes, message
  counts, and token usage when the provider reports it.
- **Estimated:** request size before sending, and token counts when the
  provider returns no usage block. Estimates use characters÷4 and are marked
  `~` in output and `"estimated": true` in the log.

A number without a `~` came from something molt counted. A number with one is
molt's arithmetic, and it says so.

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
