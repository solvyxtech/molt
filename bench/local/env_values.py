"""Bet 2 / half 1: where do the expected values in sealed drafted checks come from?

Offline, no model: reads the sealed checks out of the saved .maat journals
(bar_run events), classifies each by the provenance of its asserted literals,
and measures what making class (e) checks advisory would have done to the
grader-labelled runs.

  (a) every asserted literal is in the task text
  (b) ... or in the pristine input files
  (c) ... or in the output of running the pristine program(s)
  (d) the check asserts no free literal (relation / structure / exit status)
  (e) at least one asserted literal comes from none of the above

A "value literal" is an operand of a comparison (==, !=, -eq, -ne, <, >, <=,
>=, =~), of assertEqual-style helpers, a grep -q/-x pattern, or a line of a
here-doc given to diff/cmp: the same constructs src/tiers.ts assertsValue
looks at, but returning the literals instead of a boolean. Trivial literals
(0, 1, the empty string) are ignored: they are exit codes and indexes.

    python3 env_values.py [--json out.json] [--v11]
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

import replay_common as R

NUMWORDS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve".split())}

# ------------------------------------------------------------------ literals
STR = r"""(?:\\?"((?:[^"\\]|\\.)*)\\?"|'([^']*)')"""
NUM = r"-?\d+(?:\.\d+)?"
OPS = re.compile(r"(==|!=|>=|<=|=~|(?<=\s)-eq(?=\s)|(?<=\s)-ne(?=\s)|(?<=\s)-ge(?=\s)|(?<=\s)-le(?=\s)|(?<=\s)-gt(?=\s)|(?<=\s)-lt(?=\s)|(?<=[\w)\]\s])\s>(?=\s*\d)|(?<=\s)=(?=\s))")


def _operand(text: str) -> list[str]:
    """Literals of the operand that starts text (a string, number, or bracketed list/dict)."""
    t = text.lstrip()
    out: list[str] = []
    if t[:1] in "[{(":
        close = {"[": "]", "{": "}", "(": ")"}[t[0]]
        depth, end = 0, len(t)
        for i, ch in enumerate(t):
            if ch in "[{(":
                depth += 1
            elif ch in "]})":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        t = t[:end]
        for m in re.finditer(STR, t):
            out.append(m.group(1) if m.group(1) is not None else m.group(2))
        out += re.findall(r"(?<![\w.])" + NUM + r"(?![\w])", re.sub(STR, " ", t))
        return out
    m = re.match(STR, t)
    if m:
        s = m.group(1) if m.group(1) is not None else m.group(2)
        return [] if "$" in s else [s]
    m = re.match(NUM + r"(?![\w.])", t)
    if m:
        return [m.group(0)]
    m = re.match(r"(True|False|None|true|false|null)\b", t)
    if m:
        return []  # booleans are not invented values
    return []


def _before(text: str) -> list[str]:
    t = text.rstrip()
    m = re.search(STR + r"$", t)
    if m:
        s = m.group(1) if m.group(1) is not None else m.group(2)
        return [] if "$" in s else [s]
    m = re.search(r"(?<![\w.$)\]])(" + NUM + r")$", t)
    return [m.group(1)] if m else []


