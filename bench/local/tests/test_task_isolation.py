"""
A task cannot list or read another task's folder or logs.

2026-10-07, ml4b lanes: a worker spent 90-125 tool calls per task reading the other tasks'
folders and Maat logs in the shared, host-mounted /work instead of working. Each task now runs
in a private folder (BENCH_WORK/<random>/<tag>), its logs go to a root-only folder, and both are
copied to the export only after the task is graded.

The first test runs anywhere (a Mac host lane included): it checks the layout. The second needs
the real thing, root and the unprivileged agent user, and runs inside the bench image:

    bench/local/tests/isolation-in-container.sh
"""

import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402


def task(name: str):
    class T:
        PROMPT = f"do {name}"

        @staticmethod
        def setup(d: Path) -> None:
            (d / "input.txt").write_text(f"{name} input\n")

        @staticmethod
        def grade(d: Path):
            return (d / "out.txt").exists(), "graded"

    T.name = name
    return T


class Harness:
    """run.main over two fake tasks, with a fake agent that records what it could see."""

    def __init__(self, work: Path, export: Path, results: Path, agent=None):
        self.saved = {k: getattr(run, k) for k in ("WORK", "EXPORT", "TASKS", "run_molt", "AGENT_USER")}
        self.env = {k: os.environ.get(k) for k in ("RESULTS_DIR", "RESULTS", "ARMS", "BENCH_TASKS")}
        run.WORK, run.EXPORT, run.AGENT_USER = work, export, agent
        run.TASKS = [task("iso-a"), task("iso-b")]
        os.environ.update(RESULTS_DIR=str(results), RESULTS="iso.jsonl")
        for k in ("ARMS", "BENCH_TASKS"):
            os.environ.pop(k, None)
        self.seen: list[dict] = []

    def restore(self):
        for k, v in self.saved.items():
            setattr(run, k, v)
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class Layout(unittest.TestCase):
    def test_tasks_run_in_private_folders_and_only_finished_work_is_exported(self):
        tmp = Path(tempfile.mkdtemp())
        h = Harness(tmp / "work", tmp / "export", tmp / "results")
        try:
            def fake(d: Path, prompt: str, log: Path) -> dict:
                h.seen.append({
                    "dir": d, "log": log,
                    # what is left of the tasks before this one, where this one runs
                    "box_listing": sorted(os.listdir(d.parent)),
                    "earlier_dirs_exist": [s["dir"].exists() for s in h.seen],
                    "earlier_logs_exist": [s["log"].exists() for s in h.seen],
                    "exported_so_far": sorted(os.listdir(tmp / "export")) if (tmp / "export").exists() else [],
                })
                (d / "out.txt").write_text("x\n")
                log.write_text('{"kind":"job_end"}\n')
                return {"secs": 0, "turns": 0, "claim": "verified", "said_done": True}

            run.run_molt = fake
            run.main("molt", 1, "iso-a,iso-b")
        finally:
            h.restore()
        a, b = h.seen
        for s in h.seen:
            self.assertFalse(s["dir"].is_relative_to(tmp / "export"), "a task never runs in the export")
            self.assertNotEqual(s["log"].parent, s["dir"], "logs are not written into a task folder")
            self.assertEqual(s["box_listing"], [s["dir"].name], "the private parent holds this task only")
        self.assertNotEqual(a["dir"].parent, b["dir"].parent, "each task has its own random parent")
        self.assertEqual(b["earlier_dirs_exist"], [False], "task a's private folder is gone before task b starts")
        self.assertEqual(b["earlier_logs_exist"], [False], "task a's private log is gone before task b starts")
        self.assertIn("iso-a-molt-0", b["exported_so_far"], "task a was exported when it finished")
        self.assertNotIn("iso-b-molt-0", b["exported_so_far"])
        out = tmp / "export"
        for t in ("iso-a-molt-0", "iso-b-molt-0"):
            self.assertTrue((out / t / "out.txt").exists())
            self.assertTrue((out / f"{t}.log").exists())
        rows = [json.loads(x) for x in (tmp / "results" / "iso.jsonl").read_text().splitlines()]
        self.assertEqual([r["passed"] for r in rows], [True, True])
        # nothing of either task is left where tasks run, but the (empty) root-only log folder
        self.assertEqual(sorted(os.listdir(tmp / "work")), [".logs"])
        self.assertEqual(os.listdir(tmp / "work" / ".logs"), [])
        shutil.rmtree(tmp)


