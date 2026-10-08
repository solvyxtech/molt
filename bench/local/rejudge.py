"""
Re-judge an oracle_replay.py results file with the product's rules, no model calls.

oracle_replay.py records the checks each arm produced; this runs them again
against every saved workspace the way the CLI would:

  - preflight (dist/criteria.js preflightCriteria) on the untouched project
    drops a check that cannot run or reports its own bug before any work;
  - at the claim, a drafted check whose failure is its own bug
    (checkSelfError) is retired, and so is the reference on exit 3;
  - "verified" = at least one check left, and every check left passed.
    All retired -> unverified, never verified.

    python3 rejudge.py RESULTS.jsonl [--snap DIR] [--arms A,C]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tasks import TASKS  # noqa: E402
from tasks2 import TASKS2  # noqa: E402
from tasks3 import TASKS3  # noqa: E402

REPO = HERE.parent.parent
BY = {T.name: T for T in TASKS + TASKS2 + TASKS3}


def node(js: str, stdin: str = "") -> str:
    p = subprocess.run(["node", "--input-type=module", "-e", js], input=stdin, capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-500:])
    return p.stdout


def preflight_broken(checks: list[str], cwd: Path) -> set[int]:
    js = f"""
import {{ preflightCriteria }} from '{REPO}/dist/criteria.js';
const runs = JSON.parse(await new Promise(r => {{ let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => r(s)); }}));
const broken = await preflightCriteria(runs.map((run, i) => ({{ name: 'c' + i, kind: 'command', run, expectExit: 0 }})), {{ cwd: {json.dumps(str(cwd))}, timeoutMs: 120000 }});
process.stdout.write(JSON.stringify(broken.map(b => Number(b.name.slice(1)))));
"""
    return set(json.loads(node(js, json.dumps(checks))))


def self_errors(outputs: list[str]) -> list[bool]:
    js = f"""
import {{ checkSelfError }} from '{REPO}/dist/criteria.js';
const outs = JSON.parse(await new Promise(r => {{ let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => r(s)); }}));
process.stdout.write(JSON.stringify(outs.map(o => checkSelfError(o) !== null)));
"""
    return json.loads(node(js, json.dumps(outputs)))


def run_all(checks: list[str], ws: Path) -> list[tuple[int, str]]:
    tmp = Path(tempfile.mkdtemp(prefix="rejudge-"))
    try:
        shutil.copytree(ws, tmp / "w", symlinks=True)
        out = []
        for c in checks:
            try:
                p = subprocess.run(c, shell=True, cwd=tmp / "w", capture_output=True, text=True, timeout=180)
                out.append((p.returncode, p.stdout + p.stderr))
            except subprocess.TimeoutExpired:
                out.append((124, "timeout"))
        return out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verdict(arm: str, checks: list[str], ws: Path) -> tuple[str, str]:
    if not checks:
        return "unverified", "no checks"
    res = run_all(checks, ws)
    errs = self_errors([o for _, o in res])
    live = []
    for i, (code, out) in enumerate(res):
        reference = arm in ("B", "C")
        retired = (code == 3) if reference else (code != 0 and errs[i])
        if not retired:
            live.append((code, out))
    if not live:
        return "unverified", "every check retired"
    bad = [o for c, o in live if c != 0]
    return ("verified", "") if not bad else ("refused", bad[0][-200:])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("results")
    ap.add_argument("--snap", default=os.environ.get("SNAP", str(Path.home() / ".cache/maat-bench/work")))
    ap.add_argument("--arms", default="A,B,C")
    ap.add_argument("--out")
    a = ap.parse_args()
    snap = Path(a.snap)
    recs = [json.loads(l) for l in open(a.results) if l.strip()]
    latest: dict = {}
    for r in recs:
        latest[(r["task"], r["arm"])] = r
    tot = defaultdict(lambda: defaultdict(int))
    lines = []
    for (task, arm), r in sorted(latest.items()):
        if arm not in a.arms.split(","):
            continue
        T = BY[task]
        checks = r["meta"].get("checks") if arm == "A" else ([r["meta"]["run"]] if r["meta"].get("applies") and r["meta"].get("run") else [])
        checks = checks or []
        pristine = Path(tempfile.mkdtemp(prefix="rejudge-p-")) / "p"
        pristine.mkdir()
        T.setup(pristine)
        if arm == "A" and checks:
            drop = preflight_broken(checks, pristine)
            checks = [c for i, c in enumerate(checks) if i not in drop]
        pv, _ = verdict(arm, checks, pristine)
        row = {"task": task, "arm": arm, "n_checks": len(checks), "pristine": pv, "ws": []}
        for w in r["rows"]:
            ws = snap / w["ws"]
            if not ws.is_dir():
                continue
            v, why = verdict(arm, checks, ws)
            row["ws"].append({"ws": w["ws"], "right": w["right"], "verdict": v, "why": why})
            k = tot[arm]
            k["right" if w["right"] else "wrong"] += 1
            k[f"{'right' if w['right'] else 'wrong'}_{v}"] += 1
        tot[arm]["pristine_verified"] += pv == "verified"
        tot[arm]["tasks"] += 1
        tot[arm]["tasks_with_checks"] += bool(checks)
        lines.append(row)
        rv = sum(1 for x in row["ws"] if x["right"] and x["verdict"] == "verified")
        rn = sum(1 for x in row["ws"] if x["right"])
        wv = sum(1 for x in row["ws"] if not x["right"] and x["verdict"] == "verified")
        wn = sum(1 for x in row["ws"] if not x["right"])
        print(f"{task:22} {arm} checks={len(checks)}  right verified {rv}/{rn}  wrong verified {wv}/{wn}  pristine {pv}", flush=True)
    print()
    for arm, k in sorted(tot.items()):
        print(
            f"arm {arm}: tasks {k['tasks']} (with checks {k['tasks_with_checks']}) | "
            f"right work: verified {k['right_verified']}/{k['right']}, refused {k['right_refused']}, unverified {k['right_unverified']} | "
            f"WRONG work: verified {k['wrong_verified']}/{k['wrong']}, refused {k['wrong_refused']}, unverified {k['wrong_unverified']} | "
            f"pristine verified {k['pristine_verified']}"
        )
    if a.out:
        Path(a.out).write_text("".join(json.dumps(l) + "\n" for l in lines))


if __name__ == "__main__":
    main()
