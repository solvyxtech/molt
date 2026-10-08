import sqlite3


def connect(path=":memory:"):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT)")
    return conn


def fetch_user(uid, *, db):
    """Return the user with this id as a dict, or None."""
    row = db.execute("SELECT id, name, email FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        return None
    return {"id": row[0], "name": row[1], "email": row[2]}


def get_user_by_name(db, name):
    row = db.execute("SELECT id FROM users WHERE name = ?", (name,)).fetchone()
    return None if row is None else fetch_user(row[0], db=db)
