"""Check-quality replay, step 5: what positive evidence separates right from wrong
once buggy checks are retired; the review gate; the drafting budget.

    python3 checkquality_tiers.py SCRATCH_DIR
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

S = Path(sys.argv[1])
R = json.load(open(S / "cq-runs.json"))
C = json.load(open(S / "cq-checks-final.json"))
LANES = ["v10-old", "v10-fix", "v11-old", "v11-new", "v12-old", "v12-new"]
NOISY = {"L14-number", "L10-path"}
by_run = defaultdict(list)
for x in C:
    by_run[x["id"]].append(x)


def rule(f):
    return f.split(":")[0]


def clean(x):
    return not any(rule(f) not in NOISY for f in x["flags"])


def own(x):
    return x["own"] if x["own"] is not None else x["ok"]


def keep_f8(x):
    return clean(x) and x["pristine"] is not True and not (x["oc_n"] - x["oc_pass"] >= 2)


def keep_f3p(x):  # product-implementable today: lint + pristine (no cross-tree)
    return clean(x) and x["pristine"] is not True


def keep_f0(x):
    return True


def discriminating(x):  # oracle feature: fails on >=50% of the OTHER wrong trees (not available to the product)
    return x["ow_n"] >= 3 and (x["ow_n"] - x["ow_pass"]) * 2 >= x["ow_n"]


def strongest(live_pass):
    if any("value" in x["tags"] and "surface" not in x["tags"] for x in live_pass):
        return "runs+value"
    if any("surface" not in x["tags"] for x in live_pass):
        return "runs"
    return "surface"


def run_table(title, keep, lanes):
    print(f"\n## {title}")
    print("evidence of strongest passing live check | lane | accepted correct | accepted WRONG | precision")
    for lane in lanes:
        rows = defaultdict(lambda: [0, 0])
        for r in R:
            if lane != "ALL" and not r["lane"].startswith(lane):
                continue
            xs = [x for x in by_run.get(r["id"], []) if keep(x)]
            if not xs or any(own(x) is False for x in xs):
                continue
            ev = strongest(xs)
            rows[ev][0 if r["passed"] else 1] += 1
            # extra: value AND failed on pristine AND (oracle) discriminating
            if any("value" in x["tags"] and "surface" not in x["tags"] and x["pristine"] is False for x in xs):
                rows["runs+value & failed-on-pristine"][0 if r["passed"] else 1] += 1
            if any(discriminating(x) for x in xs):
                rows["ORACLE: >=1 check that fails most wrong trees"][0 if r["passed"] else 1] += 1
            if any(discriminating(x) and "value" in x["tags"] for x in xs):
                rows["ORACLE: discriminating & value"][0 if r["passed"] else 1] += 1
        for ev in ["runs+value", "runs", "surface", "runs+value & failed-on-pristine", "ORACLE: >=1 check that fails most wrong trees", "ORACLE: discriminating & value"]:
            c, w = rows[ev]
            print(f"  {ev:46} | {lane:8} | {c:3} | {w:3} | {c/(c+w) if c+w else float('nan'):.2f}")


run_table("F0 current bar (no retirement): precision by evidence tier of accepted runs", keep_f0, ["v12-new", "v12", "ALL"])
run_table("F3+pristine (lint at seal + pristine-pass advisory; implementable today)", keep_f3p, ["v12-new", "v12", "ALL"])
run_table("F8 (lint + pristine + cross-tree>=2, needs a second independent work)", keep_f8, ["v12-new", "v12", "ALL"])

print("\n## checks that PASS on their own tree: does the 'value' tag or pristine-failure separate correct from wrong work? (per check)")
for name, pred in (("value tag", lambda x: "value" in x["tags"]), ("failed on pristine", lambda x: x["pristine"] is False), ("value & failed on pristine", lambda x: "value" in x["tags"] and x["pristine"] is False),
                   ("ORACLE discriminating", discriminating), ("value & ORACLE discriminating", lambda x: "value" in x["tags"] and discriminating(x))):
    pc = [x for x in C if x["passed"] and own(x)]
    pw = [x for x in C if not x["passed"] and own(x)]
    print(f"  {name:30} pass-on-correct {sum(map(pred, pc))}/{len(pc)}   pass-on-wrong {sum(map(pred, pw))}/{len(pw)}")

print("\n## the review gate, runs whose final bar passed and that were reviewed (recorded): votes x grader")
c = Counter()
for r in R:
    if r["proofs"] and r["proofs"][-1]["ok"] and r["review"]:
        c[(r["review"]["votes"], r["passed"])] += 1
for v in ["0/3", "1/3", "2/3", "3/3"]:
    print(f"  {v}: correct {c[(v, True)]}  wrong {c[(v, False)]}  precision-if-accepted {c[(v, True)]/(c[(v, True)]+c[(v, False)]) if c[(v, True)]+c[(v, False)] else float('nan'):.2f}")
print(f"  gate '0/3 only' keeps {c[('0/3', True)]} correct of {sum(v for (k, p), v in c.items() if p)}, blocks {c[('0/3', False)]} wrong of {sum(v for (k, p), v in c.items() if not p)}")

print("\n## drafting budget: sealed checks vs the 54 s cut (all six lanes)")
for lane in LANES:
    rs = [r for r in R if r["lane"] == lane]
    cut = [r for r in rs if r["cut"]]
    nocut = [r for r in rs if not r["cut"]]
    def mean_sealed(xs):
        v = [r["sealed_n"] or 0 for r in xs]
        return sum(v) / len(v) if v else 0
    def barpass(xs):
        c = [r for r in xs if r["passed"]]
        return f"{sum(1 for r in c if r['proofs'] and r['proofs'][-1]['ok'])}/{len(c)}"
    print(f"  {lane:8} cut fired {len(cut):2}/{len(rs)}  mean sealed: cut {mean_sealed(cut):.1f} vs no-cut {mean_sealed(nocut):.1f}   correct runs bar-passed: cut {barpass(cut)} no-cut {barpass(nocut)}   seal_s>=54 {sum(1 for r in rs if (r['seal_s'] or 0) >= 53.5)}")
print("\n  v12-new 'none-ready' runs (0 checks at the cut):")
for r in R:
    if r["lane"] == "v12-new" and r["cut"] == "none-ready":
        print(f"    {r['id']:26} grader={'pass' if r['passed'] else 'FAIL'} late-joined {r['late_join']} claim={r['claim']} seal_s={r['seal_s']}")
print("\n  correct runs by number of sealed checks (all lanes): bar-pass rate")
by = defaultdict(lambda: [0, 0])
for r in R:
    if r["passed"]:
        n = r["sealed_n"] if r["sealed_n"] is not None else 0
        by[min(n, 4)][1] += 1
        by[min(n, 4)][0] += bool(r["proofs"] and r["proofs"][-1]["ok"])
for n in sorted(by):
    print(f"    sealed {n}: bar-passed {by[n][0]}/{by[n][1]}")
