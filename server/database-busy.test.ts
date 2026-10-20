// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SQLite budgets (PROPOSAL-v2 10.3): a lock held by another connection never holds the server's one
// thread for 5 s. Background memory work waits 50 ms and tries later; everything else waits 1 s and is
// told "try again" (503 DATABASE_BUSY with Retry-After), never a 500 or a 409. The journal is capped, and a high-water WAL is given back at start.
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { BACKGROUND_BUSY_MS, closeDatabase, database, DatabaseBusyError, finishBackgroundUpgradeWorkNow, isDatabaseBusy, JOURNAL_SIZE_LIMIT_BYTES, OWNER_BUSY_MS, storageLine, transaction, withBusyBudget } from "./database.ts";
import { maintainLineageStorage, WAL_QUIET_BYTES } from "./memory/root-set-compaction.ts";
import { ioBudget } from "./io-budget.ts";
import { resetObserveWindows, setObserveSink } from "./observe.ts";
import { checkpointTruncate, CHECKPOINT_BUSY_MS } from "./sqlite-checkpoint.ts";
import { walMaintenanceReady } from "./wal-maintenance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let lines: string[], other: DatabaseSync | null = null;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); lines = []; resetObserveWindows(); setObserveSink(line => lines.push(line)); });
afterEach(() => { try { other?.close(); } catch { /* closed */ } other = null; closeDatabase(); setObserveSink(); });
const holdWriteLock = () => { other = new DatabaseSync(join(DATA_DIR, "messages.db")); other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); };
const release = () => { other!.exec("ROLLBACK"); };

it("opens with the owner budget and a journal cap, and reads them back", () => {
  const db = database();
  expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: OWNER_BUSY_MS });
  expect(db.prepare("PRAGMA journal_size_limit").get()).toEqual({ journal_size_limit: JOURNAL_SIZE_LIMIT_BYTES });
  expect(JOURNAL_SIZE_LIMIT_BYTES).toBe(0); // the next commit after a copied log cuts the file back (wal-maintenance.ts)
  // the first open of the process says how big the store is (this file's first open is this test)
  expect(lines.some(line => /^\[sqlite\] storage file=\d+ wal=\d+ freelist=\d+$/.test(line))).toBe(true);
});

it("a transaction with a background budget gives up at its budget with a typed error, then the next one works and the wait is restored", () => {
  const db = database();
  holdWriteLock();
  const started = performance.now();
  expect(() => transaction(() => 1, { op: "claim", busyMs: BACKGROUND_BUSY_MS })).toThrow(DatabaseBusyError);
  expect(performance.now() - started).toBeLessThan(500);
  expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: OWNER_BUSY_MS });
  release();
  expect(transaction(() => 2, { busyMs: BACKGROUND_BUSY_MS })).toBe(2);
  expect(lines.some(line => /^\[sqlite\] busy op=claim waited=\d+ holder=other-process$/.test(line))).toBe(true);
});

it("work done on behalf of the memory worker takes the background budget without asking", () => {
  database();
  holdWriteLock();
  const started = performance.now();
  expect(() => ioBudget.withSource("memory-worker", () => transaction(() => 1))).toThrow(DatabaseBusyError);
  expect(() => ioBudget.withSource("memory-idle", () => transaction(() => 1))).toThrow(DatabaseBusyError);
  expect(performance.now() - started).toBeLessThan(800);
});

it("an owner action waits its second and then fails with a lock error the HTTP layer maps to a retryable 503 DATABASE_BUSY", () => {
  database();
  holdWriteLock();
  const started = performance.now();
  let caught: unknown;
  try { transaction(() => 1); } catch (error) { caught = error; }
  const waited = performance.now() - started;
  expect(isDatabaseBusy(caught)).toBe(true);
  expect(waited).toBeGreaterThan(800);
  // the bound separates the owner budget (1 s) from the old 5 s wait this replaced; a loaded runner adds
  // seconds of scheduling on top, never four
  expect(waited).toBeLessThan(4_000);
  expect(new DatabaseBusyError("x", 1).status).toBe(503); // never 409: clients read that as a conflict
  expect(new DatabaseBusyError("x", 1).code).toBe("DATABASE_BUSY");
  expect(new DatabaseBusyError("x", 1).message).toBe("Busy for a moment, try again");
});

