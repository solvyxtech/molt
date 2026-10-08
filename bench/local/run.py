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
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

from tasks import TASKS

HERE = Path(__file__).resolve().parent
# Outside every git repository: a task folder inside this one let agents'
# `git commit` walk up and commit task files into molt-desktop's main.
WORK = Path(os.environ.get("BENCH_WORK", Path.home() / ".cache/maat-bench/work"))
# BENCH_EXPORT: where each finished task's folder and logs are copied, right after it is graded.
# Unset: WORK itself. The task RUNS somewhere else (private_dir below), never in the export.
#
# 2026-10-07 (ml4b lanes): a worker spent 90-125 tool calls per task reading the other tasks'
# folders and logs in the shared /work instead of working. /work is a host bind mount, and on
# OrbStack and Docker Desktop a bind mount ignores chown and does not enforce modes for other
# users, so nothing there can be locked away from the agent user. The containers therefore mount
# the export (and the results) under /root (700, container-local, enforced), run each task in a
# private folder under BENCH_WORK, and copy it out once it is finished and the agent is gone.
EXPORT = Path(os.environ.get("BENCH_EXPORT") or WORK)
# MOLT_DIST_ABS: an absolute path to the built Maat (the container mounts it at /maat).
MOLT = (Path(os.environ["MOLT_DIST_ABS"]) if os.environ.get("MOLT_DIST_ABS") else Path.home() / os.environ.get("MOLT_DIST", "Documents/molt-desktop/dist-compare")) / "cli.js"
LIMIT = int(os.environ.get("BENCH_LIMIT", "600"))  # seconds per task
# Space Bunny Alpha was withdrawn from OpenRouter on 2026-10-05; the owner chose Nemotron 3 Ultra.
MODEL = os.environ.get("BENCH_MODEL") or "nvidia/nemotron-3-ultra-550b-a55b:free"
# BENCH_URL points the run at another endpoint (e.g. the NUC's llama.cpp over the tunnel); the
# OpenRouter key is then not sent anywhere.
URL = os.environ.get("BENCH_URL") or "https://openrouter.ai/api/v1"


def openrouter_key() -> str:
    if os.environ.get("OPENROUTER_API_KEY"):  # the container is given the key, not the Mac's auth file
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


def kill_agent_procs() -> None:
    """In a container, end every process of the agent user. Before grading, so nothing the worker
    left running (a server on the port the grader wants, a loop rewriting outputs) is still there
    while the work is judged; and again when the task is finished."""
    if AGENT_USER and shutil.which("pkill"):
        subprocess.run(["pkill", "-KILL", "-u", AGENT_USER], check=False)


# Environment variables a grader's children never see: the worker's code runs in them.
SECRET_ENV = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH")
GRADE_LIMIT = int(os.environ.get("BENCH_GRADE_LIMIT", "900"))  # seconds, the whole grade of one task


def grade(T, d: Path) -> tuple[bool, str]:
    """
    T.grade(d), and with BENCH_AGENT_USER set, as that user.

    Graders run the worker's code: `python3 server.py`, `python3 migrate.py`, `python3 -c 'import
    the_module'`. Run as root, that code could append a passing row to the results, edit the task
    modules the next tasks are graded by, or read reference_solutions/. So the grade runs in a
    forked child that has dropped to the agent user (everything it runs inherits that), with the
    secrets stripped from its environment. The child is non-dumpable after the drop, so the
    worker's code, though it runs as the same user, cannot attach to it or read its pipe; the
    verdict comes back to root over that pipe, and root alone writes the results. Code that kills
    the grader, hangs past GRADE_LIMIT or answers with anything but a verdict fails the task.
    Mac host lanes (no agent user): T.grade(d) as before.
    """
    if not AGENT_USER:
        return T.grade(d)
    import pwd
    import select
    import signal
    pw = pwd.getpwnam(AGENT_USER)
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:  # the grader
        code = 0
        try:
            os.close(r)
            os.setgroups([])
            os.setgid(pw.pw_gid)
            os.setuid(pw.pw_uid)
            try:
                import ctypes
                ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE 0 (also the default after setuid)
            except Exception:
                pass
            for k in list(os.environ):
                if any(s in k.upper() for s in SECRET_ENV):
                    del os.environ[k]
            os.environ["HOME"] = pw.pw_dir
            os.chdir(d)
            ok, why = T.grade(d)
            data = json.dumps([bool(ok), str(why)])
        except BaseException as e:  # noqa: BLE001 - every failure is a verdict
            data = json.dumps([False, f"grader error: {e!r}"[:2000]])
            code = 1
        try:
            os.write(w, data.encode())
        finally:
            os._exit(code)
    os.close(w)
    chunks: list[bytes] = []
    deadline = time.time() + GRADE_LIMIT
    timed_out = False
    try:
        while True:
            left = deadline - time.time()
            if left <= 0:
                timed_out = True
                break
            ready, _, _ = select.select([r], [], [], left)
            if not ready:
                continue
            b = os.read(r, 65536)
            if not b:
                break
            chunks.append(b)
    finally:
        os.close(r)
        if timed_out:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        kill_agent_procs()  # whatever the worker's code started while it was being graded
        _, status = os.waitpid(pid, 0)
    if timed_out:
        return False, f"grader timed out after {GRADE_LIMIT}s"
    try:
        ok, why = json.loads(b"".join(chunks).decode())
        return bool(ok), str(why)
    except (ValueError, TypeError):
        return False, f"grader ended without a verdict (wait status {status})"


