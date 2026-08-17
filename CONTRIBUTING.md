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
npm run check          # typecheck + full suite
./rnd/demo.sh          # four scripted model personalities, graded
```

Node 20.11+. No global tooling required.

## The test suite

| file | covers |
|---|---|
| `test/proof-loop.test.ts` | the gate: refusal, retry, exhaustion, receipts |
| `test/bar.test.ts` | `done.yml` parsing, builtins, tamper detection |
| `test/transcript.test.ts` | shed planning, digest merging, round-trip recovery |
| `test/wire-validity.test.ts` | 400-transcript fuzz: payloads stay provider-valid |
| `test/integration.test.ts` | end-to-end over a real socket |

`rnd/mock-provider.mjs` is an OpenAI-compatible server that lies on a script.
Use it rather than a real provider — deterministic, free, and instant.

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

## Style

TypeScript, strict, ESM. Comments explain *why*, not *what* — if a line needs a
comment restating it, rewrite the line. No React or Ink imports in any module
carrying proof logic; the whole verification path must be testable without
mounting a terminal.

## Reporting a false accept

The most valuable bug report for this project is a case where molt accepted a
completion it should have refused. Include the bar, the scenario, and ideally a
`rnd/mock-provider.mjs` script that reproduces it. Those go to the front of the
queue.
