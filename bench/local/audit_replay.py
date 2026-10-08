"""What the post-work audit (--post-work-audit) would have done on 2026-10-07's runs.

    python3 audit_replay.py --image maat-bench:<sha>-u [--jobs 4] [--limit N] [LANE_PREFIX ...]
    python3 audit_replay.py --report-only [LANE_PREFIX ...]

The audit (src/post-audit.ts): when a claimed run is not verified by the checks
sealed before the work, an independent judge drafts checks from the task text
and an interface view of the finished work (names, signatures, usage; never
the transcript, the claim or the outputs). A check counts only if it quotes the
task for its expected value, passes on the work, fails on the pre-work copy,
fails on a mutant of the changed code that still runs, and clears the lints.

Population: every saved <task>-molt-<rep>-<arm> tree from today's lanes whose
grader row exists and whose claim was "unverified" (the outcome the audit
runs on: the sealed checks passed without earning "verified", only drafted
checks refused the claim, or nothing checked it), not timed out and not
stopped by the clock. "verified", "not proven", "error" and "stopped" runs are
out of scope: the audit never runs on them.

Each run is replayed in its own throwaway container (the bench image, so the
tools are the bench's and port 8080 is free) with the PR's build installed:
the saved tree (minus .maat/) is the work, the task's own setup() rebuilds the
pre-work tree, and the judge is asked live. Results are cached per run under
~/.cache/maat-bench/audit-replay/, so a rerun only asks for what is missing.

Judged arms (arm != self: a separate judge, qwen3-coder-30b-a3b, sealed the
checks) are the population the flag applies to as run. The self arm had no
judge, so the audit would have been skipped; it is replayed with the same judge
as a what-if and reported apart.

Caveats, printed with the numbers: the judge is OpenRouter's
qwen/qwen3-coder-30b-a3b-instruct (the bench used the same model on the NUC,
a different quantisation, and is busy with other lanes); the saved trees are
the state after grading; setup() is re-run for the pre-work tree; one judge
sample per run.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache/maat-bench"
OUT = Path(os.environ.get("REPLAY_OUT") or CACHE / "audit-replay")
JUDGE_URL = os.environ.get("REPLAY_JUDGE_URL") or "https://openrouter.ai/api/v1"
# The bench's judge (qwen3-coder-30b-a3b on the NUC) by default; REPLAY_JUDGE_MODEL for a what-if.
JUDGE_MODEL = os.environ.get("REPLAY_JUDGE_MODEL") or "qwen/qwen3-coder-30b-a3b-instruct"


# ---------------------------------------------------------------- inside the container

def inside() -> int:
    """Read one entry on stdin, rebuild its pre-work tree, run the audit, print the report."""
    sys.path.insert(0, str(HERE))
    from tasks import TASKS  # noqa: PLC0415
    from tasks2 import TASKS2  # noqa: PLC0415
    from tasks3 import TASKS3  # noqa: PLC0415
    by = {T.name: T for T in TASKS + TASKS2 + TASKS3}
    e = json.loads(sys.stdin.read())
    T = by[e["task"]]
    root = Path(tempfile.mkdtemp(prefix="audit-"))
    pre = root / "pre" / e["tree_name"]
    work = root / "work" / e["tree_name"]
    pre.mkdir(parents=True)
    T.setup(pre)
    shutil.copytree("/tree", work, symlinks=True, ignore=shutil.ignore_patterns(".maat", ".molt"))
    inp = {
        "task": T.PROMPT,
        "workDir": str(work),
        "preWorkDir": str(pre),
        "judge": {"baseUrl": e["judge_url"], "apiKey": os.environ.get("JUDGE_KEY") or None, "model": e["judge_model"]},
        "reasoningEffort": "none",
    }
    p = subprocess.run(["node", str(HERE / "audit_replay_driver.mjs")], input=json.dumps(inp), capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        print(json.dumps({"error": f"driver exited {p.returncode}: {p.stderr[-800:]}"}))
        return 0
    print(p.stdout.strip().splitlines()[-1])
    return 0


# ---------------------------------------------------------------- on the host

def population(prefixes: list[str]) -> tuple[list[dict], Counter]:
    sys.path.insert(0, str(HERE))
    import discriminating_replay as dr  # noqa: PLC0415
    lanes = sorted(p for p in dr.CW.iterdir() if p.is_dir() and any(re.fullmatch(rf"{re.escape(x)}-\d+", p.name) for x in prefixes))
    out: list[dict] = []
    other: Counter = Counter()
    for lane in lanes:
        rf = dr.results_file(lane)
        if not rf:
            continue
        rows = dr.grader_rows(rf)
        for tree in sorted(lane.iterdir()):
            m = dr.RUN_DIR.match(tree.name)
            if not m or not tree.is_dir():
                continue
            row = rows.get((m["task"], m["arm"], int(m["rep"])))
            if not row:
                continue
            claim = row.get("claim") or ""
            judged = m["arm"] != "self"
            if claim.startswith("verified"):
                other[("verified", judged, bool(row["passed"]))] += 1
                continue
            if not claim.startswith("unverified") or row.get("timed_out") or row.get("endedBy") or row.get("deadline"):
                other[("out of scope", judged, bool(row["passed"]))] += 1
                continue
            out.append({"id": f"{lane.name}/{tree.name}", "lane": lane.name, "task": m["task"], "arm": m["arm"], "judged": judged,
                        "tree": str(tree), "tree_name": tree.name, "passed": bool(row["passed"]), "claim": claim, "tier": row.get("tier")})
    return out, other


def cached(e: dict) -> Path:
    return OUT / (e["id"].replace("/", "__") + ".json")


def openrouter_key() -> str:
    p = subprocess.run(["node", "-e", "import('%s').then(m=>process.stdout.write(m.readAuth().openrouter||''))"
                        % (Path.home() / "Documents/molt-desktop/dist/providers.js")], capture_output=True, text=True)
    return p.stdout.strip()


def replay_one(e: dict, image: str, envf: str) -> dict:
    entry = {"task": e["task"], "tree_name": e["tree_name"], "judge_url": JUDGE_URL, "judge_model": JUDGE_MODEL}
    cmd = ["docker", "run", "--rm", "-i", "--env-file", envf, "-e", "PYTHONDONTWRITEBYTECODE=1",
           "-v", f"{HERE}:/bench:ro", "-v", f"{e['tree']}:/tree:ro",
           # A dist/ to test in place of the image's (development only; the reported numbers use the image).
           *(["-v", f"{os.environ['REPLAY_DIST']}:/usr/local/lib/node_modules/@solvyx/molt/dist:ro"] if os.environ.get("REPLAY_DIST") else []),
           image,
           "sh", "-c", "export MOLT_DIST_ABS=$(npm root -g)/@solvyx/molt/dist; python3 /bench/audit_replay.py --inside"]
    try:
        p = subprocess.run(cmd, input=json.dumps(entry), capture_output=True, text=True, timeout=900)
        line = (p.stdout.strip().splitlines() or [""])[-1]
        r = json.loads(line) if line.startswith("{") else {"error": f"no report (exit {p.returncode}): {p.stderr[-500:]}"}
    except subprocess.TimeoutExpired:
        r = {"error": "the replay timed out"}
    cached(e).write_text(json.dumps(r))
    return r


def report(pop: list[dict], other: Counter) -> None:
    rows = []
    for e in pop:
        f = cached(e)
        if f.exists():
            rows.append((e, json.loads(f.read_text())))
    print(f"replayed {len(rows)} of {len(pop)} eligible runs (judge {JUDGE_MODEL})\n")
    for judged, label in ((True, "JUDGED ARMS (the flag applies as run)"), (False, "SELF ARM (what-if: no judge was set, so the audit would have been skipped)")):
        sel = [(e, r) for e, r in rows if e["judged"] == judged]
        if not sel:
            continue
        ok = [(e, r) for e, r in sel if not r.get("error")]
        err = [(e, r) for e, r in sel if r.get("error")]
        p_all = [(e, r) for e, r in ok if e["passed"]]
        f_all = [(e, r) for e, r in ok if not e["passed"]]
        p_v = [e for e, r in p_all if r.get("accepted")]
        f_v = [e for e, r in f_all if r.get("accepted")]
        print(f"== {label}")
        print(f"   eligible (claim unverified): {len(sel)}   replay errors: {len(err)}")
        print(f"   grader PASSED, Maat unverified: {len(p_all)}  -> audit verifies {len(p_v)}  (recall {pct(len(p_v), len(p_all))})")
        print(f"   grader FAILED, Maat unverified: {len(f_all)}  -> audit verifies {len(f_v)}  (false verifieds)")
        print(f"   precision of the audit tier: {len(p_v)}/{len(p_v) + len(f_v)} = {pct(len(p_v), len(p_v) + len(f_v))}")
        vr = other[("verified", judged, True)]
        vw = other[("verified", judged, False)]
        print(f"   pre-work 'verified' on the same lanes: {vr}/{vr + vw} right; with the audit: "
              f"{vr + len(p_v)}/{vr + vw + len(p_v) + len(f_v)} right ({pct(vr + len(p_v), vr + vw + len(p_v) + len(f_v))})")
        drafted = sum(r.get("drafted", 0) for _, r in ok)
        dropped = sum(len(r.get("dropped", [])) for _, r in ok)
        gates = Counter(c.get("rule") or "accepted" for _, r in ok for c in r.get("checks", []))
        print(f"   checks drafted {drafted}, dropped ungrounded/malformed {dropped}, gated {sum(gates.values())}:")
        for k, v in gates.most_common():
            print(f"      {k:24} {v}")
        no_mut = sum(1 for _, r in ok if r.get("drafted") and not r.get("mutants"))
        print(f"   runs where no mutant could be made: {no_mut}")
        if f_v:
            print("   WRONG audit verifieds:")
            for e, r in f_all:
                if r.get("accepted"):
                    acc = [c for c in r["checks"] if c.get("accepted")]
                    for c in acc:
                        print(f"      {e['id']}  {c['name']}: {c['run'][:150]}  quote: {c['quote'][:80]!r}")
        by_task = defaultdict(lambda: [0, 0])
        for e, r in p_all:
            by_task[e["task"]][0] += 1
            by_task[e["task"]][1] += bool(r.get("accepted"))
        print("   recall by task (verified/passing-unverified): " + ", ".join(f"{t} {v}/{n}" for t, (n, v) in sorted(by_task.items())))
        if err:
            print("   errors: " + "; ".join(f"{e['id']}: {r['error'][:100]}" for e, r in err[:8]))
        print()


def pct(a: int, b: int) -> str:
    return f"{100 * a / b:.0f}%" if b else "n/a"


def main(argv: list[str]) -> int:
    if argv[:1] == ["--inside"]:
        return inside()
    ap = argparse.ArgumentParser()
    ap.add_argument("--image")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--judged-only", action="store_true")
    ap.add_argument("prefixes", nargs="*")
    a = ap.parse_args(argv)
    sys.path.insert(0, str(HERE))
    import discriminating_replay as dr  # noqa: PLC0415
    pop, other = population(a.prefixes or dr.TODAY)
    OUT.mkdir(parents=True, exist_ok=True)
    if not a.report_only:
        if not a.image:
            print("--image maat-bench:<sha>-u is required (build it from the PR's tarball)", file=sys.stderr)
            return 2
        todo = [e for e in pop if not cached(e).exists() and (e["judged"] or not a.judged_only)]
        todo.sort(key=lambda e: (not e["judged"], e["id"]))
        if a.limit:
            todo = todo[: a.limit]
        fd, envf = tempfile.mkstemp()
        os.chmod(envf, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f"JUDGE_KEY={openrouter_key()}\n")
        try:
            with ThreadPoolExecutor(a.jobs) as ex:
                for i, r in enumerate(ex.map(lambda e: replay_one(e, a.image, envf), todo)):
                    print(f"[{i + 1}/{len(todo)}] {'error' if r.get('error') else len(r.get('accepted', []))}", file=sys.stderr, flush=True)
        finally:
            os.unlink(envf)
    report(pop, other)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