class SpecialFilesAndOrder(unittest.TestCase):
    def test_a_fifo_or_socket_in_the_task_folder_does_not_stop_the_lane(self):
        import socket
        tmp = Path(tempfile.mkdtemp())
        h = Harness(tmp / "work", tmp / "export", tmp / "results")
        socks = []
        try:
            def fake(d: Path, prompt: str, log: Path) -> dict:
                os.mkfifo(d / "pipe")
                s = socket.socket(socket.AF_UNIX)
                # AF_UNIX paths are short; bind from inside the folder.
                cwd = os.getcwd()
                os.chdir(d)
                try:
                    s.bind("srv.sock")
                finally:
                    os.chdir(cwd)
                socks.append(s)
                (d / "out.txt").write_text("x\n")
                log.write_text('{"kind":"job_end"}\n')
                return {"secs": 0, "turns": 0, "claim": "verified", "said_done": True}

            run.run_molt = fake
            run.main("molt", 1, "iso-a,iso-b")
        finally:
            h.restore()
            for s in socks:
                s.close()
        rows = [json.loads(x) for x in (tmp / "results" / "iso.jsonl").read_text().splitlines()]
        self.assertEqual([r["task"] for r in rows], ["iso-a", "iso-b"], "both tasks ran and were recorded")
        self.assertEqual([r["passed"] for r in rows], [True, True])
        for t in ("iso-a-molt-0", "iso-b-molt-0"):
            self.assertTrue((tmp / "export" / t / "out.txt").exists(), "the regular files were exported")
            self.assertFalse((tmp / "export" / t / "pipe").exists(), "the FIFO was skipped")
            self.assertFalse((tmp / "export" / t / "srv.sock").exists(), "the socket was skipped")
        self.assertEqual(sorted(os.listdir(tmp / "work")), [".logs"], "no private folder left behind")
        shutil.rmtree(tmp)

    def test_agent_processes_are_killed_before_grading_and_the_result_is_written_before_the_export(self):
        tmp = Path(tempfile.mkdtemp())
        h = Harness(tmp / "work", tmp / "export", tmp / "results")
        events: list[str] = []
        saved = (run.kill_agent_procs, run.finish_task)
        results = tmp / "results" / "iso.jsonl"
        try:
            def fake(d: Path, prompt: str, log: Path) -> dict:
                events.append("agent")
                (d / "out.txt").write_text("x\n")
                return {"secs": 0, "turns": 0, "claim": "verified", "said_done": True}

            real_finish = run.finish_task
            run.run_molt = fake
            run.kill_agent_procs = lambda: events.append("kill")
            run.finish_task = lambda d, logs: (events.append("export:" + str(len(results.read_text().splitlines()) if results.exists() else 0)), real_finish(d, logs))
            grade_a = run.TASKS[0].grade
            run.TASKS[0].grade = staticmethod(lambda d: (events.append("grade"), grade_a(d))[1])
            run.main("molt", 1, "iso-a")
        finally:
            run.kill_agent_procs, run.finish_task = saved
            h.restore()
        self.assertEqual(events[:3], ["agent", "kill", "grade"], events)
        self.assertIn("export:1", events, "the row was on disk before the export ran")
        shutil.rmtree(tmp)


def have_agent_user() -> bool:
    if os.geteuid() != 0 or not shutil.which("runuser"):
        return False
    try:
        pwd.getpwnam(os.environ.get("BENCH_AGENT_USER") or "agent")
        return True
    except KeyError:
        return False


