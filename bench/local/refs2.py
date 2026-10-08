"""Reference solutions for tasks2.py, used only by validate2.py."""

from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
from pathlib import Path


def sh(cmd: str, cwd: Path) -> str:
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True).stdout


def solve_http_json_server(d: Path):
    (d / "server.py").write_text(r'''import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DB = Path(__file__).with_name("items.json")
LOCK = threading.Lock()


def load():
    return json.loads(DB.read_text())


class H(BaseHTTPRequestHandler):
    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        items = sorted(load(), key=lambda x: x["id"])
        if self.path == "/items":
            return self.send(200, items)
        if self.path.startswith("/items/"):
            for it in items:
                if str(it["id"]) == self.path[len("/items/"):]:
                    return self.send(200, it)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/items":
            return self.send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"null")
        except ValueError:
            body = None
        if not isinstance(body, dict) or not isinstance(body.get("name"), str):
            return self.send(400, {"error": "bad request"})
        with LOCK:
            items = load()
            it = {"id": max((x["id"] for x in items), default=0) + 1, "name": body["name"]}
            items.append(it)
            DB.write_text(json.dumps(items, indent=2) + "\n")
        self.send(201, it)

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
''')


def solve_sql_top_customers(d: Path):
    db = sqlite3.connect(d / "shop.db")
    rows = db.execute(
        "SELECT c.name, printf('%.2f', SUM(oi.qty * oi.unit_price)) AS t, SUM(oi.qty * oi.unit_price) AS s "
        "FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items oi ON oi.order_id = o.id "
        "WHERE o.status = 'paid' AND o.order_date LIKE '2024-%' GROUP BY c.id ORDER BY s DESC, c.name ASC LIMIT 5"
    ).fetchall()
    db.close()
    (d / "top_customers.csv").write_text("name,total\n" + "".join(f"{n},{t}\n" for n, t, _ in rows))


def solve_csv_clean(d: Path):
    import csv
    lines = (d / "people.csv").read_text().splitlines()
    out, seen = [lines[0].split(",")], set()
    for ln in lines[1:]:
        f = [x.strip() for x in ln.split(",")]
        if not ln.strip() or len(f) != 5:
            continue
        f[2] = f[2].lower()
        p = f[2].split("@")
        if len(p) != 2 or not p[0] or "." not in p[1][1:-1]:
            continue
        if not (f[3].isdigit() and int(f[3]) <= 120) or f[2] in seen:
            continue
        seen.add(f[2]); out.append(f)
    with open(d / "clean.csv", "w", newline="") as fh:
        csv.writer(fh, lineterminator="\n").writerows(out)


def solve_refactor_pricing(d: Path):
    (d / "pricing.py").write_text('''BASE = {"widget": 2.5, "gadget": 10.0, "doohickey": 7.25}


def _save10(base, qty, subtotal):
    return subtotal - subtotal * 0.10


def _bulk(base, qty, subtotal):
    return subtotal - 5 if qty >= 10 else subtotal


def _fiveoff(base, qty, subtotal):
    return subtotal - 5 if subtotal >= 20 else subtotal


def _bogo(base, qty, subtotal):
    return base * (qty - qty // 2)


COUPONS = {"SAVE10": _save10, "BULK": _bulk, "FIVEOFF": _fiveoff, "BOGO": _bogo}


def price(item, qty, coupon=None):
    base = BASE[item]
    subtotal = base * qty
    if coupon is not None:
        if coupon not in COUPONS:
            raise ValueError("unknown coupon")
        subtotal = COUPONS[coupon](base, qty, subtotal)
    return round(subtotal, 2)


def best_coupon(item, qty):
    none = price(item, qty)
    best = min((price(item, qty, c), c) for c in COUPONS)
    return best[1] if best[0] < none else None
''')


