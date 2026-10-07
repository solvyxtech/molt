import sys

# plausible mistake: str.split() treats U+00A0 and other Unicode spaces as separators
try:
    width = int(sys.argv[1])
    assert width > 0
except Exception:
    sys.exit(2)
paras, cur = [], []
for line in sys.stdin.read().split("\n"):
    if not line.strip():
        if cur:
            paras.append(cur)
        cur = []
    else:
        cur.extend(line.split())
if cur:
    paras.append(cur)
out = []
for ws in paras:
    lines, line = [], ws[0]
    for w in ws[1:]:
        if len(line) + 1 + len(w) <= width:
            line += " " + w
        else:
            lines.append(line)
            line = w
    lines.append(line)
    out.append("\n".join(lines))
sys.stdout.write("\n\n".join(out) + ("\n" if out else ""))
