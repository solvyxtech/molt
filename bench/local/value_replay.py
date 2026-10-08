"""The value tag (src/tiers.ts assertsValue) on 2026-10-07's checks: what it rejects, and what widening it flips.

    python3 value_replay.py [--base REF] [--samples N] [--audit-gates --image maat-bench:<sha>-u] [LANE_PREFIX ...]

"Verified" needs a passing independent check that runs the work AND asserts an
expected value; the post-work audit drops a check outright with rule
V-no-value. Both read assertsValue. This replays it, offline, with two builds
of the rule: OLD is src/tiers.ts at --base (default origin/claude/post-work-audit),
NEW is the working tree's src/tiers.ts. Both are loaded straight from the .ts
source (node strips the types), so no build is needed for either.

Population: every <task>-molt-<rep>[-<arm>] tree under today's lanes in
~/.cache/maat-bench/container-work whose grader row exists (the lane's results
file is named on the first line of ~/.cache/maat-bench/<lane>.log).

Collected per check command, with its source:
  sealed    a sealed drafted check, its command from the released list, the
            last full receipt, or (older builds) the bar run's detail
  audit     a post-work audit check in the journal (`post-work-audit` note)
  replay    a post-work audit check from audit_replay.py's caches
            (~/.cache/maat-bench/audit-replay*), judged live on the same trees

1. CATEGORIES. Every command OLD rejects is sorted into one category by the
   first matching pattern below (a heuristic, for the measurement only), with
   NEW's verdict per category.

2. TIER REPLAY (sealed checks). A run whose last tier note was "passed-checks:
   no check that ran the work asserted an expected value" (the evidence
   blocker, nothing else) earns "verified" under NEW when a passing drafted
   check in its last accepted receipt is now tagged value and was written by
   an independent author (the receipt's "written by: the judge model ..." /
   "the reference writer ..."). Counted two ways: any such check (the
   default: no lane today ran with --require-discriminating, no
   `passed-untested` tier is journalled), and only one that FAILED before the
   work (the receipt's "before the work: failed"), which is what the
   discrimination gate would ask. The critic's `surface` tag is not
   journalled: when the receipt's strongest passing class is "runs" and the
   run has more than one passing drafted check, the newly-value one may have
   been surface, so the count can only overstate.

3. AUDIT REPLAY (--audit-gates). An audit check OLD dropped with V-no-value
   and NEW tags value goes on to the remaining gates (runs on the work, fails
   before it, kills a mutant) in a bench container with NEW's dist mounted
   (REPLAY_DIST, default <repo>/dist: run `npm run build` first). A run flips
   to "verified-audit" when one clears every gate and the run was not already
   verified.

   Gate results are cached per (run, command) under ~/.cache/maat-bench/value-replay/;
   clear it after changing anything past the V-no-value gate.

The change ships only if no grader-FAILED run flips to verified. As first
widened (a pattern the work wrote, matched against the check's own strings,
counted too), 4 of the 7 runs that alone would have flipped were grader
failures, every one a regex task whose judge examples missed the grader's
`x 1.2.3.4.5 on 2024-01-05`; that form was withdrawn (src/tiers.ts
PATTERN_DELIVERABLE), and this script reports the rule as shipped.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1] if len(HERE.parents) > 1 else HERE
CACHE = Path.home() / ".cache/maat-bench"
CW = CACHE / "container-work"
RESULTS = CACHE / "container-results"
TODAY = ["ab1", "dsbig", "dsha", "dshj", "dsv4", "ga3b", "gh", "gnuc", "goc", "gp", "gx", "hk55", "hkbig",
         "ml4", "ml4b", "ml4p", "mm3", "mmhd", "mmhj", "mmsj", "nemj", "q235", "scm", "scr"]
RUN_DIR = re.compile(r"^(?P<task>.+)-molt-(?P<rep>\d+)(?:-(?P<arm>[a-z0-9-]+))?$")
RESULTS_LINE = re.compile(r"container-results/(results-[\w.-]+\.jsonl)")
NO_VALUE_REASON = "no check that ran the work asserted an expected value"


# ---------------------------------------------------------------- the two classifiers

def classifier(base: str) -> dict[str, Path]:
    """{"old": tiers.ts at `base`, "new": the working tree's}, as loadable .ts files."""
    d = Path(tempfile.mkdtemp(prefix="value-replay-"))
    old = d / "tiers-old.ts"
    old.write_text(subprocess.run(["git", "-C", str(REPO), "show", f"{base}:src/tiers.ts"], capture_output=True, text=True, check=True).stdout)
    return {"old": old, "new": REPO / "src/tiers.ts"}


def tag_all(src: Path, runs: list[str]) -> list[bool]:
    js = (
        f"import {{ assertsValue }} from {json.dumps(str(src))};"
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(r=>assertsValue(r)))));"
    )
    p = subprocess.run(["node", "--no-warnings", "--input-type=module", "-e", js], input=json.dumps(runs), capture_output=True, text=True)
    if p.returncode:
        sys.exit(f"classifier {src} failed: {p.stderr[-600:]}")
    return json.loads(p.stdout)


