import configparser
import json
import sys

# plausible mistake: lean on configparser (no ${} across sections, inline comments only with the right
# prefixes, no typing of _list, DEFAULT handled its own way)
cp = configparser.ConfigParser(interpolation=configparser.ExtendedInterpolation(), inline_comment_prefixes=(";", "#"))
try:
    cp.read(sys.argv[1], encoding="utf-8")
except configparser.Error as e:
    print(e, file=sys.stderr)
    sys.exit(1)


def conv(v):
    if v.lower() in ("true", "yes", "on"):
        return True
    if v.lower() in ("false", "no", "off"):
        return False
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        return v


out = {}
for s in cp.sections():
    node = out
    for part in s.split("."):
        node = node.setdefault(part, {})
    for k, v in cp.items(s):
        node[k] = conv(v)
json.dump(out, open(sys.argv[2], "w"))
