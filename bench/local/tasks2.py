"""
Fifteen more local tasks in the style of Terminal-Bench, same shape as tasks.py:

    setup(dir)  -> builds the starting state in dir
    PROMPT      -> what the agent is told
    grade(dir)  -> (passed: bool, why: str), run after the agent finishes

Graders never depend on network access; anything that mutates state runs on a
scratch copy of dir so a grader can be run twice with the same verdict.
"""

from __future__ import annotations

import csv
import datetime as dt
import json
import os
import random
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from decimal import Decimal
from pathlib import Path

# agent bookkeeping that may appear in the task folder and is never judged
IGNORED = {".molt", ".maat", ".factory", ".droid", "__pycache__", ".DS_Store"}


def sh(cmd: str, cwd: Path) -> str:
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True).stdout


def run(args, cwd=None, inp=None, timeout=30):
    return subprocess.run(args, cwd=cwd, input=inp, capture_output=True, text=True, timeout=timeout)


def scratch_copy(d: Path):
    tmp = Path(tempfile.mkdtemp(prefix="grade2-"))
    w = tmp / "w"
    shutil.copytree(d, w, symlinks=True)
    return tmp, w


def all_files(root: Path) -> set[str]:
    out = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [x for x in dirnames if x not in IGNORED]
        for f in filenames:
            if f in IGNORED:
                continue
            out.add(os.path.relpath(os.path.join(dirpath, f), root).replace(os.sep, "/"))
    return out


def py_check(d: Path, code: str, timeout=60):
    """Run grader code in a fresh interpreter inside d; it prints OK or a reason."""
    try:
        r = run(["python3", "-c", code], cwd=d, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout}s"
    out = (r.stdout.strip().splitlines() or [""])[-1]
    if out == "OK":
        return True, "all checks"
    return False, (out or r.stderr.strip()[-200:] or "no output")[:240]


