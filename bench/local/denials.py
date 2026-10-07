#!/usr/bin/env python3
"""Denied tool calls in bench journals, by the gate's reason.

Headless with --yes, every gated "ask" is answered "User denied this action.",
so a `permission` event with allowed:false is a call the model could not run.
This reads `**/.maat/log/*.jsonl` under a folder (or several) and prints a
table: gate reason -> denied count, then the commands behind each reason,
grouped by the rule in autonomy.ts that most likely fired.

  python3 bench/local/denials.py ~/.cache/maat-bench/container-work/v9-new-s*
  python3 bench/local/denials.py DIR [DIR...] [--top N] [--width W]

Journal event shape: {"kind":"permission","data":{"name","detail","allowed",
"asked","autonomy","why"}}. `detail` is the command for bash, the path for a
file tool, and the raw arguments for act.
"""
import argparse
import collections
import glob
import json
import os
import re
import sys

# The IRREVERSIBLE rules of src/autonomy.ts, first match names the row.
RULES = [
    ("rm/rmdir/unlink/shred", r"\b(rm|rmdir|unlink|shred)\b"),
    ("find -delete/-exec", r"-delete\b|-exec\b"),
    ("tee", r"\btee\b"),
    ("heredoc/redirect write (>)", r"(?<!>)>(?![>&])"),
    ("pkill/killall", r"\b(pkill|killall)\b"),
    ("git history/state", r"\bgit\s+(push|reset|clean|checkout|restore|branch|rebase|stash)\b"),
    ("inline program (-c/-e)", r"\b(python[\d.]*|node|ruby|perl|php|deno|bun)\b[^|;&]*\s-(c|e|eval|pi|pe)\b"),
    ("sh -c / bash -c", r"\b(sh|bash|zsh)\b[^|;&]*\s-c\b"),
    ("pipe into interpreter", r"\|\s*(sh|bash|zsh|python|node)\b"),
    ("sudo/chmod/dd/mkfs", r"\b(sudo|chmod|dd|mkfs)\b"),
]


def rule_of(name, detail, why):
    if why and "cannot be undone" not in why:
        return why
    if name != "bash":
        return f"{name}: {why or 'denied'}"
    for label, pat in RULES:
        if re.search(pat, detail):
            return f"cannot be undone: {label}"
    return "cannot be undone: (other)"


def journals(paths):
    for p in paths:
        if os.path.isfile(p):
            yield p
            continue
        yield from sorted(glob.glob(os.path.join(p, "**", ".maat", "log", "*.jsonl"), recursive=True))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folders", nargs="+")
    ap.add_argument("--top", type=int, default=3, help="example commands shown per rule")
    ap.add_argument("--width", type=int, default=110)
    a = ap.parse_args()

    paths = []
    for f in a.folders:
        paths.extend(glob.glob(os.path.expanduser(f)) or [f])
    files = list(journals(paths))
    allowed = denied = 0
    by_rule = collections.defaultdict(collections.Counter)
    runs = set()
    for jf in files:
        with open(jf, errors="replace") as fh:
            for line in fh:
                if '"kind":"permission"' not in line:
                    continue
                try:
                    d = json.loads(line)["data"]
                except (ValueError, KeyError):
                    continue
                if d.get("allowed") is False:
                    denied += 1
                    runs.add(jf)
                    cmd = str(d.get("detail", "")).replace("\n", " ")
                    by_rule[rule_of(d.get("name", ""), cmd, d.get("why", ""))][cmd] += 1
                else:
                    allowed += 1
    print(f"{len(files)} journals, {allowed} allowed, {denied} denied, {len(runs)} journals with a denial")
    print(f"\n{'denied':>6}  rule")
    for rule, c in sorted(by_rule.items(), key=lambda kv: -sum(kv[1].values())):
        print(f"{sum(c.values()):>6}  {rule}")
    for rule, c in sorted(by_rule.items(), key=lambda kv: -sum(kv[1].values())):
        print(f"\n{rule}")
        for cmd, n in c.most_common(a.top):
            shown = cmd if len(cmd) <= a.width else cmd[: a.width - 1] + "…"
            print(f"  {n:>3}x  {shown}")


if __name__ == "__main__":
    sys.exit(main())
