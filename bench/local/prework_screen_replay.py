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
            verified.append({"run_id": f"{lane.name}/{tree.name}", "right": bool(row.get("passed")), "strong": a["strong"]})
    flags = cannot_fail([c["run"] for c in checks])
    for c, f in zip(checks, flags):
        key = (c["task"], c["run"])
        if key not in cache:
            cache[key] = try_before(c["task"], c["run"])
        c["static"] = f
        c["before"], c["printed_fail"] = cache[key]
        c["redraft"] = bool(f) or c["before"] == "passed"
    cleanup_pristine()
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
    print("\n## Verified runs after #32 (independent), by what the screen does to their value checks")
    for (kind, right), ids in sorted(out.items()):
        print(f"  {'right' if right else 'WRONG'}  {kind}: {len(ids)}")
        for i in ids:
            print(f"      {i}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