# ---------------------------------------------------------------- reading the runs

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
            rows[(r["task"], r.get("arm") or "", int(r["rep"]))] = r  # the last row for a trial wins
    return rows


def journal(tree: Path) -> list[dict]:
    out: list[dict] = []
    for f in sorted((tree / ".maat/log").glob("*.jsonl")):
        for line in f.read_text(errors="replace").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    out.sort(key=lambda e: (e.get("iso", ""), e.get("seq", 0)))
    return out


def tname(n: str) -> str:
    return n if n.startswith("task:") else f"task:{n}"


def receipt(tree: Path) -> dict:
    """The last accepted receipt (its full text when withheld): status line and, per check, command/result/author/before."""
    full = sorted((tree / ".maat/receipts/full").glob("*-accepted.md")) or sorted((tree / ".maat/receipts").glob("*-accepted.md"))
    if not full:
        return {}
    text = full[-1].read_text(errors="replace")
    checks: dict[str, dict] = {}
    cur: dict | None = None
    key = None
    for line in text.splitlines():
        m = re.match(r"^(check|kind|written by|before the work|command|exit|result|ran|duration_ms|role): ?(.*)$", line)
        if m:
            key = m.group(1)
            if key == "check":
                cur = checks.setdefault(m.group(2).strip(), {})
            elif cur is not None:
                cur[key] = m.group(2)
            continue
        if key == "command" and cur is not None and line and not line.startswith(("#", "|")):
            cur["command"] += "\n" + line  # a multi-line command runs on until the next field
        else:
            key = None if line.startswith(("#", "|")) else key
    strongest = re.search(r"strongest passing check is (\w+)", text)
    return {"file": str(full[-1]), "checks": checks, "strongest": strongest.group(1) if strongest else None}


def independent(author: str | None) -> bool:
    return bool(author) and author.startswith(("the judge model", "the reference writer"))


def lanes(prefixes: list[str]) -> list[Path]:
    return sorted(p for p in CW.iterdir() if p.is_dir() and any(re.fullmatch(rf"{re.escape(x)}-(?:r)?\d+", p.name) for x in prefixes))


