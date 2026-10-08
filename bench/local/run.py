"""
Run molt on the local tasks and grade the result. Graders are hidden in tasks.py.

    python3 run.py molt [repeats] [task,task]

Paired arms: ARMS="base:REFERENCE=0;ref:REFERENCE=1" (or JSON) runs, per task,
arm A then arm B before the next task; rows carry "arm"; resume is by
(task, agent, rep, arm). BENCH_TASKS=a,b restricts the task set.

Only molt is run here. Other vendors' agents are not benchmarked from this
repository: their terms commonly forbid benchmarking and publishing
performance data.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from tasks import TASKS

HERE = Path(__file__).resolve().parent
# Outside every git repository: a task folder inside this one let agents'
# `git commit` walk up and commit task files into molt-desktop's main.
WORK = Path(os.environ.get("BENCH_WORK", Path.home() / ".cache/maat-bench/work"))
# MOLT_DIST_ABS: an absolute path to the built Maat (the container mounts it at /maat).
MOLT = (Path(os.environ["MOLT_DIST_ABS"]) if os.environ.get("MOLT_DIST_ABS") else Path.home() / os.environ.get("MOLT_DIST", "Documents/molt-desktop/dist-compare")) / "cli.js"
LIMIT = int(os.environ.get("BENCH_LIMIT", "600"))  # seconds per task
# Space Bunny Alpha was withdrawn from OpenRouter on 2026-10-05; the owner chose Nemotron 3 Ultra.
MODEL = os.environ.get("BENCH_MODEL") or "nvidia/nemotron-3-ultra-550b-a55b:free"
# BENCH_URL points the run at another endpoint (e.g. the NUC's llama.cpp over the tunnel); the
# OpenRouter key is then not sent anywhere.
URL = os.environ.get("BENCH_URL") or "https://openrouter.ai/api/v1"


def load_keys_file() -> dict:
    """BENCH_KEYS_FILE: NAME=value lines in a root-only file (the containers mount it). Read into
    memory here, never put in an environment: `--env-file` put the key in the container's own
    environment, in `docker inspect`, and in every process of the run."""
    path = os.environ.get("BENCH_KEYS_FILE")
    if not path:
        return {}
    keys = {}
    for line in Path(path).read_text().splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and name and not name.startswith("#"):
            keys[name] = value
    return keys


KEYS = load_keys_file()


def openrouter_key() -> str:
    if KEYS.get("OPENROUTER_API_KEY"):  # the container is given the key, not the Mac's auth file
        return KEYS["OPENROUTER_API_KEY"]
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"]
    return subprocess.run(
        ["node", "-e", "import('%s').then(m=>process.stdout.write(m.readAuth().openrouter||''))" % (Path.home() / "Documents/molt-desktop/dist/providers.js")],
        capture_output=True, text=True,
    ).stdout


# --sandbox, as the Terminal-Bench adapter has always passed: the task folder
# is throwaway (and, in a container, so is the machine). With --yes the
# project boundary still asked, headless asking is "User denied", and every
# local number from the first run to 2026-10-06 was measured with 118-168
# denied calls per 60 runs: writing the deliverable through a heredoc, removing
# the model's own scratch files. BENCH_GATE=yes reproduces the old runs.
AGENT_USER = os.environ.get("BENCH_AGENT_USER")  # set in the containers: the agent runs unprivileged


def as_agent(cmd: list, env: dict | None = None) -> tuple[list, dict | None]:
    """With BENCH_AGENT_USER set, run the agent as that user: it cannot read the graders
    or the reference solutions, which stay root-only. Unset (Mac host lanes): unchanged."""
    if not AGENT_USER:
        return cmd, env
    import pwd
    home = pwd.getpwnam(AGENT_USER).pw_dir
    return ["runuser", "-u", AGENT_USER, "--", "env", f"HOME={home}", *cmd], env


# The same shapes Maat treats as credentials (src/secrets.ts).
SECRET_SUFFIX = re.compile(r"(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET(?:_ACCESS)?_?KEY|PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)$", re.I)
SECRET_PREFIX = re.compile(r"^(?:XAI|GROK|TOGETHER)_", re.I)
SECRET_NAMES = {"MAAT_API_KEY", "MOLT_API_KEY", "MAAT_JUDGE_KEY", "MOLT_JUDGE_KEY", "MAAT_KEYS_FD", "MAAT_KEYS_FILE"}


def is_secret(name: str) -> bool:
    return name.upper() in SECRET_NAMES or bool(SECRET_SUFFIX.search(name)) or bool(SECRET_PREFIX.match(name))


def keys_by_fd(env: dict) -> tuple[dict, dict, int]:
    """Take every credential out of the agent's environment and hand it over on a pipe instead
    (MAAT_KEYS_FD). In the environment it stayed in Maat's /proc/<pid>/environ for the whole run,
    and a worker of Maat's own user read it back with `cat /proc/$PPID/environ`; deleting it inside
    Maat does not change that copy. Returns (clean env, Popen kwargs, read end to close after Popen)."""
    secrets = {k: v for k, v in env.items() if is_secret(k)}
    clean = {k: v for k, v in env.items() if not is_secret(k)}
    payload = json.dumps(secrets).encode()
    if len(payload) > 60_000:  # one write into an empty pipe must not block
        raise SystemExit("keys too large for the handover pipe")
    r, w = os.pipe()
    os.write(w, payload)
    os.close(w)
    clean["MAAT_KEYS_FD"] = str(r)
    return clean, {"pass_fds": (r,)}, r


def kill_tree(proc: subprocess.Popen) -> None:
    """Kill the agent's whole process group, and in a container every process of the
    unprivileged agent user (a backend CLI may start its own session)."""
    import signal
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    if AGENT_USER and shutil.which("pkill"):
        subprocess.run(["pkill", "-KILL", "-u", AGENT_USER], check=False)


def hand_over(d: Path) -> None:
    if AGENT_USER:
        subprocess.run(["chown", "-R", AGENT_USER, str(d)], check=True)


def provider_capped(out: str, steps: int) -> bool:
    """The provider's cap (OpenRouter daily limit, OpenCode free-usage limit), not the work."""
    return (
        "rate limit is reached until" in out
        or ("free-models-per-day" in out and steps == 0)
        or ("OpenCode rate limit" in out and steps == 0)
    )


