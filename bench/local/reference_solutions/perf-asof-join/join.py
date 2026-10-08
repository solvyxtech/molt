import bisect
import csv
import sys


def main(events_path, rates_path, out_path):
    rates = []
    with open(rates_path, newline="") as f:
        for i, r in enumerate(csv.DictReader(f)):
            rates.append((int(r["effective_ts"]), i, r["rate"]))
    rates.sort()  # by effective_ts, then file position: the later row wins a tie
    keys = [r[0] for r in rates]
    with open(events_path, newline="") as f, open(out_path, "w", newline="") as o:
        w = csv.writer(o)
        w.writerow(["ts", "id", "rate"])
        for e in csv.DictReader(f):
            k = bisect.bisect_right(keys, int(e["ts"]))
            w.writerow([e["ts"], e["id"], rates[k - 1][2] if k else ""])


main(*sys.argv[1:4])
