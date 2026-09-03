# molt

**A coding agent that can't say "done" without proving it.**

[![check](https://github.com/solvyxtech/molt/actions/workflows/check.yml/badge.svg)](https://github.com/solvyxtech/molt/actions/workflows/check.yml)
[![licence: Apache 2.0](https://img.shields.io/badge/licence-Apache%202.0-blue.svg)](LICENSE)

molt runs any OpenAI-compatible model (and Anthropic's native API) as a coding
agent, then refuses to accept "done" until every check in your project's
`.molt/done.yml` passes against the real state on disk. A completion is a
claim; molt checks the claim and writes a receipt either way.

<p align="center">
  <img src="docs/images/accepted.png" alt="molt fixing a defect in its own source and passing all eleven checks" width="900">
</p>

<p align="center"><em>molt, working on molt: a real defect in its own source,
fixed, with a test added to pin the boundary — then eleven checks run against
the disk, including one that breaks each changed line to confirm a test
notices. This claim took two attempts; the refused one is on file beside it.</em></p>

## What it does

| | |
|---|---|
| **Refuses unproven claims** | A final answer is a claim, not a result. It runs the bar; any failing check goes back to the model with its real output. After N attempts molt reports failure, never success. |
| **Judges the disk, not the transcript** | Every write is ledgered with before/after hashes. A file that changed on disk that no tool wrote, a comment-only edit, a deleted assertion, an added line no test executes, a line no test would notice broken: each is its own check. |
| **Keeps the evidence** | One receipt per attempt, refusals included. A hash-chained journal of every call. Context that is compacted is archived verbatim, never summarised. `molt verify` recomputes all of it. |
| **Says what it knows** | Token counts and prices come from the provider; anything estimated is marked `~`. A reused check result is marked reused. An unverified answer is called unverified. |
| **Works with any model** | OpenAI, xAI, OpenRouter, Groq, Mistral, Ollama, llama.cpp, vLLM, Anthropic. Prompt caching where the provider supports it. |
| **Same engine, two surfaces** | A terminal UI and a desktop window share `src/` unmodified. A proof from either is the same proof. |

## The loop

```
you ask  →  the model works  →  it says "done"
                                     │
                     .molt/done.yml runs against the disk
                                     │
              ┌──────────────────────┴──────────────────────┐
         every check passed                          something failed
              │                                             │
      receipt: accepted                    the failures go back to the model,
      (and the answer)                     with their real output — it keeps
                                           working, up to N attempts, then
                                           molt reports failure
```

Either way a receipt is written, the journal is appended, and both are
hash-chained.

## Quick start

```sh
npm install
npm run app            # the desktop window
npm start              # the terminal UI (node dist/cli.js)
```

First run: `/login`, pick a provider, paste a key, `/model`, go. Keys live in
`~/.config/molt/auth.json` at mode 0600.

Or use a Claude Pro/Max plan instead of a key — `/login` → **claude code (your
Pro/Max plan)** in the terminal, **Settings → Model → "Use my Claude plan"** in
the window, or `--url claude-code` headless. molt runs the Claude Code you
already logged in and never sees the credential; Claude Code is given none of
its own tools, so every write still lands in molt's ledger and the bar can
still refuse the claim. A plan is not a bill, so the meter shows tokens and no
money.

Headless, for CI or a script:

```sh
molt init                                   # writes .molt/done.yml from your package scripts
molt run "make fmtDuration read hours" --yes --attempts 3
molt run "fix the failing test" --criterion "gate=npm test -- fmtDuration"
molt ask "what does the bar check?"         # a question: write checks are not applied
molt prove                                  # run the bar now, no model
molt verify                                 # recompute every hash chain
```

Exit code is non-zero when the bar is not met.

## The bar

`.molt/done.yml` is a list of shell commands and molt builtins. This
repository's own, abridged:

```yaml
version: 1
checks:
  - name: types
    run: npm run typecheck
    watch: ["src/**", "test/**", "electron/**", "ui/**"]   # reuse the result while none of this moved
  - name: tests
    run: npm test
  - name: work-landed
    builtin: files-changed      # something changed, and every write is still on disk byte-for-byte
  - name: work-accounted
    builtin: tree-accounted     # nothing changed on disk that a tool did not write
  - name: spec-intact
    builtin: spec-intact        # no assertion was deleted from a test, by any route
  - name: work-proven
    builtin: diff-covered       # every added line is executed by the suite
    lcov: coverage/lcov.info
  - name: work-checked
    builtin: mutation           # break each added line; the suite must go red
    run: npm test
    sample: 3
```

Per-task criteria are sealed before the work starts, from the window's
criteria panel or `--criterion` on the command line, and appear on the receipt
as `task:<name>`. Editing `done.yml` mid-session is itself a failing check.

## What a refusal looks like

The same task, an earlier run. The model fixed the failing test and said the
existing test already covered it, so `work-checked` broke the line it had just
written and showed that nothing noticed. Ten of eleven, refused — twice the
same way, after which molt stopped rather than spend more:

<p align="center">
  <img src="docs/images/refused.png" alt="molt refusing an attempt: ten of eleven checks pass, the mutation check fails" width="900">
</p>

The same refusal in the terminal:

```
bar not met — 10 of 11 checks
FAIL  work-checked
      1 of 1 mutation(s) changed the code and nothing failed:
        src/session-commands.ts:64 (< to <=) — if (ms < 1000) return `${Math.round(ms)}ms`;

      Those lines run but nothing checks what they do. A test that executes
      code without asserting on it leaves the code exactly as unproven as no
      test at all.

the bar failed in exactly the same way twice, on: `work-checked`. Continuing
would spend more tokens on a check the work is not moving — either the work
cannot satisfy it, or the check is wrong about the work.
```

A different route, refused by a different check. The model was told to make
the change with `sed` and claim:

```
checking 10 condition(s) from .molt/done.yml: types, tests, app-boots, app-drives, work-landed, …
8 of 10 checks passed · 28s
pass  types (exit 0)      —  `npm run typecheck` exited 0 in 1510ms
pass  tests (exit 0)      —  `npm test` exited 0 in 23395ms
FAIL  work-landed
      No file was modified in this session. Nothing was done that can be shown.
FAIL  work-accounted
      1 file(s) changed on disk this turn that no tool call wrote:
        src/session-commands.ts (changed)
      A change made through bash — a script, sed, cp, a generator — has no entry in the
      write ledger, so nothing here can prove what it did or judge it.
pass  spec-intact         —  no test file was changed

bar NOT met
molt: bar not met after 1 attempts. molt is reporting failure rather than success.
```

## What a receipt looks like

`.molt/receipts/0050-accepted.md`, from a run with one task criterion:

```
# molt receipt 0050 — accepted

molt accepted this claim: every check that can block a completion passed.

| check                 | verdict | what it established                                              |
| tests                 | pass    | `npm test` exited 0 in 23312ms                                   |
| work-landed           | pass    | 2 file(s) modified and verified byte-for-byte on disk            |
| work-accounted        | pass    | 2 file(s) changed on disk this turn, every one written through a tool |
| spec-intact           | pass    | no test file was changed                                         |
| work-proven           | pass    | 1 changed file(s) executed by the tests                          |
| task:fmtbytes-checked | pass    | `node -e "…fmtBytes(12)…"` exited 0 in 28ms                       |
```

Below the table, every check's full output; below that, provider, model,
tokens and cost. `molt stats` reports the false-claim rate and cost per
verified change over all of them, and says what it does not count.

## The desktop

<p align="center">
  <img src="docs/images/receipts.png" alt="Receipts tab" width="440">
  <img src="docs/images/log.png" alt="Log tab" width="440">
</p>
<p align="center">
  <img src="docs/images/view.png" alt="View tab: every byte to and from the model" width="440">
  <img src="docs/images/picker.png" alt="Model picker across every endpoint you hold a key for" width="440">
</p>

| tab | holds |
|---|---|
| **Session** | narration, tool calls, the bar's verdict, receipt links; the bar itself as a spine beside the work |
| **View** | every byte to and from the model, in order |
| **Receipts** | the evidence trail, rendered, with a "verify evidence chain" button |
| **Log** | the hash-chained journal for the session, filterable |
| **Settings** | workspace, model, endpoint, keys, autonomy, theme |

<p align="center">
  <img src="docs/images/palette.png" alt="The command palette, on /" width="900">
</p>

## Verifying the record

```sh
$ molt verify
ok    cc9e4d49.jsonl  58 entries
…
87 log(s) verified. Each entry hashes its predecessor, so any
alteration or deletion breaks the chain from that point on.
integrity chain    ok  7 record(s)
                   47 artifact(s) on disk are not bound by it

root of trust: 325c6dab064f3891a533862df29e312715f0c76bf71432e971573f6415ba5f55
```

The integrity ledger binds journals, receipts and archived context into one
chain. Its head is the one value to keep somewhere molt cannot write. This is
tamper evidence, not tamper prevention; the docs say so in the same words.

## Development

```sh
npm run check        # typecheck · 1,100+ tests · e2e turn against a stub provider · window self-check
npm run self-check   # boots the real window and asks the page whether it wired up
npm run e2e          # a real turn end to end, DOM read back
npm run dist:mac     # unsigned .dmg; also dist:win, dist:linux
```

molt holds itself to its own bar: an agent working on this repository must
leave the types clean, the suite green, every added line covered, and every
sampled line mutation-killed before it may say it finished.

Layout: `src/` the engine (shared, unmodified), `electron/` the main process
and preload bridge, `ui/` one HTML file, one stylesheet, one renderer,
`test/` the suite, `finetune/` a dataset extractor and training recipe for a
small model that predicts the bar's verdict, `docs/` the design notes.

## Docs

- [why.md](docs/why.md) — the failure this exists for
- [done-yml.md](docs/done-yml.md) — the bar, every builtin, `watch`, advisory checks
- [commandments.md](docs/commandments.md) — rules, each traced to the run that produced it, sorted by how they are enforced
- [transparency.md](docs/transparency.md) — the journal, receipts, cost accounting, the integrity chain
- [shed.md](docs/shed.md) — mechanical context compaction and the archive
- [autonomy.md](docs/autonomy.md) — what runs without asking, and what never does
- [testing-charter.md](docs/testing-charter.md) — how to find bugs in molt
- [audit-2026-09-02.md](docs/audit-2026-09-02.md) — the latest audit, live-model evidence, open decisions
- [prior-art.md](docs/prior-art.md), [receipts.md](docs/receipts.md), [metrics.md](docs/metrics.md)

## Security posture

`contextIsolation` on, `nodeIntegration` off, a named preload bridge and
nothing else. Model output is rendered with `textContent`, never `innerHTML`.
Provider keys are masked before anything is written or scrolled. Autonomy
levels decide what molt asks about; they are not a sandbox, and the docs are
explicit about the list.

## Status

Early and moving. The macOS build is unsigned. Apache 2.0 licence.
