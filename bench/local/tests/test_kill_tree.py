import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402


def test_kill_tree_releases_the_pipe_a_grandchild_holds():
    # A grandchild keeps stdout open: killing only the top process would leave communicate() waiting.
    proc = subprocess.Popen(["sh", "-c", "sleep 30 & sleep 30"], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)
    t0 = time.time()
    try:
        proc.communicate(timeout=0.5)
    except subprocess.TimeoutExpired:
        run.kill_tree(proc)
        proc.communicate(timeout=5)
    assert time.time() - t0 < 5
