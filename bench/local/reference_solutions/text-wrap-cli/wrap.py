import re
import sys

ASCII_WS = " \t\r\n\f\v"


def usage():
    print("usage: wrap.py WIDTH   (WIDTH a positive integer)", file=sys.stderr)
    sys.exit(2)


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"[0-9]+", sys.argv[1]) or int(sys.argv[1]) < 1:
        usage()
    width = int(sys.argv[1])
    text = sys.stdin.buffer.read().decode("utf-8")
    paragraphs, words = [], []
    for line in text.split("\n"):
        line_words = [w for w in re.split("[" + ASCII_WS + "]+", line) if w]
        if not line_words:
            if words:
                paragraphs.append(words)
            words = []
        else:
            words.extend(line_words)
    if words:
        paragraphs.append(words)
    rendered = []
    for ws in paragraphs:
        lines, cur = [], ws[0]
        for w in ws[1:]:
            if len(cur) + 1 + len(w) <= width:
                cur += " " + w
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
        rendered.append("\n".join(lines))
    sys.stdout.buffer.write(("\n\n".join(rendered) + "\n" if rendered else "").encode("utf-8"))


main()
