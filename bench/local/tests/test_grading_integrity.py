"""
The PR #33 bench audit (reports/grok-reviews/bench-audit-pr33.md), item by item, as the reviewer
reproduced it, with benign markers in place of anything hostile.

Most tests run anywhere. The ones that need root and the unprivileged agent user (a repository
another user owns, the real /tmp and ~agent) run inside the bench image:

    bench/local/tests/isolation-in-container.sh
"""

from __future__ import annotations

import io
import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import grading  # noqa: E402
import refs2  # noqa: E402
import run  # noqa: E402
import scoreboard as sb  # noqa: E402
import stats  # noqa: E402
import tasks  # noqa: E402
import tasks2  # noqa: E402
import tasks3  # noqa: E402
import validate3  # noqa: E402

REFS = HERE / "reference_solutions"


def fresh(T) -> Path:
    d = Path(tempfile.mkdtemp(prefix=f"gi-{T.name}-"))
    T.setup(d)
    return d


def solve_fix_git(d: Path) -> None:
    """The reference for fix-git: merge the commit made on the detached HEAD (found in the reflog)."""
    log = subprocess.run(["git", "log", "-g", "--format=%H %s", "HEAD"], cwd=d, capture_output=True, text=True).stdout
    sha = next(line.split()[0] for line in log.splitlines() if line.endswith("Move to Stanford"))
    subprocess.run(["git", "merge", "-q", "--no-edit", sha], cwd=d, check=True, capture_output=True)


def solved(T) -> Path:
    d = fresh(T)
    if T is tasks.FixGit:
        solve_fix_git(d)
    elif hasattr(refs2, "solve_" + T.name.replace("-", "_")):
        getattr(refs2, "solve_" + T.name.replace("-", "_"))(d)
    else:
        validate3.apply(REFS / T.name, d, REFS / T.name)
    return d


