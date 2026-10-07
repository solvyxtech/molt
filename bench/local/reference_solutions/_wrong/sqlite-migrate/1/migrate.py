import sqlite3
import sys

# plausible mistake: rename the old table out of the way, create the new one, copy, drop the old one --
# the rename also rewrites order_items' REFERENCES orders(id) to point at the (now dropped) old table
db = sqlite3.connect(sys.argv[1], isolation_level=None)
v = db.execute("PRAGMA user_version").fetchone()[0]
if v == 2:
    sys.exit(0)
if v != 1:
    sys.exit(1)
db.executescript(
    """
BEGIN;
CREATE TABLE customers(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
INSERT INTO customers(email) SELECT lower(trim(customer)) FROM orders GROUP BY lower(trim(customer)) ORDER BY min(id);
ALTER TABLE orders RENAME TO orders_old;
CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount_cents INTEGER NOT NULL, placed_at TEXT NOT NULL, note TEXT);
INSERT INTO orders SELECT o.id, c.id, CAST(ROUND(o.amount * 100) AS INTEGER), o.placed_at, o.note
  FROM orders_old o JOIN customers c ON c.email = lower(trim(o.customer));
DROP TABLE orders_old;
CREATE INDEX idx_orders_placed ON orders(placed_at);
CREATE INDEX idx_orders_customer ON orders(customer_id);
PRAGMA user_version = 2;
COMMIT;
"""
)