def _copy_regular(src: str, dst: str, *, follow_symlinks: bool = True) -> str:
    """copytree's copy_function: regular files only. A FIFO or a socket a worker left in its folder
    (a server's .sock, or `mkfifo x` on purpose) made copytree raise, and the lane stopped."""
    if stat.S_ISREG(os.lstat(src).st_mode):
        return shutil.copy2(src, dst, follow_symlinks=follow_symlinks)
    return dst


def hand_over(d: Path) -> None:
    if AGENT_USER:
        subprocess.run(["chown", "-R", AGENT_USER, str(d)], check=True)


def private_dir(tag: str) -> Path:
    """
    A fresh folder for one task: BENCH_WORK/<random>/<tag>.

    BENCH_WORK is 711 (made so here when we own it): the agent can reach its own task by the
    exact path it is given, but cannot list BENCH_WORK, and the random parent cannot be guessed,
    so no task can find another's folder. Finished tasks are removed (finish_task), so there is
    nothing left to find anyway. On a Mac host lane (no agent user) the layout is the same; the
    agent then runs as the owner, so only the names and the removal keep tasks apart.
    """
    import secrets
    WORK.mkdir(parents=True, exist_ok=True)
    if AGENT_USER:
        os.chmod(WORK, 0o711)
    box = WORK / secrets.token_hex(8)
    box.mkdir(mode=0o711)
    os.chmod(box, 0o711)  # mkdir's mode is masked by the umask
    d = box / tag
    d.mkdir()
    return d


def log_dir() -> Path:
    """Where Maat's stdout/stderr are written while a run is live: root-only (700), never in a task folder."""
    logs = WORK / ".logs"
    logs.mkdir(parents=True, exist_ok=True)
    os.chmod(logs, 0o700)
    return logs


def finish_task(d: Path, logs: list[Path]) -> None:
    """
    The task is graded and its agent is gone: copy the folder and its logs to EXPORT, then remove
    the private copies. In a container, every process of the agent user is killed first: a server
    a worker left running would otherwise still be there, as that user, during the next task.

    Never raises: the export is for the owner to look at, and a failure to copy it (a special
    file, a full disk) is reported, not allowed to stop the lane or leave the private folder.
    """
    kill_agent_procs()
    try:
        EXPORT.mkdir(parents=True, exist_ok=True)
        dst = EXPORT / d.name
        if dst.resolve() != d.resolve():
            shutil.rmtree(dst, ignore_errors=True)
            shutil.copytree(d, dst, symlinks=True, copy_function=_copy_regular)
    except (OSError, shutil.Error) as e:
        print(f"export of {d.name} incomplete: {e}", file=sys.stderr, flush=True)
    for f in logs:
        try:
            if f.exists() and (EXPORT / f.name).resolve() != f.resolve():
                shutil.copy2(f, EXPORT / f.name)
                f.unlink()
        except OSError as e:
            print(f"export of {f.name} failed: {e}", file=sys.stderr, flush=True)
    shutil.rmtree(d.parent, ignore_errors=True)


def provider_capped(out: str, steps: int) -> bool:
    """The provider's cap (OpenRouter daily limit, OpenCode free-usage limit), not the work."""
    return (
        "rate limit is reached until" in out
        or ("free-models-per-day" in out and steps == 0)
        or ("OpenCode rate limit" in out and steps == 0)
    )


