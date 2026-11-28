// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 q1022-sqlite (HIDDEN-COST item 6; owner: q1022-sqlite-opus): message-db.ts runs the search-intent prune (PRUNE_SQL) on every
// message write. Real messages.db, real search worker, the store's own insertMessage (message-db.ts). The only instrument is a counter on the
// connection's prepare. W6: once the worker's applied rows are pruned, a run of writes the worker has not acknowledged yet pays no prune
// statement (base: one per write); after the worker acknowledges them, the owed prune still removes them.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { ioBudget } from "./io-budget.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { insertMessage } from "./message-db.ts";
import * as search from "./message-search-index.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(ms: number, done: () => boolean) { const end = performance.now() + ms; while (performance.now() < end && !done()) await sleep(20); return done(); }
async function cleanSlate() { closeDatabase(); await search.stopSearchIndex(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
beforeEach(cleanSlate);
afterEach(async () => { ioBudget.stop(); await cleanSlate(); });

it("W6 prune owed: writes the worker has not acknowledged pay no prune statement; acknowledged rows are still pruned", async () => {
  const db = database();
  const counts = new Map<string, number>(), prepare = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => { counts.set(sql, (counts.get(sql) ?? 0) + 1); return prepare(sql); };
  const prunes = () => counts.get(search.PRUNE_SQL) ?? 0;
  const thread = randomUUID();
  const write = (n: number) => transaction(() => insertMessage(thread, { id: randomUUID(), at: n, role: "user", kind: "text", text: `fixture line ${n} alpha beta` }));
  expect(await until(30_000, () => search.messageSearchIndexReady(db)), "search index ready").toBe(true);
  write(0);
  // settled = the worker acknowledged the write, read from its own committed watermark: no prune is needed to see it, so a mutant that
  // never prunes still reaches the assertions below (the earlier settle waited for the prune itself)
  const acknowledged = () => { const index = search.openSearchIndex(DATA_DIR); try { return Number(index.prepare("SELECT v FROM search_state WHERE k='applied_seq'").get()?.v ?? -1); } finally { index.close(); } };
  const newest = () => Number(db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM search_intents").get()!.seq);
  expect(await until(30_000, () => acknowledged() >= newest()), "settled: the worker acknowledged the first write").toBe(true);
  // the first writes after the acknowledgement pay the prune that is owed (a full batch of PRUNE_PER_COMMIT owes one more); bounded, so
  // base (one per write) still reaches the measured run below
  for (let n = 100; n < 110; n++) { const paidBefore = prunes(); write(n); if (prunes() === paidBefore) break; }
  const before = prunes();
  for (let n = 1; n <= 20; n++) write(n); // one synchronous run: no worker acknowledgement can arrive between these writes
  const paid = prunes() - before;
  console.log(`SQLITE-MEASURE W6 prune-statements-for-20-unacknowledged-writes=${paid}`);
  expect(paid, "W6: nothing applied past the last prune, so no write pays a prune statement").toBe(0);
  expect(search.intentCount(db), "the writes left their intents").toBeGreaterThanOrEqual(20);
  expect(await until(30_000, () => search.intentCount(db) <= 1), `W6: acknowledged intents are still pruned (${search.intentCount(db)} left)`).toBe(true);
}, 120_000);
