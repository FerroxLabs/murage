// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: session-proof (collectSessionChecksSlice, the dependent proof reclamation); consumer owner: cause18-idleperf.
// 1.0.21 owner copy, 9.5 h overnight with no turn: 60,916 `SELECT 1 FROM memory_session_checks ...` probes a minute (max 123,498): the
// upkeep's session slice re-read the same ~54 live dependent rows on every tick, whether or not anything had been written. These witnesses
// call the real slice at the base tick rate on a real store: a quiet minute probes one lap, a write or an expiry is still reclaimed at once.
//
// PORT (r8-upkeep-port). cause18's lap memo (one PROBE_SQL liveness probe per dependent row, re-read once a lap) was replaced by memv2 lane H's
// collector (session-proof-schema.ts sessionCollector / orphanWindow: one primary-key seek into the checks per distinct SESSION of a
// dependent table, orphanQuerySql) under:
//   MAIN-PICK 2026-11-23T00:35:11Z memv2-I = memv2-I-tests 70af151c66
//   MAIN-RULING 2026-11-23T03:41:32Z gate-1021-swarm ... merges memv2-I 70af151c66
// The counted unit stays "liveness probes into memory_session_checks": the legacy per-row PROBE_SQL gets plus the per-session seeks of the
// orphan query (one per row it returns). One lap is now one seek per distinct session of each dependent table (2 + 2 = 4, where the per-row
// lap was 108); the bar keeps its shape: at most two laps and at least one in a quiet minute of 1,200 slices. Every other row is unchanged:
// the slice is still the production function the upkeep's session rider calls, at the base tick rate.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { RECALL_UPKEEP_TOPIC } from './recall-view-schema.ts';
import { startRecallViewMaintenance, stopRecallViewMaintenance } from './recall-view.ts';
import { collectSessionChecksSlice, orphanQuerySql } from './session-proof-schema.ts';
import { raise, wakeStats } from './wake.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { stopRecallViewMaintenance(); vi.restoreAllMocks(); vi.useRealTimers(); closeDatabase(); });

const PROBE_SQL = 'SELECT 1 FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT 1';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_790_000_000_000;

/** Two live sessions with 27 cites and 27 cited messages each (54 dependent rows per table pair, the owner copy's ~54 a tick). */
function liveSessions(db: DatabaseSync, checked = T0): void {
  for (const session of ['s1', 's2']) {
    db.prepare('INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES(?,?,?,1,1)').run('thread', 'driver', session);
    db.prepare(`INSERT INTO memory_session_checks(thread_id,driver_instance,native_session,reader_key,up_to,log_seq,recall_epoch,policy_revision,deletion_epoch,footprint,cites,seeding,checked)
      VALUES(?,?,?,'reader',0,0,0,0,0,'{}',0,0,?)`).run('thread', 'driver', session, checked);
    for (let n = 0; n < 27; n++) {
      db.prepare("INSERT INTO memory_session_check_cites VALUES(?,?,?,'record',?,1,'bundle')").run('thread', 'driver', session, `record-${n}`);
      db.prepare('INSERT INTO memory_session_check_messages VALUES(?,?,?,?,?)').run('thread', 'driver', session, 'thread', `message-${n}`);
    }
  }
}
/** Counts the liveness probes the slice runs: a legacy PROBE_SQL get (one per dependent row it reads) and a seek of the orphan query (one
 *  per distinct session it returns, each a primary-key probe into memory_session_checks). */
const ORPHAN_SQL = new Set([orphanQuerySql('memory_session_check_cites'), orphanQuerySql('memory_session_check_messages')]);
function probes(db: DatabaseSync): { n: number } {
  const count = { n: 0 }, prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql !== PROBE_SQL && !ORPHAN_SQL.has(sql)) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'get' && sql === PROBE_SQL) return (...args: unknown[]) => { count.n++; return (value as (...a: unknown[]) => unknown).apply(target, args); };
      if (key === 'all' && ORPHAN_SQL.has(sql)) return (...args: unknown[]) => { const found = (value as (...a: unknown[]) => unknown[]).apply(target, args); count.n += found.length; return found; };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  return count;
}
/** One lap of liveness probes: one per distinct session of each dependent table. */
const lap = (db: DatabaseSync) => ['memory_session_check_cites', 'memory_session_check_messages']
  .reduce((n, table) => n + Number(db.prepare(`SELECT count(*) AS n FROM (SELECT DISTINCT thread_id,driver_instance,native_session FROM ${table})`).get()!.n), 0);
const rows = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