def solve_bash_rotate(d: Path):
    s = d / "rotate.sh"
    s.write_text(r'''#!/bin/bash
usage() { echo "usage: rotate.sh [-n N] DIR" >&2; exit 2; }
n=5
if [ "$1" = "-n" ]; then
  [ $# -ge 2 ] || usage
  n=$2; shift 2
fi
[ $# -eq 1 ] || usage
dir=$1
[ -d "$dir" ] || usage
case "$n" in ''|*[!0-9]*) usage ;; esac
[ "$n" -gt 0 ] || usage
i=0
while IFS= read -r f; do
  i=$((i + 1))
  if [ "$i" -gt "$n" ]; then echo "$f"; fi
done < <(cd "$dir" && ls -t -- *.log 2>/dev/null | while IFS= read -r x; do [ -f "$x" ] && echo "$x"; done) > "${TMPDIR:-/tmp}/rot.$$"
{ tac "${TMPDIR:-/tmp}/rot.$$" 2>/dev/null || tail -r "${TMPDIR:-/tmp}/rot.$$"; } | while IFS= read -r f; do rm -f -- "$dir/$f"; echo "$f"; done
rm -f "${TMPDIR:-/tmp}/rot.$$"
exit 0
''')
    s.chmod(0o755)


def solve_config_migrate(d: Path):
    import json
    for f in sorted((d / "configs").glob("*.json")):
        v = json.loads(f.read_text())
        if v.get("version") != 1:
            continue
        feats = []
        for x in v.get("features", "").split(","):
            x = x.strip()
            if x and x not in feats:
                feats.append(x)
        dbg = v.get("debug")
        users = v.get("users", [])
        f.write_text(json.dumps({
            "version": 2,
            "database": {"host": v["db_host"], "port": int(v.get("db_port", 5432))},
            "debug": dbg is True or (isinstance(dbg, str) and dbg.lower() in ("yes", "true", "1")),
            "features": feats,
            "users": [u["name"] for u in users],
            "admins": [u["name"] for u in users if u.get("admin") is True or u.get("admin") == 1],
        }, indent=2) + "\n")


def solve_perf_pairs(d: Path):
    (d / "pairs.py").write_text('''from collections import Counter


def find_pairs(nums, target):
    """Return the sorted list of distinct pairs (a, b) with a <= b such that a and b are the
    values at two different positions of nums and a + b == target."""
    c = Counter(nums)
    out = set()
    for a in c:
        b = target - a
        if a <= b and b in c and (a != b or c[a] > 1):
            out.add((a, b))
    return sorted(out)
''')


def solve_git_revert_one(d: Path):
    h = sh("git log --format=%H --grep='^Add experimental cache$' master", d).split()[0]
    sh(f"git revert --no-edit {h}", d)


def solve_access_report(d: Path):
    import re
    counts, classes = {}, {k: 0 for k in "2345"}
    for ln in (d / "access.log").read_text().splitlines():
        m = re.match(r'^\S+ \S+ \S+ \[[^\]]*\] "([^"]*)" (\d{3}) ', ln)
        if not m:
            continue
        parts = m.group(1).split(" ")
        if len(parts) != 3 or not all(parts):
            continue
        path = parts[1].split("?")[0]
        counts[path] = counts.get(path, 0) + 1
        classes[m.group(2)[0]] += 1
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
    text = "".join(f"{c:>6} {p}\n" for p, c in top) + "\n" + "".join(f"{k}xx: {classes[k]}\n" for k in "2345")
    (d / "report.txt").write_text(text)


def solve_node_summarize(d: Path):
    (d / "summarize.js").write_text(r'''const fs = require("fs");
let tx;
try {
  tx = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch (e) {
  console.error("error: " + e.message);
  process.exit(1);
}
const cents = (s) => {
  const [w, f = ""] = String(s).split(".");
  return BigInt(w) * 100n + BigInt((f + "00").slice(0, 2));
};
const bal = {};
for (const t of tx) {
  if (!(t.user in bal)) bal[t.user] = 0n;
  if (t.type === "credit") bal[t.user] += cents(t.amount);
  else if (t.type === "debit") bal[t.user] -= cents(t.amount);
}
const out = {};
for (const u of Object.keys(bal).sort()) {
  const v = bal[u], neg = v < 0n, a = neg ? -v : v;
  out[u] = (neg ? "-" : "") + (a / 100n).toString() + "." + (a % 100n).toString().padStart(2, "0");
}
console.log(JSON.stringify(out, null, 2));
''')