def claim_of(ev: dict) -> str | None:
    """
    The `claim` field for one job_end event.

    Builds from 2026-10-07 on carry job_end's own `claim`, which says who stood
    behind the word: "verified (independent checks: <judge>)", "verified (your
    checks)", or "passed own checks (<worker>), not verified" (never counted as
    verified: it does not start with "verified"). Older builds, and outcomes
    that are not a tier, carry the outcome as before, with " (self-checked)"
    when every check was drafted (whoever drafted it).
    """
    c = ev.get("claim")
    if isinstance(c, str) and c:
        return c
    o = ev.get("outcome")
    if not isinstance(o, str):
        return None
    return o + (" (self-checked)" if ev.get("selfChecked") else "")


def run_molt(d: Path, prompt: str, log: Path) -> dict:
    key = (openrouter_key() if "openrouter.ai" in URL
           else os.environ.get("ANTHROPIC_API_KEY", "") if "api.anthropic.com" in URL
           else "local")
    env = os.environ | {"MOLT_API_KEY": key, "MOLT_JUDGMENT": "0"}  # nobody rules on a benchmark run
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
    # Own session, so the backstop kills the whole tree. subprocess.run's timeout killed only
    # the top process (runuser in the containers) and then waited on the pipe Maat and its
    # backend still held: one hung Grok turn ran 3570 s against a 600 s limit (2026-10-07).
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                            start_new_session=True)
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
            outcome = claim_of(ev)
            spend = ev.get("spend") or {}
            review = ev.get("review")
            disagree = ev.get("checksDisagree") or []
            # Only what job_end carried; absent keys stay absent (older builds).
            extra = {k: ev[k] for k in ("revealed", "deadline", "endedBy", "retired", "build", "tier", "tierReason", "providerStall", "checkAuthors") if k in ev}
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
    if not AGENT_USER:
        print("WARNING: no BENCH_AGENT_USER: the worker runs as this user, so it can read the graders, "
              "the export and earlier tasks' logs, and graders run its code with this user's rights. "
              "Use the container lanes for numbers that matter.", file=sys.stderr, flush=True)
    out = Path(os.environ.get("RESULTS_DIR", HERE)) / os.environ.get("RESULTS", f"results-{which}-x{repeats}.jsonl")
    out.parent.mkdir(parents=True, exist_ok=True)
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
                    d = private_dir(tag)
                    log = log_dir() / f"{tag}.log"
                    T.setup(d)
                    hand_over(d)
                    saved = {k: os.environ.get(k) for k in arm_env}
                    os.environ.update(arm_env)
                    try:
                        r = agents[a](d, T.PROMPT, log)
                    except BaseException:
                        finish_task(d, [log, log.with_suffix(".err")])
                        raise
                    finally:
                        for k, v in saved.items():
                            if v is None:
                                os.environ.pop(k, None)
                            else:
                                os.environ[k] = v
                    if r.get("provider_capped"):
                        finish_task(d, [log, log.with_suffix(".err")])
                        # Not recorded, so a resume runs this task again.
                        print(f"STOPPED: the provider's daily limit / quota is reached ({tag} not recorded)", flush=True)
                        return
                    # Nothing the worker started is still running while it is graded.
                    kill_agent_procs()
                    try:
                        ok, why = grade(T, d)
                    except BaseException:
                        finish_task(d, [log, log.with_suffix(".err")])
                        raise
                    final = ""
                    r.update(task=T.name, agent=a, rep=rep, passed=ok, why=why, final=final[:300])
                    if arm:
                        r["arm"] = arm
                    if os.environ.get("MAAT_BUILD"):
                        r["build"] = os.environ["MAAT_BUILD"]  # sha8 of the packed Maat the container ran
                    # The result is written before the export, so nothing in the export can lose it.
                    with out.open("a") as f:
                        f.write(json.dumps(r) + "\n")
                    finish_task(d, [log, log.with_suffix(".err")])
                    print(json.dumps({k: r[k] for k in ("task", "agent", "arm", "rep", "passed", "said_done", "turns", "secs") if k in r}), flush=True)



if __name__ == "__main__":
    args = sys.argv[1:]
    which = args[0] if args else "molt"
    repeats = int(args[1]) if len(args) > 1 else 1
    main(which, repeats, args[2] if len(args) > 2 else None)
