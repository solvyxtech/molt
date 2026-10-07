import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

LOCAL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOCAL))
sys.path.insert(0, str(LOCAL.parent / "harbor"))
import scoreboard as sb  # noqa: E402
import stats  # noqa: E402

REAL = Path.home() / ".cache/maat-bench/container-results"
V = "verified (self-checked)"


def row(task, passed, claim, rep=0, **kw):
    return {"task": task, "agent": "molt", "rep": rep, "passed": passed, "claim": claim,
            "secs": 100, "turns": 5, "tokens_in": 1000, "timed_out": False, "checks_disagree": [], **kw}


class Stats(unittest.TestCase):
    def test_wilson(self):
        lo, hi = stats.wilson(5, 6)
        self.assertAlmostEqual(lo, 0.4365, 3)
        self.assertAlmostEqual(hi, 0.9699, 3)
        lo, hi = stats.wilson(15, 20)
        self.assertAlmostEqual(lo, 0.5313, 3)
        self.assertAlmostEqual(hi, 0.8881, 3)
        self.assertIsNone(stats.wilson(0, 0))
        self.assertAlmostEqual(stats.wilson(10, 10)[1], 1.0, 9)
        self.assertAlmostEqual(stats.wilson(0, 10)[0], 0.0, 9)

    def test_sign_test(self):
        self.assertEqual(stats.sign_test(0, 0), 1.0)
        self.assertAlmostEqual(stats.sign_test(5, 2), 0.453125)
        self.assertAlmostEqual(stats.sign_test(0, 5), 0.0625)
        self.assertAlmostEqual(stats.sign_test(6, 0), 0.03125)
        self.assertEqual(stats.sign_test(3, 3), 1.0)

    def test_percentile(self):
        self.assertEqual(stats.percentile([1, 2, 3, 4], 50), 2.5)
        self.assertEqual(stats.percentile(list(range(1, 11)), 90), 9)
        self.assertIsNone(stats.percentile([], 50))

    def test_no_verdict(self):
        self.assertTrue(stats.no_verdict({"claim": None}))
        self.assertTrue(stats.no_verdict({"claim": "error (self-checked)"}))
        self.assertTrue(stats.no_verdict({"claim": "stopped"}))
        self.assertTrue(stats.no_verdict({"claim": V, "timed_out": True}))
        self.assertFalse(stats.no_verdict({"claim": "unverified"}))


class Metrics(unittest.TestCase):
    def test_precision_recall(self):
        rows = [row("a", True, V), row("b", True, V), row("c", False, V), row("d", True, "unverified"),
                row("e", False, None), row("f", True, "error"),
                row("g", True, "unverified", checks_disagree=["x"])]
        m = sb.metrics(rows)
        self.assertEqual((m["n"], m["pass"], m["verified"], m["verified_pass"]), (7, 5, 3, 2))
        self.assertEqual(m["false_done"], 1)
        self.assertEqual(m["no_verdict"], 2)
        self.assertEqual(m["disagree_passed"], 1)
        out = "\n".join(sb.report_arm("x", m))
        self.assertIn("2/3 67%", out)  # precision
        self.assertIn("2/5 40%", out)  # recall


class Tiers(unittest.TestCase):
    def test_breakdown_counts_and_precision_per_tier(self):
        rows = [row("a", True, "verified", tier="verified"), row("b", True, "verified", tier="verified"),
                row("c", False, "verified", tier="verified"),
                row("d", True, "unverified", tier="passed-checks"), row("e", False, "unverified", tier="passed-checks"),
                row("f", True, "unverified")]  # an older build's row carries no tier
        self.assertEqual(stats.tier_breakdown(rows), {"verified": (3, 2), "passed-checks": (2, 1)})
        out = "\n".join(sb.report_arm("x", sb.metrics(rows)))
        self.assertIn("verified        n=3   2/3 67%", out)
        self.assertIn("passed-checks   n=2   1/2 50%", out)

    def test_no_tier_section_for_rows_without_one(self):
        out = "\n".join(sb.report_arm("x", sb.metrics([row("a", True, V)])))
        self.assertNotIn("tiers", out)


