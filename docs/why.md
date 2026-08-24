# Why molt exists

molt is built for **any model you don't fully trust** — which, on current
evidence, is all of them.

That is a broader claim than "local models are unreliable," and a more
defensible one. It is also the claim the observed record actually supports.

## The gap molt closes

An agent's confident output is not evidence that the work was done.

The mechanism is well documented and it is not deception: models emit
completion language as an output pattern, predicting what a successful ending
looks like, regardless of the state of the codebase. "Tests passing" gets
written while the suite has syntax errors. Files are described as modified
when they were only ever mentioned in a prompt.

**Intent is irrelevant to the cost.** Whether a model lied or was merely
wrong, the consequence is identical: you shipped a false claim. So molt does
not try to detect dishonesty. It checks the work.

## Frontier models do not close the gap

They narrow it. That is not the same thing, and it may be worse.

- Adoption of AI coding tools is near-universal (~84% in 2026 surveys) while
  high trust in the output sits around 3%, and the gap widens with
  experience: the more AI-generated code someone reviews, the less they
  trust it.
- The most-cited destructive incident — a production database deleted under
  an explicit freeze, ~4,000 fabricated records generated to fill the empty
  tables, success reported, the user misled about recovery — was a frontier
  model, not a small local one.
- Claude Code declaring a task complete over a failing suite is a frontier
  model behaviour. It is the reason Stop hooks exist.

A rarer false completion is more dangerous than a frequent one, because
rarity is what stops you checking.

## Where local models fit now

Local models are the **sharpest case**, not the only one:

- smaller context windows, so compaction happens constantly
- weaker agentic judgement, so tool-call reliability and false completions
  are both worse
- LLM-summarization compaction is slow, blocks the GPU already running
  inference, and produces poor summaries at small parameter counts
- supervision cost decides usability more directly than raw capability

Everything molt does helps more there. None of it only applies there.

## Where hosted models change the argument

- **Cost becomes real money.** Token efficiency, the budget stop, and
  tokens-per-verified-change stop being GPU-time abstractions.
- **Caching matters.** Shedding rewrites the context prefix and invalidates a
  provider's cached prefix; break-even is roughly five remaining turns.
- **The refusing loop costs more per task.** Three attempts means three bar
  runs and three model turns. molt spends more to produce a change you can
  trust than a harness spends producing one you cannot. Say it that way
  round, first.

## A worked example, from building molt

This project was built with an AI assistant (Claude). Over the course of
that work, the assistant made these confident, incorrect claims:

| claim | reality |
|---|---|
| "No competitor can copy deterministic compaction without rebuilding from scratch" | Claude Code already runs a deterministic microcompact pass; OpenCode prunes tool outputs |
| "Anthropic's API is not OpenAI-compatible — use OpenRouter for Claude" | There is an OpenAI-compatible endpoint at `api.anthropic.com/v1/` |
| `cancelled — the session is unchanged` (printed by molt itself) | The user turn was left in the transcript; "nearly unchanged" |
| "120/120 facts recoverable" | The test asserted bytes existed on disk, not that anything was recoverable into live context |
| Two passing tests | Both still passed with the code they covered deliberately sabotaged |

None of those were malicious. Every one would have shipped.

They were caught by the same three habits molt encodes:

1. **Run it rather than reason about it.** The token measurements, the
   startup timings, and the cache break-even were all arithmetic until they
   were executed — and two were wrong.
2. **Break your own work to check the checks.** Mutation testing found two
   tests that passed while their subject was sabotaged. A green suite that
   survives sabotage is not covering anything.
3. **Separate measured from estimated.** A number that came from counting and
   a number that came from `chars/4` are different kinds of claim and molt
   marks them differently.

This is why the README makes a behavioural claim rather than a priority
claim. "First harness to…" is falsifiable by a stranger's blog post.
"Refuses to say done without proving it" is falsifiable only by testing molt,
and it stays true.

## What molt does not claim

- **Not that a passing bar means correct code.** It means your declared
  checks ran and passed against real state. A weak bar proves little, and
  that is visibly your call, in a file you commit.
- **Not novelty.** Every ingredient exists somewhere; see
  [prior-art.md](prior-art.md).
- **Not tamper prevention.** The session log is hash-chained, which makes a
  silent edit impossible. Anyone with write access can rewrite and re-chain
  it. See [transparency.md](transparency.md).
