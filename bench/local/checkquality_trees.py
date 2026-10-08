"""Check-quality replay, step 2: pristine and reference trees for all 20 tasks.

refs2.py has the 15 tasks2 solvers; the five tasks.py solvers are here. Every
reference tree is graded before it is kept (it must pass; pristine must fail).

    python3 checkquality_trees.py OUT_DIR
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import refs2  # noqa: E402
from tasks import TASKS  # noqa: E402
from tasks2 import TASKS2  # noqa: E402


def sh(cmd: str, cwd: Path) -> str:
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True).stdout


def solve_fix_git(d: Path) -> None:
    lost = sh("git log -g --format=%H --grep='Move to Stanford' HEAD | head -1", d).strip()
    assert lost
    sh(f"git checkout -q master && git merge -q --no-edit {lost}", d)


def solve_log_summary(d: Path) -> None:
    import csv
    import datetime as dt
    import re
    day0 = dt.date(2025, 8, 12)
    counts: dict = {}
    for f in sorted((d / "logs").glob("*.log")):
        day = dt.date.fromisoformat(f.stem)
        for line in f.read_text().splitlines():
            m = re.search(r"\[(ERROR|WARNING|INFO)\]", line)
            if not m:
                continue
            for period, ok in (("today", day == day0), ("last_7_days", day0 - dt.timedelta(days=6) <= day <= day0), ("total", True)):
                if ok:
                    counts[(period, m.group(1))] = counts.get((period, m.group(1)), 0) + 1
    with open(d / "summary.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["period", "severity", "count"])
        for p in ("today", "last_7_days", "total"):
            for s in ("ERROR", "WARNING", "INFO"):
                w.writerow([p, s, counts.get((p, s), 0)])


def solve_regex(d: Path) -> None:
    (d / "regex.txt").write_text(r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.]).*\d{4}-\d{2}-\d{2}" + "\n")


def solve_duration_bug(d: Path) -> None:
    (d / "dur.py").write_text(
        'import re\n\n\ndef parse_duration(s):\n'
        '    """Seconds in a duration string: "90s", "5m", "1h30m", "2h", "1h5m10s",\n'
        '    and a bare number means seconds ("45"). Whitespace around it is ignored."""\n'
        '    s = s.strip()\n'
        '    if s.isdigit():\n        return int(s)\n'
        '    total = 0\n    pos = 0\n'
        '    for m in re.finditer(r"(\\d+)([hms])", s):\n'
        '        if m.start() != pos:\n            raise ValueError(s)\n'
        '        pos = m.end()\n'
        '        total += int(m.group(1)) * {"h": 3600, "m": 60, "s": 1}[m.group(2)]\n'
        '    if pos != len(s) or pos == 0:\n        raise ValueError(s)\n'
        '    return total\n'
    )


def solve_wc_tool(d: Path) -> None:
    (d / "wc.py").write_text(
        'import sys\n\n\ndef counts(data: bytes):\n'
        '    return data.count(b"\\n"), len(data.split()), len(data)\n\n\n'
        'def main(argv):\n'
        '    files = argv[1:]\n'
        '    if not files:\n'
        '        l, w, b = counts(sys.stdin.buffer.read())\n'
        '        print(f"{l} {w} {b}")\n        return\n'
        '    tl = tw = tb = 0\n'
        '    for f in files:\n'
        '        with open(f, "rb") as fh:\n            l, w, b = counts(fh.read())\n'
        '        tl += l; tw += w; tb += b\n'
        '        print(f"{l} {w} {b} {f}")\n'
        '    if len(files) > 1:\n        print(f"{tl} {tw} {tb} total")\n\n\n'
        'if __name__ == "__main__":\n    main(sys.argv)\n'
    )


LOCAL = {"fix-git": solve_fix_git, "log-summary": solve_log_summary, "regex": solve_regex,
         "duration-bug": solve_duration_bug, "wc-tool": solve_wc_tool}


def main() -> None:
    out = Path(sys.argv[1])
    bad = 0
    for T in TASKS + TASKS2:
        for kind in ("pristine", "ref"):
            d = out / T.name / kind
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True)
            T.setup(d)
            if kind == "ref":
                solver = LOCAL.get(T.name) or getattr(refs2, "solve_" + T.name.replace("-", "_"))
                solver(d)
            ok, why = T.grade(d)
            want = kind == "ref"
            flag = "ok " if ok == want else "BAD"
            bad += ok != want
            print(f"{flag} {T.name:20} {kind:8} grader={ok} {why[:60]}")
    print("problems:", bad)


if __name__ == "__main__":
    main()
