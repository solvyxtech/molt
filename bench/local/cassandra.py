#!/usr/bin/env python3
"""
Has molt earned Cassandra?

Cassandra was always right and never believed. molt earns the name when the
things it says are right — not only "done", but its warnings too:

  done      molt said the work is done (verified, and the independent
            reviewers did not dispute it)
  warning   molt said the work is NOT done: "not proven", or refused by its
            own drafted checks ("unverified, its own checks disagree")
  silent    neither: no checks, a timeout, an unchecked answer

The four gates (all must hold, on at least 3 runs of every task):

  1. it gets real work right          pass rate              >= 90%
  2. its "done" is true               done precision         >= 95%
  3. its warnings are true            warning precision      >= 90%   <- Cassandra
  4. it rarely stays silent on a bad  failed runs it warned  >= 80%
     result                            about or did not claim

    python3 bench/local/cassandra.py bench/local/results-v3.jsonl [--work DIR]

`--work` points at the run logs, to recover the checks-disagree flag for
results recorded before run.py kept it.
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

GATES = [("pass rate", 0.90), ("done precision", 0.95), ("warning precision", 0.90), ("failures warned about", 0.80)]


def disagree_from_log(work: Path | None, r: dict) -> list:
    if not work:
        return []
    log = work / f"{r['task']}-molt-{r['rep']}.log"
    if not log.exists():
        return []
    for line in log.read_text(errors="replace").splitlines():
        if '"job_end"' in line:
            try:
                return json.loads(line).get("checksDisagree") or []
            except json.JSONDecodeError:
                pass
    return []


def score(rows: list[dict], agent: str, work: Path | None) -> dict:
    rs = [r for r in rows if r["agent"] == agent]
    done = warn = silent = 0
    done_ok = warn_ok = failed = failed_flagged = 0
    for r in rs:
        claim = str(r.get("claim") or "")
        if agent == "molt":
            is_done = bool(r.get("said_done_reviewed", r.get("said_done")))
            disagree = r.get("checks_disagree") or disagree_from_log(work, r)
            is_warn = (not is_done) and (claim.startswith("not proven") or (claim.startswith("unverified") and bool(disagree)))
        else:  # another agent's own words, by run.py's fixed text rule
            is_done = bool(r.get("said_done"))
            is_warn = False
        ok = bool(r["passed"])
        if is_done:
            done += 1
            done_ok += ok
        elif is_warn:
            warn += 1
            warn_ok += not ok
        else:
            silent += 1
        if not ok:
            failed += 1
            failed_flagged += not is_done
    per_task = Counter(r["task"] for r in rs)
    return {
        "runs": len(rs),
        "min repeats": min(per_task.values()) if per_task else 0,
        "pass rate": sum(r["passed"] for r in rs) / len(rs) if rs else 0,
        "done precision": done_ok / done if done else None,
        "warning precision": warn_ok / warn if warn else None,
        "failures warned about": failed_flagged / failed if failed else None,
        "counts": f"{done} done ({done - done_ok} wrong), {warn} warnings ({warn - warn_ok} wrong), {silent} silent",
    }


def main(argv: list[str]) -> None:
    path = Path(argv[0])
    work = Path(argv[argv.index("--work") + 1]) if "--work" in argv else None
    rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    m = score(rows, "molt", work)
    print(f"molt — {m['runs']} runs, at least {m['min repeats']} per task — {m['counts']}")
    earned = m["min repeats"] >= 3
    for name, need in GATES:
        v = m[name]
        ok = v is not None and v >= need
        earned &= ok
        shown = "n/a" if v is None else f"{v:.0%}"
        print(f"  {'PASS' if ok else 'not yet':8s} {name:24s} {shown:>5s}  (needs {need:.0%})")
    if any(r["agent"] != "molt" for r in rows):
        other = sorted({r["agent"] for r in rows if r["agent"] != "molt"})
        for a in other:
            o = score(rows, a, None)
            dp = o["done precision"]
            print(f"  for reference, {a}: pass rate {o['pass rate']:.0%}, done precision {'n/a' if dp is None else f'{dp:.0%}'}")
    print("\nCassandra: EARNED" if earned else "\nCassandra: not yet earned")


if __name__ == "__main__":
    main(sys.argv[1:])
