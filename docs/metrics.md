# Measuring trustworthiness

molt records what happened and computes two numbers from it. Both need their
denominators said out loud, because both are easy to quote misleadingly.

```
molt stats
molt stats --json
```

## False-claim rate

The share of completion claims that did not survive the bar.

```
false-claim rate  50.0%   (share of claims that did not survive the bar)
```

**This is a property of the model as much as the harness.** A weak local model
lies more; a frontier model lies less. Comparing harnesses on this number is
only meaningful at a matched model, and molt says so in its own output.

It is also a property of your bar. A bar of `run: true` produces a 0%
false-claim rate and proves nothing.

## Tokens per verified change

Total session tokens divided by *accepted* completions.

```
tokens per verified change  1050
```

The denominator is the whole point. A harness that accepts a false claim on
turn one spends fewer tokens per *claim* and produces a change you cannot
trust. molt's refusing loop costs more: three attempts means three bar runs
and three model turns.

State it that way round, first, before anyone else does:

> molt spends more to produce a change you can trust than others spend to
> produce one you can't.

Quoting molt's token count without the denominator is the obvious hostile
reading, and it is a fair one if the denominator is buried.

## Grading harnesses

`rnd/grade.mjs` runs scenarios with hidden graders against any agent CLI. It
lives in the terminal repository (`molt`), not in this one — nothing under
`rnd/` ships with the desktop.

```bash
node rnd/grade.mjs --list
node rnd/grade.mjs --harness molt
node rnd/grade.mjs --harness "some-agent --print" --label some-agent --json
```

Each scenario pairs a scripted model personality with a grader that inspects
the workspace afterward — never the agent's own report. A harness passes only
when its exit code and the workspace state both match what actually happened.
Refusing correct work counts as a miss, so a harness cannot score well by
refusing everything.

### What this can and cannot support

**Can:** "harnesses differ measurably in false-completion rate at a matched
model." That is the claim that matters, and it is the one that survives
scrutiny at small N.

**Cannot:** a ranking. Four scenarios is not a benchmark.

### Confounds to report, not hide

- **Configuration asymmetry.** molt ships a bar by default; other harnesses
  need one wired up. Report out-of-the-box and configured as separate columns
  and say which is which. Comparing raw defaults measures defaults.
- **Model held fixed.** Never aggregate across models.
- **Adapter quality.** `commandFor()` in the grader knows molt natively and
  invokes anything else generically. A bad adapter produces a bad score, and
  that is the grader's fault rather than the harness's. Adapter PRs welcome.

If you publish numbers from this, publish the adapter you used.
