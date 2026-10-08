"""
Count, offline, how many stored drafted checks the seal-time path rule would drop.

Every receipt under a bench cache (default ~/.cache/maat-bench) lists the
machine-checked criteria its turn sealed, as "- `name: command`" items. This
extracts them, de-duplicates by seal id + name, and runs dist/criteria.js
strayPath on each (cwd = the receipt's workspace, task text unknown so no
task-stated allowance: the count is an upper bound).

    npm run build && python3 bench/local/path_rule_count.py [CACHE_DIR] [--show]
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SEAL = re.compile(r"sealed as `([0-9a-f]+)`")
ITEM = re.compile(r"^- `([a-z0-9][\w.-]*): ", re.M)


def checks_of(md: str) -> list[tuple[str, str]]:
    """(name, command) for each item of the 'Machine-checked' list; commands may span lines."""
    start = md.find("**Machine-checked.**")
    if start < 0:
        return []
    body = md[start:]
    end = re.search(r"\n\*\*[A-Z]", body[20:])
    body = body[: end.start() + 20] if end else body
    out = []
    for m in ITEM.finditer(body):
        rest = body[m.end():]
        close = rest.find("`\n")
        close = len(rest) if close < 0 else close
        out.append((m.group(1), rest[:close].rstrip("`")))
    return out


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    cache = Path(args[0]).expanduser() if args else Path("~/.cache/maat-bench").expanduser()
    seen: dict[tuple[str, str], tuple[Path, str]] = {}
    for md in cache.rglob("receipts/*.md"):
        text = md.read_text(errors="replace")
        seal = SEAL.search(text)
        ws = md.parent.parent.parent
        for name, run in checks_of(text):
            seen.setdefault((seal.group(1) if seal else str(md), name), (ws, run))
    rows = [{"cwd": str(ws), "run": run} for ws, run in seen.values()]
    js = (
        "import {strayPath} from './dist/criteria.js';"
        "let s='';for await (const c of process.stdin) s+=c;"
        "console.log(JSON.stringify(JSON.parse(s).map(r=>strayPath(r.run,{cwd:r.cwd}))));"
    )
    p = subprocess.run(["node", "--input-type=module", "-e", js], input=json.dumps(rows), capture_output=True, text=True, cwd=REPO)
    if p.returncode != 0:
        sys.exit(p.stderr[-600:])
    hits = json.loads(p.stdout)
    dropped = [(r, h) for r, h in zip(rows, hits) if h]
    print(f"stored drafted checks (unique per seal): {len(rows)}; the path rule would drop {len(dropped)}")
    if "--show" in sys.argv:
        for r, h in dropped:
            print(f"  {h}  <-  {r['run'][:100]!r}  ({Path(r['cwd']).name})")


if __name__ == "__main__":
    main()
