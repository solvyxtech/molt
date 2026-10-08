"""
Bet 1 offline experiment (reports/frontier-2026-10-06.md): cross-check every run's
sealed drafted checks against every other run's final tree, and simulate the
"retire a drafted check on independent evidence" rule. No model calls, no network.

    python3 crosscheck.py inventory          # list runs/trees found (writes the cache index)
    python3 crosscheck.py execute [-j 6]     # one container per tree: grade + every distinct check of its task
    python3 crosscheck.py analyze [--md out] # matrices, retire rule, precision/recall

Trees are never modified: each is bind-mounted read-only into a throwaway
`maat-bench` container (network off, memory/pids capped) which copies it to
/work/<folder> (the path the run had) and runs the hidden grader and each check on
a fresh copy, so one check's side effects (git checkout, rm) cannot leak into the
next. Results are cached per tree in ~/.cache/maat-bench/crosscheck/ (resumable).

Retire rule (per run R, per drafted check c in R's sealed set):
  witnesses = trees of OTHER runs of the same task that fail c AND pass every other
              check of R's set;
  c is retired when >=2 witnesses fail with the same output signature
  (variant "strict": the witnesses must also differ in content from each other and
  from R's own tree). R's verdict is recomputed with retired checks removed.
"""

from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache/maat-bench"
RES = CACHE / "container-results"
WORK = CACHE / "container-work"
OUT = CACHE / "crosscheck"
IMAGE = "maat-bench"
CHECK_TIMEOUT = 20

# results file stem -> where its trees live
SETS = [
    "fail5", "grok-fix", "grok-smoke", "grok-smoke2", "grok-smoke3", "grok1", "m8b", "m8b2",
    "q2-base", "q3-base", "q4-fix", "v9-new", "v9-old", "v10-fix", "v10-old", "v11-new", "v11-old",
    "v12-new", "v12-old", "gem1", "sub-gemini", "sub-grok",
]