# ---------------------------------------------------------------- B1
class B1GitOwnership(unittest.TestCase):
    """Correct work in a repository the grader does not own used to fail: git refused it."""

    def test_git_graders_pass_correct_work_in_a_repository_owned_by_another_user(self):
        # GIT_TEST_ASSUME_DIFFERENT_OWNER is git's own switch for "another user owns this": what
        # `chown -R agent` did to every task folder before root graded it. (The tasks3 git graders
        # also build a reference repo of their own, which the switch would refuse too; they are
        # covered as root in the container, with a real chown.)
        for T in (tasks.FixGit, tasks2.GitRevert):
            d = solved(T)
            try:
                self.assertTrue(T.grade(d)[0], f"{T.name}: the reference passes when this user owns the repo")
                os.environ["GIT_TEST_ASSUME_DIFFERENT_OWNER"] = "1"
                try:
                    ok_old, why_old = T.grade(d)
                    ok, why, err = grading.safe_grade(T, d)
                finally:
                    del os.environ["GIT_TEST_ASSUME_DIFFERENT_OWNER"]
                self.assertFalse(ok_old, f"{T.name}: reproduces the audit (git refused the repo): {why_old}")
                self.assertTrue(ok, f"{T.name}: {why}")
                self.assertFalse(err)
            finally:
                shutil.rmtree(d, ignore_errors=True)

    def test_grader_git_does_not_run_the_workers_fsmonitor_or_hooks(self):
        d = solved(tasks.FixGit)
        try:
            marker = d.parent / (d.name + ".fsmonitor-ran")
            hook = d / ".git" / "watch.sh"
            hook.write_text(f"#!/bin/sh\ntouch '{marker}'\nexit 1\n")
            hook.chmod(0o755)
            subprocess.run(["git", "config", "core.fsmonitor", str(hook)], cwd=d, check=True)
            subprocess.run(["git", "status", "--porcelain"], cwd=d, capture_output=True)
            self.assertTrue(marker.exists(), "without the guard, git status runs the repo's fsmonitor command")
            marker.unlink()
            ok, why, _ = grading.safe_grade(tasks.FixGit, d)
            self.assertFalse(marker.exists(), "the grader ran the worker's fsmonitor command")
            env = grading.git_env(d)
            pairs = {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"] for i in range(int(env["GIT_CONFIG_COUNT"]))}
            self.assertEqual(pairs["core.hooksPath"], os.devnull)
            self.assertEqual(pairs["core.fsmonitor"], "false")
            self.assertEqual(env["GIT_CONFIG_GLOBAL"], os.devnull, "the agent's ~/.gitconfig is not read")
        finally:
            shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------- B2
ATEXIT_OK = "\nimport atexit\natexit.register(print, 'OK')\n"


class B2VerdictOutOfProcess(unittest.TestCase):
    """The worker's module used to be able to print the grader's "OK" itself."""

    def assertFails(self, T, d, msg):
        ok, why = T.grade(d)
        self.assertFalse(ok, f"{T.name} passed ({why}): {msg}")
        return why

    def test_size_parse_bug_atexit_ok(self):
        d = fresh(tasks2.SizeParse)
        (d / "sizes.py").write_text((d / "sizes.py").read_text() + ATEXIT_OK)
        self.assertFails(tasks2.SizeParse, d, "the buggy file plus atexit.register(print, 'OK')")

    def test_refactor_pricing_atexit_ok(self):
        d = fresh(tasks2.RefactorPricing)
        (d / "pricing.py").write_text((d / "pricing.py").read_text() + ATEXIT_OK)
        self.assertFails(tasks2.RefactorPricing, d, "the original file plus the hook")

    def test_perf_pairs_ok_and_exit_at_import(self):
        d = fresh(tasks2.PerfPairs)
        (d / "pairs.py").write_text("import os\nprint('OK', flush=True)\nos._exit(0)\n" + (d / "pairs.py").read_text())
        self.assertFails(tasks2.PerfPairs, d, "print('OK'); os._exit(0) at import")

    def test_duration_bug_bad_marker_in_stdout(self):
        d = fresh(tasks.DurationBug)
        (d / "dur.py").write_text("print('BAD []')\n" + (d / "dur.py").read_text())
        self.assertFails(tasks.DurationBug, d, "'BAD []' anywhere in stdout passed")

    @unittest.skipUnless(shutil.which("node"), "needs node")
    def test_async_pool_node_exit_hook(self):
        d = fresh(tasks3.AsyncPoolNode)
        (d / "pool.js").write_text(
            "process.on('exit', () => console.log('OK'));\n"
            "exports.mapLimit = async (items, limit, fn) => Promise.all(items.map(fn));\n")  # no limit at all
        self.assertFails(tasks3.AsyncPoolNode, d, "process.on('exit', () => console.log('OK'))")

    def test_vendor_units_refactor_invoice_rename_api_atexit_ok(self):
        d = fresh(tasks3.VendorUnits)
        (d / "app" / "retry.py").write_text((d / "app" / "retry.py").read_text() + ATEXIT_OK)
        self.assertFails(tasks3.VendorUnits, d, "unfixed retry.py plus the hook")

        d = fresh(tasks3.RefactorInvoice)
        (d / "tax.py").write_text("def compute_tax(b, r):\n    return 0\n" + ATEXIT_OK)
        (d / "format.py").write_text("def money(c, r):\n    return ''\n")
        self.assertFails(tasks3.RefactorInvoice, d, "stub modules plus the hook")

        d = fresh(tasks3.RenameApi)
        validate3.apply(REFS / "_wrong" / "rename-api-signature" / "1", d, REFS / "rename-api-signature")
        init = d / "shop" / "__init__.py"
        init.write_text(init.read_text() + ATEXIT_OK)
        why = self.assertFails(tasks3.RenameApi, d, "a wrong rename plus the hook")
        self.assertIn("make_loader", why)

    def test_a_forged_or_second_values_record_fails(self):
        # Writing a record of its own to the values channel at import: the grader then sees two.
        d = fresh(tasks2.SizeParse)
        (d / "sizes.py").write_text(
            "import os, __main__\nos.write(__main__._BFD, b'{\"good\": [], \"bad\": []}\\n')\n"
            + (d / "sizes.py").read_text())
        why = self.assertFails(tasks2.SizeParse, d, "a forged record at import")
        self.assertIn("more than one record", why)
        # A forged record and an immediate exit: the values do not cover the inputs.
        (d / "sizes.py").write_text(
            "import os\nos.write(int(os.environ['BENCH_VALUES_FD']), b'{\"good\": [], \"bad\": []}\\n')\nos._exit(0)\n")
        self.assertFails(tasks2.SizeParse, d, "a forged empty record")

    def test_the_references_still_pass(self):
        for T in (tasks2.SizeParse, tasks2.RefactorPricing, tasks.DurationBug):
            d = fresh(T)
            if T is tasks.DurationBug:
                (d / "dur.py").write_text(
                    "import re\ndef parse_duration(s):\n    s = s.strip()\n    if s.isdigit():\n        return int(s)\n"
                    "    m = re.fullmatch(r'(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?', s)\n"
                    "    return sum(int(x or 0) * k for x, k in zip(m.groups(), (3600, 60, 1)))\n")
            else:
                getattr(refs2, "solve_" + T.name.replace("-", "_"))(d)
            self.assertEqual(T.grade(d), (True, "all formats" if T is tasks.DurationBug else "all checks"), T.name)


# ---------------------------------------------------------------- run.main harness
def task(name: str, grade=None):
    class T:
        PROMPT = f"do {name}"

        @staticmethod
        def setup(d: Path) -> None:
            (d / "input.txt").write_text(f"{name} input\n")

    T.name = name
    T.grade = staticmethod(grade or (lambda d: ((d / "out.txt").exists(), "graded")))
    return T


class Lane:
    """run.main in a temporary layout with a fake agent; everything it touches is put back."""

    ENV = ("RESULTS_DIR", "RESULTS", "ARMS", "BENCH_TASKS", "BENCH_MODEL", "MAAT_BUILD", "REFERENCE")

    def __init__(self, tasks_, agent=None, **env):
        self.tmp = Path(tempfile.mkdtemp(prefix="gi-lane-"))
        self.saved = {k: getattr(run, k) for k in ("WORK", "EXPORT", "TASKS", "run_molt", "AGENT_USER", "make_scrubber", "SCRUBBER")}
        self.env = {k: os.environ.get(k) for k in self.ENV}
        run.WORK, run.EXPORT, run.AGENT_USER = self.tmp / "work", self.tmp / "export", None
        run.TASKS = tasks_
        run.run_molt = agent
        for k in self.ENV:
            os.environ.pop(k, None)
        os.environ.update(RESULTS_DIR=str(self.tmp / "results"), RESULTS="r.jsonl", **env)
        self.results = self.tmp / "results" / "r.jsonl"

    def main(self, repeats=1, names=None):
        return run.main("molt", repeats, names or ",".join(T.name for T in run.TASKS))

    def rows(self):
        return [json.loads(x) for x in self.results.read_text().splitlines()]

    def close(self):
        for k, v in self.saved.items():
            setattr(run, k, v)
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)


