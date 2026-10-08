# Lean guards

Maat's first product goal is lean token spend. Two guards keep a cost
regression from reaching the bill: a CI suite with hard request-size ceilings,
and a bench alarm that stops a lane on a run that costs far more than usual.
They exist because of 2026-10-07: malformed tool calls were resent in full on
every later step, and one task cost 2.68M tokens / $0.82 for a 181-byte file.
The rules they enforce are the non-regression rules in the loop charter.

## The lean-budget suite (`test/lean-budget.test.ts`)

Each scenario drives the engine with a scripted provider (no model, no
network) and measures three numbers for the turn:

- **largest**: the biggest single request body, in characters
- **total**: all request bodies of the turn added up, in characters
- **steps**: how many requests the provider received

| Scenario | Guards against | Measured (largest / total / steps) | Ceiling |
|---|---|---|---|
| a. small task: read, write, done | system prompt, tool schemas or per-step framing growing | 7,805 / 22,690 / 3 | 11,700 / 34,000 / 5 |
| b. one read of a 400 KB file | read_file paging lost; a big file sent whole or carried whole | 41,234 / 130,307 / 4 | 62,000 / 195,000 / 6 |
| c. the same 40 KB file read 8 times | the repeat pointer lost; every re-read a fresh copy | 40,732 / 115,399 / 9 | 61,000 / 173,000 / 14 |
| d. 60-step session (default auto-shed) | auto-shed not firing; requests growing every step | 259,597 / 7,262,564 / 61 | 390,000 / 10,900,000 / 92 |
| e1. 12 malformed calls, 60 KB unparseable arguments | malformed calls resent in full (PR #47); no stop after six | 12,450 / 69,197 / 7 | 18,700 / 104,000 / 11 |
| e2. 12 malformed `act` calls, 60 KB arguments (batch mode) | the same on the batch path | 9,384 / 48,455 / 7 | 14,100 / 73,000 / 11 |
| f. bash printing 1 MB | tool-result capping lost; huge output resent each step | 16,537 / 56,108 / 4 | 24,800 / 84,000 / 6 |

Measured on 2026-10-07 on the PR #47 build. The build before #47 measures e1
at 369,044 / 4,070,554 / 13 and e2 at 727,583 / 4,766,054 / 13, so those two
fail by 20-60x. Each scenario also checks that it really ran (the file, the
last step, the command's output reached the model), so a scenario that stops
early cannot pass on small numbers.

### Updating ceilings

Every run prints its measurements:

    lean-budget small largest=7805 total=22690 steps=3

To see them: `npx tsc -p tsconfig.test.json && node --test dist-test/test/lean-budget.test.js | grep lean-budget`.

- A change made a scenario cheaper: set its ceiling to about 1.5x the new
  value, and update the measured comment beside it and this table.
- A change made a scenario more expensive and fails the suite: that is the
  guard working. Fix the change. Raising a ceiling is allowed only with the
  reason in the commit message and the PR, and the new value is still 1.5x
  what was measured, never "whatever passes".
- The numbers are deterministic (scripted turns, no clock in the bodies), so
  1.5x leaves room for small prompt edits, not for noise.

## Shed and elision rules the study fixed

From the lean-sessions study (PR #50); tests in `test/lean-fixes.test.ts`.

- **Shed min-free** (`SHED_MIN_FREE` = 0.25 in `src/transcript.ts`). When
  the user turns a shed would keep are mostly Maat's own notes (acceptance
  criteria, bar refusals, nudges, all tagged in `molt`), the cut on user turns
  must free at least a quarter of the history, or `planShed` cuts on recent
  messages instead. A shed costs the whole prompt cache, and those notes are
  user messages, so the user-turn cut could land near the start of a long
  turn (a real run: 60,788 -> 60,387 tokens) or return no plan at all, step
  after step, so auto-shed never fired again. An interactive session whose
  kept turns are the person's own is cut on user turns as before.
- **Criteria and refusal survive a recent-message cut.** On a cut on recent
  messages, the latest criteria note (`molt.criteria`) and the live bar
  refusal (the latest non-stale `molt.barFailure`) stay verbatim right after
  the digest instead of being excerpted to 300 characters in it.
- **Per-call elision.** `elideSupersededReads` elides the superseded call's
  own result, not every result of its step. A bash rerun with new output
  supersedes the earlier output; the same command with different options
  (`timeout_s`, compared with keys sorted) is a different call, and a
  `background: true` run is never superseded (its result is the job handle).
  A plain `cat`/`head`/`tail`/`nl`/`sed -n` of one file (no pipe, redirect or
  second command) is a read that a later write of that file makes stale; a
  bash rerun answered with a "same call" pointer is not a new read, so the
  copy it points at stays the one a write invalidates.

The flag-gated experiments from the study (shed threshold, ageing) are not
part of this.

## The bench cost alarm (`bench/local/run.py`)

After each run, run.py reads the run's cost (`spend.costUsd`) and prompt
tokens (`spend.promptTokens`) from Maat's `job_end` event, and records the cost
in the row as `cost_usd`. The judge's spend, when `job_end` carries it
(`judge`, see transparency.md), goes in the same row beside the worker's:
`judge_calls`, `judge_tokens_in`, `judge_tokens_out`, `judge_cache_read`,
`judge_cache_write` and `judge_cost_usd` (null when the judge's model has no
price, never 0). The alarm below is on the run's whole spend: the worker's
cost plus the judge's, and the worker's prompt tokens plus the judge's, so a
runaway judge trips it too (an unpriced judge adds tokens, not dollars). When
the run had a judge, the detail shows the split, e.g. `cost $0.2800 (worker
$0.0300 + judge $0.2500) > $0.1000 ...`, and the `STOPPED` row adds
`worker_cost_usd`, `judge_cost_usd`, `worker_tokens_in` and `judge_tokens_in`;
`cost_usd` and `tokens_in` there are the totals. The lane median is over the
same totals, leaving out runs whose judge ran unpriced (a judge paid by a plan,
`judge_plan`, cost no money and counts at the worker's cost; the split reads
`judge (OpenCode plan)`): their total is only a
lower bound, and mixed with priced runs it would pull the limit down unseen.
Such a run's own alarm still uses that lower bound. The run trips the alarm when:

- its cost exceeds **max(5x the lane's running median cost, $0.10)**. The
  median is over the lane's earlier runs that reported a cost (resumed rows
  included; each paired arm is its own lane). With no earlier runs, the limit
  is $0.10. A run with no cost (an unpriced model) is judged on tokens only.
- or its prompt tokens exceed **1,500,000**.

On an alarm the offending run's row is written as usual, then a `STOPPED` row:

    {"stopped": true, "reason": "cost alarm", "run": "<tag>", "log": "<path>",
     "detail": "...", "cost_usd": ..., "tokens_in": ..., "lane_median_usd": ...,
     "limit_usd": ..., "limit_tokens": ...}

run.py prints `STOPPED: cost alarm on <tag>: <detail>` and the log path, and
exits with code 3. The marker has no `task`/`passed`: resume and the scoreboard
skip it. Resuming the lane after a look runs the remaining tasks.

| Env | Default | Meaning |
|---|---|---|
| `BENCH_COST_ALARM_X` | 5 | multiple of the lane's running median cost |
| `BENCH_COST_ALARM_USD` | 0.10 | dollar floor for the cost limit |
| `BENCH_TOKEN_ALARM` | 1500000 | prompt-token limit for one run |

Tests: `python3 -m pytest bench/local/tests` (`test_cost_alarm.py`).
