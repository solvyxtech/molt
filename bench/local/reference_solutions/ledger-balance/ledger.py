import re
import sys

AMOUNT = re.compile(r"(-?)\$(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?")
DATE = re.compile(r"(\d{4}-\d\d-\d\d)(?: |$)")


class JournalError(Exception):
    pass


def parse_amount(text, line):
    m = AMOUNT.fullmatch(text)
    if not m or (m.group(1) and m.group(2)):
        raise JournalError(f"line {line}: malformed amount {text!r}")
    cents = int(m.group(3).replace(",", "")) * 100 + int((m.group(4) or "0").ljust(2, "0"))
    return -cents if (m.group(1) or m.group(2)) else cents


def money(cents):
    s = f"${abs(cents) // 100:,}.{abs(cents) % 100:02d}"
    return "-" + s if cents < 0 else s


def read(path):
    txns, cur = [], None
    with open(path, encoding="utf-8") as f:
        for no, raw in enumerate(f.read().split("\n"), 1):
            if not raw.strip() or raw[0] in ";#":
                continue
            if raw[0] in " \t":
                if cur is not None and not raw.strip().startswith(";"):
                    cur["lines"].append(raw.strip())
                continue
            m = DATE.match(raw)
            if m:
                cur = {"line": no, "date": m.group(1), "lines": []}
                txns.append(cur)
    return txns


def postings(txn):
    out, missing, total = [], None, 0
    for content in txn["lines"]:
        m = re.search(r"\t+| {2,}", content)
        account, rest = (content[:m.start()], content[m.end():]) if m else (content, "")
        rest = rest.split(";")[0].strip()
        if not rest:
            if missing is not None:
                raise JournalError(f"line {txn['line']}: more than one posting without an amount")
            missing = len(out)
            out.append([account, 0])
        else:
            cents = parse_amount(rest, txn["line"])
            total += cents
            out.append([account, cents])
    if missing is not None:
        out[missing][1] = -total
        total = 0
    if total != 0:
        raise JournalError(f"line {txn['line']}: transaction does not balance (off by {money(total)})")
    return out


def main(argv):
    until = None
    args = list(argv)
    if "--until" in args:
        i = args.index("--until")
        until = args[i + 1]
        del args[i:i + 2]
    try:
        txns = read(args[0])
        lines = [(t["date"], postings(t)) for t in txns]
    except JournalError as e:
        print(e, file=sys.stderr)
        return 1
    totals = {}
    for date, ps in lines:
        if until is not None and date > until:
            continue
        for account, cents in ps:
            parts = account.split(":")
            for i in range(1, len(parts) + 1):
                key = ":".join(parts[:i])
                totals[key] = totals.get(key, 0) + cents
    for key in sorted(totals):
        if totals[key] != 0:
            print(f"{money(totals[key]):>12}  {key}")
    return 0


sys.exit(main(sys.argv[1:]))
