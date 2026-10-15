// SPDX-License-Identifier: AGPL-3.0-or-later
// T8 (STALLS-FINAL-DESIGN 3.2): the inbox fill's deferred rows are written one row per transaction (a thread with many of them is applied
// in as many transactions, the lock free between them), each transaction's hold is measured, and a row that held the lock past maxHoldMs
// is reported (rate limited) so a slow store shows its per-row hold on the log.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { INBOX_DEFERRED_SQL, initializeInbox, inboxProjectionSlice } from "./inbox.ts";
import { inboxDeferredDrain, INBOX_FILL_MAX_HOLD_MS, type InboxSlowRow } from "./inbox-fill-worker.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const databases: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});
function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), "murage-fill-hold-")); dirs.push(dir);
  const file = join(dir, "messages.db");
  const db = new DatabaseSync(file); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
  initializeMessageTables(db);
  return { db, file };
}
const big = (id: string, at: number) => JSON.stringify({ id, at, role: "bot", kind: "activity", tool: { name: "run", ok: true, output: "x".repeat(2 * 1024 * 1024) } });
const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;

/** One thread with `rows` deferred rows (each heavier than the slice budget). */
function deferredThread(rows: number) {
  const made = fileDb();
  for (let i = 0; i < rows; i++) made.db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t',?,?,'bot','activity',NULL,?)").run(`big${i}`, 1_000 + i, big(`big${i}`, 1_000 + i));
  initializeInbox(made.db);
  inboxProjectionSlice(made.db, { rows: 10_000, weight: 512 * 1024 });
  expect(count(made.db, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(rows);
  return made;
}

it("a thread's deferred rows are applied one transaction each, and the lock is free between them", () => {
  const { file } = deferredThread(3);
  const worker = new DatabaseSync(file); databases.push(worker);
  worker.exec("PRAGMA busy_timeout=0;");
  const probe = new DatabaseSync(file); databases.push(probe);
  probe.exec("PRAGMA busy_timeout=0;");
  const drain = inboxDeferredDrain(worker, INBOX_DEFERRED_SQL);
  let transactions = 0;
  while (drain.step()) {
    transactions++;
    // between two rows nothing holds the write lock: another writer takes it at once (no wait at all)
    probe.exec("BEGIN IMMEDIATE"); probe.exec("ROLLBACK");
  }
  expect(transactions).toBe(3);
  expect(count(worker, "SELECT COUNT(*) AS n FROM inbox_fill_deferred")).toBe(0);
});

it("a row that held the lock past maxHoldMs is reported with its hold and size, at most once per window, the rest counted into it", () => {
  const { file } = deferredThread(4);
  const worker = new DatabaseSync(file); databases.push(worker);
  worker.exec("PRAGMA busy_timeout=0;");
  const reports: InboxSlowRow[] = [];
  let clock = 0;
  // a bar below zero: every row is "slow"; a fixed clock keeps the 2nd and 3rd in the first report's window
  const drain = inboxDeferredDrain(worker, INBOX_DEFERRED_SQL, { maxHoldMs: -1, onSlowRow: row => reports.push(row), now: () => clock });
  drain.step();
  expect(reports).toHaveLength(1);
  expect(reports[0]!.size).toBeGreaterThan(2 * 1024 * 1024);
  expect(reports[0]!.ms).toBeGreaterThanOrEqual(0);
  expect(reports[0]!.more).toBe(0);
  drain.step(); drain.step();
  expect(reports).toHaveLength(1);
  clock = 60_000;
  drain.step();
  expect(reports).toHaveLength(2);
  expect(reports[1]!.more).toBe(2);
});

it("the default bar is 100 ms, and a row under it is not reported", () => {
  expect(INBOX_FILL_MAX_HOLD_MS).toBe(100);
  const { file } = deferredThread(1);
  const worker = new DatabaseSync(file); databases.push(worker);
  const reports: InboxSlowRow[] = [];
  const drain = inboxDeferredDrain(worker, INBOX_DEFERRED_SQL, { maxHoldMs: 60_000, onSlowRow: row => reports.push(row) });
  expect(drain.step()).toBe(true);
  expect(reports).toEqual([]);
});
