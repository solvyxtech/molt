"""What the seal-time pre-work screen would have done to 2026-10-07's checks.

    python3 prework_screen_replay.py [LANE_PREFIX ...]      (default: 2026-10-07's lanes)

The screen (src/criteria.ts `screen`, src/checklint.ts `cannotFail`): before a
drafted check is sealed it is linted for constructs that cannot fail (L16) and
tried on a copy of the project taken before the work. One that is flagged, or
already passes there (P1), or prints FAIL and exits 0 (L16), is sent back to
the drafter once; a redraft that is flagged again is dropped.

Offline proxy: every drafted check sealed in today's runs (released commands,
or the commands older builds journalled with each bar run) is linted through
the built dist/checklint.js and run, under bash with a 10 s limit, on a fresh
copy of its task's pristine tree (bench tasks' own setup). Ports 8080-8099 are
moved to 28080-28099 so a listener on this machine cannot answer for a server
that does not exist yet. The bench container's tool set differs from this
Mac's, so a P1 verdict here is an estimate.

Then, for each run labelled verified with an independent check behind it
(#32), it asks whether the verdict rested only on checks the screen would
have sent back: such a run would have been judged by whatever the redraft
produced, or by nothing.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import discriminating_replay as dr  # noqa: E402
from replay_common import pristine, cleanup as cleanup_pristine  # noqa: E402

REPO = HERE.parents[1]


def cannot_fail(runs: list[str]) -> list[str | None]:
    js = (
        f"import {{ cannotFail }} from {json.dumps(str(REPO / 'dist/checklint.js'))};"
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(cannotFail))));"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", js], input=json.dumps(runs), capture_output=True, text=True, check=True)
    return json.loads(p.stdout)


def reports_failure(run: str, stdout: str) -> bool:
    """src/evidence.ts reportsFailure, through the built dist/evidence.js."""
    if not stdout.strip():
        return False
    js = (
        f"import {{ reportsFailure }} from {json.dumps(str(REPO / 'dist/evidence.js'))};"
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(JSON.stringify(!!reportsFailure(a.run,a.out)))});"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", js], input=json.dumps({"run": run, "out": stdout[-65536:]}), capture_output=True, text=True, check=True)
    return json.loads(p.stdout)


def run_in(tree: Path, run: str) -> tuple[int | None, str]:
    """(exit code or None on timeout, stdout) for `run` under bash on a fresh copy of `tree` without .maat."""
    tmp = Path(tempfile.mkdtemp(prefix="atbar-"))
    work = tmp / "w"
    shutil.copytree(tree, work, symlinks=True, ignore=shutil.ignore_patterns(".maat", ".molt"))
    cmd = re.sub(r"\b80([89]\d)\b", r"280\1", run)
    try:
        p = subprocess.Popen(["bash", "-c", cmd], cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             start_new_session=True, stdin=subprocess.DEVNULL)
        try:
            out, _ = p.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.communicate()
            return None, ""
        finally:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return p.returncode, out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def golden_unproven(task: str, runs: list[str]) -> list[bool]:
    """Per command: its value rests only on an expected file that is not in the task's pristine tree (src/golden.ts)."""
    base = pristine(task)
    js = (
        f"import {{ assertsValue }} from {json.dumps(str(REPO / 'dist/tiers.js'))};"
        "import { existsSync } from 'node:fs'; import { join, isAbsolute } from 'node:path';"
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const {base, runs}=JSON.parse(s);"
        "console.log(JSON.stringify(runs.map(r=>assertsValue(r) && !assertsValue(r, g=>existsSync(isAbsolute(g)?g:join(base,g))))))});"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", js], input=json.dumps({"base": str(base), "runs": runs}), capture_output=True, text=True, check=True)
    return json.loads(p.stdout)


def try_before(task: str, run: str) -> tuple[str, bool]:
    """('passed'|'failed'|'broken', printed FAIL) for `run` on a fresh copy of the task's pristine tree."""
    tmp = Path(tempfile.mkdtemp(prefix="prework-"))
    work = tmp / "w"
    shutil.copytree(pristine(task), work, symlinks=True)
    cmd = re.sub(r"\b80([89]\d)\b", r"280\1", run)
    try:
        p = subprocess.Popen(["bash", "-c", cmd], cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             start_new_session=True, stdin=subprocess.DEVNULL)
        try:
            out, err = p.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.communicate()
            return "failed", False
        finally:
            try:
                os.killpg(p.pid, signal.SIGKILL)  # whatever it left running in the background
            except ProcessLookupError:
                pass
        if p.returncode in (126, 127):
            return "broken", False
        if p.returncode == 0:
            # As Maat reads it (src/evidence.ts reportsFailure): a check that
            # printed False/FAIL as its last line, or whose `echo $?` tail was
            # not 0, failed whatever it exited.
            if reports_failure(run, out):
                return "failed", True
            return "passed", bool(re.search(r"\bFAIL(?:ED)?\b", out + err))
        return "failed", False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def sealed_checks(tree: Path) -> dict[str, str]:
    runs: dict[str, str] = {}
    for e in dr.journal(tree):
        d = e.get("data", {})
        if e.get("kind") == "bar_run":
            for c in d.get("checks", []):
                if c.get("name", "").startswith("task:") and not str(c.get("detail", "")).startswith("[withheld"):
                    runs.setdefault(c["name"], c.get("detail", ""))
        elif e.get("kind") == "note" and d.get("kind") == "checks-released":
            for c in d.get("checks", []):
                runs[dr.task(c["name"])] = c.get("run", "")
    return {n: r for n, r in runs.items() if r and n != "task:reference"}


def main(argv: list[str]) -> int:
    prefixes = argv or dr.TODAY
    lanes = sorted(p for p in dr.CW.iterdir() if p.is_dir() and any(re.fullmatch(rf"{re.escape(x)}-\d+", p.name) for x in prefixes))
    cache: dict[tuple[str, str], tuple[str, bool]] = {}
    checks: list[dict] = []
    verified: list[dict] = []
    for lane in lanes:
        rf = dr.results_file(lane)
        rows = dr.grader_rows(rf) if rf else {}
        for tree in sorted(lane.iterdir()):
            m = dr.RUN_DIR.match(tree.name)
            if not m or not tree.is_dir() or not (tree / ".maat/log").exists():
                continue
            sealed = sealed_checks(tree)
            for n, run in sealed.items():
                checks.append({"run_id": f"{lane.name}/{tree.name}", "task": m["task"], "name": n, "run": run})
            row = rows.get((m["task"], m["arm"], int(m["rep"])))
            claim = (row or {}).get("claim") or ""
            if not claim.startswith("verified"):
                continue
            independent = claim.startswith(("verified (independent checks", "verified (your checks)")) or m["arm"] != "self"
            if not independent:
                continue
            a = dr.analyse(tree, row)
            verified.append({"run_id": f"{lane.name}/{tree.name}", "right": bool(row.get("passed")), "strong": a["strong"],
                             "task": m["task"], "tree": tree, "runs": {n: sealed.get(n, "") for n in a["strong"]}})
    flags = cannot_fail([c["run"] for c in checks])
    for c, f in zip(checks, flags):
        key = (c["task"], c["run"])
        if key not in cache:
            cache[key] = try_before(c["task"], c["run"])
        c["static"] = f
        c["before"], c["printed_fail"] = cache[key]
        c["redraft"] = bool(f) or c["before"] == "passed"
    by = Counter()
    for c in checks:
        by["checks"] += 1
        by["static L16"] += bool(c["static"])
        by["P1 passes before (not L16)"] += (not c["static"]) and c["before"] == "passed"
        by["L16 printed FAIL, exit 0"] += c["printed_fail"]
        by["redrafted (any)"] += c["redraft"]
        by["broken before (127/126)"] += c["before"] == "broken"
    print("## Sealed drafted checks in today's runs")
    for k, v in by.items():
        print(f"  {k:32} {v}")
    print("\n## Unique commands flagged, by reason")
    seen = set()
    for c in checks:
        if c["redraft"] and (c["task"], c["run"]) not in seen:
            seen.add((c["task"], c["run"]))
    print(f"  {len(seen)} unique (task, command) pairs")
    flagged = {(c["run_id"], c["name"]) for c in checks if c["redraft"]}
    out = defaultdict(list)
    for v in verified:
        if not v["strong"]:
            kind = "no value check"
        elif all((v["run_id"], n) in flagged for n in v["strong"]):
            kind = "rested only on checks the screen sends back"
        else:
            kind = "kept a value check the screen passes"
        out[(kind, v["right"])].append(v["run_id"])
    # At the bar, on the finished tree: does a strong check now fail on its own
    # words (printed False/FAIL with exit 0), and does its value rest only on a
    # golden file the worker could have written?
    print("\n## Verified runs after #32 (independent): what the bar-time reads do to their value checks")
    bar = defaultdict(list)
    for v in verified:
        runs = {n: r for n, r in v["runs"].items() if r}
        if not runs:
            continue
        unproven = dict(zip(runs, golden_unproven(v["task"], list(runs.values()))))
        words = {}
        for n, r in runs.items():
            code, said = run_in(v["tree"], r)
            words[n] = code == 0 and reports_failure(r, said)
        left = [n for n in runs if not words[n] and not unproven[n]]
        if any(words.values()):
            bar[("a value check now fails on its own words", v["right"])].append(f"{v['run_id']}  {[n for n in runs if words[n]]}")
        if any(unproven.values()):
            bar[("a value check rests on a golden file not in the pristine tree", v["right"])].append(f"{v['run_id']}  {[n for n in runs if unproven[n]]}")
        if not left:
            bar[("no value check left: would not be verified", v["right"])].append(v["run_id"])
    cleanup_pristine()
    if not bar:
        print("  none affected")
    for (kind, right), ids in sorted(bar.items()):
        print(f"  {'right' if right else 'WRONG'}  {kind}: {len(ids)}")
        for i in ids:
            print(f"      {i}")

    print("\n## Verified runs after #32 (independent), by what the screen does to their value checks")
    for (kind, right), ids in sorted(out.items()):
        print(f"  {'right' if right else 'WRONG'}  {kind}: {len(ids)}")
        for i in ids:
            print(f"      {i}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
