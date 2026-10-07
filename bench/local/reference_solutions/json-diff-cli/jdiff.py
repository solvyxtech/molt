import json
import re
import sys


def dump(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def seg(k):
    return "." + k if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) else "[" + json.dumps(k, ensure_ascii=False) + "]"


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def equal_scalars(x, y):
    if is_num(x) or is_num(y):
        return is_num(x) and is_num(y) and x == y
    return type(x) is type(y) and x == y


def walk(path, a, b, out):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in b:
                out.append(f"- {path}{seg(k)}: {dump(a[k])}")
            elif k not in a:
                out.append(f"+ {path}{seg(k)}: {dump(b[k])}")
            else:
                walk(path + seg(k), a[k], b[k], out)
    elif isinstance(a, list) and isinstance(b, list):
        for i in range(max(len(a), len(b))):
            if i >= len(b):
                out.append(f"- {path}[{i}]: {dump(a[i])}")
            elif i >= len(a):
                out.append(f"+ {path}[{i}]: {dump(b[i])}")
            else:
                walk(f"{path}[{i}]", a[i], b[i], out)
    elif not equal_scalars(a, b):
        out.append(f"~ {path}: {dump(a)} -> {dump(b)}")


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def main():
    try:
        a, b = load(sys.argv[1]), load(sys.argv[2])
    except (OSError, ValueError) as e:
        print(f"jdiff: {e}", file=sys.stderr)
        return 2
    out = []
    walk("$", a, b, out)
    sys.stdout.buffer.write(("".join(l + "\n" for l in out)).encode("utf-8"))
    return 1 if out else 0


sys.exit(main())
