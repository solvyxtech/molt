"""
Regrade finished runs from their saved task folders with the current graders, on this machine.

    RESULTS=results-v4.jsonl BENCH_EXPORT=~/.cache/maat-bench/container-work/<name> python3 regrade.py [--write]

Folders are looked up as the runs export them: <export>/<task>-<agent>-<rep>[-<arm>] (BENCH_EXPORT,
else BENCH_WORK). It used to look for <work>/<task>-<agent>-<rep> only, so after the export
moved and gained the -<arm> suffix it silently regraded nothing and reported "0 changed".
Container lanes: use regrade_today.py, which grades inside the bench image as the agent user.

Exists because the graders ignored molt's state folder as `.molt/` only; after
the rename to `.maat/` they failed correct work for leaving it behind.
"""
import json
import os
import sys
from pathlib import Path

from grading import safe_grade
from tasks import TASKS
from tasks2 import TASKS2
from tasks3 import TASKS3

HERE = Path(__file__).resolve().parent
out = HERE / os.environ.get("RESULTS", "results-v4.jsonl")
EXPORT = Path(os.environ.get("BENCH_EXPORT") or os.environ.get("BENCH_WORK") or Path.home() / ".cache/maat-bench/work").expanduser()
by = {T.name: T for T in TASKS + TASKS2 + TASKS3}
rows = [json.loads(line) for line in out.read_text().splitlines() if line.strip()]
changed = found = 0
for r in rows:
    tag = f"{r['task']}-{r['agent']}-{r['rep']}" + (f"-{r['arm']}" if r.get("arm") else "")
    d = EXPORT / tag
    if not d.is_dir():
        continue
    found += 1
    ok, why, gerr = safe_grade(by[r["task"]], d)
    if ok != r["passed"] or why != r["why"]:
        changed += ok != r["passed"]
        print(f"{tag}: {r['passed']} -> {ok}  ({r['why'][:60]} -> {why[:60]})")
        r["passed"], r["why"], r["grader_error"] = ok, why, gerr
print(f"{changed} changed of {found} regraded ({len(rows)} rows; {len(rows) - found} without a saved folder in {EXPORT})")
if not found:
    sys.exit(f"no saved folder found under {EXPORT}")
if "--write" in sys.argv:
    out.write_text("".join(json.dumps(r) + "\n" for r in rows))
