"""
Validate tasks3.py. For every task: the grader must FAIL on the untouched start state, PASS (twice, same
verdict) after the reference solution, and FAIL after each deliberately wrong solution.

    $REF (env for solve.sh) is the task's reference directory, so a wrong solution can start from it.
    reference_solutions/<task>/            files dropped into the task folder (after setup);
                                           an optional solve.sh is run there (bash) instead of being copied
    reference_solutions/_wrong/<task>/<n>/ the same layout, for a plausible-but-wrong solution

    python3 validate3.py [task-name ...]
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tasks3 import TASKS3  # noqa: E402

REFS = HERE / "reference_solutions"


def fresh(task) -> Path:
    d = Path(tempfile.mkdtemp(prefix=f"v3-{task.name}-"))
    task.setup(d)
    return d


def apply(src: Path, d: Path, ref: Path) -> None:
    for p in sorted(src.rglob("*")):
        rel = p.relative_to(src)
        if rel.parts[0] == "solve.sh" or p.is_dir():
            continue
        (d / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, d / rel)
    if (src / "solve.sh").exists():
        r = subprocess.run(["bash", str(src / "solve.sh")], cwd=d, capture_output=True, text=True, env={**os.environ, "REF": str(ref)})
        if r.returncode != 0:
            raise RuntimeError(f"solve.sh failed in {src}: {r.stderr[-300:]}")


def main() -> int:
    only = set(sys.argv[1:])
    bad = 0
    n = 0
    names = [t.name for t in TASKS3]
    assert len(names) == len(set(names)), "duplicate task names"
    for task in TASKS3:
        if only and task.name not in only:
            continue
        n += 1
        t0 = time.time()
        problems = []
        d = fresh(task)
        try:
            ok0, why0 = task.grade(d)
        finally:
            shutil.rmtree(d, ignore_errors=True)
        if ok0:
            problems.append("grader PASSES the untouched start state")
        ref = REFS / task.name
        if not ref.is_dir():
            problems.append("no reference solution")
            ok1 = ok2 = False
            why1 = ""
        else:
            d = fresh(task)
            try:
                apply(ref, d, ref)
                ok1, why1 = task.grade(d)
                ok2, why2 = task.grade(d)
            finally:
                shutil.rmtree(d, ignore_errors=True)
            if not ok1:
                problems.append(f"reference fails: {why1}")
            elif not ok2 or why1 != why2:
                problems.append(f"grader not repeatable: {why1!r} then {why2!r}")
        wrongs = sorted((REFS / "_wrong" / task.name).glob("*")) if (REFS / "_wrong" / task.name).is_dir() else []
        wnote = []
        for w in wrongs:
            d = fresh(task)
            try:
                apply(w, d, ref)
                okw, whyw = task.grade(d)
            finally:
                shutil.rmtree(d, ignore_errors=True)
            if okw:
                problems.append(f"wrong solution {w.name} PASSES")
            wnote.append(f"{w.name}:{whyw[:45]}")
        bad += bool(problems)
        print(f"{'FAIL' if problems else 'PASS'}  {task.name:24} start: {why0[:50]!r} | ref: {ok1} | wrong x{len(wrongs)} [{time.time() - t0:.1f}s]")
        for p in problems:
            print("      !!", p)
        for w in wnote:
            print("      wrong", w)
    print(f"\n{n} tasks, {bad} problems")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
