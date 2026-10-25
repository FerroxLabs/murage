#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import shutil
import sqlite3
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
CLOUD_HOME = HERE.parent
loader = importlib.machinery.SourceFileLoader("murage_backup", str(CLOUD_HOME / "murage-backup"))
spec = importlib.util.spec_from_loader("murage_backup", loader)
mb = importlib.util.module_from_spec(spec)
loader.exec_module(mb)

cmd_loader = importlib.machinery.SourceFileLoader("murage_commands", str(CLOUD_HOME / "murage-commands"))
cmd_spec = importlib.util.spec_from_loader("murage_commands", cmd_loader)
mc = importlib.util.module_from_spec(cmd_spec)
cmd_loader.exec_module(mc)


class FakeLock:
    def close(self):
        pass


def make_wal_db(path, rows, checkpoint=False):
    """A WAL database whose recent commits live only in the -wal file (the shape a running home leaves on disk)."""
    conn = sqlite3.connect(path, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA wal_autocheckpoint=0")
    conn.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, body TEXT)")
    for i in range(rows):
        conn.execute("INSERT INTO messages (body) VALUES (?)", ("m%d" % i,))
    if checkpoint:
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
    return conn


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.source = os.path.join(self.tmp, "data")
        os.makedirs(os.path.join(self.source, "home"))
        self.db = os.path.join(self.source, "home", "messages.db")
        self.config = os.path.join(self.tmp, "backup.json")
        with open(self.config, "w") as handle:
            json.dump({"repository": "/repo", "passwordFile": "/pw"}, handle)
        self.excludes = os.path.join(self.tmp, "excludes.txt")
        shutil.copy(CLOUD_HOME / "backup-excludes.txt", self.excludes)
        self.last = os.path.join(self.tmp, "last")

    def run_main(self, capturer, runner=None):
        calls = []

        def default_runner(args, env):
            calls.append(args)
            return 0

        code = mb.main(config_path=self.config, excludes=self.excludes, last=self.last, source=self.source,
                       runner=runner or default_runner, lock=lambda: FakeLock(), capturer=capturer)
        return code, calls

    def test_online_backup_of_a_mid_write_database_restores_consistent(self):
        writer = make_wal_db(self.db, 50)  # 50 committed rows that exist only in the -wal file
        self.assertTrue(os.path.getsize(self.db + "-wal") > 0)
        writer.execute("BEGIN")
        writer.execute("INSERT INTO messages (body) VALUES ('uncommitted')")
        out = os.path.join(self.tmp, "snap.db")
        mb.online_backup(self.db, out)
        writer.execute("ROLLBACK")
        writer.close()
        restored = os.path.join(self.tmp, "restored")
        os.makedirs(restored)
        shutil.copy(out, os.path.join(restored, "messages.db"))  # the snapshot alone: no -wal, no -shm
        conn = sqlite3.connect(os.path.join(restored, "messages.db"))
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 50)
        conn.close()
        self.assertEqual(os.listdir(restored), ["messages.db"])

    def test_restic_stores_the_online_snapshot_and_skips_the_live_database_files(self):
        writer = make_wal_db(self.db, 20)
        seen = {}

        def capturer(args, env):
            seen["args"] = list(args)
            stage = os.path.join(self.source, mb.STAGE_DIR, "messages.db")
            seen["stage_exists"] = os.path.isfile(stage)
            if seen["stage_exists"]:
                conn = sqlite3.connect(stage)
                seen["rows"] = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
                seen["integrity"] = conn.execute("PRAGMA integrity_check").fetchone()[0]
                conn.close()
            return 0, b'{"message_type":"summary","snapshot_id":"abcdef0123456789"}\n'

        code, calls = self.run_main(capturer)
        writer.close()
        self.assertEqual(code, 0)
        args = seen["args"]
        excluded = [args[i + 1] for i, a in enumerate(args) if a == "--exclude"]
        for suffix in ("", "-wal", "-shm"):
            self.assertIn(self.db + suffix, excluded)
        self.assertTrue(seen["stage_exists"])
        self.assertEqual((seen["rows"], seen["integrity"]), (20, "ok"))
        self.assertNotIn(os.path.join(self.source, mb.STAGE_DIR), excluded)
        self.assertFalse(os.path.exists(os.path.join(self.source, mb.STAGE_DIR)))  # staging removed after the run
        self.assertTrue(any(c[:2] == ["restic", "tag"] for c in calls))

    def test_a_failed_online_backup_is_never_tagged_complete(self):
        with open(self.db, "wb") as handle:
            handle.write(b"this is not a sqlite database" * 100)
        called = []

        def capturer(args, env):
            called.append(args)
            return 0, b'{"message_type":"summary","snapshot_id":"abcdef0123456789"}\n'

        code, calls = self.run_main(capturer)
        self.assertEqual(code, 1)
        self.assertEqual(called, [])
        self.assertFalse(any(c[:2] == ["restic", "tag"] for c in calls))

    def test_no_database_yet_backs_up_as_before(self):
        seen = {}

        def capturer(args, env):
            seen["args"] = list(args)
            return 0, b'{"message_type":"summary","snapshot_id":"abcdef0123456789"}\n'

        code, _ = self.run_main(capturer)
        self.assertEqual(code, 0)
        self.assertNotIn(self.db, [seen["args"][i + 1] for i, a in enumerate(seen["args"]) if a == "--exclude"])

    def test_restore_puts_the_staged_snapshot_at_the_live_path(self):
        restored = os.path.join(self.tmp, "restored")
        os.makedirs(os.path.join(restored, "home"))
        os.makedirs(os.path.join(restored, mb.STAGE_DIR))
        make_wal_db(os.path.join(self.tmp, "seed.db"), 5).close()
        mb.online_backup(os.path.join(self.tmp, "seed.db"), os.path.join(restored, mb.STAGE_DIR, "messages.db"))
        for name in ("messages.db-wal", "messages.db-shm"):
            with open(os.path.join(restored, "home", name), "wb") as handle:
                handle.write(b"stale")
        mc.place_database_snapshot(restored)
        self.assertEqual(sorted(os.listdir(os.path.join(restored, "home"))), ["messages.db"])
        self.assertFalse(os.path.exists(os.path.join(restored, mb.STAGE_DIR)))
        conn = sqlite3.connect(os.path.join(restored, "home", "messages.db"))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 5)
        conn.close()


if __name__ == "__main__":
    unittest.main()
