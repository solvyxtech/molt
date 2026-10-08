import sqlite3
import sys
from decimal import ROUND_HALF_UP, Decimal


def migrate(db):
    db.execute("PRAGMA foreign_keys = OFF")
    db.execute("BEGIN")
    try:
        db.execute("CREATE TABLE customers(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)")
        db.execute(
            "CREATE TABLE orders_v2(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), "
            "amount_cents INTEGER NOT NULL, placed_at TEXT NOT NULL, note TEXT)"
        )
        ids = {}
        for oid, customer, amount, placed_at, note in db.execute(
            "SELECT id, customer, amount, placed_at, note FROM orders ORDER BY id"
        ).fetchall():
            email = customer.strip().lower()
            if email not in ids:
                ids[email] = len(ids) + 1
                db.execute("INSERT INTO customers(id, email) VALUES (?, ?)", (ids[email], email))
            cents = int((Decimal(repr(amount)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
            db.execute("INSERT INTO orders_v2 VALUES (?, ?, ?, ?, ?)", (oid, ids[email], cents, placed_at, note))
        db.execute("DROP TABLE orders")
        db.execute("ALTER TABLE orders_v2 RENAME TO orders")
        db.execute("CREATE INDEX idx_orders_placed ON orders(placed_at)")
        db.execute("CREATE INDEX idx_orders_customer ON orders(customer_id)")
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("foreign key violations after migration")
        db.execute("PRAGMA user_version = 2")
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise


def main(path):
    db = sqlite3.connect(path, isolation_level=None)
    version = db.execute("PRAGMA user_version").fetchone()[0]
    if version == 2:
        return 0
    if version != 1:
        print(f"migrate.py: unsupported schema version {version}", file=sys.stderr)
        return 1
    migrate(db)
    return 0


sys.exit(main(sys.argv[1]))
