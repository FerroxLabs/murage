// SPDX-License-Identifier: AGPL-3.0-or-later
// T3 (STALLS-FINAL-DESIGN 3.1 and 3.4, database.ts invariants 1 and 4): every background source takes the background budget, and so do
// beginBackground and withBusyBudget; with no source and no budget the handle still waits its owner budget (the owner path is unchanged),
// and that unbudgeted wait is named on the log as `[sqlite] busy ... budget=none at=<caller>`.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { BACKGROUND_BUSY_MS, beginBackground, closeDatabase, database, DatabaseBusyError, DEFAULT_BUSY_MS, holdWritersForIndexBuild, isDatabaseBusy, transaction, withBusyBudget } from "./database.ts";
import { ioBudget } from "./io-budget.ts";
import { resetObserveWindows, setObserveSink } from "./observe.ts";

let lines: string[], other: DatabaseSync | null = null;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); lines = []; resetObserveWindows(); setObserveSink(line => lines.push(line)); });
afterEach(() => { holdWritersForIndexBuild(false); try { other?.exec("ROLLBACK"); } catch { /* none open */ } try { other?.close(); } catch { /* closed */ } other = null; closeDatabase(); setObserveSink(); });
const holdWriteLock = () => { other = new DatabaseSync(join(DATA_DIR, "messages.db")); other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); };
const timed = (run: () => unknown): { ms: number; error: unknown } => {
  const started = performance.now();
  try { run(); } catch (error) { return { ms: performance.now() - started, error }; }
  return { ms: performance.now() - started, error: undefined };
};

it.each(["memory-worker", "memory-idle", "memory-notebook", "startup"])("under the %s source a held lock costs the background budget, never the owner's", source => {
  database();
  holdWriteLock();
  const tx = timed(() => ioBudget.withSource(source, () => transaction(() => 1, { op: "t3" })));
  expect(tx.error).toBeInstanceOf(DatabaseBusyError);
  expect(tx.ms).toBeLessThan(150);
  // the synchronous-only source of an after-listen step does the same
  const sync = timed(() => ioBudget.withSyncSource(source, () => transaction(() => 1, { op: "t3" })));
  expect(sync.error).toBeInstanceOf(DatabaseBusyError);
  expect(sync.ms).toBeLessThan(150);
});

it("beginBackground and withBusyBudget give up at the background budget, and the usual wait is back after", () => {
  const db = database();
  holdWriteLock();
  const begun = timed(() => beginBackground(db, "slice"));
  expect(begun.error).toBeInstanceOf(DatabaseBusyError);
  expect(begun.ms).toBeLessThan(150);
  expect(db.isTransaction).toBe(false);
  const budgeted = timed(() => withBusyBudget(BACKGROUND_BUSY_MS, "mark", d => d.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES ('t3', 1, 0, 0)").run()));
  expect(budgeted.error).toBeInstanceOf(DatabaseBusyError);
  expect(budgeted.ms).toBeLessThan(150);
  expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: DEFAULT_BUSY_MS });
  other!.exec("ROLLBACK");
  // free again: the slice takes the lock, and commits with synchronous=NORMAL, FULL coming back once it has
  beginBackground(db, "slice");
  expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
  db.exec("COMMIT");
  expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
});

it("with no source and no budget the owner path still waits its full budget, and the wait is named with its caller", () => {
  database();
  holdWriteLock();
  const owner = timed(() => transaction(() => 1, { op: "owner" }));
  expect(isDatabaseBusy(owner.error)).toBe(true);
  expect(owner.ms).toBeGreaterThanOrEqual(DEFAULT_BUSY_MS * 0.9);
  const line = lines.find(text => text.startsWith("[sqlite] busy ") && text.includes("budget=none"));
  expect(line, lines.join("\n")).toMatch(/^\[sqlite\] busy op=BEGIN IMMEDIATE waited=\d+ holder=other-connection budget=none at=database\.test\.ts:\d+/);
});

it("during the process's own writer hold no write on the serving thread waits more than the background budget, and the hold is named", () => {
  const db = database();
  holdWriteLock();
  holdWritersForIndexBuild(true);
  // a transaction with no source and no budget (an owner path that got past the gate, or an unsourced background slice): the background budget
  const tx = timed(() => transaction(() => 1, { op: "owner" }));
  expect(tx.error).toBeInstanceOf(DatabaseBusyError);
  expect(tx.ms).toBeLessThan(150);
  expect(lines.find(text => text.startsWith("[sqlite] busy op=owner"))).toMatch(/holder=writer-hold/);
  // an autocommit write and a bare BEGIN, with no source: the same
  const autocommit = timed(() => db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES ('hold', 1, 0, 0)").run());
  expect(isDatabaseBusy(autocommit.error)).toBe(true);
  expect(autocommit.ms).toBeLessThan(150);
  const bare = timed(() => db.exec("BEGIN IMMEDIATE"));
  expect(isDatabaseBusy(bare.error)).toBe(true);
  expect(bare.ms).toBeLessThan(150);
  expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: DEFAULT_BUSY_MS });
  expect(lines.some(text => text.includes("budget=none")), lines.join("\n")).toBe(false);
  expect(lines.find(text => text.startsWith("[sqlite] busy op=INSERT OR REPLACE INTO transcript_index_state"))).toMatch(/holder=writer-hold budget=50 at=database\.test\.ts:\d+/);
  lines.length = 0;
  timed(() => ioBudget.withSource("memory-idle", () => transaction(() => 1, { op: "idle-receipt" })));
  expect(lines.find(text => text.startsWith("[sqlite] busy op=idle-receipt"))).toMatch(/holder=writer-hold/);
  expect(lines.some(text => text.includes("budget=none"))).toBe(false);
  // released: an owner write takes the lock again with its own wait
  holdWritersForIndexBuild(false);
  other!.exec("ROLLBACK");
  expect(transaction(() => 2, { op: "owner" })).toBe(2);
});

it("under a background source an autocommit write and a bare BEGIN wait the background budget too, also in the source's later slices", async () => {
  const db = database();
  holdWriteLock();
  const write = () => db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES ('bg', 1, 0, 0)").run();
  for (const source of ["startup", "recovery", "memory-idle"]) {
    // the asynchronous part of a boot recovery: a slice after an await, still under the source
    const later = await ioBudget.withSource(source, async () => { await new Promise(resolve => setImmediate(resolve)); return timed(write); });
    expect(isDatabaseBusy(later.error), source).toBe(true);
    expect(later.ms, source).toBeLessThan(150);
    const bare = ioBudget.withSource(source, () => timed(() => db.exec("BEGIN IMMEDIATE")));
    expect(isDatabaseBusy(bare.error), source).toBe(true);
    expect(bare.ms, source).toBeLessThan(150);
  }
  expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: DEFAULT_BUSY_MS });
  expect(lines.some(text => text.includes("budget=none")), lines.join("\n")).toBe(false);
  // with no source and no hold the owner's autocommit write still has its full wait (unchanged)
  const owner = timed(write);
  expect(isDatabaseBusy(owner.error)).toBe(true);
  expect(owner.ms).toBeGreaterThanOrEqual(DEFAULT_BUSY_MS * 0.9);
});