def collect(prefixes: list[str]) -> tuple[list[dict], list[dict]]:
    """(runs, checks). A check row: {run, source, name, cmd, rule?, ...}."""
    runs: list[dict] = []
    checks: list[dict] = []
    for lane in lanes(prefixes):
        rf = results_file(lane)
        if not rf:
            print(f"# {lane.name}: no results file, skipped", file=sys.stderr)
            continue
        rows = grader_rows(rf)
        for tree in sorted(lane.iterdir()):
            m = RUN_DIR.match(tree.name)
            if not m or not tree.is_dir() or not (tree / ".maat/log").is_dir():
                continue
            row = rows.get((m["task"], m["arm"] or "", int(m["rep"])))
            if not row:
                continue
            ev = journal(tree)
            notes = [e["data"] for e in ev if e.get("kind") == "note"]
            tier = next((d for d in reversed(notes) if str(d.get("text", "")).startswith("tier:")), None)
            rc = receipt(tree)
            run = {"id": f"{lane.name}/{tree.name}", "lane": lane.name, "task": m["task"], "arm": m["arm"] or "", "tree": str(tree),
                   "passed": bool(row.get("passed")), "claim": row.get("claim") or "", "said_done": row.get("said_done"),
                   "tier": tier.get("text", "")[6:] if tier else None, "tier_reason": (tier or {}).get("reason"),
                   "evidence": (tier or {}).get("evidence"), "receipt": rc, "audit": []}
            runs.append(run)
            # sealed checks: commands from the released list, then the receipt, then a journalled bar-run detail
            cmds: dict[str, str] = {}
            for e in ev:
                if e.get("kind") == "bar_run":
                    for c in e["data"].get("checks", []):
                        if c.get("name", "").startswith("task:") and c.get("detail") and not str(c["detail"]).startswith("[withheld"):
                            cmds.setdefault(c["name"], c["detail"])
            for n, c in rc.get("checks", {}).items():
                if n.startswith("task:") and c.get("command") and not c["command"].startswith("[withheld"):
                    cmds[n] = c["command"]
            for d in notes:
                if d.get("kind") == "checks-released":
                    for c in d.get("checks", []):
                        if c.get("run"):
                            cmds[tname(c["name"])] = c["run"]
            run["cmds"] = cmds
            for n, cmd in cmds.items():
                rcx = rc.get("checks", {}).get(n, {})
                checks.append({"run": run, "source": "sealed", "name": n, "cmd": cmd, "result": rcx.get("result"),
                               "author": rcx.get("written by"), "before": rcx.get("before the work")})
            for d in notes:
                if d.get("kind") == "post-work-audit":
                    for c in d.get("checks", []):
                        checks.append({"run": run, "source": "audit", "name": c["name"], "cmd": c["run"], "rule": c.get("rule"),
                                       "accepted": c.get("accepted"), "quote": c.get("quote"), "changed": d.get("changed", [])})
            for rd in sorted(CACHE.glob("audit-replay*")):
                f = rd / (run["id"].replace("/", "__") + ".json")
                if f.exists():
                    try:
                        rep = json.loads(f.read_text())
                    except ValueError:
                        continue
                    for c in rep.get("checks", []):
                        checks.append({"run": run, "source": f"replay:{rd.name}", "name": c["name"], "cmd": c["run"], "rule": c.get("rule"),
                                       "accepted": c.get("accepted"), "quote": c.get("quote"),
                                       "changed": [x["path"] if isinstance(x, dict) else x for x in rep.get("changed", [])]})
    return runs, checks


# ---------------------------------------------------------------- categories

PY_CALL_LIT = r"\w+(?:\.\w+)*\((?:[^()]*?)(?:-?\d|['\"\[{])"
CATEGORIES: list[tuple[str, re.Pattern[str]]] = [
    ("exception expectation", re.compile(r"except\s+\(?[\w.]*(?:Error|Exception)\b|assertRaises|pytest\.raises|assert\.throws|\.toThrow")),
    ("match / non-match of a literal", re.compile(r"re\.(?:search|match|fullmatch|findall)\([^,()]+,\s*['\"]|\.test\(\s*['\"]")),
    ("is None / is not None on a literal call", re.compile(PY_CALL_LIT + r"[^\n]*?\bis\s+(?:not\s+)?None\b")),
    ("literal in / not in the output", re.compile(r"['\"][^'\"]{2,}['\"]\s+(?:not\s+)?in\s+\w|\bnot\s+in\s+['\"]")),
    ("grep -q of a literal in the deliverable's output", re.compile(r"\|\s*grep\s+(?:-\w+\s+)*-\w*q")),
    ("grep -q of a literal in a file", re.compile(r"\bgrep\s+(?:-\w+\s+)*-\w*q")),
    ("exit code with literal stdin", re.compile(r"(?:<<<|<<|printf|echo)[^\n]*\|[^\n]*(?:\$\?|\|\||&&|^!|\bif\b)")),
    ("truthiness of a call on literal input", re.compile(r"\bassert\s+(?:not\s+)?" + PY_CALL_LIT)),
    ("ordering comparison with a literal", re.compile(r"(?:<=?|>=?)\s*-?\d|-(?:lt|le|gt|ge)\s+-?\d")),
    ("structural only (exists, type, non-empty)", re.compile(r"isinstance|test\s+-[fesdx]|\[\s+-[fesdx]|len\([^)]*\)\s*>|hasattr|callable\(|py_compile|--help|\bnode\s+--check")),
]


