// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.20 start-up write storm: a schema change resets search.db and the worker rebuilds it. An edit of an already
// indexed message during that rebuild records merge debt, and the worker's scrub then ran a negative FTS5 merge on
// every rebuild step. A rebuild commits a new segment each step, so the probe never read zero and every step
// re-merged the whole index: 17 GB of search.db + search.db-wal writes for a 55 MB owner index (4-5 GB/min for
// ~4 minutes after start). The scrub now waits for the rebuild and still runs once it is done.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { openSearchIndex, readMessageSearchCandidates, searchIndexTestHooks, startSearchIndex, stopSearchIndex, syncMessageSearchRow, trigramQuery } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const ROWS = 20_000;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  searchIndexTestHooks.event = null;
  await stopSearchIndex();
  for (const close of cleanup.splice(0).reverse()) await close();
});
// Ground truth outside the product: the OS count of bytes this process (all its threads, the worker included) passed to write calls.
const written = () => Number(/^wchar: (\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"))![1]);

it.skipIf(!existsSync("/proc/self/io"))("W-SCRUB: an edit during a full rebuild does not make every rebuild step re-merge the whole index; the scrub runs after it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-search-scrub-"));
  cleanup.push(() => removeTempDirSync(dir));
  const file = join(dir, "messages.db"), db = new DatabaseSync(file);
  cleanup.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL"); initializeMessageTables(db);
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'user','text',?,'{}')");
  db.exec("BEGIN");
  insert.run("t0", "needle", 0, "the zebrafinch report");
  for (let n = 1; n <= ROWS; n++) insert.run("t" + (n % 7), "m" + n, n, `history ${n} ${randomBytes(48).toString("hex")}`);
  db.exec("COMMIT");
  const newest = Number(db.prepare("SELECT max(rowid) AS r FROM messages").get()!.r);
  const state = () => { const index = openSearchIndex(dir); try { return Object.fromEntries(index.prepare("SELECT k,v FROM search_state WHERE k IN ('built','debt')").all().map(row => [row.k, row.v])) as { built?: string; debt?: string }; } finally { index.close(); } };
  const docs = () => { const index = openSearchIndex(dir); try { return Number(index.prepare("SELECT COUNT(*) AS n FROM docs").get()!.n); } finally { index.close(); } };

  let steps = 0, edited = false, debtWhileBuilding = false;
  const from = written();
  searchIndexTestHooks.event = event => {
    if (event.type !== "stepped") return;
    steps++;
    // The first rebuild step indexed the newest messages; the owner now edits the newest one, as on the Mac at start-up.
    if (!edited) {
      edited = true;
      db.prepare("UPDATE messages SET text=? WHERE rowid=?").run("edited newest message", newest);
      syncMessageSearchRow(db, newest, "edited newest message");
    } else if (!debtWhileBuilding) { const s = state(); if (s.built !== undefined && s.debt !== undefined) debtWhileBuilding = true; }
  };
  startSearchIndex(db, file);
  await expect.poll(() => state().built === undefined && steps > 1, { timeout: 120_000, interval: 100 }).toBe(true);
  const rebuildBytes = written() - from, indexBytes = statSync(join(dir, "search.db")).size;
  expect(debtWhileBuilding, "the edit recorded merge debt while the rebuild was still running (the storm's precondition)").toBe(true);
  expect(steps, "a rebuild of many steps (one segment per step)").toBeGreaterThan(40);
  // The rebuild itself costs about 10x the index (FTS5 inserts, secure_delete, WAL + checkpoint). A merge per step costs
  // O(index) each step: about 50x here and 300x on the owner index. The bound sits between them.
  expect(rebuildBytes, `rebuild wrote ${rebuildBytes} B for a ${indexBytes} B index over ${steps} steps`).toBeLessThan(25 * indexBytes);
  // No loss of function: the debt is still scrubbed once the rebuild is done, every message is indexed, the edit is searchable.
  await expect.poll(() => state().debt, { timeout: 30_000, interval: 100 }).toBeUndefined();
  expect(docs()).toBe(ROWS + 1);
  await expect.poll(() => readMessageSearchCandidates(db, trigramQuery("zebrafinch"), 10).rowids.length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => readMessageSearchCandidates(db, trigramQuery("edited newest"), 10).rowids, { timeout: 10_000 }).toEqual([newest]);
}, 180_000);
