// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { IoBudget, ioBudget } from "./io-budget.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { messageSearchIndexReady, openSearchIndex, startSearchIndex, stopSearchIndex, syncMessageSearchRow } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const MB = 1024 * 1024;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers(); ioBudget.stop();
  await stopSearchIndex();
  for (const close of cleanup.splice(0).reverse()) await close();
});
it("a requested search projection proceeds without forgiving unrelated periodic debt", () => {
  const budget = new IoBudget({ read: () => ({ at: Date.now(), fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => true, systemOverloaded: () => null });
  budget.start(); cleanup.push(() => budget.stop());
  budget.noteBytes("memory-idle", 100 * MB);
  expect(budget.deferredForMs("search-index", { requested: true })).toBe(0);
  expect(budget.shouldDefer("search-index")).toBe(true);
  expect(budget.shouldDefer("memory-upgrade")).toBe(true);
});
it("requested search still respects its own measured writing backoff", () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const budget = new IoBudget({ read: () => ({ at: Date.now(), fsWriteBlocks: 0, cpuMicros: 0 }), isIdle: () => true, systemOverloaded: () => null, log: () => {} });
  budget.start(); cleanup.push(() => budget.stop());
  budget.noteBytes("search-index", 2 * MB); vi.advanceTimersByTime(60_000);
  expect(budget.deferredForMs("search-index", { requested: true })).toBeGreaterThan(0);
});
async function projection(count: number, reset = false) {
  const dir = mkdtempSync(join(tmpdir(), "murage-requested-search-"));
  cleanup.push(() => removeTempDirSync(dir));
  const file = join(dir, "messages.db"), db = new DatabaseSync(file);
  cleanup.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0"); initializeMessageTables(db);
  startSearchIndex(db, file);
  await expect.poll(() => messageSearchIndexReady(db), { timeout: 5000 }).toBe(true);
  const readIndex = (read: (index: DatabaseSync) => number) => { const index = openSearchIndex(dir); try { return read(index); } finally { index.close(); } };
  await expect.poll(() => readIndex(index => Number(index.prepare("SELECT EXISTS(SELECT 1 FROM search_state WHERE k='built') AS n").get()!.n)), { timeout: 5000 }).toBe(0);
  ioBudget.start(); ioBudget.noteBytes("memory-idle", 100 * MB);
  if (reset) db.prepare("UPDATE transcript_index_state SET done='reset-under-debt' WHERE name='search_owner'").run();
  db.exec("BEGIN IMMEDIATE");
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('fresh',?,1,'user','text',?,'{}')");
  for (let n = 0; n < count; n++) {
    const row = insert.run("m" + n, "requested pelican " + n);
    syncMessageSearchRow(db, Number(row.lastInsertRowid), "requested pelican " + n);
  }
  db.exec("COMMIT");
  const target = Number(db.prepare("SELECT MAX(seq) AS n FROM search_intents").get()!.n);
  await expect.poll(() => readIndex(index => Number(index.prepare("SELECT v FROM search_state WHERE k='applied_seq'").get()?.v ?? 0)), { timeout: 5000 }).toBeGreaterThanOrEqual(target);
  await expect.poll(() => readIndex(index => Number(index.prepare("SELECT COUNT(*) AS n FROM docs").get()!.n)), { timeout: 5000 }).toBe(count);
  expect(ioBudget.shouldDefer("search-index")).toBe(true);
}
it.each([1, 1050])("new message intents drain through their sequence under unrelated debt (%i messages)", count => projection(count));
it("requested projection finishes its required reset and bounded rebuild before returning to idle debt", () => projection(1050, true));