def category(cmd: str) -> str:
    timed = bool(re.search(r"\btimeout\s+\d|time\.(?:time|perf_counter)\(", cmd))
    for name, pat in CATEGORIES:
        if pat.search(cmd):
            return f"{name}{' (+timing)' if timed else ''}"
    return "timing only" if timed else "other"


# ---------------------------------------------------------------- audit gates (--audit-gates)

GATE_CACHE = CACHE / "value-replay"


def gate_one(c: dict, image: str, dist: str) -> dict:
    """The audit gates for one check, cached per (run, command) under ~/.cache/maat-bench/value-replay/."""
    import hashlib  # noqa: PLC0415
    key = GATE_CACHE / (c["run"]["id"].replace("/", "__") + "-" + hashlib.sha256(c["cmd"].encode()).hexdigest()[:16] + ".json")
    if key.exists():
        return json.loads(key.read_text())
    r = gate_run(c, image, dist)
    if not r.get("error"):
        GATE_CACHE.mkdir(parents=True, exist_ok=True)
        key.write_text(json.dumps(r))
    return r


def gate_run(c: dict, image: str, dist: str) -> dict:
    run = c["run"]
    entry = {"task": run["task"], "tree_name": Path(run["tree"]).name, "checks": [{"name": c["name"], "run": c["cmd"], "quote": c.get("quote") or ""}],
             "changed": c.get("changed") or []}
    cmd = ["docker", "run", "--rm", "-i", "-e", "PYTHONDONTWRITEBYTECODE=1",
           "-v", f"{HERE}:/bench:ro", "-v", f"{run['tree']}:/tree:ro",
           "-v", f"{dist}:/usr/local/lib/node_modules/@solvyx/molt/dist:ro", image,
           "sh", "-c", "export MOLT_DIST_ABS=$(npm root -g)/@solvyx/molt/dist; python3 /bench/value_replay.py --inside"]
    try:
        p = subprocess.run(cmd, input=json.dumps(entry), capture_output=True, text=True, timeout=600)
        line = (p.stdout.strip().splitlines() or [""])[-1]
        return json.loads(line) if line.startswith("{") else {"error": f"exit {p.returncode}: {p.stderr[-400:]}"}
    except subprocess.TimeoutExpired:
        return {"error": "timed out"}


def inside() -> int:
    """In the container: rebuild the pre-work tree, plan mutants of the changed files, run the audit gates."""
    import shutil  # noqa: PLC0415
    sys.path.insert(0, str(HERE))
    from tasks import TASKS  # noqa: PLC0415
    from tasks2 import TASKS2  # noqa: PLC0415
    from tasks3 import TASKS3  # noqa: PLC0415
    by = {T.name: T for T in TASKS + TASKS2 + TASKS3}
    e = json.loads(sys.stdin.read())
    root = Path(tempfile.mkdtemp(prefix="value-"))
    pre = root / "pre" / e["tree_name"]
    work = root / "work" / e["tree_name"]
    pre.mkdir(parents=True)
    by[e["task"]].setup(pre)
    shutil.copytree("/tree", work, symlinks=True, ignore=shutil.ignore_patterns(".maat", ".molt"))
    js = r"""
const { auditGates, planAuditMutants } = await import(`${process.env.MOLT_DIST_ABS}/post-audit.js`);
const fs = await import('node:fs'); const path = await import('node:path');
let s=''; for await (const c of process.stdin) s+=c; const a = JSON.parse(s);
const files = [];
for (const p of a.changed) {
  let text = '', before;
  try { text = fs.readFileSync(path.join(a.work, p), 'utf8'); } catch {}
  try { before = fs.readFileSync(path.join(a.pre, p), 'utf8'); } catch {}
  if (text && !text.includes('\u0000')) files.push({ path: p, text, ...(before !== undefined ? { before } : {}) });
}
const mutants = await planAuditMutants(files);
const out = [];
for (const c of a.checks) out.push(await auditGates(c, { workDir: a.work, preWorkDir: a.pre, mutants }));
console.log(JSON.stringify({ mutants: mutants.length, checks: out }));
"""
    inp = {"work": str(work), "pre": str(pre), "changed": e["changed"], "checks": e["checks"]}
    p = subprocess.run(["node", "--input-type=module", "-e", js], input=json.dumps(inp), capture_output=True, text=True, timeout=500)
    print((p.stdout.strip().splitlines() or [json.dumps({"error": p.stderr[-500:]})])[-1])
    return 0


