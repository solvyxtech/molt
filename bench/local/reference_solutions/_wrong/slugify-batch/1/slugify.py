import re
import sys
import unicodedata

# plausible mistake: ASCII-folding through encode("ascii", "ignore") (drops ß, æ, ø... instead of
# transliterating them) and suffixing duplicates with a per-slug counter that can collide
seen = {}
for line in sys.stdin.read().splitlines():
    s = unicodedata.normalize("NFKD", line.lower()).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40].strip("-") or "untitled"
    n = seen.get(s, 0)
    seen[s] = n + 1
    print(s if n == 0 else f"{s}-{n + 1}")
