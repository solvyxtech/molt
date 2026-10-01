"""
Five local tasks in the style of Terminal-Bench, each with a setup and a
hidden grader. The grader lives here, never in the agent's folder.

    setup(dir)  -> builds the starting state in dir
    PROMPT      -> what the agent is told
    grade(dir)  -> (passed: bool, why: str), run after the agent finishes
"""

from __future__ import annotations

import csv
import datetime as dt
import os
import random
import re
import subprocess
from pathlib import Path


def sh(cmd: str, cwd: Path) -> str:
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True).stdout


# ---------------------------------------------------------------- 1. lost git work
class FixGit:
    name = "fix-git"
    PROMPT = (
        "I made some changes to my site's about page and then checked out master, and now I "
        "can't find those changes. Find them and merge them into master."
    )

    @staticmethod
    def setup(d: Path) -> None:
        sh("git init -q -b master && git config user.email t@t && git config user.name t", d)
        (d / "about.md").write_text("# About\nI work at a startup.\n")
        (d / "index.md").write_text("# Home\n")
        sh("git add -A && git commit -qm init", d)
        sh("git checkout -q --detach", d)
        (d / "about.md").write_text("# About\nI am a postdoc at Stanford.\nI study agents.\n")
        sh("git commit -qam 'Move to Stanford'", d)
        sh("git checkout -q master", d)
        (d / "index.md").write_text("# Home\nWelcome.\n")
        sh("git commit -qam 'welcome line'", d)

    @staticmethod
    def grade(d: Path):
        branch = sh("git rev-parse --abbrev-ref HEAD", d).strip()
        about = sh("git show master:about.md", d)
        index = sh("git show master:index.md", d)
        if "postdoc at Stanford" not in about or "I study agents" not in about:
            return False, "master's about.md lacks the lost changes"
        if "Welcome." not in index:
            return False, "master lost its own welcome line"
        if "<<<<<<<" in about or sh("git status --porcelain", d).strip():
            return False, "conflict markers or uncommitted changes"
        return True, f"merged on {branch}"


# ---------------------------------------------------------------- 2. log summary
class LogSummary:
    name = "log-summary"
    PROMPT = (
        "The logs/ directory holds one file per day named YYYY-MM-DD.log; each line has a "
        "severity in brackets, [ERROR], [WARNING] or [INFO]. Today is 2025-08-12. Write "
        "summary.csv with header period,severity,count and one row per period and severity, "
        "for the periods today, last_7_days (today and the 6 days before it) and total, in "
        "that order, severities in the order ERROR, WARNING, INFO."
    )

    @staticmethod
    def setup(d: Path) -> None:
        rnd = random.Random(7)
        (d / "logs").mkdir()
        day0 = dt.date(2025, 8, 12)
        for k in range(20):
            day = day0 - dt.timedelta(days=k)
            lines = []
            for _ in range(rnd.randint(20, 60)):
                sev = rnd.choice(["ERROR", "WARNING", "INFO", "INFO", "INFO"])
                noise = rnd.choice(["", " retry ERROR-free", " [DEBUG]", ""])
                lines.append(f"{day} 10:00:00 [{sev}] event{noise}")
            (d / "logs" / f"{day}.log").write_text("\n".join(lines) + "\n")

    @staticmethod
    def grade(d: Path):
        p = d / "summary.csv"
        if not p.exists():
            return False, "no summary.csv"
        day0 = dt.date(2025, 8, 12)
        counts = {}
        for f in sorted((d / "logs").glob("*.log")):
            day = dt.date.fromisoformat(f.stem)
            for line in f.read_text().splitlines():
                m = re.search(r"\[(ERROR|WARNING|INFO)\]", line)
                if not m:
                    continue
                sev = m.group(1)
                for period, ok in (("today", day == day0), ("last_7_days", day0 - dt.timedelta(days=6) <= day <= day0), ("total", True)):
                    if ok:
                        counts[(period, sev)] = counts.get((period, sev), 0) + 1
        want = [["period", "severity", "count"]] + [
            [p, s, str(counts.get((p, s), 0))] for p in ("today", "last_7_days", "total") for s in ("ERROR", "WARNING", "INFO")
        ]
        got = list(csv.reader(p.read_text().splitlines()))
        got = [r for r in got if r]
        return (got == want, "matches" if got == want else f"first difference: {next(((a, b) for a, b in zip(got, want) if a != b), (len(got), len(want)))}")


