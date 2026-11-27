// SPDX-License-Identifier: AGPL-3.0-or-later
// W-SEARCH-STARTCHECK (1.0.22 q1022-startup item 2): PRAGMA quick_check and the FTS5 integrity-check read the whole of search.db. They
// run only when the last worker did not stop cleanly or the last full check is a week old, never on every clean start.
// Owners: search.db start check (server/search-index-worker.ts activate/checkDue/stopClean) and this witness: q1022-startup-opus.
// Real worker, real messages.db, real stop and start (startSearchIndex / stopSearchIndex). Whether the full check ran is read from its
// only observable effect: a fault planted between the two starts that quick_check alone finds (a row that breaks its table's CHECK constraint) resets the
// index when the check runs, and is left alone when it does not.
import { removeTempDirSync } from "./testing/cleanup.ts";
import { closeSync, mkdtempSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import * as search from "./testing/search-index-compat.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { settleTestHandles } from "./test-handle-registry.ts";

const cleanup: Array<() => unknown> = [];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 15000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out: " + what); await pause(10); }
}
afterEach(async () => { await search.stopSearchIndex(); search.searchIndexTestHooks.event = null; for (const f of cleanup.splice(0).reverse()) await f(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-search-startcheck-")); cleanup.push(() => removeTempDirSync(dir));
  const file = join(dir, "messages.db"), db = new DatabaseSync(file); cleanup.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL"); initializeMessageTables(db);
  db.exec("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 't'||(x%5),CAST(x AS TEXT),x,'user','text','canary startcheck','{}' FROM n");
  return { dir, file, db };
}
/** One start; counts resets (reset-ack) until the reader is ready. */
async function start(db: DatabaseSync, file: string) {
  const seen = { resets: 0, ready: 0 };
  search.searchIndexTestHooks.event = e => { if (e.type === "reset-ack") seen.resets++; if (e.type === "ready") seen.ready++; };
  search.startSearchIndex(db, file);
  await until(() => seen.ready > 0 && search.messageSearchIndexReady(db), "search ready");
  return seen;
}
/** A fault only the full check finds: a table the worker never reads gets a broken root page (an invalid b-tree page type). Every
 * read the worker makes on a clean start leaves it alone; quick_check walks every b-tree and reports it. */
function plantQuickCheckFault(dir: string) {
  const path = join(dir, "search.db");
  const s = new DatabaseSync(path);
  let root = 0, size = 0;
  try {
    s.exec("CREATE TABLE fixture_probe(v TEXT); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<60) INSERT INTO fixture_probe SELECT hex(randomblob(200)) FROM n");
    root = Number(s.prepare("SELECT rootpage FROM sqlite_schema WHERE name='fixture_probe'").get()!.rootpage);
    size = Number(s.prepare("PRAGMA page_size").get()!.page_size);
    expect(Number(s.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!.busy), "search.db has no other connection while the fault is planted").toBe(0);
    expect(s.prepare("PRAGMA quick_check").get()!.quick_check, "no fault before planting").toBe("ok");
  } finally { s.close(); }
  expect(root, "probe table root page").toBeGreaterThan(1);
  const fd = openSync(path, "r+");
  try { writeSync(fd, Buffer.from([0x00]), 0, 1, (root - 1) * size); } finally { closeSync(fd); }
  const c = new DatabaseSync(path, { readOnly: true });
  try { expect(c.prepare("PRAGMA quick_check").get()!.quick_check, "planted fault is visible to quick_check").not.toBe("ok"); } finally { c.close(); }
}
function setState(dir: string, k: string, v: string) {
  const s = new DatabaseSync(join(dir, "search.db"));
  try { s.prepare("INSERT OR REPLACE INTO search_state(k,v) VALUES(?,?)").run(k, v); } finally { s.close(); }
}
async function built(db: DatabaseSync, file: string) {
  const first = await start(db, file);
  expect(first.resets, "first start builds the index").toBe(1);
  await until(() => { const r = search.readMessageSearchCandidates(db, search.trigramQuery("canary"), 400); return r.rowids.length === 200 && !r.partial; }, "first build complete");
}

it("W-SEARCH-STARTCHECK clean: after a clean stop, the next start does not run the full check", { timeout: 60000 }, async () => {
  const { dir, file, db } = fixture();
  await built(db, file);
  await search.stopSearchIndex();
  // a second clean start (the first one after the build) stamps nothing new; the check after a reset/build was already recorded
  const second = await start(db, file);
  expect(second.resets).toBe(0);
  await search.stopSearchIndex();
  plantQuickCheckFault(dir);
  const third = await start(db, file);
  expect(third.resets, "a clean start runs no quick_check, so the planted fault is not found").toBe(0);
});

it("W-SEARCH-STARTCHECK unclean: after a worker that ended without stopping, the next start runs the full check", { timeout: 60000 }, async () => {
  const { dir, file, db } = fixture();
  await built(db, file);
  await search.stopSearchIndex();
  await start(db, file);
  // the worker is terminated without its stop message: a crash as far as search.db can tell
  await settleTestHandles(dir);
  plantQuickCheckFault(dir);
  const next = await start(db, file);
  expect(next.resets, "an unclean stop is followed by the full check, which finds the fault and resets").toBe(1);
});

it("W-SEARCH-STARTCHECK weekly: a clean stop whose last full check is over a week old runs the full check", { timeout: 60000 }, async () => {
  const { dir, file, db } = fixture();
  await built(db, file);
  await search.stopSearchIndex();
  await start(db, file);
  await search.stopSearchIndex();
  setState(dir, "checked_at", String(Date.now() - 8 * 24 * 60 * 60 * 1000));
  plantQuickCheckFault(dir);
  const next = await start(db, file);
  expect(next.resets, "a week-old check is due again").toBe(1);
});

it("W-SEARCH-STARTCHECK older-build: a clean mark left behind by a build that indexed and crashed (rollback to 1.0.21) does not skip the full check", { timeout: 60000 }, async () => {
  const { dir, file, db } = fixture();
  await built(db, file);
  await search.stopSearchIndex();
  const peek = new DatabaseSync(join(dir, "search.db"), { readOnly: true });
  const left = String((peek.prepare("SELECT v FROM search_state WHERE k='clean_close'").get() as { v: string } | undefined)?.v ?? "");
  peek.close();
  expect(left, "the clean stop wrote its mark").not.toBe("");
  // the older build's run: it indexes a new message, never clears the mark (it has none), and ends without stopping
  await start(db, file);
  const row = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t9','older',999,'user','text','canary older','{}')").run();
  search.syncMessageSearchRow(db, Number(row.lastInsertRowid), "canary older");
  const appliedSeq = () => { const s = new DatabaseSync(join(dir, "search.db"), { readOnly: true }); try { return String((s.prepare("SELECT v FROM search_state WHERE k='applied_seq'").get() as { v: string } | undefined)?.v); } finally { s.close(); } };
  const before = appliedSeq();
  await until(() => appliedSeq() !== before, "older build applied its row to search.db");
  await settleTestHandles(dir);
  setState(dir, "clean_close", left);
  plantQuickCheckFault(dir);
  const next = await start(db, file);
  expect(next.resets, "a mark from before the older build's run does not count as a clean stop").toBe(1);
});
