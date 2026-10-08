import re
import sys

# plausible mistake: prerelease identifiers compared as plain strings, build metadata part of the key
RX = re.compile(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?")
rows, bad = [], 0
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    m = RX.fullmatch(line)
    if not m:
        bad += 1
        continue
    pre = m.group(4)
    rows.append(((int(m.group(1)), int(m.group(2)), int(m.group(3)), pre is None, pre or "", m.group(5) or ""), line))
rows.sort(key=lambda r: r[0])
for _, l in rows:
    print(l)
sys.exit(1 if bad else 0)
