#!/usr/bin/env python3
"""
Summarise a harbor job directory: one row per trial, then the score.

    python3 bench/harbor/summarize.py jobs/<job> [--json]

Reads each trial's result.json (harbor's TrialResult) and, where present,
molt's own record under agent/: exit-code, and the last job_end in molt.jsonl.
The score is the mean reward over trials, which is what the leaderboard
reports; the columns beside it are what you need to know whether the number
is honest — how many trials errored before the agent ran, how many hit the
timeout, and what it cost.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def last_job_end(path: Path) -> dict | None:
    if not path.is_file():
        return None
    found = None
    with path.open(errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("kind") == "job_end":
                found = ev
    return found


def trial_row(d: Path) -> dict | None:
    rp = d / "result.json"
    if not rp.is_file():
        return None
    r = json.loads(rp.read_text())
    ver = r.get("verifier_result") or {}
    rewards = ver.get("rewards") or {}
    reward = rewards.get("reward") if isinstance(rewards, dict) else None
    agent = r.get("agent_result") or {}
    exc = r.get("exception_info") or {}
    timing = r.get("agent_execution") or {}
    secs = None
    if timing.get("started_at") and timing.get("finished_at"):
        from datetime import datetime
        a = datetime.fromisoformat(timing["started_at"])
        b = datetime.fromisoformat(timing["finished_at"])
        secs = (b - a).total_seconds()
    exit_code = None
    ec = d / "agent" / "exit-code"
    if ec.is_file():
        try:
            exit_code = int(ec.read_text().strip())
        except ValueError:
            exit_code = None
    je = last_job_end(d / "agent" / "molt.jsonl")
    # A model that answered nothing with finish_reason content_filter is a
    # refusal by the provider, not a harness failure; it is named so the score
    # can be read with and without it.
    refused = False
    mj = d / "agent" / "molt.jsonl"
    if mj.is_file():
        refused = "content_filter" in mj.read_text(errors="replace")
    return {
        "model_refused": refused,
        "trial": d.name,
        "task": r.get("task_name"),
        "reward": reward,
        "exception": exc.get("exception_type"),
        "agent_secs": secs,
        "in_tokens": agent.get("n_input_tokens"),
        "out_tokens": agent.get("n_output_tokens"),
        "cost_usd": agent.get("cost_usd"),
        "molt_exit": exit_code,
        "molt_outcome": (
            "unconfirmed" if (je or {}).get("outcome") == "verified" and ((je or {}).get("review") or {}).get("confirmed") is False
            # Builds from 2026-10-07 say who wrote the checks in job_end's `claim`.
            else "passed-own-checks" if (je or {}).get("tier") == "passed-own-checks"
            else "self-checked" if (je or {}).get("outcome") == "verified" and (je or {}).get("selfChecked") and not (je or {}).get("claim")
            else (je or {}).get("outcome")
        ),
        "molt_steps": (je or {}).get("steps"),
    }


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 2
    job = Path(argv[0])
    as_json = "--json" in argv
    rows = [row for d in sorted(job.iterdir()) if d.is_dir() for row in [trial_row(d)] if row]
    if not rows:
        print(f"no trials with result.json under {job}", file=sys.stderr)
        return 1
    scored = [r for r in rows if r["reward"] is not None]
    passed = sum(1 for r in scored if (r["reward"] or 0) >= 1)
    errored = sum(1 for r in rows if r["exception"])
    timeouts = sum(1 for r in rows if (r["exception"] or "").lower().find("timeout") >= 0)
    cost = sum(r["cost_usd"] or 0 for r in rows)
    summary = {
        "job": str(job),
        "trials": len(rows),
        "scored": len(scored),
        "passed": passed,
        "score": round(100 * passed / len(rows), 1) if rows else None,
        "errored": errored,
        "timeouts": timeouts,
        "cost_usd": round(cost, 4),
        "unverified_by_molt_but_passed": sum(
            1 for r in scored if (r["reward"] or 0) >= 1 and r["molt_outcome"] not in ("verified", "self-checked", None)
        ),
        "verified_by_molt_but_failed": sum(
            1 for r in scored if (r["reward"] or 0) < 1 and r["molt_outcome"] in ("verified", "self-checked")
        ),
        "model_refused": sum(1 for r in rows if r["model_refused"]),
    }
    if as_json:
        print(json.dumps({"summary": summary, "trials": rows}, indent=2))
        return 0
    w = max(len(str(r["task"])) for r in rows)
    print(f"{'task':{w}}  reward  molt        steps  secs   in_tok    out_tok  cost    exc")
    for r in rows:
        print(
            f"{str(r['task']):{w}}  "
            f"{'' if r['reward'] is None else ('PASS' if r['reward'] >= 1 else 'fail'):6}  "
            f"{str(r['molt_outcome'] or '-'):11} "
            f"{str(r['molt_steps'] or '-'):>5}  "
            f"{'' if r['agent_secs'] is None else int(r['agent_secs']):>5}  "
            f"{str(r['in_tokens'] or '-'):>8}  "
            f"{str(r['out_tokens'] or '-'):>8}  "
            f"{'' if r['cost_usd'] is None else f'${r['cost_usd']:.2f}':>6}  "
            f"{r['exception'] or ''}{' model refused (content_filter)' if r['model_refused'] else ''}"
        )
    print()
    print(
        f"score {summary['score']}% · {passed}/{len(rows)} passed · {errored} errored ({timeouts} timeouts) · "
        f"${cost:.2f} · molt said verified on {summary['verified_by_molt_but_failed']} that failed, "
        f"passed {summary['unverified_by_molt_but_passed']} it did not verify · "
        f"{summary['model_refused']} refused by the model (content_filter)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
