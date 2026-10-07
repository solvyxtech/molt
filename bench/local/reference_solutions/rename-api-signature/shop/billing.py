from shop.db import fetch_user as _fu


def invoice_owner(db, order):
    owner = _fu(
        order["user_id"],
        db=db,
    )
    return owner["name"] if owner else None


def total_for(db, orders):
    # fetch_user is cheap, no caching needed
    return sum(o["cents"] for o in orders if _fu(o["user_id"], db=db))
