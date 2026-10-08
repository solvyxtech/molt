import json
import re
import sys


class IniError(Exception):
    pass


def parse_value(v):
    if v.startswith('"'):
        end = v.find('"', 1)
        if end == -1:
            raise IniError("unterminated quote")
        rest = v[end + 1:].strip()
        if rest and rest[0] not in ";#":
            raise IniError("text after closing quote")
        return v[1:end], True
    if v and v[0] in ";#":
        return "", False
    m = re.search(r"\s[;#]", v)
    if m:
        v = v[:m.start()].rstrip()
    return v, False


def load(path):
    root, sections, defaults = {}, {}, {}
    cur = None
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    for raw in lines:
        line = raw.strip()
        if not line or line[0] in ";#":
            continue
        m = re.fullmatch(r"\[([^\]]+)\]", line)
        if m:
            cur = m.group(1).strip()
            if cur != "DEFAULT":
                sections.setdefault(cur, {})
            continue
        if "=" not in line:
            raise IniError(f"bad line: {line!r}")
        key, _, val = line.partition("=")
        target = root if cur is None else defaults if cur == "DEFAULT" else sections[cur]
        target[key.strip()] = parse_value(val.strip())
    merged = {name: {**defaults, **body} for name, body in sections.items()}
    merged[""] = root
    return merged


def resolve(merged, sec, key, stack=()):
    if (sec, key) in stack:
        raise IniError(f"reference cycle at {key}")
    if sec not in merged or key not in merged[sec]:
        raise IniError(f"unresolved reference {sec}.{key}")
    text, _ = merged[sec][key]

    def sub(m):
        ref = m.group(1)
        s2, k2 = ref.rsplit(".", 1) if "." in ref else (sec, ref)
        return resolve(merged, s2, k2, stack + ((sec, key),))

    return re.sub(r"\$\{([^}]*)\}", sub, text)


def convert(key, text, quoted):
    if quoted:
        return text
    if key.endswith("_list"):
        return [x.strip() for x in text.split(",")] if text.strip() else []
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d+\.\d+", text):
        return float(text)
    low = text.lower()
    if low in ("true", "yes", "on"):
        return True
    if low in ("false", "no", "off"):
        return False
    if low == "null":
        return None
    return text


def main(src, dst):
    try:
        merged = load(src)
        out = {}
        for sec, body in merged.items():
            node = out
            if sec:
                for part in sec.split("."):
                    node = node.setdefault(part, {})
            for key, (_, quoted) in body.items():
                node[key] = convert(key, resolve(merged, sec, key), quoted)
    except (IniError, OSError) as e:
        print(f"ini2json: {e}", file=sys.stderr)
        sys.exit(1)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
        f.write("\n")


main(sys.argv[1], sys.argv[2])
