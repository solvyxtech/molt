import re
import sys
import unicodedata

TABLE = [("ß", "ss"), ("æ", "ae"), ("œ", "oe"), ("ø", "o"), ("ð", "d"), ("đ", "d"), ("þ", "th"), ("ł", "l")]


def slug(text):
    text = text.lower()
    for a, b in TABLE:
        text = text.replace(a, b)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    text = text[:40].rstrip("-")
    return text or "untitled"


def main():
    data = sys.stdin.buffer.read().decode("utf-8")
    lines = data.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    taken = set()
    out = []
    for line in lines:
        if line.endswith("\r"):
            line = line[:-1]
        base = slug(line)
        cand, n = base, 1
        while cand in taken:
            n += 1
            cand = f"{base}-{n}"
        taken.add(cand)
        out.append(cand)
    sys.stdout.buffer.write(("".join(s + "\n" for s in out)).encode("utf-8"))


main()
