import csv
import re
import sys
from datetime import datetime, timedelta

# plausible mistake: the timestamp offset is dropped (local wall clock used as if UTC), the file order is
# trusted, and a gap of exactly 1800 s starts a new session
LINE = re.compile(r'(\S+) \S+ \S+ \[([^\]]+) [+-]\d{4}\] "(\S+) (\S+) [^"]*" \d+ \S+ "[^"]*" "([^"]*)"')
sessions = {}
for line in open(sys.argv[1], encoding="utf-8"):
    m = LINE.match(line)
    if not m or m.group(4).startswith("/static/") or m.group(4).startswith("/favicon.ico"):
        continue
    t = datetime.strptime(m.group(2), "%d/%b/%Y:%H:%M:%S")
    sessions.setdefault((m.group(1), m.group(5)), []).append(t)
rows = []
for (ip, ua), ts in sessions.items():
    cur = [ts[0], ts[0], 1]
    for t in ts[1:]:
        if t - cur[1] >= timedelta(minutes=30):
            rows.append((ip, ua, *cur))
            cur = [t, t, 1]
        else:
            cur[1] = t
            cur[2] += 1
    rows.append((ip, ua, *cur))
w = csv.writer(open(sys.argv[2], "w", newline=""))
w.writerow(["ip", "user_agent", "start", "end", "hits", "duration_seconds"])
for ip, ua, a, b, c in sorted(rows, key=lambda r: (r[2], r[0], r[1])):
    w.writerow([ip, ua, a.strftime("%Y-%m-%dT%H:%M:%SZ"), b.strftime("%Y-%m-%dT%H:%M:%SZ"), c, int((b - a).total_seconds())])
