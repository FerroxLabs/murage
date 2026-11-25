// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owners: lane q1022-bgstarve owns these witnesses and the two rate rules they pin (message-search-index.ts: the remembered retirement
// probe, the owed-only idle prune); message-search-index.ts owns the worker's replies and the prune; io-budget.ts owns the sources.
//
// 1.0.22 bgstarve, field (an idle app, the io-budget's top statements of one minute):
//   "x154 SELECT 1 FROM sqlite_schema WHERE name GLOB 'messages_fts_retired*' OR name='messages_fts' LIMIT 1"
//   "x154 DELETE FROM search_intents WHERE seq < ? AND seq IN (SELECT seq FROM search_intents WHERE seq>0 ORDER BY seq LIMIT ?)"
// and x1471 of the probe in another minute: every idle reply of the search worker ran one write statement that removed nothing and one scan
// of the schema table, on the main thread, for as long as the app was open.
//
// Real worker, real messages.db and search.db, the real reply handler (startSearchIndex's "message" listener). The only instrument is a
// counter on the connection's prepare (every statement of the handler is prepared per call).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ioBudget } from "./io-budget.ts";
import { initializeMessageTables } from "./message-tables.ts";
import * as search from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import * as wal from "./wal-maintenance.ts";

const PROBE = "SELECT 1 FROM sqlite_schema WHERE name GLOB 'messages_fts_retired*' OR name='messages_fts' LIMIT 1";
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  search.searchIndexTestHooks.event = null;
  await search.stopSearchIndex();
  await wal.stopWalMaintenance(100, 1000);
  for (const f of cleanup.splice(0).reverse()) await f();
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-search-idle-")); cleanup.push(() => removeTempDirSync(dir));
  const file = join(dir, "messages.db"), db = new DatabaseSync(file); cleanup.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL;PRAGMA journal_size_limit=0");
  initializeMessageTables(db);
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('fixture-thread',?,?,'user','text',?,'{}')");
  const append = (n: number, text: string) => { const row = insert.run(`m${n}`, n, text); search.syncMessageSearchRow(db, Number(row.lastInsertRowid), text); };
  // the statements the main connection runs, by text
  const counts = new Map<string, number>(), prepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => { counts.set(sql, (counts.get(sql) ?? 0) + 1); return prepare(sql); };
  const idle: number[] = [], events: string[] = [];
  search.searchIndexTestHooks.event = (e: { type: string; worked?: boolean; rebuilding?: boolean; applied?: number }) => {
    if (e.type !== "timer") events.push(`${e.type}:${e.worked ? "w" : "-"}:${e.rebuilding}:${e.applied}`);
    if (e.type === "stepped" && !e.worked && e.rebuilding === false) idle.push(performance.now());
  };
  const trace = () => JSON.stringify({ ready: search.messageSearchIndexReady(db), intents: search.intentCount(db), idle: idle.length, events: events.slice(-8), prunes: counts.get(search.PRUNE_SQL) ?? 0 });
  return { db, file, append, counts, idle, trace, ran: (sql: string) => counts.get(sql) ?? 0 };
}
async function until(ms: number, done: () => boolean): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end && !done()) await sleep(20);
  return done();
}

it("W-SEARCH-IDLE-RATE an idle search index costs the main thread no repeated schema probe and no empty prune: a replay of idle worker replies runs each at most once, where base ran one of each per reply", async () => {
  const f = fixture();
  for (let n = 1; n <= 20; n++) f.append(n, `fixture words number ${n} alpha beta gamma`);
  search.startSearchIndex(f.db, f.file);
  // built, applied and pruned: the index is idle and owes nothing
  expect(await until(30_000, () => search.messageSearchIndexReady(f.db) && search.intentCount(f.db) <= 1 && f.idle.length >= 2), f.trace()).toBe(true);
  await sleep(600);
  const probes0 = f.ran(PROBE), prunes0 = f.ran(search.PRUNE_SQL), replies0 = f.idle.length;
  await until(12_000, () => f.idle.length - replies0 >= 12);
  const replies = f.idle.length - replies0, probes = f.ran(PROBE) - probes0, prunes = f.ran(search.PRUNE_SQL) - prunes0;
  console.log(`[W-SEARCH-IDLE-RATE] idle replies ${replies}, schema probes ${probes}, prune statements ${prunes}`);
  // the replay is real: the worker did reply idle a dozen times in the window
  expect(replies).toBeGreaterThanOrEqual(12);
  // base: probes === replies and prunes === replies (x154 a minute in the field)
  expect({ probes: probes <= 1, prunes: prunes <= 1 }, `probes ${probes}, prunes ${prunes} in ${replies} idle replies`).toEqual({ probes: true, prunes: true });
}, 90_000);

it("W-SEARCH-PRUNE-OWED the idle batch still removes every applied intent (the prune is batched, not dropped), in few statements", async () => {
  const f = fixture();
  search.startSearchIndex(f.db, f.file);
  expect(await until(30_000, () => search.messageSearchIndexReady(f.db) && f.idle.length >= 1), f.trace()).toBe(true);
  const prunes0 = f.ran(search.PRUNE_SQL);
  // 200 appended rows: more than three full idle batches (IDLE_PRUNE_ROWS = 64)
  f.db.exec("BEGIN");
  for (let n = 1; n <= 200; n++) f.append(n, `fixture replay line ${n} delta epsilon`);
  f.db.exec("COMMIT");
  const queued = search.intentCount(f.db);
  expect(queued).toBeGreaterThanOrEqual(200);
  // the newest applied row stays (the prune removes rows strictly below the applied watermark): every other one goes
  expect(await until(45_000, () => search.intentCount(f.db) <= 1), f.trace()).toBe(true);
  const candidates = search.readMessageSearchCandidates(f.db, search.trigramQuery("epsilon"), 500);
  expect(candidates.rowids.length).toBe(200);
  // then idle again: no further prune statements
  const settled = f.ran(search.PRUNE_SQL), replies0 = f.idle.length;
  await until(8_000, () => f.idle.length - replies0 >= 8);
  expect(f.idle.length - replies0).toBeGreaterThanOrEqual(8);
  expect(f.ran(search.PRUNE_SQL) - settled).toBeLessThanOrEqual(1);
  console.log(`[W-SEARCH-PRUNE-OWED] prune statements for 200 intents: ${settled - prunes0}`);
}, 120_000);

it("W-SEARCH-PRUNE-SOURCE a commit made by a phone-delivery slice does not pay the per-commit prune; an owner commit still does", async () => {
  const f = fixture();
  search.startSearchIndex(f.db, f.file);
  expect(await until(30_000, () => search.messageSearchIndexReady(f.db) && f.idle.length >= 1), f.trace()).toBe(true);
  for (let n = 1; n <= 6; n++) f.append(n, `fixture source line ${n} zeta eta`);
  expect(await until(30_000, () => search.intentCount(f.db) <= 1), f.trace()).toBe(true);
  const before = f.ran(search.PRUNE_SQL);
  ioBudget.withSource("push-delivery", () => search.pruneMessageSearchIntents(f.db));
  const background = f.ran(search.PRUNE_SQL) - before;
  search.pruneMessageSearchIntents(f.db);
  const owner = f.ran(search.PRUNE_SQL) - before - background;
  expect({ background, owner }).toEqual({ background: 0, owner: 1 });
}, 90_000);
