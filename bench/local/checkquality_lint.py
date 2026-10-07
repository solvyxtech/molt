"""Check-quality replay: structural lint rules a drafter could apply at seal time,
before any work exists. Every rule reads only the command, the task text, the
pristine tree and what is installed. No model.

    from checkquality_lint import flags
    flags(task_name, cmd, pristine_dir, task_text) -> [rule ids]
"""
from __future__ import annotations

import ast
import re
from functools import lru_cache
from pathlib import Path

# what the bench image has (Dockerfile): python3 git sqlite3 jq make curl node; no pytest, no python, no pip
INSTALLED = {"python3", "git", "sqlite3", "jq", "make", "curl", "node", "npm", "npx", "sh", "bash", "awk", "sed", "grep", "find", "xargs", "sort", "uniq", "wc", "head", "tail", "cut", "tr", "cat", "diff", "cmp", "test", "ls", "cp", "mv", "rm", "mkdir", "touch", "tee", "echo", "printf", "true", "false", "seq", "date", "stat", "chmod", "basename", "dirname", "env", "sleep", "kill", "pkill", "timeout", "tac", "rev", "od", "xxd", "file", "md5sum", "sha256sum", "ps", "pgrep", "nproc", "cd", "exit", "read", "set", "export", "eval", "exec", "command", "type", "which", "mktemp", "realpath", "readlink", "ln", "du", "df", "yes", "comm", "join", "paste", "split", "expr", "bc", "nc", "ss", "wait", "trap", "shift", "local", "return", "if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac", "in", "python3.11", "sqlite3"}
INSTALLED = set(INSTALLED) - {"bc", "nc", "ss"}
PY_MODULES_ABSENT = {"pytest", "numpy", "pandas", "requests", "yaml", "hypothesis", "flask"}


@lru_cache(maxsize=None)
def pristine_defs(pristine: str) -> dict[str, tuple[int, int]]:
    """python function name -> (required positional count, total positional count) across pristine .py files."""
    out: dict[str, tuple[int, int]] = {}
    for p in Path(pristine).rglob("*.py"):
        try:
            tree = ast.parse(p.read_text())
        except Exception:
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                a = node.args
                pos = a.posonlyargs + a.args
                req = len(pos) - len(a.defaults)
                out[node.name] = (req, len(pos) if a.vararg is None else 99)
    return out


@lru_cache(maxsize=None)
def pristine_files(pristine: str) -> set[str]:
    out = set()
    for p in Path(pristine).rglob("*"):
        if ".git" in p.parts:
            continue
        rel = p.relative_to(pristine).as_posix()
        out.add(rel)
        out.add(p.name)
    return out


@lru_cache(maxsize=None)
def pristine_text(pristine: str) -> str:
    buf = []
    for p in Path(pristine).rglob("*"):
        if ".git" in p.parts or not p.is_file() or p.stat().st_size > 500_000:
            continue
        try:
            buf.append(p.read_text())
        except Exception:
            pass
    return "\n".join(buf)


