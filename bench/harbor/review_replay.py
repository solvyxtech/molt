#!/usr/bin/env python3
"""
Offline test of an independent claim reviewer, on trials molt already ran.

For every trial where molt said "verified", a fresh model context gets only
the task text and molt's receipt (what it claimed, wrote, ran and checked),
and must list requirements the task states that the evidence does not show
are met — each with a verbatim quote from the task. A quote that is not in
the task text is discarded (the model finds, a string match judges). The
reviewer "refuses" when at least one quoted requirement survives.

    python3 bench/harbor/review_replay.py jobs/<job> [jobs/<job> ...]

Needs OPENROUTER_API_KEY. Prints a confusion table against the hidden grader.
"""

from __future__ import annotations

import concurrent.futures as cf
import glob
import json
import os
import re
import sys
import urllib.request

MODEL = os.environ.get("REVIEW_MODEL", "stealth/space-bunny-alpha")
KEY = os.environ["OPENROUTER_API_KEY"]

SYSTEM = """You review a coding agent's claim that it finished a task. You did not do the work.
Your job is to find what is NOT done. Assume there is a bug and look for it.

You get the task text and a receipt: what the agent claimed, the lines it wrote,
the commands it ran, and the checks that passed.

List every requirement the TASK TEXT states that the receipt does not show is
satisfied: exact values, counts, thresholds, formats, paths, files that must or
must not exist, behaviours. Only list requirements the task text actually states.
Each item must quote the task text verbatim (a short exact phrase).

Reply with JSON only:
{"unmet": [{"quote": "exact phrase from the task", "why": "one sentence"}]}
Return {"unmet": []} if the receipt shows every stated requirement is met."""


SYSTEM_V2 = """You review a coding agent's claim that it finished a task. You did not do the work.
You get the task text and a receipt: what the agent claimed, the lines it wrote,
the commands it ran and their results, and the checks that passed.

Report a requirement ONLY if the receipt shows it is VIOLATED: a written line,
a command's output, or the claim itself contradicts something the task text
states (a wrong value, a wrong path or format, a missing required file, an
explicit constraint broken, a stated case not handled by the code shown).
Do NOT report a requirement just because the receipt does not mention it —
absence of evidence is not a violation. Quote the task text verbatim, and name
the receipt evidence that contradicts it.

Reply with JSON only:
{"violations": [{"quote": "exact phrase from the task", "evidence": "what in the receipt contradicts it"}]}
Return {"violations": []} if nothing in the receipt contradicts the task."""

MODE = os.environ.get("REVIEW_MODE", "v1")
VOTES = int(os.environ.get("REVIEW_VOTES", "1"))


def ask(prompt: str) -> str:
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "system", "content": SYSTEM_V2 if MODE == "v2" else SYSTEM}, {"role": "user", "content": prompt}],
        "max_tokens": 3000,
        "temperature": 0,
        "reasoning": {"effort": "low"},
    }).encode()
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"authorization": f"Bearer {KEY}", "content-type": "application/json"},
    )
    d = json.load(urllib.request.urlopen(req, timeout=180))
    return d["choices"][0]["message"].get("content") or ""


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def trial(d: str):
    rp = os.path.join(d, "result.json")
    log = os.path.join(d, "agent", "molt.jsonl")
    ins = os.path.join(d, "agent", "instruction.txt")
    rec = sorted(glob.glob(os.path.join(d, "agent", "record", "receipts", "*-accepted.md")))
    if not (os.path.isfile(rp) and os.path.isfile(log) and os.path.isfile(ins) and rec):
        return None
    outcome = None
    for line in open(log, errors="replace"):
        if line.startswith("{") and '"job_end"' in line:
            try:
                outcome = json.loads(line).get("outcome")
            except json.JSONDecodeError:
                pass
    if outcome != "verified":
        return None
    r = json.load(open(rp))
    reward = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    task = open(ins, errors="replace").read()
    receipt = open(rec[-1], errors="replace").read()
    # The receipt's raw output section is long and mostly noise for this.
    receipt = receipt.split("## Output")[0][:14000]
    prompt = f"TASK TEXT:\n{task}\n\nRECEIPT:\n{receipt}"
    t = norm(task)
    flags = 0
    kept: list = []
    raised = 0
    for _ in range(VOTES):
        try:
            reply = ask(prompt)
        except Exception as e:  # noqa: BLE001
            return {"task": r.get("task_name"), "passed": (reward or 0) >= 1, "error": str(e)[:120]}
        m = re.search(r"\{.*\}", reply, re.S)
        items = []
        if m:
            try:
                o = json.loads(m.group(0))
                items = o.get("violations") if MODE == "v2" else o.get("unmet")
                items = items or []
            except json.JSONDecodeError:
                items = []
        raised += len(items)
        k = [i for i in items if isinstance(i, dict) and len(norm(str(i.get("quote", "")))) >= 4 and norm(str(i.get("quote", ""))) in t]
        if k:
            flags += 1
            kept = kept or k
    # Majority: flagged only when more than half of the reviews found a
    # grounded violation.
    return {
        "task": r.get("task_name"),
        "passed": (reward or 0) >= 1,
        "raised": raised,
        "votes": f"{flags}/{VOTES}",
        "kept": kept,
        "refuse": flags * 2 > VOTES,
    }


def main(jobs):
    dirs = [d for j in jobs for d in sorted(glob.glob(os.path.join(j, "*/")))]
    rows = []
    with cf.ThreadPoolExecutor(int(os.environ.get("REVIEW_WORKERS", "4"))) as ex:
        for r in ex.map(trial, dirs):
            if not r:
                continue
            rows.append(r)
            # One line per review as it lands, so a stopped run keeps its work.
            print(json.dumps({k: v for k, v in r.items() if k != "kept"} | {"quotes": [k.get("quote") for k in r.get("kept", [])]}), flush=True)
    errs = [r for r in rows if "error" in r]
    rows = [r for r in rows if "error" not in r]
    tp = sum(1 for r in rows if r["refuse"] and not r["passed"])   # caught a false claim
    fp = sum(1 for r in rows if r["refuse"] and r["passed"])       # refused a true claim
    fn = sum(1 for r in rows if not r["refuse"] and not r["passed"])
    tn = sum(1 for r in rows if not r["refuse"] and r["passed"])
    print(f"verified claims reviewed: {len(rows)} (errors {len(errs)})")
    print(f"  false claims caught      {tp}")
    print(f"  false claims missed      {fn}")
    print(f"  true claims refused      {fp}")
    print(f"  true claims let through  {tn}")
    before = (tn + fp) / len(rows) if rows else 0
    after = tn / (tn + fn) if (tn + fn) else 0
    print(f"  'verified' precision: {before:.0%} before review → {after:.0%} after")
    print()
    for r in rows:
        if r["refuse"]:
            tag = "CAUGHT" if not r["passed"] else "WRONGLY REFUSED"
            print(f"{tag:16s} {r['task']}: " + " | ".join(f"\"{k['quote'][:60]}\" — {str(k.get('why'))[:90]}" for k in r["kept"][:2]))
    missed = [r["task"] for r in rows if not r["refuse"] and not r["passed"]]
    print("\nmissed:", ", ".join(missed))


if __name__ == "__main__":
    main(sys.argv[1:])