it('W-SESSION a quiet minute at the base tick rate (1,200 slices) probes one lap of the dependent rows, not 54 every slice', () => {
  const db = database();
  liveSessions(db);
  const one = lap(db);
  expect(one).toBe(4);
  const count = probes(db);
  for (let slice = 0; slice < 1_200; slice++) collectSessionChecksSlice(db, T0 + slice * 50);
  // base c3f339db41: 1,200 x 108 = 129,600 probes (the owner copy's max minute was 123,498). One lap probes each session once (4 here).
  expect(count.n).toBeLessThanOrEqual(2 * one);
  expect(count.n).toBeGreaterThanOrEqual(one);
  expect(rows(db, 'memory_session_check_cites')).toBe(54);
  expect(rows(db, 'memory_session_check_messages')).toBe(54);
});

it('W-SESSION-WRITE an orphan written after the quiet lap is reclaimed by the next slice', () => {
  const db = database();
  liveSessions(db);
  for (let slice = 0; slice < 100; slice++) collectSessionChecksSlice(db, T0 + slice * 50);
  db.prepare("INSERT INTO memory_session_check_cites VALUES('thread','driver','gone','record','orphan',1,'bundle')").run();
  db.prepare("INSERT INTO memory_session_check_messages VALUES('thread','driver','gone','thread','orphan')").run();
  collectSessionChecksSlice(db, T0 + 101 * 50);
  expect(db.prepare("SELECT 1 FROM memory_session_check_cites WHERE native_session='gone'").get()).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM memory_session_check_messages WHERE native_session='gone'").get()).toBeUndefined();
  expect(rows(db, 'memory_session_check_cites')).toBe(54);
});

it('W-SESSION-FOREIGN a check deleted by another connection is seen (data_version) and its proof rows reclaimed', () => {
  const db = database();
  liveSessions(db);
  for (let slice = 0; slice < 100; slice++) collectSessionChecksSlice(db, T0 + slice * 50);
  const other = new DatabaseSync(`${DATA_DIR}/messages.db`);
  try { other.exec("DELETE FROM memory_session_checks WHERE native_session='s2'"); } finally { other.close(); }
  for (let slice = 0; slice < 3; slice++) collectSessionChecksSlice(db, T0 + (101 + slice) * 50);
  expect(rows(db, 'memory_session_check_cites')).toBe(27);
  expect(rows(db, 'memory_session_check_messages')).toBe(27);
});

it('W-SESSION-EXPIRY a resting slice still expires a checkpoint once it is 30 days old', () => {
  const db = database();
  liveSessions(db);
  for (let slice = 0; slice < 100; slice++) collectSessionChecksSlice(db, T0 + slice * 50);
  expect(collectSessionChecksSlice(db, T0 + 29 * DAY)).toBe(0);
  expect(collectSessionChecksSlice(db, T0 + 31 * DAY)).toBe(2);
  expect(rows(db, 'memory_session_checks')).toBe(0);
});

// Opus self-review M1: walks longer than one page (128 rows) and of different lengths. A write that orphans rows BEHIND a walk's cursor and
// changes how long the walks are still has those rows reclaimed before the slice rests again.
it('W-SESSION-LONG an orphan behind a long walk\'s cursor is reclaimed before the slice rests again', () => {
  const db = database();
  for (const session of ['a-first', 'm-middle', 'z-last']) {
    db.prepare('INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES(?,?,?,1,1)').run('thread', 'driver', session);
    db.prepare(`INSERT INTO memory_session_checks(thread_id,driver_instance,native_session,reader_key,up_to,log_seq,recall_epoch,policy_revision,deletion_epoch,footprint,cites,seeding,checked)
      VALUES(?,?,?,'reader',0,0,0,0,0,'{}',0,0,?)`).run('thread', 'driver', session, T0);
  }
  const cite = db.prepare("INSERT INTO memory_session_check_cites VALUES('thread','driver',?,'record',?,1,'bundle')");
  const message = db.prepare("INSERT INTO memory_session_check_messages VALUES('thread','driver',?,'thread',?)");
  for (let n = 0; n < 100; n++) { cite.run('a-first', `r${n}`); cite.run('z-last', `r${n}`); message.run('a-first', `m${n}`); message.run('m-middle', `m${n}`); message.run('z-last', `m${n}`); }
  let slice = 0;
  const run = (count: number) => { for (let n = 0; n < count; n++) collectSessionChecksSlice(db, T0 + (slice++) * 50); };
  run(37); // part-way through: the cites walk (200 rows) and the messages walk (300 rows) sit at different offsets
  db.prepare("DELETE FROM memory_session_checks WHERE native_session='a-first'").run();
  for (let n = 100; n < 400; n++) cite.run('m-middle', `r${n}`);
  run(40);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_session_check_cites WHERE native_session='a-first'").get()!.n)).toBe(0);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_session_check_messages WHERE native_session='a-first'").get()!.n)).toBe(0);
  expect(rows(db, 'memory_session_check_cites')).toBe(400);
});

