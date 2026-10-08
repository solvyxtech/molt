"""Check-quality replay, step 4: run-level recall/precision under candidate filters.

Inputs (scratchpad): cq-runs.json, cq-checks-lint.json, cq-taxonomy.json,
replay.cmds.json, replay.out.jsonl (container replay of every unique check on
pristine, reference and every saved tree of its task).

Verdict model (bar level): a run is ACCEPTED when at least one live drafted
check remains and every live one passes on the run's own tree. "live" is what
the filter under test leaves. positive = accepted; precision = accepted runs
that the grader passed / accepted; recall = accepted correct / correct.

    python3 checkquality_analysis.py SCRATCH_DIR
"""
from __future__ import annotations

import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

S = Path(sys.argv[1])
R = json.load(open(S / "cq-runs.json"))
C = json.load(open(S / "cq-checks-lint.json"))
TX = {(x["id"], x["name"]): x["cls"] for x in json.load(open(S / "cq-taxonomy.json"))}
CMDS = json.load(open(S / "replay.cmds.json"))
RUNS_BY_ID = {r["id"]: r for r in R}
LANES = ["v10-old", "v10-fix", "v11-old", "v11-new", "v12-old", "v12-new"]
NOISY = {"L14-number", "L10-path"}  # measured but excluded from the clean lint set


def rule(f: str) -> str:
    return f.split(":")[0]


# ---------------------------------------------------------------- replay results
res: dict[tuple[str, str], dict] = {}
for line in open(S / "replay.out.jsonl"):
    j = json.loads(line)
    res[(j["id"], j["tree"])] = j
cmd_id = {(v["task"], v["cmd"]): k for k, v in CMDS.items()}


def rep(task: str, cmd: str, tree: str) -> dict | None:
    return res.get((cmd_id[(task, cmd)], tree))


def ok(j: dict | None) -> bool | None:
    if j is None:
        return None
    return j["exit"] == 0 and not j["timedOut"]


# ---------------------------------------------------------------- per-check features
labels = {r["id"]: r["passed"] for r in R}
by_task_runs: dict[str, list[str]] = defaultdict(list)
for r in R:
    by_task_runs[r["task"]].append(r["id"])

agree = Counter()
for x in C:
    j = rep(x["task"], x["cmd"], x["id"])
    x["own"] = ok(j)
    x["pristine"] = ok(rep(x["task"], x["cmd"], "pristine"))
    x["ref"] = ok(rep(x["task"], x["cmd"], "ref"))
    oc = [ok(rep(x["task"], x["cmd"], rid)) for rid in by_task_runs[x["task"]] if rid != x["id"] and labels[rid]]
    ow = [ok(rep(x["task"], x["cmd"], rid)) for rid in by_task_runs[x["task"]] if rid != x["id"] and not labels[rid]]
    oc = [v for v in oc if v is not None]
    ow = [v for v in ow if v is not None]
    x["oc_pass"], x["oc_n"] = sum(oc), len(oc)
    x["ow_pass"], x["ow_n"] = sum(ow), len(ow)
    if x["own"] is not None and x["ok"] is not None:
        agree[(x["ok"], x["own"])] += 1

print("## replay calibration: recorded final result vs container replay on the same tree")
tot = sum(agree.values())
print(f"agree pass/pass {agree[(True, True)]}, fail/fail {agree[(False, False)]}, recorded-pass/replay-fail {agree[(True, False)]}, recorded-fail/replay-pass {agree[(False, True)]}  (agreement {100*(agree[(True,True)]+agree[(False,False)])/tot:.1f}% of {tot})")
dis = [x for x in C if x["own"] is not None and x["ok"] is not None and x["own"] != x["ok"]]
dc = Counter((x["task"], x["ok"], x["own"]) for x in dis)
print("disagreements by task (recorded, replay):", dict(dc))

# ---------------------------------------------------------------- feature tables
rc = [x for x in C if x["passed"] and x["ok"] is False]
cw = [x for x in C if not x["passed"] and x["ok"] is False]
pc = [x for x in C if x["passed"] and x["ok"]]
pw = [x for x in C if not x["passed"] and x["ok"]]


