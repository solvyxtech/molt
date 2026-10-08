"""The judge's tokens and $ in each result row, next to the worker's.

Maat meters the judge's asks (drafting, critic, review, audit) apart from the
worker's requests and reports them on job_end as `judge`. A row carries them only
when the run output did, and an unpriced judge is None, never 0.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402


def test_columns_from_job_end_judge():
    cols = run.judge_columns({
        "calls": 4, "promptTokens": 12000, "completionTokens": 900,
        "cacheReadTokens": 3000, "cacheWriteTokens": 500, "costUsd": 0.0123,
    })
    assert cols == {
        "judge_calls": 4, "judge_tokens_in": 12000, "judge_tokens_out": 900,
        "judge_cache_read": 3000, "judge_cache_write": 500, "judge_cost_usd": 0.0123,
    }


def test_unpriced_judge_is_none_not_zero():
    cols = run.judge_columns({"calls": 2, "promptTokens": 800, "completionTokens": 100,
                              "cacheReadTokens": 0, "cacheWriteTokens": 0, "unpricedCalls": 2})
    assert cols["judge_tokens_in"] == 800
    assert cols["judge_cost_usd"] is None


def test_no_judge_in_the_output_adds_no_columns():
    assert run.judge_columns(None) == {}