def value_literals(run: str) -> list[str]:
    """Port of the constructs in tiers.ts assertsValue, returning the literals asserted."""
    lits: list[str] = []
    for m in OPS.finditer(run):
        at, op = m.start(), m.group(1).strip()
        if op == "=":
            seg = re.split(r"[;\n]|&&|\|\|", run[:at])[-1]
            if not re.search(r"(?:^|\s)(?:\[\[?|test)\s", seg):
                continue
        lits += _operand(run[m.end(): m.end() + 200])
        lits += _before(run[max(0, at - 80): at])
    for m in re.finditer(r"(?:\bassert_?[Ee]qual|\bassert_eq|\.(?:deep|strict|deepStrict)?[Ee]qual)\w*\s*\(([^\n]*)", run):
        lits += [a if a else b for a, b in re.findall(STR, m.group(1))]
        lits += re.findall(r"(?<![\w.])" + NUM + r"(?![\w])", re.sub(STR, " ", m.group(1)))
    for m in re.finditer(r"\b(?:diff|cmp)\b([^\n|;&]*)", run):
        if re.search(r"<<|<\(", m.group(1)):
            body = run[m.end():]
            hd = re.search(r"<<-?\s*['\"]?(\w+)['\"]?\n(.*?)\n\s*\1\b", run, re.S)
            if hd:
                lits += [ln.strip() for ln in hd.group(2).splitlines() if ln.strip()]
            else:
                lits += ["<<heredoc>>"]
    for m in re.finditer(r"\bgrep\b([^\n|;&]*)", run):
        words = re.findall(r"\"(?:[^\"\\]|\\.)*\"|'[^']*'|\S+", m.group(1))
        flags = [w for w in words if w.startswith("-")]
        if not any(re.fullmatch(r"-[A-Za-z]+", f) and set(f) & set("qx") for f in flags):
            continue
        pat = next((w for w in words if not w.startswith("-")), None)
        if pat:
            body = re.sub(r"^([\"'])(.*)\1$", r"\2", pat, flags=re.S)
            if body and not re.search(r"\$[\w{(]", body) and not re.search(r"\[[^\]]*\]|\\[dws.]|\.\*|\w\+", body) and (re.search(r"(?<![\w.])\d+(?:\.\d+)?(?!\w)", body)
                                              or re.fullmatch(r"\^.{3,}\$", body, re.S)):
                lits.append(re.sub(r"^\^|\$$", "", body))
    out = []
    for v in lits:
        v = v.strip()
        if v in ("", "0", "1", "-1"):
            continue
        out.append(v)
    return list(dict.fromkeys(out))


EXT = r"(?:py|js|sh|csv|json|txt|md|log|ini|db|ya?ml|conf|cfg|html|xml|toml|sql|jsonl|gz|tsv|jpe?g|png|pdf|zip)"
PATH_TOK = re.compile(r"(?<![\w./$-])((?:[\w.-]+/)+[\w.-]+|[\w-]+\." + EXT + r")(?![\w])")
WRITE_CTX = re.compile(r"(?:>>?\s*|touch\s+|tee\s+(?:-a\s+)?|mkdir\s+(?:-p\s+)?|\bcp\s+\S+\s+|\bmv\s+\S+\s+|"
                       r"open\(\s*['\"])([\w./-]+)")


def path_refs(run: str) -> list[str]:
    """Paths the check mentions that it does not create itself (inputs / expected outputs)."""
    made = {m.group(1) for m in WRITE_CTX.finditer(run)}
    out = []
    for m in PATH_TOK.finditer(run):
        t = m.group(1)
        if t in made or t.startswith(("usr/", "dev/", "tmp/", "bin/", "etc/")) or "mktemp" in t:
            continue
        if t.endswith((".stdout", ".exit", ".group", ".parameters", ".signature")):
            continue
        out.append(t)
    return list(dict.fromkeys(out))


# ------------------------------------------------------------------ provenance
def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower().replace("\\n", "\n")).strip()


TIGHT = "--tight-numbers" in sys.argv   # small integers are coincidences, never provenance


def contains(hay: str, lit: str) -> bool:
    h, l = norm(hay), norm(lit)
    if not l:
        return True
    if re.fullmatch(NUM, l):
        if TIGHT and re.fullmatch(r"-?\d{1,2}", l):
            return False
        if re.search(r"(?<![\w.])" + re.escape(l) + r"(?![\w]|\.\d)", h):
            return True
        try:
            n = int(float(l))
            return float(l) == n and any(re.search(rf"\b{w}\b", h) for w, i in NUMWORDS.items() if i == n)
        except ValueError:
            return False
    if l in h:
        return True
    # a multi-line / csv-row literal: every non-trivial line or field present
    parts = [p.strip() for p in re.split(r"[\n,|]", l) if p.strip()]
    return len(parts) > 1 and all(p in h for p in parts)


