# molt

**A coding agent that can't say "done" without proving it.**

Every agent harness is built for a model you can trust. molt is built for one you can't.

When the model stops calling tools and says the task is complete, molt treats that as a *claim*, not a result. It runs the checks in your project's `.molt/done.yml`. If any fail, the claim is refused, the real failure output goes back to the model, and the loop continues. The model does not decide when it is finished.

```
› fix the failing auth test

· read_file  src/auth.ts
· bash       npm test

checking 3 condition(s) from .molt/done.yml
  FAIL  tests (exit 1)
        1 failing: token refresh returns undefined
  pass  work-landed
  pass  record-intact
completion refused (attempt 1) — continuing

· write_file  src/auth.ts
· bash        npm test

checking 3 condition(s) from .molt/done.yml
  pass  tests
  pass  work-landed
  pass  record-intact
bar met

Fixed the refresh path — it was returning before the await.
```

---

## Why this exists

Adoption of AI coding tools is near-universal and trust in their output is not. The mechanism is well understood: models emit completion language as an output pattern regardless of the actual state of the codebase. An agent writes "tests passing" while the suite has syntax errors, because it is predicting what a successful ending looks like.

The fix is not a better model. It is a harness that refuses to accept the model's word. That pattern is already described in the harness-engineering literature and reachable today via hand-written Claude Code Stop hooks — molt makes it the default contract instead of a configuration exercise, and ties it to a record the harness itself preserved. See [docs/prior-art.md](docs/prior-art.md) for what came before and exactly what is different here.

molt is **local-first**. It defaults to Ollama on `localhost:11434`, costs nothing to run, and is aimed at people driving open-weight models on their own hardware — where models lie more, context windows are smaller, and supervision cost is the metric that decides whether a tool is usable.

## Install

```bash
npx @solvyx/molt              # no install
npm i -g @solvyx/molt         # or keep it
```

Node 20.11+.

## Quickstart

```bash
cd your-project
molt init                     # writes .molt/done.yml
$EDITOR .molt/done.yml        # say what "done" means here
molt                          # interactive
```

On first run, `/login` picks a provider and takes its key; `/model` then lists
what those keys can reach, grouped by provider. Both are remembered, so later
runs start where you left off.

```
› /model
models across your keys:

  xai
     grok-4.6
     grok-4
  anthropic
   ▸ claude-opus-5
     claude-sonnet-5
   ↑↓ choose · enter select · esc cancel
```

Both pickers are driven by the arrow keys — nothing to type, no numbers to
read off. Provider headers are not selectable; the highlight steps over
them.

Cost appears beside the token count once molt knows what the tokens cost —
set `priceIn` / `priceOut` (USD per 1M tokens) in `~/.config/molt/config.json`,
or pass `--price-in` / `--price-out`. Without pricing the cost is omitted
rather than guessed.

Keys are written to `~/.config/molt/auth.json` at 0600 — outside the repo, so
a tool whose whole pitch is an auditable record never commits a credential to
one. Presets cover ollama, openrouter, anthropic, openai, xai, and groq; any
other OpenAI-compatible endpoint works with flags:

```bash
molt --url https://api.openrouter.ai/api/v1 --model deepseek/deepseek-r1 --key $OPENROUTER_API_KEY
```

Headless, for scripts and CI — exits non-zero when the bar is not met:

```bash
molt run "fix the failing test" --yes
molt prove                    # run the checks now, without the model
molt run "..." --json         # machine-readable event stream
molt prove --skip slow        # tag selection, for the inner loop
```

Inspect what happened:

```bash
molt receipts                     # every completion attempt and its verdict
molt receipts --grep "tests"      # jump to the evidence behind a claim
molt archive                      # shed batches, browsable
molt archive --grep "auth token"  # find something that left context
molt archive --explain            # digest vs original, side by side
molt stats                        # false-claim rate, tokens per verified change
```

## The bar

`.molt/done.yml` is a committed, versioned artifact. Ordinary shell commands, plus builtins that only molt can run because only molt still holds the full session record.

```yaml
version: 1

checks:
  - name: types
    run: npm run typecheck

  - name: tests
    run: npm test
    timeout: 300

  - name: work-landed
    builtin: files-changed
    tags: [fast]

  - name: record-intact
    builtin: record-intact
    tags: [fast]
```

Tags are optional selection labels — `fast`, `slow`, `ci`, `local`, `manual` are the conventional set. Every check runs on every completion attempt, so a five-minute suite across four attempts is twenty minutes of inner loop. `--only` and `--skip` let slow checks live in the file for CI without being paid for locally. An untagged check always runs, so omitting a tag can never quietly remove a condition.

