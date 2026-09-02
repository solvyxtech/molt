Reproduction scripts and run logs from the 2026-09-02 audit, copied verbatim
from the session scratchpad. Paths inside them point at that scratchpad
(`/private/tmp/claude-503/.../scratchpad/{fixed,prefix,fixed2,gen}`), which
were rsync copies of this repository; adjust before rerunning.

- `repro-*.mjs` — one script per finding, run against `dist/`
- `mutate*.mjs` — break each fix in `dist-test/` and confirm its test goes red
- `engine-real.mjs` — two-turn and cancel scenarios against the real provider
- `run-*.sh`, `R*.log` — the mercury dogfood runs and their full output
- `check*.log`, `baseline-test.log` — gate output before and after
- `index.jsonl.before-repair` — the receipts index before `--repair` backfilled change counts
