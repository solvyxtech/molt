import sys
from decimal import Decimal

# plausible mistake: round each share independently (the shares may not add up)
total = Decimal(sys.argv[1])
ws = [int(w) for w in sys.argv[2:]]
s = sum(ws)
if not ws or s == 0:
    sys.exit(1)
for w in ws:
    print((total * w / s).quantize(Decimal("0.01")))
