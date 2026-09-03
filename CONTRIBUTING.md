# Contributing to molt

molt's entire value is that it does not take a claim on faith. That standard
applies to the code as much as to the agent.

## The filter

Before proposing a change, check it against this:

> Does it make molt harder to lie to, or easier for a stranger to reach?

If neither, it probably does not belong here. molt has three tools, a handful
of commands, and one idea. Most feature requests dilute the idea rather than
extend it — MCP support, sub-agents, orchestration, and additional providers
are explicit non-goals for now.

## Getting set up

```bash
npm install
npm run check          # typecheck · suite · e2e turn · window self-check
npm run app            # the desktop window
npm start              # the terminal UI
```

Node 22+. No global tooling required. `npm run check` is what the project's
own bar runs, so a change that passes it is a change molt would accept.

## The test suite

| file | covers |
|---|---|
| `test/proof-loop.test.ts` | the gate: refusal, retry, exhaustion, receipts |
| `test/bar.test.ts` | `done.yml` parsing, builtins, tamper detection |
| `test/tree-accounted.test.ts` | the disk against the ledger; assertions removed by any route |
| `test/record-scope.test.ts` | what a turn is judged on, and what a cancel does |
| `test/integrity.test.ts` | the cross-linked evidence chain and its root of trust |
| `test/archive-verification.test.ts` | write evidence surviving compaction |
| `test/transcript.test.ts` | shed planning, digest merging, round-trip recovery |
| `test/wire-validity.test.ts` | 400-transcript fuzz: payloads stay provider-valid |
| `test/desktop-shell.test.ts` | the window's own logic, without an Electron process |

`scriptedProvider` in `test/helpers.ts` replays assistant turns from a script,
and `test-e2e/drive.mjs` stands up an OpenAI-compatible stub server for the
window. Use those rather than a real provider — deterministic, free, instant.

## Rules for changes

**Anything touching the proof gate, the bar, or shedding needs a test that
fails without your change.** Write the failing test first and say so in the PR.

**Mutation-test your own work.** Break the thing you just fixed and confirm a
test catches it. A green suite that stays green when you sabotage the code is
not covering the code. This has already caught one hollow test in this repo.

**Never let a defect degrade quietly.** A malformed `done.yml` throws rather
than falling back to "no checks". A failed archive write aborts the shed rather
than losing context. When you are choosing between crashing and silently doing
less than promised, crash.

**Shedding must only ever shrink, and never lose.** If a change to
`planShed`/`commitShed` cannot be shown to preserve the full record and produce
a provider-valid payload, it does not land.

## Licensing

molt is Apache 2.0. Contributions are accepted under the same terms —
section 5 of the licence says so, so there is no separate agreement to sign.
If you paste in code you did not write, say where it came from and under what
licence, in the pull request rather than in a comment.

## Style

TypeScript, strict, ESM. Comments explain *why*, not *what* — if a line needs a
comment restating it, rewrite the line. No React or Ink imports in any module
carrying proof logic; the whole verification path must be testable without
mounting a terminal.

## Reporting a false accept

The most valuable bug report for this project is a case where molt accepted a
completion it should have refused. Include the bar, the scenario, and ideally a
scripted-provider test that reproduces it. Those go to the front of the
queue.