def read_inputs(d: Path) -> str:
    buf = []
    for p in sorted(d.rglob("*")):
        if ".git" in p.parts or not p.is_file() or p.stat().st_size > 2_000_000:
            continue
        buf.append(p.relative_to(d).as_posix())
        try:
            buf.append(p.read_text())
        except Exception:
            pass
    return "\n".join(buf)


_run_cache: dict[str, str] = {}


def pristine_outputs(task: str) -> str:
    """stdout+stderr of every runnable thing in the pristine tree, no arguments and --help."""
    if task in _run_cache:
        return _run_cache[task]
    src = R.pristine(task)
    out: list[str] = []
    tmp = Path(tempfile.mkdtemp(prefix="bet2-run-"))
    try:
        work = tmp / "w"
        shutil.copytree(src, work, symlinks=True)
        env = dict(os.environ, HOME=str(tmp), PYTHONDONTWRITEBYTECODE="1")
        cmds: list[list[str]] = []
        for p in sorted(work.rglob("*")):
            if not p.is_file() or ".git" in p.parts:
                continue
            rel = p.relative_to(work).as_posix()
            runner = {".py": "python3", ".sh": "bash", ".js": "node"}.get(p.suffix)
            if runner:
                cmds += [[runner, rel], [runner, rel, "--help"]]
        if (work / "Makefile").exists():
            cmds.append(["make", "-n"])
        if any(work.rglob("test*.py")):
            cmds.append(["python3", "-m", "unittest", "discover", "-v"])
        for c in cmds:
            try:
                r = subprocess.run(c, cwd=work, env=env, capture_output=True, text=True,
                                   timeout=6, stdin=subprocess.DEVNULL)
                out += [r.stdout, r.stderr]
            except Exception:
                pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    _run_cache[task] = "\n".join(out)
    return _run_cache[task]


_ctx: dict[str, tuple[str, str]] = {}


def invented_paths(task: str, run_cmd: str) -> list[str]:
    text, inputs = _ctx[task]
    tree = {p.relative_to(R.pristine(task)).as_posix() for p in R.pristine(task).rglob("*") if ".git" not in p.parts}
    bad = []
    for t in path_refs(run_cmd):
        t = t.lstrip("./")
        base = t.rsplit("/", 1)[-1]
        if t in tree or contains(text, t) or contains(text, base) or any(f.endswith("/" + base) or f == base for f in tree) \
                or any(f.startswith(t.rstrip("/") + "/") for f in tree):
            continue
        bad.append(t)
    return bad


def classify(task: str, run_cmd: str) -> tuple[str, list[str], list[str]]:
    """-> (class a-e, literals, the untraced ones)."""
    if task not in _ctx:
        _ctx[task] = (R.TASK_BY_NAME[task].PROMPT, read_inputs(R.pristine(task)))
    text, inputs = _ctx[task]
    lits = value_literals(run_cmd)
    if not lits:
        return "d", [], []
    src = []
    for lit in lits:
        if contains(text, lit):
            src.append("a")
        elif contains(inputs, lit):
            src.append("b")
        elif contains(pristine_outputs(task), lit):
            src.append("c")
        else:
            src.append("e")
    bad = [l for l, s in zip(lits, src) if s == "e"]
    if bad:
        return "e", lits, bad
    return max(src), lits, []   # "a" < "b" < "c": the weakest source present


BENDS = [("access-report", 2), ("csv-clean", 2), ("cron-next", 2), ("git-revert-one", 2),
         ("organize-files", 0), ("organize-files", 1), ("perf-pairs", 1), ("wc-tool", 0)]


