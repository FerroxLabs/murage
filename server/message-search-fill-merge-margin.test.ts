// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every step of the background search fill commits one level-0 segment; automerge is off, so the merge worker (search-merge-runner.ts) is what keeps level 0
// below crisismerge (16), whose merge a COMMIT would pay (65 to 150 ms in the step that crosses). On a quiet machine the worker kept level 0 at 14 or 15,
// one or two segments from the line; a loaded machine crossed it. The fill now asks for the merge at once when level 0 reaches 8.
//
// The first test decides nothing by timing; the negative cases at the end say which of them watch a bounded window. The worker is held (searchMergeTestHooks.halt: no op is posted, so nothing merges and level 0 grows by exactly one
// segment per step), the plain kick's wait is ten minutes, and the assertions read named states: level 0 from the independent decoder of the fixtures
// (testing/search-merge-fixtures.ts ftsLevels) and the product's own reader in the same quiet moment, then whether the scheduler started a sequence
// (a "config" event) once the step that brought level 0 to the trigger has committed. The end-to-end figures (level 0 reaching 15 without the trigger,
// 8 to 10 with it, under load) were measured on a quiet and a loaded machine and are in the ledger row; they are not asserted here, because they depend
// on how fast the worker runs.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { messageSearchFillPending, prepareMessageSearchBackfill, searchLevel0Segments, stepMessageSearchBackfill } from "./message-search-index.ts";
import { kickSearchMerge, resumeSearchMerge, searchMergeBusy, searchMergeFastPath, searchMergeTestHooks, SEARCH_MERGE_KICK_MS, type SearchMergeEvent } from "./search-merge-runner.ts";
import { writeIndexState } from "./transcript-backfill.ts";
import { mergeOpTestHooks } from "./wal-maintenance.ts";
import { ftsLevels } from "./testing/search-merge-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const defaultHooks = { replyLostMs: searchMergeTestHooks.replyLostMs, backoffFirstMs: searchMergeTestHooks.backoffFirstMs };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { searchMergeTestHooks.kickMs = SEARCH_MERGE_KICK_MS; searchMergeTestHooks.onEvent = null; searchMergeTestHooks.halt = false; searchMergeTestHooks.replyLostMs = defaultHooks.replyLostMs; searchMergeTestHooks.backoffFirstMs = defaultHooks.backoffFirstMs; mergeOpTestHooks.extra = {}; });

const until = async (what: string, ready: () => boolean) => {
  for (let i = 0; i < 3_000 && !ready(); i++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  expect(ready(), what).toBe(true);
};
const level0 = (db: ReturnType<typeof database>) => ftsLevels(db)[0]?.segments ?? 0;

it("the fill asks for the merge as soon as a step brings level 0 to 8, and not before", { timeout: 120_000 }, async () => {
  const db = database();
  // the worker has started, read its configuration and gone idle: the startup kick is spent; then it is held and the plain kick waits ten minutes
  await until("the merge worker started and went idle", () => searchMergeFastPath() && !searchMergeBusy());
  searchMergeTestHooks.halt = true;
  searchMergeTestHooks.kickMs = 600_000;
  const kinds: string[] = [];
  searchMergeTestHooks.onEvent = (event: SearchMergeEvent) => { kinds.push(event.kind); };
  db.exec("DELETE FROM messages_fts; DELETE FROM transcript_index_state WHERE name='search_fts'; DELETE FROM messages");
  // 500 rows is one step's chunk: every step commits one level-0 segment
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<12000)
    INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) SELECT i, 'big', 'm'||i, 1700000000000+i, 'bot', 'text', 'searchable line '||i, '{}' FROM n`);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  const base = level0(db);
  // steps below the trigger: the segment count is exactly what the steps committed (nothing merges), both readers agree, and no sequence starts
  let steps = 0;
  while (level0(db) < 7) {
    stepMessageSearchBackfill(db); steps++;
    expect(level0(db), "one segment per step with the worker held").toBe(base + steps);
    expect(searchLevel0Segments(db), "the product's reader agrees with the independent decoder").toBe(level0(db));
    expect(steps).toBeLessThan(20);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  expect(kinds, "no sequence started below the trigger").toEqual([]);
  // the step that brings level 0 to 8 asks for the merge at once: with the plain wait at ten minutes, only that ask can start a sequence
  searchMergeTestHooks.halt = false;
  stepMessageSearchBackfill(db);
  expect(level0(db)).toBe(8);
  expect(searchLevel0Segments(db)).toBe(8);
  await until("the trigger step started a merge sequence", () => kinds.includes("config"));
});

// Negative cases for the merge kick. Each reads a named state; the below-trigger and backoff cases also watch a bounded window (40 and 100 ms) for a wrongly early kick, which can only let a broken guard slip through on a slow worker, never fail correct code. The scheduler's own timer shows in searchMergeBusy() the moment kickSearchMerge sets it
// (synchronously, inside the step), a "soon" timer at 0 ms fires and leaves it unset again, and a plain kick's ten-minute timer stays set.
const insertRows = (db: ReturnType<typeof database>, count: number) => {
  db.exec("DELETE FROM messages_fts; DELETE FROM transcript_index_state WHERE name='search_fts'; DELETE FROM messages");
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count})
    INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) SELECT i, 'big', 'm'||i, 1700000000000+i, 'bot', 'text', 'searchable line '||i, '{}' FROM n`);
};
/** The worker is idle then held; fill steps run with it held until level 0 reaches the trigger, and the fill is marked finished; the trigger's own "soon" timer has fired into the hold and is gone. */
const heldFilledToTrigger = async (db: ReturnType<typeof database>, kinds: string[]) => {
  await until("the merge worker started and went idle", () => searchMergeFastPath() && !searchMergeBusy());
  searchMergeTestHooks.halt = true;
  searchMergeTestHooks.kickMs = 600_000;
  searchMergeTestHooks.onEvent = (event: SearchMergeEvent) => { kinds.push(event.kind); };
  insertRows(db, 12_000);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  // every step commits one segment (a step may stop early on its 25 ms budget, which only adds steps) and the worker is held, so level 0 reaches 8 after at
  // most 14 steps and never meets crisismerge (16); the fill is then marked finished, so how a loaded machine split the steps decides nothing
  for (let i = 0; i < 14 && level0(db) < 8; i++) stepMessageSearchBackfill(db);
  expect(level0(db), "level 0 is at the trigger").toBeGreaterThanOrEqual(8);
  writeIndexState(db, "search_fts", { done: 1, cursor: 12_000, skipped: 0 });
  expect(messageSearchFillPending(db), "the fill has nothing left").toBe(false);
  await until("the trigger's own timer fired into the hold", () => !searchMergeBusy());
};

