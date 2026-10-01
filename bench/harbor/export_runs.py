#!/usr/bin/env python3
"""
Every trial of the given harbor jobs as one CSV row — the raw data behind the
published record, so anyone can redo the arithmetic.

    python3 bench/harbor/export_runs.py jobs/<job>[=label] ... > runs.csv

Columns: job, label, task, attempt, passed (grader reward >= 1), said (what the
agent itself said: verified / not proven / unverified / unconfirmed / none;
for Terminus-2, "verified" = called mark_task_complete), timeout, seconds,
input_tokens, cached_tokens, output_tokens.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare import load  # noqa: E402


def main(argv: list[str]) -> None:
    w = csv.writer(sys.stdout)
    w.writerow(["job", "label", "task", "attempt", "passed", "said", "timeout", "seconds", "input_tokens", "cached_tokens", "output_tokens"])
    for arg in argv:
        path, _, label = arg.partition("=")
        job = Path(path)
        for task, trials in sorted(load(job).items()):
            for i, t in enumerate(trials):
                w.writerow([
                    job.name, label or job.name, task, i,
                    int((t["reward"] or 0) >= 1), t["said"] or "", int(bool(t["timeout"])),
                    "" if t["secs"] is None else round(t["secs"]), t["in"] or "", t["cached"] or "", t["out"] or "",
                ])


if __name__ == "__main__":
    main(sys.argv[1:])