# ------------------------------------------------------------------ the replay
def sealed_checks(bars: list[dict]) -> dict[str, dict]:
    """name -> {cmd, first_ok, final_ok, ever_failed}, over every bar_run (late-joined included)."""
    out: dict[str, dict] = {}
    for i, b in enumerate(bars):
        for c in b.get("checks", []):
            if not R.drafted(c):
                continue
            d = out.setdefault(c["name"], {"cmd": c.get("detail", ""), "first_ok": c.get("ok"),
                                           "ever_failed": False, "final_ok": None, "kind": c.get("kind")})
            d["final_ok"] = c.get("ok")
            d["ever_failed"] |= not c.get("ok")
    return out


def rate(n: int, d: int) -> str:
    return f"{n}/{d} ({100 * n / d:.0f}%)" if d else f"{n}/0"


def main() -> None:
    only_v11 = "--v11" in sys.argv
    rs = R.runs()
    seen, uniq = set(), []
    for r in rs:           # v9 has re-run trees under one grader row: keep the first, mark the rest ambiguous
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        uniq.append(r)
    if only_v11:
        uniq = [r for r in uniq if r["arm"].startswith("v11")]
    recs = []
    for r in uniq:
        bars = R.bar_runs(R.journal_events(r["dir"]))
        if not bars:
            continue
        ch = sealed_checks(bars)
        for name, d in ch.items():
            cls, lits, bad = classify(r["task"], d["cmd"])
            cls_strict = cls
            ip = invented_paths(r["task"], d["cmd"])
            if cls != "e" and ip:
                cls = "e"      # broad (e): an expected path/input the task and tree never mention
                bad = bad + ["path:" + p for p in ip]
            recs.append({"run": r["id"], "arm": r["arm"], "task": r["task"], "passed": r["passed"],
                         "check": name, "cls": cls, "lits": lits, "bad": bad, "strict_e": any(not b.startswith("path:") for b in bad), "cls_strict": cls_strict, "cmd": d["cmd"],
                         "first_ok": d["first_ok"], "final_ok": d["final_ok"], "ever_failed": d["ever_failed"],
                         "bars": len(bars)})
    which = "cls_strict" if "--strict" in sys.argv else "cls"
    for x in recs:
        x["cls"] = x[which]
    print(f"definition of (e): {'strict, untraced value literals only' if which == 'cls_strict' else 'broad, also expected paths/inputs the task and tree never mention'}")
    runs_with = {x["run"] for x in recs}
    print(f"runs with a sealed check: {len(runs_with)} of {len(uniq)} graded; checks: {len(recs)}")
    print("class of all sealed drafted checks:", dict(sorted(Counter(x['cls'] for x in recs).items())))

    def table(title: str, sel) -> None:
        sub = [x for x in recs if sel(x)]
        c = Counter(x["cls"] for x in sub)
        print(f"\n{title}: n={len(sub)}  " + "  ".join(f"{k}={c.get(k, 0)}" for k in "abcde")
              + f"  | (e) share {rate(c.get('e', 0), len(sub))}")

    table("checks passing on all runs", lambda x: x["final_ok"])
    table("REFUSED CORRECT: failed at final bar, grader passed", lambda x: x["passed"] and x["final_ok"] is False)
    table("REFUSED CORRECT (ever failed, grader passed)", lambda x: x["passed"] and x["ever_failed"])
    table("CAUGHT WRONG: failed at final bar, grader failed", lambda x: (not x["passed"]) and x["final_ok"] is False)
    table("CAUGHT WRONG (ever failed, grader failed)", lambda x: (not x["passed"]) and x["ever_failed"])
    table("passing checks on wrong runs (missed it)", lambda x: (not x["passed"]) and x["final_ok"])

    # run-level refusal verdicts: positive = work is wrong
    def confusion(adv: set[str], mode: str) -> dict:
        per: dict[str, list] = defaultdict(list)
        for x in recs:
            per[x["run"]].append(x)
        tp = fp = fn = tn = 0
        for run, xs in per.items():
            fail = [x for x in xs if x["cls"] not in adv and ((x["final_ok"] is False) if mode == "final" else x["ever_failed"])]
            refused, wrong = bool(fail), not xs[0]["passed"]
            tp += refused and wrong
            fp += refused and not wrong
            fn += (not refused) and wrong
            tn += (not refused) and not wrong
        return dict(tp=tp, fp=fp, fn=fn, tn=tn,
                    precision=tp / (tp + fp) if tp + fp else float("nan"),
                    recall=tp / (tp + fn) if tp + fn else float("nan"),
                    fpr=fp / (fp + tn) if fp + tn else float("nan"))

    print("\nrun-level refusal as a wrong-work detector (positive = grader failed)")
    for mode in ("final", "ever"):
        for label, adv in (("all drafted checks binding", set()), ("(e) advisory-only", {"e"}),
                           ("only a/b/c binding (d,e advisory)", {"d", "e"})):
            c = confusion(adv, mode)
            print(f"  [{mode:5}] {label:34} TP={c['tp']:3} FP={c['fp']:3} FN={c['fn']:3} TN={c['tn']:3}"
                  f"  precision={c['precision']:.2f} recall={c['recall']:.2f} false-refusal-rate={c['fpr']:.2f}")

    # the 8 v11-new bends named in reports/oracle-2026-10-06b.md section 1 (class A)
    bends = [f"v11-new/{t}#{r}" for t, r in BENDS]
    print(f"\nthe 8 known v11-new bends: drafted checks that refused the correct work first")
    ncheck = ne = nruns_e = 0
    for b in bends:
        trig = [x for x in recs if x["run"] == b and x["first_ok"] is False]
        ncheck += len(trig)
        ne += sum(x["cls"] == "e" for x in trig)
        nruns_e += any(x["cls"] == "e" for x in trig)
        for x in trig:
            print(f"  {b:34} {x['check']:36} [{x['cls']}] bad={x['bad'][:2]}")
        if not trig:
            print(f"  {b:34} (no refused sealed check found in journal)")
    print(f"  triggering checks that are (e): {ne}/{ncheck}; bends with >=1 (e) trigger: {nruns_e}/8")

    # per-task view of class (e) on refused-correct
    print("\nrefused-correct checks by task, class (e) first:")
    bytask: dict[str, Counter] = defaultdict(Counter)
    for x in recs:
        if x["passed"] and x["final_ok"] is False:
            bytask[x["task"]][x["cls"]] += 1
    for t, c in sorted(bytask.items(), key=lambda kv: -sum(kv[1].values())):
        print(f"  {t:20} " + " ".join(f"{k}={c[k]}" for k in sorted(c)))

    # examples
    print("\nexamples, refused-correct (e):")
    shown = set()
    for x in recs:
        if x["passed"] and x["final_ok"] is False and x["cls"] == "e" and (x["task"], x["check"]) not in shown and len(shown) < 8:
            shown.add((x["task"], x["check"]))
            print(f"  {x['run']} {x['check']} bad={x['bad'][:3]}\n     {x['cmd'][:160]!r}")
    print("\nexamples, refused-correct (a/b/c/d):")
    shown = set()
    for x in recs:
        if x["passed"] and x["final_ok"] is False and x["cls"] != "e" and (x["task"], x["check"]) not in shown and len(shown) < 8:
            shown.add((x["task"], x["check"]))
            print(f"  [{x['cls']}] {x['run']} {x['check']} lits={x['lits'][:3]}\n     {x['cmd'][:160]!r}")

    if "--json" in sys.argv:
        Path(sys.argv[sys.argv.index("--json") + 1]).write_text(json.dumps(recs, indent=1))
    R.cleanup()


if __name__ == "__main__":
    main()