it("a step with nothing left to fill asks for no merge, even when level 0 stands at the trigger", { timeout: 120_000 }, async () => {
  const db = database();
  const kinds: string[] = [];
  await heldFilledToTrigger(db, kinds);
  expect(stepMessageSearchBackfill(db)).toMatchObject({ more: false });
  expect(searchMergeBusy(), "the finished fill set no timer (no kick was asked for)").toBe(false);
  expect(kinds).toEqual([]);
});

it("no merge sequence starts while the worker is held, and the held kick is served when it is released", { timeout: 120_000 }, async () => {
  const db = database();
  const kinds: string[] = [];
  await heldFilledToTrigger(db, kinds);
  expect(kinds, "level 0 passed the trigger and nothing was posted to the held worker").toEqual([]);
  searchMergeTestHooks.halt = false;
  resumeSearchMerge();
  await until("the held kick was served on release", () => kinds.includes("config"));
});

it("steps below the trigger start no sequence: the plain ten-minute wait stands", { timeout: 120_000 }, async () => {
  const db = database();
  await until("the merge worker started and went idle", () => searchMergeFastPath() && !searchMergeBusy());
  searchMergeTestHooks.kickMs = 600_000;
  const kinds: string[] = [];
  searchMergeTestHooks.onEvent = (event: SearchMergeEvent) => { kinds.push(event.kind); };
  insertRows(db, 12_000);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  const base = level0(db);
  // the worker is live: a wrongly early kick would start a sequence within a few milliseconds and merge level 0 down, so the count would stop following the steps
  for (let steps = 1; level0(db) < 7; steps++) {
    stepMessageSearchBackfill(db);
    expect(level0(db), "one segment per step: nothing merged").toBe(base + steps);
    expect(searchMergeBusy(), "only the plain wait is armed").toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(kinds, "no sequence started").toEqual([]);
  }
});

it("a step at the trigger never shortens a backoff: only the plain wait is pulled forward", { timeout: 120_000 }, async () => {
  const db = database();
  await until("the merge worker started and went idle", () => searchMergeFastPath() && !searchMergeBusy());
  const kinds: string[] = [];
  searchMergeTestHooks.onEvent = (event: SearchMergeEvent) => { kinds.push(event.kind); };
  // a lost reply puts the scheduler into a ten-minute backoff (the timer is armed by the failure, so it is not the plain wait)
  searchMergeTestHooks.replyLostMs = 200; searchMergeTestHooks.backoffFirstMs = 600_000;
  mergeOpTestHooks.extra = { drop: true };
  kickSearchMerge();
  await until("the scheduler is in backoff", () => kinds.includes("backoff"));
  mergeOpTestHooks.extra = {};
  insertRows(db, 12_000);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  const configs = kinds.filter((k) => k === "config").length;
  for (let i = 0; i < 14 && level0(db) < 8; i++) stepMessageSearchBackfill(db);
  expect(level0(db), "the fill brought level 0 to the trigger; nothing merged (backoff)").toBeGreaterThanOrEqual(8);
  // a wrongly shortened backoff would post the config op within a few milliseconds
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  expect(kinds.filter((k) => k === "config").length, "no new sequence started during the backoff").toBe(configs);
  expect(searchMergeBusy(), "the backoff timer is still armed").toBe(true);
});
