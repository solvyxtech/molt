# molt

**A coding agent that can't say "done" without proving it.**

Every agent harness is built for a model you can trust. molt is built for any model you don't — which, on current evidence, is all of them.

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

Adoption of AI coding tools is near-universal and trust in their output is not. The mechanism is well understood and it is not deception: models emit completion language as an output pattern regardless of the actual state of the codebase. An agent writes "tests passing" while the suite has syntax errors, because it is predicting what a successful ending looks like.

**Intent is irrelevant to the cost.** Whether a model lied or was simply wrong, you shipped a false claim either way. So molt does not try to detect dishonesty — it checks the work.

Frontier models narrow this gap rather than closing it, and a rarer false completion is arguably more dangerous, because rarity is what stops you checking. See [docs/why.md](docs/why.md), which includes a table of confident wrong claims made *by the AI assistant used to build molt*, and how each was caught.

The fix is not a better model. It is a harness that refuses to accept the model's word. That pattern is already described in the harness-engineering literature and reachable today via hand-written Claude Code Stop hooks — molt makes it the default contract instead of a configuration exercise, and ties it to a record the harness itself preserved. See [docs/prior-art.md](docs/prior-art.md) for what came before and exactly what is different here.

molt is **local-first by default** — it points at Ollama on `localhost:11434` and costs nothing to run. Local models are the sharpest case: smaller context windows, weaker agentic judgement, and summarization-based compaction that is slow and poor at small parameter counts.

They are not the only case. molt works against any OpenAI-compatible endpoint — xAI, Anthropic's compatibility endpoint, OpenRouter, Groq, Mistral, vLLM, llama.cpp — and on hosted models the token efficiency, the budget stop, and tokens-per-verified-change stop being abstractions and start being invoices.

## Install

```bash
npx @solvyxtech/molt          # no install
npm i -g @solvyxtech/molt     # or keep it
```

Node 20.11+.

## Quickstart

```bash
cd your-project
molt init                     # writes .molt/done.yml
$EDITOR .molt/done.yml        # say what "done" means here
molt                          # interactive
```

Point it anywhere OpenAI-compatible:

```bash
molt --url http://localhost:11434/v1 --model qwen2.5-coder:7b
molt --url https://openrouter.ai/api/v1 --model deepseek/deepseek-r1 --key $OPENROUTER_API_KEY
```

Headless, for scripts and CI — exits non-zero when the bar is not met:

```bash
molt run "fix the failing test" --yes
molt ask "what does the bar check here?"   # a question, not a change
molt run "..." --autonomy medium           # fewer prompts, same boundaries
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
molt stats                        # false-claim rate, tokens and cost per verified change
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
| `record-intact` | Everything this project shed is still recoverable. Compares the archive against three expectations it cannot itself supply — batches shed, write records handed over, and archive filenames recorded in the hash-chained log. Delete an exuvia and this fails, naming what can no longer be proven. |
| `claims-grounded` | Every file the model names in its final answer either exists or was written here. Catches invented file references, including when the write is recorded only in the archive. |

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

## Transparency

Everything molt did is on disk, in a form you can check without trusting
molt's summary of it.

```bash
molt log        # every request, tool call, permission, and bar run
molt verify     # recompute the log's hash chain
```

### While it is running

Every step closes with one line saying what it did and what it cost:

```
· read_file  src/auth.ts  12ms
  step 2 · read_file, bash · 3.4k in (2.1k cached) · 412 out · $0.0072 · 6.2s

  checking 3 condition(s) from .molt/done.yml: types, tests, work-landed
  2 of 3 checks passed · 4.1s · failed: tests
  the failures above go back to the model; it keeps working
