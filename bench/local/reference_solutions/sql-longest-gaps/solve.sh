python3 - <<'PY'
import csv
import sqlite3
from datetime import datetime, timezone

db = sqlite3.connect("sensors.db")
by = {}
for sensor, ts in db.execute("SELECT sensor, ts FROM readings WHERE value IS NOT NULL"):
    t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    by.setdefault(sensor, []).append(int(t.timestamp()))
rows = []
for sensor, xs in by.items():
    xs.sort()
    if len(xs) < 2:
        continue
    gap, start = max(((b - a), -a) for a, b in zip(xs, xs[1:]))
    start = -start
    rows.append((sensor, gap, datetime.fromtimestamp(start, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")))
rows.sort(key=lambda r: (-r[1], r[0]))
with open("longest_gaps.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["sensor", "gap_seconds", "gap_start"])
    w.writerows(rows)
PY