class Compare(unittest.TestCase):
    def arms(self, a_pass, b_pass, b_claims=None):
        tasks = [f"t{i}" for i in range(len(a_pass))]
        ra = [row(t, bool(p), V if p else "unverified") for t, p in zip(tasks, a_pass)]
        rb = [row(t, bool(p), (b_claims or {}).get(t, V if p else "unverified")) for t, p in zip(tasks, b_pass)]
        return ra, rb

    def test_ship(self):
        ra, rb = self.arms([1, 1, 0, 0], [1, 1, 1, 0])
        _, v = sb.compare("a", "b", ra, rb, "pass", 0.1)
        self.assertIn("VERDICT b vs a: SHIP", v)
        self.assertIn("LOW POWER", v)

    def test_pass_drop(self):
        ra, rb = self.arms([1, 1, 1, 0], [1, 0, 0, 0])
        _, v = sb.compare("a", "b", ra, rb, "secs", -1)
        self.assertIn("NO-SHIP (pass drop)", v)

    def test_one_task_drop_is_allowed(self):
        ra, rb = self.arms([1, 1, 1, 0], [1, 1, 0, 0])
        _, v = sb.compare("a", "b", ra, rb, "pass", -1)
        self.assertIn(": SHIP", v)

    def test_false_done_up_blocks(self):
        ra, rb = self.arms([1, 0, 0, 0], [1, 0, 0, 0], {"t1": V})
        _, v = sb.compare("a", "b", ra, rb, "pass", 0.0)
        self.assertIn("false-done up", v)

    def test_target_not_improved(self):
        ra, rb = self.arms([1, 0], [1, 0])
        _, v = sb.compare("a", "b", ra, rb, "precision", 0.1)
        self.assertIn("target not improved", v)

    def test_sign_test_reported(self):
        ra, rb = self.arms([1] * 5 + [0] * 2, [0] * 5 + [1] * 2)
        lines, _ = sb.compare("a", "b", ra, rb, "pass", -9)
        self.assertTrue(any("only A passed 5, only B passed 2" in x and "p = 0.453" in x for x in lines))

    def test_pairs_by_task_and_rep(self):
        a = [row("t", True, V, rep=0), row("t", False, "unverified", rep=1)]
        b = [row("t", True, V, rep=1)]
        self.assertEqual(len(sb.pair_up(a, b)), 1)

    def test_arm_column_grouping(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "r.jsonl"
            f.write_text("\n".join(json.dumps(r) for r in [row("t", True, V, arm="base"), row("t", False, V, arm="ref")]))
            self.assertEqual(sorted(sb.group([str(f)])), ["base", "ref"])


class RealFiles(unittest.TestCase):
    @unittest.skipUnless((REAL / "results-v8-base.jsonl").exists(), "container results not on this machine")
    def test_v8(self):
        b = sb.metrics(sb.load(REAL / "results-v8-base.jsonl"))
        self.assertEqual((b["n"], b["pass"], b["verified"], b["verified_pass"]), (20, 15, 6, 5))
        r = sb.metrics(sb.load(REAL / "results-v8-ref.jsonl"))
        self.assertEqual((r["n"], r["pass"]), (20, 12))
        buf = io.StringIO()
        with redirect_stdout(buf):
            sb.main([f"base={REAL / 'results-v8-base.jsonl'}", f"ref={REAL / 'results-v8-ref.jsonl'}"])
        self.assertIn("5/6 83%", buf.getvalue())
        self.assertIn("5/15 33%", buf.getvalue())


class HarborCompare(unittest.TestCase):
    def test_precision_recall_lines(self):
        import compare

        def job(root, name, trials):
            for i, (reward, said) in enumerate(trials):
                d = Path(root) / name / f"t{i}"
                (d / "agent").mkdir(parents=True)
                (d / "result.json").write_text(json.dumps({"task_name": f"t{i}", "verifier_result": {"rewards": {"reward": reward}}}))
                (d / "agent" / "molt.jsonl").write_text(json.dumps({"kind": "job_end", "outcome": said}) + "\n")
            return Path(root) / name

        with tempfile.TemporaryDirectory() as root:
            a = job(root, "a", [(1, "verified"), (1, "verified"), (0, "verified"), (1, "unverified")])
            b = job(root, "b", [(1, "verified"), (0, "unverified"), (0, "unverified"), (1, "unverified")])
            buf = io.StringIO()
            with redirect_stdout(buf):
                compare.main([str(a), str(b)])
            out = buf.getvalue()
            self.assertIn("precision", out)
            self.assertIn("2/3 67% [21-94]", out)  # a: precision; recall is 2/3 too
            self.assertIn("1/1 100%", out)  # b precision
            self.assertIn("1/2 50%", out)  # b recall


if __name__ == "__main__":
    unittest.main()