def done(d: Path, *args) -> dict:
    """A fake agent that does the work: done(d, prompt, log) as run_molt, or done(d, log)."""
    log = args[-1]
    (d / "out.txt").write_text("x\n")
    log.write_text('{"kind":"job_end"}\n')
    return {"secs": 0, "turns": 1, "claim": "verified", "said_done": True}


# ---------------------------------------------------------------- B3
class B3NothingCarriesOver(unittest.TestCase):
    def test_notes_left_in_tmp_and_home_do_not_reach_the_next_rep_or_arm(self):
        lane = Lane([task("carry-a"), task("carry-b")], ARMS="A:X=1;B:X=2")
        faketmp, home = lane.tmp / "tmp", lane.tmp / "home"
        faketmp.mkdir()
        home.mkdir()
        (home / "cred.json").write_text('{"token": "benign"}\n')
        seen = []

        def agent(d, prompt, log):
            notes = [p for p in (faketmp / ".bench-notes", home / ".bench-notes") if p.exists()]
            seen.append((d.name, [p.read_text() for p in notes], (home / "cred.json").read_text()))
            (faketmp / ".bench-notes").write_text(f"solution of {d.name}\n")
            (home / ".bench-notes").write_text(f"solution of {d.name}\n")
            (faketmp / "maat-check-123").mkdir()
            (home / "cred.json").write_text("overwritten\n")
            return done(d, log)

        run.run_molt = agent
        run.make_scrubber = lambda: (lambda sc: (sc.take(), sc)[1])(
            run.Scrubber(os.getuid(), home, lane.tmp / "snap" / "home", dirs=[faketmp]))
        try:
            lane.main(repeats=2)
            self.assertEqual(len(seen), 8, "2 tasks x 2 reps x 2 arms")
            for name, notes, cred in seen:
                self.assertEqual(notes, [], f"{name} read notes an earlier run left")
                self.assertEqual(cred, '{"token": "benign"}\n', f"{name} saw a changed credential")
            self.assertEqual(os.listdir(faketmp), [])
            self.assertEqual(os.listdir(home), ["cred.json"])
        finally:
            lane.close()

    def test_scrub_leaves_other_users_files_and_does_not_follow_links(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            (tmp / "t").mkdir()
            outside = tmp / "outside.txt"
            outside.write_text("keep\n")
            (tmp / "t" / "link").symlink_to(outside)
            (tmp / "t" / "f").write_text("x")
            sc = run.Scrubber(os.getuid() + 12345, tmp / "h", tmp / "s", dirs=[tmp / "t"])
            self.assertEqual(sc.scrub(), [], "nothing of another uid is removed")
            sc = run.Scrubber(os.getuid(), tmp / "h", tmp / "s", dirs=[tmp / "t"])
            self.assertEqual(sorted(Path(p).name for p in sc.scrub()), ["f", "link"])
            self.assertEqual(outside.read_text(), "keep\n", "the link was removed, not followed")
        finally:
            shutil.rmtree(tmp)

    def test_arm_order_alternates(self):
        order = []
        lane = Lane([task("ab-0"), task("ab-1")], ARMS="A:X=1;B:X=2")

        def agent(d, prompt, log):
            order.append(d.name)
            return done(d, log)

        run.run_molt = agent
        try:
            lane.main(repeats=2)
            self.assertEqual(order, ["ab-0-molt-0-A", "ab-0-molt-0-B", "ab-1-molt-0-B", "ab-1-molt-0-A",
                                     "ab-0-molt-1-B", "ab-0-molt-1-A", "ab-1-molt-1-A", "ab-1-molt-1-B"])
            self.assertEqual({(r["task"], r["rep"], r["arm"]): r["arm_pos"] for r in lane.rows()}[("ab-1", 0, "B")], 0)
        finally:
            lane.close()


# ---------------------------------------------------------------- B4
class B4GraderErrors(unittest.TestCase):
    def test_a_grader_that_raises_is_a_failed_row_and_the_lane_goes_on(self):
        def boom(d):
            raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "benign marker")

        lane = Lane([task("ge-a", boom), task("ge-b")], agent=done)
        try:
            lane.main()
            rows = lane.rows()
            self.assertEqual([r["task"] for r in rows], ["ge-a", "ge-b"], "the lane went on to the next task")
            self.assertEqual((rows[0]["passed"], rows[0]["grader_error"]), (False, True))
            self.assertIn("grader error", rows[0]["why"])
            self.assertEqual((rows[1]["passed"], rows[1]["grader_error"]), (True, False))
            # resume: the failed row is recorded, so it is not run again
            ran = []
            run.run_molt = lambda d, p, log: (ran.append(d.name), done(d, log))[1]
            lane.main()
            self.assertEqual(ran, [])
        finally:
            lane.close()

    def test_cheap_end_states_no_longer_raise(self):
        d = fresh(tasks.DurationBug)
        (d / "test_dur.py").unlink()
        self.assertEqual(grading.safe_grade(tasks.DurationBug, d), (False, "the tests were changed", False))
        d = fresh(tasks3.RenameApi)
        (d / "CHANGELOG.md").unlink()
        self.assertEqual(grading.safe_grade(tasks3.RenameApi, d)[1:], ("CHANGELOG.md was modified", False))
        d = Path(tempfile.mkdtemp())
        (d / "wc.py").write_text("import sys\nsys.stdout.buffer.write(b'\\xff\\n')\n")
        ok, why, err = grading.safe_grade(tasks.Wc, d)
        self.assertEqual((ok, err), (False, False), why)

    def test_a_hang_is_a_fail_not_a_grader_error(self):
        def hang(d):
            subprocess.run(["sleep", "5"], timeout=0.1)

        self.assertEqual(grading.safe_grade(task("hang", hang), Path("."))[0::2], (False, False))