it("a statement outside a transaction gets the same budget through withBusyBudget", () => {
  const db = database();
  db.exec("CREATE TABLE IF NOT EXISTS t(a)");
  holdWriteLock();
  const started = performance.now();
  expect(() => withBusyBudget(BACKGROUND_BUSY_MS, "heartbeat", handle => handle.prepare("INSERT INTO t VALUES(1)").run())).toThrow(DatabaseBusyError);
  expect(performance.now() - started).toBeLessThan(500);
  expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: OWNER_BUSY_MS });
});

it("a checkpoint on a secondary connection waits at most CHECKPOINT_BUSY_MS and says it was blocked", () => {
  const main = database();
  main.exec("CREATE TABLE IF NOT EXISTS t(a); INSERT INTO t VALUES(1)");
  const secondary = new DatabaseSync(join(DATA_DIR, "messages.db"));
  secondary.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  // a reader that has not finished pins the log
  const reader = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT * FROM t").all();
  main.exec("INSERT INTO t VALUES(2)");
  const started = performance.now();
  expect(checkpointTruncate(secondary, "deletion")).toBe(false);
  expect(performance.now() - started).toBeLessThan(CHECKPOINT_BUSY_MS + 500);
  expect(secondary.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  expect(lines.some(line => line.startsWith("[sqlite] busy op=deletion"))).toBe(true);
  reader.exec("ROLLBACK"); reader.close();
  expect(checkpointTruncate(secondary, "deletion")).toBe(true);
  secondary.close();
});

it("a log left large by an earlier run is NOT checkpointed when the background work starts (that blocked the first responses); the idle storage sweep gives it back off the serving thread, and the sizes are logged", async () => {
  closeDatabase();
  const file = join(DATA_DIR, "messages.db");
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE big(a TEXT)");
  for (let i = 0; i < 40; i++) raw.prepare("INSERT INTO big VALUES(?)").run("x".repeat(200_000));
  expect(statSync(`${file}-wal`).size).toBeGreaterThan(4_000_000);
  other = raw;  // still open, as a crashed run's connection would not be, but nothing reads from it
  database();
  const walAfterOpen = statSync(`${file}-wal`).size;
  finishBackgroundUpgradeWorkNow();
  // starting the background work issues no checkpoint: the log is as the open left it
  expect(statSync(`${file}-wal`).size).toBe(walAfterOpen);
  // the idle sweep (never waiting on a lock) cuts it back; it copies the log through the checkpointer thread, which comes up a moment after the open
  for (let waited = 0; !walMaintenanceReady() && waited < 5_000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  expect(walMaintenanceReady()).toBe(true);
  await maintainLineageStorage({ database: () => database(), idle: () => true, pauseMs: 0 });
  // (the checkpointer copies the log and one tiny write restarts it, wal-maintenance.ts: what is left is that write's one frame, under the quiet size)
  const walAfter = statSync(`${file}-wal`).size;
  expect(walAfter).toBeLessThan(walAfterOpen);
  expect(walAfter).toBeLessThanOrEqual(WAL_QUIET_BYTES);
  expect(storageLine(database(), file)).toMatch(/^\[sqlite\] storage file=\d+ wal=\d+ freelist=\d+$/);
});

it("every HTTP answer for a lock goes through busyJson: 503, code DATABASE_BUSY, Retry-After, and no 409 is built from a busy error", () => {
  const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  // e71504028 added no-store to every JSON answer, this one included: a busy answer is never cached and served again.
  expect(source).toContain('res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(DATABASE_BUSY_RETRY_AFTER_S) })');
  expect(source).toContain('code: "DATABASE_BUSY"');
  expect(source).toContain('if (isDatabaseBusy(e)) return busyJson(res, "request");');
  expect(source).toContain('if(isDatabaseBusy(error))return busyJson(res,"memory-action");');
  expect(source).not.toMatch(/json\(res, ?409, ?\{ ?error: new DatabaseBusyError/);
});
