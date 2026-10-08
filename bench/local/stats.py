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


TIERS = ("verified", "passed-checks", "passed-own-checks", "passed-untested")


def claim_basis(claim) -> str | None:
    """
    Who stood behind a claim, read from run.py's `claim` text, old or new.

      "verified (independent checks: m)"            -> "independent"
      "verified (your checks)"                      -> "person"
      "passed own checks (m), not verified"         -> "own"
      "passed checks that did not test this work, not verified" -> "untested"
      "verified (self-checked)"  (builds before 2026-10-07: the checks were
                                  drafted, by the worker or a judge; the
                                  text cannot say which)  -> "self-checked"
      "verified"                 (old: no drafted-only flag; authorship
                                  was never recorded)  -> "unrecorded"
      anything else                                  -> None
    """
    if not isinstance(claim, str):
        return None
    if claim.startswith("verified (independent checks"):
        return "independent"
    if claim.startswith("verified (your checks)"):
        return "person"
    if claim.startswith("passed own checks"):
        return "own"
    if claim.startswith("passed checks that did not test this work"):
        return "untested"
    if claim.startswith("verified (self-checked)"):
        return "self-checked"
    if claim.startswith("verified"):
        return "unrecorded"
    return None


def claim_judge(claim) -> list[str]:
    """The judge model(s) named by "verified (independent checks: a, b)"; [] otherwise."""
    if not isinstance(claim, str) or not claim.startswith("verified (independent checks:"):
        return []
    inner = claim[len("verified (independent checks:"):].rsplit(")", 1)[0]
    return [m.strip() for m in inner.split(",") if m.strip()]


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


# ---------------------------------------------------------------- the task as the unit of analysis
#
# Repeats of one task are correlated (same prompt, same grader, often the same mistake), so treating
# every (task, rep) row as an independent trial overstates confidence: Wilson intervals and sign
# tests over rows are too narrow. The functions below average the repeats within each task first and
# then resample or permute over TASKS. Rows a grader could not judge (grader_error) and runs the
# provider stalled (providerStall) are neither a pass nor a fail and are left out; count them with
# excluded().

def excluded(row: dict) -> str | None:
    """Why a row is not a pass/fail observation: "grader_error", "stall", or None (it counts)."""
    if row.get("grader_error"):
        return "grader_error"
    if row.get("providerStall"):
        return "stall"
    return None


def per_task(rows: list[dict]) -> dict[str, tuple[int, int]]:
    """{task: (passes, runs)} over the rows that count."""
    out: dict[str, tuple[int, int]] = {}
    for r in rows:
        if excluded(r):
            continue
        k, n = out.get(r.get("task"), (0, 0))
        out[r.get("task")] = (k + (1 if r.get("passed") else 0), n + 1)
    return out


def _bootstrap_mean(xs: list[float], b: int, seed: int) -> tuple[float, float] | None:
    import random
    if not xs:
        return None
    rnd = random.Random(seed)
    n = len(xs)
    means = sorted(sum(xs[rnd.randrange(n)] for _ in range(n)) / n for _ in range(b))
    return means[int(0.025 * b)], means[min(b - 1, int(0.975 * b))]


def task_rate(rows: list[dict], b: int = 2000, seed: int = 0) -> dict | None:
    """
    Mean over tasks of each task's pass fraction, with a 95% percentile-bootstrap interval that
    resamples tasks (not rows). None with no countable rows.
    """
    pt = per_task(rows)
    if not pt:
        return None
    fr = [k / n for k, n in pt.values()]
    lo, hi = _bootstrap_mean(fr, b, seed)
    return {"tasks": len(fr), "mean": sum(fr) / len(fr), "lo": lo, "hi": hi}


def sign_flip_p(diffs: list[float], b: int = 20000, seed: int = 0) -> float:
    """Two-sided paired permutation (sign-flip) test of mean(diffs) == 0; exact up to 16 nonzero
    differences, Monte Carlo (seeded) above."""
    import itertools
    import random
    d = [x for x in diffs if x != 0]
    if not d:
        return 1.0
    obs = abs(sum(d))
    eps = 1e-12
    if len(d) <= 16:
        hits = sum(1 for s in itertools.product((1, -1), repeat=len(d)) if abs(sum(x * y for x, y in zip(d, s))) >= obs - eps)
        return hits / 2 ** len(d)
    rnd = random.Random(seed)
    hits = sum(1 for _ in range(b) if abs(sum(x if rnd.random() < 0.5 else -x for x in d)) >= obs - eps)
    return (hits + 1) / (b + 1)


def paired_tasks(a: list[dict], b: list[dict], boot: int = 2000, seed: int = 0) -> dict | None:
    """
    A/B on the tasks both sides ran: per task, B's pass fraction minus A's. The mean difference
    with a bootstrap 95% interval over tasks, a sign test on the tasks that moved, and a sign-flip
    permutation p on the differences. None when no task is shared.
    """
    pa, pb = per_task(a), per_task(b)
    shared = sorted(set(pa) & set(pb), key=str)
    if not shared:
        return None
    diffs = [pb[t][0] / pb[t][1] - pa[t][0] / pa[t][1] for t in shared]
    lo, hi = _bootstrap_mean(diffs, boot, seed)
    up = sum(1 for x in diffs if x > 0)
    down = sum(1 for x in diffs if x < 0)
    return {"tasks": len(shared), "mean_diff": sum(diffs) / len(diffs), "lo": lo, "hi": hi,
            "b_better": up, "a_better": down, "sign_p": sign_test(up, down), "perm_p": sign_flip_p(diffs, seed=seed),
            "diffs": dict(zip(shared, diffs))}
