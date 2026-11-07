import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import * as shares from "./room-shares.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { instrumentDatabase, currentBusy } from "./io-budget.ts";
import { DEFAULT_BUSY_MS, setBusy } from "./db-busy.ts";
import { initializeRoomShares } from "./room-shares-schema.ts";

const DAY = 86_400_000, NOW = 100 * DAY;
const opened: DatabaseSync[] = [];
const dirs: string[] = [];
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path); opened.push(db); initializeRoomShares(db); return db;
}
afterEach(() => { for (const db of opened.splice(0).reverse()) db.close(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
function seed(db: DatabaseSync, id: string, status = "shared", expiry = NOW - 31 * DAY) {
  db.prepare(`INSERT INTO room_shares VALUES (?, 'bot', 'room', 'thread', 'origin', 'query', '[]', 'hash', 'nonce', ?, ?, 1, ?)`)
    .run(id, status, `line-${id}`, expiry);
}
it("deletes expired finished rows, retaining pending, unexpired, recent and crash recovery rows", () => {
  const db = fixture();
  for (const status of ["shared", "declined", "unavailable", "pending", "sharing"]) seed(db, status, status);
  seed(db, "future", "shared", NOW + DAY); seed(db, "recent", "shared", NOW - DAY);
  seed(db, "boundary", "shared", NOW - 30 * DAY);
  expect(shares.pruneRoomShares(db, NOW)).toBe(3);
  expect(db.prepare("SELECT id FROM room_shares ORDER BY id").all().map(r => r.id)).toEqual(["boundary", "future", "pending", "recent", "sharing"]);
  const probes: string[] = [];
  shares.recoverRoomShares(db, (_thread, stable) => { probes.push(stable); return true; });
  expect(probes).toEqual(["line-sharing"]);
  expect(shares.roomShare(db, "sharing")?.status).toBe("shared");
});
it("drains a table larger than the fixed batch over several passes", () => {
  const db = fixture();
  for (let i = 0; i < 1003; i++) seed(db, `row-${i}`);
  expect([shares.pruneRoomShares(db, NOW), shares.pruneRoomShares(db, NOW), shares.pruneRoomShares(db, NOW), shares.pruneRoomShares(db, NOW)]).toEqual([500, 500, 3, 0]);
});
it("skips a real busy writer quietly and retries on the next pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "room-shares-test-")); dirs.push(dir);
  const path = join(dir, "shares.db");
  const db = fixture(path); seed(db, "old");
  const lock = new DatabaseSync(path); opened.push(lock);
  instrumentDatabase(db); setBusy(db, DEFAULT_BUSY_MS); lock.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  try { expect(shares.pruneRoomShares(db, NOW)).toBeNull();
    expect(performance.now() - started).toBeLessThan(400);
    expect(currentBusy(db)).toBe(DEFAULT_BUSY_MS);
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(DEFAULT_BUSY_MS); expect(shares.roomShare(db, "old")).not.toBeNull(); }
  finally { lock.exec("ROLLBACK"); }
  expect(shares.pruneRoomShares(db, NOW)).toBe(1);
});
it("the actual prune query searches the status/expiry index without scanning or sorting history", () => {
  const db = fixture();
  const plans = db.prepare(`EXPLAIN QUERY PLAN ${shares.ROOM_SHARE_PRUNE_SQL}`).all(NOW - 30 * DAY, 500).map(r => String(r.detail)).join("\n");
  expect(plans).toMatch(/SEARCH room_shares USING COVERING INDEX room_shares_status .*status=\? AND expires_at<\?/);
  expect(plans).not.toMatch(/SCAN room_shares|TEMP B-TREE/);
});
