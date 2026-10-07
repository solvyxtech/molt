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
# BENCH_EXPORT: where the task folders and logs are copied when the whole run ends. The
# container works in a container-local BENCH_WORK because a host bind mount (OrbStack, Docker
# Desktop) ignores chown and does not enforce modes for other users: on /work a later task's
# worker could read every earlier task's log and released checks however they were locked.
EXPORT = os.environ.get("BENCH_EXPORT")
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
# Privilege separation (default in the containers): Maat runs as root and only the worker's
# tools run as BENCH_AGENT_USER (--worker-user), so the worker cannot read Maat's state dir,
# the reference program, the judge's HOME or its process list either. BENCH_PRIVSEP=0 runs the
# whole of Maat as the agent user, as before 2026-10-07.
PRIVSEP = bool(AGENT_USER) and os.environ.get("BENCH_PRIVSEP", "1") != "0" and os.geteuid() == 0

# The graders run as root. They never run git in the agent's own repository: the agent owns its
# .git/config, and core.fsmonitor, hooks, filters and diff drivers there would run as root. Until
# 2026-10-07 run.py set safe.directory=* so git would grade an agent-owned repository at all; that
# setting is gone. The graders get a root-owned copy of the task folder instead, with the git
# config cut down to the repository format and the hooks removed (grading_copy), and git runs
# with no system or global config and hooks pointed at /dev/null (GRADER_GIT_ENV).
GRADER_GIT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_COUNT": "3",
    "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/dev/null",
    "GIT_CONFIG_KEY_1": "core.fsmonitor", "GIT_CONFIG_VALUE_1": "false",
    "GIT_CONFIG_KEY_2": "core.pager", "GIT_CONFIG_VALUE_2": "cat",
    "GIT_TERMINAL_PROMPT": "0",
}


def sanitize_git(git_dir: Path) -> None:
    """Replace a copied repository's config with the format lines alone, and drop its hooks
    and attributes: nothing in it can name a program for git to run."""
    cfg = git_dir / "config"
    version, objfmt = "0", None
    try:
        section = ""
        for line in cfg.read_text(errors="replace").splitlines():
            t = line.strip()
            if t.startswith("["):
                section = t.strip("[]").strip().lower()
                continue
            k, _, v = t.partition("=")
            k, v = k.strip().lower(), v.strip()
            if section == "core" and k == "repositoryformatversion" and v.isdigit():
                version = v
            elif section == "extensions" and k == "objectformat" and v in ("sha1", "sha256"):
                objfmt = v
    except OSError:
        pass
    text = f"[core]\n\trepositoryformatversion = {version}\n\tfilemode = true\n\tbare = false\n"
    if objfmt:
        text += f"[extensions]\n\tobjectformat = {objfmt}\n"
    if cfg.is_symlink() or cfg.exists():
        cfg.unlink()
    cfg.write_text(text)
    for p in (git_dir / "hooks", git_dir / "info" / "attributes", git_dir / "config.worktree"):
        if p.is_symlink() or p.is_file():
            p.unlink()
        elif p.is_dir():
            shutil.rmtree(p)


def grading_copy(d: Path) -> Path:
    """A root-owned copy of a finished task folder, for the graders. Regular files, folders and
    symlinks (as links) only: a FIFO or device the agent left is skipped, not opened. Every
    repository in it (.git folders) is sanitized. Call with the agent's processes stopped."""
    import tempfile

    def copy_regular(src, dst, *, follow_symlinks=True):
        st = os.lstat(src)
        if not stat.S_ISREG(st.st_mode):
            return dst
        fd = os.open(src, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, "rb") as fsrc:
            if not stat.S_ISREG(os.fstat(fsrc.fileno()).st_mode):
                return dst
            with open(dst, "wb") as fdst:
                shutil.copyfileobj(fsrc, fdst)
        shutil.copystat(src, dst, follow_symlinks=False)
        return dst

    dst = Path(tempfile.mkdtemp(prefix="maat-grade-")) / d.name
    shutil.copytree(d, dst, symlinks=True, copy_function=copy_regular)
    for root, dirs, _files in os.walk(dst):
        if ".git" in dirs and not os.path.islink(os.path.join(root, ".git")):
            sanitize_git(Path(root) / ".git")
    return dst


def grade_safely(T, d: Path):
    """T.grade on a sanitized root-owned copy (grading_copy), with GRADER_GIT_ENV set."""
    if AGENT_USER and shutil.which("pkill"):
        subprocess.run(["pkill", "-KILL", "-u", AGENT_USER], check=False)
    copy = grading_copy(d)
    saved = {k: os.environ.get(k) for k in GRADER_GIT_ENV}
    os.environ.update(GRADER_GIT_ENV)
    try:
        return T.grade(copy)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(copy.parent, ignore_errors=True)


def as_agent(cmd: list, env: dict | None = None) -> tuple[list, dict | None]:
    """With BENCH_AGENT_USER set, run the agent as that user: it cannot read the graders
    or the reference solutions, which stay root-only. Unset (Mac host lanes): unchanged.
    With privilege separation Maat stays root and is told which user the worker is."""
    if not AGENT_USER:
        return cmd, env
    if PRIVSEP:
        return [*cmd[:3], "--worker-user", AGENT_USER, *cmd[3:]], env
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


def hand_over(d: Path) -> None:
    if AGENT_USER:
        subprocess.run(["chown", "-R", AGENT_USER, str(d)], check=True)


def lock(p: Path) -> None:
    """A finished task's folder and logs: root-only, so a later task's worker cannot read an
    earlier run's released checks, receipts or Maat's log (/work is shared by every task)."""
    if not AGENT_USER or not p.exists():
        return
    try:
        os.chown(p, 0, 0, follow_symlinks=False)
        os.chmod(p, 0o700 if p.is_dir() else 0o600)
    except (PermissionError, FileNotFoundError):
        pass


def write_private(p: Path, text: str) -> None:
    """Written mode 600 from the start: the logs carry every hidden check once a job ends."""
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    lock(p)


def provider_capped(out: str, steps: int) -> bool:
    """The provider's cap (OpenRouter daily limit, OpenCode free-usage limit), not the work."""
    return (
        "rate limit is reached until" in out
        or ("free-models-per-day" in out and steps == 0)
        or ("OpenCode rate limit" in out and steps == 0)
    )


def run_molt(d: Path, prompt: str, log: Path) -> dict:
    key = openrouter_key() if "openrouter.ai" in URL else "local"
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
    write_private(log, out)
    # Maat's own notices (criteria not drafted, dropped checks, refusals) go to stderr.
    write_private(log.with_suffix(".err"), err or "")
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
    try:
        run_all(which, repeats, task_filter)
    finally:
        if EXPORT and Path(EXPORT).resolve() != WORK.resolve() and WORK.exists():
            shutil.copytree(WORK, EXPORT, symlinks=True, dirs_exist_ok=True)


def run_all(which: str, repeats: int, task_filter: str | None) -> None:
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
    # Earlier runs' folders and logs (a resumed run, an earlier lane): out of the worker's reach.
    if AGENT_USER and WORK.exists():
        for p in WORK.iterdir():
            lock(p)
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
                    ok, why = grade_safely(T, d)
                    lock(d)
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