# ---------------------------------------------------------------- report

def pct(a: int, b: int) -> str:
    return f"{100 * a / b:.0f}%" if b else "n/a"


def main(argv: list[str]) -> int:
    if argv[:1] == ["--inside"]:
        return inside()
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="origin/claude/post-work-audit")
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--audit-gates", action="store_true")
    ap.add_argument("--image")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("prefixes", nargs="*")
    a = ap.parse_args(argv)
    runs, checks = collect(a.prefixes or TODAY)
    src = classifier(a.base)
    cmds = sorted({c["cmd"] for c in checks})
    old = dict(zip(cmds, tag_all(src["old"], cmds)))
    new = dict(zip(cmds, tag_all(src["new"], cmds)))
    for c in checks:
        c["old"], c["new"] = old[c["cmd"]], new[c["cmd"]]
    print(f"runs with a grader row: {len(runs)}   check rows: {len(checks)}   distinct commands: {len(cmds)}")
    print(f"tagged value: OLD {sum(old.values())}, NEW {sum(new.values())} of {len(cmds)} distinct commands")
    lost = [x for x in cmds if old[x] and not new[x]]
    if lost:
        print(f"!! NEW drops the value tag from {len(lost)} command(s) OLD tagged:")
        for x in lost[:10]:
            print("   " + x[:200].replace("\n", "\\n"))

    # 1. categories of what OLD rejects (distinct commands; audit V-no-value rows called out)
    rejected = sorted({c["cmd"] for c in checks if not c["old"]})
    vnv = {c["cmd"] for c in checks if c.get("rule") == "V-no-value"}
    cat = {x: category(x) for x in rejected}
    by_cat: dict[str, list[str]] = defaultdict(list)
    for x in rejected:
        by_cat[cat[x]].append(x)
    print(f"\n== 1. what OLD tags no-value: {len(rejected)} distinct commands ({len(vnv)} of them audit V-no-value rejections)")
    print(f"   {'category':58} {'all':>5} {'V-no-v':>7} {'NEW value':>10}")
    for k, xs in sorted(by_cat.items(), key=lambda kv: -len(kv[1])):
        print(f"   {k:58} {len(xs):5} {sum(x in vnv for x in xs):7} {sum(new[x] for x in xs):10}")
    for k, xs in sorted(by_cat.items(), key=lambda kv: -len(kv[1])):
        print(f"\n   -- {k}")
        for x in sorted(xs, key=lambda x: (x not in vnv, len(x)))[: a.samples]:
            print(f"      [{'NEW value' if new[x] else 'no value '}] {x[:230]!r}")

    # 2. tier replay over the sealed checks
    print("\n== 2. tier replay (sealed checks; last tier note per run)")
    tiers = Counter((r["tier"], r["tier_reason"] == NO_VALUE_REASON) for r in runs)
    print("   runs by last tier note: " + ", ".join(f"{t or 'none'}{' [value blocker]' if b else ''}: {n}" for (t, b), n in tiers.most_common()))
    blocked = [r for r in runs if r["tier"] == "passed-checks" and r["tier_reason"] == NO_VALUE_REASON]
    flips_any: list[tuple[dict, list[dict]]] = []
    flips_disc: list[tuple[dict, list[dict]]] = []
    own_only = 0
    for r in blocked:
        mine = [c for c in checks if c["run"] is r and c["source"] == "sealed" and c.get("result") in ("pass", "pass-vacuous")]
        newv = [c for c in mine if c["new"] and not c["old"]]
        ind = [c for c in newv if independent(c.get("author"))]
        if newv and not ind:
            own_only += 1
        if ind:
            flips_any.append((r, ind))
            disc = [c for c in ind if str(c.get("before") or "").startswith("failed")]
            if disc:
                flips_disc.append((r, disc))
    for label, fl in (("any independent newly-value check (as the lanes ran)", flips_any),
                      ("one that also FAILED before the work (the discrimination gate)", flips_disc)):
        right = [r for r, _ in fl if r["passed"]]
        wrong = [r for r, _ in fl if not r["passed"]]
        print(f"   blocked only by the value tag: {len(blocked)} runs ({sum(r['passed'] for r in blocked)} grader-passed)")
        print(f"   flip to verified, {label}: {len(fl)}  right {len(right)}  WRONG {len(wrong)}")
        for r, cs in fl:
            many = sum(1 for c in checks if c['run'] is r and c['source'] == 'sealed' and c.get('result') in ('pass', 'pass-vacuous')) > 1
            print(f"      {'right' if r['passed'] else 'WRONG'} {r['id']}{'  (surface unknown)' if many else ''}")
            for c in cs:
                print(f"         {c['name']} [{c.get('before') or 'no pre-work try'}] {c['cmd'][:170]!r}")
    print(f"   runs whose newly-value checks were all the worker's own: {own_only} (-> passed-own-checks, not verified)")
    old_v = [r for r in runs if r["tier"] == "verified"]
    print(f"   recorded 'verified' on these lanes: {sum(r['passed'] for r in old_v)}/{len(old_v)} right; with NEW: "
          f"{sum(r['passed'] for r in old_v) + sum(r['passed'] for r, _ in flips_any)}/{len(old_v) + len(flips_any)} "
          f"({pct(sum(r['passed'] for r in old_v) + sum(r['passed'] for r, _ in flips_any), len(old_v) + len(flips_any))})")

    # 3. audit checks OLD dropped with V-no-value
    cand = [c for c in checks if c.get("rule") == "V-no-value" and c["new"]]
    stay = [c for c in checks if c.get("rule") == "V-no-value" and not c["new"]]
    print(f"\n== 3. audit checks dropped with V-no-value: {len(cand) + len(stay)}; NEW tags value: {len(cand)} "
          f"(runs: {len({c['run']['id'] for c in cand})}, {sum(1 for i in {c['run']['id']: c['run'] for c in cand}.values() if not i['passed'])} grader-failed)")
    if a.audit_gates:
        if not a.image:
            sys.exit("--audit-gates needs --image maat-bench:<sha>-u")
        dist = os.environ.get("REPLAY_DIST") or str(REPO / "dist")
        from concurrent.futures import ThreadPoolExecutor  # noqa: PLC0415
        with ThreadPoolExecutor(a.jobs) as ex:
            res = list(ex.map(lambda c: gate_one(c, a.image, dist), cand))
        per_run: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
        rules = Counter()
        for c, g in zip(cand, res):
            gr = (g.get("checks") or [{}])[0] if not g.get("error") else {"rule": "replay-error", "why": g["error"]}
            rules[gr.get("rule") or "accepted"] += 1
            per_run[(c["source"], c["run"]["id"])].append((c, gr))
        print("   gate outcomes: " + ", ".join(f"{k} {v}" for k, v in rules.most_common()))
        fl = [(k, cs) for k, cs in per_run.items() if any(g.get("accepted") for _, g in cs)]
        already = {(c["source"], c["run"]["id"]) for c in checks if c.get("accepted")}
        newfl = [(k, cs) for k, cs in fl if k not in already and cs[0][0]["run"]["tier"] != "verified"]
        right = [k for k, cs in newfl if cs[0][0]["run"]["passed"]]
        wrong = [k for k, cs in newfl if not cs[0][0]["run"]["passed"]]
        print(f"   runs that flip to verified-audit: {len(newfl)}  right {len(right)}  WRONG {len(wrong)}")
        for k, cs in newfl:
            run = cs[0][0]["run"]
            for c, g in cs:
                if g.get("accepted"):
                    print(f"      {'right' if run['passed'] else 'WRONG'} {k[0]} {k[1]}  {c['name']}: {c['cmd'][:160]!r}")
        for k, cs in per_run.items():
            for c, g in cs:
                if g.get("rule") == "replay-error":
                    print(f"      error {k[1]} {c['name']}: {g['why'][:200]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
