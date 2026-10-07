"""Report users that look incomplete."""
from shop.db import fetch_user


def audit(conn, ids):
    bad = []
    for uid in ids:
        u = fetch_user(uid, db=conn)
        if u is None or not u["email"]:
            bad.append(uid)
    return bad
