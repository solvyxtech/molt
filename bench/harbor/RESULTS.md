# Terminal-Bench 2.0 runs

Every row is one harbor job with its manifest beside it on the runner
(`jobs/<name>.manifest.json`). A number without a manifest is not in this
file. Score is mean reward; `k` is attempts per task; the tarball column is
the sha256 prefix of the exact CLI that ran.

Read the numbers with their denominators. Eight tasks at one attempt each is a
pipeline check, not a leaderboard entry: one task flipping moves the score by
12.5 points.

## 2026-09-29 — pipeline check, 8 tasks, Sonnet 5.5 via OpenRouter

Tasks: regex-log, openssl-selfsigned-cert, sqlite-db-truncate,
log-summary-date-ranges, git-multibranch, password-recovery, extract-elf,
nginx-request-logging. Runner: the NUC, rootless podman, harbor 0.23.0.

| job | agent | tarball | k | score | cost | notes |
|---|---|---|---|---|---|---|
| `sonnet-sub8` | molt | `49ac894e` | 1 | 7/8 (87.5%) | $0.62 | password-recovery: provider `content_filter`, two empty turns, molt refused the empty claim. Every pass was reported `not proven` by molt itself: the drafter's commands had been cut at 300 chars and did not parse (fixed in `46a9c38a`). |
| `terminus2-sub8` | harbor `terminus-2` | — | 1 | 7/8 (87.5%) | $0.71 | git-multibranch failed after 385 s. |
| `sonnet-sub8-v2` | molt | `46a9c38a` | 1 | 7/8 (87.5%) | $0.32 | criteria fix. molt's verdict matched the grader on every pass. The miss: the model copied the awk from its own drafted criterion into the solution ("a diff against that command matches trivially") — both wrong together. Self-drafted checks are hidden from the model from `d1ea6901` on (commandment 9). |
| (discarded) | molt | `d1ea6901` | 1 | — | $0 | Space Bunny Alpha at default reasoning effort spent 8,000 tokens per draft and never answered; a resumed job also lost its env file (401s). Not a result; the tarball gained `--reasoning` (`6917f76f`). |

What the pairs say: at the same model on the same tasks the two harnesses
tied at one attempt each, with different failures; after the criteria fix
molt did it for 45% of the reference agent's cost. It does not say which is
better; that needs the full set and `k ≥ 3`.

What the run found in molt, each now fixed and pinned by a test:

1. `sanitizeCriteria` truncated a drafted command to 300 characters, turning
   it into one the shell could not parse. Over-long checks are now dropped,
   preflight drops any command the shell cannot parse, and the drafter is
   told to keep checks to one short line.
2. `molt run` exited 3 ("no verdict") on a turn verified against sealed task
   criteria when the project had no bar of its own.
3. Both of `fix-git`'s drafted checks passed before the work began, so they
   guarded rather than established. The drafter is now told to prefer a
   check that fails before the work.

## How to add a row

```
bench/harbor/run.sh -m <provider/model> -t <tarball> --name <job> -k <n> [-i task ...]
python3 bench/harbor/summarize.py jobs/<job>
python3 bench/harbor/compare.py jobs/<job-a> jobs/<job-b>
```

Then copy the score, cost and tarball prefix here, and say what the run found.
