"""Retry delays."""
import re

# The vendored vendor.units reads "m" as a month, so it is not used for durations any more.
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
_PART = re.compile(r"(\d+(?:\.\d+)?)\s*([smhdw])")


def delay_seconds(spec):
    """Seconds to wait for a duration spec such as '90s', '5m' or '1h30m'."""
    text = spec.strip()
    pos, total, seen = 0, 0, False
    while pos < len(text):
        m = _PART.match(text, pos)
        if not m:
            raise ValueError("bad duration: %r" % (spec,))
        seen = True
        n, unit = m.group(1), m.group(2)
        if "." in n:
            whole, frac = n.split(".")
            total += int(whole) * _UNIT_SECONDS[unit] + int(frac) * _UNIT_SECONDS[unit] / 10 ** len(frac)
        else:
            total += int(n) * _UNIT_SECONDS[unit]
        pos = m.end()
        while pos < len(text) and text[pos] == " ":
            pos += 1
    if not seen:
        raise ValueError("bad duration: %r" % (spec,))
    return int(total) if float(total).is_integer() else float(total)
