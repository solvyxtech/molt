# Prior art

molt is not the first tool to notice that agents declare victory too early,
and it does not invent the ideas it combines. This page names what came
before, accurately, because a project whose entire pitch is refusing to
overclaim cannot start by overclaiming.

If something here is described wrongly, that is a bug — please file it.

## Completion gates

**Claude Code hooks.** A `Stop` hook exiting 2 blocks the end of a turn and
returns stderr to the model, which then keeps working. This is a real,
shipped, general mechanism, and it can enforce a test gate today. It is
opt-in: you write the script, wire it into `settings.json`, and handle
loop-safety via `stop_hook_active` yourself.

molt's difference is *default*, not *capability*. If you already run a Stop
hook that gates on your suite, you have most of what molt's proof loop does.

**Harness-engineering literature.** The pattern — termination criteria owned
by the harness, verification/validation dual gates, planner/generator/evaluator
splits — is well described in 2026 writing on agent harnesses. molt is an
implementation of an idea the field had already articulated.

**Bolt-on verifiers.** ProofShot records video evidence for UI work.
Orchestrators like swarm runners verify each step against an isolated git
branch. Agent-forensics suites sign and replay runs. These are agent-agnostic
by design, which is their strength and their ceiling: they observe from outside
and cannot reach a case where the evidence was destroyed by compaction.

## Context compaction

**Claude Code microcompact.** A deterministic pass that clears old tool
results before the expensive summarization tier. No model call. molt's
`shed` is not the first mechanical compaction in a coding agent.

**OpenCode.** Prunes old tool outputs before full compaction.

**Transcript archives.** Claude Code writes session transcripts to disk, and
`/rewind` offers checkpoint-scoped summarization. Keeping the original around
is not novel either.

**Server-side compaction.** Anthropic's API offers automatic summarization at
a token threshold.

## Closing the loop

**karpathy/autoresearch.** Wraps a coding agent in a loop with four moving
parts: edit one file, run for a fixed five minutes of wall clock, read one
immutable scalar from a read-only scorer, then `git commit` if it improved and
`git reset` if it did not — and repeat, forever, without asking. Its power is
not the judge, which is a single number; it is that the loop is *closed*. The
agent cannot keep a change the judge did not like.

molt had the judge and not the closing. A passing turn and a failing turn both
left the same dirty tree. Three things here come straight from that design:

- `--for 5m` / `/for` — a wall-clock ceiling for a turn. molt already had
  ceilings in tokens and in money; those measure what a turn *consumes*, and
  this measures what it costs the person waiting for it.
- `--commit` / `/commit on` — a turn that meets the bar becomes a commit, with
  the receipt named in the message.
- `--revert` / `/revert on` — a turn that does not meet the bar leaves the tree
  as it found it.

Two deliberate differences. autoresearch hill-climbs one number, which works
because in its domain "better" is a scalar; molt's bar is a composite pass/fail
because general software changes do not reduce to one. And autoresearch's
`git reset` throws away the whole tree, which is safe when the agent owns the
repository and unacceptable when a person is working in it — so molt reverts
only the paths the turn wrote, restores them from a pre-turn snapshot rather
than from HEAD, and refuses to delete a file git never had a copy of.

## Aider

**aider** (Paul Gauthier and contributors) is the most-copied design in this
category, and three of its ideas are here:

- **The repository map.** aider builds a tree-sitter parse of the repo and
  ranks it with PageRank over symbol references, then spends a token budget on
  the most connected files. `src/repomap.ts` does the same job with regex
  declaration-scraping and a much cruder rank — "how many other files mention
  what this one defines" — and says so in the map's own header. The idea, and
  the insight that it belongs in the cached prefix, are aider's.
- **Auto-commit, and `/undo`.** aider commits each AI change with a generated
  message and can undo it. molt commits only what the bar verified, and does
  not need a model to write the message because the receipt already says what
  was checked. molt's `/undo` differs on purpose: aider's runs `git reset
  --hard`, molt's runs `--mixed`, so the commit goes and the work stays.
- **Read-only files.** aider's `/read-only` adds a file to the context that the
  model may not edit. molt's `/read` pins the same way and enforces it at the
  tool boundary — `write_file` and `edit_file` refuse the path outright, rather
  than the model being asked nicely.

What is not taken from aider: its edit formats (whole-file, unified-diff,
search/replace blocks — molt has one write tool and one edit tool and a guard
that refuses a diff pasted into either), its architect/editor two-model split,
and its voice and watch-file modes.

## What molt does differently

Not "first" — different, and specifically:

1. **The bar is a committed file, not a hook script.** `.molt/done.yml` is
   versioned, reviewable, and portable in principle across harnesses. A hook
   is code in one tool's config format.

2. **The gate is the default contract.** No configuration required for the
   refusal loop to exist. A project without a bar is warned on every launch.

3. **Verification reads from a record the same harness preserved.** This is
   the piece that is not a bolt-on. When a claim references work from forty
   turns ago, molt checks the original, because `shed` archived it and
   `record-intact` proves the archive is whole. A harness that summarized the
   original away has nothing to check against, and an external verifier does
   not own the context to begin with.

4. **The bar cannot be lowered by the work being judged against it.** The
   fingerprint check turns an instruction into a control.

5. **Trustworthiness is measured, not asserted.** `molt stats` reports
   false-claim rate and tokens per verified change from the receipt index,
   and `rnd/grade.mjs` runs the same scenarios against any harness.

That combination is what molt is. Each ingredient exists somewhere; the
bundle is a product position, not a moat. The durable part is (3), because
it requires owning both compaction and verification in one harness.

## Why the gap might exist

Worth saying plainly, because it explains more than "nobody thought of it":

A harness that refuses to declare victory produces slower demos, lower
apparent completion rates, and worse benchmark numbers. A vendor whose growth
metric is tasks completed has no reason to ship the thing that makes that
number honest.

That is a structural gap rather than a technical one — which is the only kind
a small project can hold.