def share(xs, pred):
    n = sum(1 for x in xs if pred(x))
    return f"{n}/{len(xs)} ({100*n/len(xs):.0f}%)" if xs else "0/0"


print("\n## per-check features by group (final bar on own tree x grader)")
print("group            | fails on REF | passes on PRISTINE | fails >=1 other correct tree | fails >=2 | fails >=50% | passes >=80% of other WRONG trees | lint(clean) | lint(any)")
for name, xs in (("refused-correct", rc), ("caught-wrong", cw), ("pass-on-correct", pc), ("pass-on-wrong", pw)):
    print(f"{name:16} | {share(xs, lambda x: x['ref'] is False):14} | {share(xs, lambda x: x['pristine'] is True):18} | "
          f"{share(xs, lambda x: x['oc_n'] and x['oc_pass'] < x['oc_n']):28} | {share(xs, lambda x: x['oc_n'] - x['oc_pass'] >= 2):9} | "
          f"{share(xs, lambda x: x['oc_n'] and (x['oc_n'] - x['oc_pass']) * 2 >= x['oc_n']):11} | "
          f"{share(xs, lambda x: x['ow_n'] and x['ow_pass'] * 5 >= x['ow_n'] * 4):33} | "
          f"{share(xs, lambda x: any(rule(f) not in NOISY for f in x['flags'])):11} | {share(xs, lambda x: bool(x['flags']))}")

print("\nrefused-correct by taxonomy class: fails on ref / fails >=2 other correct / lint(clean)")
byc = defaultdict(list)
for x in rc:
    byc[TX[(x["id"], x["name"])]].append(x)
for k, xs in sorted(byc.items(), key=lambda kv: -len(kv[1])):
    print(f"  {k}: n={len(xs)} ref-fail {sum(1 for x in xs if x['ref'] is False)}  cross>=2 {sum(1 for x in xs if x['oc_n']-x['oc_pass']>=2)}  lint {sum(1 for x in xs if any(rule(f) not in NOISY for f in x['flags']))}  union {sum(1 for x in xs if x['ref'] is False or x['oc_n']-x['oc_pass']>=2 or any(rule(f) not in NOISY for f in x['flags']))}")


# ---------------------------------------------------------------- run-level filters
def live_filter(name: str):
    def f(x: dict) -> bool:  # True = keep the check
        clean = not any(rule(fl) not in NOISY for fl in x["flags"])
        anylint = not x["flags"]
        if name == "F0 current":
            return True
        if name == "F1 ref-filter":
            return x["ref"] is not False
        if name == "F2 pristine-pass advisory":
            return x["pristine"] is not True
        if name == "F3 lint clean":
            return clean
        if name == "F3b lint all rules":
            return anylint
        if name == "F4 cross>=2 (LOO)":
            return not (x["oc_n"] - x["oc_pass"] >= 2)
        if name == "F4b cross>=1 (LOO)":
            return not (x["oc_n"] and x["oc_pass"] < x["oc_n"])
        if name == "F4c cross>=50% (LOO)":
            return not (x["oc_n"] and (x["oc_n"] - x["oc_pass"]) * 2 >= x["oc_n"])
        if name == "F5 lint clean + pristine":
            return clean and x["pristine"] is not True
        if name == "F6 lint clean + cross>=2":
            return clean and not (x["oc_n"] - x["oc_pass"] >= 2)
        if name == "F7 lint clean + ref":
            return clean and x["ref"] is not False
        if name == "F8 lint+pristine+cross>=2":
            return clean and x["pristine"] is not True and not (x["oc_n"] - x["oc_pass"] >= 2)
        if name == "F9 ref + pristine":
            return x["ref"] is not False and x["pristine"] is not True
        raise KeyError(name)
    return f


checks_by_run: dict[str, list[dict]] = defaultdict(list)
for x in C:
    checks_by_run[x["id"]].append(x)


