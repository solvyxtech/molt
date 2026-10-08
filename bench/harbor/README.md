# molt on Terminal-Bench

Terminal-Bench 2.0 is 89 tasks, each a Docker container, an `instruction.md`,
and a hidden `tests/` the harness runs after the agent returns. The score is
the share of tasks whose tests pass. It is run through
[harbor](https://github.com/laude-institute/harbor).

`molt_agent.py` is the adapter. It installs this tree's CLI into each task
container and runs `molt run --yes --criteria auto` on the instruction.

The adapter passes no `--judge`, so the checks are drafted by the worker
model, and since 2026-10-07 a run that passes only its own checks ends
`passed own checks (<model>), not verified` (job_end `tier:
passed-own-checks`, exit 3), never `verified`. Set `MAAT_JUDGE_MODEL` (and
`MAAT_JUDGE_URL` / `MAAT_JUDGE_KEY`) in the container to another model to make "verified"
reachable. The exit code never fails a trial (see below).

## What it measures

The score of **this tree**, not of a published package. The adapter installs
from a tarball you build, so a harness change is measurable the same hour it
is made. Keep the pairs honest: same model, same tasks, same `-k`, and change
one thing.

## Running it

A container runtime is required, so this runs on a Linux box, not on the
Mac. Docker and rootless podman both work; the recipe below is podman, which
is what the NUC has.

```bash
# once, on the runner
curl -LsSf https://astral.sh/uv/install.sh | sh && uv tool install harbor
sudo dnf install -y docker-compose                 # Compose v2 as podman's provider
systemctl --user enable --now podman.socket        # the provider talks to this
printf '[engine]\ncompose_warning_logs = false\n' > ~/.config/containers/containers.conf
#   ^ without this podman prints a banner into every exec's stdout, and
#     harbor's package-manager probe reads "…<<<<\napt-get" as the manager name

# every shell
export PATH=$HOME/.local/bin:$PATH
export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock
export PYTHONPATH=/path/to/dir/holding/bench     # harbor's venv cannot see the cwd
```

### The repeatable way

`run.sh` pins everything a number depends on and writes a manifest first:

```bash
bench/harbor/run.sh -m openrouter/anthropic/claude-sonnet-5.5 -t solvyx-molt-0.2.0.tgz --name sonnet-full -k 1 -n 3
bench/harbor/run.sh -m ... -t ... -i fix-git -i regex-log          # a subset
python3 bench/harbor/summarize.py jobs/sonnet-full                  # the table and the score
```

The manifest (`jobs/<name>.manifest.json`) records the tarball's sha256,
harbor's version, the dataset, the model, `-k`, `-n`, and the subset. Two
runs are comparable when their manifests differ in one field.

### For days at a time

`campaign.sh` works through a queue of runs, one after another, and
`status.sh` writes `jobs/STATUS.md` from a timer so a phone can read it:

```bash
# queue.txt: one run per line — run.sh arguments, or agent:<harbor agent> <harbor args>
tmux new-session -d -s campaign "cd ~/tb && bench/harbor/campaign.sh ~/tb/queue.txt"
systemctl --user enable --now tb-status.timer     # every 10 min → jobs/STATUS.md
cat ~/tb/jobs/STATUS.md
```

A line is removed from the queue when its run starts and appended to
`queue.done.txt` when it ends, so a killed campaign restarts where it was,
and a line added while it runs is picked up in turn. It waits for any harbor
already running before it starts, so it can be started beside a job in
flight. `loginctl enable-linger` keeps the timer alive after logout.

### By hand

```bash
# 1. Build the CLI package from this tree.
npm run pack:cli && npm pack ./out-cli          # → solvyx-molt-<version>.tgz

# 2. Install harbor (once).
uv tool install harbor

# 3. Run. Provider prefix picks the endpoint and the key variable.
export ANTHROPIC_API_KEY=...
harbor run -d terminal-bench@2.0 \
  -a bench.harbor.molt_agent:Molt \
  -m anthropic/claude-sonnet-4-5 \
  --ak tarball=$PWD/solvyx-molt-0.2.0.tgz \
  -n 4 -k 1 -o ./jobs
```

Run it from the repository root, or set `PYTHONPATH` to it, so
`bench.harbor.molt_agent` is importable from harbor's own Python.

Any OpenAI-compatible endpoint works with an explicit URL:

```bash
harbor run -d terminal-bench@2.0 -a bench.harbor.molt_agent:Molt \
  -m custom/qwen3-coder \
  --ae MOLT_BASE_URL=http://192.168.0.218:8080/v1 \
  --ak tarball=$PWD/solvyx-molt-0.2.0.tgz
```

Known prefixes: `anthropic`, `openai`, `openrouter`, `xai`, `groq`, `mistral`,
`deepseek`. Each reads its usual `*_API_KEY` from the host environment.

### Agent options (`--ak key=value`)

| key | default | meaning |
|---|---|---|
| `tarball` | required | path to the `solvyx-molt-*.tgz` to install |
| `attempts` | 3 | completion attempts before molt gives up |
| `criteria` | `auto` | `auto` drafts and seals task criteria first; `none` skips it |
| `for` | unset | wall-clock ceiling per turn, e.g. `12m`; most tasks allow 15 minutes |
| `map_tokens` | molt's default | repo map budget; `0` leaves it out |
| `max_tokens` | unset | output ceiling per reply |
| `auto_shed` | molt's default (60000) | tokens of history before molt compacts; raise for a large-context model |

The adapter always passes `--sandbox`: the task container is disposable, so
the project boundary is the machine and nothing is refused for being
irreversible. Every other adapter does the equivalent (Claude Code runs with
`--permission-mode bypassPermissions`). The journal still records every call.

### A subset, for iterating

```bash
harbor run -d terminal-bench@2.0 -a bench.harbor.molt_agent:Molt -m ... \
  --ak tarball=... -i fix-git -i regex-log -i openssl-selfsigned-cert
```

Results land in `./jobs/<job>/`, one directory per trial, with `result.json`
holding the reward and molt's token spend. `harbor view ./jobs` browses them.
Each trial's `agent/` directory holds `molt.jsonl` (every event molt emitted),
`instruction.txt`, `exit-code`, and `record/` — the task's `.molt/` moved out
of the way before grading, so every receipt is there to read.

## What to look at when a task fails

In this order, because each is cheaper than the next:

1. `exit-code` is `2` — molt could not start (no key, bad URL). Not a task
   failure; fix the environment.
2. `molt.jsonl` ends with `proof_exhausted` — molt refused its own claim
   `attempts` times. Read the last `proof_result`: the failing criterion says
   what the model thought done meant and could not reach.
3. `job_end` says `verified` (or `passed-own-checks`) and the test still failed — the drafted
   criteria did not capture the task. This is the interesting case: it is the
   gap between what the model checked and what the grader checked.
4. The log stops mid-step — the harness killed molt at the task's timeout.
   Set `for` a minute or two under the task's `agent.timeout_sec`.

## Timeouts in Terminal-Bench 2.0

| tasks | agent timeout |
|---|---|
| 48 | 900 s |
| 17 | 1800 s |
| 12 | 3600 s |
| 6 | 1200 s |
| 6 | other |

Harbor kills the agent at the limit and grades whatever is on disk, so a
molt run that is mid-proof when the clock runs out is not lost — the work is
there — but the last verification never ran.
