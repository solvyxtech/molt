import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402


class ProviderCap(unittest.TestCase):
    def test_openrouter_daily_cap(self):
        self.assertTrue(run.provider_capped('..."rate limit is reached until 17:00 - x"', 3))
        self.assertTrue(run.provider_capped("free-models-per-day", 0))
        self.assertFalse(run.provider_capped("free-models-per-day", 4))

    def test_opencode_limit(self):
        self.assertTrue(run.provider_capped("OpenCode rate limit (HTTP 429): Free usage limit reached", 0))
        self.assertFalse(run.provider_capped("OpenCode rate limit (HTTP 429): Free usage limit reached", 3))

    def test_ordinary_failure_is_not_a_cap(self):
        self.assertFalse(run.provider_capped("tests failed", 5))


if __name__ == "__main__":
    unittest.main()