def verdict(xs: list[dict], keep, tolerate: int = 0, use_replay: bool = True) -> bool | None:
    live = [x for x in xs if keep(x)]
    if not live:
        return None
    fails = 0
    for x in live:
        v = x["own"] if (use_replay and x["own"] is not None) else x["ok"]
        if v is False:
            fails += 1
    if tolerate and len(live) >= 3 and fails <= tolerate:
        return True
    return fails == 0


def wilson(k: int, n: int) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    z = 1.96
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0, c - h), min(1, c + h))


def table(title: str, filters: list[str], tolerate: int = 0, use_replay: bool = True) -> None:
    print(f"\n## {title}")
    print("filter                        | lane     | correct | accepted-correct (recall) | accepted-WRONG | precision | no live check (correct runs) ")
    for name in filters:
        keep = live_filter(name)
        for lane in LANES + ["v12 both", "v10+v11", "ALL"]:
            rs = [r for r in R if (r["lane"] == lane if lane in LANES else r["lane"].startswith("v12") if lane == "v12 both" else not r["lane"].startswith("v12") if lane == "v10+v11" else True)]
            corr = [r for r in rs if r["passed"]]
            acc_c = acc_w = none_c = 0
            for r in rs:
                v = verdict(checks_by_run.get(r["id"], []), keep, tolerate, use_replay)
                if v is None and r["passed"]:
                    none_c += 1
                if v:
                    if r["passed"]:
                        acc_c += 1
                    else:
                        acc_w += 1
            prec = acc_c / (acc_c + acc_w) if acc_c + acc_w else float("nan")
            lo, hi = wilson(acc_c, len(corr))
            if lane in ("v12-new", "v12 both", "v10+v11", "ALL"):
                print(f"{name:29} | {lane:8} | {len(corr):7} | {acc_c:3} ({100*acc_c/len(corr):.0f}%, CI {100*lo:.0f}-{100*hi:.0f}) | {acc_w:3} | {prec:.2f} | {none_c}")


ALL_F = ["F0 current", "F1 ref-filter", "F2 pristine-pass advisory", "F3 lint clean", "F3b lint all rules", "F4 cross>=2 (LOO)", "F4b cross>=1 (LOO)", "F4c cross>=50% (LOO)",
         "F5 lint clean + pristine", "F6 lint clean + cross>=2", "F7 lint clean + ref", "F8 lint+pristine+cross>=2", "F9 ref + pristine"]
table("bar-level verdict with each filter (replayed results on own tree; all live must pass)", ALL_F)
table("same, tolerating 1 failing check when >=3 live", ["F0 current", "F3 lint clean", "F6 lint clean + cross>=2", "F8 lint+pristine+cross>=2"], tolerate=1)
table("same as the first table but on RECORDED results (no replay), sanity", ["F0 current", "F3 lint clean"], use_replay=False)

# which wrong runs are accepted under F8, and why
print("\n## wrong runs accepted under F8 (false verifieds the filters would leave), v12 lanes")
keep = live_filter("F8 lint+pristine+cross>=2")
for r in R:
    if r["lane"].startswith("v12") and not r["passed"] and verdict(checks_by_run.get(r["id"], []), keep):
        live = [x for x in checks_by_run[r["id"]] if keep(x)]
        print(f"  {r['id']:28} why={r['why'][:60]!r} live={[ (x['name'].replace('task:',''), x['tags']) for x in live]}")
print("\n## correct runs still refused under F8, v12-new, with the refusing check's class")
for r in R:
    if r["lane"] == "v12-new" and r["passed"]:
        xs = checks_by_run.get(r["id"], [])
        v = verdict(xs, keep)
        if v is False:
            bad = [(x["name"].replace("task:", ""), TX.get((x["id"], x["name"]), "?"), x["cmd"][:70]) for x in xs if keep(x) and (x["own"] if x["own"] is not None else x["ok"]) is False]
            print(f"  {r['id']:28} {bad}")
        elif v is None:
            print(f"  {r['id']:28} no live check (sealed {r['sealed_n']}, cut {r['cut']}, checks {len(xs)})")
json.dump(C, open(S / "cq-checks-final.json", "w"))
