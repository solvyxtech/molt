import json
import sys
from collections import Counter, defaultdict

import bucket


def main(path):
    per_day = Counter()
    per_hour = defaultdict(Counter)
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            ts = json.loads(line)["ts"]
            day = bucket.day_of(ts)
            per_day[day] += 1
            per_hour[day][bucket.hour_of(ts)] += 1
    for day in sorted(per_day):
        counts = per_hour[day]
        peak = min(counts, key=lambda h: (-counts[h], h))
        print(f"{day} {per_day[day]} peak={peak:02d}")


if __name__ == "__main__":
    main(sys.argv[1])
