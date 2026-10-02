#!/usr/bin/env python3
"""
Where a full run lost its points, sorted into leaks, biggest first.

    python3 bench/harbor/leaks.py jobs/<job> [--vs jobs/<other> ...] [--json]

Every trial that failed the grader gets exactly one leak, decided from the
trial's own record (result.json, molt.jsonl, the grader's output) in this
order, so the first cause wins:

  crash        molt never ran or died: harbor's agent error, a usage error
               (exit 2), killed by a signal (exit 143), no job_end
  hung         harbor's timeout, but molt spent < half the wall clock in steps
               and its last event is a tool that never returned
  slow         harbor's timeout while genuinely busy
  time-budget  molt's own --for deadline stopped the turn
  no-checks    nothing was drafted or sealed, so nothing could catch it
  false-done   molt said verified and the grader failed it (subdivided:
               retired = a dispute retired a check first; surface = what was
               left only looked)
  stuck-check  the same drafted check failed twice and the turn stopped
  gave-up      unverified / not proven otherwise

Passed trials are listed only for the honesty column: passed but molt did not
say verified ("unsaid"). With --vs, each failure says how many of the other
jobs passed the same task ("reachable" = at least one did), which is the part
of a leak that is plainly not the task's difficulty.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ORDER = ["crash", "hung", "slow", "time-budget", "no-checks", "false-done", "stuck-check", "gave-up"]


def events(trial: Path) -> list[dict]:
    log = trial / "agent" / "molt.jsonl"
    out: list[dict] = []
    if not log.is_file():
        return out
    with log.open(errors="replace") as f:
        for line in f:
            if line.startswith("{"):
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def reward(trial: Path) -> float | None:
    try:
        r = json.loads((trial / "result.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None
    rw = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    return rw


def grader_line(trial: Path) -> str:
    """The grader's first assertion message, for the report."""
    p = trial / "verifier" / "test-stdout.txt"
    if not p.is_file():
        return ""
    for line in p.read_text(errors="replace").splitlines():
        if line.startswith("E ") and line[1:].strip():
            return line[1:].strip()[:140]
    return ""


def classify(trial: Path) -> dict:
    try:
        res = json.loads((trial / "result.json").read_text())
    except (OSError, json.JSONDecodeError):
        res = {}
    exc = (res.get("exception_info") or {}).get("exception_type")
    rw = reward(trial)
    passed = (rw or 0) >= 1
    evs = events(trial)
    infos = [e.get("text", "") for e in evs if e.get("kind") == "info"]
    end = next((e for e in reversed(evs) if e.get("kind") == "job_end"), None)
    outcome = (end or {}).get("outcome")
    step_ms = sum(e.get("durationMs") or 0 for e in evs if e.get("kind") == "step_summary")
    steps = sum(1 for e in evs if e.get("kind") == "step_summary")
    try:
        code = int((trial / "agent" / "exit-code").read_text().strip())
    except (OSError, ValueError):
        code = None
    sealed = None
    for t in infos:
        m = re.search(r"(\d+) task check\(s\) and \d+ note", t)
        if m:
            sealed = int(m.group(1))
    has = lambda s: any(s in t for t in infos)  # noqa: E731
    ae = res.get("agent_execution") or {}
    row = {
        "task": trial.name.split("__")[0], "passed": passed, "outcome": outcome, "steps": steps,
        "step_secs": round(step_ms / 1000), "exit": code, "exc": exc, "sealed": sealed,
        "grader": "" if passed else grader_line(trial),
        "started": ae.get("started_at"), "finished": ae.get("finished_at"),
    }
    if passed:
        row["leak"] = None
        row["unsaid"] = outcome != "verified"
        return row

    last = next((e for e in reversed(evs) if e.get("kind") in ("tool_start", "tool", "request", "usage", "step_summary", "info", "job_end")), None)
    if exc == "AgentTimeoutError":
        wall = None
        try:
            from datetime import datetime
            f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))  # noqa: E731
            wall = (f(ae["finished_at"]) - f(ae["started_at"])).total_seconds()
        except (KeyError, TypeError, ValueError):
            pass
        stuck_in_tool = bool(last and last.get("kind") == "tool_start")
        idle = wall is not None and step_ms / 1000 < 0.5 * wall
        if (stuck_in_tool and idle) or (not evs) or (last and last.get("kind") == "info" and "waiting for this task" in last.get("text", "")):
            row["leak"] = "hung"
            row["detail"] = (last or {}).get("detail", (last or {}).get("text", ""))[:100] if last else "no events"
        else:
            row["leak"] = "slow"
        return row
    if exc or code in (2, 143) or (evs and end is None) or not evs:
        row["leak"] = "crash"
        row["detail"] = exc or (f"exit {code}" if code is not None else "no job_end")
        return row
    if has("time budget reached"):
        row["leak"] = "time-budget"
        return row
    if sealed in (None, 0) and not any("check" in t and "sealed" in t and not t.startswith("0 ") for t in infos):
        if sealed == 0 or has("done.yml"):
            row["leak"] = "no-checks"
            return row
    if outcome == "verified":
        row["leak"] = "false-done"
        row["detail"] = "retired" if has("retired") else ("reviewer flagged" if has("independent reviews found") else "checks passed")
        return row
    if has("failed in exactly the same way twice"):
        row["leak"] = "stuck-check"
        return row
    row["leak"] = "gave-up"
    return row


