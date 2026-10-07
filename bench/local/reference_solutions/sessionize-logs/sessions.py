import csv
import re
import sys
from datetime import datetime, timedelta, timezone

MONTHS = {m: i for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(), 1)}
LINE = re.compile(
    r'(\S+) \S+ \S+ \[(\d\d)/(\w{3})/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)\] "([^"]*)" \d{3} (?:\d+|-) "[^"]*" "([^"]*)"'
)
GAP = 1800


def parse(line):
    m = LINE.fullmatch(line)
    if not m:
        return None
    ip, dd, mon, yy, hh, mi, ss, sign, oh, om, request, ua = m.groups()
    parts = request.split(" ")
    if len(parts) != 3 or mon not in MONTHS:
        return None
    path = parts[1].split("?")[0]
    if path.startswith("/static/") or path == "/favicon.ico":
        return None
    offset = timedelta(hours=int(oh), minutes=int(om))
    if sign == "-":
        offset = -offset
    t = datetime(int(yy), MONTHS[mon], int(dd), int(hh), int(mi), int(ss), tzinfo=timezone(offset))
    return ip, ua, t.astimezone(timezone.utc)


def main(src, dst):
    hits = {}
    with open(src, encoding="utf-8", errors="replace") as f:
        for n, line in enumerate(f):
            p = parse(line.rstrip("\r\n"))
            if p:
                hits.setdefault((p[0], p[1]), []).append((p[2], n))
    rows = []
    for (ip, ua), hs in hits.items():
        hs.sort()
        cur = None
        for t, _ in hs:
            if cur is not None and (t - cur[1]).total_seconds() <= GAP:
                cur[1] = t
                cur[2] += 1
            else:
                if cur:
                    rows.append((ip, ua, *cur))
                cur = [t, t, 1]
        rows.append((ip, ua, *cur))
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    out = [(ip, ua, a.strftime(fmt), b.strftime(fmt), c, int((b - a).total_seconds())) for ip, ua, a, b, c in rows]
    out.sort(key=lambda r: (r[2], r[0], r[1]))
    with open(dst, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ip", "user_agent", "start", "end", "hits", "duration_seconds"])
        w.writerows(out)


main(sys.argv[1], sys.argv[2])