// ASTRA + OPUS spec-cand-1021 b2343335b6 (High, F4): the foreign-commit look must be reached on the PRODUCTION path, the upkeep's session
// rider (recall-view.ts sessionRiders) started by startRecallViewMaintenance on the real wake bus, not by calling the slice by hand. Fake
// timers as recall-upkeep-idle-1021 (the bus's deadlines are setTimeout on Date.now; its pump, setImmediate, stays real and is drained).
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
async function drain(): Promise<void> { for (let n = 0; n < 400; n++) { await immediate(); if (wakeStats().owed === 0) { await immediate(); if (wakeStats().owed === 0) return; } } }
async function run(ms: number): Promise<void> { for (let t = 0; t < ms; t += 10) { vi.advanceTimersByTime(10); await drain(); } }
/** A store whose collector has finished its orphan cycle (the cache `done`) under the running upkeep, with nothing written since. */
async function restingUpkeep(): Promise<DatabaseSync> {
  const db = database();
  await stopWalMaintenance(); await stopSearchIndex();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  liveSessions(db, Date.now());
  startRecallViewMaintenance();
  // 5 s settle: the lineage lap and the first orphan cycle. Not asserted here: on b2343335b6 the upkeep leaves that cycle open at its second
  // table with nothing armed (no figure moves), which is the defect itself; each row asserts the outcome, the reclaimed rows.
  await run(5_000);
  return db;
}
const foreignDelete = () => { const other = new DatabaseSync(`${DATA_DIR}/messages.db`); try { other.exec("DELETE FROM memory_session_checks WHERE native_session='s2'"); } finally { other.close(); } };

it('W-SESSION-FOREIGN-IDLE a check deleted by another connection while nothing local happens is reclaimed by the upkeep within the 30 s foreign look', async () => {
  const db = await restingUpkeep();
  foreignDelete();
  const runs0 = wakeStats().runs;
  await run(31_000);
  // base b2343335b6: the resting upkeep is armed only for the 30-day expiry, so nothing looks at the foreign commit: 54 rows stay
  expect(rows(db, 'memory_session_check_cites')).toBe(27);
  expect(rows(db, 'memory_session_check_messages')).toBe(27);
  // and the look is the 30 s one, not a pace: a few bus slices in 31 s, not 620
  expect(wakeStats().runs - runs0).toBeLessThanOrEqual(8);
}, 240_000);

it('W-SESSION-FOREIGN-WAKE an upkeep wake after another connection\'s commit sees it (commit sign moved) and reclaims at once, not 30 s later', async () => {
  const db = await restingUpkeep();
  foreignDelete();
  raise(RECALL_UPKEEP_TOPIC);
  await run(200);
  // base 74de3ec3f9 (no commitMoved rider cause): the wake finds no figure moved and nothing due, so the orphans wait for the 30 s look
  expect(rows(db, 'memory_session_check_cites')).toBe(27);
  expect(rows(db, 'memory_session_check_messages')).toBe(27);
}, 240_000);

it('W-SESSION-FOREIGN-AGAIN after a foreign commit reopens the orphan cycle, the upkeep finishes it and keeps looking: a later foreign delete is still reclaimed with no local wake', async () => {
  const db = await restingUpkeep();
  // a foreign commit that deletes nothing: the 30 s look clears the cache and the cycle it reopens must reach done again by itself
  const other = new DatabaseSync(`${DATA_DIR}/messages.db`);
  try { other.exec("INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES('thread','driver','s3',1,1)"); } finally { other.close(); }
  await run(31_000);
  foreignDelete();
  await run(31_000);
  // self-review H1 (0fcaf286fc): the reopened cycle stalled at its second table with nothing armed, so this delete waited for a local wake
  expect(rows(db, 'memory_session_check_cites')).toBe(27);
  expect(rows(db, 'memory_session_check_messages')).toBe(27);
  const again = new DatabaseSync(`${DATA_DIR}/messages.db`);
  try { again.exec("DELETE FROM memory_session_checks WHERE native_session='s1'"); } finally { again.close(); }
  await run(31_000);
  expect(rows(db, 'memory_session_check_cites')).toBe(0);
  expect(rows(db, 'memory_session_check_messages')).toBe(0);
}, 240_000);
