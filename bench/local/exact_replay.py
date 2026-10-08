"""The exact tag (src/tiers.ts assertsExact) replayed over 2026-10-07's recorded "verified" runs.

    python3 exact_replay.py [--base REF] [--show N] [LANE ...]

"Verified" now needs a passing independent check that compares the work's
output with an EXACT expected value; a run whose passing checks only test
properties (counts, sortedness, membership, types, two runs agreeing) gets
"passed-checks" with the reason "passed checks that test properties only".

Population: every <task>-molt-<rep>[-<arm>] tree under the lanes in
~/.cache/maat-bench/container-work last written on --day (default
2026-10-07), joined to its grader row. The grader row comes from the lane's
results file (named on the first line of ~/.cache/maat-bench/<lane>.log), or
its `.regraded.jsonl` twin when there is one: the regraded verdict wins.

For each run whose last journalled tier is "verified": the checks that could
have carried the word are the passing (`pass`, `pass-vacuous`) sealed checks
in the last accepted receipt that the value rule at --base tags value and
that the worker did not write. The run keeps "verified" under the new rule
when one of them is also tagged exact (the working tree's assertsExact). A
"verified-audit" run keeps it when one of its accepted audit checks is exact.

The rule ships only if it removes every grader-WRONG verified and keeps at
least two thirds of the grader-RIGHT ones. Two populations are reported:

  A. every recorded "verified" on the day, from any build;
  B. those the base rule (--base) still grants: a carrying check whose
     receipt names an independent author. Older builds labelled runs
     verified on checks with no recorded author, which the base rule already
     treats as the worker's; the exact rule cannot remove what is not there.

B is the gate: it is what the exact rule changes on the build it ships on.
As shipped (2026-10-07 lanes):

                          A right   A wrong   B right   B wrong
  recorded verified          113         8        79         2
  --literal-only kept     53 (47%)       0     48 (61%)       0
  shipped rule kept       61 (54%)       0     56 (71%)       0

The literal-only rule (equality with a literal, diff against literal text,
grep -x) failed the gate; the shipped rule adds two forms (containment of a
worked-out value in a program's output on literal input, and an oracle built
from the input files), and passes. In A, 11 right runs rest only on commands
that also carried a wrong run (the same `find -exec`, `|| echo fail` and
`print(len(header) == 5)` checks), so no command-level rule can keep them.
"""
from __future__ import annotations

import argparse
import datetime
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import value_replay as vr  # noqa: E402

PASS = ("pass", "pass-vacuous")
_recorded_results = vr.results_file


def results_file(lane: Path) -> Path | None:
    p = _recorded_results(lane)
    if p:
        g = p.with_name(p.name.replace(".jsonl", ".regraded.jsonl"))
        if g.exists():
            return g
    return p


def lanes_on(day: str, names: list[str]) -> list[Path]:
    out = []
    for p in vr.CW.iterdir():
        if not p.is_dir():
            continue
        if names and p.name not in names and not any(p.name.startswith(n + "-") for n in names):
            continue
        if datetime.date.fromtimestamp(p.stat().st_mtime).isoformat() == day:
            out.append(p)
    return sorted(out)


def tag(src: Path, fn: str, cmds: list[str], arg: str = "") -> dict[str, bool]:
    js = (
        f"import {{ {fn} }} from {json.dumps(str(src))};"
        f"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(r=>{fn}(r{arg})))));"
    )
    p = subprocess.run(["node", "--no-warnings", "--input-type=module", "-e", js], input=json.dumps(cmds), capture_output=True, text=True)
    if p.returncode:
        sys.exit(f"{fn} from {src} failed: {p.stderr[-600:]}")
    return dict(zip(cmds, json.loads(p.stdout)))