# ---------------------------------------------------------------- 1. HTTP JSON server
class HttpServer:
    name = "http-json-server"
    PROMPT = (
        "Write server.py, a Python HTTP server using only the standard library: `python3 server.py PORT` "
        "listens on 127.0.0.1:PORT and serves the items stored in items.json (a JSON list of {\"id\", \"name\"} objects). "
        "GET /items returns the list sorted by id; GET /items/<id> returns that one item, or status 404 with body "
        "{\"error\": \"not found\"}. POST /items with a JSON body {\"name\": \"...\"} creates {\"id\": highest existing id + 1, "
        "\"name\": ...}, saves it to items.json and returns it with status 201; a body that is not valid JSON or lacks a "
        "string name returns status 400 with {\"error\": \"bad request\"} and changes nothing."
    )

    ITEMS = [{"id": 3, "name": "gamma"}, {"id": 1, "name": "alpha"}, {"id": 2, "name": "beta"}]

    @staticmethod
    def setup(d: Path) -> None:
        (d / "items.json").write_text(json.dumps(HttpServer.ITEMS, indent=2) + "\n")

    @staticmethod
    def grade(d: Path):
        if not (d / "server.py").exists():
            return False, "no server.py"
        tmp, w = scratch_copy(d)
        (w / "items.json").write_text(json.dumps(HttpServer.ITEMS, indent=2) + "\n")
        s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
        proc = subprocess.Popen(["python3", "server.py", str(port)], cwd=w, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def req(method, path, body=None):
            data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
            r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                       headers={"Content-Type": "application/json"} if data is not None else {})
            try:
                with opener.open(r, timeout=5) as resp:
                    status, raw = resp.status, resp.read()
            except urllib.error.HTTPError as e:
                status, raw = e.code, e.read()
            try:
                return status, json.loads(raw.decode() or "null")
            except ValueError:
                return status, raw.decode(errors="replace")[:60]

        try:
            deadline = time.time() + 10
            while True:
                if proc.poll() is not None:
                    return False, "server exited on startup"
                try:
                    socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
                    break
                except OSError:
                    if time.time() > deadline:
                        return False, "server never started listening"
                    time.sleep(0.1)
            want = sorted(HttpServer.ITEMS, key=lambda x: x["id"])
            got = req("GET", "/items")
            if got != (200, want):
                return False, f"GET /items -> {got}"
            got = req("GET", "/items/2")
            if got != (200, {"id": 2, "name": "beta"}):
                return False, f"GET /items/2 -> {got}"
            got = req("GET", "/items/99")
            if got != (404, {"error": "not found"}):
                return False, f"GET /items/99 -> {got}"
            for bad in ({}, {"name": 5}, b"not json"):
                got = req("POST", "/items", bad)
                if got != (400, {"error": "bad request"}):
                    return False, f"POST {bad!r} -> {got}"
            got = req("POST", "/items", {"name": "delta"})
            if got != (201, {"id": 4, "name": "delta"}):
                return False, f"POST delta -> {got}"
            want.append({"id": 4, "name": "delta"})
            got = req("GET", "/items")
            if got != (200, want):
                return False, f"GET /items after POST -> {got}"
            try:
                saved = sorted(json.loads((w / "items.json").read_text()), key=lambda x: x["id"])
            except Exception as e:
                return False, f"items.json unreadable after POST: {e}"
            if saved != want:
                return False, f"items.json after POST: {saved}"
            return True, "all endpoints"
        except Exception as e:
            return False, f"request failed: {type(e).__name__}: {e}"
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            proc.wait()
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- 2. SQL against sqlite
class SqlTop:
    name = "sql-top-customers"
    PROMPT = (
        "shop.db is a SQLite database of customers, orders and order_items. Write top_customers.csv with the header "
        "name,total and one row for each of the 5 customers who spent the most on orders with status 'paid' placed in "
        "2024, where an order's spend is the sum of qty * unit_price over its items. Order rows by total descending, "
        "ties by name ascending, and write total with exactly two decimals (e.g. 1234.50)."
    )

    NAMES = ["Ada", "Ben", "Cleo", "Dmitri", "Esi", "Farah", "Gus", "Hana", "Ines", "Jonas", "Kofi", "Lena"]

    @staticmethod
    def setup(d: Path) -> None:
        rnd = random.Random(11)
        db = sqlite3.connect(d / "shop.db")
        db.executescript(
            "CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, country TEXT);"
            "CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER, order_date TEXT, status TEXT);"
            "CREATE TABLE order_items(id INTEGER PRIMARY KEY, order_id INTEGER, product TEXT, qty INTEGER, unit_price REAL);"
        )
        for i, n in enumerate(SqlTop.NAMES, 1):
            db.execute("INSERT INTO customers VALUES(?,?,?)", (i, n, rnd.choice(["US", "DE", "GH", "JP"])))
        start = dt.date(2023, 11, 1)
        for oid in range(1, 181):
            day = start + dt.timedelta(days=rnd.randint(0, 485))
            status = rnd.choice(["paid", "paid", "paid", "pending", "refunded"])
            db.execute("INSERT INTO orders VALUES(?,?,?,?)", (oid, rnd.randint(1, 12), day.isoformat(), status))
            for _ in range(rnd.randint(1, 4)):
                db.execute("INSERT INTO order_items(order_id,product,qty,unit_price) VALUES(?,?,?,?)",
                           (oid, rnd.choice(["bolt", "nut", "gear", "belt", "cell"]), rnd.randint(1, 5), rnd.randint(4, 200) * 0.25))
        db.commit(); db.close()

    @staticmethod
    def grade(d: Path):
        p = d / "top_customers.csv"
        if not p.exists():
            return False, "no top_customers.csv"
        tmp, w = scratch_copy(d)
        try:
            db = sqlite3.connect(w / "shop.db")
            rows = db.execute(
                "SELECT c.name, oi.qty, oi.unit_price FROM orders o JOIN customers c ON c.id=o.customer_id "
                "JOIN order_items oi ON oi.order_id=o.id WHERE o.status='paid' AND o.order_date BETWEEN '2024-01-01' AND '2024-12-31'"
            ).fetchall()
            db.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        quarters = {}
        for name, qty, price in rows:
            quarters[name] = quarters.get(name, 0) + qty * round(price * 4)
        ranked = sorted(quarters.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        want = [["name", "total"]] + [[n, f"{Decimal(q) / 4:.2f}"] for n, q in ranked]
        got = [r for r in csv.reader(p.read_text().splitlines()) if r]
        if got == want:
            return True, "matches"
        diff = next(((a, b) for a, b in zip(got, want) if a != b), (len(got), len(want)))
        return False, f"first difference (got, want): {diff}"


# ---------------------------------------------------------------- 3. CSV cleaning
class CsvClean:
    name = "csv-clean"
    PROMPT = (
        "people.csv (header id,name,email,age,city) is messy. Write clean.csv with the same header and the surviving rows "
        "in their original order: trim whitespace around every field and lowercase the email; drop blank lines and rows "
        "that don't have exactly 5 fields, rows whose email isn't local@domain (exactly one @, non-empty local part, and "
        "a domain containing a dot that is neither its first nor last character), and rows whose age isn't a whole number "
        "written in digits from 0 to 120. Then, among the remaining rows, drop any row whose email already appeared in an "
        "earlier remaining row; write plain comma-separated values."
    )

    TEXT = (
        "id,name,email,age,city\n"
        "1, Alice , ALICE@Example.com , 34, Paris\n"
        "2,Bob,bob@example.com,abc,Berlin\n"
        "3,Carol,carol@example,29,Rome\n"
        "4,Dave,dave@example.org,121,Oslo\n"
        "5,Eve,eve@@example.com,40,Lima\n"
        "6,Frank,alice@example.com,50,Kyiv\n"
        "7,Grace,grace@example.net,0,Quito\n"
        "8,Heidi,heidi@example.net,-3,Cairo\n"
        "9,Ivan,ivan@example.co.uk,120,Delhi\n"
        "\n"
        "10,Judy,judy@example.com,25\n"
        "11,Mallory,mallory@example.com,31,Nice,extra\n"
        "12,Niaj, NIAJ@example.com ,44,Accra\n"
        "13,Olivia,niaj@example.com,22,Doha\n"
        "14,Peggy,@example.com,30,Lyon\n"
        "15,Rupert,rupert@.com,30,Bern\n"
        "16,Sybil,sybil@example.,30,Rome\n"
        "17,Trent,trent@example.com,4.5,Riga\n"
        "18,Uma,uma@example.com,,Baku\n"
        "19,Wendy,bob@example.com,27,Minsk\n"
        "20, Xavier ,xavier@example.com, 65 ,Lagos\n"
        "   \n"
        "21,Yara,YARA@EXAMPLE.IO,19,Porto\n"
    )

    @staticmethod
    def setup(d: Path) -> None:
        (d / "people.csv").write_text(CsvClean.TEXT)

    @staticmethod
    def expected():
        lines = CsvClean.TEXT.splitlines()
        out = [lines[0].split(",")]
        seen = set()
        for ln in lines[1:]:
            if not ln.strip():
                continue
            f = [x.strip() for x in ln.split(",")]
            if len(f) != 5:
                continue
            f[2] = f[2].lower()
            parts = f[2].split("@")
            if len(parts) != 2 or not parts[0]:
                continue
            dom = parts[1]
            if "." not in dom[1:-1]:
                continue
            if not (f[3].isdigit() and 0 <= int(f[3]) <= 120):
                continue
            if f[2] in seen:
                continue
            seen.add(f[2])
            out.append(f)
        return out

    @staticmethod
    def grade(d: Path):
        p = d / "clean.csv"
        if not p.exists():
            return False, "no clean.csv"
        got = [r for r in csv.reader(p.read_text().splitlines()) if r]
        want = CsvClean.expected()
        if got == want:
            return True, "matches"
        diff = next(((a, b) for a, b in zip(got, want) if a != b), (len(got), len(want)))
        return False, f"first difference (got, want): {diff}"


# ---------------------------------------------------------------- 4. refactor with behaviour lock
class RefactorPricing:
    name = "refactor-pricing"
    PROMPT = (
        "Refactor pricing.py so that the coupon rules live in a module-level dict COUPONS mapping each existing coupon "
        "code to a function f(base, qty, subtotal) that returns the discounted subtotal, and price() looks the coupon up "
        "in COUPONS instead of using a per-coupon if/elif chain (so adding an entry to COUPONS adds a coupon). price() "
        "must return exactly what it returns now for every item, quantity and coupon, including raising ValueError for "
        "an unknown coupon and KeyError for an unknown item. Also add best_coupon(item, qty), returning the code in "
        "COUPONS that gives the lowest price, or None if no coupon is strictly cheaper than no coupon; ties go to the "
        "alphabetically first code."
    )

    ORIGINAL = (
        'BASE = {"widget": 2.5, "gadget": 10.0, "doohickey": 7.25}\n\n\n'
        'def price(item, qty, coupon=None):\n'
        '    base = BASE[item]\n'
        '    subtotal = base * qty\n'
        '    if coupon == "SAVE10":\n'
        '        subtotal = subtotal - subtotal * 0.10\n'
        '    elif coupon == "BULK":\n'
        '        if qty >= 10:\n'
        '            subtotal = subtotal - 5\n'
        '    elif coupon == "FIVEOFF":\n'
        '        if subtotal >= 20:\n'
        '            subtotal = subtotal - 5\n'
        '    elif coupon == "BOGO":\n'
        '        subtotal = base * (qty - qty // 2)\n'
        '    elif coupon is not None:\n'
        '        raise ValueError("unknown coupon")\n'
        '    return round(subtotal, 2)\n'
    )

    @staticmethod
    def setup(d: Path) -> None:
        (d / "pricing.py").write_text(RefactorPricing.ORIGINAL)

    @staticmethod
    def grade(d: Path):
        if not (d / "pricing.py").exists():
            return False, "no pricing.py"
        code = (
            "import sys, inspect\nsys.path.insert(0, '.')\n"
            "ref = {}\nexec(" + repr(RefactorPricing.ORIGINAL) + ", ref)\n"
            "try:\n    import pricing as m\nexcept Exception as e:\n    print('import failed:', repr(e)); sys.exit()\n"
            "CODES = ['BOGO', 'BULK', 'FIVEOFF', 'SAVE10']\n"
            "def call(f, *a):\n    try:\n        return ('ok', f(*a))\n    except Exception as e:\n        return ('err', type(e).__name__)\n"
            "C = getattr(m, 'COUPONS', None)\n"
            "if not isinstance(C, dict) or sorted(C) != CODES or not all(callable(v) for v in C.values()):\n"
            "    print('COUPONS must be a dict of the 4 codes to functions'); sys.exit()\n"
            "for it in ['widget', 'gadget', 'doohickey', 'thing']:\n"
            "    for q in range(0, 26):\n"
            "        for c in [None, 'NOPE'] + CODES:\n"
            "            a, b = call(m.price, it, q, c), call(ref['price'], it, q, c)\n"
            "            if a != b:\n                print(f'price({it!r},{q},{c!r}) = {a} but was {b}'); sys.exit()\n"
            "if call(m.price, 'widget', 3) != call(ref['price'], 'widget', 3):\n    print('default coupon changed'); sys.exit()\n"
            "if C['BULK'](2.5, 10, 25.0) != 20.0 or C['BOGO'](2.5, 3, 7.5) != 5.0:\n"
            "    print('COUPONS functions do not follow f(base, qty, subtotal)'); sys.exit()\n"
            "src = inspect.getsource(m.price)\n"
            "if any(c in src for c in CODES):\n    print('price() still names coupon codes'); sys.exit()\n"
            "saved = dict(C)\n"
            "C['SAVE10'] = lambda b, q, s: 1.0\nC['ZZZ'] = lambda b, q, s: s - 1\n"
            "r1, r2 = call(m.price, 'gadget', 3, 'SAVE10'), call(m.price, 'gadget', 1, 'ZZZ')\n"
            "C.clear(); C.update(saved)\n"
            "if r1 != ('ok', 1.0) or r2 != ('ok', 9.0):\n    print(f'price() does not use COUPONS: {r1} {r2}'); sys.exit()\n"
            "if not callable(getattr(m, 'best_coupon', None)):\n    print('no best_coupon'); sys.exit()\n"
            "def best(it, q):\n"
            "    none = ref['price'](it, q)\n"
            "    p, c = min((ref['price'](it, q, c), c) for c in CODES)\n"
            "    return c if p < none else None\n"
            "for it in ['widget', 'gadget', 'doohickey']:\n"
            "    for q in range(0, 26):\n"
            "        a, b = call(m.best_coupon, it, q), ('ok', best(it, q))\n"
            "        if a != b:\n            print(f'best_coupon({it!r},{q}) = {a}, want {b}'); sys.exit()\n"
            "print('OK')\n"
        )
        return py_check(d, code)


# ---------------------------------------------------------------- 5. bash script with args + exit codes
class RotateLogs:
    name = "bash-rotate"
    PROMPT = (
        "Write an executable bash script rotate.sh used as `./rotate.sh [-n N] DIR`: it keeps the N newest (by "
        "modification time) regular files named *.log directly inside DIR, default N=5, deletes the other *.log files "
        "there, and prints the name (basename only) of each deleted file on its own line, oldest first; names may "
        "contain spaces and other files are never touched. It exits 0 on success. If DIR is missing or not a "
        "directory, or N is not a positive integer, it prints a usage message to stderr, prints nothing to stdout, "
        "deletes nothing and exits 2."
    )

    @staticmethod
    def setup(d: Path) -> None:
        pass

    @staticmethod
    def _make(root: Path, n: int, extra=True):
        root.mkdir(parents=True)
        base = time.time() - 100000
        names = [f"app {i}.log" for i in range(n)]
        # mtimes are deliberately not in name order
        order = list(range(n)); random.Random(n).shuffle(order)
        for rank, i in enumerate(order):
            f = root / names[i]; f.write_text(f"log {i}\n"); os.utime(f, (base + rank * 60, base + rank * 60))
        if extra:
            (root / "notes.txt").write_text("keep\n"); os.utime(root / "notes.txt", (base - 999, base - 999))
            (root / "keep.log").mkdir()
            (root / "sub").mkdir(); (root / "sub" / "old.log").write_text("x\n"); os.utime(root / "sub" / "old.log", (base - 999, base - 999))
        return [names[i] for i in order]  # oldest first

    @staticmethod
    def grade(d: Path):
        s = d / "rotate.sh"
        if not s.exists():
            return False, "no rotate.sh"
        if not os.access(s, os.X_OK):
            return False, "rotate.sh is not executable"
        tmp = Path(tempfile.mkdtemp(prefix="grade2-rot-"))
        try:
            def go(*args):
                try:
                    return run([str(s), *args], cwd=tmp, timeout=20)
                except subprocess.TimeoutExpired:
                    return None
            for label, n, args, keep in (("default", 8, [], 5), ("-n 2", 4, ["-n", "2"], 2), ("-n 10", 3, ["-n", "10"], 10)):
                root = tmp / label.replace(" ", "")
                oldest_first = RotateLogs._make(root, n)
                r = go(*args, str(root))
                if r is None or r.returncode != 0:
                    return False, f"{label}: exit {None if r is None else r.returncode}: {(r.stderr if r else '')[-100:]}"
                gone = oldest_first[:max(0, n - keep)]
                if r.stdout.splitlines() != gone:
                    return False, f"{label}: printed {r.stdout.splitlines()} want {gone}"
                left = sorted(x.name for x in root.iterdir())
                want_left = sorted(set(oldest_first[len(gone):]) | {"notes.txt", "keep.log", "sub"})
                if left != want_left or not (root / "sub" / "old.log").exists():
                    return False, f"{label}: left {left} want {want_left}"
            guard = tmp / "guard"
            RotateLogs._make(guard, 7, extra=False)
            (tmp / "afile").write_text("x\n")
            for args in ([], [str(tmp / "nope")], [str(tmp / "afile")], ["-n", "0", str(guard)], ["-n", "abc", str(guard)],
                         ["-n", "-3", str(guard)], ["-n", "2.5", str(guard)]):
                r = go(*args)
                if r is None or r.returncode != 2 or r.stdout.strip() or not r.stderr.strip():
                    return False, f"args {args}: want exit 2, usage on stderr, empty stdout; got exit {None if r is None else r.returncode}"
                if len(list(guard.iterdir())) != 7:
                    return False, f"args {args}: deleted files on a usage error"
            return True, "all cases"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- 6. JSON config migration
class ConfigMigrate:
    name = "config-migrate"
    PROMPT = (
        "Migrate every configs/*.json file whose \"version\" is 1 to the version 2 schema, rewriting it in place; files "
        "already at version 2 and non-JSON files must stay byte-for-byte unchanged. A v2 file has exactly these keys: "
        "\"version\": 2, \"database\": {\"host\": db_host, \"port\": db_port as an integer, 5432 if missing}, \"debug\": a "
        "boolean that is true only if v1 debug is JSON true or a string equal to yes, true or 1 ignoring case, "
        "\"features\": v1's comma-separated features string as a list of trimmed, non-empty names in original order with "
        "repeats removed, \"users\": the list of user names in order, and \"admins\": the names of users whose admin is 1 "
        "or true, in order."
    )

    V1 = {
        "web.json": {"version": 1, "db_host": "db.local", "db_port": "5433", "debug": "Yes",
                     "features": "auth, cache,,search ,auth",
                     "users": [{"name": "ann", "admin": 1}, {"name": "bo", "admin": 0}, {"name": "cy", "admin": True}]},
        "worker.json": {"version": 1, "db_host": "10.0.0.5", "debug": False, "features": "", "users": []},
        "api.json": {"version": 1, "db_host": "api-db", "db_port": 6000, "debug": "TRUE", "features": "metrics",
                     "users": [{"name": "dee", "admin": 0}]},
        "batch.json": {"version": 1, "db_host": "b", "db_port": "7000", "debug": "no", "features": " a ,b, a",
                       "users": [{"name": "eli", "admin": 1}]},
    }
    V2_TEXT = '{\n    "version": 2,\n    "database": {"host": "old", "port": 5432},\n    "debug": false,\n    "features": ["x"],\n    "users": [],\n    "admins": []\n}\n'
    README = "Config files live here.\nversion: 1\n"

    @staticmethod
    def setup(d: Path) -> None:
        c = d / "configs"; c.mkdir()
        for k, v in ConfigMigrate.V1.items():
            (c / k).write_text(json.dumps(v, indent=2) + "\n")
        (c / "legacy.json").write_text(ConfigMigrate.V2_TEXT)
        (c / "README.txt").write_text(ConfigMigrate.README)

    @staticmethod
    def migrate(v):
        feats = []
        for f in v.get("features", "").split(","):
            f = f.strip()
            if f and f not in feats:
                feats.append(f)
        dbg = v.get("debug")
        return {
            "version": 2,
            "database": {"host": v["db_host"], "port": int(v.get("db_port", 5432))},
            "debug": dbg is True or (isinstance(dbg, str) and dbg.lower() in ("yes", "true", "1")),
            "features": feats,
            "users": [u["name"] for u in v.get("users", [])],
            "admins": [u["name"] for u in v.get("users", []) if u.get("admin") in (1, True)],
        }

    @staticmethod
    def grade(d: Path):
        c = d / "configs"
        names = sorted(x.name for x in c.iterdir()) if c.is_dir() else []
        want_names = sorted(list(ConfigMigrate.V1) + ["legacy.json", "README.txt"])
        if names != want_names:
            return False, f"configs/ holds {names}"
        if (c / "legacy.json").read_text() != ConfigMigrate.V2_TEXT:
            return False, "legacy.json (already v2) was changed"
        if (c / "README.txt").read_text() != ConfigMigrate.README:
            return False, "README.txt was changed"
        for k, v in ConfigMigrate.V1.items():
            try:
                got = json.loads((c / k).read_text())
            except ValueError as e:
                return False, f"{k} is not valid JSON: {e}"
            want = ConfigMigrate.migrate(v)
            if got != want or type(got.get("debug")) is not bool or type(got["database"].get("port")) is not int:
                return False, f"{k}: got {json.dumps(got)[:160]} want {json.dumps(want)[:160]}"
        return True, "all files"


# ---------------------------------------------------------------- 7. performance fix
class PerfPairs:
    name = "perf-pairs"
    PROMPT = (
        "find_pairs in pairs.py is far too slow on big inputs. Make it return exactly the same value as now (same "
        "signature, same sorted list of tuples, same behaviour with duplicates) but fast enough to handle a list of "
        "200,000 integers in under 5 seconds."
    )

    SLOW = (
        "def find_pairs(nums, target):\n"
        '    """Return the sorted list of distinct pairs (a, b) with a <= b such that a and b are the\n'
        '    values at two different positions of nums and a + b == target."""\n'
        "    result = []\n"
        "    for i in range(len(nums)):\n"
        "        for j in range(i + 1, len(nums)):\n"
        "            if nums[i] + nums[j] == target:\n"
        "                p = (min(nums[i], nums[j]), max(nums[i], nums[j]))\n"
        "                if p not in result:\n"
        "                    result.append(p)\n"
        "    return sorted(result)\n"
    )

    @staticmethod
    def setup(d: Path) -> None:
        (d / "pairs.py").write_text(PerfPairs.SLOW)

    @staticmethod
    def grade(d: Path):
        if not (d / "pairs.py").exists():
            return False, "no pairs.py"
        code = (
            "import sys, time, random\nsys.path.insert(0, '.')\n"
            "ref = {}\nexec(" + repr(PerfPairs.SLOW) + ", ref)\n"
            "def fast(nums, t):\n"
            "    from collections import Counter\n    c = Counter(nums); out = set()\n"
            "    for a in c:\n        b = t - a\n"
            "        if a <= b and b in c and (a != b or c[a] > 1):\n            out.add((a, b))\n"
            "    return sorted(out)\n"
            "from pairs import find_pairs\n"
            "small = [([], 5), ([5], 10), ([5, 5], 10), ([1, 2, 3, 4, 5], 6), ([3, 3, 3], 6), ([-2, 7, 4, 1, 1, 4, 9, -2], 5),\n"
            "         ([0, 0, 0, 1, -1], 0), ([10, -10, 20, -20, 0], 0), ([2, 4, 6], 100)]\n"
            "rnd = random.Random(3)\n"
            "for _ in range(40):\n    small.append(([rnd.randint(-8, 8) for _ in range(rnd.randint(0, 15))], rnd.randint(-10, 10)))\n"
            "for nums, t in small:\n"
            "    got, want = find_pairs(list(nums), t), ref['find_pairs'](nums, t)\n"
            "    if got != want or type(got) is not list or any(type(p) is not tuple for p in got):\n"
            "        print(f'find_pairs({nums}, {t}) = {got!r}, want {want!r}'); sys.exit()\n"
            "rnd = random.Random(5)\nbig = [rnd.randint(-10**6, 10**6) for _ in range(200000)]\n"
            "want = fast(big, 1234)\n"
            "t0 = time.time(); got = find_pairs(list(big), 1234); el = time.time() - t0\n"
            "if got != want:\n    print(f'wrong answer on the big input ({len(got)} pairs, want {len(want)})'); sys.exit()\n"
            "if el > 5:\n    print(f'big input took {el:.1f}s'); sys.exit()\n"
            "print('OK')\n"
        )
        return py_check(d, code, timeout=20)


# ---------------------------------------------------------------- 8. git: revert one bad commit
class GitRevert:
    name = "git-revert-one"
    PROMPT = (
        "In this git repo, the commit 'Add experimental cache' on master broke things. Undo exactly that commit's "
        "changes by adding one new commit on top of master, without rewriting history (all existing commits must stay "
        "on master unchanged) and keeping every change made by the other commits. Leave master checked out with a clean "
        "working tree."
    )

    MSGS = ["Initial commit", "Add logging", "Add experimental cache", "Raise timeout", "Document usage"]
    APP = "def main():\n    return 'ok'\n"
    INI = "[app]\ntimeout = 30\nretries = 3\nname = demo\nmode = prod\n"

    @staticmethod
    def setup(d: Path) -> None:
        sh("git init -q -b master && git config user.email t@t && git config user.name t", d)
        (d / "app.py").write_text(GitRevert.APP)
        (d / "config.ini").write_text(GitRevert.INI)
        (d / "README.md").write_text("# Demo\n")
        sh("git add -A && git commit -qm 'Initial commit'", d)
        (d / "log.py").write_text("def info(m):\n    print(m)\n")
        sh("git add -A && git commit -qm 'Add logging'", d)
        (d / "cache.py").write_text("CACHE = {}\n\ndef get(k):\n    return CACHE.get(k)\n")
        (d / "config.ini").write_text(GitRevert.INI + "cache = on\n")
        (d / "app.py").write_text("import cache\n\n" + GitRevert.APP)
        sh("git add -A && git commit -qm 'Add experimental cache'", d)
        (d / "config.ini").write_text((GitRevert.INI + "cache = on\n").replace("timeout = 30", "timeout = 60"))
        sh("git commit -qam 'Raise timeout'", d)
        (d / "README.md").write_text("# Demo\n\nRun app.py.\n")
        sh("git commit -qam 'Document usage'", d)

    @staticmethod
    def grade(d: Path):
        if sh("git rev-parse --abbrev-ref HEAD", d).strip() != "master":
            return False, "master is not checked out"
        msgs = sh("git log --format=%s master", d).splitlines()
        if msgs[1:] != GitRevert.MSGS[::-1] or len(msgs) != 6:
            return False, f"master history is {msgs}, want the 5 original commits plus exactly one new one"
        if sh("git rev-list --merges master", d).strip():
            return False, "master contains merge commits"
        tree = set(sh("git ls-tree -r --name-only master", d).split())
        if tree != {"app.py", "config.ini", "README.md", "log.py"}:
            return False, f"master tree is {sorted(tree)}"
        want = {"app.py": GitRevert.APP, "config.ini": GitRevert.INI.replace("timeout = 30", "timeout = 60"),
                "README.md": "# Demo\n\nRun app.py.\n", "log.py": "def info(m):\n    print(m)\n"}
        for f, text in want.items():
            if sh(f"git show master:{f}", d) != text:
                return False, f"{f} on master is wrong"
        if sh("git status --porcelain", d).strip():
            return False, "working tree is not clean"
        return True, "reverted"


# ---------------------------------------------------------------- 9. text processing, exact format
class AccessReport:
    name = "access-report"
    PROMPT = (
        "access.log is in Common Log Format: `HOST - - [DATE] \"METHOD PATH PROTOCOL\" STATUS BYTES`. Skip any line whose "
        "quoted request is not exactly three space-separated parts. Write report.txt: first the 5 most requested paths "
        "(a path with a ?query string counts as the path without it), one per line as the count right-aligned in a "
        "6-character field, one space, then the path, sorted by count descending then path ascending; then one empty "
        "line; then four lines `2xx: N`, `3xx: N`, `4xx: N`, `5xx: N` giving how many requests had a status in each class."
    )

    COUNTS = {"/": 40, "/api/items": 31, "/about": 31, "/login": 25, "/static/app.js": 20, "/contact": 20,
              "/index.html": 12, "/api/users": 9, "/static/style.css": 4}

    @staticmethod
    def entries():
        rnd = random.Random(21)
        rows = []
        for path, n in AccessReport.COUNTS.items():
            for _ in range(n):
                q = rnd.choice(["", "", "", "?page=2", "?q=a+b&x=1"])
                rows.append((path, path + q, rnd.choice([200, 200, 200, 201, 301, 304, 404, 403, 500, 503]), True))
        for req in ("-", "GET /broken", "GET /a b HTTP/1.1", "", "GET  /double HTTP/1.1"):
            rows.append((None, req, 400, False))
        rnd.shuffle(rows)
        return rnd, rows

    @staticmethod
    def setup(d: Path) -> None:
        rnd, rows = AccessReport.entries()
        lines = []
        for i, (_, full, status, ok) in enumerate(rows):
            host = f"10.0.{rnd.randint(0, 3)}.{rnd.randint(1, 250)}"
            date = (dt.datetime(2025, 3, 1, 8, 0) + dt.timedelta(minutes=i)).strftime("%d/%b/%Y:%H:%M:%S +0000")
            req = f"{rnd.choice(['GET', 'GET', 'POST'])} {full} HTTP/1.1" if ok else full
            lines.append(f'{host} - - [{date}] "{req}" {status} {rnd.randint(0, 9000)}')
        (d / "access.log").write_text("\n".join(lines) + "\n")

    @staticmethod
    def grade(d: Path):
        p = d / "report.txt"
        if not p.exists():
            return False, "no report.txt"
        _, rows = AccessReport.entries()
        good = [r for r in rows if r[3]]
        counts = {}
        for path, *_ in good:
            counts[path] = counts.get(path, 0) + 1
        top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        classes = {k: 0 for k in "2345"}
        for r in good:
            classes[str(r[2])[0]] += 1
        want = [f"{c:>6} {pth}" for pth, c in top] + [""] + [f"{k}xx: {classes[k]}" for k in "2345"]
        got = p.read_text().rstrip("\n").split("\n")
        if got == want:
            return True, "matches"
        diff = next(((i, a, b) for i, (a, b) in enumerate(zip(got, want)) if a != b), (len(got), len(want)))
        return False, f"first difference (line, got, want): {diff}"


# ---------------------------------------------------------------- 10. Node.js script
class NodeSummarize:
    name = "node-summarize"
    PROMPT = (
        "Write summarize.js, a plain Node.js script (no npm packages): `node summarize.js FILE` reads a JSON array of "
        "transactions {\"user\", \"amount\", \"type\"}, where amount is a decimal string like \"12.50\" and type is "
        "\"credit\" or \"debit\" (transactions of any other type are ignored). It prints one JSON object whose keys are "
        "every user that appears in the file, in sorted order, each mapped to that user's balance (credits minus debits) "
        "as a string with exactly two decimals such as \"-3.50\" or \"0.00\", computed without floating-point error. If "
        "FILE can't be read or isn't valid JSON, it prints an error to stderr and exits with status 1."
    )

    TX = [
        {"user": "zoe", "amount": "0.10", "type": "credit"}, {"user": "zoe", "amount": "0.20", "type": "credit"},
        {"user": "zoe", "amount": "0.30", "type": "debit"},
        {"user": "amy", "amount": "0.30", "type": "credit"}, {"user": "amy", "amount": "0.10", "type": "debit"},
        {"user": "amy", "amount": "0.20", "type": "debit"},
        {"user": "max", "amount": "19.99", "type": "credit"}, {"user": "max", "amount": "25.49", "type": "debit"},
        {"user": "kim", "amount": "100.00", "type": "refund"},
        {"user": "bob", "amount": "1234.56", "type": "credit"}, {"user": "bob", "amount": "0.01", "type": "credit"},
        {"user": "bob", "amount": "34.57", "type": "debit"},
    ]

    @staticmethod
    def setup(d: Path) -> None:
        (d / "transactions.json").write_text(json.dumps(NodeSummarize.TX, indent=1) + "\n")

    @staticmethod
    def expected(tx):
        bal = {}
        for t in tx:
            bal.setdefault(t["user"], Decimal(0))
            if t["type"] == "credit":
                bal[t["user"]] += Decimal(t["amount"])
            elif t["type"] == "debit":
                bal[t["user"]] -= Decimal(t["amount"])
        return [(u, f"{bal[u]:.2f}") for u in sorted(bal)]

    @staticmethod
    def grade(d: Path):
        if not (d / "summarize.js").exists():
            return False, "no summarize.js"
        if not shutil.which("node"):
            return False, "node is not installed on the grading machine"
        tmp = Path(tempfile.mkdtemp(prefix="grade2-node-"))
        rnd = random.Random(8)
        hidden = []
        for _ in range(300):
            hidden.append({"user": rnd.choice(["ann", "cal", "dee", "eve"]),
                           "amount": f"{rnd.randint(0, 5000)}.{rnd.randint(0, 99):02d}",
                           "type": rnd.choice(["credit", "debit", "debit", "fee"])})
        try:
            (tmp / "tx.json").write_text(json.dumps(NodeSummarize.TX))
            (tmp / "hidden.json").write_text(json.dumps(hidden))
            (tmp / "bad.json").write_text("[{\"user\": ")
            for f, tx in (("tx.json", NodeSummarize.TX), ("hidden.json", hidden)):
                try:
                    r = run(["node", str(d / "summarize.js"), str(tmp / f)], cwd=tmp, timeout=20)
                except subprocess.TimeoutExpired:
                    return False, f"{f}: timed out"
                if r.returncode != 0:
                    return False, f"{f}: exit {r.returncode}: {r.stderr.strip()[-120:]}"
                try:
                    got = json.loads(r.stdout, object_pairs_hook=list)
                except ValueError:
                    return False, f"{f}: stdout is not one JSON object: {r.stdout[:80]!r}"
                want = NodeSummarize.expected(tx)
                if got != want:
                    return False, f"{f}: got {got} want {want}"
            for f in ("missing.json", "bad.json"):
                r = run(["node", str(d / "summarize.js"), str(tmp / f)], cwd=tmp, timeout=20)
                if r.returncode != 1 or not r.stderr.strip():
                    return False, f"{f}: want exit 1 with an error on stderr, got exit {r.returncode}"
            return True, "all inputs"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- 11. parsing bug with hidden edge cases
class SizeParse:
    name = "size-parse-bug"
    PROMPT = (
        "parse_size in sizes.py is buggy. Fix it so it does everything its docstring says; hidden tests check the "
        "docstring's rules, examples and error cases. Don't change the docstring or test_sizes.py."
    )

    DOC = (
        '    """Parse a human-readable size into a whole number of bytes (an int).\n\n'
        '    The input is a non-negative number (digits, optionally followed by a dot and more digits)\n'
        '    followed by an optional unit, with optional whitespace between them and around the whole\n'
        '    string. Units are case-insensitive: B (or no unit) = 1, KB = 1000, MB = 1000**2,\n'
        '    GB = 1000**3, TB = 1000**4, KiB = 1024, MiB = 1024**2, GiB = 1024**3, TiB = 1024**4.\n'
        '    The result is computed exactly (no floating-point error) and any fraction of a byte is\n'
        '    rounded down: "1.5 KB" -> 1500, "2.01KB" -> 2010, "0.5 B" -> 0, "2 kib" -> 2048.\n'
        '    Anything else (empty string, negative number, unknown unit, missing number) raises ValueError.\n'
        '    """\n'
    )
    BUGGY = (
        'UNITS = {"b": 1, "kb": 1024, "mb": 1024 ** 2, "gb": 1024 ** 3, "kib": 1024, "mib": 1024 ** 2}\n\n\n'
        "def parse_size(s):\n" + DOC +
        '    num, unit = s.split(" ")\n'
        "    return int(num) * UNITS[unit.lower()]\n"
    )
    TESTS = (
        "from sizes import parse_size\n\n"
        "def test_bytes():\n    assert parse_size('10 B') == 10\n\n"
        "def test_kb():\n    assert parse_size('2 KB') == 2000\n"
    )

    @staticmethod
    def setup(d: Path) -> None:
        (d / "sizes.py").write_text(SizeParse.BUGGY)
        (d / "test_sizes.py").write_text(SizeParse.TESTS)

    @staticmethod
    def grade(d: Path):
        if not (d / "sizes.py").exists():
            return False, "no sizes.py"
        if (d / "test_sizes.py").read_text() != SizeParse.TESTS:
            return False, "test_sizes.py was changed"
        if SizeParse.DOC.strip() not in (d / "sizes.py").read_text():
            return False, "the docstring was changed"
        good = {"10 B": 10, "10": 10, "0": 0, "2 KB": 2000, "2kb": 2000, "1.5 MB": 1500000, " 3 GiB ": 3 * 1024 ** 3,
                "1TB": 10 ** 12, "1 TiB": 1024 ** 4, "0.5 B": 0, "1.5 KiB": 1536, "2.01KB": 2010, "4.06 kb": 4060, "2.05 MB": 2050000, "1.003 KB": 1003,
                "0.001 KB": 1, "0.0001 KB": 0, "7 mib": 7 * 1024 ** 2, "1.1 GB": 1100000000, "2 kib": 2048,
                "12 b": 12, "8\tMB": 8000000, "0.29 KB": 290, "1.005 GiB": 1079110533}
        bad = ["", "   ", "-1 KB", "KB", "5 XB", "1.2.3 MB", "1,5 KB", "abc", "5 KBB", "-0.5"]
        code = (
            "import sys\nsys.path.insert(0, '.')\n"
            "try:\n    from sizes import parse_size\nexcept Exception as e:\n    print('import failed:', repr(e)); sys.exit()\n"
            f"good = {good!r}\nbad = {bad!r}\n"
            "for s, v in good.items():\n"
            "    try:\n        r = parse_size(s)\n    except Exception as e:\n        print(f'parse_size({s!r}) raised {type(e).__name__}, want {v}'); sys.exit()\n"
            "    if r != v or type(r) is not int:\n        print(f'parse_size({s!r}) = {r!r}, want {v}'); sys.exit()\n"
            "for s in bad:\n"
            "    try:\n        r = parse_size(s)\n    except ValueError:\n        continue\n"
            "    except Exception as e:\n        print(f'parse_size({s!r}) raised {type(e).__name__}, want ValueError'); sys.exit()\n"
            "    print(f'parse_size({s!r}) = {r!r}, want ValueError'); sys.exit()\n"
            "print('OK')\n"
        )
        return py_check(d, code)


# ---------------------------------------------------------------- 12. file organisation
class OrganizeFiles:
    name = "organize-files"
    PROMPT = (
        "Move every file under inbox/ (including subfolders) into sorted/images/ (extensions .jpg .jpeg .png .gif), "
        "sorted/docs/ (.pdf .txt .docx) or sorted/other/ (anything else), matching extensions case-insensitively, and "
        "rename each file to its name in lowercase. When two files would get the same name in the same folder, process "
        "files in order of their path relative to inbox/ (plain string sort, e.g. `2023/x.jpg` before `X.JPG`): the "
        "first keeps the name and later ones get -1, -2, ... inserted before the extension (photo-1.jpg). File contents "
        "must be unchanged; afterwards inbox/ must be gone and sorted/ must be the only thing in this directory."
    )

    FILES = ["Photo.JPG", "2023/photo.jpg", "2023/Report.PDF", "2023/notes.TXT", "notes.txt", "misc/Notes.TXT",
             "archive.zip", "misc/deep/Song.MP3", "img.jpeg", "a.Png", "README", "misc/deep/Plan.docx", "logo.GIF",
             "2023/Budget.tar.gz"]

    @staticmethod
    def setup(d: Path) -> None:
        for rel in OrganizeFiles.FILES:
            f = d / "inbox" / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(f"content of {rel}\n")

    @staticmethod
    def expected():
        kinds = {".jpg": "images", ".jpeg": "images", ".png": "images", ".gif": "images",
                 ".pdf": "docs", ".txt": "docs", ".docx": "docs"}
        out = {}
        for rel in sorted(OrganizeFiles.FILES):
            name = rel.split("/")[-1].lower()
            stem, ext = os.path.splitext(name)
            folder = kinds.get(ext, "other")
            cand, k = name, 0
            while f"{folder}/{cand}" in out:
                k += 1
                cand = f"{stem}-{k}{ext}"
            out[f"{folder}/{cand}"] = f"content of {rel}\n"
        return out

    @staticmethod
    def grade(d: Path):
        top = sorted(x.name for x in d.iterdir() if x.name not in IGNORED)
        if top != ["sorted"]:
            return False, f"directory holds {top}, want only sorted/"
        want = OrganizeFiles.expected()
        got = all_files(d / "sorted")
        # compare with the names the filesystem actually stores (case matters)
        real = set()
        for dirpath, _, files in os.walk(d / "sorted"):
            for f in files:
                if f not in IGNORED:
                    real.add(os.path.relpath(os.path.join(dirpath, f), d / "sorted").replace(os.sep, "/"))
        if real != set(want):
            return False, f"missing {sorted(set(want) - real)[:4]}, unexpected {sorted(real - set(want))[:4]}"
        for rel, text in want.items():
            if (d / "sorted" / rel).read_text() != text:
                return False, f"sorted/{rel} holds the wrong file"
        dirs = sorted(x.name for x in (d / "sorted").iterdir() if x.name not in IGNORED)
        if dirs != ["docs", "images", "other"] or got != set(want):
            return False, f"sorted/ holds {dirs}"
        return True, "organised"


# ---------------------------------------------------------------- 13. Makefile
class MakeSite:
    name = "makefile-site"
    PROMPT = (
        "Write a Makefile here so that `make` builds build/NAME.html from every src/NAME.md by running "
        "`python3 md2html.py src/NAME.md build/NAME.html` (creating build/ if needed), picking up new .md files without "
        "editing the Makefile. A page must be rebuilt only when its .md file or md2html.py is newer than it, so running "
        "`make` twice in a row rebuilds nothing the second time. `make clean` removes build/."
    )

    MD2HTML = (
        "import html\nimport sys\n\n"
        "src, out = sys.argv[1], sys.argv[2]\nbody = []\n"
        "for ln in open(src).read().splitlines():\n"
        "    if ln.startswith('# '):\n        body.append('<h1>' + html.escape(ln[2:]) + '</h1>')\n"
        "    elif ln.strip():\n        body.append('<p>' + html.escape(ln) + '</p>')\n"
        "with open(out, 'w') as f:\n    f.write('<html><body>\\n' + '\\n'.join(body) + '\\n</body></html>\\n')\n"
    )
    PAGES = {"index": "# Home\nWelcome & hello.\n", "about": "# About\nWe make <things>.\n\nSince 2020.\n",
             "contact": "# Contact\nmail us\n"}

    @staticmethod
    def setup(d: Path) -> None:
        (d / "md2html.py").write_text(MakeSite.MD2HTML)
        (d / "src").mkdir()
        for k, v in MakeSite.PAGES.items():
            (d / "src" / f"{k}.md").write_text(v)

    @staticmethod
    def render(md: str) -> str:
        body = []
        for ln in md.splitlines():
            if ln.startswith("# "):
                body.append("<h1>" + __import__("html").escape(ln[2:]) + "</h1>")
            elif ln.strip():
                body.append("<p>" + __import__("html").escape(ln) + "</p>")
        return "<html><body>\n" + "\n".join(body) + "\n</body></html>\n"

    @staticmethod
    def grade(d: Path):
        if not (d / "Makefile").exists():
            return False, "no Makefile"
        tmp, w = scratch_copy(d)
        try:
            shutil.rmtree(w / "build", ignore_errors=True)
            (w / "md2html.py").write_text(MakeSite.MD2HTML)
            for f in (w / "src").glob("*.md"):
                f.unlink()
            for k, v in MakeSite.PAGES.items():
                (w / "src" / f"{k}.md").write_text(v)

            def make(*a):
                try:
                    return run(["make", *a], cwd=w, timeout=30)
                except subprocess.TimeoutExpired:
                    return None

            def mt(name):
                return (w / "build" / f"{name}.html").stat().st_mtime

            r = make()
            if r is None or r.returncode != 0:
                return False, f"make failed: {(r.stderr if r else 'timeout')[-120:]}"
            for k, v in MakeSite.PAGES.items():
                f = w / "build" / f"{k}.html"
                if not f.exists() or f.read_text() != MakeSite.render(v):
                    return False, f"build/{k}.html missing or wrong after make"
            now = time.time()
            old = now - 300
            for f in [w / "md2html.py", w / "Makefile", *(w / "src").glob("*.md")]:
                os.utime(f, (old, old))
            for k in MakeSite.PAGES:
                os.utime(w / "build" / f"{k}.html", (now - 200, now - 200))
            os.utime(w / "build", (now - 200, now - 200))
            r = make()
            if r is None or r.returncode != 0 or any(abs(mt(k) - (now - 200)) > 1 for k in MakeSite.PAGES):
                return False, "a second make with nothing changed rebuilt pages"
            os.utime(w / "src" / "about.md", (now - 100, now - 100))
            r = make()
            if r is None or r.returncode != 0 or mt("about") < now - 150:
                return False, "about.html not rebuilt after src/about.md changed"
            if abs(mt("index") - (now - 200)) > 1 or abs(mt("contact") - (now - 200)) > 1:
                return False, "untouched pages were rebuilt when only about.md changed"
            os.utime(w / "md2html.py", (now - 50, now - 50))
            r = make()
            if r is None or r.returncode != 0 or any(mt(k) < now - 60 for k in MakeSite.PAGES):
                return False, "pages not rebuilt after md2html.py changed"
            (w / "src" / "news.md").write_text("# News\nnothing yet\n")
            r = make()
            f = w / "build" / "news.html"
            if r is None or r.returncode != 0 or not f.exists() or f.read_text() != MakeSite.render("# News\nnothing yet\n"):
                return False, "a new src/news.md was not built"
            r = make("clean")
            if r is None or r.returncode != 0 or (w / "build").exists():
                return False, "make clean did not remove build/"
            r = make()
            if r is None or r.returncode != 0 or not (w / "build" / "news.html").exists():
                return False, "make after clean failed"
            return True, "all rebuild rules"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- 14. cron next-run computation
class CronNext:
    name = "cron-next"
    PROMPT = (
        "Write nextrun.py: `python3 nextrun.py 'CRON' 'YYYY-MM-DD HH:MM' N` prints the next N times strictly after the "
        "given time that match the 5-field cron expression (minute hour day-of-month month day-of-week), one per line "
        "as YYYY-MM-DD HH:MM. Each field is *, a number, a range a-b, a step */n or a-b/n, or a comma-separated list of "
        "these; day-of-week is 0-6 with Sunday = 0, and 7 also means Sunday. As in standard cron, when both "
        "day-of-month and day-of-week are something other than *, a day matches if it matches either one."
    )

    CASES = [
        ("*/15 * * * *", "2025-01-01 00:07", 3),
        ("0 9 * * 1-5", "2025-01-03 10:00", 3),
        ("30 2 29 2 *", "2025-01-01 00:00", 2),
        ("0 0 1,15 * 0", "2025-03-01 00:00", 5),
        ("5-10/2 8-9 * * *", "2025-06-01 08:06", 5),
        ("0 12 * * 7", "2025-06-01 12:00", 2),
        ("59 23 31 12 *", "2025-12-31 23:59", 1),
        ("0 0 31 * *", "2025-01-31 00:00", 3),
        ("0,30 22-23 * 11-12 6", "2025-10-31 23:59", 4),
        ("1 1 1 1 1", "2025-01-01 00:00", 3),
    ]

    @staticmethod
    def _field(spec, lo, hi):
        out = set()
        for part in spec.split(","):
            step = 1
            if "/" in part:
                part, s = part.split("/"); step = int(s)
            if part == "*":
                a, b = lo, hi
            elif "-" in part:
                a, b = map(int, part.split("-"))
            else:
                a = b = int(part)
            out.update(range(a, b + 1, step))
        return out

    @staticmethod
    def expected(expr, start, n):
        mi, ho, dom, mo, dow = expr.split()
        M, H, D, MO = (CronNext._field(mi, 0, 59), CronNext._field(ho, 0, 23), CronNext._field(dom, 1, 31), CronNext._field(mo, 1, 12))
        W = {x % 7 for x in CronNext._field(dow, 0, 7)}
        t0 = dt.datetime.strptime(start, "%Y-%m-%d %H:%M")
        day = t0.date()
        out = []
        while len(out) < n:
            wd = (day.weekday() + 1) % 7
            dm, wm = day.day in D, wd in W
            ok = (dm or wm) if (dom != "*" and dow != "*") else (dm and wm)
            if day.month in MO and ok:
                for h in sorted(H):
                    for m in sorted(M):
                        t = dt.datetime(day.year, day.month, day.day, h, m)
                        if t > t0 and len(out) < n:
                            out.append(t.strftime("%Y-%m-%d %H:%M"))
            day += dt.timedelta(days=1)
        return out

    @staticmethod
    def setup(d: Path) -> None:
        pass

    @staticmethod
    def grade(d: Path):
        if not (d / "nextrun.py").exists():
            return False, "no nextrun.py"
        for expr, start, n in CronNext.CASES:
            try:
                r = run(["python3", str(d / "nextrun.py"), expr, start, str(n)], cwd=d, timeout=30)
            except subprocess.TimeoutExpired:
                return False, f"{expr!r} from {start}: timed out"
            want = CronNext.expected(expr, start, n)
            got = r.stdout.strip().splitlines()
            if got != want:
                return False, f"{expr!r} from {start}: got {got[:3]} want {want[:3]}{' ' + r.stderr.strip()[-80:] if r.returncode else ''}"
        return True, f"{len(CronNext.CASES)} expressions"


# ---------------------------------------------------------------- 15. secrets redaction
class RedactSecrets:
    name = "redact-secrets"
    PROMPT = (
        "Redact secrets in every file under this directory by replacing each one with [REDACTED]: AWS access key ids "
        "(AKIA followed by exactly 16 uppercase letters or digits), GitHub tokens (ghp_ followed by exactly 36 letters or "
        "digits), where neither may be immediately preceded or followed by another letter or digit, and PEM private-key "
        "blocks (from -----BEGIN ... PRIVATE KEY----- through the matching -----END ... PRIVATE KEY----- line's last dash, "
        "replaced as a whole). Everything else in every file, including line endings and files with no secrets, must "
        "stay byte-for-byte unchanged. Then write redactions.txt listing each changed file as `PATH: N` (path relative "
        "to this directory, N = secrets replaced in it), sorted by path; create no other files."
    )

    AWS1 = "AKIAQ7XK2M9PLR4TZ8WN"
    AWS2 = "AKIAZZ01BB23CC45DD67"
    GH1 = "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
    GH2 = "ghp_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210"
    PEM = ("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n"
           "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK\n-----END RSA PRIVATE KEY-----")

    @staticmethod
    def files():
        C = RedactSecrets
        return {
            "app/settings.py": (f'AWS_ACCESS_KEY_ID = "{C.AWS1}"\nREGION = "us-east-1"\n# format: AKIA + 16 chars\n',
                                'AWS_ACCESS_KEY_ID = "[REDACTED]"\nREGION = "us-east-1"\n# format: AKIA + 16 chars\n', 1),
            "app/.env": (f"GITHUB_TOKEN={C.GH1}\r\nAWS_KEY={C.AWS2}\r\nDEBUG=1\r\n",
                         "GITHUB_TOKEN=[REDACTED]\r\nAWS_KEY=[REDACTED]\r\nDEBUG=1\r\n", 2),
            "deploy/key.pem": (f"# deploy key\n{C.PEM}\n", "# deploy key\n[REDACTED]\n", 1),
            "scripts/fetch.sh": (f"curl -H 'Authorization: token {C.GH2}' 'https://x.test/?key={C.AWS1}&v=2'\n",
                                 "curl -H 'Authorization: token [REDACTED]' 'https://x.test/?key=[REDACTED]&v=2'\n", 2),
            "docs/notes.md": ("Near misses that are not secrets:\n"
                              "- AKIAQ7XK2M9PLR4TZ8W (15 chars)\n- XAKIAQ7XK2M9PLR4TZ8WN (glued to a letter)\n"
                              "- AKIAQ7XK2M9PLR4TZ8WNX (17 chars)\n- akiaq7xk2m9plr4tz8wn (lowercase)\n"
                              "- ghp_short123\n- ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8Z (37 chars)\n"
                              "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n", None, 0),
            "README.md": ("No secrets here. Keys look like AKIA... and ghp_...\n", None, 0),
        }

    LOGO = bytes(random.Random(99).randrange(256) for _ in range(2048))

    @staticmethod
    def setup(d: Path) -> None:
        for rel, (orig, _, _) in RedactSecrets.files().items():
            f = d / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(orig.encode())
        (d / "assets").mkdir()
        (d / "assets" / "logo.png").write_bytes(RedactSecrets.LOGO)

    @staticmethod
    def grade(d: Path):
        files = RedactSecrets.files()
        want_set = set(files) | {"assets/logo.png", "redactions.txt"}
        have = all_files(d)
        if have != want_set:
            return False, f"missing {sorted(want_set - have)}, unexpected {sorted(have - want_set)}"
        for rel, (orig, red, _) in files.items():
            got = (d / rel).read_bytes()
            want = (red if red is not None else orig).encode()
            if got != want:
                return False, f"{rel} is wrong: {got[:90]!r}"
        if (d / "assets" / "logo.png").read_bytes() != RedactSecrets.LOGO:
            return False, "assets/logo.png was changed"
        want_list = [f"{rel}: {n}" for rel, (_, _, n) in sorted(files.items()) if n]
        got_list = [x for x in (d / "redactions.txt").read_text().splitlines() if x.strip()]
        if got_list != want_list:
            return False, f"redactions.txt is {got_list}, want {want_list}"
        return True, "all redacted"


TASKS2 = [HttpServer, SqlTop, CsvClean, RefactorPricing, RotateLogs, ConfigMigrate, PerfPairs, GitRevert,
          AccessReport, NodeSummarize, SizeParse, OrganizeFiles, MakeSite, CronNext, RedactSecrets]
