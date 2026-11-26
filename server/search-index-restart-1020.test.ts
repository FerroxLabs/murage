// SPDX-License-Identifier: AGPL-3.0-or-later
// W-SEARCH-RESTART (1.0.20): a normal start must not reset the message search index.
// Owners: search index source stamp (server/search-index-worker.ts valid/anchors) and this witness: searchreset-1020-n1b.
// Start-up migrations drop and remake triggers/indexes with no net change, which moves
// messages.db's schema cookie on every start (owner copy: 2142 -> 2150 in one start).
// The worker used to treat any moved cookie as a new source and rebuilt the whole
// index from zero on every start. Real worker, real messages.db, real restart.
import { removeTempDirSync } from "./testing/cleanup.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import * as search from "./testing/search-index-compat.ts";
import { initializeMessageTables } from "./message-tables.ts";

const cleanup: Array<() => unknown> = [];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out: " + what); await pause(10); }
}
afterEach(async () => { await search.stopSearchIndex(); search.searchIndexTestHooks.event = null; for (const f of cleanup.splice(0).reverse()) await f(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-search-restart-")); cleanup.push(() => removeTempDirSync(dir));
  const file = join(dir, "messages.db"), db = new DatabaseSync(file); cleanup.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL"); initializeMessageTables(db);
  db.exec("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 't'||(x%5),CAST(x AS TEXT),x,'user','text','canary restart','{}' FROM n");
  return { dir, file, db };
}
const cookie = (db: DatabaseSync) => Number(db.prepare("PRAGMA schema_version").get()!.schema_version);
function indexState(dir: string): Record<string, string> {
  const s = search.openSearchIndex(dir);
  try { return Object.fromEntries((s.prepare("SELECT k,v FROM search_state").all() as Array<{ k: string; v: string }>).map(r => [r.k, r.v])); } finally { s.close(); }
}
const hits = (db: DatabaseSync) => search.readMessageSearchCandidates(db, search.trigramQuery("canary"), 400);
/** One start of the search index; counts resets and adoptions until the reader is ready. */
async function start(db: DatabaseSync, file: string) {
  const seen = { resets: 0, adopted: 0, ready: 0 };
  search.searchIndexTestHooks.event = e => { if (e.type === "reset-ack") seen.resets++; if (e.type === "source-adopted") seen.adopted++; if (e.type === "ready") seen.ready++; };
  search.startSearchIndex(db, file);
  await until(() => seen.ready > 0 && search.messageSearchIndexReady(db), "search ready");
  return seen;
}
/** What every start does to messages.db: drop and remake triggers, no net schema change. */
function startMigration(db: DatabaseSync) {
  for (let i = 0; i < 4; i++) {
    db.exec("DROP TRIGGER IF EXISTS fixture_start_trigger");
    db.exec("CREATE TRIGGER fixture_start_trigger AFTER UPDATE OF at ON messages BEGIN SELECT 1; END");
  }
}

it("W-SEARCH-RESTART: a start that only moves the schema cookie keeps the built index and searches at once", { timeout: 30000 }, async () => {
  const { dir, file, db } = fixture();
  const first = await start(db, file);
  expect(first.resets, "first start builds the index").toBe(1);
  await until(() => { const r = hits(db); return r.rowids.length === 300 && !r.partial; }, "first build complete");
  const built = indexState(dir);
  expect(built.built, "rebuild finished").toBeUndefined();
  await search.stopSearchIndex();

  const before = cookie(db);
  startMigration(db);
  expect(cookie(db), "the start migration moves the cookie").toBeGreaterThan(before);

  const second = await start(db, file);
  // Search works the moment the reader is ready: complete, not partial, no rebuild.
  const now = hits(db);
  expect({ resets: second.resets, adopted: second.adopted, n: now.rowids.length, partial: now.partial }).toEqual({ resets: 0, adopted: 1, n: 300, partial: false });
  const kept = indexState(dir);
  expect(kept.index_id, "same index, not rebuilt").toBe(built.index_id);
  expect(kept.built, "no rebuild cursor").toBeUndefined();
  expect(kept.source_schema).toBe(String(cookie(db)));
  await search.stopSearchIndex();

  // A third start with nothing moved adopts nothing and resets nothing.
  const third = await start(db, file);
  expect({ resets: third.resets, adopted: third.adopted, n: hits(db).rowids.length }).toEqual({ resets: 0, adopted: 0, n: 300 });
  expect(indexState(dir).index_id).toBe(built.index_id);
});

it("W-SEARCH-RESTART-GUARD: a moved cookie whose rowids name other messages still resets and rebuilds", { timeout: 30000 }, async () => {
  const { dir, file, db } = fixture();
  await start(db, file);
  await until(() => { const r = hits(db); return r.rowids.length === 300 && !r.partial; }, "first build complete");
  const built = indexState(dir);
  await search.stopSearchIndex();
  // A renumbering rewrite: rowids 1 and 300 (both anchored) now name each other's message.
  db.exec("UPDATE messages SET rowid=-1 WHERE rowid=1; UPDATE messages SET rowid=1 WHERE rowid=300; UPDATE messages SET rowid=300 WHERE rowid=-1");
  startMigration(db);
  const second = await start(db, file);
  expect({ resets: second.resets, adopted: second.adopted }).toEqual({ resets: 1, adopted: 0 });
  expect(indexState(dir).index_id, "a new index").not.toBe(built.index_id);
  await until(() => { const r = hits(db); return r.rowids.length === 300 && !r.partial; }, "rebuild complete");
});

it("W-SEARCH-RESTART-LEGACY: an index stamped before anchors existed resets once on a moved cookie, then keeps", { timeout: 30000 }, async () => {
  const { dir, file, db } = fixture();
  await start(db, file);
  await until(() => { const r = hits(db); return r.rowids.length === 300 && !r.partial; }, "first build complete");
  await search.stopSearchIndex();
  const w = new DatabaseSync(join(dir, "search.db")); w.exec("DELETE FROM search_state WHERE k='source_anchors'"); w.close();
  startMigration(db);
  expect((await start(db, file)).resets, "no anchors: fail closed").toBe(1);
  await until(() => { const r = hits(db); return r.rowids.length === 300 && !r.partial; }, "rebuild complete");
  await search.stopSearchIndex();
  startMigration(db);
  expect((await start(db, file)).resets, "anchored now: kept").toBe(0);
});
