import shop.db as sdb


def welcome(db, uid):
    user = sdb.fetch_user(uid, db=db)
    return "Welcome, %s!" % user["name"] if user else "Welcome!"


def by_keyword(db, uid):
    return sdb.fetch_user(uid=uid, db=db)
