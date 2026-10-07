"""Shared loader for the Bet 2 offline replay (env_values.py, frame_intact.py).

Walks the saved bench work folders, pairs every <task>-molt-<rep> tree with its
grader row, and reads the sealed checks out of its .maat journal. No model,
no network.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache/maat-bench"
RESULTS = CACHE / "container-results"
CW = CACHE / "container-work"

sys.path.insert(0, str(HERE))
from tasks import TASKS  # noqa: E402
from tasks2 import TASKS2  # noqa: E402

TASK_BY_NAME = {T.name: T for T in TASKS + TASKS2}
RUN_DIR = re.compile(r"^(?P<task>.+)-molt-(?P<rep>\d+)$")


def result_key(root_name: str) -> str:
    """container-work/v11-new-s3 -> v11-new; grok1-2 -> grok1; m8b2-1 -> m8b2."""
    n = re.sub(r"-s\d+$", "", root_name)
    if (RESULTS / f"results-{n}.jsonl").exists():
        return n
    return re.sub(r"-\d+$", "", root_name)


def roots() -> list[tuple[str, Path]]:
    """(results key, folder holding <task>-molt-<rep> trees)."""
    out: list[tuple[str, Path]] = []
    pat = re.compile(r"^(v9|v10|v11|v12)-|^grok|^q\d|^m8b|^fail5")
    for d in sorted(CW.iterdir()):
        if d.is_dir() and pat.match(d.name):
            out.append((result_key(d.name), d))
    out.append(("gem1", CACHE / "work-gem1"))
    out.append(("sub-gemini", CACHE / "work-sub-gemini"))
    out.append(("sub-grok", CACHE / "work-sub-grok"))
    return [(k, p) for k, p in out if p.is_dir()]


def load_results(key: str) -> dict[tuple[str, int], dict]:
    f = RESULTS / f"results-{key}.jsonl"
    rows: dict[tuple[str, int], dict] = {}
    if f.exists():
        for line in f.read_text().splitlines():
            r = json.loads(line)
            rows[(r["task"], r["rep"])] = r
    return rows


def journal_events(run: Path) -> list[dict]:
    ev: list[dict] = []
    logd = run / ".maat/log"
    for f in sorted(logd.glob("*.jsonl")) if logd.is_dir() else []:
        for line in f.read_text(errors="replace").splitlines():
            try:
                ev.append(json.loads(line))
            except Exception:
                pass
    ev.sort(key=lambda e: (e.get("iso", ""), e.get("seq", 0)))
    return ev


def bar_runs(ev: list[dict]) -> list[dict]:
    return [e["data"] for e in ev if e.get("kind") == "bar_run"]


def drafted(check: dict) -> bool:
    return str(check.get("name", "")).startswith("task:")


def runs() -> list[dict]:
    """One record per saved tree that has a grader row."""
    out = []
    for key, root in roots():
        res = load_results(key)
        for r in sorted(p for p in root.iterdir() if p.is_dir()):
            # a shard folder holds the trees; a work folder (work-gem1) is the trees
            cands = [r] if RUN_DIR.match(r.name) else sorted(c for c in r.iterdir() if c.is_dir())
            for c in cands:
                m = RUN_DIR.match(c.name)
                if not m:
                    continue
                task, rep = m["task"], int(m["rep"])
                row = res.get((task, rep))
                if row is None or task not in TASK_BY_NAME:
                    continue
                out.append({"arm": key, "task": task, "rep": rep, "dir": c, "row": row,
                            "passed": bool(row["passed"]), "id": f"{key}/{task}#{rep}"})
        # root itself may directly hold trees (work-gem1)
        for c in sorted(p for p in root.iterdir() if p.is_dir() and RUN_DIR.match(p.name)):
            pass
    return out


_pristine: dict[str, Path] = {}
_tmp = Path(tempfile.mkdtemp(prefix="bet2-pristine-"))


def pristine(task: str) -> Path:
    if task not in _pristine:
        d = _tmp / task
        d.mkdir()
        TASK_BY_NAME[task].setup(d)
        _pristine[task] = d
    return _pristine[task]


def cleanup() -> None:
    shutil.rmtree(_tmp, ignore_errors=True)
