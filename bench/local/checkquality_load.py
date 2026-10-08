"""Check-quality replay, step 1: one record per run across the v10/v11/v12 lanes.

Reads container-results/results-<lane>.jsonl (grader labels), each run's
<task>-molt-<rep>.log (engine events: seal, drafting cut, proof results with
output, retirements) and the workspace's .maat/log journal (bar_run events,
timestamps). No model, no network.

    python3 checkquality_load.py OUT.json
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

CACHE = Path.home() / ".cache/maat-bench"
RESULTS = CACHE / "container-results"
CW = CACHE / "container-work"
LANES = ["v10-old", "v10-fix", "v11-old", "v11-new", "v12-old", "v12-new"]


def events(path: Path) -> list[dict]:
    out = []
    for line in path.read_text(errors="replace").splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def journal(run: Path) -> list[dict]:
    ev: list[dict] = []
    logd = run / ".maat/log"
    for f in sorted(logd.glob("*.jsonl")) if logd.is_dir() else []:
        ev += events(f)
    ev.sort(key=lambda e: (e.get("iso", ""), e.get("seq", 0)))
    return ev


def iso(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def load_lane(lane: str) -> list[dict]:
    rows = {}
    for line in (RESULTS / f"results-{lane}.jsonl").read_text().splitlines():
        r = json.loads(line)
        rows[(r["task"], r["rep"])] = r
    recs = []
    for shard in sorted(CW.glob(f"{lane}-s*")):
        for log in sorted(shard.glob("*-molt-*.log")):
            m = re.match(r"^(.+)-molt-(\d+)\.log$", log.name)
            task, rep = m[1], int(m[2])
            row = rows.get((task, rep))
            if not row:
                continue
            ws = shard / f"{task}-molt-{rep}"
            ev = events(log)
            rec = {
                "lane": lane, "task": task, "rep": rep, "id": f"{lane}/{task}#{rep}", "ws": str(ws),
                "passed": bool(row["passed"]), "why": row.get("why", ""), "claim": row.get("claim"),
                "checks_disagree": row.get("checks_disagree") or [], "tier": row.get("tier"),
                "secs": row.get("secs"), "timed_out": row.get("timed_out"), "review": row.get("review"),
                "said_done": row.get("said_done"), "steps": row.get("turns"),
                "sealed_n": None, "notes_n": None, "cut": None, "late_join": 0, "late_join_names": [],
                "seal_s": None, "proofs": [], "retired": [], "infos": [], "outcome": None, "job_end": None,
                "preflight_broken": [], "passed_before_work": [],
            }
            for e in ev:
                k = e.get("kind")
                if k == "info":
                    t = e.get("text", "")
                    m2 = re.match(r"^(\d+) task check\(s\) and (\d+) note\(s\) sealed", t)
                    if m2:
                        rec["sealed_n"] = int(m2[1]); rec["notes_n"] = int(m2[2])
                    if "checks were still being drafted after" in t:
                        rec["cut"] = "none-ready" if "none was ready" in t else "partial"
                    m3 = re.match(r"^(\d+) drafted check\(s\) joined this turn", t)
                    if m3:
                        rec["late_join"] += int(m3[1])
                    m4 = re.match(r"^check (\S+) (?:timed out|failed in its own code, not on the work \((.*?)\))", t)
                    if m4:
                        rec["retired"].append({"name": m4[1], "why": m4[2] or "timeout"})
                    if t.startswith("criterion `"):
                        rec["preflight_broken"] += re.findall(r"criterion `([^`]+)` did not run", t)
                    rec["infos"].append(t[:160])
                elif k in ("proof_refused", "proof_exhausted", "proof_passed", "proof_ok", "proof_result"):
                    res = e.get("result") or {}
                    rec["proofs"].append({
                        "kind": k, "attempt": e.get("attempt") or e.get("attempts"), "ok": res.get("ok"),
                        "results": [
                            {"name": r.get("name"), "detail": r.get("detail"), "ok": r.get("ok"), "exitCode": r.get("exitCode"),
                             "output": (r.get("output") or "")[-1500:], "tags": r.get("tags") or [], "hidden": r.get("hidden"),
                             "timedOut": r.get("timedOut"), "advisory": r.get("advisory"), "skipped": r.get("skipped"), "kind": r.get("kind")}
                            for r in res.get("results") or []
                        ],
                    })
                elif k == "job_end":
                    rec["outcome"] = e.get("outcome")
                    rec["job_end"] = {kk: e.get(kk) for kk in ("steps", "durationMs", "outcome", "selfChecked", "checksDisagree", "tier", "turnEndedBy")}
            jl = journal(ws)
            start = next((e["iso"] for e in jl if e.get("kind") == "session_start"), None)
            seal = next((e for e in jl if e.get("kind") == "note" and str(e.get("data", {}).get("text", "")).startswith("task criteria sealed")), None)
            if start and seal:
                rec["seal_s"] = round(iso(seal["iso"]) - iso(start), 1)
                rec["sealed_names"] = seal["data"].get("checks", [])
            late = [e for e in jl if e.get("kind") == "note" and e.get("data", {}).get("kind") == "late-checks"]
            for e in late:
                rec["late_join_names"] += e["data"].get("checks") or []
            bars = [e for e in jl if e.get("kind") == "bar_run"]
            rec["bar_runs"] = [
                {"iso": e["iso"], "ok": e["data"].get("ok"), "checks": [{"name": c["name"], "detail": c.get("detail"), "ok": c.get("ok"), "exitCode": c.get("exitCode")} for c in e["data"].get("checks", [])]}
                for e in bars
            ]
            pbw = [e for e in jl if e.get("kind") == "note" and "already pass" in str(e.get("data", {}).get("text", ""))]
            rec["passed_before_work"] = [str(e["data"].get("text"))[:200] for e in pbw]
            rec["journal_start"] = start
            rec["journal_end"] = next((e["iso"] for e in reversed(jl) if e.get("kind") == "session_end"), None)
            recs.append(rec)
    return recs


def main() -> None:
    out = []
    for lane in LANES:
        recs = load_lane(lane)
        print(lane, len(recs), "runs;", sum(r["passed"] for r in recs), "passed", file=sys.stderr)
        out += recs
    Path(sys.argv[1]).write_text(json.dumps(out))


if __name__ == "__main__":
    main()
