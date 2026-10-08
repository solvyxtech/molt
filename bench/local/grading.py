"""
What every grading path shares (run.py, regrade_today.py, crosscheck.py, the validators).

- git_env / git_guard: grader git never refuses the worker's repository for its owner, and never
  runs the worker's hooks or fsmonitor (B1 of the PR #33 audit).
- child_values / PY_EMIT / emit_js: a grader that has to run the worker's code in a process only
  takes computed VALUES back from it, as one JSON record on a dedicated file descriptor; the
  grader process compares them with the expected values, which never enter the worker's process
  (B2). A last stdout line "OK" was forgeable by an atexit hook in the worker's module.
- safe_grade: a grader that raises records a failed row flagged grader_error instead of stopping
  the lane (B4).
- links_into: a symlink in the task folder that resolves into the bench's own folders (graders,
  reference solutions, results, export) fails the task before any grader follows it (N1).
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

# ---------------------------------------------------------------- B1: git as the grader sees it

# Applied in the command scope (GIT_CONFIG_COUNT), which outranks the repository's own config.
GIT_GRADE_CONFIG = (("core.hooksPath", os.devnull), ("core.fsmonitor", "false"))


def git_env(d: Path | str) -> dict[str, str]:
    """
    Environment for every git command a grader runs on task folder `d`:

    - safe.directory=<d> (both spellings, as given and resolved), so a repository owned by the
      agent user is not refused as "dubious ownership" when root grades it. Git >= 2.35.2 printed
      nothing for every grader call and four git tasks failed correct work.
    - core.hooksPath=/dev/null and core.fsmonitor=false: the ownership refusal used to be the only
      thing keeping root's git from running the worker's hooks or fsmonitor command.
    - GIT_CONFIG_GLOBAL=/dev/null: the agent user's ~/.gitconfig is the worker's to write.
    """
    p = Path(d)
    dirs = list(dict.fromkeys([str(p), str(p.resolve())]))
    pairs = [("safe.directory", x) for x in dirs] + list(GIT_GRADE_CONFIG)
    env = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_COUNT": str(len(pairs)), "GIT_TERMINAL_PROMPT": "0"}
    for i, (k, v) in enumerate(pairs):
        env[f"GIT_CONFIG_KEY_{i}"] = k
        env[f"GIT_CONFIG_VALUE_{i}"] = v
    return env


@contextlib.contextmanager
def git_guard(d: Path | str):
    """git_env(d) in os.environ for the duration (graders' children inherit it), then restored."""
    add = git_env(d)
    stale = [k for k in os.environ if k.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"))]
    saved = {k: os.environ.get(k) for k in [*add, *stale]}
    for k in stale:
        del os.environ[k]
    os.environ.update(add)
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ---------------------------------------------------------------- B2: values out of process

VALUES_FD_ENV = "BENCH_VALUES_FD"

# Prepended to every Python harness: emit(v) writes v as the one record on the values channel and
# ends the process at once (os._exit, so an atexit hook in the worker's module cannot add to it).
PY_EMIT = (
    "import os as _bo, json as _bj\n"
    f"_BFD = int(_bo.environ.pop({VALUES_FD_ENV!r}))\n"
    "def _btag(v):\n"
    "    if isinstance(v, tuple):\n"
    "        return {'$tuple': [_btag(x) for x in v]}\n"
    "    if isinstance(v, list):\n"
    "        return [_btag(x) for x in v]\n"
    "    if isinstance(v, dict):\n"
    "        return {k: _btag(x) for k, x in v.items()}\n"
    "    return v\n"
    "def emit(v):\n"
    "    b = (_bj.dumps(_btag(v), default=repr) + '\\n').encode()\n"
    "    while b:\n"
    "        b = b[_bo.write(_BFD, b):]\n"
    "    _bo._exit(0)\n"
    "def call(f, *a, **k):\n"
    "    try:\n"
    "        return ['ok', f(*a, **k)]\n"
    "    except Exception as e:\n"
    "        return ['err', type(e).__name__, str(e)[:300], isinstance(e, ValueError), isinstance(e, TypeError)]\n"
)

# The same for a Node harness: `emit(v)`.
JS_EMIT = (
    "const __bfs = require('fs');\n"
    f"const __bfd = Number(process.env.{VALUES_FD_ENV});\n"
    "function emit(v) { __bfs.writeSync(__bfd, JSON.stringify(v) + '\\n'); process.exit(0); }\n"
)


def child_values(cmd: list[str], cwd: Path, timeout: float, env: dict | None = None) -> tuple[object | None, str]:
    """
    Run `cmd` (a harness that loads the worker's code) and return (values, diagnostic).

    The harness writes exactly one JSON record to the file descriptor named by $BENCH_VALUES_FD.
    values is None when there is no record, more than one, or it is not JSON; stdout and stderr
    are only ever a diagnostic, never a verdict.
    """
    e = dict(os.environ)
    e.update(env or {})
    with tempfile.TemporaryFile() as ch:
        e[VALUES_FD_ENV] = str(ch.fileno())
        try:
            r = subprocess.run(cmd, cwd=cwd, capture_output=True, timeout=timeout, env=e, pass_fds=(ch.fileno(),))
        except subprocess.TimeoutExpired:
            return None, f"timed out after {timeout}s"
        ch.seek(0)
        raw = ch.read()
    diag = (r.stdout + b"\n" + r.stderr).decode(errors="replace").strip()
    diag = diag.splitlines()[-1][:240] if diag else f"exit {r.returncode}"
    if not raw:
        return None, diag or "no values"
    lines = raw.split(b"\n")
    if len(lines) != 2 or lines[1] != b"":
        return None, "the values channel held more than one record"
    try:
        return json.loads(lines[0]), diag
    except ValueError:
        return None, "the values channel held no valid JSON"


def py_values(d: Path, code: str, timeout: float = 60) -> tuple[object | None, str]:
    """Run PY_EMIT + code in a fresh python3 inside d (see child_values)."""
    return child_values(["python3", "-c", PY_EMIT + code], d, timeout)


def tag(v):
    """Tuples as {"$tuple": [...]}, as emit() sends them: a tuple and a list stay unequal, as they
    were when the comparison ran next to the worker's code."""
    if isinstance(v, tuple):
        return {"$tuple": [tag(x) for x in v]}
    if isinstance(v, list):
        return [tag(x) for x in v]
    if isinstance(v, dict):
        return {k: tag(x) for k, x in v.items()}
    return v


def jsonish(v):
    """v as it looks after emit()'s JSON round trip, for comparing with child values."""
    return json.loads(json.dumps(tag(v), default=repr))


# ---------------------------------------------------------------- B4: a grader that raises

def safe_grade(T, d: Path) -> tuple[bool, str, bool]:
    """
    (passed, why, grader_error). A grader exception is a failed row with grader_error set, never
    an abort: the lane went on to the next task's free retry of this sample. A TimeoutExpired is the
    worker's program hanging, an ordinary fail.
    """
    try:
        with git_guard(d):
            ok, why = T.grade(d)
        return bool(ok), str(why), False
    except subprocess.TimeoutExpired as e:
        return False, f"timed out: {' '.join(map(str, e.cmd)) if isinstance(e.cmd, (list, tuple)) else e.cmd}"[:300], False
    except (Exception, SystemExit) as e:  # noqa: BLE001 - every failure is a verdict
        return False, f"grader error: {e!r}"[:2000], True


# ---------------------------------------------------------------- N1: links into the bench

def links_into(d: Path, roots: list[Path]) -> list[str]:
    """Symlinks under d (not followed) whose target resolves into one of `roots`. A link to
    something inside d itself is fine, wherever d lives."""
    rs = [Path(r).resolve() for r in roots if r]
    home = Path(d).resolve()
    bad = []
    for dirpath, dirnames, filenames in os.walk(d):
        for name in dirnames + filenames:
            p = Path(dirpath) / name
            if not p.is_symlink():
                continue
            try:
                t = p.resolve()
            except (OSError, RuntimeError):
                continue
            if t == home or t.is_relative_to(home):
                continue
            if any(t == r or t.is_relative_to(r) for r in rs):
                bad.append(os.path.relpath(p, d))
    return bad
