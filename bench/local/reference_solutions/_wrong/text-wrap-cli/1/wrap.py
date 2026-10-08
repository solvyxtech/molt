import sys
import textwrap

# plausible mistake: textwrap's defaults (splits long words and breaks at hyphens)
try:
    width = int(sys.argv[1])
    assert width > 0
except Exception:
    sys.exit(2)
paras = [p for p in sys.stdin.read().split("\n\n") if p.strip()]
print("\n\n".join(textwrap.fill(" ".join(p.split()), width) for p in paras))
