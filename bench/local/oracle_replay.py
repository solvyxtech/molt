"""
Offline replay: do drafted checks tell right work from wrong work?

For every local task, take the saved workspaces (any agent, any rep) and the
hidden grader's verdict on each, plus a pristine copy (no work done). Then:

  A  today's drafter + critic (dist/criteria.js draftCriteriaCritiqued)
  B  an independent reference check (ORACLE_SYSTEM below): a fresh model sees
     the task text and the original files only, writes the most literal
     reference it can and a harness that compares the deliverable to it.

Each check set is run in a copy of every workspace. A set "accepts" a
workspace when every check passes. Reported per arm:
  wrong work accepted   (false verified — the thing to drive to zero)
  right work refused    (underclaim)
  pristine accepted     (a check that cannot tell no work from work)

    python3 oracle_replay.py [--arms A,B] [--tasks a,b] [--snap DIR] [--out FILE]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tasks import TASKS  # noqa: E402
from tasks2 import TASKS2  # noqa: E402
from tasks3 import TASKS3  # noqa: E402
from run import openrouter_key  # noqa: E402

REPO = HERE.parent.parent
MODEL = os.environ.get("REPLAY_MODEL", "nvidia/nemotron-3-ultra-550b-a55b:free")
SKIP = {".git", ".maat", ".molt", "node_modules", "__pycache__", ".venv"}

ORACLE_SYSTEM = (REPO / "bench/local/oracle_prompt.txt").read_text() if (REPO / "bench/local/oracle_prompt.txt").exists() else ""


def ask(system: str, prompt: str, key: str, max_tokens: int = 16000) -> str:
    body = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "reasoning": {"effort": os.environ.get("REPLAY_EFFORT", "low")},
    }
    for attempt in range(7):
        try:
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions",
                data=json.dumps(body).encode(),
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=300) as r:
                j = json.load(r)
            text = (j["choices"][0]["message"].get("content") or "").strip()
            if text:
                return text
        except Exception as e:  # noqa: BLE001
            print(f"  ask failed ({attempt}): {e}", file=sys.stderr)
        time.sleep(5 * (attempt + 1))
    return ""


def listing(d: Path, limit: int = 40) -> str:
    out = []
    for p in sorted(d.rglob("*")):
        rel = p.relative_to(d)
        if any(part in SKIP for part in rel.parts) or not p.is_file():
            continue
        head = ""
        try:
            t = p.read_text()
            head = "\n".join(t.splitlines()[:8])
        except (UnicodeDecodeError, OSError):
            head = "(binary)"
        out.append(f"--- {rel} ({p.stat().st_size} bytes)\n{head}")
        if len(out) >= limit:
            break
    return "\n".join(out) or "(empty)"


def parse_json(text: str):
    body = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```")
    s, e = body.find("{"), body.rfind("}")
    if s < 0 or e < 0:
        return None
    try:
        return json.loads(body[s : e + 1])
    except json.JSONDecodeError:
        return None


def oracle_for(T, pristine: Path, key: str, store: Path) -> dict:
    """Arm B: ask for a reference check; files land in store/, inputs snapshotted to store/before."""
    prompt = f"TASK TEXT:\n{T.PROMPT}\n\nFILES IN THE PROJECT BEFORE ANY WORK:\n{listing(pristine)}"
    text = ask(ORACLE_SYSTEM, prompt, key)
    j = parse_json(text) or {}
    if not j.get("applies"):
        return {"applies": False, "reason": j.get("reason", "") or text[:200]}
    store.mkdir(parents=True, exist_ok=True)
    shutil.copytree(pristine, store / "before", ignore=shutil.ignore_patterns(*SKIP), dirs_exist_ok=True)
    files = j.get("files") or {}
    for name, content in files.items():
        if "/" in name or name.startswith("."):
            continue
        (store / name).write_text(content)
    run = (j.get("run") or "").replace("{ORACLE}", str(store))
    return {"applies": True, "run": run, "files": list(files)}


def product_reference_for(T, pristine: Path, key: str) -> dict:
    """Arm C: the shipped src/reference.ts, through the built dist (snapshot, write, try, one retry)."""
    js = f"""
import {{ draftReference, snapshotProject }} from '{REPO}/dist/reference.js';
const snapshot = snapshotProject({json.dumps(str(pristine))});
const r = snapshot ? await draftReference({{ task: {json.dumps(T.PROMPT)}, snapshot,
  baseUrl: 'https://openrouter.ai/api/v1', apiKey: process.env.K, model: {json.dumps(MODEL)}, reasoningEffort: 'low' }}) : {{ ok: false, why: 'no snapshot' }};
