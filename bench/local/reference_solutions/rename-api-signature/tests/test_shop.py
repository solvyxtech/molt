import unittest

from shop import billing, db, notify, registry, views
from shop.db import fetch_user


class ShopTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect()
        self.conn.execute("INSERT INTO users VALUES (1, 'Ada', 'ada@x.org')")
        self.conn.execute("INSERT INTO users VALUES (2, 'Ben', '')")

    def test_fetch_user(self):
        self.assertEqual(fetch_user(1, db=self.conn)["name"], "Ada")
        self.assertIsNone(fetch_user(9, db=self.conn))

    def test_by_name(self):
        self.assertEqual(db.get_user_by_name(self.conn, "Ben")["id"], 2)

    def test_views(self):
        self.assertEqual(views.profile(self.conn, 1), "Ada <ada@x.org>")
        self.assertEqual(views.profiles(self.conn, [1, 2, 3]), ["Ada <ada@x.org>", "Ben <>"])
        self.assertEqual(views.make_loader(self.conn)(2)["name"], "Ben")

    def test_billing(self):
        self.assertEqual(billing.invoice_owner(self.conn, {"user_id": 1}), "Ada")
        self.assertEqual(billing.total_for(self.conn, [{"user_id": 1, "cents": 5}, {"user_id": 7, "cents": 9}]), 5)

    def test_notify_and_registry(self):
        self.assertEqual(notify.welcome(self.conn, 1), "Welcome, Ada!")
        self.assertEqual(notify.by_keyword(self.conn, 2)["name"], "Ben")
        self.assertEqual(registry.load("user_loader")(1, db=self.conn)["email"], "ada@x.org")


if __name__ == "__main__":
    unittest.main()