def _count_args(call: str) -> int:
    """positional args in the text between the call's parentheses (top level commas)."""
    depth, n, seen = 0, 0, False
    i = 0
    quote = None
    while i < len(call):
        ch = call[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            seen = True
        elif ch in "\"'":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif ch == "," and depth == 0:
            n += 1
        elif not ch.isspace():
            seen = True
        i += 1
    return (n + 1) if seen else 0


EXT = r"(?:py|js|sh|csv|json|txt|md|log|ini|db|ya?ml|conf|cfg|html|xml|toml|sql|jsonl|gz|tsv|jpe?g|png|pdf|zip|docx|gif)"
PATH_TOK = re.compile(r"(?<![\w./$@-])((?:[\w.-]+/)+[\w.*-]+|[\w-]+\." + EXT + r")(?![\w])")
MADE = re.compile(r"(?:>>?\s*|touch\s+|tee\s+(?:-a\s+)?|mkdir\s+(?:-p\s+)?|\bcp\s+\S+\s+|\bmv\s+\S+\s+|open\(\s*['\"]|-o\s+|-name\s+['\"]?|\bcd\s+)([\w./*-]+)")


def flags(task: str, cmd: str, pristine: str, text: str) -> list[str]:
    f: list[str] = []
    low = text.lower()
    files = pristine_files(pristine)
    ptext = pristine_text(pristine)
    has_git_dir = (Path(pristine) / ".git").is_dir()

    # L1 tool/module not installed
    if re.search(r"python3?\s+-m\s+pytest|\bpytest\b", cmd):
        f.append("L1-pytest")
    for m in re.finditer(r"(?:^|[;&|(]\s*)(?:time\s+)?([A-Za-z_][\w.-]*)(?=\s|$)", cmd):
        w = m.group(1)
        if w not in INSTALLED and not w.startswith(("./", "$")) and w not in files and not re.match(r"^[A-Z_]+=", w) and w not in ("p", "PORT", "PID"):
            if w in ("python", "pip", "pip3", "pytest", "rg", "fd", "bat", "tree", "ss", "lsof", "netstat", "nc", "bc", "column", "perl", "ruby"):
                f.append(f"L1-{w}")
    # L2 git in a project with no repository (and the task does not ask for git)
    if re.search(r"(?:^|[;&|(]\s*|\s)git\s", cmd) and not has_git_dir and not re.search(r"\bgit\b|\brepo\b|\bcommit\b", low):
        f.append("L2-git-norepo")
    # L3 sh has no job control: kill %1 / fg / jobs ; pkill -f with a string that is in the command itself
    if re.search(r"\bkill\s+%|\bfg\b|\bjobs\b", cmd):
        f.append("L3-jobcontrol")
    m = re.search(r"pkill\s+-f\s+(['\"]?)([^'\"]+)\1", cmd)
    if m and m.group(2).strip() and m.group(2).strip() in cmd.replace(m.group(0), ""):
        f.append("L3-pkill-self")
    # L4 single-quoted command substitution / variable (never expands)
    if re.search(r"'[^']*\$[({][^']*'", cmd) and not re.search(r"awk|sed|perl|python3? -c '", cmd):
        f.append("L4-quoted-subst")
    # L5 grep with three or more bare words after the pattern (unquoted multi-word pattern)
    if re.search(r"grep(?:\s+-\S+)*\s+[A-Za-z]+(?:\s+[a-z]+){2,}\s*(?:$|[|;&)])", cmd):
        f.append("L5-grep-unquoted")
    # L6 test -z/-n on a double-quoted literal command
    if re.search(r"test\s+-[zn]\s+\"[a-z]+ [^$\"]*\"", cmd):
        f.append("L6-test-literal")
    # L7 mawk / BRE regex dialect: \d anywhere in awk/grep -E/sed, {n} intervals in awk, `+` or {n} in basic grep
    if re.search(r"\bawk\b[^|;]*\\d", cmd) or re.search(r"\bgrep\s+(?:-[a-zA-Z]*\s+)*(?:-e\s+)?['\"][^'\"]*\\d", cmd) or re.search(r"\bgrep\s+-[a-zA-Z]*E[a-zA-Z]*[^|;]*\\d", cmd):
        f.append("L7-backslash-d")
    if re.search(r"\bawk\b[^|;]*\{\d+(?:,\d*)?\}", cmd):
        f.append("L7-mawk-interval")
    for gm in re.finditer(r"\bgrep\s+((?:-\S+\s+)*)(['\"])(.*?)\2", cmd):
        fl, pat = gm.group(1), gm.group(3)
        if not re.search(r"-\w*[EP]", fl) and re.search(r"(?<=[\w\])*.])(?<!\\)[+?]|(?<=[\w\]])(?<!\\)\{\d", pat) and "\\|" not in pat:
            f.append("L7-bre-plus")
            break
    # L8 bashisms under /bin/sh
    if re.search(r"\[\[|\becho\s+-n\b|\btime\s+python|(?:^|[;&|(]\s*)source\s|\bdeclare\b|\blocal\s+-|<<<", cmd):
        f.append("L8-bashism")
    # L9 shape rules the product already applies at the bar (evidence.ts): move them to seal time
    if re.search(r"\|\|\s*exit 0\s*$|\|\|\s*true\s*$", cmd):
        f.append("L9-swallows-exit")
    # L10 a path the check reads that is in neither the pristine tree, the task text, nor made by the check
    made = {m.group(1) for m in MADE.finditer(cmd)}
    for pm in PATH_TOK.finditer(cmd):
        p = pm.group(1)
        if p in made or "*" in p or p.startswith(("tmp/", "dev/", "usr/", "etc/")) or "mktemp" in cmd and p.startswith("$"):
            continue
        base = p.rsplit("/", 1)[-1]
        if p.lstrip("./") in files or base in files or p in text or base in text:
            continue
        stem = base.rsplit(".", 1)[0]
        if any(x.rsplit(".", 1)[0] == stem for x in files) or re.search(r"nonexist|no[-_]such|missing|does[-_]?not", base):
            continue
        if any(x.startswith(p.rstrip("/") + "/") for x in files):
            continue
        # a path the task names as output is fine
        f.append(f"L10-path:{p}")
        break
    # L11 absolute path outside the project (strayPath in the product)
    for am in re.finditer(r"(?<![\w.$}):/~<*+\]\\-])(/[\w.@+-][^\s\"'`;|&<>()*?\[\]{}$,=\\]*)", cmd):
        p = am.group(1)
        if p.endswith("/") or re.match(r"^/(usr|bin|sbin|opt|lib|etc|dev|proc|sys|tmp|var|private)(/|$)", p) or p in text:
            continue
        if re.search(r"nonexist|no[-_]such|missing", p):
            continue
        f.append(f"L11-abs:{p}")
        break
    # L12 calls a pristine python function with the wrong number of positional args
    defs = pristine_defs(pristine)
    for name, (req, tot) in defs.items():
        for cm in re.finditer(r"(?<![\w.])(?:\w+\.)?" + re.escape(name) + r"\(", cmd):
            n = _count_args(cmd[cm.end():])
            if n < req or n > tot:
                f.append(f"L12-arity:{name}({n})")
                break
    # L13 string literal passed to a pristine function that appears nowhere in task text or pristine tree
    for name in defs:
        if re.search(r"Error|raise|except|-q 'Traceback", cmd):
            break
        for cm in re.finditer(r"(?<![\w.])(?:\w+\.)?" + re.escape(name) + r"\(([^)]*)\)", cmd):
            for sm in re.finditer(r"['\"]([^'\"]{1,40})['\"]", cm.group(1)):
                lit = sm.group(1)
                if lit and lit not in text and lit not in ptext and not re.fullmatch(r"\s*", lit):
                    f.append(f"L13-input:{lit}")
                    break
    # L14 hand-computed number: an integer >= 2 compared/grepped for that is in neither the task text nor the pristine inputs
    nums = re.findall(r"(?:-eq|==|-ne|!=|grep -q[a-z]*\s+'\^?|grep -qx\s+'?)\s*(\d{1,6})(?![\w.])", cmd)
    nums += re.findall(r"len\([^)]*\)\s*==\s*(\d+)", cmd)
    for n in nums:
        if int(n) >= 2 and not re.search(r"(?<![\d.])" + n + r"(?![\d.])", text) and not re.search(r"(?<![\d.])" + n + r"(?![\d.])", ptext):
            f.append(f"L14-number:{n}")
            break
    # L15 the check performs the task / mutates named inputs (git checkout/merge/revert, rm -rf of a task-named dir)
    if re.search(r"\bgit\s+(checkout|merge|revert|reset|commit|add)\b", cmd) and "revert" not in low and "merge" not in low:
        f.append("L15-mutates")
    return f
