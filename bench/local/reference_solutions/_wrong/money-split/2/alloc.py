import re
import sys
from decimal import Decimal

# plausible mistake: leftover cents go to the first parties, not the largest remainders
total, ws = sys.argv[1], sys.argv[2:]
if not re.fullmatch(r"\d+(\.\d{1,2})?", total) or not ws or not all(re.fullmatch(r"\d+", w) for w in ws) or not any(int(w) for w in ws):
    sys.exit(1)
w = [int(x) for x in ws]
cents = int(Decimal(total) * 100)
sh = [cents * x // sum(w) for x in w]
for i in range(cents - sum(sh)):
    sh[i] += 1
for c in sh:
    print(f"{c // 100}.{c % 100:02d}")
