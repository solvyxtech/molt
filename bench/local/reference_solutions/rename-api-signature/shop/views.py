import functools

from shop.db import fetch_user


def profile(db, uid):
    u = fetch_user(uid, db=db)
    if u is None:
        return "unknown"
    return "%s <%s>" % (u["name"], u["email"])


def profiles(db, uids):
    return [profile(db, u) for u in uids if fetch_user(u, db=db)]


def make_loader(db):
    """A one-argument loader bound to this connection."""
    return functools.partial(fetch_user, db=db)
