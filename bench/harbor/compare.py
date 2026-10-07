#!/usr/bin/env python3
"""
Two harbor jobs, side by side: right, fast, cheap, and honest.

    python3 bench/harbor/compare.py jobs/<a> jobs/<b> [--tasks]

Only tasks present in both are compared; a number that compares different
task sets is not a comparison. With `-k` above 1, each task's reward, time and
tokens are means over that job's attempts.

  right    tasks passed, and which tasks only one of them passed
  fast     agent wall-clock per task: median over all shared tasks, median over
           tasks BOTH passed (the fair speed number: same work, both succeeded),
           and timeouts
  cheap    input (of which cached) and output tokens, total over shared tasks,
           and passes per million tokens (the Writer "harness effect" paper's
           release gate), over the tasks whose usage was recorded
  honest   how often the harness's own "done" agreed with the grader — said
           done and was right, said done and was wrong, passed without saying
           so. molt's "done" is its verified outcome; Terminus-2's is calling
           mark_task_complete. A harness that says nothing shows "—".
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# Shared with bench/local/scoreboard.py (Wilson intervals, one definition).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "local"))
from stats import rate  # noqa: E402


def outcome_of(trial: Path) -> str | None:
    """
    What the harness itself said at the end: molt's last job_end outcome, or
    for Terminus-2 "verified" when it called mark_task_complete (its protocol's
    "I am done") and "none" when it did not. None for a harness that says
    nothing either way.
    """
    traj = trial / "agent" / "trajectory.json"
    log = trial / "agent" / "molt.jsonl"
    if not log.is_file() and traj.is_file():
        try:
            steps = json.loads(traj.read_text()).get("steps") or []
        except json.JSONDecodeError:
            return None
        done = any(
            (c.get("function_name") or "") == "mark_task_complete"
            for st in steps for c in (st.get("tool_calls") or [])
        )
        return "verified" if done else "none"
    if not log.is_file():
        return None
    found = "none"
    with log.open(errors="replace") as f:
        for line in f:
            if '"job_end"' not in line or not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("kind") == "job_end":
                found = ev.get("outcome") or "none"
                # An unconfirmed claim is not a "done" claim: molt said it
                # passed its checks and that an independent review doubted it.
                if found == "verified" and (ev.get("review") or {}).get("confirmed") is False:
                    found = "unconfirmed"
    return found


def secs(t: dict | None) -> float | None:
    if not t or not t.get("started_at") or not t.get("finished_at"):
        return None
    return (datetime.fromisoformat(t["finished_at"]) - datetime.fromisoformat(t["started_at"])).total_seconds()


def load(job: Path) -> dict[str, list[dict]]:
    by_task: dict[str, list[dict]] = defaultdict(list)
    for d in sorted(job.iterdir()):
        rp = d / "result.json"
        if not d.is_dir() or not rp.is_file():
            continue
        r = json.loads(rp.read_text())
        rewards = (r.get("verifier_result") or {}).get("rewards") or {}
        agent = r.get("agent_result") or {}
        by_task[str(r.get("task_name"))].append(
            {
                "reward": rewards.get("reward") if isinstance(rewards, dict) else None,
                "secs": secs(r.get("agent_execution")),
                "timeout": (r.get("exception_info") or {}).get("exception_type") == "AgentTimeoutError",
                "in": agent.get("n_input_tokens"),
                "cached": agent.get("n_cache_tokens"),
                "out": agent.get("n_output_tokens"),
                "said": outcome_of(d),
            }
        )
    return by_task


def mean(xs):
    vals = [x for x in xs if x is not None]
    return sum(vals) / len(vals) if vals else None


def med(xs):
    vals = [x for x in xs if x is not None]
    return statistics.median(vals) if vals else None


def fmt_secs(s):
    if s is None:
        return "—"
    return f"{s / 60:.1f}m" if s >= 90 else f"{s:.0f}s"


def fmt_tok(n):
    if not n:
        return "—"
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.0f}k"


def summarize(tasks: dict[str, list[dict]], shared: list[str], both_pass: set[str]) -> dict:
    passed = {t for t in shared if (mean([x["reward"] for x in tasks[t]]) or 0) >= 0.5}
    per_task_secs = {t: mean([x["secs"] for x in tasks[t]]) for t in shared}
    said = [x["said"] for t in shared for x in tasks[t]]
    molt = any(s is not None for s in said)
    h = None
    if molt:
        right = wrong = under = 0
        for t in shared:
            for x in tasks[t]:
                claimed = x["said"] == "verified"
                ok = (x["reward"] or 0) >= 1
                right += claimed and ok
                wrong += claimed and not ok
                under += (not claimed) and ok
        h = {"claimed_right": right, "claimed_wrong": wrong, "passed_unclaimed": under}
    return {
        "passed": passed,
        "median_secs": med(per_task_secs.values()),
        "median_secs_both_passed": med([per_task_secs[t] for t in both_pass]),
        "timeouts": sum(1 for t in shared for x in tasks[t] if x["timeout"]),
        "in": sum((mean([x["in"] for x in tasks[t]]) or 0) for t in shared),
        "cached": sum((mean([x["cached"] for x in tasks[t]]) or 0) for t in shared),
        "out": sum((mean([x["out"] for x in tasks[t]]) or 0) for t in shared),
        "unrecorded": sum(1 for t in shared if mean([x["in"] for x in tasks[t]]) is None),
        # Completions per million tokens, over the tasks whose usage was kept
        # (a timed-out trial keeps none): passes there / their total tokens.
        "cpm": (lambda rec: (sum(1 for t in rec if t in passed) / (sum(
            (mean([x["in"] for x in tasks[t]]) or 0) + (mean([x["out"] for x in tasks[t]]) or 0) for t in rec) / 1e6))
            if rec and sum((mean([x["in"] for x in tasks[t]]) or 0) for t in rec) else None)(
            [t for t in shared if mean([x["in"] for x in tasks[t]]) is not None]),
        "honesty": h,
    }


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__.strip())
        return 2
    a, b = Path(args[0]), Path(args[1])
    ta, tb = load(a), load(b)
    shared = sorted(set(ta) & set(tb))
    if not shared:
        print("no task appears in both jobs", file=sys.stderr)
        return 1
    pa = {t for t in shared if (mean([x["reward"] for x in ta[t]]) or 0) >= 0.5}
    pb = {t for t in shared if (mean([x["reward"] for x in tb[t]]) or 0) >= 0.5}
    both = pa & pb
    sa, sb = summarize(ta, shared, both), summarize(tb, shared, both)
    n = len(shared)
    na, nb = a.name, b.name
    w = max(len(na), len(nb), 10)

    if "--tasks" in argv:
        tw = max(len(t) for t in shared)
        print(f"{'task':{tw}}  {na[:12]:>12} {'time':>6}   {nb[:12]:>12} {'time':>6}")
        for t in shared:
            ra, rb = mean([x["reward"] for x in ta[t]]), mean([x["reward"] for x in tb[t]])
            print(
                f"{t:{tw}}  {('pass' if (ra or 0) >= 0.5 else 'fail'):>12} {fmt_secs(mean([x['secs'] for x in ta[t]])):>6}   "
                f"{('pass' if (rb or 0) >= 0.5 else 'fail'):>12} {fmt_secs(mean([x['secs'] for x in tb[t]])):>6}"
            )
        print()

    print(f"{n} shared task(s)")
    print(f"{'':16} {na:>{w}}  {nb:>{w}}")
    print(f"{'right':16} {len(pa):>{w - 7}} ({100 * len(pa) / n:4.1f}%)  {len(pb):>{w - 7}} ({100 * len(pb) / n:4.1f}%)")
    print(f"{'  only this one':16} {len(pa - pb):>{w}}  {len(pb - pa):>{w}}")
    print(f"{'median time':16} {fmt_secs(sa['median_secs']):>{w}}  {fmt_secs(sb['median_secs']):>{w}}")
    print(f"{'  both passed':16} {fmt_secs(sa['median_secs_both_passed']):>{w}}  {fmt_secs(sb['median_secs_both_passed']):>{w}}   ({len(both)} tasks)")
    print(f"{'timeouts':16} {sa['timeouts']:>{w}}  {sb['timeouts']:>{w}}")
    print(f"{'input tokens':16} {fmt_tok(sa['in']):>{w}}  {fmt_tok(sb['in']):>{w}}")
    print(f"{'  cached':16} {fmt_tok(sa['cached']):>{w}}  {fmt_tok(sb['cached']):>{w}}")
    print(f"{'output tokens':16} {fmt_tok(sa['out']):>{w}}  {fmt_tok(sb['out']):>{w}}")
    fc = lambda v: "—" if v is None else f"{v:.2f}"
    print(f"{'passes / M tok':16} {fc(sa['cpm']):>{w}}  {fc(sb['cpm']):>{w}}   (tasks with usage kept)")
    if sa["unrecorded"] or sb["unrecorded"]:
        print(f"{'  no usage kept':16} {sa['unrecorded']:>{w}}  {sb['unrecorded']:>{w}}   (timed out before harbor read it)")
    ha, hb = sa["honesty"], sb["honesty"]

    def hcell(h, key):
        return "—" if h is None else str(h[key])

    print(f"{'said done, right':16} {hcell(ha, 'claimed_right'):>{w}}  {hcell(hb, 'claimed_right'):>{w}}")
    print(f"{'said done, wrong':16} {hcell(ha, 'claimed_wrong'):>{w}}  {hcell(hb, 'claimed_wrong'):>{w}}")
    print(f"{'passed, unsaid':16} {hcell(ha, 'passed_unclaimed'):>{w}}  {hcell(hb, 'passed_unclaimed'):>{w}}")

    def prec(h):
        if h is None or not (h["claimed_right"] + h["claimed_wrong"]):
            return "—"
        return f"{100 * h['claimed_right'] / (h['claimed_right'] + h['claimed_wrong']):.0f}%"

    print(f"{'  done was true':16} {prec(ha):>{w}}  {prec(hb):>{w}}")
    def pr(h, kind):
        if h is None:
            return "—"
        r, wr, un = h["claimed_right"], h["claimed_wrong"], h["passed_unclaimed"]
        return rate(r, r + wr) if kind == "p" else rate(r, r + un)

    # Wilson 95% intervals: at 89 tasks a 5-task gap is noise, so say how wide.
    print(f"{'precision':16} {pr(ha, 'p')}  |  {pr(hb, 'p')}   P(pass | said done)")
    print(f"{'recall':16} {pr(ha, 'r')}  |  {pr(hb, 'r')}   P(said done | pass)")
    only_a, only_b = sorted(set(ta) - set(tb)), sorted(set(tb) - set(ta))
    if only_a or only_b:
        print(f"not compared — only in {na}: {len(only_a)} task(s); only in {nb}: {len(only_b)} task(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
