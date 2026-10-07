"""
Shared statistics for the benchmark scoreboards (standard library only).
bench/harbor/compare.py imports this file by path, so keep it dependency-free.
"""

from __future__ import annotations

import math

Z95 = 1.959963984540054


def wilson(k: int, n: int, z: float = Z95) -> tuple[float, float] | None:
    """Wilson score interval for k successes in n trials; None when n == 0."""
    if n <= 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def rate(k: int, n: int) -> str:
    """'5/6 83% [44-97]' (or '0/0 -')."""
    if n == 0:
        return f"{k}/{n} -"
    lo, hi = wilson(k, n)
    return f"{k}/{n} {100 * k / n:.0f}% [{100 * lo:.0f}-{100 * hi:.0f}]"


def sign_test(b: int, c: int) -> float:
    """Exact two-sided sign test on b vs c discordant pairs (p = 1 with none)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def percentile(xs: list[float], q: float) -> float | None:
    """Nearest-rank percentile (q in 0..100); the median uses the usual midpoint."""
    v = sorted(x for x in xs if x is not None)
    if not v:
        return None
    if q == 50:
        m = len(v) // 2
        return v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2
    return v[max(0, math.ceil(q / 100 * len(v)) - 1)]


def is_verified(claim) -> bool:
    return isinstance(claim, str) and claim.startswith("verified")


def no_verdict(row: dict) -> bool:
    """No usable Maat verdict: claim missing, error, stopped, or the run timed out."""
    c = row.get("claim")
    return (not c) or c.startswith(("error", "stopped")) or bool(row.get("timed_out"))


TIERS = ("verified", "passed-checks")


def tier_breakdown(rows: list[dict]) -> dict[str, tuple[int, int]]:
    """{tier: (rows, rows that passed)} over rows that carry `tier` (job_end's field).

    Rows from builds before the tiers have no `tier` and are left out, so an old
    result file reports no breakdown rather than a wrong one. Precision of a
    tier is P(pass | tier): the word "verified" has to mean the same thing on
    every model, and this is how that is read off the results.
    """
    out: dict[str, tuple[int, int]] = {}
    for r in rows:
        t = r.get("tier")
        if not t:
            continue
        n, k = out.get(t, (0, 0))
        out[t] = (n + 1, k + (1 if r.get("passed") else 0))
    return out
