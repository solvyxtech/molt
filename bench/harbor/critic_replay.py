#!/usr/bin/env python3
"""
Offline test of the check critic (src/criteria.ts CRITIC_SYSTEM) on drafts
molt already sealed. For every trial molt said "verified", the critic reads
the task text and the sealed checks from the accepted receipt. Reports, for
claims the grader failed and claims it passed: how often the critic would
drop a check (with a task quote that string-matches) or call the draft
surface-only.

    CRITIC_SYSTEM_FILE=critic_system.txt python3 bench/harbor/critic_replay.py jobs/<job> ...
"""
from __future__ import annotations
import concurrent.futures as cf, glob, json, os, re, sys, urllib.request

MODEL = os.environ.get("REVIEW_MODEL", "stealth/space-bunny-alpha")
KEY = os.environ["OPENROUTER_API_KEY"]
SYSTEM = open(os.environ["CRITIC_SYSTEM_FILE"]).read()

def ask(prompt: str) -> str:
    body = json.dumps({"model": MODEL, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
                       "max_tokens": 3000, "temperature": 0, "reasoning": {"effort": "low"}}).encode()
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=body,
                                 headers={"authorization": f"Bearer {KEY}", "content-type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=180))["choices"][0]["message"].get("content") or ""

norm = lambda s: re.sub(r"\s+", " ", s).strip().lower()

def checks_of(receipt: str):
    sec = receipt.split("**Machine-checked.**", 1)
    if len(sec) < 2: return []
    body = sec[1].split("**Recorded, not verified.**")[0].split("\n## ")[0]
    out = []
    for m in re.finditer(r"^- `([\w.-]+): ([\s\S]*?)`\s*$(?=\n- `|\n\n|\Z)", body, re.M):
        out.append((m.group(1), m.group(2)))
    return out

def trial(d: str):
    try:
        r = json.load(open(os.path.join(d, "result.json")))
        oc = None
        for l in open(os.path.join(d, "agent", "molt.jsonl"), errors="replace"):
            if '"job_end"' in l:
                try: oc = json.loads(l).get("outcome")
                except json.JSONDecodeError: pass
        if oc != "verified": return None
        rec = sorted(glob.glob(os.path.join(d, "agent", "record", "receipts", "*-accepted.md")))
        task = open(os.path.join(d, "agent", "instruction.txt"), errors="replace").read()
    except OSError:
        return None
    checks = checks_of(open(rec[-1], errors="replace").read()) if rec else []
    if not checks: return None
    passed = (((r.get("verifier_result") or {}).get("rewards") or {}).get("reward") or 0) >= 1
    try:
        reply = ask(f"TASK TEXT:\n{task}\n\nCHECKS:\n" + "\n".join(f"- {n}: {c}" for n, c in checks))
        o = json.loads(reply[reply.index("{"): reply.rindex("}") + 1])
    except Exception as e:  # noqa: BLE001
        return {"task": r.get("task_name"), "passed": passed, "error": str(e)[:100]}
    v = {x.get("name"): x for x in o.get("checks", []) if isinstance(x, dict)}
    t = norm(task)
    dropped = [n for n, _ in checks if v.get(n, {}).get("verdict") in ("invents", "guesses")
               and len(norm(str(v[n].get("quote", "")))) >= 4 and norm(str(v[n].get("quote", ""))) in t]
    kept = [n for n, _ in checks if n not in dropped]
    runs = [n for n in kept if v.get(n, {}).get("verdict", "runs") == "runs"]
    return {"task": r.get("task_name"), "passed": passed, "n": len(checks), "dropped": dropped,
            "surface_only": bool(kept) and not runs, "verdicts": {n: v.get(n, {}).get("verdict") for n, _ in checks},
            "quotes": {n: v[n].get("quote") for n in dropped}}

def main(jobs):
    dirs = [d for j in jobs for d in sorted(glob.glob(os.path.join(j, "*/")))]
    rows = []
    with cf.ThreadPoolExecutor(int(os.environ.get("REVIEW_WORKERS", "4"))) as ex:
        for r in ex.map(trial, dirs):
            if r:
                rows.append(r); print(json.dumps(r), flush=True)
    rows = [r for r in rows if "error" not in r]
    for label, sel in (("false claims (grader failed)", [r for r in rows if not r["passed"]]), ("true claims (grader passed)", [r for r in rows if r["passed"]])):
        n = len(sel) or 1
        flag = [r for r in sel if r["dropped"] or r["surface_only"]]
        print(f"{label}: {len(sel)}  any check dropped {sum(1 for r in sel if r['dropped'])}  surface-only {sum(1 for r in sel if r['surface_only'])}  flagged either {len(flag)} ({len(flag)/n:.0%})")

if __name__ == "__main__":
    main(sys.argv[1:])