| builtin | what it proves |
|---|---|
| `files-changed` | At least one file was actually modified, and every write molt performed is still on disk byte-for-byte. Catches work that was never done, reverted, or rewritten with identical contents. |
| `record-intact` | The shed archive is complete and readable, so the evidence behind any result can be audited later. |

**The bar cannot be lowered by the work being judged against it.** molt fingerprints `done.yml` at session start and compares before every run. An agent that edits it to make checks pass fails a check called `bar-unmodified`. Instructions are a hope; this is a control.

See [docs/done-yml.md](docs/done-yml.md).

## Receipts

Every completion attempt writes `.molt/receipts/NNNN-<verdict>.md` — including refusals. The claim, each check, the command, the exit code, and the real output.

Refusals are the interesting record. Keeping only the successes would leave exactly the shape of evidence nobody should trust.

`molt stats` turns the receipt index into two numbers:

```
false-claim rate            50.0%   share of claims that did not survive the bar
tokens per verified change   1050
```

The denominator on that second one matters and molt prints the caveat itself. A harness that accepts a false claim on turn one spends fewer tokens per *claim* and produces a change you cannot trust. molt spends more to produce a change you can. False-claim rate is a property of the model as much as the harness — compare only at matched models.

See [docs/receipts.md](docs/receipts.md) and [docs/metrics.md](docs/metrics.md).

## Shedding

Context compaction in molt is **mechanical**: verbatim excerpts, no model call, no tokens, no hallucination surface. The full unabridged history is archived to `.molt/exuviae/` rather than discarded.

This is not a headline feature. It is the infrastructure the proof loop stands on: when a completion claim references work from forty turns ago, molt checks the preserved record instead of a summary of it. Harnesses that summarize the original away have nothing to check against.

Shedding is two-phase — the archive write happens *between* planning and committing, so a failed write can never take context with it.

`molt archive --explain` shows the digest that stays in context next to the exuvia preserved on disk, and `/regrow <pattern>` pulls archived context back in on demand with its token cost reported before it lands.

See [docs/shed.md](docs/shed.md).

## Commands

Type `/` to browse. `↑↓` chooses, `tab` fills, `enter` runs, `esc` clears —
nothing has to be typed in full or looked up.

```
/prove             run the bar now, without the model
/bar               show the current bar
/init              write a starter .molt/done.yml
/shed              compact context; the full record is archived
/shed --explain    digest and original, side by side
/regrow <pattern>  pull archived context back in by search
/archive [pattern] list or search shed batches
/receipts          completion attempts and verdicts
/stats             false-claim rate, tokens per verified change
/bom               context bill of materials
/wire              exact JSON of the last request
/budget <n|off>    hard token ceiling
/login [provider]  add a provider key
/model [id]        browse models across your keys, or switch by id
/molt              cycle theme
/clear             reset the session
```

## What molt does not do

Being specific about this matters more here than anywhere else.

- **Three tools** — read, write, bash. Everything else is shell. No MCP, no sub-agents, no orchestration.
- **`files-changed` fails read-only tasks by design.** If a task legitimately changes nothing, leave that check out of your bar.
- **A passing bar is not proof of correctness.** It proves your declared checks ran and passed against real state. A weak bar proves little — that is your call to make, visibly, in a file you commit.
- **Not benchmarked against other harnesses yet.** `rnd/grade.mjs` runs scenarios with hidden graders against any agent CLI, and molt scores 4/4 on its own four scenarios — which is worth exactly what a self-run benchmark is worth. Four scenarios supports "harnesses differ measurably", not a ranking. Adapters and scenarios from people who are not me are the thing that makes those numbers mean anything.
- **No novelty claim.** Every ingredient here exists somewhere else; see [docs/prior-art.md](docs/prior-art.md). What molt claims is behavioural and testable: it refuses to say done without proving it.

## Development

```bash
npm install
npm run check              # typecheck + full test suite
./rnd/demo.sh              # four scripted model personalities, graded
node rnd/grade.mjs         # the harness-agnostic grader
node rnd/grade.mjs --list  # what it measures
```

The test suite includes a 400-transcript fuzz asserting that shedding never produces a request payload a provider would reject, and mutation-tested coverage of the proof gate. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Name

An exuvia is not rubbish. Entomologists identify species and growth history from shed skins alone — the cast-off *is* the record. molt discards the working copy of context and keeps the shell, because the shell is the evidence.

## License

MIT © Tyler Skelton
