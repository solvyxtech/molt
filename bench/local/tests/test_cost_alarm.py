"""The per-run cost alarm: a run far over the lane's usual cost stops the lane.

2026-10-07: one task cost 2.68M tokens / $0.82 because malformed tool calls were
resent in full every step. These tests pin the thresholds and that the lane
stops with a STOPPED row and a non-zero exit instead of running on.
"""
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run  # noqa: E402
import scoreboard  # noqa: E402


@pytest.fixture(autouse=True)
def _no_env_overrides(monkeypatch):
    for k in ("BENCH_COST_ALARM_X", "BENCH_COST_ALARM_USD", "BENCH_TOKEN_ALARM", "ARMS", "BENCH_TASKS", "MAAT_BUILD"):
        monkeypatch.delenv(k, raising=False)


def test_floor_applies_with_no_history():
    assert run.cost_alarm({"cost_usd": 0.09, "tokens_in": 1000}, []) is None
    a = run.cost_alarm({"cost_usd": 0.11, "tokens_in": 1000}, [])
    assert a and a["limit_usd"] == 0.10 and "cost $0.1100" in a["detail"]


def test_five_times_the_median_when_that_is_above_the_floor():
    prior = [0.03, 0.04, 0.05]  # median 0.04 -> limit 0.20
    assert run.cost_alarm({"cost_usd": 0.19}, prior) is None
    a = run.cost_alarm({"cost_usd": 0.21}, prior)
    assert a and a["limit_usd"] == pytest.approx(0.20) and a["lane_median_usd"] == 0.04


def test_floor_wins_over_a_tiny_median():
    # A cheap lane (median $0.002) must not alarm on an ordinary $0.05 run.
    assert run.cost_alarm({"cost_usd": 0.05}, [0.002, 0.002, 0.003]) is None


def test_the_regression_that_motivated_it_trips_both_alarms():
    a = run.cost_alarm({"cost_usd": 0.82, "tokens_in": 2_680_000}, [0.02, 0.03, 0.025])
    assert a and "cost $0.8200" in a["detail"] and "prompt tokens 2,680,000 > 1,500,000" in a["detail"]


def test_token_alarm_without_a_price():
    # Free models report no cost: prompt tokens are the only signal.
    assert run.cost_alarm({"cost_usd": None, "tokens_in": 1_400_000}, []) is None
    a = run.cost_alarm({"cost_usd": None, "tokens_in": 1_600_000}, [])
    assert a and a["cost_usd"] is None and a["limit_tokens"] == 1_500_000


def test_env_overrides(monkeypatch):
    monkeypatch.setenv("BENCH_COST_ALARM_X", "2")
    monkeypatch.setenv("BENCH_COST_ALARM_USD", "0.01")
    monkeypatch.setenv("BENCH_TOKEN_ALARM", "1000")
    assert run.cost_alarm({"cost_usd": 0.05}, [0.03]) is None  # limit max(0.06, 0.01)
    assert run.cost_alarm({"cost_usd": 0.07}, [0.03])
    assert run.cost_alarm({"tokens_in": 1001}, [])


class _Task:
    def __init__(self, name):
        self.name = name
        self.PROMPT = "p"

    def setup(self, d):
        pass

    def grade(self, d):
        return True, "ok"


def _lane(monkeypatch, tmp_path, costs):
    """Run main() over len(costs) fake tasks whose runs cost `costs`, in order."""
    monkeypatch.setattr(run, "WORK", tmp_path / "work")
    monkeypatch.setattr(run, "TASKS", [_Task(f"t{i}") for i in range(len(costs))])
    monkeypatch.setitem(sys.modules, "tasks2", types.SimpleNamespace(TASKS2=[]))
    monkeypatch.setitem(sys.modules, "tasks3", types.SimpleNamespace(TASKS3=[]))
    monkeypatch.setenv("RESULTS_DIR", str(tmp_path))
    monkeypatch.setenv("RESULTS", "lane.jsonl")
    it = iter(costs)

    def fake_molt(d, prompt, log):
        cost, toks = next(it)
        log.write_text("")
        return {"provider_capped": False, "cost_usd": cost, "tokens_in": toks, "turns": 3, "secs": 1}

    monkeypatch.setattr(run, "run_molt", fake_molt)
    return tmp_path / "lane.jsonl"


def test_lane_stops_with_a_stopped_row_and_nonzero_exit(monkeypatch, tmp_path, capsys):
    out = _lane(monkeypatch, tmp_path, [(0.02, 50_000), (0.03, 60_000), (0.82, 2_680_000), (0.02, 50_000)])
    with pytest.raises(SystemExit) as e:
        run.main("molt", 1, None)
    assert e.value.code == run.COST_ALARM_EXIT != 0
    rows = [json.loads(x) for x in out.read_text().splitlines()]
    assert [r.get("task") for r in rows[:3]] == ["t0", "t1", "t2"]  # the offending run is recorded
    stop = rows[3]
    assert len(rows) == 4, "the lane ran on after the alarm"
    assert stop["stopped"] is True and stop["reason"] == "cost alarm" and stop["run"] == "t2-molt-0"
    assert stop["cost_usd"] == 0.82 and stop["tokens_in"] == 2_680_000
    assert stop["log"].endswith("t2-molt-0.log")
    printed = capsys.readouterr().out
    assert "STOPPED: cost alarm on t2-molt-0" in printed and "t2-molt-0.log" in printed
    # The marker is not a run: the scoreboard does not count it.
    assert len(scoreboard.load(out)) == 3


def test_an_ordinary_lane_runs_to_the_end(monkeypatch, tmp_path):
    out = _lane(monkeypatch, tmp_path, [(0.02, 50_000), (0.06, 80_000), (0.03, 60_000)])
    run.main("molt", 1, None)
    rows = [json.loads(x) for x in out.read_text().splitlines()]
    assert len(rows) == 3 and not any(r.get("stopped") for r in rows)


def test_resume_skips_the_marker_and_keeps_the_median(monkeypatch, tmp_path):
    out = _lane(monkeypatch, tmp_path, [(0.40, 1000)])
    out.write_text(
        json.dumps({"task": "t9", "agent": "molt", "rep": 0, "cost_usd": 0.10}) + "\n"
        + json.dumps({"stopped": True, "reason": "cost alarm", "run": "t9-molt-0"}) + "\n"
    )
    # Earlier run's $0.10 is the median: limit max(0.50, 0.10), so $0.40 passes.
    run.main("molt", 1, None)
    assert json.loads(out.read_text().splitlines()[-1])["task"] == "t0"
