"""
Regrade finished runs from their saved work folders with the current graders.

    RESULTS=results-v4.jsonl python3 regrade.py [--write]

Exists because the graders ignored molt's state folder as `.molt/` only; after
the rename to `.maat/` they failed correct work for leaving it behind.
"""
import json, os, sys
from pathlib import Path
from tasks import TASKS
from tasks2 import TASKS2

HERE = Path(__file__).resolve().parent
out = HERE / os.environ.get("RESULTS", "results-v4.jsonl")
by = {T.name: T for T in TASKS + TASKS2}
rows = [json.loads(l) for l in out.read_text().splitlines()]
changed = 0
for r in rows:
    d = HERE / "work" / f"{r['task']}-{r['agent']}-{r['rep']}"
    if not d.is_dir():
        continue
    ok, why = by[r["task"]].grade(d)
    if ok != r["passed"] or why != r["why"]:
        changed += ok != r["passed"]
        print(f"{r['task']} {r['agent']} {r['rep']}: {r['passed']} -> {ok}  ({r['why'][:60]} -> {why[:60]})")
        r["passed"], r["why"] = ok, why
print(f"{changed} changed of {len(rows)}")
if "--write" in sys.argv:
    out.write_text("".join(json.dumps(r) + "\n" for r in rows))
