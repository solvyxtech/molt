import re
import sys
from decimal import Decimal


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def main(argv):
    if len(argv) < 2:
        fail("usage: alloc.py TOTAL W1 W2 ...")
    total, ws = argv[0], argv[1:]
    if not re.fullmatch(r"\d+(\.\d{1,2})?", total):
        fail(f"bad total: {total}")
    if not ws:
        fail("no weights")
    if not all(re.fullmatch(r"\d+", w) for w in ws):
        fail("weights must be non-negative integers")
    weights = [int(w) for w in ws]
    s = sum(weights)
    if s == 0:
        fail("weights are all zero")
    cents = int(Decimal(total) * 100)
    shares = [cents * w // s for w in weights]
    rems = [cents * w % s for w in weights]
    left = cents - sum(shares)
    for i in sorted(range(len(weights)), key=lambda i: (-rems[i], i))[:left]:
        shares[i] += 1
    for c in shares:
        print(f"{c // 100}.{c % 100:02d}")


main(sys.argv[1:])
