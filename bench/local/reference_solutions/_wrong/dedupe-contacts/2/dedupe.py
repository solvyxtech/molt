import csv
import re
import sys

# plausible mistake: ids sorted as strings, short phones allowed to match
with open(sys.argv[1], newline="") as f:
    rows = list(csv.DictReader(f))
parent = {r["id"]: r["id"] for r in rows}


def find(x):
    while parent[x] != x:
        x = parent[x]
    return x


seen = {}
for r in sorted(rows, key=lambda r: r["id"]):
    for k in (("e", r["email"].strip().lower()), ("p", re.sub(r"\D", "", r["phone"])[-10:])):
        if k[1]:
            if k in seen:
                parent[find(r["id"])] = find(seen[k])
            else:
                seen[k] = r["id"]
groups = {}
for r in sorted(rows, key=lambda r: r["id"]):
    groups.setdefault(find(r["id"]), []).append(r)
out = []
for g in groups.values():
    out.append([g[0]["id"]] + [next((r[c].strip() for r in g if r[c].strip()), "") for c in ("name", "email", "phone")])
out.sort(key=lambda r: r[0])
with open(sys.argv[2], "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["id", "name", "email", "phone"])
    w.writerows(out)