# ---------------------------------------------------------------- 3. regex
class Regex:
    name = "regex"
    PROMPT = (
        "Write a Python-compatible regular expression to regex.txt (the pattern only, one "
        "line) that matches exactly the lines of a log that contain a valid IPv4 address "
        "(four numbers 0-255, no leading zeros) followed later on the same line by a date "
        "in YYYY-MM-DD form. It will be used with re.search on each line."
    )

    CASES = [
        ("user 10.0.0.1 logged in 2024-01-05", True),
        ("from 255.255.255.255 at 1999-12-31", True),
        ("host 192.168.1.20 on 2023-11-02 ok", True),
        ("bad 256.1.1.1 on 2024-01-05", False),
        ("bad 01.2.3.4 on 2024-01-05", False),
        ("no date 10.0.0.1 here", False),
        ("date first 2024-01-05 then 10.0.0.1", False),
        ("1.2.3 on 2024-01-05", False),
        ("x 1.2.3.4.5 on 2024-01-05", False),
        ("a 0.0.0.0 b 2020-02-29", True),
    ]

    @staticmethod
    def setup(d: Path) -> None:
        (d / "sample.log").write_text("\n".join(c for c, _ in Regex.CASES[:4]) + "\n")

    @staticmethod
    def grade(d: Path):
        p = d / "regex.txt"
        if not p.exists():
            return False, "no regex.txt"
        pat = p.read_text().strip().splitlines()[0] if p.read_text().strip() else ""
        try:
            r = re.compile(pat)
        except re.error as e:
            return False, f"invalid regex: {e}"
        bad = [c for c, want in Regex.CASES if bool(r.search(c)) != want]
        return (not bad, "all cases" if not bad else f"wrong on: {bad[0]!r} (+{len(bad) - 1} more)")


# ---------------------------------------------------------------- 4. bug fix with hidden tests
class DurationBug:
    name = "duration-bug"
    PROMPT = (
        "tests in test_dur.py fail. Fix parse_duration in dur.py so it handles every format "
        "its docstring promises. Don't change the tests."
    )

    @staticmethod
    def setup(d: Path) -> None:
        (d / "dur.py").write_text(
            'def parse_duration(s):\n'
            '    """Seconds in a duration string: "90s", "5m", "1h30m", "2h", "1h5m10s",\n'
            '    and a bare number means seconds ("45"). Whitespace around it is ignored."""\n'
            '    s = s.strip()\n'
            '    if s.endswith("s"):\n'
            '        return int(s[:-1])\n'
            '    if s.endswith("m"):\n'
            '        return int(s[:-1]) * 60\n'
            '    return int(s)\n'
        )
        (d / "test_dur.py").write_text(
            "from dur import parse_duration\n\n"
            "def test_minutes():\n    assert parse_duration('5m') == 300\n\n"
            "def test_mixed():\n    assert parse_duration('1h30m') == 5400\n"
        )

    @staticmethod
    def grade(d: Path):
        cases = {"90s": 90, "5m": 300, "1h30m": 5400, "2h": 7200, "1h5m10s": 3910, "45": 45, " 7m ": 420}
        code = (
            "import sys\nsys.path.insert(0, '.')\nfrom dur import parse_duration as p\n"
            f"cases={cases!r}\nbad=[k for k,v in cases.items() if p(k)!=v]\nprint('BAD', bad)\n"
        )
        out = subprocess.run(["python3", "-c", code], cwd=d, capture_output=True, text=True)
        tests = (d / "test_dur.py").read_text()
        if "1h30m" not in tests or "5400" not in tests:
            return False, "the tests were changed"
        if "BAD []" in out.stdout:
            return True, "all formats"
        return False, (out.stdout + out.stderr).strip()[-160:]


# ---------------------------------------------------------------- 5. small CLI tool
class Wc:
    name = "wc-tool"
    PROMPT = (
        "Write wc.py, a Python command-line tool: `python3 wc.py FILE...` prints, for each "
        "file, the line count, word count and byte count, then the file name, separated by "
        "single spaces; with more than one file, a final line with the totals and the word "
        "'total'. With no files it reads stdin and prints the three counts only. Put nothing "
        "else in this directory."
    )

    @staticmethod
    def setup(d: Path) -> None:
        pass

    @staticmethod
    def grade(d: Path):
        p = d / "wc.py"
        if not p.exists():
            return False, "no wc.py"
        extra = [x.name for x in d.iterdir() if x.name not in ("wc.py", ".molt", "__pycache__")]
        if extra:
            return False, f"extra files left behind: {extra}"
        tmp = Path(os.environ.get("TMPDIR", "/tmp")) / "wc-grade"
        tmp.mkdir(exist_ok=True)
        a = tmp / "a.txt"; b = tmp / "b.txt"
        a.write_text("one two\nthree\n"); b.write_text("four five six\n\nseven\n")
        run = lambda args, inp=None: subprocess.run(["python3", str(p), *args], capture_output=True, text=True, input=inp).stdout.strip()
        want1 = f"2 3 {a.stat().st_size} {a}"
        got1 = run([str(a)])
        got2 = run([str(a), str(b)]).splitlines()
        want_total = f"5 7 {a.stat().st_size + b.stat().st_size} total"
        got3 = run([], "x y\nz\n")
        if got1 != want1:
            return False, f"one file: {got1!r} != {want1!r}"
        if not got2 or got2[-1] != want_total:
            return False, f"totals: {got2[-1:]!r} != {want_total!r}"
        if got3 != "2 3 6":
            return False, f"stdin: {got3!r}"
        return True, "matches"


TASKS = [FixGit, LogSummary, Regex, DurationBug, Wc]
