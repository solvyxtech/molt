import re
import sys

ID = r"(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
RX = re.compile(
    r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(" + ID + r"(?:\." + ID + r")*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


def key(m):
    core = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    pre = m.group(4)
    if pre is None:
        return core + (1, ())
    ids = tuple((0, int(x), "") if x.isdigit() else (1, 0, x) for x in pre.split("."))
    return core + (0, ids)


def main():
    good, bad = [], 0
    for line in sys.stdin.read().split("\n"):
        line = line.rstrip("\r")
        if not line.strip():
            continue
        m = RX.fullmatch(line)
        if m is None:
            print(f"invalid version: {line!r}", file=sys.stderr)
            bad += 1
            continue
        good.append((key(m), line))
    good.sort(key=lambda kv: kv[0])  # stable
    for _, line in good:
        print(line)
    return 1 if bad else 0


sys.exit(main())
