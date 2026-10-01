"""
Validate tasks2.py: for every task, the grader must FAIL on the untouched start
state and PASS (twice, same verdict) after the reference solution in refs2.py.

    python3 validate2.py [task-name ...]
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import refs2  # noqa: E402
from tasks2 import TASKS2  # noqa: E402


def fresh(task) -> Path:
    d = Path(tempfile.mkdtemp(prefix=f"v2-{task.name}-"))
    task.setup(d)
    return d


def main() -> int:
    only = set(sys.argv[1:])
    bad = 0
    for task in TASKS2:
        if only and task.name not in only:
            continue
        t0 = time.time()
        d = fresh(task)
        try:
            ok0, why0 = task.grade(d)
        finally:
            shutil.rmtree(d, ignore_errors=True)
        d = fresh(task)
        try:
            getattr(refs2, "solve_" + task.name.replace("-", "_"))(d)
            ok1, why1 = task.grade(d)
            ok2, why2 = task.grade(d)
        finally:
            shutil.rmtree(d, ignore_errors=True)
        good = (not ok0) and ok1 and ok2 and why1 == why2
        bad += not good
        print(f"{'PASS' if good else 'FAIL'}  {task.name:22} start: {'fail' if not ok0 else 'PASS?!'} ({why0[:70]})"
              f" | solved: {ok1}/{ok2} ({why1[:40]}) [{time.time() - t0:.1f}s]")
    print(f"\n{len(only) or len(TASKS2)} tasks, {bad} problems")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
