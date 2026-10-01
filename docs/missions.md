# Missions

Work that runs for hours, against a contract nobody can edit, with no model
deciding whether it is done.

```
molt mission plan "a CLI that turns a CSV of orders into printable labels"
# read and edit .molt/mission/contract.yml and features.json
molt mission run --yes --commit
molt mission status        # or /mission, in the terminal or the window
```

## The shape

A mission is four files in `.molt/mission/`, all of them plain text you can
read, edit, and commit.

| file | what it is | who writes it |
|---|---|---|
| `mission.md` | the goal, one paragraph | the planner, then you |
| `contract.yml` | assertions with stable ids; each is a **command** whose exit 0 establishes it, or a **note** that no command can | the planner, then you; **sealed** when the run starts |
| `features.json` | ordered features; each claims the assertions it establishes (`fulfills`), names a milestone, and may name features it comes `after` | the planner, then you; status fields by the runner |
| `state.json` | the contract's hash at seal time, each assertion's last verdict, each milestone's seal, a log | the runner only |

Plus `library/`, a folder of markdown any worker may add to, and `handoffs/`,
one JSON per worker attempt.

## The loop

1. **The coverage gate.** Every assertion with a `run` is claimed by exactly
   one feature. Every feature claims at least one assertion that can run.
   `after` is a DAG over real ids. Any problem is a sentence, and the run
   refuses to start until there are none.
2. **The seal.** The contract's hash is recorded. If the file changes at any
   later point, the run stops and says so. A contract that moves cannot judge
   the work already done against it, whoever moved it.
3. **A worker per feature.** The first pending feature whose dependencies are
   done gets a fresh session: the mission goal, the feature, its assertions
   verbatim, what earlier workers wrote in the library, and nothing else. The
   contract and the queue are pinned read-only for it. Its task criteria are
   exactly its assertions, sealed before the turn starts, so the ordinary
   proof loop is what holds it: it cannot say done until they pass, and it
   gets `--attempts` tries.
4. **The verdict is the bar's.** `verified` marks the feature done and its
   assertions passed. Anything else records which assertions failed, and the
   feature goes back in the queue, or is **blocked** after the last attempt.
   Nothing that depends on a blocked feature runs.
5. **Milestones seal.** When every feature in a milestone is done, every
   assertion in the milestone is run again, together. Passing alone is not
   passing: the feature that deleted the last one's file was verified in its
   own turn and caught here. A regressed assertion **reopens the feature that
   owns it**, with the failure named. No model is asked what went wrong.
6. **Resume is free.** Every state change is on disk before the next worker
   starts, so a killed run picks up at the next pending feature.

## What there is not

**An orchestrator model.** Factory's missions put a frontier model in a loop
with seventeen tools to decide what runs next, read each worker's handoff,
delegate a review of it to more subagents, and decide whether a milestone is
done. It is the most expensive process in their system, and it is doing a job
a loop can do. Here the orchestrator is `src/mission.ts`. It reads a queue,
starts a worker, reads a verdict the bar produced, and moves on. It costs no
tokens.

**Validators that are models.** Factory injects a "scrutiny validator" and a
"user-testing validator" at each milestone: subagents that read the work and
say whether it is good. Their CTO, on the record: when the model cannot run
something "it's going to validate this by just looking at it, and it will
fundamentally make a mistake." A milestone here is sealed by running the
assertions. If an assertion cannot be a command, it is a note, it is on every
receipt as stated intent, and it is never reported as passed.

**A validation contract written in prose.** Factory's contract is a markdown
checklist with "evidence requirements" a worker is asked to satisfy. Here an
assertion is a command or it is not an assertion. That is the whole
difference, and it is the difference between a checklist a model reads and a
gate a model cannot talk its way through.

## What the model does

Two things, and only these.

**It proposes the plan.** `molt mission plan` asks once, with the environment
brief and the project's scripts, for a mission, a contract, and a feature
list. What comes back is written to disk with the coverage gate's findings
printed beside it. You read it, you edit it, and it is not sealed until you
run it. The rule is the one the criteria drafter follows: a model may propose
a contract and must never judge against one.

**It does the work.** One feature per session, held to the assertions it
claims, with every tool molt has and every refusal molt makes. The receipt is
the record of what it claimed, what changed, and what was checked.

## Model per role

The planner and the workers can be different models, because they are
different jobs. Planning is one structured answer that a person will read;
working is a long session of tool calls held to a gate.

```
molt mission plan  --url https://api.anthropic.com/v1 --model claude-sonnet-4-5 "..."
molt mission run   --url https://openrouter.ai/api/v1 --model inception/mercury-2.5-preview --yes
```

Measured on this repository's own loop, the same verified change costs
$0.0034 on Mercury 2.5 and $0.066 on grok-4.6. The bar is what makes a cheap
worker safe to use: it cannot claim what it did not do, whichever model it is.

## The library

Workers are told: if you learn something the next worker needs, write it in
`.molt/mission/library/`. A port that must be free, a command that has to run
first, a trap. Each worker is shown the library within a token budget and
told where the rest is. It is the one thing a worker may leave behind for
another, and it is why feature forty does not repeat feature three's mistake.

## Flags

| flag | meaning |
|---|---|
| `--attempts n` | tries per feature before it is blocked (default 3) |
| `--features n` | stop after n worker runs; the next `run` continues |
| `--commit` | a verified feature becomes a commit, receipt named in the message |
| `--revert` | a feature that is not verified leaves the tree as it found it |
| `--for 20m` | wall-clock ceiling per worker turn |
| `--yes` / `--autonomy high` | required in practice: nobody is there to approve a command |
| `--force` (plan) | replace an existing mission and reset its state |

## Exit codes

`molt mission run` exits 0 when every feature is done and every milestone
sealed; 1 when it stopped with something pending or blocked; 2 when it could
not start or the contract moved.

## Writing a good contract

- An assertion is a command that exits 0 exactly when the thing is true.
  `test -f`, `grep -q`, `curl -sf`, `npm test -- <pattern>`, `python -c`.
- Name the artifact. `test -f dist/labels.pdf` is an assertion; "produces a
  PDF" is a note.
- One feature, one session's work. Ten features is typical.
- If nothing can check it, it is a note, and you are the check.