# ---------------------------------------------------------------- B5
class B5ProviderCap(unittest.TestCase):
    PHRASE = "the provider's rate limit is reached until 10/7/2026, 12:00:00 AM"

    def test_worker_text_does_not_stop_the_lane(self):
        tool = json.dumps({"kind": "tool", "name": "bash", "args": "cat app.log", "preview": self.PHRASE})
        text = json.dumps({"kind": "text", "text": "echo " + self.PHRASE})
        self.assertFalse(run.provider_capped(tool + "\n" + text + "\n", 3))
        self.assertFalse(run.provider_capped(json.dumps({"kind": "tool", "preview": "free-models-per-day"}), 0))

    def test_maats_error_event_stderr_and_plain_lines_still_do(self):
        self.assertTrue(run.provider_capped(json.dumps({"kind": "error", "text": self.PHRASE}) + "\n", 3))
        self.assertTrue(run.provider_capped("", 3, err=self.PHRASE))
        self.assertTrue(run.provider_capped(self.PHRASE + "\n", 3))

    def test_stopped_exits_non_zero_and_records_nothing(self):
        lane = Lane([task("cap-a"), task("cap-b")], agent=lambda d, p, log: {"provider_capped": True})
        try:
            with redirect_stdout(io.StringIO()) as out, self.assertRaises(SystemExit) as e:
                lane.main()
            self.assertEqual(e.exception.code, run.STOPPED_EXIT)
            self.assertNotEqual(e.exception.code, 0)
            self.assertIn("STOPPED", out.getvalue())
            self.assertFalse(lane.results.exists() and lane.results.read_text().strip())
        finally:
            lane.close()