# ------------------------------------------------------------------ inside the container
def inside(job_path: str = "/job.json", src: str = "/src", work: str = "/work") -> None:
    sys.path.insert(0, str(HERE))
    job = json.load(open(job_path))
    from tasks import TASKS  # noqa: PLC0415
    from tasks2 import TASKS2  # noqa: PLC0415

    import run  # noqa: PLC0415  (the grading helpers run.py grades with)

    by = {T.name: T for T in TASKS + TASKS2}
    # No safe.directory=*: the trees are agent-written, and their .git/config (core.fsmonitor,
    # hooks, filters, diff drivers) would run as root. The grader grades a sanitized root-owned
    # copy exactly as run.py does (run.grade_safely: config cut to the format lines, hooks and
    # attributes removed, git started without system or global config). The checks run on a
    # root-owned copy whose repositories are sanitized the same way (run.sanitized_copy).
    dst = Path(work) / job["name"]

    def fresh() -> Path:
        shutil.rmtree(dst, ignore_errors=True)
        dst.parent.mkdir(parents=True, exist_ok=True)
        return run.sanitized_copy(Path(src), dst)

    res: dict = {"name": job["name"], "checks": {}}
    try:
        d = fresh()
        ok, why = run.grade_safely(by[job["task"]], d)
        res["grade"] = [bool(ok), str(why)[:300]]
    except Exception as e:  # noqa: BLE001
        res["grade"] = [None, f"grader crashed: {e}"[:300]]
    for cmd in job["checks"]:
        d = fresh()
        # a check names the folder of the run that drafted it (/work/<task>-molt-<n>); in another
        # run's tree that path must mean "this tree", or every foreign tree fails it spuriously
        # (runs since 2026-10-07 have a private folder: /var/lib/bench-work/<random>/<task>-molt-<n>)
        run_cmd = re.sub(r"(?:/var/lib/bench-work/[0-9a-f]+|/work)/[\w.-]+-molt-\d+", str(dst), cmd)
        p = subprocess.Popen(run_cmd, shell=True, cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            out, _ = p.communicate(timeout=CHECK_TIMEOUT)
            rc = p.returncode
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except Exception:  # noqa: BLE001
                pass
            out, _ = p.communicate()
            rc = 124
        try:
            os.killpg(p.pid, signal.SIGKILL)  # leave no server behind
        except Exception:  # noqa: BLE001
            pass
        res["checks"][cmd] = {"rc": rc, "out": out.decode("utf8", "replace")[:600]}
    print("@@RESULT@@" + json.dumps(res))


# ------------------------------------------------------------------ inventory (host)
def tree_hash(d: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(d.rglob("*")):
        rel = p.relative_to(d)
        if rel.parts[0] in (".maat", ".git") or "__pycache__" in rel.parts or "node_modules" in rel.parts:
            continue
        if p.is_file() and not p.is_symlink():
            h.update(str(rel).encode())
            try:
                h.update(p.read_bytes())
            except OSError:
                pass
    return h.hexdigest()[:12]


def journal_info(d: Path) -> dict:
    """Sealed drafted checks (name -> command) from bar_run events, last bar's failures, tokens."""
    checks: dict[str, str] = {}
    last = None
    tokens = 0
    nbar = 0
    for p in sorted((d / ".maat/log").glob("*.jsonl")) if (d / ".maat/log").is_dir() else []:
        for line in p.read_text(errors="replace").splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            k = e.get("kind")
            if k == "response":
                tokens += e["data"].get("promptTokens", 0) or 0
            elif k == "bar_run":
                nbar += 1
                last = e["data"]
                for c in e["data"]["checks"]:
                    checks[c["name"]] = c["detail"]
    info = {"checks": checks, "nbar": nbar, "tokens": tokens}
    if last:
        info["last_ok"] = bool(last["ok"])
        info["last_failed_names"] = [c["name"] for c in last["checks"] if not c["ok"]]
        info["first_ok"] = None
    return info


def find_tree(stem: str, row: dict) -> Path | None:
    name = f"{row['task']}-{row.get('agent', 'molt')}-{row['rep']}"
    if stem in ("gem1", "sub-gemini", "sub-grok"):
        p = CACHE / f"work-{stem}" / name
        return p if p.is_dir() else None
    cands = [WORK / d / name for d in sorted(os.listdir(WORK)) if (d == stem or d.startswith(stem + "-")) and (WORK / d / name).is_dir()]
    if len(cands) <= 1:
        return cands[0] if cands else None
    for c in cands:  # two shards ran the same task/rep: the one whose journal matches the row
        if journal_info(c)["tokens"] == row.get("tokens_in"):
            return c
    shard = [c for c in cands if re.search(r"-s\d+$", c.parent.name)]
    return (shard or cands)[0]


def build_inventory() -> list[dict]:
    runs = []
    for stem in SETS:
        f = RES / f"results-{stem}.jsonl"
        if not f.exists():
            continue
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("agent", "molt") != "molt":
                continue
            d = find_tree(stem, r)
            if d is None:
                continue
            ji = journal_info(d)
            runs.append({
                "id": f"{stem}/{r['task']}-{r['rep']}", "set": stem, "task": r["task"], "rep": r["rep"],
                "dir": str(d), "grader_row": r["passed"], "claim": r.get("claim"), "tier": r.get("tier"),
                "review": r.get("review"), "checks_disagree": r.get("checks_disagree"),
                "hash": tree_hash(d), **ji,
            })
    return runs


def load_inventory() -> list[dict]:
    OUT.mkdir(parents=True, exist_ok=True)
    idx = OUT / "inventory.json"
    if idx.exists():
        return json.loads(idx.read_text())
    runs = build_inventory()
    idx.write_text(json.dumps(runs))
    return runs


def safe(i: str) -> str:
    return i.replace("/", "__")


# ------------------------------------------------------------------ execute (host)
def exec_tree(run: dict, cmds: list[str]) -> str:
    out = OUT / "trees" / (safe(run["id"]) + ".json")
    old = None
    if out.exists():
        old = json.loads(out.read_text())
        if old.get("pathfix"):
            if set(cmds) <= set(old["checks"]):
                return "cached"
        else:  # results from before the /work/<folder> rewrite: redo only commands that name such a path
            cmds = [c for c in cmds if "/work/" in c or "/var/lib/bench-work/" in c]
            if not cmds:
                old["pathfix"] = True
                out.write_text(json.dumps(old))
                return "cached"
    with tempfile.TemporaryDirectory() as td:
        job = Path(td) / "job.json"
        job.write_text(json.dumps({"name": Path(run["dir"]).name, "task": run["task"], "checks": cmds}))
        try:
            p = subprocess.run(
                ["docker", "run", "--rm", "--network", "none", "--memory", "1g", "--pids-limit", "512",
                 "-v", f"{HERE}:/bench:ro", "-v", f"{run['dir']}:/src:ro", "-v", f"{job}:/job.json:ro",
                 IMAGE, "python3", "/bench/crosscheck.py", "--inside"],
                capture_output=True, text=True, timeout=60 + CHECK_TIMEOUT * (len(cmds) + 2) * 2)
            txt = p.stdout
        except subprocess.TimeoutExpired:
            return "container-timeout"
    m = re.search(r"@@RESULT@@(.*)", txt)
    if not m:
        return "no-result: " + (p.stderr or txt)[-200:]
    new = json.loads(m.group(1))
    if old is not None:  # merge: keep earlier results for commands not re-run
        old["checks"].update(new["checks"])
        new = old
    new["pathfix"] = True
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(new))
    return "ok"


def execute(jobs: int) -> None:
    runs = load_inventory()
    cmds_by_task: dict[str, set[str]] = collections.defaultdict(set)
    for r in runs:
        cmds_by_task[r["task"]].update(r["checks"].values())
    todo = [(r, sorted(cmds_by_task[r["task"]])) for r in runs]
    print(f"{len(runs)} trees, {sum(len(v) for v in cmds_by_task.values())} distinct (task,check) commands", flush=True)
    done = 0
    with cf.ThreadPoolExecutor(jobs) as ex:
        futs = {ex.submit(exec_tree, r, c): r for r, c in todo}
        for f in cf.as_completed(futs):
            done += 1
            s = f.result()
            if s not in ("ok", "cached"):
                print("  !", futs[f]["id"], s, flush=True)
            if done % 25 == 0:
                print(f"  {done}/{len(todo)}", flush=True)


# ------------------------------------------------------------------ analysis
def sig(rc: int, out: str, run_name: str) -> str:
    o = re.sub(r"(?:/var/lib/bench-work/[0-9a-f]+|/work)/[\w.-]+", "/work/T", out)
    o = re.sub(r"0x[0-9a-f]+|\b[0-9a-f]{7,40}\b", "H", o)
    o = re.sub(r"\d{4,}", "N", o)
    o = re.sub(r"\s+", " ", o).strip()[:300]
    return f"{rc}|{o}"


def analyze(md_out: str | None) -> None:
    runs = load_inventory()
    res: dict[str, dict] = {}
    for r in runs:
        p = OUT / "trees" / (safe(r["id"]) + ".json")
        if p.exists():
            res[r["id"]] = json.loads(p.read_text())
    runs = [r for r in runs if r["id"] in res]
    for r in runs:
        g = res[r["id"]]["grade"][0]
        r["grader"] = r["grader_row"] if g is None else g
        r["grade_rerun"] = g
        r["verified"] = bool(r["claim"] and r["claim"].startswith("verified"))
    L: list[str] = []
    out = L.append

    gdis = [r for r in runs if r["grade_rerun"] is not None and r["grade_rerun"] != r["grader_row"]]
    out(f"Trees analysed: {len(runs)}; grader re-run disagrees with the recorded verdict on {len(gdis)}"
        + (": " + ", ".join(r["id"] for r in gdis[:12]) if gdis else "") + ".")

    # matrix: task -> cmd -> run id -> (ok, sig)
    M: dict[str, dict[str, dict[str, tuple[bool, str]]]] = collections.defaultdict(lambda: collections.defaultdict(dict))
    for r in runs:
        for cmd, v in res[r["id"]]["checks"].items():
            M[r["task"]][cmd][r["id"]] = (v["rc"] == 0, sig(v["rc"], v["out"], r["id"]))
    by_task: dict[str, list[dict]] = collections.defaultdict(list)
    for r in runs:
        by_task[r["task"]].append(r)

    # per-run simulation
    insts = []  # one per (run, drafted check)
    for r in runs:
        if not r["checks"]:
            continue
        t = r["task"]
        cmds = sorted(set(r["checks"].values()))
        name_of = {v: k for k, v in r["checks"].items()}
        for c in cmds:
            own = M[t][c].get(r["id"])
            others = [o for o in by_task[t] if o["id"] != r["id"] and o["id"] in M[t][c]]
            wit = []
            for o in others:
                ok, sg = M[t][c][o["id"]]
                if ok:
                    continue
                if all(M[t][c2].get(o["id"], (False,))[0] for c2 in cmds if c2 != c):
                    wit.append((o, sg))
            groups = collections.defaultdict(list)
            for o, sg in wit:
                groups[sg].append(o)
            best = max(groups.values(), key=len) if groups else []
            retired = len(best) >= 2
            strict_w = {o["hash"] for o in best if o["hash"] != r["hash"]}
            retired_strict = len(strict_w) >= 2
            ngp = sum(1 for o in best if o["grader"])
            insts.append({
                "run": r["id"], "task": t, "name": name_of[c], "cmd": c, "own_fail": own is not None and not own[0],
                "own_grader": r["grader"], "retired": retired, "retired_strict": retired_strict,
                "n_witness": len(best), "n_witness_pass": ngp, "n_other_trees": len(others),
            })

    # global check label: fails >=1 grader-passing tree = wrong ; fails only grader-failing = right
    glabel = {}
    for t, cm in M.items():
        gp = {r["id"] for r in by_task[t] if r["grader"]}
        gf = {r["id"] for r in by_task[t] if not r["grader"]}
        for c, row in cm.items():
            F = {i for i, (ok, _) in row.items() if not ok}
            if not F:
                glabel[(t, c)] = "never-fails"
            elif F & gp:
                glabel[(t, c)] = "wrong"
            else:
                glabel[(t, c)] = "right-exact" if F == gf & set(row) else "right-partial"

    # ---- headline: refusals by own tree
    ref = [i for i in insts if i["own_fail"]]
    wrong_ref = [i for i in ref if i["own_grader"]]
    right_ref = [i for i in ref if not i["own_grader"]]

    def rate(xs, key):
        return f"{sum(1 for i in xs if i[key])}/{len(xs)} ({100 * sum(1 for i in xs if i[key]) / max(1, len(xs)):.0f}%)"

    out("\n## Retire rule on refusing checks (check fails its own run's final tree)\n")
    out("| class | instances | retired (rule) | retired (strict: distinct trees) |")
    out("|---|---|---|---|")
    out(f"| wrong refusal (own tree grader-PASS) | {len(wrong_ref)} | {rate(wrong_ref, 'retired')} | {rate(wrong_ref, 'retired_strict')} |")
    out(f"| right refusal (own tree grader-FAIL) | {len(right_ref)} | {rate(right_ref, 'retired')} | {rate(right_ref, 'retired_strict')} |")
    # global labelling
    gl = collections.Counter(glabel[(i["task"], i["cmd"])] for i in ref)
    out(f"\nRefusing instances by global check label (check fails some grader-passing tree = wrong): {dict(gl)}")
    for lab in ("wrong", "right-exact", "right-partial"):
        xs = [i for i in ref if glabel[(i["task"], i["cmd"])] == lab]
        out(f"- global {lab}: {len(xs)} instances, retired {rate(xs, 'retired')}, strict {rate(xs, 'retired_strict')}")

    # ---- verdict recompute
    out("\n## Verdicts before / after\n")
    inst_by_run = collections.defaultdict(dict)
    for i in insts:
        inst_by_run[i["run"]][i["name"]] = i
    for variant, key in (("rule", "retired"), ("strict", "retired_strict")):
        tp = fp = fn = tn = 0
        rescued_good = []
        rescued_bad = []
        for r in runs:
            v = r["verified"]
            after = v
            if not v and r.get("nbar") and r.get("last_ok") is False and r["last_failed_names"]:
                ii = inst_by_run[r["id"]]
                if all(n in ii and ii[n][key] for n in r["last_failed_names"]):
                    after = True
                    (rescued_good if r["grader"] else rescued_bad).append(r)
            tp += after and r["grader"]; fp += after and not r["grader"]
            fn += (not after) and r["grader"]; tn += (not after) and not r["grader"]
            if variant == "rule":
                r["_after"] = after
        # before
        btp = sum(1 for r in runs if r["verified"] and r["grader"]); bfp = sum(1 for r in runs if r["verified"] and not r["grader"])
        P = sum(1 for r in runs if r["grader"])
        out(f"**{variant}**: runs {len(runs)}, grader-pass {P}. Before: verified {btp + bfp} (TP {btp}, FP {bfp}) precision {100 * btp / max(1, btp + bfp):.0f}% recall {100 * btp / max(1, P):.0f}%."
            f" After: verified {tp + fp} (TP {tp}, FP {fp}) precision {100 * tp / max(1, tp + fp):.0f}% recall {100 * tp / max(1, P):.0f}%."
            f" Rescued grader-pass: {len(rescued_good)}; false-done introduced (grader-FAIL now verified): {len(rescued_bad)}.")
        out("  rescued-good: " + ", ".join(sorted(r["id"] for r in rescued_good)))
        out("  false-done:   " + ", ".join(sorted(r["id"] for r in rescued_bad)))
        if variant == "rule":
            refused_pass = [r for r in runs if r["grader"] and not r["verified"] and r.get("last_ok") is False]
            out(f"  grader-pass runs whose last bar refused them: {len(refused_pass)}; of these rescued {len(rescued_good)}")
            rr = [r for r in rescued_good + rescued_bad if (r.get("review") or {}).get("confirmed") and (r["review"].get("votes") or "0/3")[0] != "0"]
            out(f"  rescued runs whose independent review contradicted the task: {len(rr)}")

    # ---- per task
    out("\n## Per task\n")
    out("| task | trees | grader pass | distinct trees | runs w/ checks | distinct checks | refusing inst. | wrong-ref retired | right-ref retired | rescued good | false-done |")
    out("|---|---|---|---|---|---|---|---|---|---|---|")
    for t in sorted(by_task):
        rs = by_task[t]
        ii = [i for i in insts if i["task"] == t]
        rf = [i for i in ii if i["own_fail"]]
        w = [i for i in rf if i["own_grader"]]
        rt = [i for i in rf if not i["own_grader"]]
        rg = rb = 0
        for r in rs:
            if r["verified"] or r.get("last_ok") is not False or not r["last_failed_names"]:
                continue
            m = inst_by_run[r["id"]]
            if all(n in m and m[n]["retired"] for n in r["last_failed_names"]):
                rg += r["grader"]; rb += not r["grader"]
        out(f"| {t} | {len(rs)} | {sum(r['grader'] for r in rs)} | {len({r['hash'] for r in rs})} | {sum(1 for r in rs if r['checks'])} | "
            f"{len({c for c in M[t]})} | {len(rf)} | {sum(i['retired'] for i in w)}/{len(w)} | {sum(i['retired'] for i in rt)}/{len(rt)} | {rg} | {rb} |")

    # ---- retired checks list
    out("\n## Retired checks (distinct task+command, refusing instances only)\n")
    out("| task | check | instances | retired | global label | own-grader pass/fail | fails grader-passing trees | fails grader-failing trees |")
    out("|---|---|---|---|---|---|---|---|")
    agg = collections.defaultdict(list)
    for i in ref:
        agg[(i["task"], i["cmd"])].append(i)
    for (t, c), xs in sorted(agg.items()):
        if not any(i["retired"] for i in xs):
            continue
        row = M[t][c]
        gp = {r["id"] for r in by_task[t] if r["grader"]}
        F = {k for k, (ok, _) in row.items() if not ok}
        out(f"| {t} | `{xs[0]['name']}`: `{c[:90].replace('|', '/')}` | {len(xs)} | {sum(i['retired'] for i in xs)} | {glabel[(t, c)]} | "
            f"{sum(i['own_grader'] for i in xs)}/{sum(not i['own_grader'] for i in xs)} | {len(F & gp)}/{len(gp & set(row))} | {len(F - gp)}/{len(set(row) - gp)} |")

    # right checks that got retired (the cost)
    out("\n## Right-refusal instances that the rule retires\n")
    for i in right_ref:
        if i["retired"]:
            out(f"- {i['run']} `{i['name']}`: {i['cmd'][:100]} (witnesses {i['n_witness']}, of which grader-pass {i['n_witness_pass']}, label {glabel[(i['task'], i['cmd'])]})")

    text = "\n".join(L)
    print(text)
    if md_out:
        Path(md_out).write_text(text + "\n")
    (OUT / "insts.json").write_text(json.dumps(insts))
    (OUT / "runs-analysed.json").write_text(json.dumps([{k: v for k, v in r.items() if k != "checks"} for r in runs]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default="analyze", choices=["inventory", "execute", "analyze"])
    ap.add_argument("-j", type=int, default=6)
    ap.add_argument("--md")
    ap.add_argument("--inside", action="store_true")
    a = ap.parse_args()
    if a.inside:
        return inside()
    if a.cmd == "inventory":
        (OUT / "inventory.json").unlink(missing_ok=True)
        runs = load_inventory()
        c = collections.Counter(r["task"] for r in runs)
        print(len(runs), "trees;", sum(1 for r in runs if r["checks"]), "with sealed checks")
        for t, n in sorted(c.items()):
            print(f"  {t}: {n}")
    elif a.cmd == "execute":
        execute(a.j)
    else:
        analyze(a.md)


if __name__ == "__main__":
    main()
