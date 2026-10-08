"""
Regrade today's finished container lanes with the fixed graders (PR #33 audit, B1 and B2).

    python3 bench/local/regrade_today.py [--date 2026-10-07] [--old <rev>] [-j 3] [--lanes a,b]

For every lane run today (a folder under ~/.cache/maat-bench/container-work/<name>/ whose
~/.cache/maat-bench/<name>.log names its results file) that is no longer running, every row of a
git task (B1) or of a task whose grader trusted the worker's process (B2) is graded again from the
task folder the lane saved, inside the bench image (maat-bench:agentu, network off):

    new        the graders at this checkout, as the lanes grade now: the folder belongs to the
               agent user and run.grade drops to it (git guard, values channel, grader_error)
    old_root   the graders of <rev> (default: the branch head before the fixes), as root, on the
               same agent-owned folder: what the lanes graded before c6e3e56 (dubious ownership)
    old_guard  the same old graders as root with safe.directory set: the old grader minus B1, so a
               change between old_guard and new is the B2 rewrite alone

The originals are never modified. Each results file gets a copy, results-<x>.regraded.jsonl, in
which regraded rows carry the new verdict and a "regrade" record (the recorded verdict, the
three re-runs, the grader hash); rows whose folder was not saved are copied unchanged with
"regrade": {"skipped": ...}. The report says, per lane, how many verdicts changed, and lists every
"verified" row that now fails and every failed row that now passes.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache/maat-bench"
WORKS = CACHE / "container-work"
RESULTS = CACHE / "container-results"
IMAGE = "maat-bench:agentu"
OLD_REV = "b6c5ddc"  # claude/no-probing before the audit fixes

GIT_TASKS = {"fix-git", "git-revert-one", "git-split-lib-history", "git-find-culprit"}
B2_TASKS = {"duration-bug", "refactor-pricing", "perf-pairs", "size-parse-bug", "refactor-invoice",
            "vendor-units-workaround", "rename-api-signature", "async-pool-node"}
TASKS = GIT_TASKS | B2_TASKS


# ------------------------------------------------------------------ inside the container (root)
def inside(mode: str) -> None:
    """mode "new": graders from /bench, run.grade as the agent user. "old": graders from /old, as root."""
    job = json.load(open("/job.json"))
    if mode == "new":
        sys.path.insert(0, "/bench")
        import run  # noqa: PLC0415
        run.AGENT_USER = "agent"
    else:
        sys.path.insert(0, "/old")
    from tasks import TASKS as T1  # noqa: PLC0415
    from tasks2 import TASKS2  # noqa: PLC0415
    from tasks3 import TASKS3  # noqa: PLC0415
    by = {T.name: T for T in T1 + TASKS2 + TASKS3}
    base = Path("/var/lib/bench-work")
    base.mkdir(parents=True, exist_ok=True)
    os.chmod(base, 0o711)
    out = {}

    def fresh(src: str, tag: str) -> Path:
        box = base / "rg"
        shutil.rmtree(box, ignore_errors=True)
        box.mkdir(mode=0o711)
        os.chmod(box, 0o711)
        d = box / tag
        subprocess.run(["cp", "-a", src, str(d)], check=True)
        subprocess.run(["chown", "-R", "agent:agent", str(d)], check=True)
        return d

    def timed(fn):
        try:
            return list(fn())
        except Exception as e:  # noqa: BLE001
            return [False, f"grader error: {e!r}"[:300], True]

    for j in job:
        T = by[j["task"]]
        res = {}
        if mode == "new":
            d = fresh(j["src"], j["tag"])
            res["new"] = timed(lambda: run.grade(T, d))
        else:
            d = fresh(j["src"], j["tag"])
            res["old_root"] = timed(lambda: (*T.grade(d), False))
            d = fresh(j["src"], j["tag"])
            env = {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "safe.directory", "GIT_CONFIG_VALUE_0": "*"}
            os.environ.update(env)
            try:
                res["old_guard"] = timed(lambda: (*T.grade(d), False))
            finally:
                for k in env:
                    os.environ.pop(k, None)
        for k in ("new", "old_root", "old_guard"):
            if k in res:
                res[k][1] = str(res[k][1])[:300]
        out[j["id"]] = res
        print("@@ROW@@" + json.dumps({"id": j["id"], **res}), flush=True)


# ------------------------------------------------------------------ host
def running() -> set[str]:
    p = subprocess.run(["docker", "ps", "--format", "{{.Names}}"], capture_output=True, text=True)
    return {n[len("maat-bench-"):] for n in p.stdout.split() if n.startswith("maat-bench-")}


def lanes_of(day: str) -> tuple[dict[str, list[Path]], list[str]]:
    """{results file name: [work dirs]} for lanes whose work dir changed on `day` and are not running."""
    live = running()
    by: dict[str, list[Path]] = collections.defaultdict(list)
    notes = []
    for w in sorted(WORKS.iterdir()):
        if not w.is_dir() or dt.date.fromtimestamp(w.stat().st_mtime).isoformat() != day:
            continue
        if w.name in live:
            notes.append(f"{w.name}: still running, skipped")
            continue
        log = CACHE / f"{w.name}.log"
        m = re.search(r"results/(\S+\.jsonl)", log.read_text(errors="replace")[:4000]) if log.exists() else None
        if not m:
            notes.append(f"{w.name}: no results file named in {log.name}, skipped")
            continue
        by[m.group(1)].append(w)
    # a results file shared with a lane that is still running is not finished
    for name in list(by):
        live_dirs = [n for n in live if (CACHE / f"{n}.log").exists() and f"results/{name}" in (CACHE / f"{n}.log").read_text(errors="replace")[:4000]]
        if live_dirs:
            notes.append(f"{name}: lane {', '.join(sorted(live_dirs))} still writing it, skipped")
            del by[name]
    return by, notes


def tag_of(r: dict) -> str:
    return f"{r['task']}-{r['agent']}-{r['rep']}" + (f"-{r['arm']}" if r.get("arm") else "")


def old_tree(rev: str) -> Path:
    d = Path(tempfile.mkdtemp(prefix="regrade-old-"))
    repo = HERE.parents[1]
    arch = subprocess.run(["git", "-C", str(repo), "archive", rev, "bench/local"], capture_output=True, check=True).stdout
    subprocess.run(["tar", "-x", "-C", str(d)], input=arch, check=True)
    return d / "bench" / "local"


def grade_lane(name: str, jobs: list[dict], dirs: list[Path], old: Path) -> dict:
    with tempfile.TemporaryDirectory() as td:
        jf = Path(td) / "job.json"
        jf.write_text(json.dumps(jobs))
        mounts = []
        for w in dirs:
            mounts += ["-v", f"{w}:/src/{w.name}:ro"]
        cmd = ["docker", "run", "--rm", "--network", "none", "--memory", "4g", "--pids-limit", "1024",
               "-e", "PYTHONDONTWRITEBYTECODE=1", "-v", f"{HERE}:/bench:ro", "-v", f"{old}:/old:ro", "-v", f"{jf}:/job.json:ro",
               *mounts, IMAGE, "sh", "-c",
               "python3 /bench/regrade_today.py --inside old; python3 /bench/regrade_today.py --inside new"]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=3600 + 120 * len(jobs))
    res: dict = collections.defaultdict(dict)
    for line in p.stdout.splitlines():
        if line.startswith("@@ROW@@"):
            x = json.loads(line[7:])
            res[x.pop("id")].update(x)
    if not res:
        print(f"  ! {name}: no results from the container: {(p.stderr or p.stdout)[-400:]}", flush=True)
    return res


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--old", default=OLD_REV, help="git revision of the old graders")
    ap.add_argument("-j", type=int, default=3, help="containers at once")
    ap.add_argument("--lanes", help="only these results files (comma-separated names)")
    a = ap.parse_args(argv)
    lanes, notes = lanes_of(a.date)
    if a.lanes:
        want = set(a.lanes.split(","))
        lanes = {k: v for k, v in lanes.items() if k in want}
    for n in notes:
        print("note:", n)
    old = old_tree(a.old)
    sys.path.insert(0, str(HERE))
    import run  # noqa: PLC0415
    ghash = run.grader_hash()

    plan = {}
    for name, dirs in sorted(lanes.items()):
        src = RESULTS / name
        if not src.exists():
            print(f"note: {name}: no results file, skipped")
            continue
        rows = [json.loads(x) for x in src.read_text().splitlines() if x.strip()]
        jobs, where, dup = [], {}, 0
        for i, r in enumerate(rows):
            if r.get("task") not in TASKS:
                continue
            cands = [w / tag_of(r) for w in dirs if (w / tag_of(r)).is_dir()]
            if not cands:
                where[i] = None
                continue
            dup += len(cands) > 1
            best = max(cands, key=lambda p: p.stat().st_mtime)  # a capped run's leftover is older than the recorded one
            where[i] = best
            jobs.append({"id": i, "task": r["task"], "tag": tag_of(r), "src": f"/src/{best.parent.name}/{best.name}"})
        plan[name] = (rows, jobs, where, dirs, dup)

    print(f"{len(plan)} lanes, {sum(len(p[1]) for p in plan.values())} rows to regrade (old graders: {a.old}, new grader hash {ghash})", flush=True)
    results = {}
    with cf.ThreadPoolExecutor(a.j) as ex:
        futs = {ex.submit(grade_lane, name, jobs, dirs, old): name for name, (rows, jobs, where, dirs, dup) in plan.items() if jobs}
        for f in cf.as_completed(futs):
            results[futs[f]] = f.result()
            print(f"  graded {futs[f]}", flush=True)
    shutil.rmtree(old.parents[1], ignore_errors=True)

    table = []
    flips = []
    for name, (rows, jobs, where, dirs, dup) in plan.items():
        res = results.get(name, {})
        out_rows = []
        c = collections.Counter()
        for i, r in enumerate(rows):
            r = dict(r)
            if i in where and where[i] is None:
                r["regrade"] = {"skipped": "no saved task folder"}
                c["missing"] += 1
            elif i in where:
                g = res.get(i) or res.get(str(i))
                if not g or "new" not in g:
                    r["regrade"] = {"skipped": "the container gave no verdict"}
                    c["missing"] += 1
                else:
                    new_ok, new_why, gerr = g["new"]
                    rec = {"recorded": [r.get("passed"), r.get("why")], "new": g["new"], "old_root": g.get("old_root"),
                           "old_guard": g.get("old_guard"), "grader": ghash, "folder": str(where[i])}
                    c["regraded"] += 1
                    verified = str(r.get("claim") or "").startswith("verified")
                    if bool(new_ok) != bool(r.get("passed")):
                        c["changed"] += 1
                        kind = "fail->pass" if new_ok else "pass->fail"
                        c[kind] += 1
                        cause = []
                        og = g.get("old_guard") or [None]
                        orr = g.get("old_root") or [None]
                        if orr[0] is not None and bool(orr[0]) != bool(og[0]):
                            cause.append("B1 ownership")
                        if og[0] is not None and bool(og[0]) != bool(new_ok):
                            cause.append("B2 grader")
                        if orr[0] is not None and bool(orr[0]) != bool(r.get("passed")):
                            cause.append("old grader no longer reproduces the row")
                        flips.append((name, r["task"], tag_of(r), r.get("claim"), r.get("passed"), r.get("why"), new_ok, new_why, cause))
                        if verified and not new_ok:
                            c["verified_now_wrong"] += 1
                        if verified and new_ok:
                            c["false_done_now_right"] += 1
                        if not verified and new_ok:
                            c["failed_now_right"] += 1
                    if gerr:
                        c["grader_error"] += 1
                    r["passed"], r["why"], r["grader_error"] = bool(new_ok), new_why, bool(gerr)
                    r["regrade"] = rec
            out_rows.append(r)
        dst = RESULTS / name.replace(".jsonl", ".regraded.jsonl")
        dst.write_text("".join(json.dumps(x) + "\n" for x in out_rows))
        p0 = sum(1 for x in rows if x.get("passed"))
        p1 = sum(1 for x in out_rows if x.get("passed"))
        table.append((name, len(rows), c["regraded"], c["missing"], dup, c["changed"], c["fail->pass"], c["pass->fail"],
                      c["verified_now_wrong"], c["false_done_now_right"], c["failed_now_right"], c["grader_error"], p0, p1))

    print("\n| lane (results file) | rows | regraded | no folder | dup folders | changed | fail->pass | pass->fail | "
          "verified now wrong | false-done now right | failed (unverified) now right | grader_error | pass before -> after |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for t in table:
        print(f"| {t[0]} | {t[1]} | {t[2]} | {t[3]} | {t[4]} | {t[5]} | {t[6]} | {t[7]} | {t[8]} | {t[9]} | {t[10]} | {t[11]} | {t[12]} -> {t[13]} |")
    tot = [sum(t[k] for t in table) for k in range(1, 14)]
    print(f"| **all** | {' | '.join(map(str, tot[:11]))} | {tot[11]} -> {tot[12]} |")
    allg = [r["regrade"] for name in plan for r in map(json.loads, (RESULTS / name.replace(".jsonl", ".regraded.jsonl")).read_text().splitlines())
            if isinstance(r.get("regrade"), dict) and "new" in r["regrade"]]
    same_b2 = sum(1 for g in allg if g["old_guard"] and g["old_guard"][0] == g["new"][0])
    repro = sum(1 for g in allg if g["old_root"] and g["old_root"][0] == g["recorded"][0])
    print(f"\nConsistency: old graders with only the ownership fix agree with the new graders on {same_b2}/{len(allg)} rows "
          f"(a difference would be the B2 rewrite); the old graders as root on an agent-owned copy reproduce the recorded "
          f"verdict on {repro}/{len(allg)} (the rest come from lanes that did not hand the folder to the agent user before "
          f"root graded it, so B1 never hit them).")
    if flips:
        print("\nChanged verdicts:")
        for name, task, tag, claim, was, why, now, nwhy, cause in flips:
            print(f"- {name} {tag}: {was} -> {now} [{', '.join(cause) or '?'}]; claim {claim!r}\n    was: {str(why)[:110]}\n    now: {str(nwhy)[:110]}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--inside":
        inside(sys.argv[2])
    else:
        sys.exit(main(sys.argv[1:]))
