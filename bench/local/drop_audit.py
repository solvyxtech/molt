#!/usr/bin/env python3
"""Audit of drafted checks Maat dropped before sealing.

Collects every drop line the bench lanes wrote to stderr:

  maat: dropped drafted criterion NAME (RUN) — WHY               (seal-time trial, cli.tsx)
  maat: criteria review — dropped NAME (RUN) before sealing: WHY [RULE]
  maat: criteria review — dropped NAME (RUN) from the redraft: WHY [RULE]
  maat: criteria review — dropped NAME (RUN) from the cover draft: WHY [RULE]
  maat: criteria review — dropped NAME from the redraft — "QUOTE"  (the critic's own drop, no run)

groups them by reason, and prints a table with samples per reason.

With --run, every dropped command whose task is known is also executed in the
bench image (Linux, the tools the lanes had): once on the task's pristine
tree (tasks*.py setup) and once on the lane's saved finished tree, which is
then graded. A check that FAILS on the pristine tree, PASSES on a finished
tree the grader accepted, and is not one of the rules that is right whatever
the outcome (it changes the work, it cannot fail), told the work from none:
dropping it threw away a good check. That count is the automatic part of
the false-drop estimate; the rest is reading the samples.

With --lint DIST, every dropped command is also re-linted by the built
dist/checklint.js (and dist/criteria.js strayPath) of a checkout, to show
which drops a given build would still make ("after" counts).

Usage:
  python3 bench/local/drop_audit.py [--since 2026-10-07] [--samples 3]
      [--run [--image maat-bench:TAG]] [--lint ~/Documents/molt-wt-drops/dist]
      [--json out.json]
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CW = Path.home() / ".cache/maat-bench/container-work"

DRAFTED = re.compile(r"^maat: dropped drafted criterion (?P<name>\S+) \((?P<run>.*)\) — (?P<why>.*)$", re.S)
REVIEW = re.compile(
    r"^maat: criteria review — dropped (?P<name>\S+) \((?P<run>.*)\) (?P<where>before sealing|from the redraft|from the cover draft): "
    r"(?P<why>.*?)(?: \[(?P<rule>[^\]]+)\])?$",
    re.S,
)
CRITIC_RUN = re.compile(
    r"^maat: criteria review — dropped (?P<name>\S+) \((?P<run>.*)\): it (?P<why>(?:guesses an answer the task does not give|demands what the task does not state) — .*)$", re.S
)
CRITIC = re.compile(r"^maat: criteria review — dropped (?P<name>\S+) from the (?P<where>redraft|draft) — (?P<why>.*)$", re.S)
START = re.compile(r"^maat: (?:dropped drafted criterion |criteria review — dropped )")
RUN_FILE = re.compile(r"^(?P<task>.+?)-(?P<agent>molt)-(?P<rep>\d+)(?:-(?P<arm>[\w.-]+))?\.err$")

# What a trial (preflightCriteria) said, as a reason key.
TRIAL_KEYS = [
    (re.compile(r"an absolute path outside the project"), "trial:L11-abs"),
    (re.compile(r"the command was not found"), "trial:not-found"),
    (re.compile(r"could not parse it"), "trial:unparsed"),
    (re.compile(r"git outside a git repository"), "trial:git-norepo"),
    (re.compile(r"reads a file from HEAD"), "trial:git-head-missing"),
    (re.compile(r"git rejected the check"), "trial:git-usage"),
    (re.compile(r"own program has a bug"), "trial:own-bug"),
    (re.compile(r"rejected the check's options"), "trial:bad-options"),
    (re.compile(r"rejected the check's date"), "trial:bad-date"),
    (re.compile(r"misuses a library call"), "trial:lib-misuse"),
]

# Rules whose drop is right whatever the check would have reported: a check
# that changes the work, or that exits 0 whatever happened, is unsafe even
# when it happens to tell the work from none on one tree. Their false drops
# are mis-fires of the rule itself, which only reading the command shows.
OUTCOME_INDEPENDENT = ("L15-mutates", "L16-cannot-fail", "L9-swallows-exit", "L9-pipe-no-pipefail")


def reason_of(rec: dict) -> str:
    if rec["src"] == "trial":
        for rx, key in TRIAL_KEYS:
            if rx.search(rec["why"]):
                return key
        return "trial:" + re.sub(r"\W+", "-", rec["why"].lower())[:40].strip("-")
    if rec["src"] == "critic":
        if rec["why"].startswith("guesses"):
            return "critic:guesses"
        if rec["why"].startswith("demands"):
            return "critic:invents"
        return "critic:off-task"
    rule = rec.get("rule") or "unlabelled"
    return re.sub(r":.*$", "", rule)


def collect(since: dt.date, root: Path = CW, until: dt.datetime | None = None) -> list[dict]:
    recs: list[dict] = []
    cutoff = dt.datetime.combine(since, dt.time()).timestamp()
    stop = until.timestamp() if until else float("inf")
    for err in sorted(root.glob("*/*.err")):
        if not cutoff <= err.stat().st_mtime <= stop:
            continue
        m = RUN_FILE.match(err.name)
        task = m["task"] if m else err.stem
        cur: list[str] | None = None
        blocks: list[str] = []
        for line in err.read_text(errors="replace").splitlines():
            if line.startswith("maat:"):
                if cur is not None:
                    blocks.append("\n".join(cur))
                cur = [line] if START.match(line) else None
            elif cur is not None:
                cur.append(line)
        if cur is not None:
            blocks.append("\n".join(cur))
        for b in blocks:
            base = {"lane": err.parent.name, "task": task, "err": str(err), "tree": str(err.with_suffix(""))}
            if mm := DRAFTED.match(b):
                rec = {**base, "src": "trial", "where": "trial", "name": mm["name"], "run": mm["run"], "why": mm["why"].strip(), "rule": None}
            elif mm := REVIEW.match(b):
                rec = {**base, "src": "lint", "where": mm["where"], "name": mm["name"], "run": mm["run"], "why": mm["why"].strip(), "rule": mm["rule"]}
            elif mm := CRITIC_RUN.match(b):
                rec = {**base, "src": "critic", "where": "critic", "name": mm["name"], "run": mm["run"], "why": mm["why"].strip(), "rule": None}
            elif mm := CRITIC.match(b):
                rec = {**base, "src": "critic", "where": "critic", "name": mm["name"], "run": None, "why": mm["why"].strip(), "rule": None}
            else:
                rec = {**base, "src": "unparsed", "where": "?", "name": "?", "run": None, "why": b[:200], "rule": None}
            rec["reason"] = reason_of(rec)
            recs.append(rec)
    return recs


# ---------------------------------------------------------------- running the commands

RUNNER = r'''
import json, os, re, shutil, signal, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, "/bench")
from tasks import TASKS
from tasks2 import TASKS2
try:
    from tasks3 import TASKS3
except Exception:
    TASKS3 = []
BY = {T.name: T for T in TASKS + TASKS2 + TASKS3}
items = json.load(open("/io/in.json"))

def run(tree, cmd):
    tmp = Path(tempfile.mkdtemp())
    w = tmp / "w"
    shutil.copytree(tree, w, symlinks=True, ignore=shutil.ignore_patterns(".maat", ".molt"))
    try:
        p = subprocess.Popen(["bash", "-c", cmd], cwd=w, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             start_new_session=True, stdin=subprocess.DEVNULL)
        try:
            out, err = p.communicate(timeout=20)
            code = p.returncode
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL); p.communicate(); code, out, err = None, "", "timeout"
        finally:
            try: os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError: pass
        return {"code": code, "tail": (out + err)[-300:]}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

pristine = {}
graded = {}
out = []
for it in items:
    T = BY.get(it["task"])
    r = {"i": it["i"]}
    if T is None:
        r["skip"] = "task unknown"; out.append(r); continue
    if it["task"] not in pristine:
        d = Path(tempfile.mkdtemp()) / "w"; d.mkdir()
        T.setup(d); pristine[it["task"]] = d
    r["pre"] = run(pristine[it["task"]], it["run"])
    post = Path("/cw") / it["tree"]
    if post.is_dir():
        if it["tree"] not in graded:
            tmp = Path(tempfile.mkdtemp()) / "w"
            shutil.copytree(post, tmp, symlinks=True, ignore=shutil.ignore_patterns(".maat", ".molt"))
            try:
                ok, why = T.grade(tmp)
            except Exception as e:
                ok, why = False, f"grader raised {e!r}"
            graded[it["tree"]] = (bool(ok), str(why)[:120])
            shutil.rmtree(tmp.parent, ignore_errors=True)
        r["post"] = run(post, it["run"])
        r["graded"] = graded[it["tree"]]
    out.append(r)
json.dump(out, open("/io/out.json", "w"))
'''


def run_all(recs: list[dict], image: str) -> None:
    todo = [{"i": i, "task": r["task"], "run": r["run"], "tree": str(Path(r["tree"]).relative_to(CW))} for i, r in enumerate(recs) if r["run"]]
    with tempfile.TemporaryDirectory() as io:
        Path(io, "in.json").write_text(json.dumps(todo))
        Path(io, "runner.py").write_text(RUNNER)
        subprocess.run(
            ["docker", "run", "--rm", "--network=none", "-v", f"{HERE}:/bench:ro", "-v", f"{CW}:/cw:ro", "-v", f"{io}:/io",
             "--entrypoint", "python3", image, "/io/runner.py"],
            check=True, timeout=3600,
        )
        for r in json.loads(Path(io, "out.json").read_text()):
            recs[r["i"]]["exec"] = r


def verdict(rec: dict) -> str:
    """good: failed on the pristine tree, passed on a finished tree the grader accepted."""
    ex = rec.get("exec")
    if not ex or "skip" in ex or "post" not in ex:
        return "n/a"
    pre, post, (ok, _) = ex["pre"]["code"], ex["post"]["code"], ex["graded"]
    if pre == 0:
        return "passes-before"
    if post == 0 and ok:
        return "good"
    if post == 0 and not ok:
        return "passes-wrong-work"
    if ok:
        return "fails-correct-work"
    return "fails-both"


# ---------------------------------------------------------------- re-linting with a build

LINT_JS = r'''
import { cannotFail } from "%(dist)s/checklint.js";
import { checkMutates } from "%(dist)s/checkwrites.js";
import * as criteria from "%(dist)s/criteria.js";
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const items = JSON.parse(s);
  const out = items.map((it) => ({
    // What the seal-time review drops by default (criteria.ts lintSplit): L15, then L16.
    L15: checkMutates(it.run),
    L16: cannotFail(it.run),
    // What the seal-time trial drops without running (cli.tsx sealDraft → preflightCriteria stray).
    stray: criteria.strayPath(it.run, { cwd: "/nonexistent-project-root", task: it.task }),
    // A "not found" that is the deliverable missing (absent in older builds).
    missing: criteria.missingDeliverable ? criteria.missingDeliverable(it.stderr ?? "", "/nonexistent-project-root") : null,
    // P1 drops this build seals as refuse-only guards (criteria.ts guardsFrom), before the per-draft cap.
    guard: criteria.pinsCurrentValue ? !criteria.pinsCurrentValue(it.run) : false,
  }));
  console.log(JSON.stringify(out));
});
'''


def relint(recs: list[dict], dist: Path) -> None:
    todo = [r for r in recs if r["run"]]
    task_text = {}
    try:
        sys.path.insert(0, str(HERE))
        from tasks import TASKS  # noqa: E402
        from tasks2 import TASKS2  # noqa: E402
        from tasks3 import TASKS3  # noqa: E402
        task_text = {T.name: getattr(T, "PROMPT", "") for T in TASKS + TASKS2 + TASKS3}
    except Exception:
        pass
    items = [{"run": r["run"], "task": task_text.get(r["task"], ""), "stderr": ((r.get("exec") or {}).get("pre") or {}).get("tail", "")} for r in todo]
    p = subprocess.run(["node", "--input-type=module", "-e", LINT_JS % {"dist": str(dist.resolve())}], input=json.dumps(items),
                       capture_output=True, text=True, check=True)
    for r, o in zip(todo, json.loads(p.stdout)):
        r["relint"] = o


def still_dropped(rec: dict) -> bool | None:
    """Would this build still drop the command for the same reason? None when a re-lint cannot say (a run's outcome decides)."""
    o = rec.get("relint")
    if o is None:
        return None
    reason = rec["reason"]
    if reason in ("trial:L11-abs", "L11-abs"):
        return bool(o["stray"])
    if reason == "L15-mutates":
        return bool(o["L15"])
    if reason == "L16-cannot-fail":
        return bool(o["L16"])
    if reason == "trial:not-found":
        # Needs the run's stderr (--run); a missing deliverable is now a failure before the work.
        return None if not rec.get("exec") else not o["missing"]
    return None


# ---------------------------------------------------------------- report

def short(s: str, n: int = 150) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default=dt.date.today().isoformat())
    ap.add_argument("--until", default=None, help="only .err files last written before this local time (2026-10-07T18:20), so a re-run reads the same set while lanes are still writing")
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--image", default=None)
    ap.add_argument("--lint", type=Path, default=None, help="a dist/ directory to re-lint the drops with")
    ap.add_argument("--json", type=Path, default=None)
    ap.add_argument("--reason", default=None, help="print every record of this reason")
    ap.add_argument("--reuse", type=Path, default=None, help="take --run results from an earlier --json instead of running again")
    a = ap.parse_args(argv)
    recs = collect(dt.date.fromisoformat(a.since), until=dt.datetime.fromisoformat(a.until) if a.until else None)
    if a.reuse:
        saved = {(r["err"], r["name"], r["run"], r["where"]): r.get("exec") for r in json.loads(a.reuse.read_text())}
        for r in recs:
            if saved.get((r["err"], r["name"], r["run"], r["where"])):
                r["exec"] = saved[(r["err"], r["name"], r["run"], r["where"])]
    if a.run:
        image = a.image or subprocess.run(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}", "maat-bench"],
                                          capture_output=True, text=True, check=True).stdout.split()[0]
        print(f"running {sum(1 for r in recs if r['run'])} commands in {image}", file=sys.stderr)
        run_all(recs, image)
    if a.lint:
        relint(recs, a.lint)
    by = collections.defaultdict(list)
    for r in recs:
        by[r["reason"]].append(r)
    lanes = len({r["lane"] for r in recs})
    print(f"{len(recs)} drop lines in {lanes} lanes since {a.since}{f' until {a.until}' if a.until else ''} ({len({(r['lane'], r['task'], r['name'], r['run']) for r in recs})} distinct)\n")
    hdr = f"{'reason':28} {'lines':>5} {'uniq':>5}"
    if a.run or a.reuse:
        hdr += f" {'good':>5} {'pass-bef':>8} {'n/a':>4}"
    if a.lint:
        hdr += f" {'still':>5} {'guard':>5}"
    print(hdr)
    for reason, rs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        uniq = {(r["lane"], r["task"], r["name"], r["run"]) for r in rs}
        line = f"{reason:28} {len(rs):5} {len(uniq):5}"
        if a.run or a.reuse:
            vs = collections.Counter(verdict(r) for r in rs)
            line += f" {vs['good']:5} {vs['passes-before']:8} {vs['n/a']:4}"
        if a.lint:
            st = [still_dropped(r) for r in rs]
            line += f" {sum(1 for s in st if s):5}" if any(s is not None for s in st) else f" {'-':>5}"
            g = sum(1 for r in rs if r["reason"] == "P1-passes-before-work" and (r.get("relint") or {}).get("guard"))
            line += f" {g:5}" if reason == "P1-passes-before-work" else f" {'-':>5}"
        print(line)
    print()
    for reason, rs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        pick = rs if a.reason == reason else rs[: a.samples]
        print(f"== {reason} ({len(rs)})")
        for r in pick:
            v = f" [{verdict(r)}]" if (a.run or a.reuse) else ""
            print(f"   {r['lane']}/{r['task']} {r['name']}{v}: {short(r['run'] or '')}")
            print(f"      → {short(r['why'], 160)}")
    if a.json:
        a.json.write_text(json.dumps(recs, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
