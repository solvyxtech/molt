import json
import sys

# plausible mistake: plain == (so 1 equals true), keys in file order rather than sorted, simple paths only


def dump(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def walk(path, a, b, out):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in list(a) + [k for k in b if k not in a]:
            if k not in b:
                out.append(f"- {path}.{k}: {dump(a[k])}")
            elif k not in a:
                out.append(f"+ {path}.{k}: {dump(b[k])}")
            else:
                walk(f"{path}.{k}", a[k], b[k], out)
    elif isinstance(a, list) and isinstance(b, list):
        for i in range(max(len(a), len(b))):
            if i >= len(b):
                out.append(f"- {path}[{i}]: {dump(a[i])}")
            elif i >= len(a):
                out.append(f"+ {path}[{i}]: {dump(b[i])}")
            else:
                walk(f"{path}[{i}]", a[i], b[i], out)
    elif a != b:
        out.append(f"~ {path}: {dump(a)} -> {dump(b)}")


try:
    a = json.load(open(sys.argv[1], encoding="utf-8"))
    b = json.load(open(sys.argv[2], encoding="utf-8"))
except (OSError, ValueError):
    sys.exit(2)
out = []
walk("$", a, b, out)
sys.stdout.buffer.write(("".join(l + "\n" for l in out)).encode())
sys.exit(1 if out else 0)