# ---------------------------------------------------------------- B6
class B6LaneMetadata(unittest.TestCase):
    def test_rows_carry_the_lane(self):
        lane = Lane([task("ln-a")], agent=done, BENCH_MODEL="model-a", ARMS="j:MAAT_JUDGE_MODEL=judge-x,MAAT_JUDGE_KEY=sk-benign",
                    MAAT_BUILD="abc12345")
        try:
            lane.main()
            r = lane.rows()[0]
            L = r["lane"]
            self.assertEqual(L["model"], "model-a")
            self.assertEqual((L["reasoning"], L["limit"], L["gate"], L["build"]), ("low", run.LIMIT, "sandbox", "abc12345"))
            self.assertIn("url", L)
            self.assertEqual(L["arms"], {"j": {"MAAT_JUDGE_MODEL": "judge-x"}}, "judge settings recorded, the key left out")
            self.assertEqual(L["grader"], run.grader_hash())
            self.assertEqual(r["lane_id"], run.lane_id(L))
        finally:
            lane.close()

    def test_another_lane_is_not_appended_to_the_same_file(self):
        lane = Lane([task("ln-a"), task("ln-b")], agent=done, BENCH_MODEL="model-a")
        try:
            lane.main()
            before = lane.results.read_text()
            os.environ["BENCH_MODEL"] = "model-b"
            with self.assertRaises(SystemExit) as e:
                lane.main()
            self.assertIn("another lane", str(e.exception.code))
            self.assertEqual(lane.results.read_text(), before)
            # legacy rows with no lane at all are refused too
            lane.results.write_text(json.dumps({"task": "ln-a", "agent": "molt", "rep": 0, "passed": True}) + "\n")
            with self.assertRaises(SystemExit):
                lane.main()
        finally:
            lane.close()

    def test_a_truncated_last_line_is_tolerated_on_resume(self):
        lane = Lane([task("tr-a"), task("tr-b")], agent=done)
        try:
            lane.main(names="tr-a")
            good = lane.results.read_text()
            lane.results.write_text(good + '{"task": "tr-b", "agent": "mo')
            with redirect_stdout(io.StringIO()):
                lane.main()
            rows = lane.rows()
            self.assertEqual([r["task"] for r in rows], ["tr-a", "tr-b"])
            self.assertTrue(lane.results.with_name("r.jsonl.partial").read_text().startswith('{"task": "tr-b"'))
        finally:
            lane.close()


