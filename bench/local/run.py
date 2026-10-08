"""
Run molt on the local tasks and grade the result. Graders are hidden in tasks.py.

    python3 run.py molt [repeats] [task,task]

Paired arms: ARMS="base:REFERENCE=0;ref:REFERENCE=1" (or JSON) runs both arms on a
task before the next task, in ABBA order (rows carry "arm" and "arm_pos"); resume
is by (task, agent, rep, arm). BENCH_TASKS=a,b restricts the task set.

Every row carries its lane (model, url, reasoning, limit, gate, judge and Maat
settings per arm, build, grader hash) and lane_id; a results file holding another
lane's rows is refused. A run the provider's cap stops prints STOPPED and exits 3.
In the containers nothing the agent user leaves in /tmp, /var/tmp, /dev/shm or its
home survives into the next run (Scrubber).

Only molt is run here. Other vendors' agents are not benchmarked from this
repository: their terms commonly forbid benchmarking and publishing
performance data.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import statistics
import subprocess
import sys
import time
from pathlib import Path

from grading import links_into, safe_grade
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
# Privilege separation (default in the containers): Maat runs as root and only the worker's
# tools run as BENCH_AGENT_USER (--worker-user), so the worker cannot read Maat's state dir,
# the reference program, the judge's HOME or its process list either. BENCH_PRIVSEP=0 runs the
# whole of Maat as the agent user, as before 2026-10-07.
PRIVSEP = bool(AGENT_USER) and os.environ.get("BENCH_PRIVSEP", "1") != "0" and os.geteuid() == 0
# With privilege separation, task checks (hidden, drafted, mission) run as a third account
# (--check-user): they can read the reference check, and the worker cannot. The image makes it.
CHECK_USER = os.environ.get("BENCH_CHECK_USER") or "checker"

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


def _copy_regular(src, dst, *, follow_symlinks=True):
    """copytree's copy function: regular files only, opened without following a link and
    without blocking on a FIFO; anything else is skipped."""
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


def sanitized_copy(src: Path, dst: Path) -> Path:
    """Copy an agent-written tree to `dst` (which must not exist), owned by whoever runs this:
    regular files, folders and symlinks (as links) only, and every repository in it (.git
    folders) sanitized (sanitize_git)."""
    shutil.copytree(src, dst, symlinks=True, copy_function=_copy_regular)
    for root, dirs, _files in os.walk(dst):
        if ".git" in dirs and not os.path.islink(os.path.join(root, ".git")):
            sanitize_git(Path(root) / ".git")
    return dst


def grading_copy(d: Path) -> Path:
    """A root-owned copy of a finished task folder, for the graders. Regular files, folders and
    symlinks (as links) only: a FIFO or device the agent left is skipped, not opened. Every
    repository in it (.git folders) is sanitized. Call with the agent's processes stopped."""
    import tempfile

    return sanitized_copy(d, Path(tempfile.mkdtemp(prefix="maat-grade-")) / d.name)


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
    With privilege separation Maat stays root and is told which user the worker is, and which
    account runs the task checks."""
    if not AGENT_USER:
        return cmd, env
    if PRIVSEP:
        return [*cmd[:3], "--worker-user", AGENT_USER, "--check-user", CHECK_USER, *cmd[3:]], env
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


def kill_agent_procs() -> None:
    """In a container, end every process of the agent user. Before grading, so nothing the worker
    left running (a server on the port the grader wants, a loop rewriting outputs) is still there
    while the work is judged; and again when the task is finished."""
    if AGENT_USER and shutil.which("pkill"):
        subprocess.run(["pkill", "-KILL", "-u", AGENT_USER], check=False)


# Environment variables a grader's children never see: the worker's code runs in them.
SECRET_ENV = ("KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH")
GRADE_LIMIT = int(os.environ.get("BENCH_GRADE_LIMIT", "900"))  # seconds, the whole grade of one task


def grade(T, d: Path) -> tuple[bool, str, bool]:
    """
    (passed, why, grader_error): T.grade(d) through grading.safe_grade, and with BENCH_AGENT_USER
    set, as that user.

    A grader that raises is a failed row with grader_error set, never an abort: the lane used to
    stop, and on resume the (task, rep) ran again, a free retry for exactly the runs that broke a
    grader. A symlink that resolves into the bench's own folders fails the task before any grader
    can follow it (the agent cannot read them; root, or a host lane's owner, can).

    Graders run the worker's code: `python3 server.py`, `python3 migrate.py`, `python3 -c 'import
    the_module'`. Run as root, that code could append a passing row to the results, edit the task
    modules the next tasks are graded by, or read reference_solutions/. So the grade runs in a
    forked child that has dropped to the agent user (everything it runs inherits that), with the
    secrets stripped from its environment. The child is non-dumpable after the drop, so the
    worker's code, though it runs as the same user, cannot attach to it or read its pipe; the
    verdict comes back to root over that pipe, and root alone writes the results. Code that kills
    the grader, hangs past GRADE_LIMIT or answers with anything but a verdict fails the task.
    Mac host lanes (no agent user): in this process, as before.
    """
    bad = links_into(d, protected_roots())
    if bad:
        return False, f"symlink into the bench's own folders: {bad[:3]}", False
    if not AGENT_USER:
        return safe_grade(T, d)
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
            data = json.dumps(list(safe_grade(T, d)))
        except BaseException as e:  # noqa: BLE001 - every failure is a verdict
            data = json.dumps([False, f"grader error: {e!r}"[:2000], True])
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
        return False, f"grader timed out after {GRADE_LIMIT}s", False
    try:
        ok, why, err = json.loads(b"".join(chunks).decode())
        return bool(ok), str(why), bool(err)
    except (ValueError, TypeError):
        # The worker's code, run by the grader as the same user, can kill it: a fail, not a grader error.
        return False, f"grader ended without a verdict (wait status {status})", False


def protected_roots() -> list[Path]:
    """Where a task folder's symlinks must not lead: the graders and reference solutions, the
    results, the export and the other tasks' work."""
    return [HERE, Path(os.environ.get("RESULTS_DIR", HERE)), EXPORT, WORK]


class Scrubber:
    """
    Nothing the agent user leaves outside its task folder reaches the next run (B3 of the PR #33
    audit). After every task, and so after every arm and every repeat:

    - every entry the agent user owns in /tmp, /var/tmp and /dev/shm is removed (Maat's own
      maat-check-*/ref-* copies of a SIGKILLed run included), looking inside world-writable folders
      only, the only ones it could create anything in;
    - its home is put back exactly as it was before the first task, from a root-only snapshot, so
      notes it left there go and the credentials it was given stay.

    It used to be one long-lived machine: rep 1 read the notes rep 0 left in /tmp and ~, and arm B
    of a pair could read arm A's solution.
    """

    DIRS = (Path("/tmp"), Path("/var/tmp"), Path("/dev/shm"))

    def __init__(self, uid: int, home: Path, snapshot: Path, dirs=DIRS):
        self.uid, self.home, self.snap, self.dirs = uid, Path(home), Path(snapshot), [Path(x) for x in dirs]

    def take(self) -> None:
        shutil.rmtree(self.snap, ignore_errors=True)
        self.snap.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(self.snap.parent, 0o700)
        subprocess.run(["cp", "-a", str(self.home), str(self.snap)], check=True)

    def scrub(self) -> list[str]:
        removed: list[str] = []

        def walk(p: str) -> None:
            try:
                entries = list(os.scandir(p))
            except OSError:
                return
            for e in entries:
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                if st.st_uid == self.uid:
                    try:
                        if stat.S_ISDIR(st.st_mode):
                            shutil.rmtree(e.path)
                        else:
                            os.unlink(e.path)
                        removed.append(e.path)
                    except OSError as err:
                        print(f"scrub: could not remove {e.path}: {err}", file=sys.stderr, flush=True)
                elif stat.S_ISDIR(st.st_mode) and st.st_mode & 0o002:
                    walk(e.path)

        for d in self.dirs:
            if d.is_dir():
                walk(str(d))
        return removed

    def restore_home(self) -> None:
        for e in list(os.scandir(self.home)):
            if e.is_dir(follow_symlinks=False):
                shutil.rmtree(e.path)
            else:
                os.unlink(e.path)
        subprocess.run(["cp", "-a", f"{self.snap}/.", f"{self.home}/"], check=True)
        st = os.stat(self.snap)
        os.chmod(self.home, stat.S_IMODE(st.st_mode))
        if os.geteuid() == 0:
            os.chown(self.home, st.st_uid, st.st_gid)

    def reset(self) -> None:
        """Never raises: reported, so a lane is not stopped by a file it could not remove."""
        try:
            self.scrub()
            self.restore_home()
        except (OSError, subprocess.CalledProcessError) as e:
            print(f"scrub after the task incomplete: {e}", file=sys.stderr, flush=True)


SCRUBBER: Scrubber | None = None


def make_scrubber() -> Scrubber | None:
    """In the containers (root, with an agent user): the scrubber, its snapshot taken now."""
    if not AGENT_USER or os.geteuid() != 0:
        return None
    import pwd
    pw = pwd.getpwnam(AGENT_USER)
    sc = Scrubber(pw.pw_uid, Path(pw.pw_dir), WORK / ".home-snapshot" / "home")
    sc.take()
    return sc


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
    if SCRUBBER is not None:
        SCRUBBER.reset()


def write_private(p: Path, text: str) -> None:
    """Written mode 600 from the start: the logs carry every hidden check once a job ends."""
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def maat_said(out: str, err: str = "") -> str:
    """
    What Maat itself reported: its `error` events, any stdout line that is not a JSON event, and
    stderr. Never a tool event's preview or args, nor model text: the worker's own output (`cat
    app.log`, an echo, a source file that quotes the phrase) is in those, and it used to stop the
    lane as "the provider's cap" (B5 of the PR #33 audit).
    """
    keep = [err or ""]
    for line in (out or "").splitlines():
        try:
            ev = json.loads(line) if line.startswith("{") else None
        except json.JSONDecodeError:
            ev = None
        if not isinstance(ev, dict):
            keep.append(line)
        elif ev.get("kind") == "error":
            keep.append(str(ev.get("text", "")) + " " + str(ev.get("message", "")))
    return "\n".join(keep)


def provider_capped(out: str, steps: int, err: str = "") -> bool:
    """The provider's cap (OpenRouter daily limit, OpenCode free-usage limit), not the work."""
    said = maat_said(out, err)
    return (
        "rate limit is reached until" in said
        or ("free-models-per-day" in said and steps == 0)
        or ("OpenCode rate limit" in said and steps == 0)
    )


def claim_of(ev: dict) -> str | None:
    """
    The `claim` field for one job_end event.

    Builds from 2026-10-07 on carry job_end's own `claim`, which says who stood
    behind the word: "verified (independent checks: <judge>)", "verified (your
    checks)", "verified (post-work audit: <judge>)" (--post-work-audit, tier
    verified-audit: checks drafted after the work, gated on the pre-work tree
    and on mutants), or "passed own checks (<worker>), not verified" (never counted as
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
    # The api2 lane: host and key variable from BENCH_API2_HOST / BENCH_API2_KEYVAR (run-in-container.sh).
    api2_host = os.environ.get("BENCH_API2_HOST") or ""
    api2_var = os.environ.get("BENCH_API2_KEYVAR") or "ANTHROPIC_API_KEY"
    key = (openrouter_key() if "openrouter.ai" in URL
           else KEYS.get(api2_var) or os.environ.get(api2_var, "") if api2_host and api2_host in URL
           else "local")
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
    write_private(log, out)
    # Maat's own notices (criteria not drafted, dropped checks, refusals) go to stderr.
    write_private(log.with_suffix(".err"), err or "")
    steps = 0; per = []; outcome = None; spend = {}; judge = None; review = None; disagree = []; extra = {}
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
            # The judge's asks (drafting, critic, review, audit), metered apart from
            # the worker's. Absent on builds before judge metering, or when no judge ran.
            judge = ev.get("judge")
            review = ev.get("review")
            disagree = ev.get("checksDisagree") or []
            # Only what job_end carried; absent keys stay absent (older builds).
            extra = {k: ev[k] for k in ("revealed", "deadline", "endedBy", "retired", "build", "tier", "tierReason", "providerStall", "checkAuthors", "audit") if k in ev}
    # The provider's daily cap, not the work: every later task would fail the
    # same way (2026-10-05: eleven tasks per arm "failed" in 140 s, 0 turns).
    capped = provider_capped(out, steps, err or "")
    return {
        "provider_capped": capped,
        "secs": round(secs), "turns": steps, "calls": sum(per), "multi": sum(1 for x in per if x > 1),
        "tokens_in": spend.get("promptTokens"), "cost_usd": spend.get("costUsd"),
        **judge_columns(judge),
        "claim": outcome, "timed_out": timed_out,
        "said_done": (outcome or "").startswith("verified"),
        # The reviewer's label: a verified claim it did not confirm.
        "review": review,
        # Refused only by molt's own drafted checks (reported unverified).
        "checks_disagree": disagree,
        "said_done_reviewed": (outcome or "").startswith("verified") and not (review and not review.get("confirmed")),
        **extra,
    }


def judge_columns(judge: dict | None) -> dict:
    """The judge's tokens and $, next to the worker's `tokens_in` / `cost_usd`.

    Only when the run output carried them (job_end.judge, Maat's judge meter): None
    otherwise, so an older build is never read as a free judge. `judge_cost_usd` is
    None when the judge's model had no price ("$ unknown"), never 0."""
    if not isinstance(judge, dict):
        return {}
    return {
        "judge_calls": judge.get("calls"),
        "judge_tokens_in": judge.get("promptTokens"),
        "judge_tokens_out": judge.get("completionTokens"),
        "judge_cache_read": judge.get("cacheReadTokens"),
        "judge_cache_write": judge.get("cacheWriteTokens"),
        "judge_cost_usd": judge.get("costUsd"),
    }


# Per-run cost alarm (reports/loop-charter.md, non-regression rule 1): a run that
# costs more than max(5x the lane's running median cost, $0.10), or sends more
# than 1.5M prompt tokens, stops the lane before the bill grows. 2026-10-07: one
# task cost 2.68M tokens / $0.82 because malformed calls were resent in full.
COST_ALARM_EXIT = 3


def alarm_limits() -> dict:
    """The alarm thresholds, each overridable by env."""
    return {
        "x": float(os.environ.get("BENCH_COST_ALARM_X") or 5),
        "usd": float(os.environ.get("BENCH_COST_ALARM_USD") or 0.10),
        "tokens": int(float(os.environ.get("BENCH_TOKEN_ALARM") or 1_500_000)),
    }


def _sum_known(*xs):
    """The sum of the values that are known, or None when none is."""
    known = [x for x in xs if x is not None]
    return sum(known) if known else None


def run_cost(row: dict) -> float | None:
    """A run's whole cost: the worker's plus the judge's (judge_columns). None when
    neither is known; an unpriced judge adds nothing it cannot price."""
    return _sum_known(row.get("cost_usd"), row.get("judge_cost_usd"))


def run_tokens(row: dict) -> int | None:
    """A run's prompt tokens, the worker's plus the judge's."""
    return _sum_known(row.get("tokens_in"), row.get("judge_tokens_in"))


def cost_alarm(row: dict, prior_costs: list[float]) -> dict | None:
    """Why this run trips the alarm, or None. `prior_costs` are the lane's earlier runs'
    total costs (this run excluded): the median is over runs that reported a cost. A
    run with no cost (an unpriced model) is judged on its prompt tokens only.

    Cost and tokens are the worker's plus the judge's: a runaway judge trips it too.
    When the run had a judge, the detail says how the total splits."""
    lim = alarm_limits()
    med = statistics.median(prior_costs) if prior_costs else None
    limit_usd = max(lim["x"] * med, lim["usd"]) if med is not None else lim["usd"]
    cost, toks = run_cost(row), run_tokens(row)
    judged = row.get("judge_calls") is not None

    def usd(x):
        return "$ unknown" if x is None else f"${x:.4f}"

    why = []
    if cost is not None and cost > limit_usd:
        split = f" (worker {usd(row.get('cost_usd'))} + judge {usd(row.get('judge_cost_usd'))})" if judged else ""
        why.append(f"cost ${cost:.4f}{split} > ${limit_usd:.4f} (max({lim['x']:g}x lane median "
                   f"{'n/a' if med is None else f'${med:.4f}'}, ${lim['usd']:g}))")
    if toks is not None and toks > lim["tokens"]:
        split = (f" (worker {row.get('tokens_in') or 0:,} + judge {row.get('judge_tokens_in') or 0:,})"
                 if judged else "")
        why.append(f"prompt tokens {toks:,}{split} > {lim['tokens']:,}")
    if not why:
        return None
    return {"detail": "; ".join(why), "cost_usd": cost, "tokens_in": toks,
            **({"worker_cost_usd": row.get("cost_usd"), "judge_cost_usd": row.get("judge_cost_usd"),
                "worker_tokens_in": row.get("tokens_in"), "judge_tokens_in": row.get("judge_tokens_in")}
               if judged else {}),
            "lane_median_usd": med, "limit_usd": round(limit_usd, 6), "limit_tokens": lim["tokens"]}


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


STOPPED_EXIT = 3  # the provider's cap stopped the lane before it finished

GRADER_FILES = ("run.py", "grading.py", "tasks.py", "tasks2.py", "tasks3.py")


def grader_hash() -> str:
    """sha256 (12 hex) of the harness and every grader: rows graded by different code differ."""
    import hashlib
    h = hashlib.sha256()
    for f in GRADER_FILES:
        h.update(f.encode() + b"\0" + (HERE / f).read_bytes() + b"\0")
    return h.hexdigest()[:12]


def _public_env(env: dict) -> dict:
    return {k: v for k, v in sorted(env.items()) if not any(x in k.upper() for x in SECRET_ENV)}


def lane_meta(arms: list[tuple[str | None, dict]]) -> dict:
    """
    Everything that makes a lane this lane, on every row (B6 of the PR #33 audit): rows did not
    say which model, endpoint, reasoning, limit, gate, judge or grader produced them, and a second
    lane resumed into the same file as if it were the first.
    """
    from urllib.parse import urlsplit, urlunsplit
    u = urlsplit(URL)
    url = urlunsplit((u.scheme, u.hostname + (f":{u.port}" if u.port else "") if u.hostname else u.netloc, u.path, "", ""))
    return {
        "model": os.environ.get("BENCH_MODEL") or MODEL,
        "url": url,
        "reasoning": os.environ.get("BENCH_REASONING") or "low",
        "limit": LIMIT,
        "gate": "yes" if os.environ.get("BENCH_GATE") == "yes" else "sandbox",
        "reference": os.environ.get("REFERENCE", "0"),
        # judge (MAAT_JUDGE_*) and every other Maat setting the lane runs with, secrets left out
        "maat_env": _public_env({k: v for k, v in os.environ.items() if k.startswith("MAAT_") and k != "MAAT_BUILD"}),
        "arms": {name or "": _public_env(env) for name, env in arms},
        "build": os.environ.get("MAAT_BUILD"),
        "grader": grader_hash(),
        "agent_user": AGENT_USER,
        "cpus": os.environ.get("BENCH_CPUS"),
        "memory": os.environ.get("BENCH_MEMORY"),
    }


def lane_id(meta: dict) -> str:
    import hashlib
    return hashlib.sha256(json.dumps(meta, sort_keys=True).encode()).hexdigest()[:12]


def read_results(out: Path) -> list[dict]:
    """
    The rows already in a results file. A last line cut short (the lane was killed while writing
    it) is moved to <file>.partial and cut from the file, so the resume neither crashes on it nor
    glues the next row onto it. A broken line anywhere else is real damage and stops the run.
    """
    if not out.exists():
        return []
    raw = out.read_bytes()
    lines = raw.split(b"\n")
    tail = lines.pop()  # b"" when the file ends with a newline
    rows = []
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            sys.exit(f"{out}: line {i + 1} is not JSON; not resuming into a damaged results file")
    if tail.strip():
        try:
            rows.append(json.loads(tail))
            with out.open("ab") as f:
                f.write(b"\n")
        except ValueError:
            with out.with_name(out.name + ".partial").open("ab") as f:
                f.write(tail + b"\n")
            with out.open("r+b") as f:
                f.truncate(len(raw) - len(tail))
            print(f"{out}: the last line was cut short; moved to {out.name}.partial", file=sys.stderr, flush=True)
    return rows


def arm_order(arms: list, rep: int, task_index: int) -> list:
    """ABBA: arm order alternates per (task, rep), so neither arm always runs first."""
    return arms if len(arms) < 2 or (rep + task_index) % 2 == 0 else arms[::-1]


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
    meta = lane_meta(arms)
    lid = lane_id(meta)
    done = set()
    lane_costs: dict = {}  # arm -> costs of its runs so far, for the cost alarm's median
    rows = read_results(out)  # resume: skip runs already recorded
    other = sorted({str(r.get("lane_id")) for r in rows if r.get("lane_id") != lid})
    if other:
        sys.exit(f"{out} holds rows of another lane (lane_id {', '.join(other)}; this lane is {lid}): "
                 "not appending to it. Use another RESULTS file.")
    for r in rows:
        if r.get("stopped"):  # a STOPPED marker, not a run
            continue
        done.add((r["task"], r["agent"], r["rep"], r.get("arm")))
        if run_cost(r) is not None:
            lane_costs.setdefault(r.get("arm"), []).append(run_cost(r))
    global SCRUBBER
    SCRUBBER = make_scrubber()
    for rep in range(repeats):
        for ti, T in enumerate(tasks):
            # paired: both arms on this task before the next task, in ABBA order
            for pos, (arm, arm_env) in enumerate(arm_order(arms, rep, ti)):
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
                        # Not recorded, so a resume runs this task again. Non-zero: the lane is not done.
                        print(f"STOPPED: the provider's daily limit / quota is reached ({tag} not recorded)", flush=True)
                        sys.exit(STOPPED_EXIT)
                    # Nothing the worker started is still running while it is graded.
                    kill_agent_procs()
                    try:
                        ok, why, gerr = grade(T, d)
                    except BaseException:
                        finish_task(d, [log, log.with_suffix(".err")])
                        raise
                    final = ""
                    r.update(task=T.name, agent=a, rep=rep, passed=ok, why=why, final=final[:300], grader_error=gerr)
                    if arm:
                        r["arm"] = arm
                        r["arm_pos"] = pos
                    r["lane_id"] = lid
                    r["lane"] = meta
                    if os.environ.get("MAAT_BUILD"):
                        r["build"] = os.environ["MAAT_BUILD"]  # sha8 of the packed Maat the container ran
                    # The result is written before the export, so nothing in the export can lose it.
                    with out.open("a") as f:
                        f.write(json.dumps(r) + "\n")
                    finish_task(d, [log, log.with_suffix(".err")])
                    print(json.dumps({k: r[k] for k in ("task", "agent", "arm", "rep", "passed", "said_done", "turns", "secs") if k in r}), flush=True)
                    costs = lane_costs.setdefault(arm, [])
                    alarm = cost_alarm(r, costs)
                    if alarm:
                        stop_lane(out, tag, EXPORT / f"{tag}.log", alarm, arm, lid)
                    if run_cost(r) is not None:
                        costs.append(run_cost(r))


def stop_lane(out: Path, tag: str, log: Path, alarm: dict, arm: str | None, lid: str | None = None) -> None:
    """Record a STOPPED row (no `passed`: not a run) and end the lane non-zero."""
    row = {"stopped": True, "reason": "cost alarm", "run": tag, "log": str(log), **alarm}
    if lid:
        row["lane_id"] = lid  # the same lane: a resume does not take it for another
    if arm:
        row["arm"] = arm
    with out.open("a") as f:
        f.write(json.dumps(row) + "\n")
    print(f"STOPPED: cost alarm on {tag}: {alarm['detail']}\n  log: {log}", flush=True)
    sys.exit(COST_ALARM_EXIT)



if __name__ == "__main__":
    args = sys.argv[1:]
    which = args[0] if args else "molt"
    repeats = int(args[1]) if len(args) > 1 else 1
    main(which, repeats, args[2] if len(args) > 2 else None)