def run_molt(d: Path, prompt: str, log: Path) -> dict:
    key = openrouter_key() if "openrouter.ai" in URL else "local"
    env = os.environ | KEYS | {"MOLT_API_KEY": key, "MOLT_JUDGMENT": "0"}  # nobody rules on a benchmark run
    cmd = [
        "node", str(MOLT), "run", "--url", URL, "--model", os.environ.get("BENCH_MODEL") or MODEL,
        "--reasoning", os.environ.get("BENCH_REASONING") or "low", *(["--yes"] if os.environ.get("BENCH_GATE") == "yes" else ["--sandbox"]), "--json", "--criteria", "auto", "--batch", "--review", "3", "--steps", "200",
        # Maat stops itself a minute before the kill and judges what is on disk;
        # the subprocess timeout below is only the backstop.
        "--for", f"{max(60, LIMIT - 60)}s",
        *(["--reference"] if os.environ.get("REFERENCE") == "1" else []), "--cwd", str(d), prompt,
    ]
    t0 = time.time()
    cmd, env = as_agent(cmd, env)
    env, fds, keys_fd = keys_by_fd(env)
    # Own session, so the backstop kills the whole tree. subprocess.run's timeout killed only
    # the top process (runuser in the containers) and then waited on the pipe Maat and its
    # backend still held: one hung Grok turn ran 3570 s against a 600 s limit (2026-10-07).
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                                start_new_session=True, **fds)
    finally:
        os.close(keys_fd)
    try:
        out, err = proc.communicate(timeout=LIMIT)
        timed_out = False
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        try:
            out, err = proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            out, err = "", ""
        timed_out = True
    secs = time.time() - t0
    log.write_text(out)
    # Maat's own notices (criteria not drafted, dropped checks, refusals) go to stderr.
    log.with_suffix(".err").write_text(err or "")
    steps = 0; per = []; outcome = None; spend = {}; review = None; disagree = []; extra = {}
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
            # Only what job_end carried; absent keys stay absent (older builds).
            extra = {k: ev[k] for k in ("revealed", "deadline", "endedBy", "retired", "build", "tier", "tierReason", "providerStall") if k in ev}
    # The provider's daily cap, not the work: every later task would fail the
    # same way (2026-10-05: eleven tasks per arm "failed" in 140 s, 0 turns).
    capped = provider_capped(out, steps)
    return {
        "provider_capped": capped,
        "secs": round(secs), "turns": steps, "calls": sum(per), "multi": sum(1 for x in per if x > 1),
        "tokens_in": spend.get("promptTokens"), "claim": outcome, "timed_out": timed_out,
        "said_done": (outcome or "").startswith("verified"),
        # The reviewer's label: a verified claim it did not confirm.
        "review": review,
        # Refused only by molt's own drafted checks (reported unverified).
        "checks_disagree": disagree,
        "said_done_reviewed": (outcome or "").startswith("verified") and not (review and not review.get("confirmed")),
        **extra,
    }


