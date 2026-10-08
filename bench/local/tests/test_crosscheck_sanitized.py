"""crosscheck.py grades and runs checks on sanitized copies, as run.py does (2026-10-07 review).

The trees it re-grades are agent-written, so their .git/config can name programs for git to run
(core.fsmonitor, hooks, filters, an include). crosscheck used to set safe.directory=* and run
git on a plain copy. Now the grader goes through run.grade_safely and each check gets a copy
from run.sanitized_copy. The test plants every trap from test_grading_copy, runs a grader and a
check that both drive git, and asserts no trap fired and safe.directory was never set.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import crosscheck  # noqa: E402
import tasks  # noqa: E402
from test_grading_copy import hostile_repo, planted  # noqa: E402

pytestmark = pytest.mark.skipif(not shutil.which("git"), reason="needs git")

GIT = "git status --porcelain; git diff; git log -1; git add -A; git diff --cached; git checkout -q master"


class FakeTask:
    name = "crosscheck-fake"

    def grade(self, d: Path):
        subprocess.run(GIT, shell=True, cwd=d, capture_output=True)
        return True, (Path(d) / "a.txt").read_text().strip()


def test_grader_and_checks_run_nothing_the_agent_planted(tmp_path, monkeypatch, capsys):
    d, _ = hostile_repo(tmp_path)
    monkeypatch.setattr(tasks, "TASKS", [*tasks.TASKS, FakeTask()])
    job = tmp_path / "job.json"
    job.write_text(json.dumps({"name": "fake-molt-1", "task": FakeTask.name, "checks": [GIT + "; echo check-ran"]}))
    before = {k: os.environ.get(k) for k in ("GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0")}
    crosscheck.inside(str(job), str(d), str(tmp_path / "work"))
    out = capsys.readouterr().out
    res = json.loads(out.split("@@RESULT@@", 1)[1])
    assert res["grade"] == [True, "two"], res
    assert "check-ran" in res["checks"][GIT + "; echo check-ran"]["out"]
    assert planted(tmp_path) == [], f"a planted git command ran: {planted(tmp_path)}"
    assert {k: os.environ.get(k) for k in before} == before, "inside() changed the git config environment"
    assert "safe.directory" not in json.dumps(dict(os.environ))
