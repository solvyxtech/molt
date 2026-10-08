import re
import sys
from decimal import Decimal

# plausible mistake: only leaf accounts are reported (no parent totals), floats avoided but --until ignored for
# validation, and zero-balance accounts are printed
until = sys.argv[sys.argv.index("--until") + 1] if "--until" in sys.argv else None
text = open(sys.argv[1]).read().split("\n")
totals, cur, date = {}, [], None


def flush():
    if not cur:
        return
    known = [(a, v) for a, v in cur if v is not None]
    tot = sum(v for _, v in known)
    for a, v in cur:
        v = -tot if v is None else v
        if until is None or date <= until:
            totals[a] = totals.get(a, 0) + v


for line in text:
    if line.startswith(("#", ";")) or not line.strip():
        continue
    if line[0] in " \t":
        m = re.match(r"\s+(.+?)(?:\s{2,}|\t+)(-?\$-?[\d,.]+)", line)
        if m:
            cur.append((m.group(1), Decimal(m.group(2).replace("$", "").replace(",", ""))))
        else:
            cur.append((line.strip().split(";")[0].strip(), None))
    else:
        flush()
        cur, date = [], line.split()[0]
flush()
for a in sorted(totals):
    print(f"{('-$' if totals[a] < 0 else '$') + format(abs(totals[a]), ',.2f'):>12}  {a}")
