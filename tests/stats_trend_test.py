import os
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

from app import db
from app.routes import admin


class StatsTrendTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = os.path.join(self.tempdir.name, "gateway.db")
        db.init_db()

    def tearDown(self):
        db.DB_PATH = self.original_db_path
        self.tempdir.cleanup()

    def add_log(self, local_time, status=200):
        utc_time = local_time - timedelta(hours=8)
        with db.get_conn() as conn:
            conn.execute(
                "INSERT INTO request_logs (ts, status) VALUES (?, ?)",
                (utc_time.strftime("%Y-%m-%d %H:%M:%S"), status),
            )

    def test_hourly_trend_fills_missing_buckets_and_counts_errors(self):
        now = datetime.now(db.TZ).replace(minute=0, second=0, microsecond=0)
        self.add_log(now - timedelta(hours=1))
        self.add_log(now - timedelta(hours=1), status=500)

        trend = db.stats_trend("24h", now=now)

        self.assertEqual(len(trend), 24)
        self.assertEqual(trend[-1]["count"], 0)
        self.assertEqual(trend[-2]["count"], 2)
        self.assertEqual(trend[-2]["errors"], 1)
        self.assertEqual(trend[-3]["count"], 0)

    def test_daily_trend_uses_one_bucket_per_day_for_week_and_month(self):
        now = datetime.now(db.TZ).replace(hour=12, minute=0, second=0, microsecond=0)
        self.add_log(now - timedelta(days=2))

        week = db.stats_trend("7d", now=now)
        month = db.stats_trend("30d", now=now)

        self.assertEqual(len(week), 7)
        self.assertEqual(len(month), 30)
        self.assertEqual(week[-3]["count"], 1)
        self.assertEqual(month[-3]["count"], 1)

    def test_stats_endpoint_returns_the_selected_range(self):
        with patch.object(admin, "verify_admin_auth"):
            payload = __import__("asyncio").run(admin.stats(None, range="7d"))

        self.assertEqual(len(payload["trend"]), 7)
        self.assertEqual(payload["range"], "7d")


if __name__ == "__main__":
    unittest.main()