def solve_size_parse_bug(d: Path):
    src = (d / "sizes.py").read_text()
    doc = src[src.index('    """'):src.index('    """', src.index('    """') + 7) + 8]
    (d / "sizes.py").write_text(
        "import re\nfrom decimal import Decimal\n\n"
        'UNITS = {"": 1, "b": 1, "kb": 1000, "mb": 1000 ** 2, "gb": 1000 ** 3, "tb": 1000 ** 4,\n'
        '         "kib": 1024, "mib": 1024 ** 2, "gib": 1024 ** 3, "tib": 1024 ** 4}\n\n\n'
        "def parse_size(s):\n" + doc +
        "    m = re.fullmatch(r'\\s*(\\d+(?:\\.\\d+)?)\\s*([A-Za-z]*)\\s*', s)\n"
        "    if not m or m.group(2).lower() not in UNITS:\n"
        "        raise ValueError(f'bad size: {s!r}')\n"
        "    return int(Decimal(m.group(1)) * UNITS[m.group(2).lower()])\n"
    )


def solve_organize_files(d: Path):
    kinds = {".jpg": "images", ".jpeg": "images", ".png": "images", ".gif": "images",
             ".pdf": "docs", ".txt": "docs", ".docx": "docs"}
    inbox = d / "inbox"
    rels = sorted(str(p.relative_to(inbox)) for p in inbox.rglob("*") if p.is_file())
    used = set()
    for rel in rels:
        name = rel.split("/")[-1].lower()
        stem, ext = os.path.splitext(name)
        folder = kinds.get(ext, "other")
        cand, k = name, 0
        while (folder, cand) in used:
            k += 1
            cand = f"{stem}-{k}{ext}"
        used.add((folder, cand))
        (d / "sorted" / folder).mkdir(parents=True, exist_ok=True)
        shutil.move(str(inbox / rel), str(d / "sorted" / folder / cand))
    shutil.rmtree(inbox)


def solve_makefile_site(d: Path):
    (d / "Makefile").write_text(
        "PAGES := $(patsubst src/%.md,build/%.html,$(wildcard src/*.md))\n\n"
        "all: $(PAGES)\n\n"
        "build/%.html: src/%.md md2html.py | build\n"
        "\tpython3 md2html.py $< $@\n\n"
        "build:\n\tmkdir -p build\n\n"
        "clean:\n\trm -rf build\n\n"
        ".PHONY: all clean\n"
    )


def solve_cron_next(d: Path):
    (d / "nextrun.py").write_text(r'''import datetime as dt
import sys


def field(spec, lo, hi):
    out = set()
    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/")
            step = int(s)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a, b = map(int, part.split("-"))
        else:
            a = b = int(part)
        out.update(range(a, b + 1, step))
    return out


expr, start, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
mi, ho, dom, mo, dow = expr.split()
M, H, D, MO = field(mi, 0, 59), field(ho, 0, 23), field(dom, 1, 31), field(mo, 1, 12)
W = {x % 7 for x in field(dow, 0, 7)}
t0 = dt.datetime.strptime(start, "%Y-%m-%d %H:%M")
day, found = t0.date(), 0
while found < n:
    dm, wm = day.day in D, (day.weekday() + 1) % 7 in W
    ok = (dm or wm) if dom != "*" and dow != "*" else (dm and wm)
    if day.month in MO and ok:
        for h in sorted(H):
            for m in sorted(M):
                t = dt.datetime(day.year, day.month, day.day, h, m)
                if t > t0 and found < n:
                    print(t.strftime("%Y-%m-%d %H:%M"))
                    found += 1
    day += dt.timedelta(days=1)
''')


def solve_redact_secrets(d: Path):
    import re
    pats = [re.compile(rb"(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])"),
            re.compile(rb"(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])"),
            re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S)]
    report = []
    for p in sorted(x for x in d.rglob("*") if x.is_file()):
        data = p.read_bytes()
        total = 0
        for pat in pats:
            data, k = pat.subn(b"[REDACTED]", data)
            total += k
        if total:
            p.write_bytes(data)
            report.append((p.relative_to(d).as_posix(), total))
    (d / "redactions.txt").write_text("".join(f"{r}: {n}\n" for r, n in sorted(report)))
