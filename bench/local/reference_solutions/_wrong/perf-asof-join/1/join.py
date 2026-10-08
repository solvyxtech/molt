import bisect
import csv
import sys

# plausible mistake: dict keyed by effective_ts keeps the FIRST row of a tie, and bisect_left misses an
# exact-match timestamp (strictly-before instead of <=)


def main(events_path, rates_path, out_path):
    by = {}
    with open(rates_path, newline="") as f:
        for r in csv.DictReader(f):
            by.setdefault(int(r["effective_ts"]), r["rate"])
    keys = sorted(by)
    with open(events_path, newline="") as f, open(out_path, "w", newline="") as o:
        w = csv.writer(o)
        w.writerow(["ts", "id", "rate"])
        for e in csv.DictReader(f):
            k = bisect.bisect_right(keys, int(e["ts"]))
            w.writerow([e["ts"], e["id"], by[keys[k - 1]] if k else ""])


main(*sys.argv[1:4])
