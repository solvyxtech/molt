import getpass
import os
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402


def test_privsep_keeps_maat_root_and_names_the_worker(monkeypatch):
    monkeypatch.setattr(run, "AGENT_USER", "agent")
    monkeypatch.setattr(run, "PRIVSEP", True)
    cmd, _ = run.as_agent(["node", "cli.js", "run", "--url", "u", "the task"])
    assert cmd == ["node", "cli.js", "run", "--worker-user", "agent", "--url", "u", "the task"]


def test_without_privsep_the_whole_agent_runs_as_the_user(monkeypatch):
    me = getpass.getuser()
    monkeypatch.setattr(run, "AGENT_USER", me)
    monkeypatch.setattr(run, "PRIVSEP", False)
    cmd, _ = run.as_agent(["node", "cli.js", "run", "t"])
    assert cmd[:4] == ["runuser", "-u", me, "--"]


def test_no_agent_user_changes_nothing(monkeypatch):
    monkeypatch.setattr(run, "AGENT_USER", None)
    assert run.as_agent(["node", "cli.js", "run", "t"])[0] == ["node", "cli.js", "run", "t"]


def test_logs_are_written_owner_only(tmp_path):
    p = tmp_path / "task.log"
    run.write_private(p, "hidden: grep -q secret out.txt\n")
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    assert p.read_text().startswith("hidden")
