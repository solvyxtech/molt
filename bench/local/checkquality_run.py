"""Check-quality replay, step 3: run (command, tree) jobs inside the bench image.

Every job copies its tree to a scratch dir inside the container and runs the
command with `sh -c`, as the bar does (node spawn shell:true -> /bin/sh), with
a 120 s timeout. Tasks run in parallel; jobs within one task run one at a time
(server checks bind fixed ports). Output: one JSON line per job.

    python3 checkquality_run.py JOBS.jsonl OUT.jsonl [--image maat-bench:9ba6b27e] [--workers 6]

A job: {"id": ..., "task": ..., "cmd": ..., "tree": "<abs path on the Mac>"}.
Trees may be under ~/.cache/maat-bench (container-work, cq-trees); that folder
is mounted read-only at /mnt.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

CACHE = Path.home() / ".cache/maat-bench"

DRIVER = r'''
import json, os, shutil, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
jobs = [json.loads(l) for l in open("/jobs.jsonl") if l.strip()]
bytask = {}
for j in jobs:
    bytask.setdefault(j["task"], []).append(j)
out = open("/out.jsonl", "a")
import threading
lock = threading.Lock()
def run_one(j):
    tmp = tempfile.mkdtemp(prefix="cq-", dir="/scratch")
    w = os.path.join(tmp, "w")
    src = j["tree"]
    try:
        subprocess.run(["cp", "-a", src, w], check=True)
        t0 = time.time()
        outf = open(os.path.join(tmp, "out.txt"), "w+", errors="replace")
        p = subprocess.Popen(["/bin/sh", "-c", j["cmd"]], cwd=w, stdout=outf, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, preexec_fn=os.setsid,
                             env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root", "LANG": "C.UTF-8", "TMPDIR": tmp})
        try:
            code = p.wait(timeout=30); to = False
        except subprocess.TimeoutExpired:
            code, to = 124, True
        time.sleep(0.2)
        try: os.killpg(p.pid, 9)
        except Exception: pass
        outf.flush(); outf.seek(0); o = outf.read(); outf.close()
        res = {"id": j["id"], "tree": j.get("treeid", src), "exit": code, "out": o[-2000:], "timedOut": to, "ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        res = {"id": j["id"], "tree": j.get("treeid", src), "exit": -1, "out": "harness: " + str(e)[:300], "timedOut": False, "ms": 0}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    with lock:
        out.write(json.dumps(res) + "\n"); out.flush()
def run_task(t):
    for j in bytask[t]:
        run_one(j)
with ThreadPoolExecutor(max_workers=int(sys.argv[1])) as ex:
    list(ex.map(run_task, sorted(bytask, key=lambda t: -len(bytask[t]))))
'''


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs")
    ap.add_argument("out")
    ap.add_argument("--image", default="maat-bench:9ba6b27e")
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    jobs = [json.loads(l) for l in open(a.jobs) if l.strip()]
    # rewrite Mac paths to the mount
    mapped = []
    for j in jobs:
        t = j["tree"]
        if not t.startswith(str(CACHE)):
            sys.exit(f"tree outside the cache mount: {t}")
        mapped.append({**j, "treeid": j.get("treeid", t), "tree": "/mnt" + t[len(str(CACHE)):]})
    tmp = Path(a.out).with_suffix(".jobs.tmp")
    tmp.write_text("".join(json.dumps(j) + "\n" for j in mapped))
    drv = Path(a.out).with_suffix(".driver.py")
    drv.write_text(DRIVER)
    Path(a.out).touch()
    cmd = [
        "docker", "run", "--rm", "--network", "none",
        "-v", f"{CACHE}:/mnt:ro", "-v", f"{tmp.resolve()}:/jobs.jsonl:ro", "-v", f"{drv.resolve()}:/driver.py:ro",
        "-v", f"{Path(a.out).resolve()}:/out.jsonl", "--tmpfs", "/scratch:exec,size=2g",
        a.image, "python3", "/driver.py", str(a.workers),
    ]
    print(" ".join(cmd), file=sys.stderr)
    r = subprocess.run(cmd)
    print("docker exit", r.returncode, file=sys.stderr)


if __name__ == "__main__":
    main()
