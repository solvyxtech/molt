#!/usr/bin/env python3
"""
Ship/no-ship scoreboard over benchmark results (JSONL from bench/local/run.py).

    python3 bench/local/scoreboard.py base=results-v8-base.jsonl ref=results-v8-ref.jsonl \\
        --target precision --min-gain 0.10

Each argument is LABEL=FILE (or FILE alone: labelled by its "arm" column if
rows have one, else by the file stem). Files sharing a label are pooled.
The first label is the baseline; every other arm is compared to it.

Per arm: pass rate, verified precision P(pass | verified), verified recall
P(verified | pass), false-done (verified but failed), no-verdict (claim
missing/error/stopped or timed out), checks-disagree-but-passed, median/p90
secs, median tokens_in; rates carry Wilson 95% intervals.

Paired (same task, rep): per-pair pass differences and an exact sign test on
discordant pairs. Ship rule: paired pass difference >= -1 task AND false-done
not higher AND the target metric improved by >= --min-gain.
Target gains: pass/precision/recall/verified in rate points (0.10 = 10 points);
secs/tokens as relative reduction (0.10 = 10% lower); no_verdict/false_done as
count reduction.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stats import TIERS, is_verified, no_verdict, percentile, rate, sign_test, tier_breakdown  # noqa: E402

LOW_POWER_N = 30  # pairs below this cannot separate a few-task difference from noise


def load(path: str | Path) -> list[dict]:
    rows = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if line.startswith("{"):
            rows.append(json.loads(line))
    return rows


def metrics(rows: list[dict]) -> dict:
    n = len(rows)
    passed = [r for r in rows if r.get("passed")]
    ver = [r for r in rows if is_verified(r.get("claim"))]
    ver_ok = [r for r in ver if r.get("passed")]
    secs = [r["secs"] for r in rows if r.get("secs") is not None]
    toks = [r["tokens_in"] for r in rows if r.get("tokens_in") is not None]
    return {
        "n": n,
        "pass": len(passed),
        "verified": len(ver),
        "verified_pass": len(ver_ok),
        "false_done": len(ver) - len(ver_ok),
        "no_verdict": sum(1 for r in rows if no_verdict(r)),
        "disagree_passed": sum(1 for r in passed if r.get("checks_disagree")),
        "tiers": tier_breakdown(rows),
        "secs_med": percentile(secs, 50),
        "secs_p90": percentile(secs, 90),
        "tokens_med": percentile(toks, 50),
    }


def fmt_num(v) -> str:
    return "-" if v is None else f"{v:.0f}"


def tier_lines(m: dict) -> list[str]:
    """Count and precision per tier, when the rows carry one (job_end `tier`)."""
    tiers = m.get("tiers") or {}
    if not tiers:
        return []
    out = ["  tiers               P(pass | tier)"]
    for t in [*TIERS, *sorted(set(tiers) - set(TIERS))]:
        if t in tiers:
            n, k = tiers[t]
            out.append(f"    {t:<15} n={n:<3} {rate(k, n)}")
    return out


def report_arm(label: str, m: dict) -> list[str]:
    return [
        f"== {label}  (n={m['n']})",
        f"  pass rate           {rate(m['pass'], m['n'])}",
        f"  verified precision  {rate(m['verified_pass'], m['verified'])}   P(pass | verified)",
        f"  verified recall     {rate(m['verified_pass'], m['pass'])}   P(verified | pass)",
        f"  false-done          {m['false_done']}",
        f"  no-verdict          {m['no_verdict']}",
        f"  checks-disagree but passed  {m['disagree_passed']}",
        f"  secs                median {fmt_num(m['secs_med'])}  p90 {fmt_num(m['secs_p90'])}",
        f"  tokens_in           median {fmt_num(m['tokens_med'])}",
        *tier_lines(m),
    ]


def pair_up(a: list[dict], b: list[dict]) -> list[tuple[dict, dict]]:
    key = lambda r: (r.get("task"), r.get("agent"), r.get("rep", 0))
    bi = {key(r): r for r in b}
    return [(r, bi[key(r)]) for r in a if key(r) in bi]


TARGETS = ("pass", "precision", "recall", "verified", "secs", "tokens", "no_verdict", "false_done")


def target_gain(target: str, ma: dict, mb: dict) -> float | None:
    """Improvement of B over A on the target metric (positive = better)."""
    div = lambda k, n: k / n if n else None
    if target in ("pass", "verified"):
        return div(mb[target], mb["n"]) - div(ma[target], ma["n"])
    if target in ("precision", "recall"):
        den = "verified" if target == "precision" else "pass"
        va, vb = div(ma["verified_pass"], ma[den]), div(mb["verified_pass"], mb[den])
        return None if va is None or vb is None else vb - va
    if target in ("secs", "tokens"):
        k = "secs_med" if target == "secs" else "tokens_med"
        if not ma[k] or mb[k] is None:
            return None
        return (ma[k] - mb[k]) / ma[k]
    return ma[target] - mb[target]  # no_verdict, false_done: fewer is better


def compare(la: str, lb: str, ra: list[dict], rb: list[dict], target: str, min_gain: float) -> tuple[list[str], str]:
    pairs = pair_up(ra, rb)
    out = [f"== paired: {la} (A) vs {lb} (B)"]
    n = len(pairs)
    if not n:
        return out + ["  no (task, rep) in both arms"], f"VERDICT {lb} vs {la}: NO VERDICT (no shared tasks)"
    only_a = [x for x, y in pairs if x.get("passed") and not y.get("passed")]
    only_b = [y for x, y in pairs if y.get("passed") and not x.get("passed")]
    ma, mb = metrics([x for x, _ in pairs]), metrics([y for _, y in pairs])
    diff = mb["pass"] - ma["pass"]
    p = sign_test(len(only_a), len(only_b))
    out += [
        f"  pairs {n}; A {ma['pass']} pass, B {mb['pass']} pass; B-A = {diff:+d}",
        f"  discordant: only A passed {len(only_a)}, only B passed {len(only_b)}; exact sign test p = {p:.3f}",
    ]
    if only_a:
        out.append("    only A: " + ", ".join(sorted(str(r.get("task")) for r in only_a)))
    if only_b:
        out.append("    only B: " + ", ".join(sorted(str(r.get("task")) for r in only_b)))
    gain = target_gain(target, ma, mb)
    ok_pass = diff >= -1
    ok_fd = mb["false_done"] <= ma["false_done"]
    ok_target = gain is not None and gain >= min_gain
    gs = "n/a" if gain is None else f"{gain:+.3f}"
    out.append(
        f"  rule: pass diff >= -1: {diff:+d} {'ok' if ok_pass else 'FAIL'}; "
        f"false-done B<=A: {mb['false_done']} vs {ma['false_done']} {'ok' if ok_fd else 'FAIL'}; "
        f"target {target} gain >= {min_gain}: {gs} {'ok' if ok_target else 'FAIL'}"
    )
    fails = [name for name, ok in (("pass drop", ok_pass), ("false-done up", ok_fd), ("target not improved", ok_target)) if not ok]
    line = f"VERDICT {lb} vs {la}: {'NO-SHIP' if fails else 'SHIP'}" + (f" ({', '.join(fails)})" if fails else "")
    if n < LOW_POWER_N:
        line += f"  [LOW POWER: {n} pairs < {LOW_POWER_N}; sign test p={p:.2f}; a decision rule, not evidence]"
    return out, line


def group(args: list[str]) -> dict[str, list[dict]]:
    arms: dict[str, list[dict]] = {}
    for a in args:
        label, sep, path = a.partition("=")
        if not sep or Path(a).exists():
            label, path = None, a
        for r in load(path):
            arms.setdefault(label or r.get("arm") or Path(path).stem, []).append(r)
    return arms


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", help="LABEL=FILE or FILE")
    ap.add_argument("--target", choices=TARGETS, default="precision", help="metric that must improve (default precision)")
    ap.add_argument("--min-gain", type=float, default=0.0, help="required improvement (units: see above)")
    ap.add_argument("--agent", help="only rows of this agent (e.g. molt)")
    a = ap.parse_args(argv)
    arms = group(a.files)
    if a.agent:
        arms = {k: [r for r in v if r.get("agent") == a.agent] for k, v in arms.items()}
    for label, rows in arms.items():
        print("\n".join(report_arm(label, metrics(rows))))
    labels = list(arms)
    verdicts = []
    for lb in labels[1:]:
        lines, v = compare(labels[0], lb, arms[labels[0]], arms[lb], a.target, a.min_gain)
        print("\n".join(lines))
        verdicts.append(v)
    print("\n".join(verdicts))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
