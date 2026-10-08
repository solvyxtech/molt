"""Check-quality replay: hand classification of every drafted check that failed
at the final bar on grader-passed work (v10-old/fix, v11-old/new, v12-old/new).

Each (run id, check name) was read with its command and recorded output
(scratchpad refused-correct.txt). Classes:

  GV  guessed value: a hand-computed number or an invented literal/case/message
  GI  guessed interface: an invented path, file, argument, signature, input or module
  SB  shell/tool bug in the check's own code (dash job control, pkill -f self-kill,
      quoting, mawk/BRE dialect, precedence, chained greps on consumed stdin)
  WL  wrong logic: tests a state correct work cannot produce, or misreads the spec
  OS  over-strict: a format stricter than the task states
  ET  environment: tool missing (pytest)
  EA  environment assumption (git HEAD in a non-repo, .maat/ counted, `time` in sh)
  PL  product lint: the check PASSED (exit 0) but evidence.ts refused its shape

    python3 checkquality_taxonomy.py CQ_CHECKS.json
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict

# rules in order; first match wins. (task regex, name regex, cmd regex) -> class
RULES: list[tuple[str, str, str, str]] = [
    # product-lint refusals of passing checks
    (".", ".", r"\|\| exit 0\s*$", "PL"),
    ("duration-bug", "run-tests", r"unittest.*\| grep -q", "PL"),
    # environment
    (".", ".", r"-m pytest", "ET"),
    (".", ".", r"git diff --quiet HEAD --", "EA"),
    ("organize-files", "sorted-only", r"ls -A", "EA"),
    ("perf-pairs", ".", r"^time python3", "EA"),
    # shell / tool bugs
    ("http-json-server", ".", r"kill %1|pkill -f|^p=python3", "SB"),
    ("makefile-site", ".", r"grep -q nothing to be done|\$\{f#src/\}", "SB"),
    ("git-revert-one", ".", r"test -z \"git status|'\^\$\(git rev-parse", "SB"),
    ("sql-top-customers", ".", r"awk", "SB"),
    ("node-summarize", ".", r"grep -vE '\^-\?\\d", "SB"),
    ("csv-clean", ".", r"grep -q '\^\[\^@\]\+@|or exit\(1\)", "SB"),
    ("cron-next", "run-cron-2", r".", "SB"),
    ("access-report", "validate-top-5", r".", "SB"),
    ("config-migrate", "migrate_v1_configs", r".", "SB"),
    # wrong logic
    ("fix-git", ".", r"git merge --no-commit|git diff master\.\.HEAD|git diff HEAD -- about\.md", "WL"),
    ("git-revert-one", ".", r"git diff --quiet HEAD~1 HEAD", "WL"),
    ("sql-top-customers", ".", r"grep -qv", "WL"),
    ("config-migrate", "migrate-v1-files|verify_port_default|validate-v2-schema|port-defaults-to-5432", r".", "WL"),
    ("csv-clean", "validate-age-rules", r".", "WL"),
    ("access-report", "path-count-format|check-report-format", r".", "WL"),
    ("log-summary", "period-order", r".", "WL"),
    # over-strict format
    ("access-report", "verify-format", r".", "OS"),
    # guessed interface
    ("perf-pairs", ".", r".", "GI"),
    ("refactor-pricing", ".", r".", "GI"),
    ("config-migrate", ".", r"sample_v1|test\.json|example\.json|cd /app|migrate\.py", "GI"),
    ("http-json-server", ".", r"/app/|/workspace/", "GI"),
    ("fix-git", ".", r"about\.html|origin/master", "GI"),
    ("makefile-site", ".", r"build/(NAME|example|README|test)\.html", "GI"),
    ("access-report", "generate-report", r"task\.py", "GI"),
    ("git-revert-one", ".", r"git revert \"Add", "GI"),
    # guessed value
    ("wc-tool", ".", r".", "GV"),
    ("bash-rotate", ".", r"grep -q 'usage'", "GV"),
    ("fix-git", ".", r"grep -q '(modified|changed|changes|merge)'", "GV"),
    ("git-revert-one", ".", r"wc -l \| grep -q '\^[13]\$'|grep -q 'revert'", "GV"),
    ("makefile-site", ".", r"nothing to be done|Nothing to do|\[0-9\]\+ files", "GV"),
    ("size-parse-bug", ".", r"== 1024", "GV"),
    ("csv-clean", ".", r"len\(rows\)==24|len\(d\)==12|local@domain\.com", "GV"),
    ("log-summary", ".", r".", "GV"),
    ("organize-files", ".", r"-eq 5|grep -qx 1", "GV"),
    ("cron-next", ".", r".", "GV"),
]


def classify(task: str, name: str, cmd: str) -> str:
    n = name.replace("task:", "")
    for t, nm, c, cls in RULES:
        if re.search(t, task) and re.search(nm, n) and re.search(c, cmd, re.S):
            return cls
    return "??"


def main() -> None:
    rows = json.load(open(sys.argv[1]))
    rc = [x for x in rows if x["passed"] and x["ok"] is False]
    cnt: Counter = Counter()
    per_task: dict = defaultdict(Counter)
    per_lane: dict = defaultdict(Counter)
    unk = []
    for x in rc:
        cls = classify(x["task"], x["name"], x["cmd"])
        x["cls"] = cls
        cnt[cls] += 1
        per_task[x["task"]][cls] += 1
        per_lane[x["lane"]][cls] += 1
        if cls == "??":
            unk.append(x)
    print(f"refused-correct checks: {len(rc)} in {len(set(x['id'] for x in rc))} runs")
    for k, v in cnt.most_common():
        print(f"  {k}: {v} ({100*v/len(rc):.0f}%)")
    print("\nby lane:")
    for lane in ["v10-old", "v10-fix", "v11-old", "v11-new", "v12-old", "v12-new"]:
        c = per_lane[lane]
        print(f"  {lane:8} n={sum(c.values()):3} " + " ".join(f"{k}={c[k]}" for k in ["GV", "GI", "SB", "WL", "OS", "ET", "EA", "PL"]))
    print("\nby task:")
    for t, c in sorted(per_task.items(), key=lambda kv: -sum(kv[1].values())):
        print(f"  {t:18} n={sum(c.values()):3} " + " ".join(f"{k}={v}" for k, v in c.most_common()))
    # run-level: the class of the check(s) that refused each correct run
    runs: dict = defaultdict(set)
    for x in rc:
        runs[x["id"]].add(x["cls"])
    print("\nruns refused only by one class:")
    rc_cnt = Counter("+".join(sorted(s)) for s in runs.values())
    for k, v in rc_cnt.most_common():
        print(f"  {k}: {v}")
    for x in unk:
        print("UNCLASSIFIED", x["id"], x["name"], x["cmd"][:120])
    json.dump([{k: x[k] for k in ("id", "lane", "task", "name", "cmd", "cls")} for x in rc], open(sys.argv[1].replace("cq-checks", "cq-taxonomy"), "w"), indent=1)


if __name__ == "__main__":
    main()
