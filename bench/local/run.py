"""
Run molt and Droid on the same local tasks, same model and effort, and
compare how they behave. Graders are hidden in tasks.py.

    python3 run.py [molt|droid|both]
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

from tasks import TASKS

HERE = Path(__file__).resolve().parent
# Outside every git repository: a task folder inside this one let agents'
# `git commit` walk up and commit task files into molt-desktop's main.
WORK = Path(os.environ.get("BENCH_WORK", Path.home() / ".cache/maat-bench/work"))
MOLT = Path.home() / os.environ.get("MOLT_DIST", "Documents/molt-desktop/dist-compare") / "cli.js"
DROID = Path.home() / ".local/bin/droid"
LIMIT = 600  # seconds per task


def openrouter_key() -> str:
    return subprocess.run(
        ["node", "-e", "import('%s').then(m=>process.stdout.write(m.readAuth().openrouter||''))" % (Path.home() / "Documents/molt-desktop/dist/providers.js")],
        capture_output=True, text=True,
    ).stdout


def run_molt(d: Path, prompt: str, log: Path) -> dict:
    env = os.environ | {"MOLT_API_KEY": openrouter_key(), "MOLT_JUDGMENT": "0"}  # nobody rules on a benchmark run
    cmd = [
        "node", str(MOLT), "run", "--url", "https://openrouter.ai/api/v1", "--model", "stealth/space-bunny-alpha",
        "--reasoning", "low", "--yes", "--json", "--criteria", "auto", "--batch", "--review", "3", "--steps", "200", "--cwd", str(d), prompt,
    ]
    t0 = time.time()
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=LIMIT, env=env).stdout
        timed_out = False
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        timed_out = True
    secs = time.time() - t0
    log.write_text(out)
    steps = 0; per = []; outcome = None; spend = {}; review = None; disagree = []
    for line in out.splitlines():
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("kind") == "step_summary":
            steps += 1
            per.append(len(ev.get("tools") or []))
        elif ev.get("kind") == "job_end":
            outcome = ev.get("outcome") + (" (self-checked)" if ev.get("selfChecked") else "")
            spend = ev.get("spend") or {}
            review = ev.get("review")
            disagree = ev.get("checksDisagree") or []
    return {
        "secs": round(secs), "turns": steps, "calls": sum(per), "multi": sum(1 for x in per if x > 1),
        "tokens_in": spend.get("promptTokens"), "claim": outcome, "timed_out": timed_out,
        "said_done": (outcome or "").startswith("verified"),
        # The reviewer's label: a verified claim it did not confirm.
        "review": review,
        # Refused only by molt's own drafted checks (reported unverified).
        "checks_disagree": disagree,
        "said_done_reviewed": (outcome or "").startswith("verified") and not (review and not review.get("confirmed")),
    }


def run_droid(d: Path, prompt: str, log: Path) -> dict:
    cmd = [str(DROID), "exec", "--auto", "high", "-m", "custom:space-bunny-alpha", "-r", "low", "-o", "stream-json", "--cwd", str(d), prompt]
    t0 = time.time()
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=LIMIT).stdout
        timed_out = False
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        timed_out = True
    secs = time.time() - t0
    log.write_text(out)
    by_msg = Counter(); tools = Counter(); comp = {}
    for line in out.splitlines():
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "tool_call":
            by_msg[ev.get("messageId")] += 1
            tools[ev.get("toolName")] += 1
        elif ev.get("type") == "completion":
            comp = ev
    u = comp.get("usage") or {}
    return {
        "secs": round(secs), "turns": comp.get("numTurns"), "calls": sum(by_msg.values()),
        "multi": sum(1 for v in by_msg.values() if v > 1), "tokens_in": (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0),
        "claim": "finished" if comp else "no completion", "timed_out": timed_out, "said_done": bool(comp),
        "tools": dict(tools), "credits": u.get("factory_credits"),
    }


def claims_done(text: str) -> bool:
    """
    Whether a final message says the work is done, by one fixed rule applied
    to both agents: a hedge or failure word wins over a success word.
    """
    t = (text or "").lower()
    hedges = ("not proven", "could not", "couldn't", "unable", "failed", "not verified", "unverified",
              "did not", "didn't", "still fails", "not able", "incomplete", "blocked", "not done", "partially")
    if any(h in t for h in hedges):
        return False
    return any(w in t for w in ("done", "complete", "fixed", "merged", "created", "wrote", "implemented",
                                "passes", "passing", "finished", "works", "added", "updated", "written"))


def main(which: str, repeats: int, task_filter: str | None) -> None:
    from tasks2 import TASKS2  # noqa: PLC0415
    agents = {"molt": run_molt, "droid": run_droid}
    chosen = list(agents) if which == "both" else [which]
    # AGENTS=droid limits a "both" run to some agents while keeping its results file.
    if os.environ.get("AGENTS"):
        chosen = [a for a in chosen if a in os.environ["AGENTS"].split(",")]
    tasks = [T for T in TASKS + TASKS2 if not task_filter or T.name in task_filter.split(",")]
    out = HERE / os.environ.get("RESULTS", f"results-{which}-x{repeats}.jsonl")
    done = set()
    if out.exists():  # resume: skip runs already recorded
        for line in out.read_text().splitlines():
            r = json.loads(line)
            done.add((r["task"], r["agent"], r["rep"]))
    for rep in range(repeats):
        for T in tasks:
            for a in chosen:
                if (T.name, a, rep) in done:
                    continue
                d = WORK / f"{T.name}-{a}-{rep}"
                shutil.rmtree(d, ignore_errors=True)
                d.mkdir(parents=True)
                T.setup(d)
                r = agents[a](d, T.PROMPT, WORK / f"{T.name}-{a}-{rep}.log")
                ok, why = T.grade(d)
                final = ""
                if a == "droid":
                    for line in (WORK / f"{T.name}-{a}-{rep}.log").read_text(errors="replace").splitlines():
                        if line.startswith("{") and '"completion"' in line:
                            try:
                                final = json.loads(line).get("finalText") or ""
                            except json.JSONDecodeError:
                                pass
                    r["said_done"] = claims_done(final)
                r.update(task=T.name, agent=a, rep=rep, passed=ok, why=why, final=final[:300])
                with out.open("a") as f:
                    f.write(json.dumps(r) + "\n")
                print(json.dumps({k: r[k] for k in ("task", "agent", "rep", "passed", "said_done", "turns", "secs")}), flush=True)
                # Stop on the first Factory credit: BYOK is free only up to an allowance.
                if a == "droid" and (r.get("credits") or 0) > 0:
                    print(f"STOPPED: Droid reported factory_credits={r.get('credits')}", flush=True)
                    return


if __name__ == "__main__":
    args = sys.argv[1:]
    which = args[0] if args else "both"
    repeats = int(args[1]) if len(args) > 1 else 1
    main(which, repeats, args[2] if len(args) > 2 else None)