# ---------------------------------------------------------------- non-blocking
class N1SymlinksIntoTheBench(unittest.TestCase):
    def test_a_link_to_a_reference_solution_fails_before_grading(self):
        d = Path(tempfile.mkdtemp())
        try:
            (d / "solve.sh").symlink_to(REFS / "git-find-culprit" / "solve.sh")
            (d / "own").write_text("x")
            (d / "ok-link").symlink_to(d / "own")
            ran = []
            T = task("n1", lambda dd: (ran.append(1), (True, "followed"))[1])
            saved, run.AGENT_USER = run.AGENT_USER, None  # this process grades (the image sets an agent user)
            self.addCleanup(setattr, run, "AGENT_USER", saved)
            ok, why, err = run.grade(T, d)
            self.assertFalse(ok)
            self.assertIn("solve.sh", why)
            self.assertEqual(ran, [], "no grader ran")
            (d / "solve.sh").unlink()
            self.assertTrue(run.grade(T, d)[0], "a link inside the task folder is fine")
        finally:
            shutil.rmtree(d)


class N2WcScratch(unittest.TestCase):
    def test_a_premade_wc_grade_folder_is_not_written_through(self):
        tmp = Path(tempfile.mkdtemp())
        saved = os.environ.get("TMPDIR")
        try:
            victim = tmp / "victim.txt"
            victim.write_text("benign\n")
            (tmp / "wc-grade").mkdir()
            (tmp / "wc-grade" / "a.txt").symlink_to(victim)
            os.environ["TMPDIR"] = str(tmp)
            tempfile.tempdir = None
            d = tmp / "task"
            d.mkdir()
            (d / "wc.py").write_text("print('x')\n")
            tasks.Wc.grade(d)
            self.assertEqual(victim.read_text(), "benign\n")
        finally:
            if saved is None:
                os.environ.pop("TMPDIR", None)
            else:
                os.environ["TMPDIR"] = saved
            tempfile.tempdir = None
            shutil.rmtree(tmp)


class N4PooledPairs(unittest.TestCase):
    def test_pooled_runs_are_not_paired_twice(self):
        rows = lambda arm, passes: [{"task": f"t{i}", "agent": "molt", "rep": 0, "arm": arm, "passed": p} for i, p in enumerate(passes)]
        a = rows("A", [1, 0] * 5) + rows("A", [1, 0] * 5)  # two base files under one label
        b = rows("B", [1, 1] * 5) + rows("B", [1, 1] * 5)
        with self.assertRaises(sb.Ambiguous):
            sb.pair_up(a, b)
        lines, verdict = sb.compare("A", "B", a, b, "pass", 0.0)
        self.assertIn("NO VERDICT", verdict)
        self.assertTrue(any("by task (10 tasks" in x for x in lines), lines)


class N7Stalls(unittest.TestCase):
    def test_stalled_and_grader_error_rows_are_counted_apart(self):
        rows = [{"task": "a", "passed": True}, {"task": "b", "passed": False, "providerStall": True},
                {"task": "c", "passed": False, "grader_error": True}, {"task": "d", "passed": False}]
        m = sb.metrics(rows)
        self.assertEqual((m["n"], m["pass"], m["stall"], m["grader_error"]), (2, 1, 1, 1))


