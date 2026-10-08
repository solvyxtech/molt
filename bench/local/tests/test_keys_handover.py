import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402


def test_keys_leave_the_environment_and_arrive_on_the_descriptor():
    env = {"PATH": os.environ.get("PATH", "/bin"), "MOLT_API_KEY": "k1", "OPENROUTER_API_KEY": "k2",
           "MAAT_JUDGE_KEY": "k3", "XAI_BASE": "k4", "BENCH_MODEL": "m"}
    clean, fds, r = run.keys_by_fd(env)
    try:
        child = subprocess.run(
            [sys.executable, "-c", "import os,sys;print(os.read(int(os.environ['MAAT_KEYS_FD']),65536).decode());print(sorted(os.environ))"],
            env=clean, capture_output=True, text=True, **fds)
    finally:
        os.close(r)
    keys_line, env_line = child.stdout.strip().split("\n")
    assert json.loads(keys_line) == {"MOLT_API_KEY": "k1", "OPENROUTER_API_KEY": "k2", "MAAT_JUDGE_KEY": "k3", "XAI_BASE": "k4"}
    names = eval(env_line)
    assert "BENCH_MODEL" in names and "MAAT_KEYS_FD" in names
    assert not any(n in names for n in ("MOLT_API_KEY", "OPENROUTER_API_KEY", "MAAT_JUDGE_KEY", "XAI_BASE"))


def test_keys_file_is_read_into_memory(tmp_path, monkeypatch):
    f = tmp_path / "keys"
    f.write_text("OPENROUTER_API_KEY=sk-x\n# c\n")
    monkeypatch.setenv("BENCH_KEYS_FILE", str(f))
    assert run.load_keys_file() == {"OPENROUTER_API_KEY": "sk-x"}
