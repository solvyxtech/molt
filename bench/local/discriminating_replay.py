"""Replay the "verified" tier with and without the discrimination rule.

    python3 discriminating_replay.py [LANE_PREFIX ...]      (default: 2026-10-07's lanes)

The rule (src/tiers.ts tierOf, `failedBefore`): "verified" needs a passing
independent runs+value check that FAILED on the tree before the work. One that
passed then too (receipt: `pass-vacuous`), was broken then ("sealed criteria
that did not run when tried before the work"), or joined after the work began
(late drafts, the reference check) with no pre-work try does not count.

Reads, offline, for every <task>-molt-<rep>-<arm> tree under
~/.cache/maat-bench/container-work/<lane>/: the session journal (.maat/log), the
last accepted full receipt, and the lane's grader row in container-results. No
model, no network. "Value" is src/tiers.ts assertsValue on the released
command, through the built dist/tiers.js; the critic's `surface` tag is not
journalled, so a value check the critic marked surface still counts here
(this can only overstate what the rule keeps).

Baselines:
  recorded  the run's own claim started with "verified" (what the build said)
  pr32      recorded, and an independent check stood behind it: the claim names
            independent checks, or (builds before 2026-10-07) the arm is not
            `self`, i.e. a separate judge drafted the checks
The rule is applied on top of pr32.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

CACHE = Path.home() / ".cache/maat-bench"
CW = CACHE / "container-work"
RESULTS = CACHE / "container-results"
REPO = Path(__file__).resolve().parents[2]
TODAY = ["q235", "mm3", "ml4b", "hk55", "dsv4", "gh", "ga3b", "gx"]
RUN_DIR = re.compile(r"^(?P<task>.+)-molt-(?P<rep>\d+)-(?P<arm>[a-z0-9]+)$")
RESULTS_LINE = re.compile(r"container-results/(results-[\w.-]+\.jsonl)")


def results_file(lane: Path) -> Path | None:
    log = CACHE / f"{lane.name}.log"
    if log.exists():
        m = RESULTS_LINE.search(log.read_text(errors="replace")[:4000])
        if m and (RESULTS / m.group(1)).exists():
            return RESULTS / m.group(1)
    return None


def grader_rows(path: Path) -> dict[tuple[str, str, int], dict]:
    rows: dict[tuple[str, str, int], dict] = {}
    for line in path.read_text().splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("agent") == "molt":
            rows[(r["task"], r["arm"], int(r["rep"]))] = r  # the last row for a trial wins
    return rows


def journal(tree: Path) -> list[dict]:
    out: list[dict] = []
    for f in sorted((tree / ".maat/log").glob("*.jsonl")):
        for line in f.read_text(errors="replace").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def task(n: str) -> str:
    return n if n.startswith("task:") else f"task:{n}"


def receipt_results(tree: Path) -> dict[str, str]:
    """{check: result} from the last accepted full receipt: pass, pass-vacuous, fail, ..."""
    # Builds that withhold hidden checks keep the full text under full/; older ones have only the one file.
    full = sorted((tree / ".maat/receipts/full").glob("*-accepted.md")) or sorted((tree / ".maat/receipts").glob("*-accepted.md"))
    if not full:
        return {}
    out: dict[str, str] = {}
    name = None
    for line in full[-1].read_text(errors="replace").splitlines():
        if line.startswith("check: "):
            name = line[len("check: "):].strip()
        elif line.startswith("result: ") and name:
            out[name] = line[len("result: "):].strip()
            name = None
    return out


def asserts_value(runs: list[str]) -> list[bool]:
    js = (
        f"import {{ assertsValue }} from {json.dumps(str(REPO / 'dist/tiers.js'))};"
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(assertsValue))));"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", js], input=json.dumps(runs), capture_output=True, text=True, check=True)
    return json.loads(p.stdout)


def analyse(tree: Path, row: dict) -> dict:
    ev = journal(tree)
    notes = [e["data"] for e in ev if e.get("kind") == "note"]
    upfront: set[str] = set()
    late: set[str] = set()
    broken: set[str] = set()
    runs: dict[str, str] = {}
    pre_failed: set[str] | None = None
    for e in ev:  # builds before hidden checks were withheld journalled the command with each run
        if e.get("kind") == "bar_run":
            for c in e["data"].get("checks", []):
                if c.get("name", "").startswith("task:") and not str(c.get("detail", "")).startswith("[withheld"):
                    runs.setdefault(c["name"], c.get("detail", ""))
    for d in notes:
        text = d.get("text", "")
        if text.startswith("task criteria sealed"):
            upfront |= {task(c) for c in d.get("checks", [])}
        elif d.get("kind") == "late-checks" and d.get("arrived") and "joined" in text and "NOT joined" not in text:
            late |= {task(c) for c in d.get("checks", [])}
        elif text.startswith("reference check joined"):
            late.add("task:reference")
        elif text.startswith("sealed criteria that did not run"):
            broken |= {task(c) for c in d.get("checks", [])}
        elif d.get("kind") == "checks-released":
            for c in d.get("checks", []):
                runs[task(c["name"])] = c.get("run", "")  # the released command outranks a journalled detail
        elif d.get("kind") == "pre-work-try":  # builds with the rule journal it directly
            pre_failed = (pre_failed or set()) | set(d.get("failed", []))
    late -= upfront
    res = receipt_results(tree)
    passing = [n for n, r in res.items() if n.startswith("task:") and r in ("pass", "pass-vacuous")]
    values = dict(zip(passing, asserts_value([runs.get(n, "") for n in passing]))) if passing else {}
    strong = [n for n in passing if values.get(n)]
    status = {}
    for n in strong:
        if pre_failed is not None:
            status[n] = "failed" if n in pre_failed else ("passed" if res[n] == "pass-vacuous" else "untried")
        elif res[n] == "pass-vacuous":
            status[n] = "passed"
        elif n in broken:
            status[n] = "untried"
        elif n in late:
            status[n] = "late"
        elif n in upfront:
            status[n] = "failed"
        else:
            status[n] = "untried"
    return {"strong": strong, "status": status}


def main(argv: list[str]) -> int:
    prefixes = argv or TODAY
    lanes = sorted(p for p in CW.iterdir() if p.is_dir() and any(re.fullmatch(rf"{re.escape(x)}-\d+", p.name) for x in prefixes))
    tally: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    lost_right: list[str] = []
    removed_wrong: list[str] = []
    kept_wrong: list[str] = []
    late_only: list[str] = []
    for lane in lanes:
        rf = results_file(lane)
        if not rf:
            print(f"# {lane.name}: no results file found, skipped", file=sys.stderr)
            continue
        rows = grader_rows(rf)
        for tree in sorted(lane.iterdir()):
            m = RUN_DIR.match(tree.name)
            if not m or not tree.is_dir() or not (tree / ".maat/log").exists():
                continue
            row = rows.get((m["task"], m["arm"], int(m["rep"])))
            if not row:
                continue
            claim = row.get("claim") or ""
            if not claim.startswith("verified"):
                continue
            if claim.startswith(("verified (independent checks", "verified (your checks)")):
                independent = True
            else:  # builds before 2026-10-07: a separate judge drafted unless the arm is self
                independent = m["arm"] != "self"
            right = bool(row.get("passed"))
            key = f"{lane.name}/{tree.name}"
            lane_key = lane.name.rsplit("-", 1)[0]
            t = tally[lane_key]
            t["recorded"] += 1
            t["recorded_right"] += right
            if not independent:
                continue
            t["pr32"] += 1
            t["pr32_right"] += right
            a = analyse(tree, row)
            disc = [n for n in a["strong"] if a["status"][n] == "failed"]
            if disc:
                t["rule"] += 1
                t["rule_right"] += right
                if not right:
                    kept_wrong.append(f"{key}  discriminating: {', '.join(disc)}")
            else:
                why = ", ".join(f"{n}={a['status'][n]}" for n in a["strong"]) or "no value check in the receipt"
                if any(s == "late" for s in a["status"].values()):
                    late_only.append(f"{key} ({'right' if right else 'WRONG'})  {why}")
                (lost_right if right else removed_wrong).append(f"{key}  {why}")
    tot: dict[str, int] = defaultdict(int)
    print(f"{'lane':8} {'recorded':>12} {'PR #32':>12} {'+ rule':>12}")
    for lane_key in sorted(tally):
        t = tally[lane_key]
        for k, v in t.items():
            tot[k] += v
        print(f"{lane_key:8} {t['recorded_right']:>5}/{t['recorded']:<6} {t['pr32_right']:>5}/{t['pr32']:<6} {t['rule_right']:>5}/{t['rule']:<6}")
    print(f"{'all':8} {tot['recorded_right']:>5}/{tot['recorded']:<6} {tot['pr32_right']:>5}/{tot['pr32']:<6} {tot['rule_right']:>5}/{tot['rule']:<6}   (right/verified)")
    print(f"\nwrong verifieds the rule removes ({len(removed_wrong)}):")
    for x in removed_wrong:
        print("  " + x)
    print(f"\nright verifieds the rule loses ({len(lost_right)}):")
    for x in lost_right:
        print("  " + x)
    print(f"\nwrong verifieds the rule keeps ({len(kept_wrong)}):")
    for x in kept_wrong:
        print("  " + x)
    if late_only:
        print(f"\nof those denied, rested on a late-joined check with no pre-work try in this build ({len(late_only)}); "
              "with the rule, Maat tries late checks on a copy taken before the work, so these may differ live:")
        for x in late_only:
            print("  " + x)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