@unittest.skipUnless(have_agent_user(), "needs root and the agent user: run isolation-in-container.sh")
class AsTheAgentUser(unittest.TestCase):
    def test_the_agent_cannot_list_or_read_another_tasks_folder_or_logs(self):
        user = os.environ.get("BENCH_AGENT_USER") or "agent"
        # As in the container: tasks under a container-local folder, the export under /root (700).
        os.chmod("/root", 0o700)
        work = Path(tempfile.mkdtemp(dir="/var/tmp")) / "bench-work"
        os.chmod(work.parent, 0o755)  # like /var/lib: the agent may pass through to BENCH_WORK
        export = Path(tempfile.mkdtemp(dir="/root")) / "bench-export"
        results = Path(tempfile.mkdtemp(dir="/root"))
        h = Harness(work, export, results, agent=user)

        def as_agent(script: str) -> subprocess.CompletedProcess:
            cmd, _ = run.as_agent(["sh", "-c", script])
            return subprocess.run(cmd, capture_output=True, text=True)

        try:
            def fake(d: Path, prompt: str, log: Path) -> dict:
                probes = {
                    "own_input": as_agent(f"cat {d}/input.txt"),
                    "own_write": as_agent(f"echo x > {d}/out.txt"),
                    "list_work": as_agent(f"ls {work}"),
                    "list_logs": as_agent(f"ls {work}/.logs"),
                    "list_box": as_agent(f"ls {d.parent}"),
                    "list_export": as_agent(f"ls {export}"),
                }
                if h.seen:
                    a = h.seen[0]
                    probes |= {
                        "other_dir": as_agent(f"ls {a['dir']}"),
                        "other_input": as_agent(f"cat {a['dir']}/input.txt"),
                        "other_log_private": as_agent(f"cat {a['log']}"),
                        "other_dir_exported": as_agent(f"ls {export}/{a['dir'].name}"),
                        "other_log_exported": as_agent(f"cat {export}/{a['log'].name}"),
                        "find_logs": as_agent(f"find / -xdev -name '*.log' -path '*iso-*' 2>/dev/null"),
                        "find_inputs": as_agent(f"grep -rl 'iso-a input' / --exclude-dir=proc --exclude-dir=sys 2>/dev/null"),
                    }
                h.seen.append({"dir": d, "log": log, "probes": probes})
                log.write_text('{"kind":"job_end","secret":"iso-a log"}\n')
                return {"secs": 0, "turns": 0, "claim": "verified", "said_done": True}

            run.run_molt = fake
            run.main("molt", 1, "iso-a,iso-b")
        finally:
            h.restore()
        a, b = h.seen
        for s in h.seen:
            p = s["probes"]
            self.assertEqual(p["own_input"].returncode, 0, p["own_input"].stderr)
            self.assertEqual(p["own_write"].returncode, 0, p["own_write"].stderr)
            for k in ("list_work", "list_logs", "list_box", "list_export"):
                self.assertNotEqual(p[k].returncode, 0, f"{k} worked: {p[k].stdout}")
        p = b["probes"]
        for k in ("other_dir", "other_input", "other_log_private", "other_dir_exported", "other_log_exported"):
            self.assertNotEqual(p[k].returncode, 0, f"task b could {k}: {p[k].stdout}")
        self.assertEqual(p["find_logs"].stdout.strip(), "", "task b found task a's log")
        self.assertEqual(p["find_inputs"].stdout.strip(), "", "task b found task a's files")
        # Exported for the owner all the same.
        self.assertTrue((export / "iso-a-molt-0" / "out.txt").exists())
        self.assertIn("iso-a log", (export / "iso-a-molt-0.log").read_text())


@unittest.skipUnless(have_agent_user(), "needs root and the agent user: run isolation-in-container.sh")
class GradedAsTheAgentUser(unittest.TestCase):
    def test_the_workers_code_runs_unprivileged_during_grading_and_cannot_reach_the_results(self):
        user = os.environ.get("BENCH_AGENT_USER") or "agent"
        uid = pwd.getpwnam(user).pw_uid
        os.chmod("/root", 0o700)
        work = Path(tempfile.mkdtemp(dir="/var/tmp")) / "bench-work"
        os.chmod(work.parent, 0o755)
        export = Path(tempfile.mkdtemp(dir="/root")) / "bench-export"
        results = Path(tempfile.mkdtemp(dir="/root"))
        h = Harness(work, export, results, agent=user)
        os.environ["FAKE_API_KEY"] = "sk-must-not-leak"
        seen: dict = {}
        try:
            def fake(d: Path, prompt: str, log: Path) -> dict:
                # A hostile "solution": run by the grader, it tries to forge a result and read secrets.
                (d / "server.py").write_text(
                    "import os, glob\n"
                    "out = {'uid': os.getuid(), 'key': os.environ.get('FAKE_API_KEY')}\n"
                    f"try:\n    open('{results}/iso.jsonl', 'a').write('forged\\n'); out['forged'] = True\n"
                    "except OSError:\n    out['forged'] = False\n"
                    "print(repr(out))\n"
                )
                (d / "out.txt").write_text("x\n")
                os.chown(d / "server.py", uid, -1)
                return {"secs": 0, "turns": 0, "claim": "verified", "said_done": True}

            def grade(d: Path):
                seen["grader_uid"] = os.getuid()
                p = subprocess.run(["python3", "server.py"], cwd=d, capture_output=True, text=True)
                seen["worker"] = p.stdout.strip()
                return True, "graded"

            run.run_molt = fake
            run.TASKS[0].grade = staticmethod(grade)
            run.main("molt", 1, "iso-a")
            # The grader ran in a child: what it saw comes back only through its verdict, so ask again directly.
            ok, why = run.grade(type("T", (), {"grade": staticmethod(lambda d: (True, repr((os.getuid(), subprocess.run(["python3", "-c", "import os;print(os.getuid(), os.environ.get('FAKE_API_KEY'))"], capture_output=True, text=True).stdout.strip()))))}), Path("/tmp"))
        finally:
            h.restore()
            os.environ.pop("FAKE_API_KEY", None)
        rows = (results / "iso.jsonl").read_text().splitlines()
        self.assertEqual(len(rows), 1, rows)
        self.assertNotIn("forged", "\n".join(rows))
        self.assertTrue(json.loads(rows[0])["passed"])
        self.assertTrue(ok)
        self.assertEqual(why, repr((uid, f"{uid} None")), "the grader and what it runs are the agent user, without the secrets")


if __name__ == "__main__":
    unittest.main()