```

Press **shift+V** while molt is working — `ctrl+V` any time, `/verbose` as a
command, `--verbose` headlessly — to open the live view: what the model is
doing right now, the exact arguments of each call, the head of each result,
each check's command and duration, and **what every job has cost**.

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

It is a bounded panel, not an expanding scrollback: the transcript above it is
printed once and never redrawn, which is what stops a long session from
tearing itself apart in a terminal that cannot scroll backwards. Detail is
recorded whether or not the view is open, so shift+V shows what already
happened rather than starting a recording. Nothing in it is paraphrased — a
transparency view that summarizes is one more claim to check.

### How much it does without asking

**shift+A** sets the autonomy ceiling — low, medium, high. At an empty prompt
it opens a picker (nothing changes until you press enter, and esc gives the
letter back, because a terminal cannot tell `shift+A` from the `A` that starts
"Add a test"). While molt is working, or while it is asking you to approve
something — which is exactly where "stop asking me this" gets decided — the
same key cycles immediately. `ctrl+A` and `/autonomy` work from anywhere.

The level sits beside the model in the status line the whole time it is in
force.

| level | runs without asking |
|---|---|
| **low** (default) | reading a file inside the project, and nothing else |
| **medium** | reads, writes inside the project, and commands that only report |
| **high** | everything except a named list of destructive commands, or leaving the project |

The classifier is mechanical and conservative — a short allowlist of commands
whose purpose is to report, judged segment by segment, with redirection and
substitution disqualified because their effect is not readable from the text.
Anything unrecognised asks. `rm -rf`, `sudo`, `git push`, and writing outside
the project ask at *every* level, including high. A call that ran unasked is
marked `[auto]` as it happens and journalled with the level that allowed it.

It decides what molt asks about, not what is possible: a command that runs can
do anything you can. See [docs/autonomy.md](docs/autonomy.md).

### Credentials

Masked before anything is written *or* printed: the log, receipts, the
transcript on screen, and the model's own answer. Values molt holds (the session
key) are masked exactly; provider key shapes, bearer headers, JWTs, private-key
blocks and `secret =` assignments are masked by pattern, keeping the field name
so the record still says what was hidden. The permission prompt is the
deliberate exception — you cannot judge a command you cannot read.

### What a turn cost

The bottom line is the **session** meter — provider, model, tokens, price —
and it only ever climbs. Per-job figures live in the view; a job is a lens on
the session total, never a reset of it. The unit never changes either: cost is
always in dollars, because a meter that reads `0.9¢` and then `$0.029` looks
like it went down.

molt reads the price of the selected model from the endpoint that will do the
billing (xAI and OpenRouter publish theirs) and stamps it with the model it
belongs to, so a stored rate can never be applied to a different model. Token
counts come from the provider's own usage block — including cached prompt
tokens, which are billed at the cache rate rather than the full one — and
`stream_options.include_usage` is requested so that streaming, the default,
does not silently fall back to estimates. When a figure *is* an estimate it is
marked `~`; when the provider reports the dollar amount itself, that is what
is shown. `/price` says which, and sets the rate by hand for endpoints that
publish none.

The session log is append-only and hash-chained: each entry stores the SHA-256
of the one before it, so altering or deleting a line breaks every hash after it
and `molt verify` names the entry where the chain broke. That is tamper
**evidence**, not prevention — anyone with write access can rewrite and
re-chain a log. What it rules out is a silent edit.

Measured values (exit codes, byte counts, durations, provider-reported usage)
are distinguished from estimates (request size, token counts when a provider
reports none), which are marked `~` in output and `"estimated": true` in the
log. Message content is never logged — only length, a short preview, and a
digest — because an audit log is exactly the file that quietly accumulates
credentials.

Costs nothing in tokens: all of it is disk only and never enters a prompt.

See [docs/transparency.md](docs/transparency.md).

## Shedding

Context compaction in molt is **mechanical**: verbatim excerpts, no model call, no tokens, no hallucination surface. The full unabridged history is archived to `.molt/exuviae/` rather than discarded.

This is not a headline feature. It is the infrastructure the proof loop stands on — and it is load-bearing rather than decorative. Every write molt performed during shed messages travels **into** the exuvia and is dropped from memory, so the archive becomes the only place that evidence exists. Delete an exuvia and a completion check fails, naming the work that can no longer be proven.

That is what lets molt verify a claim about work from forty turns ago, or from yesterday's session. Harnesses that summarized the original away have nothing to check against.

Shedding is two-phase — the archive write happens *between* planning and committing, so a failed write can never take context with it.

`molt archive --explain` shows the digest that stays in context next to the exuvia preserved on disk, and `/regrow <pattern>` pulls archived context back in on demand with its token cost reported before it lands.

See [docs/shed.md](docs/shed.md).

## Commands

Type `/` to browse. `↑↓` chooses, `tab` fills, `enter` runs, `esc` clears —
nothing has to be typed in full or looked up.

```
/ask <question>    a question, not a change (or start a line with ?)
/autonomy [level]  how much molt does without asking  (shift+A)
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
/verbose           watch every call, argument, and result  (shift+V)
/price             what this model costs, per 1M tokens
/model <id>        switch model
/molt              cycle theme
/clear             reset the session
```

## What molt does not do

Being specific about this matters more here than anywhere else.

- **Six tools, and a reason for the count.** `list_dir` and `grep` to find things, `read_file` to read them, `edit_file` to change exact text, `write_file` for a new file or a full rewrite, `bash` for everything else. No MCP, no sub-agents, no orchestration. It was three until a session showed the cost: `ls` through bash is a *string* the autonomy classifier has to reason about, and an unfamiliar construction sends it to a prompt — so a model that could not list a directory started guessing filenames. A tool that has no write in it needs no guessing, and that is a better kind of safety than a regex over a command line. `read_file` pages through a long file (`offset`/`limit`) and says how to continue; results are capped at 16KB for a file and 8KB for command output, and truncation is always stated.
- **An edit that refuses rather than guesses.** `edit_file` replaces exact text and fails loudly if it is absent, or ambiguous without `replace_all` — a write that lands on the wrong occurrence looks exactly like a write that worked. Edits are ledgered like any other write, so `files-changed` still proves them.
- **Work that goes nowhere is stopped, not billed.** A repeated tool call that returns byte-identical output gets a pointer to the earlier result rather than the payload again, and two consecutive steps of nothing but repeats end the turn with what it spent. The bar is not re-run against state the model has not touched.
- **`files-changed` fails read-only tasks by design.** Ask a question with a leading `?` (or `/ask`, or `molt ask`) and molt runs the rest of the bar without it. molt will not decide this for you: the only party that knows whether "done" meant a change is you, and the only other candidate — asking the model whether its own claim needs proving — is precisely the decision molt exists to take away from it. If a project never verifies writes, leave the check out of your bar.
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

## Reading order

- [docs/why.md](docs/why.md) — the gap molt closes, and a worked example of confident wrong claims caught by the habits molt encodes
- [docs/done-yml.md](docs/done-yml.md) — the completion bar
- [docs/transparency.md](docs/transparency.md) — what is recorded and how to check it
- [docs/autonomy.md](docs/autonomy.md) — what runs without asking, and what never does
- [docs/receipts.md](docs/receipts.md) · [docs/shed.md](docs/shed.md) · [docs/metrics.md](docs/metrics.md)
- [docs/prior-art.md](docs/prior-art.md) — what came before, credited by name

## Name

An exuvia is not rubbish. Entomologists identify species and growth history from shed skins alone — the cast-off *is* the record. molt discards the working copy of context and keeps the shell, because the shell is the evidence.

## License

MIT © Tyler Skelton