def claims_done(text: str) -> bool:
    """
    Whether a final message says the work is done, by one fixed rule: a hedge
    or failure word wins over a success word.
    """
    t = (text or "").lower()
    hedges = ("not proven", "could not", "couldn't", "unable", "failed", "not verified", "unverified",
              "did not", "didn't", "still fails", "not able", "incomplete", "blocked", "not done", "partially")
    if any(h in t for h in hedges):
        return False
    return any(w in t for w in ("done", "complete", "fixed", "merged", "created", "wrote", "implemented",
                                "passes", "passing", "finished", "works", "added", "updated", "written"))


def parse_arms(spec: str | None) -> list[tuple[str | None, dict]]:
    """
    ARMS defines the arms of a paired run. Either "base:REFERENCE=0;ref:REFERENCE=1"
    (arms split on ";", variables on ","), or JSON: {"base": {"REFERENCE": "0"}, ...}
    or a path to such a file. No ARMS: one unnamed arm, the legacy behaviour.
    """
    if not spec:
        return [(None, {})]
    spec = spec.strip()
    if spec.startswith("{") or (os.path.isfile(spec) and spec.endswith(".json")):
        data = json.loads(spec if spec.startswith("{") else Path(spec).read_text())
        return [(k, {a: str(b) for a, b in (v or {}).items()}) for k, v in data.items()]
    arms = []
    for part in filter(None, (x.strip() for x in spec.split(";"))):
        name, _, vs = part.partition(":")
        env = {}
        for kv in filter(None, (x.strip() for x in vs.split(","))):
            k, _, v = kv.partition("=")
            env[k.strip()] = v
        arms.append((name.strip(), env))
    return arms


def main(which: str, repeats: int, task_filter: str | None) -> None:
    from tasks2 import TASKS2  # noqa: PLC0415
    from tasks3 import TASKS3  # noqa: PLC0415
    agents = {"molt": run_molt}
    if which not in agents:
        sys.exit(f"unknown agent {which!r}: this runner only runs molt")
    chosen = [which]
    tasks = [T for T in TASKS + TASKS2 + TASKS3 if not task_filter or T.name in task_filter.split(",")]
    # BENCH_TASKS restricts to a subset (e.g. the discordant tasks of an earlier pair).
    if os.environ.get("BENCH_TASKS"):
        want = {x.strip() for x in os.environ["BENCH_TASKS"].split(",") if x.strip()}
        tasks = [T for T in tasks if T.name in want]
    arms = parse_arms(os.environ.get("ARMS"))
    out = Path(os.environ.get("RESULTS_DIR", HERE)) / os.environ.get("RESULTS", f"results-{which}-x{repeats}.jsonl")
    done = set()
    if out.exists():  # resume: skip runs already recorded
        for line in out.read_text().splitlines():
            r = json.loads(line)
            done.add((r["task"], r["agent"], r["rep"], r.get("arm")))
    for rep in range(repeats):
        for T in tasks:
            for arm, arm_env in arms:  # paired: arm A then arm B on this task before the next task
                for a in chosen:
                    if (T.name, a, rep, arm) in done:
                        continue
                    tag = f"{T.name}-{a}-{rep}" + (f"-{arm}" if arm else "")
                    d = WORK / tag
                    shutil.rmtree(d, ignore_errors=True)
                    d.mkdir(parents=True)
                    T.setup(d)
                    hand_over(d)
                    saved = {k: os.environ.get(k) for k in arm_env}
                    os.environ.update(arm_env)
                    try:
                        r = agents[a](d, T.PROMPT, WORK / f"{tag}.log")
                    finally:
                        for k, v in saved.items():
                            if v is None:
                                os.environ.pop(k, None)
                            else:
                                os.environ[k] = v
                    if r.get("provider_capped"):
                        # Not recorded, so a resume runs this task again.
                        print(f"STOPPED: the provider's daily limit / quota is reached ({tag} not recorded)", flush=True)
                        return
                    ok, why = T.grade(d)
                    final = ""
                    r.update(task=T.name, agent=a, rep=rep, passed=ok, why=why, final=final[:300])
                    if arm:
                        r["arm"] = arm
                    if os.environ.get("MAAT_BUILD"):
                        r["build"] = os.environ["MAAT_BUILD"]  # sha8 of the packed Maat the container ran
                    with out.open("a") as f:
                        f.write(json.dumps(r) + "\n")
                    print(json.dumps({k: r[k] for k in ("task", "agent", "arm", "rep", "passed", "said_done", "turns", "secs") if k in r}), flush=True)



if __name__ == "__main__":
    args = sys.argv[1:]
    which = args[0] if args else "molt"
    repeats = int(args[1]) if len(args) > 1 else 1
    main(which, repeats, args[2] if len(args) > 2 else None)