process.stdout.write(JSON.stringify(r.ok ? {{ applies: true, run: r.check.run, reason: r.reason }} : {{ applies: false, reason: r.why }}));
"""
    p = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, env=os.environ | {"K": key}, timeout=1200)
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"applies": False, "reason": f"node failed: {p.stderr[-300:]}"}


def drafted_for(T, pristine: Path, key: str) -> list[dict]:
    """Arm A: today's drafter + critic, through the built dist."""
    js = f"""
import {{ draftCriteriaCritiqued, commandsHere }} from '{REPO}/dist/criteria.js';
const r = await draftCriteriaCritiqued({{
  task: {json.dumps(T.PROMPT)}, scripts: [], barChecks: [],
  baseUrl: 'https://openrouter.ai/api/v1', apiKey: process.env.K, model: {json.dumps(MODEL)},
  reasoningEffort: 'low', commands: commandsHere({json.dumps(str(pristine))}), cwd: {json.dumps(str(pristine))},
}});
process.stdout.write(JSON.stringify(r));
"""
    p = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, env=os.environ | {"K": key}, timeout=600)
    try:
        r = json.loads(p.stdout)
    except json.JSONDecodeError:
        return []
    return r.get("draft", {}).get("checks", []) if r.get("ok") else []


def real_work(ws: Path) -> bool:
    """A workspace whose run died on the provider (e.g. a withdrawn model) holds no work to judge."""
    log = ws.with_name(ws.name + ".log")
    return not (log.exists() and "No endpoints found" in log.read_text(errors="replace"))


def run_check(run: str, d: Path, timeout: int = 120) -> tuple[int, str]:
    try:
        p = subprocess.run(run, shell=True, cwd=d, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr)[-600:]
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def judge(checks: list[str], ws: Path) -> tuple[bool, list]:
    tmp = Path(tempfile.mkdtemp(prefix="replay-"))
    try:
        shutil.copytree(ws, tmp / "w", symlinks=True)
        outs = [run_check(c, tmp / "w") for c in checks]
        return all(code == 0 for code, _ in outs), outs
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--arms", default="A,B")
    ap.add_argument("--tasks")
    ap.add_argument("--snap", default=os.environ.get("SNAP", str(Path.home() / ".cache/maat-bench/work")))
    ap.add_argument("--out", default=str(HERE / "oracle-replay.jsonl"))
    ap.add_argument("--tag", default="")
    a = ap.parse_args()
    key = openrouter_key()
    snap = Path(a.snap)
    arms = a.arms.split(",")
    tasks = [T for T in TASKS + TASKS2 + TASKS3 if not a.tasks or T.name in a.tasks.split(",")]
    root = Path(tempfile.mkdtemp(prefix="oracle-replay-"))
    for T in tasks:
        wss = sorted(p for p in snap.glob(f"{T.name}-*-[0-9]") if p.is_dir() and real_work(p))
        if not wss:
            continue
        pristine = root / T.name / "pristine"
        pristine.mkdir(parents=True)
        T.setup(pristine)
        labels = {ws.name: T.grade(ws)[0] for ws in wss}
        for arm in arms:
            t0 = time.time()
            if arm == "A":
                checks = [c["run"] for c in drafted_for(T, pristine, key)]
                meta = {"checks": checks}
            elif arm == "C":
                o = product_reference_for(T, pristine, key)
                checks = [o["run"]] if o.get("applies") and o.get("run") else []
                meta = o
            else:
                o = oracle_for(T, pristine, key, root / T.name / "oracle")
                checks = [o["run"]] if o.get("applies") and o.get("run") else []
                meta = o
            draft_s = round(time.time() - t0)
            ok0, out0 = judge(checks, pristine) if checks else (True, [])
            # Preflight: a check that reports its OWN bug (exit 3) on the
            # untouched project is dropped before work, as the engine would.
            if arm == "B" and checks and out0 and out0[0][0] == 3:
                meta["dropped_at_preflight"] = out0[0][1][-300:]
                checks = []
                ok0, out0 = True, []
            rows = []
            for ws in wss:
                acc, outs = judge(checks, ws) if checks else (True, [])
                rows.append({"ws": ws.name, "right": labels[ws.name], "accepted": acc, "out": [o[1][-300:] for o in outs if o[0] != 0][:1]})
            rec = {"tag": a.tag, "task": T.name, "arm": arm, "draft_s": draft_s, "n_checks": len(checks), "pristine_accepted": ok0, "pristine_out": [o[1][-200:] for o in out0][:1], "rows": rows, "meta": meta}
            with open(a.out, "a") as f:
                f.write(json.dumps(rec) + "\n")
            wa = sum(1 for r in rows if not r["right"] and r["accepted"])
            wn = sum(1 for r in rows if not r["right"])
            rr = sum(1 for r in rows if r["right"] and not r["accepted"])
            rn = sum(1 for r in rows if r["right"])
            print(f"{T.name:22} {arm}  checks={len(checks)}  wrong accepted {wa}/{wn}  right refused {rr}/{rn}  pristine {'ACCEPTED' if ok0 else 'refused'}  ({draft_s}s)", flush=True)


if __name__ == "__main__":
    main()