def worker_wrote(author: str | None) -> bool:
    return bool(author) and author.startswith("the worker model")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="origin/claude/value-classifier")
    ap.add_argument("--day", default="2026-10-07")
    ap.add_argument("--show", type=int, default=0, help="print the carrying checks of up to N kept and N removed right runs")
    ap.add_argument("--literal-only", action="store_true", help="the rule as first measured: no containment (form 5), no oracle (form 6)")
    ap.add_argument("lanes", nargs="*")
    a = ap.parse_args(argv)
    vr.results_file = results_file
    vr.lanes = lambda _prefixes: lanes_on(a.day, a.lanes)
    runs, checks = vr.collect([])
    by_run: dict[str, list[dict]] = defaultdict(list)
    for c in checks:
        by_run[c["run"]["id"]].append(c)
    old_src = vr.classifier(a.base)["old"]
    new_src = vr.REPO / "src/tiers.ts"
    cmds = sorted({c["cmd"] for c in checks})
    value = tag(old_src, "assertsValue", cmds)
    exact = tag(new_src, "assertsExact", cmds, ", { literalOnly: true }" if a.literal_only else "")

    rows = []
    for r in runs:
        if r["tier"] not in ("verified", "verified-audit"):
            continue
        cs = by_run[r["id"]]
        if r["tier"] == "verified":
            carry = [c for c in cs if c["source"] == "sealed" and c.get("result") in PASS and value[c["cmd"]] and not worker_wrote(c.get("author"))]
        else:
            carry = [c for c in cs if c["source"] == "audit" and c.get("accepted")]
        # Still verified at --base: a carrier whose independent author the receipt names (an unrecorded author is the worker's).
        base = r["tier"] == "verified-audit" or any(vr.independent(c.get("author")) for c in carry)
        keep = [c for c in carry if exact[c["cmd"]] and (base and (r["tier"] == "verified-audit" or vr.independent(c.get("author"))) or not base)]
        rows.append({"run": r, "carry": carry, "keep": keep, "base": base})

    print(f"runs with a grader row: {len(runs)}   recorded verified: {sum(x['run']['tier'] == 'verified' for x in rows)}"
          f"   verified-audit: {sum(x['run']['tier'] == 'verified-audit' for x in rows)}")
    print(f"distinct check commands: {len(cmds)}   value (base): {sum(value.values())}   exact (new): {sum(exact.values())}"
          f"   exact but not value (never counted): {sum(exact[c] and not value[c] for c in cmds)}")

    # A command-level rule cannot tell two runs apart that rest on the same commands: a right run whose
    # carriers all also carried a WRONG run is removed by any rule that removes every wrong one.
    wrong_cmds = {c["cmd"] for x in rows if not x["run"]["passed"] for c in x["carry"]}
    for x in rows:
        x["forced"] = x["run"]["passed"] and all(c["cmd"] in wrong_cmds for c in x["carry"])

    verdict = {}
    for scope, sel in (("A. every recorded verified (any build)", lambda x: True),
                       ("B. those --base still grants (an independent author on the receipt)", lambda x: x["base"])):
        xs = [x for x in rows if sel(x)]
        right = [x for x in xs if x["run"]["passed"]]
        wrong = [x for x in xs if not x["run"]["passed"]]
        kept_right = sum(bool(x["keep"]) for x in right)
        kept_wrong = sum(bool(x["keep"]) for x in wrong)
        forced = sum(x["forced"] for x in right)
        print(f"\n== {scope}")
        print(f"   {'':16} {'total':>6} {'kept':>6} {'removed':>8}")
        print(f"   {'grader-right':16} {len(right):6} {kept_right:6} {len(right) - kept_right:8}")
        print(f"   {'grader-wrong':16} {len(wrong):6} {kept_wrong:6} {len(wrong) - kept_wrong:8}")
        kept_all = kept_right + kept_wrong
        print(f"   precision of 'verified': {len(right)}/{len(xs)} = {len(right) / max(1, len(xs)):.1%} recorded -> "
              f"{kept_right}/{kept_all} = {kept_right / max(1, kept_all):.1%} under the exact rule")
        print(f"   right runs whose every carrying command also carried a wrong run (no command rule can keep them): {forced}")
        ok = kept_wrong == 0 and 3 * kept_right >= 2 * len(right)
        print(f"   gate: wrong removed {len(wrong) - kept_wrong}/{len(wrong)}, right kept {kept_right}/{len(right)}"
              f" ({kept_right / max(1, len(right)):.0%}, need >= 67%) -> {'PASS' if ok else 'FAIL'}")
        verdict[scope[0]] = ok
    ok = verdict["B"]
    right = [x for x in rows if x["run"]["passed"]]
    wrong = [x for x in rows if not x["run"]["passed"]]

    print("\n-- grader-wrong verifieds")
    for x in wrong:
        print(f"   {'KEPT   ' if x['keep'] else 'removed'} {x['run']['id']}{'' if x['base'] else '  (not granted at --base)'}")
        for c in x["keep"] or x["carry"]:
            print(f"      [{'exact' if exact[c['cmd']] else 'property'}] {c['cmd'][:200]!r}")
    print("\n-- grader-right verifieds removed")
    for x in right:
        if x["keep"]:
            continue
        print(f"   removed {x['run']['id']}{'' if x['base'] else '  (not granted at --base)'}{'  (forced)' if x['forced'] else ''}")
        for c in x["carry"][: max(a.show, 2)]:
            print(f"      [property] {c['cmd'][:200]!r}")
    if a.show:
        print("\n-- grader-right verifieds kept (the exact check that carries each)")
        for x in right:
            if x["keep"]:
                print(f"   kept {x['run']['id']}: {x['keep'][0]['cmd'][:200]!r}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
