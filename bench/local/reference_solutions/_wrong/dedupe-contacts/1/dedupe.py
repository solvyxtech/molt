import csv
import re
import sys

# plausible mistake: groups by email first, then by phone, but not transitively across both
with open(sys.argv[1], newline="") as f:
    rows = list(csv.DictReader(f))
rows.sort(key=lambda r: int(r["id"]))
groups = []
for r in rows:
    e = r["email"].strip().lower()
    p = re.sub(r"\D", "", r["phone"])[-10:]
    for g in groups:
        if (e and e == g["e"]) or (len(p) >= 7 and p == g["p"]):
            g["rows"].append(r)
            break
    else:
        groups.append({"e": e, "p": p, "rows": [r]})
with open(sys.argv[2], "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["id", "name", "email", "phone"])
    for g in groups:
        rs = g["rows"]
        w.writerow([rs[0]["id"]] + [next((r[c].strip() for r in rs if r[c].strip()), "") for c in ("name", "email", "phone")])