class TaskLevelStats(unittest.TestCase):
    def test_repeats_are_averaged_within_a_task(self):
        # 3 tasks: one passes 3/3, one 0/3, one 1/3 -> mean of fractions 4/9, not rows 4/9 by luck
        rows = [{"task": "x", "passed": True}] * 3 + [{"task": "y", "passed": False}] * 3 + \
               [{"task": "z", "passed": p} for p in (True, False, False)] + [{"task": "x", "passed": False, "grader_error": True}]
        self.assertEqual(stats.per_task(rows), {"x": (3, 3), "y": (0, 3), "z": (1, 3)})
        tr = stats.task_rate(rows)
        self.assertEqual(tr["tasks"], 3)
        self.assertAlmostEqual(tr["mean"], 4 / 9)
        self.assertLessEqual(tr["lo"], tr["mean"])
        self.assertGreaterEqual(tr["hi"], tr["mean"])

    def test_paired_by_task(self):
        a = [{"task": f"t{i}", "passed": i < 5} for i in range(10) for _ in range(3)]
        b = [{"task": f"t{i}", "passed": i < 8} for i in range(10) for _ in range(3)]
        pt = stats.paired_tasks(a, b)
        self.assertEqual((pt["tasks"], pt["b_better"], pt["a_better"]), (10, 3, 0))
        self.assertAlmostEqual(pt["mean_diff"], 0.3)
        self.assertAlmostEqual(pt["perm_p"], 2 / 8)  # 3 equal nonzero diffs: only all-same signs reach |sum|
        self.assertAlmostEqual(pt["sign_p"], 0.25)
        # the 30 row pairs would have said 9 discordant, p = 0.004: the repeats are not independent
        self.assertLess(stats.sign_test(0, 9), 0.01)


# ---------------------------------------------------------------- as root, in the bench image
def have_agent_user() -> bool:
    if os.geteuid() != 0 or not shutil.which("runuser"):
        return False
    try:
        pwd.getpwnam(os.environ.get("BENCH_AGENT_USER") or "agent")
        return True
    except KeyError:
        return False


@unittest.skipUnless(have_agent_user(), "needs root and the agent user: run isolation-in-container.sh")
class AsRootInTheImage(unittest.TestCase):
    def setUp(self):
        self.user = os.environ.get("BENCH_AGENT_USER") or "agent"
        self.pw = pwd.getpwnam(self.user)

    def test_b1_all_four_git_tasks_pass_correct_work_owned_by_the_agent(self):
        saved = run.AGENT_USER
        try:
            for T in (tasks.FixGit, tasks2.GitRevert, tasks3.GitSplitHistory, tasks3.GitFindCulprit):
                d = solved(T)
                os.chmod(d, 0o755)
                subprocess.run(["chown", "-R", self.user, str(d)], check=True)
                ok_old, why_old = T.grade(d)
                self.assertFalse(ok_old, f"{T.name}: reproduces the audit as root without the guard: {why_old}")
                self.assertEqual(grading.safe_grade(T, d)[0::2], (True, False), f"{T.name} as root with the guard")
                run.AGENT_USER = self.user
                ok, why, err = run.grade(T, d)
                run.AGENT_USER = saved
                self.assertTrue(ok, f"{T.name} as the agent user: {why}")
                shutil.rmtree(d)
        finally:
            run.AGENT_USER = saved

    def test_b3_the_real_tmp_dirs_and_home_are_reset(self):
        snap = Path(tempfile.mkdtemp(dir="/root")) / "home"
        home = Path(self.pw.pw_dir)
        (home / ".keep-me").write_text("cred\n")
        subprocess.run(["chown", self.user, str(home / ".keep-me")], check=True)
        sc = run.Scrubber(self.pw.pw_uid, home, snap)
        sc.take()
        mine = Path(tempfile.mkdtemp(dir="/tmp", prefix="root-own-"))
        try:
            script = ("echo n > /tmp/.bench-notes; echo n > /var/tmp/.bench-notes; mkdir -p /tmp/maat-check-1/x; "
                      "[ -d /dev/shm ] && echo n > /dev/shm/.bench-notes; echo n > ~/.bench-notes; echo changed > ~/.keep-me; "
                      f"mkdir ~/.maat; true")
            cmd, _ = run.as_agent(["sh", "-c", script])
            subprocess.run(cmd, check=True)
            sc.reset()
            for p in ("/tmp/.bench-notes", "/var/tmp/.bench-notes", "/tmp/maat-check-1", "/dev/shm/.bench-notes",
                      str(home / ".bench-notes"), str(home / ".maat")):
                self.assertFalse(os.path.lexists(p), p)
            self.assertEqual((home / ".keep-me").read_text(), "cred\n")
            self.assertEqual(os.stat(home / ".keep-me").st_uid, self.pw.pw_uid)
            self.assertTrue(mine.exists(), "root's own files in /tmp are left alone")
        finally:
            shutil.rmtree(mine, ignore_errors=True)
            (home / ".keep-me").unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
