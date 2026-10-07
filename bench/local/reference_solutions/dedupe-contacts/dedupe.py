import csv
import re
import sys


def main(src, dst):
    with open(src, newline="") as f:
        rows = list(csv.DictReader(f))
    parent = list(range(len(rows)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    first = {}
    for i, r in enumerate(rows):
        keys = []
        email = r["email"].strip().lower()
        if email:
            keys.append(("email", email))
        digits = re.sub(r"\D", "", r["phone"])
        if len(digits) >= 7:
            keys.append(("phone", digits[-10:]))
        for k in keys:
            if k in first:
                parent[find(i)] = find(first[k])
            else:
                first[k] = i
    groups = {}
    for i, r in enumerate(rows):
        groups.setdefault(find(i), []).append(r)
    out = []
    for g in groups.values():
        g.sort(key=lambda r: int(r["id"]))
        merged = {"id": g[0]["id"]}
        for col in ("name", "email", "phone"):
            merged[col] = next((r[col].strip() for r in g if r[col].strip()), "")
        out.append(merged)
    out.sort(key=lambda r: int(r["id"]))
    with open(dst, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "name", "email", "phone"])
        w.writeheader()
        w.writerows(out)


main(sys.argv[1], sys.argv[2])
