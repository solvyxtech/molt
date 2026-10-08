"""The graders never run git on the agent's own repository config (2026-10-07 review).

An agent that owns the task folder owns its .git/config, and core.fsmonitor,
hooks and filters there name programs git runs. Graders run as root, so they
grade a sanitized root-owned copy instead.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402

pytestmark = pytest.mark.skipif(not shutil.which("git"), reason="needs git")


def sh(cmd, cwd, env=None):
    return subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, env=env)


def hostile_repo(tmp_path: Path) -> tuple[Path, Path]:
    d = tmp_path / "task"
    d.mkdir()
    marker = tmp_path / "pwned"
    sh("git init -q -b master && git config user.email t@t && git config user.name t", d)
    (d / "a.txt").write_text("one\n")
    (d / ".gitattributes").write_text("*.txt filter=evil diff=evil\n")
    sh("git add -A && git commit -qm init", d)
    (d / "a.txt").write_text("two\n")
    # Everything an agent could plant for git to run.
    for k, v in [
        ("core.fsmonitor", f"touch {marker}.fsmonitor; false"),
        ("filter.evil.clean", f"sh -c 'touch {marker}.filter; cat'"),
        ("diff.evil.textconv", f"sh -c 'touch {marker}.textconv; cat \"$1\"' -"),
        ("core.pager", f"touch {marker}.pager; cat"),
        ("alias.status", f"!touch {marker}.alias"),
        ("include.path", str(tmp_path / "more.cfg")),
    ]:
        subprocess.run(["git", "config", k, v], cwd=d, check=True)
    (tmp_path / "more.cfg").write_text(f"[core]\n\thooksPath = {d}/.git/myhooks\n")
    hooks = d / ".git" / "hooks"
    hooks.mkdir(exist_ok=True)
    for h in ("post-checkout", "pre-commit", "post-index-change"):
        p = hooks / h
        p.write_text(f"#!/bin/sh\ntouch {marker}.{h}\n")
        p.chmod(0o755)
    return d, marker


def planted(tmp_path: Path) -> list[str]:
    return sorted(p.name for p in tmp_path.glob("pwned*"))


def grader_git(copy: Path, env=None) -> None:
    env = env or (os.environ | run.GRADER_GIT_ENV)
    for cmd in ("git status --porcelain", "git diff", "git show master:a.txt", "git log -1",
                "git rev-parse --abbrev-ref HEAD", "git checkout -q master", "git add -A"):
        sh(cmd, copy, env)


def test_the_planted_config_does_run_on_the_original(tmp_path):
    # The control: the same grader commands on the agent's own repository fire the traps,
    # so the test below would see them if the copy kept any.
    d, _ = hostile_repo(tmp_path)
    grader_git(d, env=dict(os.environ))
    assert planted(tmp_path), "the control should have fired at least one planted command"


def test_graders_git_on_the_copy_runs_nothing_the_agent_planted(tmp_path):
    d, _ = hostile_repo(tmp_path)
    copy = run.grading_copy(d)
    try:
        grader_git(copy)
        assert planted(tmp_path) == []
        # And the copy still grades: history and the working tree are intact.
        env = os.environ | run.GRADER_GIT_ENV
        assert sh("git show HEAD:a.txt", copy, env).stdout == "one\n"
        assert (copy / "a.txt").read_text() == "two\n"
        assert "filter" not in (copy / ".git" / "config").read_text()
    finally:
        shutil.rmtree(copy.parent, ignore_errors=True)


def test_copy_skips_fifos_and_keeps_links_as_links(tmp_path):
    d = tmp_path / "task"
    d.mkdir()
    (d / "f.txt").write_text("x")
    os.mkfifo(d / "pipe")
    (d / "link").symlink_to("/etc/hostname")
    copy = run.grading_copy(d)
    try:
        assert (copy / "f.txt").read_text() == "x"
        assert not (copy / "pipe").exists()
        assert (copy / "link").is_symlink()
    finally:
        shutil.rmtree(copy.parent, ignore_errors=True)
