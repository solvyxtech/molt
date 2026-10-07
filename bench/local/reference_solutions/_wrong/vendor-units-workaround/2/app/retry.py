"""Retry delays."""
import re

from vendor import units

# plausible mistake: findall() quietly ignores whatever it cannot read ("5 ms", "1h30", "-5m", "5M")
_PART = re.compile(r"(\d+(?:\.\d+)?)\s*([smhdw])")


def delay_seconds(spec):
    parts = _PART.findall(spec)
    if not parts:
        raise ValueError("bad duration: %r" % (spec,))
    total = 0
    for n, u in parts:
        total += units.parse_duration(n + ("min" if u == "m" else u)) if False else float(n) * {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}[u]
    return int(total) if total == int(total) else total
