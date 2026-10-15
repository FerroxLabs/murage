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

it("a wait during the process's own writer hold names the hold as its holder", () => {
  database();
  holdWriteLock();
  holdWritersForIndexBuild(true);
  timed(() => transaction(() => 1, { op: "owner" }));
  expect(lines.find(text => text.includes("budget=none"))).toMatch(/holder=writer-hold /);
  lines.length = 0;
  timed(() => ioBudget.withSource("memory-idle", () => transaction(() => 1, { op: "idle-receipt" })));
  expect(lines.find(text => text.startsWith("[sqlite] busy op=idle-receipt"))).toMatch(/holder=writer-hold/);
  expect(lines.some(text => text.includes("budget=none"))).toBe(false);
});