def trials(job: Path) -> list[Path]:
    return sorted(d for d in job.iterdir() if d.is_dir() and (d / "result.json").is_file())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("job", type=Path)
    ap.add_argument("--vs", type=Path, action="append", default=[], help="other jobs: which failures some other run passed")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    rows = [classify(t) for t in trials(a.job)]
    others: dict[str, int] = defaultdict(int)
    for j in a.vs:
        for t in trials(j):
            if (reward(t) or 0) >= 1:
                others[t.name.split("__")[0]] += 1
    for r in rows:
        r["others_passed"] = others.get(r["task"], 0) if a.vs else None

    if a.json:
        print(json.dumps(rows, indent=1))
        return

    n = len(rows)
    passed = sum(r["passed"] for r in rows)
    print(f"{a.job.name}: {passed}/{n} passed ({100 * passed / max(n, 1):.1f}%)")
    if a.vs:
        reach = sum(1 for r in rows if not r["passed"] and r["others_passed"])
        print(f"failures some other run passed: {reach}  (vs {', '.join(j.name for j in a.vs)})")
    unsaid = sum(1 for r in rows if r["passed"] and r.get("unsaid"))
    print(f"passed but not said verified: {unsaid}\n")

    by = defaultdict(list)
    for r in rows:
        if not r["passed"]:
            by[r["leak"]].append(r)
    ranked = sorted(by, key=lambda k: (-len(by[k]), ORDER.index(k)))
    print(f"{'leak':<12} {'count':>5} {'reachable':>9}")
    for k in ranked:
        reach = sum(1 for r in by[k] if r["others_passed"]) if a.vs else "-"
        print(f"{k:<12} {len(by[k]):>5} {reach:>9}")
    for k in ranked:
        print(f"\n== {k}")
        for r in sorted(by[k], key=lambda r: -(r["others_passed"] or 0)):
            o = f" [{r['others_passed']} other pass]" if r["others_passed"] else ""
            d = f" · {r['detail']}" if r.get("detail") else ""
            g = f"\n      grader: {r['grader']}" if r["grader"] else ""
            print(f"  {r['task']:<34} {str(r['outcome']):<11} steps {r['steps']:>3} chk {r['sealed']}{o}{d}{g}")
    c = Counter(r["leak"] for r in rows if not r["passed"])
    print(f"\nlost: {sum(c.values())} · " + " · ".join(f"{k} {c[k]}" for k in ranked))


if __name__ == "__main__":
    main()
