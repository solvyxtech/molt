# Shedding

molt compacts context **mechanically**: verbatim excerpts, no model call, no
tokens spent, no hallucination surface. The full unabridged history is archived
to `.molt/exuviae/` rather than discarded.

```
/shed
shed 24 messages · 18402 → 4106 tokens · archived 0002-2026-08-15T22-14-08-441Z.md
```

## Why it is not the headline

Deterministic pruning is not unique. Claude Code runs a microcompact pass that
clears old tool results without a model call; OpenCode prunes tool outputs
before compaction; several harnesses keep transcripts on disk.

What molt does with the preserved record is the part that matters. When a
completion claim references work from forty turns ago, molt checks the
**original**, not a summary of it. Harnesses that summarized the original away
have nothing left to check against.

Shedding is infrastructure for the proof loop. That is a stronger position than
being a headline feature, because it means the differentiator is protected by a
subsystem a competitor would have to rebuild rather than copy.

## Two-phase, on purpose

```
planShed()   →   archive.write()   →   commitShed()
  (pure)          (may throw)           (mutates)
```

The archive write happens *between* planning and committing. If the disk is
full, the directory is read-only, or the path is wrong, the write throws, the
commit never happens, and the working context is byte-identical to what it was.

"Nothing is ever lost" is only true if a failed disk write cannot take context
with it. There is a test that injects a throwing archive and asserts the
transcript is unchanged.

## What a digest keeps

The replacement left in context is excerpts, never paraphrase:

- earlier requests, capped at 300 characters each
- earlier results, capped the same way
- every tool call by name and target
- **prior digests carried through whole**, never re-excerpted

That last point is subtle and load-bearing. Re-truncating a truncation is how
context silently rots across repeated sheds: shed three times and the earliest
material becomes a truncation of a truncation of a truncation. molt merges
digests instead of nesting them, and there is a test that plants markers deep
enough that re-excerpting would drop them.

## Where it cuts

By default molt keeps the last two exchanges and sheds what came before.

A single request can produce dozens of tool calls with no user turn to cut on —
which is exactly when context runs out. In that case molt falls back to keeping
the most recent messages instead.

Either way the cut point is chosen so it never orphans a `tool` message from the
`assistant` turn that requested it. An orphaned tool result makes a payload that
OpenAI-compatible providers reject outright, which kills the session. There is a
fuzz test over 400 randomized tool-heavy transcripts asserting the wire payload
stays valid through repeated shedding.

molt also refuses to shed when the digest would cost more than the messages it
replaces. Shedding must shrink or not happen.

## The archive

```
.molt/exuviae/
  index.md                            one row per batch: when, size, first ask
  0000-2026-08-15T21-02-11-903Z.md    full unabridged messages
  0001-2026-08-15T21-44-56-118Z.md
```

Numbering continues across sessions, so the archive is a project-level record
rather than a per-session one.

## Shedding carries the evidence

Shedding does not only move messages. Every write molt performed during the
messages being shed travels with them, embedded in the exuvia as a
`molt-ledger` block: the path, the hash before the write, and the hash molt
observed after it.

After a shed, that evidence is **not** duplicated in memory. The archive is
the only place it exists.

That is what makes "verification runs against preserved history" a fact
rather than an architecture diagram. Delete an exuvia and a completion check
fails, naming what can no longer be proven:

```
FAIL  record-intact
      The session log records 7 archived batch(es), but 1 is missing from
      the archive: 0003-2026-08-17T05-25-49-549Z.md. Earlier work in this
      project can no longer be proven.
```

Evidence is partitioned by the tool call that produced it, never by a
message index — indices shift when a shed replaces a dropped prefix with a
digest, and a missed rebase silently misfiles evidence. A call id is stable
for the life of a session.

molt refuses to shed at all when no archive is configured and there is write
evidence to lose. Shedding must shrink context, never the ability to prove
what happened.

## Three expectations, none supplied by the archive

An integrity check is worthless if the thing being checked also supplies the
expectation. molt keeps three, in increasing durability:

| expectation | held by | catches |
|---|---|---|
| batches shed this session | engine memory | a lost exuvia, even one with no writes in it |
| write records handed over | engine memory | lost write evidence specifically |
| archive filenames | the hash-chained session log | a loss noticed in a *later* process, tomorrow |

The archive is per project, not per session. Reopening a project that has
shed before is normal; the archive holding *less* than was put there is not.

## Cheaper than shedding: elision

Before considering a shed, molt prunes tool results that later work made
irrelevant — a file read and then written, or a path read twice. Those
results are replaced with a one-line marker naming what superseded them.

This runs every step, costs nothing, and is strictly less disruptive than
shedding, because it does not rewrite the context prefix.

## A tension worth knowing about

Shedding rewrites the prefix of the context, and providers cache on exact
prefix match. So a shed invalidates the cache: on one sample session it cut
history from 11,480 to 2,971 tokens, but the next request then re-read those
2,971 tokens uncached.

On a caching provider, shedding mid-task can cost more than it saves. That
argues for shedding at task boundaries rather than token thresholds. molt
does not yet model this, and `/bom` reports raw savings rather than
cache-adjusted ones — treat the numbers as a floor on cost, not a ceiling on
benefit.

## Auto-shed

```bash
molt --auto-shed 24000
```

Sheds automatically once working history exceeds that many tokens. Off by
default — surprising context mutation is the exact behaviour molt exists to
avoid, so it is opt-in.
