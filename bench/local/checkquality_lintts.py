"""Check-quality replay with the SHIPPED lint (src/checklint.ts) instead of checkquality_lint.py.

    npm run build            # dist/checklint.js
    python3 checkquality_lintts.py SCRATCH_DIR [sh|bash]

Writes SCRATCH_DIR/ts-<shell>/ (a copy of the inputs with cq-checks-lint.json's `flags`
replaced by the TypeScript lint's) and prints per-rule counts by group; then run
    python3 checkquality_analysis.py SCRATCH_DIR/ts-<shell>
for the run-level recall/precision table.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from tasks import TASKS  # noqa: E402
from tasks2 import TASKS2  # noqa: E402

S = Path(sys.argv[1])
SHELL = sys.argv[2] if len(sys.argv) > 2 else "sh"
TREES = Path.home() / ".cache/maat-bench/cq-trees"
HERE = Path(__file__).parent
PROMPT = {T.name: T.PROMPT for T in [*TASKS, *TASKS2]}

checks = json.load(open(S / "cq-checks-lint.json"))
tax = {(x["id"], x["name"]): x["cls"] for x in json.load(open(S / "cq-taxonomy.json"))}
items = [{"task": c["task"], "cmd": c["cmd"], "pristine": str(TREES / c["task"] / "pristine"), "text": PROMPT[c["task"]]} for c in checks]
r = subprocess.run(["node", str(HERE / "checkquality_lintts.mjs"), SHELL], input=json.dumps(items), capture_output=True, text=True, check=True)
flags = json.loads(r.stdout)

out = S / f"ts-{SHELL}"
out.mkdir(exist_ok=True)
for f in S.iterdir():
    if f.is_file() and f.name not in ("cq-checks-lint.json",):
        dst = out / f.name
        if not dst.exists():
            try:
                dst.symlink_to(f)
            except OSError:
                shutil.copy(f, dst)
for c, fl in zip(checks, flags):
    c["flags_py"] = c["flags"]
    c["flags"] = fl
json.dump(checks, open(out / "cq-checks-lint.json", "w"))


def group(c):
    if c["ok"]:
        return "pass-on-correct" if c["passed"] else "pass-on-wrong"
    return "refused-correct" if c["passed"] else "caught-wrong"


rules = Counter()
for c in checks:
    g = group(c)
    for rule in {f.split(":")[0] for f in c["flags"]}:
        rules[(rule, g)] += 1
groups = ["refused-correct", "caught-wrong", "pass-on-correct", "pass-on-wrong"]
print(f"shell={SHELL}  rule | " + " | ".join(groups))
for rule in sorted({k[0] for k in rules}):
    print(f"{rule:22} | " + " | ".join(str(rules[(rule, g)]) for g in groups))
for label, key in (("python (report)", "flags_py"), ("typescript (shipped)", "flags")):
    n = {g: sum(1 for c in checks if group(c) == g and c[key]) for g in groups}
    tot = {g: sum(1 for c in checks if group(c) == g) for g in groups}
    print(f"{label:22} flagged: " + ", ".join(f"{g} {n[g]}/{tot[g]}" for g in groups))
