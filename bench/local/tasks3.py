"""
Twenty-two more local tasks, harder and more varied than tasks.py / tasks2.py, same shape:

    setup(dir)  -> builds the starting state in dir
    PROMPT      -> what the agent is told
    grade(dir)  -> (passed: bool, why: str), run after the agent finishes

Graders run the deliverable on cases of their own (some implied by the prompt rather than listed
in it) and never depend on the network. Anything that mutates state runs on a scratch copy of dir.
Reference and deliberately-wrong solutions live in reference_solutions/ and are exercised by
validate3.py.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import os
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unicodedata
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tasks2 import IGNORED, all_files, py_check, run, scratch_copy, sh  # noqa: E402,F401

VCS_ENV = {
    "GIT_AUTHOR_NAME": "Dev", "GIT_AUTHOR_EMAIL": "dev@example.com",
    "GIT_COMMITTER_NAME": "Dev", "GIT_COMMITTER_EMAIL": "dev@example.com",
    "FILTER_BRANCH_SQUELCH_WARNING": "1",
}


def runb(args, cwd=None, inp=None, env=None, timeout=30):
    """Run a command with bytes in/out (locale-independent); env entries are added to os.environ."""
    e = dict(os.environ)
    e.update(env or {})
    if isinstance(inp, str):
        inp = inp.encode()
    return subprocess.run(args, cwd=cwd, input=inp, capture_output=True, env=e, timeout=timeout)


def vcs(d: Path, *args, date: str | None = None):
    env = dict(VCS_ENV)
    if date:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = date
    r = runb(["git", *args], cwd=d, env=env)
    return r.stdout.decode(errors="replace")


def write(d: Path, rel: str, text):
    p = d / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(text if isinstance(text, bytes) else text.encode())


def digest(root: Path) -> dict:
    out = {}
    for rel in sorted(all_files(root)):
        out[rel] = hashlib.sha256((root / rel).read_bytes()).hexdigest()
    return out


# ================================================================ 1. dedupe-contacts
class DedupeContacts:
    name = "dedupe-contacts"
    PROMPT = (
        "contacts.csv has columns id,name,email,phone and a lot of duplicate people. Write dedupe.py: "
        "`python3 dedupe.py in.csv out.csv` merges them. Two rows are the same person if they have the same "
        "email (ignoring case and surrounding spaces) or the same phone number (compare digits only, and only "
        "the last 10 digits when there are more than 10); blank emails never match, and neither do phones with "
        "fewer than 7 digits. Sameness is transitive. Write one row per person to out.csv with the same header: "
        "id is the smallest id in the group; name, email and phone are the first non-blank value (stripped of "
        "surrounding spaces, otherwise kept as written) among the group's rows taken in ascending numeric id "
        "order, or blank if there is none. Rows go in ascending numeric id order. Then run it on contacts.csv "
        "to produce contacts_clean.csv."
    )

    ROWS = [
        (1, "Ada Lovelace", "ada@x.org", "+1 (555) 010-2000"),
        (2, "A. Lovelace", "ADA@X.ORG ", ""),
        (3, "", "", "555-010-2000"),
        (4, "Ben Ng", "ben@x.org", "12345"),
        (5, "Benjamin Ng", "bn@y.org", "12345"),
        (6, "Cleo, Jr.", "cleo@x.org", "00 44 20 7946 0958"),
        (7, "Cleo Jones", "", "020 7946 0958"),
        (10, " Dmitri ", "d@z.com", ""),
        (9, "Dima", "", "555 0100"),
        (100, "Dmitri P.", "D@Z.com", "555-0100"),
        (8, "Esi", "", ""),
        (11, "Esi Mensah", "", ""),
    ]

    @staticmethod
    def gen(seed=5, people=120, rows=400):
        rnd = random.Random(seed)
        ppl = []
        for i in range(people):
            ppl.append((f"Person {i}", f"user{i}@mail{i % 7}.com", "".join(rnd.choice("0123456789") for _ in range(10))))
        out = []
        ids = rnd.sample(range(1000, 5000), rows)
        for rid in ids:
            n, e, p = rnd.choice(ppl)
            if rnd.random() < 0.3:
                e = ""
            elif rnd.random() < 0.4:
                e = " " + e.upper() + " "
            if rnd.random() < 0.3:
                p = ""
            else:
                f = rnd.choice(["{}", "+1 {}", "{}.{}", "({}) {}-{}", "001{}"])
                if f.count("{}") == 1:
                    p = f.format(p)
                elif f.startswith("("):
                    p = f.format(p[:3], p[3:6], p[6:])
                else:
                    p = f.format(p[:3], p[3:])
            if rnd.random() < 0.15:
                p = "".join(rnd.choice("0123456789") for _ in range(rnd.randint(3, 6)))
            if rnd.random() < 0.2:
                n = ""
            out.append((rid, n, e, p))
        return out

    @staticmethod
    def write_csv(path: Path, rows):
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "name", "email", "phone"])
            w.writerows(rows)

    @staticmethod
    def oracle(rows):
        rows = [dict(zip(("id", "name", "email", "phone"), (str(x) for x in r))) for r in rows]
        par = list(range(len(rows)))

        def find(x):
            while par[x] != x:
                par[x] = par[par[x]]
                x = par[x]
            return x
        seen = {}
        for i, r in enumerate(rows):
            keys = []
            e = r["email"].strip().lower()
            if e:
                keys.append(("e", e))
            dg = re.sub(r"\D", "", r["phone"])
            if len(dg) >= 7:
                keys.append(("p", dg[-10:]))
            for k in keys:
                if k in seen:
                    par[find(i)] = find(seen[k])
                else:
                    seen[k] = i
        groups = {}
        for i, r in enumerate(rows):
            groups.setdefault(find(i), []).append(r)
        out = []
        for g in groups.values():
            g.sort(key=lambda r: int(r["id"]))
            row = {"id": g[0]["id"]}
            for k in ("name", "email", "phone"):
                row[k] = next((r[k].strip() for r in g if r[k].strip()), "")
            out.append(row)
        out.sort(key=lambda r: int(r["id"]))
        return out

    @staticmethod
    def all_rows():
        return [list(r) for r in DedupeContacts.ROWS] + DedupeContacts.gen(3, 40, 120)

    @staticmethod
    def setup(d: Path) -> None:
        DedupeContacts.write_csv(d / "contacts.csv", DedupeContacts.all_rows())

    @staticmethod
    def grade(d: Path):
        if not (d / "dedupe.py").exists():
            return False, "no dedupe.py"
        tmp, w = scratch_copy(d)
        try:
            cases = {"contacts.csv": DedupeContacts.all_rows(), "big.csv": DedupeContacts.gen(5, 120, 400)}
            for fn, rows in cases.items():
                DedupeContacts.write_csv(w / fn, rows)
                r = runb(["python3", "dedupe.py", fn, "o_" + fn], cwd=w)
                if r.returncode != 0 or not (w / ("o_" + fn)).exists():
                    return False, f"dedupe.py failed on {fn}: {r.stderr.decode()[-150:]}"
                with open(w / ("o_" + fn), newline="") as f:
                    rd = list(csv.reader(f))
                if not rd or rd[0] != ["id", "name", "email", "phone"]:
                    return False, f"bad header {rd[:1]}"
                got = [dict(zip(rd[0], x)) for x in rd[1:]]
                want = DedupeContacts.oracle(rows)
                if got != want:
                    for a, b in zip(got, want):
                        if a != b:
                            return False, f"{fn}: got {a} want {b}"
                    return False, f"{fn}: {len(got)} rows, want {len(want)}"
            cc = d / "contacts_clean.csv"
            if not cc.exists():
                return False, "no contacts_clean.csv"
            with open(cc, newline="") as f:
                rd = list(csv.reader(f))
            if not rd or [dict(zip(rd[0], x)) for x in rd[1:]] != DedupeContacts.oracle(cases["contacts.csv"]):
                return False, "contacts_clean.csv does not match the dedupe of contacts.csv"
            return True, "all inputs"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 2. money-split
class MoneySplit:
    name = "money-split"
    PROMPT = (
        "Write alloc.py: `python3 alloc.py TOTAL W1 W2 ...` splits a sum of money between parties in proportion to "
        "their integer weights and prints each party's share on its own line with exactly two decimals, in the "
        "order given. Shares are whole cents and must add up to TOTAL exactly: give every party the floor of its "
        "exact share, then hand the leftover cents out one each to the parties with the largest fractional "
        "remainders (ties go to the party listed first). TOTAL is a non-negative decimal with at most two decimals "
        "(e.g. 100, 0.05, 1234.5); weights are non-negative integers. On any bad input (no weights, a negative or "
        "non-integer weight, all weights zero, a TOTAL that is not a decimal with at most two places) print "
        "nothing to stdout, write a message to stderr and exit with status 1. Don't use floating point."
    )

    @staticmethod
    def oracle(total, ws):
        if not re.fullmatch(r"\d+(\.\d{1,2})?", total):
            return None
        cents = int((Decimal(total) * 100).to_integral_value())
        if not ws or not all(re.fullmatch(r"\d+", w) for w in ws):
            return None
        ws = [int(w) for w in ws]
        S = sum(ws)
        if S == 0:
            return None
        base = [cents * w // S for w in ws]
        rem = [cents * w % S for w in ws]
        left = cents - sum(base)
        for i in sorted(range(len(ws)), key=lambda i: (-rem[i], i))[:left]:
            base[i] += 1
        return [f"{c // 100}.{c % 100:02d}" for c in base]

    CASES = [
        ("100", ["1", "1", "1"]), ("0.05", ["1", "1", "1"]), ("0.01", ["1", "1"]), ("10.00", ["0", "3", "0", "7"]),
        ("1234.5", ["5", "3", "2"]), ("0", ["1", "2"]), ("99.99", ["1"] * 7),
        ("1000000000.07", ["17", "23", "59", "1"]), ("0.10", ["1", "2", "3"]), ("5", ["7"]),
        ("100", ["0", "0"]), ("100", []), ("100", ["-1", "2"]), ("100", ["1.5", "2"]), ("1.234", ["1", "1"]),
        ("abc", ["1"]), ("-5", ["1", "2"]), ("0.07", ["1"] * 10),
        ("2.00", ["1", "1", "1", "0", "1", "1", "1"]), ("8.33", ["333", "333", "334"]),
        ("0.03", ["1", "0", "1", "1"]), ("19.99", ["3", "3"]),
    ]

    @staticmethod
    def setup(d: Path) -> None:
        (d / "README.txt").write_text("Splits invoices between cost centres.\n")

    @staticmethod
    def grade(d: Path):
        if not (d / "alloc.py").exists():
            return False, "no alloc.py"
        rnd = random.Random(2)
        cases = list(MoneySplit.CASES)
        for _ in range(60):
            n = rnd.randint(1, 8)
            cases.append((f"{rnd.randint(0, 10 ** rnd.randint(1, 9))}.{rnd.randint(0, 99):02d}", [str(rnd.choice([0, 1, 1, 2, 3, 7, 10, 333])) for _ in range(n)]))
        for total, ws in cases:
            try:
                r = runb(["python3", "alloc.py", total, *ws], cwd=d)
            except subprocess.TimeoutExpired:
                return False, "timeout"
            want = MoneySplit.oracle(total, ws)
            if want is None:
                if r.returncode != 1 or r.stdout.strip():
                    return False, f"{total} {ws}: want exit 1 and no stdout, got {r.returncode} {r.stdout[:30]!r}"
                continue
            got = r.stdout.decode().split("\n")
            if r.returncode != 0 or got != want + [""]:
                return False, f"{total} {ws}: got {got[:8]} want {want[:8]}"
        return True, f"{len(cases)} cases"


# ================================================================ 3. fix-daily-buckets
class FixDailyBuckets:
    name = "fix-daily-buckets"
    PROMPT = (
        "Our nightly event report (`python3 report.py events.jsonl`) prints a different count per day on the "
        "Berlin server than on my laptop, even though both read the same file: the numbers are fine most of the "
        "day but wrong around midnight, and it only shows up for some events. The report must give exactly the "
        "same output whatever timezone the machine is set to; days and hours are UTC (an event timestamp with an "
        "explicit offset means that instant, a timestamp without one is already UTC). Fix it."
    )

    BUCKET = '''from datetime import datetime


def to_dt(ts):
    """Event timestamp (epoch seconds, or an ISO-8601 string) -> datetime."""
    if isinstance(ts, str):
        return datetime.fromisoformat(ts)
    return datetime.fromtimestamp(ts)


def day_of(ts):
    return to_dt(ts).strftime("%Y-%m-%d")


def hour_of(ts):
    return to_dt(ts).hour
'''
    REPORT = '''import json
import sys
from collections import Counter, defaultdict
from datetime import datetime

import bucket


def hour(ts):
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts).hour
    return bucket.hour_of(ts)


def main(path):
    per_day = Counter()
    per_hour = defaultdict(Counter)
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            ts = json.loads(line)["ts"]
            day = bucket.day_of(ts)
            per_day[day] += 1
            per_hour[day][hour(ts)] += 1
    for day in sorted(per_day):
        counts = per_hour[day]
        peak = min(counts, key=lambda h: (-counts[h], h))
        print(f"{day} {per_day[day]} peak={peak:02d}")


if __name__ == "__main__":
    main(sys.argv[1])
'''

    @staticmethod
    def events(seed, n):
        rnd = random.Random(seed)
        base = 1700000000 - 1700000000 % 86400
        out = []
        for i in range(n):
            t = base + rnd.choice([0, 1, 2, 3]) * 86400 + rnd.choice([rnd.randint(0, 86399), rnd.randint(0, 7200), rnd.randint(79200, 86399)])
            k = rnd.random()
            if k < 0.5:
                ts = t
            elif k < 0.6:
                ts = t + 0.5
            else:
                off = rnd.choice(["+05:30", "-08:00", "+13:00", "Z", "+00:00", ""])
                sign = {"+05:30": 19800, "-08:00": -28800, "+13:00": 46800}.get(off, 0)
                ts = (dt.datetime(1970, 1, 1) + dt.timedelta(seconds=t + sign)).strftime("%Y-%m-%dT%H:%M:%S") + off
            out.append({"id": i, "ts": ts})
        return out

    @staticmethod
    def oracle(evs):
        per = {}
        for e in evs:
            ts = e["ts"]
            if isinstance(ts, str):
                m = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(Z|[+-]\d\d:\d\d)?", ts)
                t = dt.datetime.fromisoformat(m.group(1))
                o = m.group(2)
                if o and o != "Z":
                    s = 1 if o[0] == "+" else -1
                    t -= s * dt.timedelta(hours=int(o[1:3]), minutes=int(o[4:6]))
            else:
                t = dt.datetime(1970, 1, 1) + dt.timedelta(seconds=ts)
            per.setdefault(t.strftime("%Y-%m-%d"), []).append(t.hour)
        lines = []
        for day in sorted(per):
            hs = per[day]
            peak = min(set(hs), key=lambda h: (-hs.count(h), h))
            lines.append(f"{day} {len(hs)} peak={peak:02d}")
        return "\n".join(lines) + "\n"

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "bucket.py", FixDailyBuckets.BUCKET)
        write(d, "report.py", FixDailyBuckets.REPORT)
        write(d, "events.jsonl", "".join(json.dumps(e) + "\n" for e in FixDailyBuckets.events(1, 60)))

    @staticmethod
    def grade(d: Path):
        tmp, w = scratch_copy(d)
        try:
            for seed in (1, 7):
                evs = FixDailyBuckets.events(seed, 400)
                (w / "e.jsonl").write_text("".join(json.dumps(e) + "\n" for e in evs))
                want = FixDailyBuckets.oracle(evs)
                for tz in ("UTC", "EST5", "IST-5:30", "NZST-12NZDT,M9.5.0,M4.1.0/3", "PST8PDT,M3.2.0,M11.1.0"):
                    r = runb(["python3", "report.py", "e.jsonl"], cwd=w, env={"TZ": tz})
                    if r.returncode != 0:
                        return False, f"TZ={tz}: {r.stderr.decode()[-150:]}"
                    if r.stdout.decode() != want:
                        a, b = r.stdout.decode().splitlines(), want.splitlines()
                        return False, f"TZ={tz}: first diff {next(((x, y) for x, y in zip(a, b) if x != y), (len(a), len(b)))}"
            return True, "same output in every timezone"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 4. semver-sort
class SemverSort:
    name = "semver-sort"
    PROMPT = (
        "Write vsort.py: reads version strings from stdin, one per line, and writes them to stdout sorted in "
        "ascending order by Semantic Versioning 2.0.0 precedence (the rules of semver.org item 11, including "
        "pre-release identifiers; build metadata after + is ignored for ordering). A single leading `v` is "
        "accepted (`v1.2.3`); strings are printed exactly as given (minus the line terminator). Versions of equal "
        "precedence keep their input order. Blank lines are ignored. A line that is not a valid semantic version "
        "(strict: three numeric parts without leading zeros, optional -prerelease with non-empty dot-separated "
        "identifiers of [0-9A-Za-z-] where numeric identifiers have no leading zeros, optional +build with "
        "non-empty dot-separated [0-9A-Za-z-] identifiers) is reported to stderr and skipped, and then the exit "
        "status is 1 after the valid ones were still printed; otherwise 0."
    )

    ID = r"(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    RX = re.compile(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(" + ID + r"(?:\." + ID + r")*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")

    @staticmethod
    def oracle(lines):
        good, bad = [], 0
        for l in lines:
            if not l.strip():
                continue
            m = SemverSort.RX.fullmatch(l)
            if not m:
                bad += 1
                continue
            pre = m.group(4)
            core = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if pre is None:
                key = core + (1, ())
            else:
                ids = tuple((0, int(x), "") if x.isdigit() else (1, 0, x) for x in pre.split("."))
                key = core + (0, ids)
            good.append((key, l))
        good.sort(key=lambda x: x[0])
        return [l for _, l in good], (1 if bad else 0)

    CASES = [
        ["1.0.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1"],
        ["1.10.0", "1.2.0", "1.2.10", "1.2.9", "v1.2.9", "0.9.9", "10.0.0", "2.0.0"],
        ["1.0.0+b", "1.0.0+a", "1.0.0", "v1.0.0+z", "1.0.0-0+x", "1.0.0-0"],
        ["1.0.0-1", "1.0.0-a", "1.0.0-A", "1.0.0-a-b", "1.0.0-a.b", "1.0.0-a.1", "1.0.0-9", "1.0.0-10", "1.0.0-1a", "1.0.0-01a"],
        ["01.0.0", "1.0", "1.0.0.0", "1.0.0-", "1.0.0-01", "1.0.0+", "1.0.0-a..b", "vv1.0.0", "x", "1.0.0-a_b"],
        ["", "2.0.0", "", "1.0.0", "", "bad", "99999999999999999999.0.0", "99999999999999999998.0.0"],
        ["1.0.0-alpha.9", "1.0.0-alpha.10", "1.0.0-alpha.-", "1.0.0-alpha.a", "1.0.0-alpha"],
    ]

    @staticmethod
    def setup(d: Path) -> None:
        (d / "versions.txt").write_text("1.2.0\n1.10.0\n1.2.0-rc.1\n")

    @staticmethod
    def grade(d: Path):
        if not (d / "vsort.py").exists():
            return False, "no vsort.py"
        rnd = random.Random(4)
        cases = [list(c) for c in SemverSort.CASES]
        pool = ["1.0.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-1", "1.0.0-a", "1.0.1", "0.1.0", "1.0.0+build", "v1.0.0-rc.1", "1.0.0-rc.1+x"]
        for _ in range(20):
            cases.append([rnd.choice(pool) for _ in range(rnd.randint(2, 15))])
        for c in cases:
            r = runb(["python3", "vsort.py"], cwd=d, inp="\n".join(c) + "\n")
            want, code = SemverSort.oracle(c)
            got = r.stdout.decode().splitlines()
            if got != want:
                return False, f"{c[:4]}...: got {got[:6]} want {want[:6]}"
            if r.returncode != code:
                return False, f"{c[:4]}...: exit {r.returncode}, want {code}"
        r = runb(["python3", "vsort.py"], cwd=d, inp="1.0.0\n1.0.0-b")
        if r.stdout.decode() != "1.0.0-b\n1.0.0\n":
            return False, "input without trailing newline mishandled"
        return True, f"{len(cases)} cases"


# ================================================================ 5. json-diff
class JsonDiff:
    name = "json-diff-cli"
    PROMPT = (
        "Write jdiff.py: `python3 jdiff.py A.json B.json` prints how B differs from A, one line per difference, "
        "and exits 1 if there were any, 0 if none, 2 (message on stderr, nothing on stdout) if either file is not "
        "readable valid JSON. Paths: the root is `$`; an object member is `.name` when name matches "
        "[A-Za-z_][A-Za-z0-9_]*, otherwise `[\"name\"]` written as a JSON string (so `$[\"a.b\"].c`); an array "
        "element is `[index]`. Objects are compared key by key in sorted key order and arrays index by index, "
        "recursively, and lines are printed in that traversal order. A key or element only in A prints "
        "`- PATH: VALUE`; only in B prints `+ PATH: VALUE`; present in both but different (any scalar change, a "
        "type change, or object vs array) prints `~ PATH: OLD -> NEW`; two objects or two arrays are never "
        "reported themselves, only their contents. VALUE/OLD/NEW are compact JSON: `json.dumps(v, "
        "sort_keys=True, separators=(',', ':'), ensure_ascii=False)`. Numbers compare by numeric value (1 equals "
        "1.0) but true/false are not numbers (`1` vs `true` is a difference)."
    )

    @staticmethod
    def oracle(a, b):
        out = []

        def dump(v):
            return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

        def key(k):
            return "." + k if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) else "[" + json.dumps(k, ensure_ascii=False) + "]"

        def isnum(x):
            return isinstance(x, (int, float)) and not isinstance(x, bool)

        def walk(p, x, y):
            if isinstance(x, dict) and isinstance(y, dict):
                for k in sorted(set(x) | set(y)):
                    if k not in y:
                        out.append(f"- {p}{key(k)}: {dump(x[k])}")
                    elif k not in x:
                        out.append(f"+ {p}{key(k)}: {dump(y[k])}")
                    else:
                        walk(p + key(k), x[k], y[k])
            elif isinstance(x, list) and isinstance(y, list):
                for i in range(max(len(x), len(y))):
                    if i >= len(y):
                        out.append(f"- {p}[{i}]: {dump(x[i])}")
                    elif i >= len(x):
                        out.append(f"+ {p}[{i}]: {dump(y[i])}")
                    else:
                        walk(f"{p}[{i}]", x[i], y[i])
            else:
                same = (isnum(x) and isnum(y) and x == y) or (not isnum(x) and not isnum(y) and type(x) is type(y) and x == y)
                if not same:
                    out.append(f"~ {p}: {dump(x)} -> {dump(y)}")
        walk("$", a, b)
        return out

    CASES = [
        ({"a": 1, "b": [1, 2, 3], "c": {"d": True}}, {"a": 1.0, "b": [1, 2], "c": {"d": 1, "e": None}}),
        ({"a.b": {"c": 1}, "": 2, "x y": [1]}, {"a.b": {"c": 2}, "": 3, "x y": []}),
        ([1, [2, {"k": "v"}]], [1, [2, {"k": "w"}], 5]),
        (1, 2), ({"a": 1}, [1]), ("é", "e"), (None, False), ({"a": {"b": {}}}, {"a": {"b": []}}),
        ({"z": 1, "a": 2, "m": {"q": [0]}}, {"z": 1, "a": 2, "m": {"q": [0]}}),
        ({"k": "ünï", "n": 1.5, "t": [True, False]}, {"k": "üni", "n": 1.50, "t": [1, 0]}),
        ({"1a": 1, "a-b": 2, "_ok": 3, "A9": 4}, {"1a": 2, "a-b": 3, "_ok": 4, "A9": 5}),
        ([], {}), ({"a": [[1, 2], [3]]}, {"a": [[1, 2, 3], []]}),
    ]

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "old.json", json.dumps({"name": "svc", "ports": [80, 443], "env": {"DEBUG": False}}, indent=2))
        write(d, "new.json", json.dumps({"name": "svc", "ports": [80, 8443, 9000], "env": {"DEBUG": True, "LOG": "info"}}, indent=2))

    @staticmethod
    def grade(d: Path):
        if not (d / "jdiff.py").exists():
            return False, "no jdiff.py"
        tmp, w = scratch_copy(d)
        try:
            for i, (a, b) in enumerate(JsonDiff.CASES):
                (w / "a.json").write_text(json.dumps(a, ensure_ascii=False), encoding="utf-8")
                (w / "b.json").write_text(json.dumps(b, ensure_ascii=False), encoding="utf-8")
                r = runb(["python3", "jdiff.py", "a.json", "b.json"], cwd=w)
                want = JsonDiff.oracle(a, b)
                got = r.stdout.decode("utf-8").splitlines()
                if got != want:
                    return False, f"case {i}: got {got[:4]} want {want[:4]}"
                if r.returncode != (1 if want else 0):
                    return False, f"case {i}: exit {r.returncode}"
            (w / "bad.json").write_text("{not json")
            r = runb(["python3", "jdiff.py", "a.json", "bad.json"], cwd=w)
            if r.returncode != 2 or r.stdout.strip():
                return False, f"invalid JSON: exit {r.returncode}, stdout {r.stdout[:30]!r}"
            r = runb(["python3", "jdiff.py", "a.json", "missing.json"], cwd=w)
            if r.returncode != 2:
                return False, f"missing file: exit {r.returncode}, want 2"
            return True, f"{len(JsonDiff.CASES)} cases"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)



# ================================================================ 6. refactor-invoice
INVOICE_ORIG = '''REGIONS = {"US-CA": 725, "US-NY": 400, "US-OR": 0, "DE": 1900, "FR": 2000}


def render(order):
    region = order["region"]
    eu = region in ("DE", "FR")
    lines = order["lines"]
    sub = 0
    for ln in lines:
        sub += ln["qty"] * ln["cents"]
    disc = 0
    coupon = order.get("coupon")
    if coupon == "SAVE10":
        disc = sub * 10 // 100
    elif coupon == "FIVER":
        if sub >= 2000:
            disc = 500
    elif coupon is not None and coupon != "":
        raise ValueError("unknown coupon: " + str(coupon))
    base = sub - disc
    if region not in REGIONS:
        raise ValueError("unknown region: " + str(region))
    bps = REGIONS[region]
    tax = (base * bps + 5000) // 10000
    ship = 0 if base >= 5000 else 599
    if eu:
        ship += 300
    total = base + tax + ship

    def money(cents):
        neg = cents < 0
        whole, frac = divmod(abs(cents), 100)
        if eu:
            s = f"{whole:,}".replace(",", ".") + "," + f"{frac:02d}" + " \\u20ac"
        else:
            s = "$" + f"{whole:,}" + "." + f"{frac:02d}"
        return "-" + s if neg else s

    out = []
    out.append("INVOICE " + str(order["id"]))
    out.append("Customer: " + order["customer"])
    out.append("Region: " + region)
    out.append("-" * 44)
    for ln in lines:
        desc = ln["desc"]
        if len(desc) > 20:
            desc = desc[:19] + "\\u2026"
        out.append(f"{desc:<20} {ln['qty']:>3} x {money(ln['cents']):>10} {money(ln['qty'] * ln['cents']):>12}")
    out.append("-" * 44)
    out.append(f"{'Subtotal':<20}{money(sub):>24}")
    if disc:
        out.append(f"{'Discount (' + coupon + ')':<20}{money(-disc):>24}")
    out.append(f"{'Tax (' + format(bps / 100, 'g') + '%)':<20}{money(tax):>24}")
    out.append(f"{'Shipping':<20}{money(ship):>24}")
    out.append(f"{'TOTAL':<20}{money(total):>24}")
    return "\\n".join(out) + "\\n"
'''

INVOICE_ORIG = INVOICE_ORIG.replace("\\u20ac", "\u20ac").replace("\\u2026", "\u2026")


def _rand_orders(seed, n):
    rnd = random.Random(seed)
    words = ["Widget", "Gadget with a very long descriptive name", "Cable", "Ünïcode thing", "Bolt", "Thing 12345678901234567890", "Exactly twenty chars"]
    out = []
    for i in range(n):
        lines = [{"sku": f"S{rnd.randint(1, 99)}", "desc": rnd.choice(words), "qty": rnd.randint(0, 40), "cents": rnd.choice([1, 99, 250, 1999, 100000, 123456, -500, 3333])}
                 for _ in range(rnd.randint(0, 5))]
        o = {"id": rnd.choice([i, f"INV-{i}"]), "region": rnd.choice(["US-CA", "US-NY", "US-OR", "DE", "FR", "DE", "US-CA", "XX", "us-ca"]),
             "customer": rnd.choice(["Acme", "Müller GmbH", "O'Neil"]), "lines": lines}
        c = rnd.choice([None, None, "SAVE10", "FIVER", "", "NOPE"])
        if c is not None:
            o["coupon"] = c
        out.append(o)
    return out


INVOICE_HARNESS = r'''
import importlib.util, json, sys
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
sys.path.insert(0, ".")
old = load("_orig_invoice", "_orig_invoice.py")
import invoice, tax, format as fmt
orders = json.load(open("_orders.json"))
def call(f, o):
    try: return ("ok", f(o))
    except Exception as e: return ("err", type(e).__name__, str(e))
for i, o in enumerate(orders):
    a, b = call(old.render, o), call(invoice.render, o)
    if a != b:
        print(f"order {i} ({o['region']}, coupon={o.get('coupon')!r}): old {a!r:.120} new {b!r:.120}"); sys.exit()
for base, region in [(10000, "US-CA"), (1, "US-CA"), (-1234, "DE"), (-1, "FR"), (0, "US-OR"), (99999, "US-NY"), (6, "US-CA"), (-6, "US-CA"), (13, "FR"), (-13, "FR"), (150, "DE"), (200, "US-CA"), (-150, "DE"), (250, "FR")]:
    want = (base * old.REGIONS[region] + 5000) // 10000
    got = tax.compute_tax(base, region)
    if got != want or type(got) is not int:
        print(f"compute_tax({base}, {region!r}) = {got!r}, want {want}"); sys.exit()
try:
    tax.compute_tax(100, "XX"); print("compute_tax accepted an unknown region"); sys.exit()
except ValueError as e:
    if str(e) != "unknown region: XX": print(f"wrong message {e}"); sys.exit()
for c, region, want in [(123456, "US-CA", "$1,234.56"), (-5, "US-NY", "-$0.05"), (123456789, "DE", "1.234.567,89 \u20ac"), (-100, "FR", "-1,00 \u20ac"), (0, "US-OR", "$0.00"), (7, "FR", "0,07 \u20ac")]:
    got = fmt.money(c, region)
    if got != want: print(f"money({c}, {region!r}) = {got!r}, want {want!r}"); sys.exit()
src = open("invoice.py").read()
for bad in ("1900", "725", "\u20ac", "REGIONS", "divmod"):
    if bad in src: print(f"invoice.py still contains {bad!r}: the logic was not moved"); sys.exit()
print("OK")
'''


class RefactorInvoice:
    name = "refactor-invoice"
    PROMPT = (
        "invoice.py's render(order) is one long function that mixes tax rules, money formatting and layout. "
        "Refactor it: tax goes in tax.py as `compute_tax(base_cents, region)` (returns the tax in cents, raises "
        "ValueError for an unknown region exactly as render does today), money formatting goes in format.py as "
        "`money(cents, region)` (returns the string render prints today for that region), and render(order) stays "
        "in invoice.py, calling them. Behaviour must not change in any way: byte-identical output for every order, "
        "and the same exception types and messages for the bad ones, including which error you get when an order "
        "has more than one problem. The rate table and the formatting rules must live in the new modules, not "
        "still in invoice.py. golden.json has sample orders with today's output."
    )

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "invoice.py", INVOICE_ORIG)
        ns: dict = {}
        exec(compile(INVOICE_ORIG, "orig", "exec"), ns)
        gold = []
        for o in _rand_orders(99, 12):
            try:
                gold.append({"order": o, "output": ns["render"](o)})
            except Exception as e:
                gold.append({"order": o, "error": f"{type(e).__name__}: {e}"})
        write(d, "golden.json", json.dumps(gold, indent=1, ensure_ascii=False))

    @staticmethod
    def grade(d: Path):
        tmp, w = scratch_copy(d)
        try:
            for f in ("tax.py", "format.py", "invoice.py"):
                if not (w / f).exists():
                    return False, f"no {f}"
            write(w, "_orig_invoice.py", INVOICE_ORIG)
            write(w, "_orders.json", json.dumps(_rand_orders(5, 500), ensure_ascii=False))
            return py_check(w, INVOICE_HARNESS)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 7. sql-longest-gaps
class SqlGaps:
    name = "sql-longest-gaps"
    PROMPT = (
        "sensors.db (SQLite) has a table readings(id, sensor, ts, value). ts is text in UTC unless it carries an "
        "explicit offset, and comes in the forms 2024-03-01T10:00:00Z, 2024-03-01 10:00:00 and "
        "2024-03-01T12:00:00+02:00. Rows whose value is NULL are faulty and must be ignored. For each sensor with "
        "at least two valid readings, find its longest gap in seconds between two consecutive valid readings in "
        "time order (compare instants, not text); if several gaps tie, take the earliest one. Write "
        "longest_gaps.csv with the header sensor,gap_seconds,gap_start, where gap_start is the time of the earlier "
        "reading of the gap in UTC as YYYY-MM-DDTHH:MM:SSZ, rows ordered by gap_seconds descending, then sensor "
        "ascending."
    )

    @staticmethod
    def parse(ts):
        m = re.fullmatch(r"(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(Z|[+-]\d\d:\d\d)?", ts)
        t = dt.datetime(*(int(x) for x in m.groups()[:6]))
        o = m.group(7)
        if o and o != "Z":
            t -= (1 if o[0] == "+" else -1) * dt.timedelta(hours=int(o[1:3]), minutes=int(o[4:6]))
        return t

    @staticmethod
    def make_db(path: Path):
        rnd = random.Random(21)
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE readings(id INTEGER PRIMARY KEY, sensor TEXT NOT NULL, ts TEXT NOT NULL, value REAL)")
        base = dt.datetime(2024, 3, 1)
        for s in ["s1", "s2", "s3", "s4", "s5", "s6", "t10", "t9"]:
            n = {"s5": 3, "s6": 1}.get(s, rnd.randint(8, 30))
            for _ in range(n):
                t = base + dt.timedelta(seconds=rnd.randint(0, 86400 * 5))
                k = rnd.random()
                if k < 0.34:
                    txt = t.strftime("%Y-%m-%dT%H:%M:%SZ")
                elif k < 0.67:
                    txt = t.strftime("%Y-%m-%d %H:%M:%S")
                else:
                    h = rnd.choice([2, -5, 9])
                    tt = t + dt.timedelta(hours=h)
                    txt = tt.strftime("%Y-%m-%dT%H:%M:%S") + ("+" if h > 0 else "-") + f"{abs(h):02d}:00"
                val = None if (s == "s5" or rnd.random() < 0.2) else round(rnd.random() * 10, 2)
                if s == "s5" and _ == 0:
                    val = 1.0
                db.execute("INSERT INTO readings(sensor,ts,value) VALUES(?,?,?)", (s, txt, val))
        # a tie: two equal 1-hour gaps for s7, written in a scrambled order
        for txt in ["2024-03-02T10:00:00Z", "2024-03-02 08:00:00", "2024-03-02T09:00:00Z", "2024-03-02 09:00:00", "2024-03-02T11:00:00+00:00"]:
            db.execute("INSERT INTO readings(sensor,ts,value) VALUES('s7',?,1.0)", (txt,))
        db.commit()
        db.close()

    @staticmethod
    def oracle(path: Path):
        db = sqlite3.connect(path)
        by = {}
        for s, ts in db.execute("SELECT sensor, ts FROM readings WHERE value IS NOT NULL"):
            by.setdefault(s, []).append(SqlGaps.parse(ts))
        rows = []
        for s, ts in by.items():
            ts.sort()
            if len(ts) < 2:
                continue
            best = max(range(len(ts) - 1), key=lambda i: ((ts[i + 1] - ts[i]).total_seconds(), -i))
            rows.append([s, str(int((ts[best + 1] - ts[best]).total_seconds())), ts[best].strftime("%Y-%m-%dT%H:%M:%SZ")])
        rows.sort(key=lambda r: (-int(r[1]), r[0]))
        db.close()
        return rows

    @staticmethod
    def setup(d: Path) -> None:
        SqlGaps.make_db(d / "sensors.db")

    @staticmethod
    def grade(d: Path):
        p = d / "longest_gaps.csv"
        if not p.exists():
            return False, "no longest_gaps.csv"
        tmp = Path(tempfile.mkdtemp(prefix="grade3-"))
        try:
            SqlGaps.make_db(tmp / "s.db")
            want = SqlGaps.oracle(tmp / "s.db")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        got = [r for r in csv.reader(p.read_text().splitlines()) if r]
        if not got or got[0] != ["sensor", "gap_seconds", "gap_start"]:
            return False, f"bad header {got[:1]}"
        got = got[1:]
        if got != want:
            return False, f"first difference: {next(((a, b) for a, b in zip(got, want) if a != b), (len(got), len(want)))}"
        return True, "matches"


# ================================================================ 8. git-extract-subtree-history
class GitSplitHistory:
    name = "git-split-lib-history"
    PROMPT = (
        "This repo keeps a library in lib/ and an application in app/ together. Create a branch called lib-only "
        "whose history contains only the commits that changed something under lib/, each one reduced to its "
        "changes under lib/ (files keep their paths, e.g. lib/parser.py; nothing outside lib/ in any of its "
        "trees), in the same order, with the same commit messages and author dates. Commits that touched nothing "
        "under lib/ must not appear on it. Do not alter master or any existing commit, and leave the working "
        "tree clean."
    )

    @staticmethod
    def setup(d: Path) -> None:
        vcs(d, "init", "-q", "-b", "master")
        vcs(d, "config", "commit.gpgsign", "false")
        n = [0]

        def commit(msg, files: dict, remove=(), move=None):
            n[0] += 1
            for rel, txt in files.items():
                write(d, rel, txt)
            if move:
                (d / move[1]).parent.mkdir(parents=True, exist_ok=True)
                vcs(d, "mv", move[0], move[1])
            for rel in remove:
                vcs(d, "rm", "-q", rel)
            vcs(d, "add", "-A")
            vcs(d, "commit", "-q", "-m", msg, date=f"2024-01-{n[0]:02d}T12:00:00+00:00")

        commit("Initial readme", {"README.md": "# proj\n"})
        commit("lib: add parser", {"lib/__init__.py": "", "lib/parser.py": "def parse(s):\n    return s.split(',')\n"})
        commit("app: first screen", {"app/main.py": "print('hi')\n"})
        commit("Add util and glue", {"lib/util.py": "def clamp(x, lo, hi):\n    return max(lo, min(x, hi))\n", "app/glue.py": "from lib import util\n"})
        commit("docs: usage", {"README.md": "# proj\nUsage: see app/main.py\n"})
        commit("lib: fix parser off-by-one", {"lib/parser.py": "def parse(s):\n    return [p.strip() for p in s.split(',')]\n"})
        commit("lib: move util into core", {}, move=("lib/util.py", "lib/core/util.py"))
        commit("app: tweak", {"app/main.py": "print('hello')\n"})
        commit("Parser speedup and app update", {"lib/parser.py": "def parse(s):\n    return [p.strip() for p in s.split(',') if p]\n", "app/main.py": "print('hello, world')\n"})
        commit("app: drop glue", {}, remove=["app/glue.py"])

    @staticmethod
    def grade(d: Path):
        tmp = Path(tempfile.mkdtemp(prefix="grade3-"))
        try:
            GitSplitHistory.setup(tmp)
            master0 = vcs(tmp, "rev-parse", "master").strip()
            if vcs(d, "rev-parse", "master").strip() != master0:
                return False, "master was altered"
            if vcs(d, "rev-parse", "--verify", "-q", "refs/heads/lib-only").strip() == "":
                return False, "no branch lib-only"
            fmt = "%s|%aI"
            want = vcs(tmp, "log", "--reverse", f"--format={fmt}", "master", "--", "lib").splitlines()
            want_sha = vcs(tmp, "rev-list", "--reverse", "master", "--", "lib").split()
            got = vcs(d, "log", "--reverse", f"--format={fmt}", "lib-only").splitlines()
            got_sha = vcs(d, "rev-list", "--reverse", "lib-only").split()
            if got != want:
                return False, f"lib-only history is {[g.split('|')[0] for g in got]}, want {[w.split('|')[0] for w in want]}"
            for g, w in zip(got_sha, want_sha):
                names = [x for x in vcs(d, "ls-tree", "--name-only", g).splitlines()]
                if names != ["lib"]:
                    return False, f"commit {g[:7]} has top-level entries {names}"
                if vcs(d, "rev-parse", f"{g}:lib").strip() != vcs(tmp, "rev-parse", f"{w}:lib").strip():
                    return False, f"commit {g[:7]}: lib/ differs from the original commit's lib/"
            if len(vcs(d, "rev-list", "--merges", "lib-only").split()):
                return False, "merge commits on lib-only"
            st = [l for l in vcs(d, "status", "--porcelain").splitlines() if not re.search(r"\.(maat|molt)/?$", l)]
            if st:
                return False, f"working tree not clean: {st[:3]}"
            return True, f"{len(got)} commits, trees match"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 9. git-find-culprit
CHECK_SH = '''#!/bin/sh
v=$(grep '^max_conns' limits.conf | head -1 | cut -d= -f2 | tr -d ' ')
if [ "$v" -lt 500 ]; then
  echo ok
else
  echo "max_conns too high: $v"
  exit 1
fi
'''


class GitFindCulprit:
    name = "git-find-culprit"
    PROMPT = (
        "`sh check.sh` passes on the first commit of this repo and fails on master now. Find the first commit "
        "where it fails and write its full 40-character hash (and nothing else) to culprit.txt. Don't rewrite "
        "history or move branches: leave the repo on master with no bisect or checkout left in progress, and "
        "don't commit culprit.txt."
    )

    @staticmethod
    def setup(d: Path) -> None:
        vcs(d, "init", "-q", "-b", "master")
        vcs(d, "config", "commit.gpgsign", "false")
        limits = {1: "max_conns = 100\ntimeout = 30\n", 9: "max_conns = 450\ntimeout = 30\n", 13: "max_conns = 450\ntimeout = 60\n",
                  15: "max_conns=  900\ntimeout = 60\n", 18: "max_conns = 900\ntimeout = 60\nretries = 3\n"}
        msgs = {9: "raise connection limit for load test", 13: "longer timeout", 15: "tidy whitespace in limits.conf",
                18: "limits.conf: add retries", 21: "fix flaky check"}
        write(d, "check.sh", CHECK_SH)
        for i in range(1, 25):
            if i in limits:
                write(d, "limits.conf", limits[i])
            write(d, f"notes/n{i:02d}.txt", f"note {i}\n")
            if i == 1:
                write(d, "README", "service config\n")
            vcs(d, "add", "-A")
            vcs(d, "commit", "-q", "-m", msgs.get(i, f"notes {i}"), date=f"2024-02-{i:02d}T09:00:00+00:00")

    @staticmethod
    def grade(d: Path):
        p = d / "culprit.txt"
        if not p.exists():
            return False, "no culprit.txt"
        tmp = Path(tempfile.mkdtemp(prefix="grade3-"))
        try:
            GitFindCulprit.setup(tmp)
            revs = vcs(tmp, "rev-list", "--reverse", "master").split()
            first_bad = None
            for r in revs:
                x = Path(tempfile.mkdtemp(prefix="co-", dir=tmp))
                subprocess.run(f"git archive {r} | tar -x -C {x}", shell=True, cwd=tmp, capture_output=True)
                if subprocess.run(["sh", "check.sh"], cwd=x, capture_output=True).returncode != 0:
                    first_bad = r
                    break
            if vcs(d, "rev-list", "--reverse", "master").split() != revs:
                return False, "history of master changed"
            if vcs(d, "rev-parse", "--abbrev-ref", "HEAD").strip() != "master":
                return False, "HEAD is not on master"
            if (d / ".git" / "BISECT_START").exists() or (d / ".git" / "BISECT_LOG").exists():
                return False, "a bisect is still in progress"
            if vcs(d, "ls-files", "culprit.txt").strip():
                return False, "culprit.txt was committed"
            got = p.read_text().strip()
            if got != first_bad:
                return False, f"culprit.txt has {got[:12]}, the first failing commit is {first_bad[:12]}"
            if not re.fullmatch(r"[0-9a-f]{40}\n?", p.read_text()):
                return False, "culprit.txt must hold only the 40-character hash"
            return True, "right commit"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 10. bash-backup
class BackupScript:
    name = "bash-backup"
    PROMPT = (
        "Write backup.sh (bash): `bash backup.sh SRC DEST KEEP` archives the directory SRC into "
        "DEST/backup-STAMP.tar.gz and then prunes old archives. STAMP is the value of the environment variable "
        "BACKUP_NOW if it is set (format YYYYmmdd-HHMMSS), otherwise the current local time in that format. DEST is "
        "created if missing. Archive member paths are relative to SRC itself (docs/a.txt, not SRC/docs/a.txt), "
        "dotfiles included, names with spaces preserved; files whose name ends in .tmp and any directory named "
        ".cache (at any depth) are left out, and so is anything inside DEST, which may itself be inside SRC. "
        "After writing the archive, keep only the KEEP newest files in DEST named exactly "
        "backup-YYYYmmdd-HHMMSS.tar.gz, newest by the STAMP in the name, and delete the others; never touch any "
        "other file in DEST. Errors: if SRC is not a directory, or KEEP is not a positive integer, exit 2 and "
        "change nothing (do not even create DEST); if the archive for that STAMP already exists, exit 3 and "
        "change nothing."
    )

    FILES = {
        "a.txt": "A\n", "docs/b.md": "B\n", "docs/x y.txt": "XY\n", ".hidden": "H\n", "my.cache/keep.txt": "K\n",
        ".cachefile": "C\n", "deep/er/est/f.bin": "F\n", "skip.tmp": "T\n", "docs/notes.tmp": "T\n",
        "docs/.cache/z": "Z\n", ".cache/q": "Q\n", "deep/.cache/er/w": "W\n",
    }
    EXPECT = {"a.txt", "docs/b.md", "docs/x y.txt", ".hidden", "my.cache/keep.txt", ".cachefile", "deep/er/est/f.bin"}

    @staticmethod
    def members(archive: Path):
        r = runb(["tar", "-tzf", str(archive)])
        if r.returncode != 0:
            return None
        out = set()
        for l in r.stdout.decode().splitlines():
            l = l[2:] if l.startswith("./") else l
            if l and not l.endswith("/"):
                out.add(l)
        return out

    @staticmethod
    def setup(d: Path) -> None:
        for rel, txt in BackupScript.FILES.items():
            write(d, "data/" + rel, txt)
        write(d, "README.txt", "Run backup.sh nightly from cron.\n")

    @staticmethod
    def grade(d: Path):
        if not (d / "backup.sh").exists():
            return False, "no backup.sh"
        tmp = Path(tempfile.mkdtemp(prefix="grade3-"))
        try:
            shutil.copy(d / "backup.sh", tmp / "backup.sh")
            src = tmp / "my src"
            for rel, txt in BackupScript.FILES.items():
                write(src, rel, txt)
            before = digest(src)

            def bk(src_arg, dest, keep, stamp=None):
                env = {"BACKUP_NOW": stamp} if stamp else {}
                return runb(["bash", "backup.sh", src_arg, dest, str(keep)], cwd=tmp, env=env)

            dest = tmp / "out"
            for st in ("20240101-000000", "20240102-000000", "20240103-120000", "20240104-235959"):
                r = bk("my src", "out", 3, st)
                if r.returncode != 0:
                    return False, f"run {st} exited {r.returncode}: {r.stderr.decode()[-120:]}"
                if st == "20240101-000000":
                    for name, txt in (("notes.txt", "n"), ("backup-latest.tar.gz", "l"), ("backup-20240101-0000.tar.gz", "s"), ("backup-20240101-000000.tar.gz.sig", "g"), ("backup-20230101-000000.txt", "t")):
                        write(dest, name, txt)
            have = sorted(x.name for x in dest.iterdir())
            want = sorted(["notes.txt", "backup-latest.tar.gz", "backup-20240101-0000.tar.gz", "backup-20240101-000000.tar.gz.sig", "backup-20230101-000000.txt",
                           "backup-20240102-000000.tar.gz", "backup-20240103-120000.tar.gz", "backup-20240104-235959.tar.gz"])
            if have != want:
                return False, f"DEST holds {have}"
            m = BackupScript.members(dest / "backup-20240104-235959.tar.gz")
            if m != BackupScript.EXPECT:
                return False, f"archive members differ: extra {sorted((m or set()) - BackupScript.EXPECT)[:3]}, missing {sorted(BackupScript.EXPECT - (m or set()))[:3]}"
            if digest(src) != before:
                return False, "SRC was modified"
            # same stamp again -> exit 3, nothing changed
            snap = digest(dest)
            r = bk("my src", "out", 1, "20240104-235959")
            if r.returncode != 3 or digest(dest) != snap:
                return False, f"existing archive: exit {r.returncode}, DEST changed={digest(dest) != snap}"
            # an older stamp than KEEP newest is pruned straight away
            r = bk("my src", "out", 3, "20240101-000000")
            if r.returncode != 0 or (dest / "backup-20240101-000000.tar.gz").exists() or not (dest / "backup-20240102-000000.tar.gz").exists():
                return False, "stamp older than the KEEP newest must be pruned, newer ones kept (ordering is by name, not mtime)"
            # a stamp in the middle
            r = bk("my src", "out", 3, "20240103-000000")
            left = sorted(x.name for x in dest.glob("backup-????????-??????.tar.gz"))
            if left != ["backup-20240103-000000.tar.gz", "backup-20240103-120000.tar.gz", "backup-20240104-235959.tar.gz"]:
                return False, f"after mid-stamp run archives are {left}"
            # errors change nothing, not even DEST
            write(tmp, "a.txt", "x")
            for args in (("nope", "never1", 3), ("my src", "never2", 0), ("my src", "never3", "abc"), ("my src", "never4", -1), ("my src", "never5", "2x"), ("a.txt", "never6", 2)):
                r = bk(args[0], args[1], args[2], "20240110-000000")
                if r.returncode != 2 or (tmp / args[1]).exists():
                    return False, f"bad args {args}: exit {r.returncode}, DEST created={(tmp / args[1]).exists()}"
            # DEST inside SRC
            r = bk("my src", "my src/backups", 2, "20240201-000000")
            r2 = bk("my src", "my src/backups", 2, "20240202-000000")
            if r.returncode or r2.returncode:
                return False, f"DEST inside SRC exited {r.returncode}/{r2.returncode}"
            m = BackupScript.members(src / "backups" / "backup-20240202-000000.tar.gz")
            if m != BackupScript.EXPECT:
                return False, f"DEST inside SRC: archive members {sorted((m or set()) ^ BackupScript.EXPECT)[:4]}"
            return True, "all scenarios"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 11. make-incremental
MAKEFILE_BAD = """SRCS := $(sort $(wildcard src/*.md))
OUTS := $(SRCS:src/%.md=out/%.txt)

all: out/all.txt

out/all.txt: $(OUTS)
\tcat $(OUTS) > $@
\techo "build $@" >> build.log

out/%.txt: src/%.md FORCE
\tmkdir -p out
\t(cat common/header.txt; tr a-z A-Z < $<) > $@
\techo "build $@" >> build.log

FORCE:

clean:
\trm -rf out

.PHONY: all clean
"""


class MakeIncremental:
    name = "make-incremental"
    PROMPT = (
        "`make` in this project rebuilds everything every time. It should only rebuild what is stale: after a "
        "full build, running make again does nothing; editing one src/x.md rebuilds out/x.txt and out/all.txt and "
        "nothing else; editing common/header.txt (every out/*.txt starts with it) rebuilds every out/*.txt and "
        "out/all.txt; adding a new src/y.md builds out/y.txt and out/all.txt only. `make clean` should leave the "
        "tree as it was before the first build (out/ and build.log gone). A full `make -j4` from clean must also "
        "give correct output. Fix the Makefile; don't change what the recipes produce or the lines they log."
    )

    FILES = {"src/alpha.md": "first file\nline two\n", "src/beta.md": "second file\n", "src/gamma.md": "third\n",
             "common/header.txt": "# generated\n"}

    @staticmethod
    def setup(d: Path) -> None:
        for k, v in MakeIncremental.FILES.items():
            write(d, k, v)
        write(d, "Makefile", MAKEFILE_BAD)

    @staticmethod
    def expect_all(w: Path):
        header = (w / "common/header.txt").read_text()
        return "".join(header + (w / f"src/{n}.md").read_text().upper() for n in sorted(p.stem for p in (w / "src").glob("*.md")))

    @staticmethod
    def grade(d: Path):
        if not (d / "Makefile").exists():
            return False, "no Makefile"
        tmp, w = scratch_copy(d)
        try:
            shutil.rmtree(w / "out", ignore_errors=True)
            (w / "build.log").unlink(missing_ok=True)

            def mk(*a):
                r = runb(["make", *a], cwd=w, timeout=60)
                return r.returncode, ((w / "build.log").read_text().splitlines() if (w / "build.log").exists() else [])

            def age_outputs(t):
                for p in (w / "out").glob("*"):
                    os.utime(p, (t, t))

            t0 = int(time.time()) - 100000
            for p in w.rglob("*"):
                if p.is_file() and ".git" not in p.parts:
                    os.utime(p, (t0, t0))
            rc, log = mk()
            if rc != 0:
                return False, "make failed on a clean tree"
            if sorted(log[:-1]) != ["build out/alpha.txt", "build out/beta.txt", "build out/gamma.txt"] or log[-1] != "build out/all.txt":
                return False, f"first build logged {log}"
            if (w / "out/all.txt").read_text() != MakeIncremental.expect_all(w):
                return False, "out/all.txt content is wrong"
            if (w / "out/beta.txt").read_text() != "# generated\nSECOND FILE\n":
                return False, "out/beta.txt content is wrong"
            age_outputs(t0 + 100)
            n = len(log)
            rc, log = mk()
            if rc != 0 or len(log) != n:
                return False, f"a second make rebuilt {log[n:]}"
            # edit one source
            write(w, "src/beta.md", "second file, edited\n")
            os.utime(w / "src/beta.md", (t0 + 200, t0 + 200))
            rc, log2 = mk()
            if log2[n:] != ["build out/beta.txt", "build out/all.txt"]:
                return False, f"editing src/beta.md rebuilt {log2[n:]}"
            if "SECOND FILE, EDITED" not in (w / "out/all.txt").read_text():
                return False, "all.txt not refreshed after editing a source"
            # edit the header
            age_outputs(t0 + 250)
            n = len(log2)
            write(w, "common/header.txt", "# generated v2\n")
            os.utime(w / "common/header.txt", (t0 + 300, t0 + 300))
            rc, log3 = mk()
            new = log3[n:]
            if sorted(new[:-1]) != ["build out/alpha.txt", "build out/beta.txt", "build out/gamma.txt"] or new[-1:] != ["build out/all.txt"]:
                return False, f"editing common/header.txt rebuilt {new}"
            if (w / "out/gamma.txt").read_text() != "# generated v2\nTHIRD\n":
                return False, "header edit did not reach out/gamma.txt"
            # add a source
            age_outputs(t0 + 350)
            n = len(log3)
            write(w, "src/delta.md", "fourth\n")
            os.utime(w / "src/delta.md", (t0 + 400, t0 + 400))
            rc, log4 = mk()
            if log4[n:] != ["build out/delta.txt", "build out/all.txt"]:
                return False, f"adding src/delta.md rebuilt {log4[n:]}"
            if (w / "out/all.txt").read_text() != MakeIncremental.expect_all(w):
                return False, "out/all.txt wrong after adding a source"
            # clean, then a parallel build
            rc, _ = mk("clean")
            if rc != 0 or (w / "out").exists() or (w / "build.log").exists():
                return False, "make clean left out/ or build.log behind"
            rc, log5 = mk("-j4")
            if rc != 0 or len(log5) != 5 or (w / "out/all.txt").read_text() != MakeIncremental.expect_all(w):
                return False, f"make -j4 from clean: rc={rc}, log={log5}"
            return True, "incremental, clean and parallel builds right"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 12. csv-to-json-node
class CsvToJsonNode:
    name = "csv-to-json-node"
    PROMPT = (
        "Write csv2json.js (Node 22, no npm packages): it reads CSV from stdin and writes to stdout a JSON array "
        "with one object per data row, keyed by the header row, all values strings. Format: fields separated by "
        "commas; a field may be wrapped in double quotes, and then may contain commas, line breaks (kept exactly "
        "as they are) and doubled quotes (\"\" is one quote); a quote in the middle of an unquoted field is "
        "literal. Records end at LF or CRLF. A UTF-8 byte-order mark at the very start is ignored. Completely empty "
        "lines between records are skipped, and a trailing newline does not make a record. If a header name "
        "repeats, its second occurrence becomes name_2, the third name_3; an empty header becomes colN, N being "
        "its 1-based column number. A row with fewer fields than the header is padded with empty strings. A row "
        "with more fields than the header, or a quoted field that is never closed, is an error: a message on "
        "stderr, nothing on stdout, exit status 1. A header with no rows, or empty input, gives []."
    )

    @staticmethod
    def oracle(data: bytes):
        s = data.decode("utf-8")
        if s.startswith("\ufeff"):
            s = s[1:]
        recs, rec, field = [], [], []
        fstart, inq, any_char = True, False, False
        i, n = 0, len(s)
        while i < n:
            c = s[i]
            if inq:
                if c == '"':
                    if s[i + 1:i + 2] == '"':
                        field.append('"')
                        i += 1
                    else:
                        inq = False
                else:
                    field.append(c)
            elif c == '"' and fstart:
                inq, fstart, any_char = True, False, True
            elif c == ",":
                rec.append("".join(field))
                field, fstart, any_char = [], True, True
            elif c == "\n" or (c == "\r" and s[i + 1:i + 2] == "\n"):
                if c == "\r":
                    i += 1
                if any_char:
                    rec.append("".join(field))
                    recs.append(rec)
                rec, field, fstart, any_char = [], [], True, False
            else:
                field.append(c)
                fstart, any_char = False, True
            i += 1
        if inq:
            raise ValueError("unterminated")
        if any_char:
            rec.append("".join(field))
            recs.append(rec)
        if not recs:
            return []
        head = recs[0]
        names, seen = [], {}
        for k, h in enumerate(head, 1):
            h = h if h != "" else f"col{k}"
            seen[h] = seen.get(h, 0) + 1
            names.append(h if seen[h] == 1 else f"{h}_{seen[h]}")
        out = []
        for r in recs[1:]:
            if len(r) > len(names):
                raise ValueError("too many fields")
            out.append(dict(zip(names, r + [""] * (len(names) - len(r)))))
        return out

    CASES = [
        b"a,b,c\n1,2,3\n4,5,6\n",
        b"a,b\r\n1,2\r\n3,4",
        b"\xef\xbb\xbfname,note\n\"Smith, J\",\"said \"\"hi\"\"\"\n",
        b"k,v\n\"line1\nline2\",x\n\"crlf\r\ninside\",y\n",
        b"a,b,c\n1,2\n1\n",
        b"a,b\n\n1,2\n\n\n3,4\n\n",
        b"x,x,x,y\n1,2,3,4\n",
        b",b,\n1,2,3\n",
        b"",
        b"a,b\n",
        b"\n\na,b\n1,2\n",
        b"a,b\n1,2,3\n",
        b"a,b\n\"unclosed,2\n",
        b"a,b\nab\"c,d\"e\n",
        b"a\n\"\"\n\"x\"\n",
        b"a,b\n,\n 1 , 2 \n",
        b"h\n\xc3\xa9\xe2\x82\xac\xf0\x9f\x98\x80\n",
        b"a,b\n\"\",\"\"\n",
        b"a\n\r\n1\r\n",
    ]

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "sample.csv", 'id,name,comment\n1,"Ada, Countess","wrote ""the"" notes"\n2,Ben,\n')

    @staticmethod
    def grade(d: Path):
        if not (d / "csv2json.js").exists():
            return False, "no csv2json.js"
        for i, data in enumerate(CsvToJsonNode.CASES):
            try:
                want = CsvToJsonNode.oracle(data)
            except ValueError:
                want = None
            try:
                r = runb(["node", "csv2json.js"], cwd=d, inp=data)
            except subprocess.TimeoutExpired:
                return False, f"case {i}: timeout"
            if want is None:
                if r.returncode != 1 or r.stdout.strip():
                    return False, f"case {i} {data[:30]!r}: want error exit 1 with empty stdout, got exit {r.returncode}, stdout {r.stdout[:40]!r}"
                continue
            try:
                got = json.loads(r.stdout.decode("utf-8"))
            except ValueError:
                return False, f"case {i} {data[:30]!r}: stdout is not JSON (exit {r.returncode}): {r.stdout[:40]!r} {r.stderr[-100:]!r}"
            if r.returncode != 0 or got != want:
                return False, f"case {i} {data[:30]!r}: got {str(got)[:80]} want {str(want)[:80]}"
        return True, f"{len(CsvToJsonNode.CASES)} cases"


# ================================================================ 13. ini-to-json
class IniToJson:
    name = "ini-to-json"
    PROMPT = (
        "Write ini2json.py: `python3 ini2json.py in.ini out.json` converts our INI config to JSON. Rules: "
        "`[section]` headers; `key = value` lines (split at the first `=`, key and value stripped of surrounding "
        "whitespace); keys before the first section go at the top level of the JSON object. Lines starting "
        "(after whitespace) with ; or # are comments, and so is the rest of a value from a ; or # that is the "
        "first character of the value or is preceded by whitespace (`a;b` is literal, `a ;b` is `a`). A value "
        "wrapped in double quotes is taken literally between the quotes (no escapes, comment characters inside "
        "are literal) and is always a string; only a comment may follow the closing quote. The section "
        "[DEFAULT], wherever it appears, supplies keys to every other section (the section's own value wins); it "
        "does not appear in the output. A dot in a section name nests: [db.pool] is the object db -> pool, and "
        "[db] and [db.pool] merge. Repeated keys: the last wins; a repeated section header continues the "
        "section. `${key}` in a value is replaced by that key's value text from the same section (including "
        "inherited DEFAULT keys), and `${section.key}` (split at the last dot) by the value text of that key in "
        "that section; this applies to quoted values too and works through chains of references. Types for "
        "unquoted values, applied after substitution: integers (-?digits) and floats (-?digits.digits) become "
        "numbers; true/false/yes/no/on/off (any case) become booleans; null (any case) becomes null; a key whose "
        "name ends in _list becomes a list of strings split at commas with each item stripped (an empty value "
        "is []); everything else stays a string. An unresolvable reference, a reference cycle, a line that is "
        "neither a comment, a section header nor key = value, or an unterminated quote is an error: message on "
        "stderr, exit status 1 and out.json not written."
    )

    class Err(Exception):
        pass

    @staticmethod
    def oracle(text: str):
        Err = IniToJson.Err
        root, secs, defaults = {}, {}, {}
        cur = None  # None = top level
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line[0] in ";#":
                continue
            m = re.fullmatch(r"\[([^\]]+)\]", line)
            if m:
                cur = m.group(1).strip()
                if cur != "DEFAULT":
                    secs.setdefault(cur, {})
                continue
            if "=" not in line:
                raise Err("bad line")
            k, v = (x.strip() for x in line.split("=", 1))
            if v.startswith('"'):
                end = v.find('"', 1)
                if end == -1:
                    raise Err("unterminated")
                rest = v[end + 1:].strip()
                if rest and rest[0] not in ";#":
                    raise Err("junk after quote")
                val = (v[1:end], True)
            else:
                if v and v[0] in ";#":
                    v = ""
                else:
                    mm = re.search(r"\s[;#]", v)
                    if mm:
                        v = v[:mm.start()].rstrip()
                val = (v, False)
            target = root if cur is None else (defaults if cur == "DEFAULT" else secs[cur])
            target[k] = val
        merged = {name: {**defaults, **body} for name, body in secs.items()}
        merged[""] = root

        def text_of(sec, key, stack):
            if (sec, key) in stack:
                raise Err("cycle")
            if sec not in merged or key not in merged[sec]:
                raise Err("unresolved")
            t, _ = merged[sec][key]

            def sub(m):
                ref = m.group(1)
                if "." in ref:
                    s2, k2 = ref.rsplit(".", 1)
                else:
                    s2, k2 = sec, ref
                return text_of(s2, k2, stack | {(sec, key)})
            return re.sub(r"\$\{([^}]*)\}", sub, t)

        def typed(key, t, quoted):
            if quoted:
                return t
            if key.endswith("_list"):
                return [x.strip() for x in t.split(",")] if t.strip() else []
            if re.fullmatch(r"-?\d+", t):
                return int(t)
            if re.fullmatch(r"-?\d+\.\d+", t):
                return float(t)
            if t.lower() in ("true", "yes", "on"):
                return True
            if t.lower() in ("false", "no", "off"):
                return False
            if t.lower() == "null":
                return None
            return t
        out = {}
        for sec, body in merged.items():
            node = out
            if sec:
                for part in sec.split("."):
                    node = node.setdefault(part, {})
            for k, (t, q) in body.items():
                node[k] = typed(k, text_of(sec, k, frozenset()), q)
        return out

    GOOD = [
        """; global settings
name = My App   ; inline comment
debug = yes
version = 1.10
[DEFAULT]
timeout = 30
host = localhost
[db]
host = db.internal
port = 5432
url = postgres://${host}:${port}/main
tags_list = a, b ,c
empty_list =
quoted = "x ; not a comment"  # real comment
path = C:\\temp#dir
pct = 50%
[db.pool]
size = 10
ratio = 0.75
max = ${db.port}
off = Off
nothing = NULL
neg = -4
[web]
port = 8080
workers = ${port}
base = "${host}"
""",
        "[a]\r\nx = 1\r\nx = 2\r\n[b]\r\ny=a=b\r\n[a]\r\nz\t=\ttrue\r\n",
        "[one]\nhost = h1\nurl = http://${host}/\n[two]\nhost = h2\n[DEFAULT]\nurl = default://${host}\ntimeout = 5\n",
        "top = 1\nflag = No\n[s]\nKeyCase = Value\nonly_list = x\nlist_of = 1, 2\nempty = \"\"\ncomment_only = ; nothing\n",
        "[a]\nb = ${c}\nc = ${d}\nd = 7\ne_list = ${d}, ${c}, z\n",
        "[a.b.c]\nx = 1\n[a]\ny = 2\n[a.b]\nz = 3\n",
        "[q]\nv = \"a\" ; trailing\nw = a;b\nx = a ;b\ny = a\t#b\nz = 1.5.2\nn = 1e5\nt = TRUE\n",
    ]
    BAD = [
        "[a]\nx = ${nope}\n",
        "[a]\nx = ${y}\ny = ${x}\n",
        "[a]\njust some text\n",
        "[a]\nx = \"open\n",
        "[a]\nx = ${b.y}\n[b]\nz = 1\n",
        "[a]\nx = \"q\" junk\n",
    ]

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "app.ini", IniToJson.GOOD[0])

    @staticmethod
    def grade(d: Path):
        if not (d / "ini2json.py").exists():
            return False, "no ini2json.py"
        tmp, w = scratch_copy(d)
        try:
            for i, text in enumerate(IniToJson.GOOD):
                (w / "in.ini").write_bytes(text.encode())
                (w / "out.json").unlink(missing_ok=True)
                r = runb(["python3", "ini2json.py", "in.ini", "out.json"], cwd=w)
                want = IniToJson.oracle(text)
                if r.returncode != 0 or not (w / "out.json").exists():
                    return False, f"good case {i}: exit {r.returncode}: {r.stderr.decode()[-150:]}"
                got = json.loads((w / "out.json").read_text())
                if json.dumps(got, sort_keys=True) != json.dumps(want, sort_keys=True):
                    for k in sorted(set(got) | set(want)):
                        if got.get(k) != want.get(k):
                            return False, f"good case {i}: key {k!r}: got {str(got.get(k))[:90]} want {str(want.get(k))[:90]}"
                    return False, f"good case {i}: differs"
            for i, text in enumerate(IniToJson.BAD):
                (w / "in.ini").write_bytes(text.encode())
                (w / "out.json").unlink(missing_ok=True)
                r = runb(["python3", "ini2json.py", "in.ini", "out.json"], cwd=w)
                if r.returncode != 1 or (w / "out.json").exists():
                    return False, f"bad case {i}: exit {r.returncode}, out.json written={(w / 'out.json').exists()}"
            return True, f"{len(IniToJson.GOOD)} good + {len(IniToJson.BAD)} bad cases"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 14. perf-asof-join
JOIN_SLOW = '''import csv
import sys


def main(events_path, rates_path, out_path):
    rates = []
    with open(rates_path, newline="") as f:
        for r in csv.DictReader(f):
            rates.append((int(r["effective_ts"]), r["rate"]))
    with open(events_path, newline="") as f, open(out_path, "w", newline="") as o:
        w = csv.writer(o)
        w.writerow(["ts", "id", "rate"])
        for e in csv.DictReader(f):
            ts = int(e["ts"])
            best = None
            for eff, rate in rates:
                if eff <= ts and (best is None or eff >= best[0]):
                    best = (eff, rate)
            w.writerow([e["ts"], e["id"], best[1] if best else ""])


main(*sys.argv[1:4])
'''


class PerfAsofJoin:
    name = "perf-asof-join"
    PROMPT = (
        "join.py (`python3 join.py events.csv rates.csv out.csv`) attaches to each event the rate that was in "
        "force at its time: the rate of the rates.csv row with the greatest effective_ts that is <= the event's ts "
        "(if several rows share that effective_ts, the one later in the file wins; if no row qualifies the rate "
        "is blank). It is correct but far too slow on real data: it must finish a 200,000-event, 50,000-rate input "
        "in under 10 seconds. Make it fast without changing its output in any way (rows in event order, rate "
        "text copied as is, same header). rates.csv is not sorted."
    )

    @staticmethod
    def gen(seed, ne, nr):
        rnd = random.Random(seed)
        span = max(nr * 10, 100)
        rates = [(rnd.randint(-50, span), rnd.choice(["1.5", "0.250", "7", "x,y", "", "0.1"])) for _ in range(nr)]
        if nr > 3:
            rates[1] = (rates[0][0], "dup-later")
        events = [(rnd.randint(-80, span + 50), f"e{i}") for i in range(ne)]
        return events, rates

    @staticmethod
    def write_inputs(w: Path, events, rates):
        with open(w / "events.csv", "w", newline="") as f:
            c = csv.writer(f)
            c.writerow(["ts", "id"])
            c.writerows(events)
        with open(w / "rates.csv", "w", newline="") as f:
            c = csv.writer(f)
            c.writerow(["effective_ts", "rate"])
            c.writerows(rates)

    @staticmethod
    def oracle(events, rates):
        import bisect
        order = sorted(range(len(rates)), key=lambda i: (rates[i][0], i))
        keys = [rates[i][0] for i in order]
        out = [["ts", "id", "rate"]]
        for ts, eid in events:
            k = bisect.bisect_right(keys, ts)
            out.append([str(ts), eid, rates[order[k - 1]][1] if k else ""])
        return out

    @staticmethod
    def setup(d: Path) -> None:
        ev, ra = PerfAsofJoin.gen(1, 30, 8)
        PerfAsofJoin.write_inputs(d, ev, ra)
        write(d, "join.py", JOIN_SLOW)

    @staticmethod
    def grade(d: Path):
        if not (d / "join.py").exists():
            return False, "no join.py"
        tmp, w = scratch_copy(d)
        try:
            for seed, ne, nr, limit in ((2, 300, 40, 30), (3, 200000, 50000, 10), (4, 5, 0, 30)):
                ev, ra = PerfAsofJoin.gen(seed, ne, nr)
                PerfAsofJoin.write_inputs(w, ev, ra)
                (w / "out.csv").unlink(missing_ok=True)
                t0 = time.time()
                try:
                    r = runb(["python3", "join.py", "events.csv", "rates.csv", "out.csv"], cwd=w, timeout=limit)
                except subprocess.TimeoutExpired:
                    return False, f"{ne} events x {nr} rates: not done in {limit}s"
                el = time.time() - t0
                if r.returncode != 0 or not (w / "out.csv").exists():
                    return False, f"exit {r.returncode}: {r.stderr.decode()[-150:]}"
                with open(w / "out.csv", newline="") as f:
                    got = list(csv.reader(f))
                want = PerfAsofJoin.oracle(ev, ra)
                if got != want:
                    for a, b in zip(got, want):
                        if a != b:
                            return False, f"{ne} events: got {a} want {b}"
                    return False, f"{len(got)} rows, want {len(want)}"
            return True, f"correct, big input in {el:.1f}s"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 15. slugify-batch
class SlugifyBatch:
    name = "slugify-batch"
    PROMPT = (
        "Write slugify.py: reads lines from stdin (each terminated by \\n or \\r\\n; the terminator is not part of "
        "the line, and blank lines count) and writes one URL slug per line to stdout, in order. A slug is made "
        "like this, in this order: lowercase the line (str.lower); replace ß with ss, æ with ae, œ with oe, ø, ð "
        "and đ with o, d and d, þ with th and ł with l; apply Unicode NFKD normalisation and delete the combining "
        "marks; turn every run of characters outside a-z and 0-9 into a single hyphen; strip leading and trailing "
        "hyphens; cut to at most 40 characters and strip trailing hyphens again; an empty result becomes "
        "`untitled`. Finally make slugs unique across the whole input: if a slug is already taken by an earlier "
        "line, append -2, -3, ... using the first number whose result is not yet taken (the suffix is added after "
        "the 40-character cut). Read and write UTF-8 regardless of the locale."
    )

    TABLE = [("ß", "ss"), ("æ", "ae"), ("œ", "oe"), ("ø", "o"), ("ð", "d"), ("đ", "d"), ("þ", "th"), ("ł", "l")]

    @staticmethod
    def slug(s):
        s = s.lower()
        for a, b in SlugifyBatch.TABLE:
            s = s.replace(a, b)
        s = unicodedata.normalize("NFKD", s)
        s = "".join(c for c in s if not unicodedata.combining(c))
        s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
        s = s[:40].rstrip("-")
        return s or "untitled"

    @staticmethod
    def oracle(lines):
        seen, out = set(), []
        for l in lines:
            base = SlugifyBatch.slug(l)
            cand, n = base, 1
            while cand in seen:
                n += 1
                cand = f"{base}-{n}"
            seen.add(cand)
            out.append(cand)
        return out

    CASES = [
        ["Hello, World!", "  Hello,   World!  ", "hello world", "Hello World"],
        ["Crème Brûlée", "Straße", "STRASSE", "Ærø Œuvre", "Zażółć gęślą jaźń", "Ñandú", "Þórr Ðæmi Đồng"],
        ["日本語", "", "---", "!!!", "x²", "ﬁne ﬂour", "Ⅷ rooms", "Ünïcödé Тест"],
        ["a", "a", "a-2", "a", "a 2", "a-3"],
        ["a" * 50, "a" * 50, "a" * 39 + " bbb", "a" * 39 + "-bbb", "a" * 40, "a" * 41],
        ["untitled", "", "日本", "untitled-2", "!"],
        ["Release v1.2.3 (final)", "release v1.2.3 final", "Release: v1.2.3 / final!"],
        ["İstanbul", "ISTANBUL", "ǅ", "ǆ"],
    ]

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "titles.txt", "Hello, World!\nCrème Brûlée\nHello World\n")

    @staticmethod
    def grade(d: Path):
        if not (d / "slugify.py").exists():
            return False, "no slugify.py"
        for i, lines in enumerate(SlugifyBatch.CASES):
            for eol in ("\n", "\r\n"):
                data = "".join(l + eol for l in lines).encode("utf-8")
                r = runb(["python3", "slugify.py"], cwd=d, inp=data, env={"LC_ALL": "C", "LANG": "C", "PYTHONUTF8": "", "PYTHONIOENCODING": ""})
                want = SlugifyBatch.oracle(lines)
                got = r.stdout.decode("utf-8", "replace").split("\n")
                if r.returncode != 0 or got != want + [""]:
                    for a, b in zip(got, want):
                        if a != b:
                            return False, f"case {i} (eol {eol!r}): input {lines[want.index(b)]!r}: got {a!r} want {b!r}"
                    return False, f"case {i}: exit {r.returncode}, {len(got) - 1} lines, want {len(want)}: {r.stderr.decode()[-120:]}"
        return True, f"{len(SlugifyBatch.CASES)} cases"


# ================================================================ 16. text-wrap-cli
class TextWrap:
    name = "text-wrap-cli"
    PROMPT = (
        "Write wrap.py: `python3 wrap.py WIDTH` reads text from stdin and writes it re-wrapped to at most WIDTH "
        "characters per line (counted in Unicode characters). Paragraphs are separated by one or more blank "
        "lines (lines empty or holding only ASCII whitespace); each is re-flowed greedily: words (separated by "
        "runs of ASCII whitespace -- space, tab, CR, LF, FF, VT -- and nothing else, so U+00A0 and other Unicode "
        "spaces are ordinary characters inside a word) are packed onto a line while they fit, single-spaced. A "
        "word longer than WIDTH sits alone on its own line, never split, and hyphenated words are never split "
        "either. Output has no trailing spaces, one blank line between paragraphs, and ends with a single "
        "newline; empty or all-blank input gives empty output. WIDTH must be a positive integer, otherwise print "
        "a usage message to stderr and exit with status 2."
    )

    @staticmethod
    def oracle(text, width):
        paras, cur = [], []
        for line in text.split("\n"):
            if not line.strip(" \t\r\f\v"):
                if cur:
                    paras.append(cur)
                cur = []
            else:
                cur.extend(re.split(r"[ \t\r\n\f\v]+", line.strip(" \t\r\f\v")))
        if cur:
            paras.append(cur)
        out = []
        for words in paras:
            lines, line = [], words[0]
            for w in words[1:]:
                if len(line) + 1 + len(w) <= width:
                    line += " " + w
                else:
                    lines.append(line)
                    line = w
            lines.append(line)
            out.append("\n".join(lines))
        return "\n\n".join(out) + "\n" if out else ""

    TEXT = (
        "The quick brown fox jumps over the lazy dog. A well-known state-of-the-art technique; see "
        "https://example.com/a/very/long/url/that/will/not/fit/anywhere for details.\n\n\n"
        "   Second\tparagraph\twith   odd   spacing\r\nand a CRLF line break.\n   \nThird: the na\u00efve caf\u00e9 "
        "owner\u00a0keeps\u00a0nbsp\u00a0words together, \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8 too.\n"
        "x\n\n\n\n"
    )

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "sample.txt", TextWrap.TEXT)

    @staticmethod
    def grade(d: Path):
        if not (d / "wrap.py").exists():
            return False, "no wrap.py"
        inputs = [TextWrap.TEXT, "", "   \n\n \t\n", "one", "a b c d e f g h i j k l m n o p", "word " * 30, "\n\nlead\n", "x" * 100 + " y " + "z" * 3 + "\n",
                  "end-of-line   \nstill same paragraph\n\nnew"]
        for width in (1, 5, 10, 20, 37, 80):
            for text in inputs:
                r = runb(["python3", "wrap.py", str(width)], cwd=d, inp=text.encode("utf-8"))
                want = TextWrap.oracle(text, width)
                got = r.stdout.decode("utf-8")
                if r.returncode != 0 or got != want:
                    return False, f"width {width}, input {text[:30]!r}: got {got[:90]!r} want {want[:90]!r} (exit {r.returncode})"
        for bad in ("0", "-3", "abc", "", "2.5"):
            r = runb(["python3", "wrap.py", bad], cwd=d, inp=b"hello\n")
            if r.returncode != 2 or r.stdout:
                return False, f"WIDTH {bad!r}: exit {r.returncode}, want 2 and no stdout"
        r = runb(["python3", "wrap.py"], cwd=d, inp=b"hello\n")
        if r.returncode != 2:
            return False, "missing WIDTH should exit 2"
        return True, "all widths"


# ================================================================ 17. sqlite-migrate
class SqliteMigrate:
    name = "sqlite-migrate"
    PROMPT = (
        "app.db is at schema version 1 (PRAGMA user_version = 1). Write migrate.py: `python3 migrate.py DB` "
        "migrates the database in place to version 2, keeping all data: (1) a new table customers(id INTEGER "
        "PRIMARY KEY, email TEXT NOT NULL UNIQUE) holding each distinct customer of orders, where the old "
        "orders.customer text is an email that must be trimmed and lowercased to compare, ids assigned 1, 2, 3, "
        "... in order of first appearance by orders.id, email stored trimmed and lowercased; (2) orders becomes "
        "(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), amount_cents INTEGER NOT "
        "NULL, placed_at TEXT NOT NULL, note TEXT) in exactly that column order, with the same ids and data, "
        "customer replaced by customer_id and amount (dollars, REAL) replaced by amount_cents rounded to the "
        "nearest cent; (3) the existing index idx_orders_placed must still exist on orders(placed_at) and a new "
        "index idx_orders_customer on orders(customer_id) is added; (4) order_items must keep working and keep "
        "referencing orders(id); (5) finally set user_version to 2. Running it on a database already at version "
        "2 changes nothing and exits 0; any other version leaves the database untouched "
        "and exits 1. After migrating, PRAGMA foreign_key_check and integrity_check "
        "must come back clean."
    )

    @staticmethod
    def make_v1(path: Path, seed: int, n: int):
        rnd = random.Random(seed)
        Path(path).unlink(missing_ok=True)
        db = sqlite3.connect(path)
        db.executescript(
            "CREATE TABLE orders(id INTEGER PRIMARY KEY, customer TEXT NOT NULL, amount REAL NOT NULL, placed_at TEXT NOT NULL, note TEXT);"
            "CREATE INDEX idx_orders_placed ON orders(placed_at);"
            "CREATE TABLE order_items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), sku TEXT NOT NULL, qty INTEGER NOT NULL);"
        )
        people = ["ada@example.com", "ben@example.com", "Cleo@Example.com", "dmitri@example.org", "esi@example.net"]
        fixed = [19.99, 0.29, 4.35, 8.2, 1.15, 2.675, 100.0, 0.07, 33.33, 1234567.89]
        for i in range(1, n + 1):
            who = rnd.choice(people)
            who = rnd.choice([who, who.upper(), " " + who + " ", who.title()])
            amt = fixed[i - 1] if i <= len(fixed) else round(rnd.uniform(0.01, 999.99), 2)
            if amt == 2.675:
                amt = 2.68
            db.execute("INSERT INTO orders VALUES(?,?,?,?,?)", (i * 3, who, amt, f"2024-0{rnd.randint(1, 9)}-{rnd.randint(10, 28)}", rnd.choice([None, "gift", ""])))
            for _ in range(rnd.randint(0, 3)):
                db.execute("INSERT INTO order_items(order_id, sku, qty) VALUES(?,?,?)", (i * 3, rnd.choice(["A", "B", "C"]), rnd.randint(1, 5)))
        db.execute("PRAGMA user_version = 1")
        db.commit()
        db.close()

    @staticmethod
    def setup(d: Path) -> None:
        SqliteMigrate.make_v1(d / "app.db", 1, 25)

    @staticmethod
    def check(path: Path, orig: Path):
        a = sqlite3.connect(orig)
        b = sqlite3.connect(path)
        try:
            if b.execute("PRAGMA user_version").fetchone()[0] != 2:
                return "user_version is not 2"
            cols = [r[1] for r in b.execute("PRAGMA table_info(orders)")]
            if cols != ["id", "customer_id", "amount_cents", "placed_at", "note"]:
                return f"orders columns are {cols}"
            ccols = [(r[1], r[2], r[3], r[5]) for r in b.execute("PRAGMA table_info(customers)")]
            if ccols != [("id", "INTEGER", 0, 1), ("email", "TEXT", 1, 0)]:
                return f"customers columns are {ccols}"
            old = a.execute("SELECT id, customer, amount, placed_at, note FROM orders ORDER BY id").fetchall()
            emails, want_orders = {}, []
            for oid, cust, amt, placed, note in old:
                e = cust.strip().lower()
                emails.setdefault(e, len(emails) + 1)
                want_orders.append((oid, emails[e], int((Decimal(repr(amt)) * 100).quantize(Decimal(1), rounding="ROUND_HALF_UP")), placed, note))
            if b.execute("SELECT id, email FROM customers ORDER BY id").fetchall() != sorted((i, e) for e, i in emails.items()):
                return "customers rows are wrong"
            got = b.execute("SELECT id, customer_id, amount_cents, placed_at, note FROM orders ORDER BY id").fetchall()
            if got != want_orders:
                for x, y in zip(got, want_orders):
                    if x != y:
                        return f"orders row {x} should be {y}"
                return "orders row count differs"
            if any(type(r[2]) is not int for r in got):
                return "amount_cents is not stored as an integer"
            idx = {r[1]: r[2] for r in b.execute("PRAGMA index_list(orders)")}
            if "idx_orders_placed" not in idx or "idx_orders_customer" not in idx:
                return f"indexes on orders are {sorted(idx)}"
            if [r[2] for r in b.execute("PRAGMA index_info(idx_orders_placed)")] != ["placed_at"] or [r[2] for r in b.execute("PRAGMA index_info(idx_orders_customer)")] != ["customer_id"]:
                return "index columns are wrong"
            if [(r[2], r[3], r[4]) for r in b.execute("PRAGMA foreign_key_list(orders)")] != [("customers", "customer_id", "id")]:
                return "orders no longer has its foreign key to customers(id)"
            if [(r[2], r[3], r[4]) for r in b.execute("PRAGMA foreign_key_list(order_items)")] != [("orders", "order_id", "id")]:
                return f"order_items foreign key is {list(b.execute('PRAGMA foreign_key_list(order_items)'))}"
            if a.execute("SELECT * FROM order_items ORDER BY id").fetchall() != b.execute("SELECT * FROM order_items ORDER BY id").fetchall():
                return "order_items data changed"
            if b.execute("PRAGMA foreign_key_check").fetchall():
                return "foreign_key_check reports violations"
            if b.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                return "integrity_check failed"
            names = {r[0] for r in b.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if names != {"orders", "order_items", "customers"}:
                return f"tables are {sorted(names)}"
            return None
        finally:
            a.close()
            b.close()

    @staticmethod
    def grade(d: Path):
        if not (d / "migrate.py").exists():
            return False, "no migrate.py"
        tmp = Path(tempfile.mkdtemp(prefix="grade3-"))
        try:
            shutil.copy(d / "migrate.py", tmp / "migrate.py")
            for seed, n in ((1, 25), (7, 60)):
                SqliteMigrate.make_v1(tmp / "orig.db", seed, n)
                shutil.copy(tmp / "orig.db", tmp / "t.db")
                r = runb(["python3", "migrate.py", "t.db"], cwd=tmp)
                if r.returncode != 0:
                    return False, f"seed {seed}: exit {r.returncode}: {r.stderr.decode()[-200:]}"
                bad = SqliteMigrate.check(tmp / "t.db", tmp / "orig.db")
                if bad:
                    return False, f"seed {seed}: {bad}"
                dump1 = subprocess.run(["python3", "-c", "import sqlite3,sys;print('\\n'.join(sqlite3.connect('t.db').iterdump()))"], cwd=tmp, capture_output=True).stdout
                r = runb(["python3", "migrate.py", "t.db"], cwd=tmp)
                dump2 = subprocess.run(["python3", "-c", "import sqlite3,sys;print('\\n'.join(sqlite3.connect('t.db').iterdump()))"], cwd=tmp, capture_output=True).stdout
                if r.returncode != 0 or dump1 != dump2:
                    return False, f"seed {seed}: a second run exit {r.returncode} / changed the database"
            for ver in (0, 3):
                shutil.copy(tmp / "orig.db", tmp / "u.db")
                c = sqlite3.connect(tmp / "u.db")
                c.execute(f"PRAGMA user_version = {ver}")
                c.commit()
                c.close()
                before = (tmp / "u.db").read_bytes()
                r = runb(["python3", "migrate.py", "u.db"], cwd=tmp)
                if r.returncode != 1 or (tmp / "u.db").read_bytes() != before:
                    return False, f"user_version {ver}: exit {r.returncode}, database {'changed' if (tmp / 'u.db').read_bytes() != before else 'untouched'}"
            return True, "migrated, idempotent"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 18. vendor-units-workaround
VENDOR_UNITS = '''"""units 1.4.2 -- vendored copy. Do not edit: CI compares vendor/ against the upstream checksums."""
import re

_UNITS = {"s": 1, "m": 2592000, "mo": 2592000, "h": 3600, "d": 86400, "w": 604800}


def parse_duration(spec):
    """Parse '<number><unit>' (single unit) into seconds."""
    m = re.fullmatch(r"\\s*(\\d+(?:\\.\\d+)?)\\s*([a-z]+)\\s*", spec)
    if not m:
        raise ValueError("bad duration: %r" % (spec,))
    unit = m.group(2)
    if unit not in _UNITS:
        raise ValueError("unknown unit: %r" % (unit,))
    return float(m.group(1)) * _UNITS[unit]
'''
RETRY_PY = '''"""Retry delays."""
from vendor import units


def delay_seconds(spec):
    """Seconds to wait for a duration spec such as '90s' or '5m'."""
    return units.parse_duration(spec)
'''
SCHEDULE_PY = '''import json

from app.retry import delay_seconds


def load_schedule(path):
    """{name: seconds} for every duration in a JSON config file."""
    with open(path) as f:
        cfg = json.load(f)
    return {name: delay_seconds(spec) for name, spec in cfg.items()}
'''


class VendorUnits:
    name = "vendor-units-workaround"
    PROMPT = (
        "Our retry delays are wrong: a config value of \"5m\" makes the app wait about five months. The cause is in "
        "vendor/units.py, a pinned third-party copy whose checksums CI verifies, so nothing under vendor/ may be "
        "changed, added or removed. Fix the app instead (app/retry.py's delay_seconds, which app/schedule.py's "
        "load_schedule uses). delay_seconds(spec) must accept: a number (integer or decimal) followed by a unit "
        "s, m (minutes), h, d or w (lowercase only), optional spaces between number and unit, and several such "
        "parts in a row ('1h30m', '2d 4h 30s'), with leading/trailing whitespace allowed. It returns the total "
        "in seconds (an int when whole, otherwise a float). Anything else -- empty, bare numbers, unknown units "
        "such as 'mo' or 'y', uppercase units, negative or signed numbers -- raises ValueError."
    )

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "vendor/__init__.py", "")
        write(d, "vendor/units.py", VENDOR_UNITS)
        write(d, "app/__init__.py", "")
        write(d, "app/retry.py", RETRY_PY)
        write(d, "app/schedule.py", SCHEDULE_PY)
        write(d, "config.json", json.dumps({"backoff": "5m", "timeout": "90s", "cooldown": "1h30m", "report": "1.5h"}, indent=2))

    GOOD = [("90s", 90), ("5m", 300), ("1h", 3600), ("2d", 172800), ("1w", 604800), ("1.5h", 5400), ("0s", 0), ("0.5m", 30),
            (" 5m ", 300), ("5 m", 300), ("1h30m", 5400), ("2d 4h 30s", 2 * 86400 + 4 * 3600 + 30), ("1w 1d 1h 1m 1s", 604800 + 86400 + 3600 + 61),
            ("0.25h", 900), ("100s", 100), ("1m 0.5s", 60.5)]
    BAD = ["", "  ", "5", "5mo", "1y", "5M", "5S", "-5m", "+5m", "5m-", "m", "1h 30", "1h,30m", "1..5h", "5 ms", "five minutes", "1e3s", "1h30"]

    @staticmethod
    def grade(d: Path):
        tmp, w = scratch_copy(d)
        try:
            ref = Path(tempfile.mkdtemp(prefix="grade3-"))
            try:
                VendorUnits.setup(ref)
                if digest(ref / "vendor") != digest(w / "vendor"):
                    return False, "vendor/ was changed"
            finally:
                shutil.rmtree(ref, ignore_errors=True)
            code = (
                "import json, math, sys\n"
                "from app.retry import delay_seconds\n"
                "from app.schedule import load_schedule\n"
                f"GOOD = {VendorUnits.GOOD!r}\nBAD = {VendorUnits.BAD!r}\n"
                "for spec, want in GOOD:\n"
                "    try: got = delay_seconds(spec)\n"
                "    except Exception as e: print(f'{spec!r}: raised {e!r}'); sys.exit()\n"
                "    if not math.isclose(got, want, rel_tol=1e-9, abs_tol=1e-9) or (float(want).is_integer() and not isinstance(got, int)):\n"
                "        print(f'{spec!r}: got {got!r} want {want!r}'); sys.exit()\n"
                "for spec in BAD:\n"
                "    try: got = delay_seconds(spec)\n"
                "    except ValueError: continue\n"
                "    except Exception as e: print(f'{spec!r}: raised {type(e).__name__}, want ValueError'); sys.exit()\n"
                "    print(f'{spec!r}: accepted as {got!r}'); sys.exit()\n"
                "json.dump({'a': '2m', 'b': '1h 1s'}, open('cfg2.json', 'w'))\n"
                "if load_schedule('cfg2.json') != {'a': 120, 'b': 3601}: print('load_schedule wrong:', load_schedule('cfg2.json')); sys.exit()\n"
                "if load_schedule('config.json') != {'backoff': 300, 'timeout': 90, 'cooldown': 5400, 'report': 5400}: print('config.json schedule wrong:', load_schedule('config.json')); sys.exit()\n"
                "print('OK')\n"
            )
            ok, why = py_check(w, code)
            return ok, why
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 19. rename-api-signature
SHOP_FILES = {
    "shop/__init__.py": "",
    "shop/db.py": '''import sqlite3


def connect(path=":memory:"):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT)")
    return conn


def get_user(db, uid):
    """Return the user with this id as a dict, or None."""
    row = db.execute("SELECT id, name, email FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        return None
    return {"id": row[0], "name": row[1], "email": row[2]}


def get_user_by_name(db, name):
    row = db.execute("SELECT id FROM users WHERE name = ?", (name,)).fetchone()
    return None if row is None else get_user(db, row[0])
''',
    "shop/views.py": '''import functools

from shop.db import get_user


def profile(db, uid):
    u = get_user(db, uid)
    if u is None:
        return "unknown"
    return "%s <%s>" % (u["name"], u["email"])


def profiles(db, uids):
    return [profile(db, u) for u in uids if get_user(db, u)]


def make_loader(db):
    """A one-argument loader bound to this connection."""
    return functools.partial(get_user, db)
''',
    "shop/billing.py": '''from shop.db import get_user as _gu


def invoice_owner(db, order):
    owner = _gu(
        db,
        order["user_id"],
    )
    return owner["name"] if owner else None


def total_for(db, orders):
    # get_user is cheap, no caching needed
    return sum(o["cents"] for o in orders if _gu(db, o["user_id"]))
''',
    "shop/notify.py": '''import shop.db as sdb


def welcome(db, uid):
    user = sdb.get_user(db, uid)
    return "Welcome, %s!" % user["name"] if user else "Welcome!"


def by_keyword(db, uid):
    return sdb.get_user(uid=uid, db=db)
''',
    "shop/registry.py": '''import json
import os

import shop.db

with open(os.path.join(os.path.dirname(__file__), "plugins.json")) as _f:
    PLUGINS = json.load(_f)


def load(name):
    """Look a data-access function up by its configured name."""
    return getattr(shop.db, PLUGINS[name])
''',
    "shop/plugins.json": '{"user_loader": "get_user", "name_loader": "get_user_by_name"}\n',
    "shop/cli.py": '''import sys

from shop import views


def main(argv, db):
    if len(argv) == 2 and argv[0] == "show":
        print(views.profile(db, int(argv[1])))
        return 0
    print("usage: show UID", file=sys.stderr)
    return 2
''',
    "scripts/audit.py": '''"""Report users that look incomplete."""
from shop.db import get_user


def audit(conn, ids):
    bad = []
    for uid in ids:
        u = get_user(conn, uid)
        if u is None or not u["email"]:
            bad.append(uid)
    return bad
''',
    "README.md": "# shop\n\nUse `shop.db.get_user(db, uid)` to load a user; `get_user_by_name(db, name)` looks one up by name.\n",
    "docs/API.md": "# API\n\n## get_user(db, uid)\n\nReturns a dict `{id, name, email}` or `None`.\n\nExample: `u = get_user(conn, 5)`\n\n## get_user_by_name(db, name)\n\nSame, looked up by name.\n",
    "CHANGELOG.md": "# Changelog\n\n## 1.2\n- Added get_user_by_name.\n\n## 1.0\n- Initial release: get_user(db, uid).\n",
    "tests/__init__.py": "",
    "tests/test_shop.py": '''import unittest

from shop import billing, db, notify, registry, views
from shop.db import get_user


class ShopTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect()
        self.conn.execute("INSERT INTO users VALUES (1, 'Ada', 'ada@x.org')")
        self.conn.execute("INSERT INTO users VALUES (2, 'Ben', '')")

    def test_get_user(self):
        self.assertEqual(get_user(self.conn, 1)["name"], "Ada")
        self.assertIsNone(get_user(self.conn, 9))

    def test_by_name(self):
        self.assertEqual(db.get_user_by_name(self.conn, "Ben")["id"], 2)

    def test_views(self):
        self.assertEqual(views.profile(self.conn, 1), "Ada <ada@x.org>")
        self.assertEqual(views.profiles(self.conn, [1, 2, 3]), ["Ada <ada@x.org>", "Ben <>"])
        self.assertEqual(views.make_loader(self.conn)(2)["name"], "Ben")

    def test_billing(self):
        self.assertEqual(billing.invoice_owner(self.conn, {"user_id": 1}), "Ada")
        self.assertEqual(billing.total_for(self.conn, [{"user_id": 1, "cents": 5}, {"user_id": 7, "cents": 9}]), 5)

    def test_notify_and_registry(self):
        self.assertEqual(notify.welcome(self.conn, 1), "Welcome, Ada!")
        self.assertEqual(notify.by_keyword(self.conn, 2)["name"], "Ben")
        self.assertEqual(registry.load("user_loader")(self.conn, 1)["email"], "ada@x.org")


if __name__ == "__main__":
    unittest.main()
''',
}


class RenameApi:
    name = "rename-api-signature"
    PROMPT = (
        "Rename shop.db.get_user(db, uid) to fetch_user(uid, *, db) -- new name, and `db` becomes a keyword-only "
        "argument after uid -- and update everything that uses it: every call site in the package and in "
        "scripts/, including calls through an import alias, multi-line calls and anything that binds the "
        "function (partial and the like), the name looked up by string in shop/plugins.json, the tests in "
        "tests/, and the docs (README.md, docs/API.md). Don't leave the old name behind as an alias. "
        "get_user_by_name keeps its name and its (db, name) signature. CHANGELOG.md records history: leave it "
        "exactly as it is. Apart from CHANGELOG.md, the old name get_user must not appear anywhere in the "
        "project any more (comments included). Behaviour must stay the same and the tests must pass."
    )

    @staticmethod
    def setup(d: Path) -> None:
        for rel, txt in SHOP_FILES.items():
            write(d, rel, txt)

    HARNESS = r'''
import inspect, runpy, sys
sys.path.insert(0, ".")
from shop import db, views, billing, notify, registry, cli
conn = db.connect()
conn.execute("INSERT INTO users VALUES (1, 'Ada', 'ada@x.org')")
conn.execute("INSERT INTO users VALUES (2, 'Ben', '')")
if hasattr(db, "get_user"): print("shop.db still has get_user"); sys.exit()
sig = inspect.signature(db.fetch_user)
ps = list(sig.parameters.values())
if [p.name for p in ps] != ["uid", "db"] or ps[0].kind not in (ps[0].POSITIONAL_OR_KEYWORD, ps[0].POSITIONAL_ONLY) or ps[1].kind != ps[1].KEYWORD_ONLY:
    print(f"fetch_user signature is {sig}"); sys.exit()
if db.fetch_user(1, db=conn) != {"id": 1, "name": "Ada", "email": "ada@x.org"} or db.fetch_user(9, db=conn) is not None:
    print("fetch_user returns the wrong thing"); sys.exit()
try:
    db.fetch_user(conn, 1); print("fetch_user(conn, 1) should not be accepted"); sys.exit()
except TypeError:
    pass
if db.get_user_by_name(conn, "Ben")["id"] != 2 or list(inspect.signature(db.get_user_by_name).parameters) != ["db", "name"]:
    print("get_user_by_name changed"); sys.exit()
checks = [
    ("views.profile", lambda: views.profile(conn, 1) == "Ada <ada@x.org>"),
    ("views.profiles", lambda: views.profiles(conn, [1, 2, 3]) == ["Ada <ada@x.org>", "Ben <>"]),
    ("views.make_loader", lambda: views.make_loader(conn)(2)["name"] == "Ben"),
    ("billing.invoice_owner", lambda: billing.invoice_owner(conn, {"user_id": 1}) == "Ada"),
    ("billing.total_for", lambda: billing.total_for(conn, [{"user_id": 1, "cents": 5}, {"user_id": 7, "cents": 9}]) == 5),
    ("notify.welcome", lambda: notify.welcome(conn, 1) == "Welcome, Ada!" and notify.welcome(conn, 8) == "Welcome!"),
    ("notify.by_keyword", lambda: notify.by_keyword(conn, 2)["name"] == "Ben"),
    ("registry user_loader", lambda: registry.load("user_loader")(1, db=conn)["email"] == "ada@x.org"),
    ("registry name_loader", lambda: registry.load("name_loader")(conn, "Ada")["id"] == 1),
    ("cli show", lambda: cli.main(["show", "1"], conn) == 0),
    ("scripts/audit.py", lambda: runpy.run_path("scripts/audit.py")["audit"](conn, [1, 2, 3]) == [2, 3]),
]
for name, fn in checks:
    try:
        ok = fn()
    except Exception as e:
        print(f"{name}: raised {type(e).__name__}: {e}"); sys.exit()
    if not ok:
        print(f"{name}: wrong result"); sys.exit()
print("OK")
'''

    @staticmethod
    def grade(d: Path):
        tmp, w = scratch_copy(d)
        try:
            if (d / "CHANGELOG.md").read_text() != SHOP_FILES["CHANGELOG.md"]:
                return False, "CHANGELOG.md was modified"
            for rel in sorted(all_files(w)):
                if rel == "CHANGELOG.md" or not rel.endswith((".py", ".md", ".json", ".txt", ".toml", ".cfg", ".sh")):
                    continue
                txt = (w / rel).read_text(errors="replace")
                if re.search(r"\bget_user\b", txt):
                    return False, f"{rel} still mentions get_user"
            if "fetch_user" not in (w / "docs/API.md").read_text() or "fetch_user" not in (w / "README.md").read_text():
                return False, "docs do not mention fetch_user"
            if '"fetch_user"' not in (w / "shop/plugins.json").read_text():
                return False, "shop/plugins.json does not name fetch_user"
            if "get_user_by_name" not in (w / "shop/db.py").read_text():
                return False, "get_user_by_name is gone"
            ok, why = py_check(w, RenameApi.HARNESS)
            if not ok:
                return False, why
            r = runb(["python3", "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=w, timeout=60)
            out = (r.stdout + r.stderr).decode()
            m = re.search(r"Ran (\d+) tests?", out)
            if r.returncode != 0 or not m:
                return False, f"the project's tests fail: {out[-200:]}"
            if int(m.group(1)) < 5:
                return False, f"only {m.group(1)} tests ran, the suite had 5"
            return True, "renamed everywhere"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 20. sessionize-logs
class SessionizeLogs:
    name = "sessionize-logs"
    PROMPT = (
        "access.log is an Apache combined-format log (ip ident user [dd/Mon/yyyy:HH:MM:SS +zzzz] \"request\" "
        "status bytes \"referer\" \"user-agent\"). Write sessions.py: `python3 sessions.py access.log out.csv` "
        "groups hits into visitor sessions. A visitor is an (ip, user-agent) pair. A hit is a line that parses in "
        "that format with a request of the form `METHOD PATH PROTOCOL` (three space-separated parts), except "
        "static assets: a PATH (ignoring any ?query) starting with /static/ or equal to /favicon.ico is not a "
        "hit; lines that do not parse are skipped. The file is NOT in time order and timestamps carry different "
        "UTC offsets: order each visitor's hits by the real instant (ties keep file order). A visitor's hit "
        "starts a new session when it comes more than 30 minutes (1800 seconds; exactly 1800 still continues) "
        "after the visitor's previous hit. Write out.csv with the header ip,user_agent,start,end,hits,"
        "duration_seconds, one row per session, start and end in UTC as YYYY-MM-DDTHH:MM:SSZ (first and last "
        "hit), duration_seconds = end - start, rows sorted by start, then ip, then user_agent."
    )

    MONTHS = {m: i for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}
    RX = re.compile(r'(\S+) \S+ \S+ \[(\d\d)/(\w{3})/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)\] "([^"]*)" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"')

    @staticmethod
    def gen(seed, n):
        rnd = random.Random(seed)
        visitors = [("10.0.0.%d" % i, ua) for i in range(1, 5) for ua in ("Mozilla/5.0 (X11; Linux)", "curl/8.0, test")][:6] + [("2001:db8::1", "Mozilla/5.0 (X11; Linux)")]
        inv = {v: k for k, v in SessionizeLogs.MONTHS.items()}
        lines = []
        base = dt.datetime(2024, 3, 9, 22, 0, 0)
        for _ in range(n):
            ip, ua = rnd.choice(visitors)
            t = base + dt.timedelta(seconds=rnd.choice([rnd.randint(0, 40000), rnd.randint(0, 4000), rnd.randint(0, 40000)]))
            if rnd.random() < 0.15:
                t = t.replace(second=0)
            off = rnd.choice([0, -420, 120, 330, 0])
            local = t + dt.timedelta(minutes=off)
            sign = "+" if off >= 0 else "-"
            path = rnd.choice(["/", "/a", "/b?x=1", "/static/app.js", "/static/", "/favicon.ico", "/favicon.ico?v=2", "/staticfoo", "/api/x"])
            req = rnd.choice(['GET %s HTTP/1.1', 'POST %s HTTP/2.0', 'GET %s HTTP/1.1']) % path
            if rnd.random() < 0.04:
                req = "-"
            if rnd.random() < 0.03:
                req = "GET %s" % path
            line = '%s - - [%02d/%s/%d:%02d:%02d:%02d %s%02d%02d] "%s" %s %s "-" "%s"' % (
                ip, local.day, inv[local.month], local.year, local.hour, local.minute, local.second, sign, abs(off) // 60, abs(off) % 60, req,
                rnd.choice(["200", "404", "500"]), rnd.choice(["123", "-"]), ua)
            if rnd.random() < 0.03:
                line = "garbage line without structure"
            lines.append(line)
        # exact 1800s and 1801s boundaries for one visitor
        for k, (ip, ua) in enumerate([("9.9.9.9", "edge/1")]):
            for ts in ("2024-03-10 00:00:00", "2024-03-10 00:30:00", "2024-03-10 01:00:01", "2024-03-10 01:00:01", "2024-03-10 05:00:00"):
                t = dt.datetime.fromisoformat(ts)
                lines.append('%s - - [%02d/%s/%d:%02d:%02d:%02d +0000] "GET /e HTTP/1.1" 200 1 "-" "%s"' % (ip, t.day, inv[t.month], t.year, t.hour, t.minute, t.second, ua))
        rnd.shuffle(lines)
        return lines

    @staticmethod
    def oracle(lines):
        by = {}
        for idx, line in enumerate(lines):
            m = SessionizeLogs.RX.fullmatch(line)
            if not m:
                continue
            ip, dd, mon, yy, hh, mi, ss, sg, oh, om, req, _st, _b, _ref, ua = m.groups()
            parts = req.split(" ")
            if len(parts) != 3:
                continue
            path = parts[1].split("?")[0]
            if path.startswith("/static/") or path == "/favicon.ico":
                continue
            t = dt.datetime(int(yy), SessionizeLogs.MONTHS[mon], int(dd), int(hh), int(mi), int(ss))
            t -= (1 if sg == "+" else -1) * dt.timedelta(hours=int(oh), minutes=int(om))
            by.setdefault((ip, ua), []).append((t, idx))
        rows = []
        for (ip, ua), hits in by.items():
            hits.sort()
            sess = [[hits[0][0], hits[0][0], 1]]
            for t, _ in hits[1:]:
                if (t - sess[-1][1]).total_seconds() > 1800:
                    sess.append([t, t, 1])
                else:
                    sess[-1][1] = t
                    sess[-1][2] += 1
            for a, b, c in sess:
                rows.append([ip, ua, a.strftime("%Y-%m-%dT%H:%M:%SZ"), b.strftime("%Y-%m-%dT%H:%M:%SZ"), str(c), str(int((b - a).total_seconds()))])
        rows.sort(key=lambda r: (r[2], r[0], r[1]))
        return rows

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "access.log", "\n".join(SessionizeLogs.gen(1, 60)) + "\n")

    @staticmethod
    def grade(d: Path):
        if not (d / "sessions.py").exists():
            return False, "no sessions.py"
        tmp, w = scratch_copy(d)
        try:
            for seed, n in ((1, 60), (2, 600)):
                lines = SessionizeLogs.gen(seed, n)
                (w / "t.log").write_bytes(("\n".join(lines) + "\n").encode())
                (w / "o.csv").unlink(missing_ok=True)
                r = runb(["python3", "sessions.py", "t.log", "o.csv"], cwd=w)
                if r.returncode != 0 or not (w / "o.csv").exists():
                    return False, f"exit {r.returncode}: {r.stderr.decode()[-150:]}"
                with open(w / "o.csv", newline="", encoding="utf-8") as f:
                    rd = list(csv.reader(f))
                if rd[:1] != [["ip", "user_agent", "start", "end", "hits", "duration_seconds"]]:
                    return False, f"bad header {rd[:1]}"
                want = SessionizeLogs.oracle(lines)
                if rd[1:] != want:
                    for a, b in zip(rd[1:], want):
                        if a != b:
                            return False, f"seed {seed}: got {a} want {b}"
                    return False, f"seed {seed}: {len(rd) - 1} sessions, want {len(want)}"
            return True, "sessions match"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 21. ledger-balance
class LedgerBalance:
    name = "ledger-balance"
    PROMPT = (
        "Write ledger.py: `python3 ledger.py FILE [--until YYYY-MM-DD]` reads a plain-text double-entry journal "
        "and prints a balance report. Journal: blank lines and lines starting with ; or # are ignored. A "
        "transaction starts at a line beginning (column 0) with a date YYYY-MM-DD followed by a space and a "
        "description; its postings are the following lines that start with a space or tab, up to the next line "
        "that does not (indented comment lines starting with ; are skipped). A posting is `ACCOUNT` or "
        "`ACCOUNT` followed by two or more spaces or a tab and then `AMOUNT`, optionally followed by a comment "
        "starting with ;. Account names may contain single spaces, and colons make a hierarchy "
        "(Assets:Bank:Checking). AMOUNT is dollars: `$` required, with an optional minus before the $ or after "
        "it (`-$5`, `$-5`), optional thousands commas, 0 to 2 decimals (`$1,234.50`, `$7`). At most one "
        "posting of a transaction may omit its amount: it receives whatever makes the transaction sum to zero. "
        "Every transaction must sum to exactly zero after that; a transaction that does not, one with two or "
        "more amount-less postings, or one with a malformed amount is an error: print `line N: ...` (N = the "
        "line number of its date line) to stderr, nothing to stdout, exit 1. All transactions are validated even "
        "when --until excludes them. Report: only transactions dated <= the --until date are counted (all of "
        "them without it). Every account and every ancestor of an account (each prefix ending before a colon) "
        "gets the sum of the postings in it and below it; accounts whose total is exactly zero are left out. "
        "One line per account, sorted by full account name in plain codepoint order, formatted as the amount "
        "right-aligned in 12 columns, two spaces, then the account name. Amounts print as $1,234.50 or "
        "-$1,234.50, always with two decimals. Use exact decimal arithmetic."
    )

    AMT = re.compile(r"(-?)\$(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?")

    @staticmethod
    def fmt(c):
        s = f"${abs(c) // 100:,}.{abs(c) % 100:02d}"
        return "-" + s if c < 0 else s

    @staticmethod
    def oracle(text, until=None):
        lines = text.split("\n")
        txns = []
        cur = None
        for no, raw in enumerate(lines, 1):
            if not raw.strip() or raw[0] in ";#":
                continue
            if raw[0] in " \t":
                if raw.strip().startswith(";"):
                    continue
                if cur is not None:
                    cur["raw"].append((no, raw.strip()))
                continue
            m = re.match(r"(\d{4}-\d\d-\d\d)(?: |$)", raw)
            if m:
                cur = {"line": no, "date": m.group(1), "raw": []}
                txns.append(cur)
        postings = []
        for t in txns:
            ps, missing, tot = [], 0, 0
            for no, content in t["raw"]:
                m = re.search(r"\t+| {2,}", content)
                if m:
                    acct, rest = content[:m.start()], content[m.end():]
                else:
                    acct, rest = content, ""
                rest = rest.split(";")[0].strip()
                if acct.startswith(";"):
                    continue
                if not rest:
                    missing += 1
                    ps.append([acct, None])
                    continue
                am = LedgerBalance.AMT.fullmatch(rest)
                if not am or (am.group(1) and am.group(2)):
                    raise ValueError(f"line {t['line']}: bad amount")
                c = int(am.group(3).replace(",", "")) * 100 + int((am.group(4) or "0").ljust(2, "0"))
                c = -c if (am.group(1) or am.group(2)) else c
                tot += c
                ps.append([acct, c])
            if missing > 1:
                raise ValueError(f"line {t['line']}: more than one posting without an amount")
            for p in ps:
                if p[1] is None:
                    p[1] = -tot
                    tot = 0
            if tot != 0:
                raise ValueError(f"line {t['line']}: unbalanced")
            if until is None or t["date"] <= until:
                postings.extend(ps)
        totals = {}
        for acct, c in postings:
            parts = acct.split(":")
            for i in range(1, len(parts) + 1):
                k = ":".join(parts[:i])
                totals[k] = totals.get(k, 0) + c
        return "".join(f"{LedgerBalance.fmt(c):>12}  {k}\n" for k, c in sorted(totals.items()) if c != 0)

    CASES = [
        ("""; sample
2024-01-05 Groceries
    Expenses:Food    $12.50
    Assets:Cash

2024-01-06 Paycheck
  Assets:Bank:Checking    $2,500.00  ; march
  Income:Salary           $-2,500.00
# comment
2024-01-07 Rent
\tExpenses:Housing:Rent\t$1,000
\tAssets:Bank:Checking
2024-02-01 Transfer to savings
    Assets:Bank:Savings Account    $500
    Assets:Bank:Checking           -$500
""", None),
        ("2024-01-01 a\n  A:b  $0.10\n  A:c  $0.20\n  B  -$0.30\n2024-01-02 b\n  A:b  -$0.10\n  Z\n", None),
        ("2024-01-01 open\n  Assets:Cash  $100\n  Equity  -$100\n2024-03-01 later\n  Assets:Cash  $50\n  Income  -$50\n", "2024-02-01"),
        ("2024-01-01 x\n  A  $1,000,000.01\n  B\n", None),
        ("2024-01-01 round trip\n  A  $5\n  B  -$5\n2024-01-02 undo\n  A  -$5\n  B  $5\n", None),
        ("2024-01-01 x\n  A  $1\n  B  $-1\n  C  $0.5\n  D  -$0.50\n", None),
        ("2024-01-01 odd spacing\n  Assets:My Wallet  $3.5\n  Equity:Opening Balances\n", None),
        ("", None),
        # errors
        ("2024-01-01 x\n  A  $1\n  B  -$2\n", None),
        ("2024-01-01 x\n  A  $1\n  B\n  C\n", None),
        ("2024-01-01 x\n  A  $1.234\n  B  -$1.234\n", None),
        ("2024-01-01 ok\n  A  $1\n  B  -$1\n2024-01-02 bad\n  A  $1\n  B  -$2\n", "2024-01-01"),
        ("2024-01-01 x\n  A  1.00\n  B  -1.00\n", None),
    ]

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "journal.txt", LedgerBalance.CASES[0][0])

    @staticmethod
    def grade(d: Path):
        if not (d / "ledger.py").exists():
            return False, "no ledger.py"
        tmp, w = scratch_copy(d)
        try:
            for i, (text, until) in enumerate(LedgerBalance.CASES):
                (w / "j.txt").write_text(text, encoding="utf-8")
                args = ["python3", "ledger.py", "j.txt"] + (["--until", until] if until else [])
                r = runb(args, cwd=w)
                try:
                    want = LedgerBalance.oracle(text, until)
                except ValueError as e:
                    if r.returncode != 1 or r.stdout.strip():
                        return False, f"case {i}: want error ({e}), got exit {r.returncode}, stdout {r.stdout[:60]!r}"
                    if not re.search(rb"line \d+", r.stderr):
                        return False, f"case {i}: stderr should say `line N: ...`, got {r.stderr[:80]!r}"
                    continue
                if r.returncode != 0 or r.stdout.decode() != want:
                    return False, f"case {i}: exit {r.returncode}, got {r.stdout.decode()[:120]!r} want {want[:120]!r}"
            r = runb(["python3", "ledger.py", "j.txt", "--until", "2024-02-01"], cwd=w)
            (w / "j.txt").write_text(LedgerBalance.CASES[8][0])
            r = runb(["python3", "ledger.py", "j.txt"], cwd=w)
            if r.returncode != 1 or not re.search(rb"line 1\b", r.stderr):
                return False, f"error message should name line 1, got {r.stderr[:80]!r}"
            return True, f"{len(LedgerBalance.CASES)} journals"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ================================================================ 22. async-pool-node
POOL_TESTS = r'''
"use strict";
const assert = require("assert");
let mapLimit;
try { ({ mapLimit } = require("./pool.js")); } catch (e) { console.log("cannot load pool.js: " + e.message); process.exit(); }
if (typeof mapLimit !== "function") { console.log("pool.js must export mapLimit"); process.exit(); }
let unhandled = 0;
process.on("unhandledRejection", () => { unhandled++; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("results keep input order and index is passed", async () => {
  const items = [...Array(20).keys()];
  const res = await mapLimit(items, 3, async (x, i) => { await sleep((x * 7) % 11); return x * 2 + i; });
  assert.deepStrictEqual(res, items.map((x, i) => x * 2 + i));
});
test("never more than `limit` in flight, and uses all of them", async () => {
  let running = 0, max = 0;
  await mapLimit([...Array(15).keys()], 4, async (x) => { running++; max = Math.max(max, running); await sleep(5 + (x % 3)); running--; });
  assert.strictEqual(max, 4);
});
test("limit larger than the item count", async () => {
  let running = 0, max = 0;
  const res = await mapLimit([1, 2, 3], 10, async (x) => { running++; max = Math.max(max, running); await sleep(5); running--; return x; });
  assert.deepStrictEqual(res, [1, 2, 3]); assert.strictEqual(max, 3);
});
test("empty input", async () => { assert.deepStrictEqual(await mapLimit([], 2, async () => 1), []); });
test("plain (non-promise) return values and falsy results", async () => {
  assert.deepStrictEqual(await mapLimit([1, 2, 3], 2, (x) => (x === 2 ? 0 : x)), [1, 0, 3]);
  assert.deepStrictEqual(await mapLimit([1, 2], 1, (x) => (x === 1 ? undefined : null)), [undefined, null]);
});
test("a free slot is refilled at once (no batches)", async () => {
  const start = [];
  const t0 = Date.now();
  await mapLimit([80, 10, 10, 10], 2, async (ms, i) => { start[i] = Date.now() - t0; await sleep(ms); });
  assert.ok(start[2] < 50, "item 2 started at " + start[2] + "ms, should be ~10ms");
  assert.ok(start[3] < 60, "item 3 started at " + start[3] + "ms, should be ~20ms");
});
test("limit 1 runs strictly one after another, in order", async () => {
  const order = [];
  await mapLimit([3, 1, 2], 1, async (x) => { order.push("s" + x); await sleep(x); order.push("e" + x); });
  assert.deepStrictEqual(order, ["s3", "e3", "s1", "e1", "s2", "e2"]);
});
test("first rejection rejects the result; nothing new is started afterwards", async () => {
  const started = [];
  const p = mapLimit([0, 1, 2, 3, 4, 5], 2, async (i) => { started.push(i); if (i === 0) { await sleep(5); throw new Error("boom0"); } await sleep(30); return i; });
  await assert.rejects(p, /boom0/);
  await sleep(100);
  assert.deepStrictEqual(started, [0, 1]);
});
test("a synchronous throw becomes a rejection, not an exception", async () => {
  let p;
  try { p = mapLimit([0, 1, 2], 2, (i) => { if (i === 1) throw new TypeError("sync"); return sleep(5); }); }
  catch (e) { assert.fail("mapLimit threw synchronously: " + e.message); }
  await assert.rejects(p, TypeError);
});
test("later failures after the first do not become unhandled rejections", async () => {
  const before = unhandled;
  const p = mapLimit([0, 1, 2], 3, async (i) => { await sleep(5 + i * 10); throw new Error("e" + i); });
  await assert.rejects(p, /e0/);
  await sleep(80);
  assert.strictEqual(unhandled, before, "unhandled rejections leaked");
});
test("invalid limits reject with RangeError and run nothing", async () => {
  for (const bad of [0, -1, 1.5, NaN, "2", Infinity, undefined, null]) {
    let called = 0, p;
    try { p = mapLimit([1, 2], bad, async () => { called++; }); } catch (e) { assert.fail("threw synchronously for " + String(bad)); }
    await assert.rejects(p, (e) => e instanceof RangeError, "limit " + String(bad));
    assert.strictEqual(called, 0);
  }
});
test("many items, many rounds", async () => {
  const items = [...Array(500).keys()];
  const res = await mapLimit(items, 7, async (x) => { if (x % 50 === 0) await sleep(1); return x * x; });
  assert.deepStrictEqual(res, items.map((x) => x * x));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); } catch (e) { console.log(name + ": " + String(e.message || e).split("\n")[0].slice(0, 160)); process.exit(); }
  }
  await sleep(20);
  if (unhandled) { console.log("unhandled rejections: " + unhandled); process.exit(); }
  console.log("OK");
})();
'''


class AsyncPoolNode:
    name = "async-pool-node"
    PROMPT = (
        "Write pool.js (Node 22, CommonJS, no packages) exporting `mapLimit(items, limit, fn)`. It returns a "
        "promise for the array of results in input order, calling fn(item, index) (which may return a value or a "
        "promise) so that at most `limit` calls are in flight at any moment: calls start in input order, and a "
        "new one starts as soon as a running one settles (not in batches). If any call rejects or throws "
        "synchronously, the returned promise rejects with that first error, no further items are started, and "
        "calls already running are left to finish with their outcome ignored -- a later failure must not surface "
        "as an unhandled rejection. An empty array resolves to []. A limit that is not an integer >= 1 makes the "
        "returned promise reject with a RangeError without calling fn; mapLimit itself never throws "
        "synchronously."
    )

    @staticmethod
    def setup(d: Path) -> None:
        write(d, "example.js", "const { mapLimit } = require('./pool.js');\nmapLimit([1, 2, 3], 2, async (x) => x * 2).then(console.log);\n")

    @staticmethod
    def grade(d: Path):
        if not (d / "pool.js").exists():
            return False, "no pool.js"
        tmp, w = scratch_copy(d)
        try:
            (w / "pool_test_hidden.js").write_text(POOL_TESTS.replace('require("./pool.js")', 'require("./pool.js")'))
            try:
                r = runb(["node", "pool_test_hidden.js"], cwd=w, timeout=60)
            except subprocess.TimeoutExpired:
                return False, "tests hung"
            out = (r.stdout.decode().strip().splitlines() or [""])[-1]
            if out == "OK" and r.returncode == 0:
                return True, "all pool tests"
            return False, (out or r.stderr.decode()[-200:] or f"exit {r.returncode}")[:240]
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


TASKS3 = [DedupeContacts, MoneySplit, FixDailyBuckets, SemverSort, JsonDiff, RefactorInvoice, SqlGaps, GitSplitHistory,
          GitFindCulprit, BackupScript, MakeIncremental, CsvToJsonNode, IniToJson, PerfAsofJoin, SlugifyBatch, TextWrap,
          SqliteMigrate, VendorUnits, RenameApi, SessionizeLogs, LedgerBalance, AsyncPoolNode]
