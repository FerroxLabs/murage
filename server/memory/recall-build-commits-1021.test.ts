// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope (recall view build, recall-view.ts) and provenance-stamp (the identity reading every transaction takes);
// consumer owner: cause18e-overbudget (PERF-SPEC 0edba926a6, the perf harness's `0 over-budget lines` bar).
// PERF-SPEC 2026-11-22T05:02Z on 0edba926a6: the minute the recall views were first built printed `source: recall-build ... top statements:
// exec: COMMIT x9722` at 10 threads and `x22500` at 1000, and `SELECT ... (SELECT data_version FROM pragma_data_version)` once per COMMIT.
// Cause: every build slice was its own BEGIN IMMEDIATE ... COMMIT, and the membership oracle is thousands of pure-read steps (one per
// roster item), so one build took the write lock 47 times at 10 threads and 113 at 1000 (measured), nearly always to write nothing.
// These witnesses run the real build (prepareRecallContext, the path the queue runs) on the real database and count the COMMITs the
// transaction wrapper executes:
//   W-COMMIT-BOUND   a build commits at most 4 + new scopes + floor(rows/256) + floor(scopes/256) times, whatever the roster size
//   W-ROSTER-FREE    the same view over a 10-thread and a 1000-thread roster commits the same number of times
//   W-PRAGMA-ONLY    no statement of a build or of an upkeep page reads data_version through the table-valued form
//   W-SHADOW         a table named pragma_data_version cannot freeze the identity memo: a foreign commit still makes it stale
//   W-STEADY         a rebuild of a context that already has a view is small and is never charged to the one-time seed source
//   W-STEADY-WINDOW  five steady minutes at 1000 threads (the perf rig's four owner sends a minute, one roster save in the window): the
//                    recall-build bytes of EVERY minute, judged by the watchdog's own idle-minute verdict, stay within 1 MB/min, and
//                    the write transactions committed on the connection in ANY minute, the rebuild's minute included, stay within
//                    the perf bar's churn allowance (PERF-BAR cause18: BEGIN/min <= 3 x change rows + 25). The bytes of a rebuild
//                    are the same on 0edba926a6 (3.2 MB, measured); what that head did in the rebuild's minute was take the write
//                    lock once per oracle slice, and that is the part of this window that is RED there.
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { setExecutionStore } from '../execution-audience.ts';
import { IoBudget, ioBudget, IO_BUDGET_IDLE_BYTES_PER_MINUTE, type IoReading } from '../io-budget.ts';
import { OWNER } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { identityGeneration, identitySourceSet } from './provenance-stamp.ts';
import { insertMemoryRecord } from './record-write.ts';
import { databaseFile } from './optional-index.ts';
import { OWNER_PIN } from './schema.ts';
import * as views from './recall-view.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database().exec(OWNER_PIN.sql); });
afterEach(() => { vi.restoreAllMocks(); views.stopRecallViewMaintenance(); setExecutionStore(undefined); closeDatabase(); });

const SLICE = views.RECALL_BUILD_SLICE;
const binding = (botId: string, threadId: string) => ({ botId, threadId, humanPrincipal: OWNER, notOwnerAudience: false });
/** A reader with its own thread, and a second bot that owns `threads` task threads (the roster the oracle has to walk). */
function rosterOf(threads: number, revision = 1): MemoryRoster {
  return { memoryRosterRevision: revision, bots: [
    // partitioned, as every bot of a current file is: the oracle then asks the build for its partition's scopes (recall-partitions.ts)
    { id: 'reader', threadId: 'reader-thread', partitionedAt: 1 },
    { id: 'keeper', threadId: 'keeper-thread', tasks: Array.from({ length: threads }, (_, n) => ({ threadId: `task-${n}` })) },
  ], groups: [] };
}
/** The bot store the partition oracle reads (execution-audience.ts): the roster itself, as the server's store is. */
function usePartitions(roster: MemoryRoster): void {
  const store = roster as unknown as NonNullable<Parameters<typeof setExecutionStore>[0]>;
  Object.assign(store, { bot: (id: string) => roster.bots.find(bot => bot.id === id) ?? null });
  setExecutionStore(store);
}
const count = (sql: string, ...args: (string | number)[]) => Number(database().prepare(sql).get(...args)!.n);
/** Runs `work` and returns the COMMITs the recall view code executed meanwhile (transaction() commits through db.exec; a COMMIT whose
 *  stack does not pass through recall-view.ts belongs to another subsystem, such as the search index's own reset, and is not the build's). */
const committers: string[] = [];
async function commitsDuring(work: () => Promise<void> | void): Promise<number> {
  const db = database(), exec = db.exec;
  let commits = 0;
  committers.length = 0;
  const spy = vi.spyOn(db, 'exec').mockImplementation(sql => {
    if (/^\s*COMMIT\b/i.test(sql) && (new Error().stack ?? '').includes('recall-view.ts')) {
      commits++;
      // who committed, for the failure message: the first frames outside the database layer
      committers.push((new Error().stack ?? '').split('\n').slice(2).filter(line => !/database\.ts|node_modules|node:|tx-scope/.test(line)).slice(0, 2).map(line => line.trim().replace(/^at /, '').replace(/ \(.*[\\/]server[\\/]/, ' (').slice(0, 60)).join(' < '));
    }
    return exec.call(db, sql);
  });
  try { await work(); } finally { spy.mockRestore(); }
  return commits;
}
/** Builds the reader's first view over a roster of `threads` task threads; returns the COMMITs and the shape the bound is stated in. */
async function firstBuild(threads: number) {
  const roster = rosterOf(threads);
  reconcileMemoryRoster(roster);
  usePartitions(roster);
  views.stopRecallViewMaintenance();
  const db = database();
  // the reader's thread has history, so its conversation scope exists before the build: the oracle asks for it and must only read it
  ensureScope('conversation', 'reader-thread');
  // three records in the reader's own scope, so the projection has rows to write
  const scope = ensureScope('bot', 'reader');
  for (let n = 0; n < 3; n++) insertMemoryRecord(db, { id: `fact-${n}`, version: 1, scopeId: scope, kind: 'fact', text: `reader fact ${n}`, assertion: 'owner-statement', state: 'active', validFrom: 1, createdAt: 1 });
  const scopesBefore = count('SELECT count(*) AS n FROM memory_scopes');
  const commits = await commitsDuring(() => views.prepareRecallContext('reader', 'reader-thread', roster));
  const handle = views.resolveRecallView(binding('reader', 'reader-thread'), roster).handle;
  const viewScopes = count('SELECT count(*) AS n FROM memory_recall_view_scopes WHERE view_id=? AND generation=?', handle.viewId, handle.generation);
  const records = count('SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND generation=?', handle.viewId, handle.generation);
  const jobs = count('SELECT count(*) AS n FROM memory_recall_view_jobs WHERE view_id=? AND generation=?', handle.viewId, handle.generation);
  const newScopes = count('SELECT count(*) AS n FROM memory_scopes') - scopesBefore;
  return { roster, handle, commits, viewScopes, records, jobs, newScopes, bound: 4 + newScopes + Math.floor((viewScopes + records + jobs) / SLICE) + Math.floor(viewScopes / SLICE) };
}

it('W-COMMIT-BOUND: a first build over a 1000-thread roster commits at most 4 + new scopes + floor(rows/256) + floor(scopes/256) times', { timeout: 120_000 }, async () => {
  const built = await firstBuild(1000);
  expect(built.records, 'the fixture projected its three records').toBe(3);
  expect(built.viewScopes, 'the reader sees a handful of scopes, not the roster').toBeLessThan(SLICE);
  expect(built.newScopes, 'scopes the build itself created').toBeLessThanOrEqual(4);
  expect(built.commits, `COMMITs of one build (bound ${built.bound}: start, oracle result, projection, publish, +1 per new scope); committed by: ${committers.join(' | ')}`).toBeLessThanOrEqual(built.bound);
  expect(built.commits, 'the build did commit: start, oracle result, projection, publish').toBeGreaterThanOrEqual(4);
});

it('W-ROSTER-FREE: the same view commits the same number of times over a 10-thread and a 1000-thread roster', { timeout: 120_000 }, async () => {
  const small = await firstBuild(10);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database().exec(OWNER_PIN.sql);
  const large = await firstBuild(1000);
  expect([large.viewScopes, large.records, large.newScopes], 'the two builds produce the same view').toEqual([small.viewScopes, small.records, small.newScopes]);
  expect(large.commits, `COMMITs at 1000 threads (${large.commits}) and at 10 (${small.commits})`).toBe(small.commits);
});

it('W-PRAGMA-ONLY: a build and an upkeep page never read data_version through the table-valued form', { timeout: 120_000 }, async () => {
  const roster = rosterOf(50);
  reconcileMemoryRoster(roster);
  views.stopRecallViewMaintenance();
  const db = database(), seen = new Set<string>();
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as Record<string, (...args: unknown[]) => unknown>;
  const saved: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['get', 'all', 'run', 'iterate']) {
    const original = proto[method]!; saved[method] = original;
    proto[method] = function (this: { sourceSQL: string }, ...args: unknown[]) { seen.add(this.sourceSQL); return original.apply(this, args); };
  }
  const exec = db.exec;
  const spy = vi.spyOn(db, 'exec').mockImplementation(sql => { seen.add(sql); return exec.call(db, sql); });
  try {
    await views.prepareRecallContext('reader', 'reader-thread', roster);
    const handle = views.resolveRecallView(binding('reader', 'reader-thread'), roster).handle;
    insertMemoryRecord(db, { id: 'late', version: 1, scopeId: ensureScope('bot', 'reader'), kind: 'fact', text: 'a later fact', assertion: 'owner-statement', state: 'active', validFrom: 2, createdAt: 2 });
    expect(views.maintainRecallViewSlice(handle), 'the upkeep page projected the new record').toBe(true);
  } finally { spy.mockRestore(); for (const method of Object.keys(saved)) proto[method] = saved[method]!; }
  expect(seen.size, 'the build ran statements').toBeGreaterThan(20);
  expect([...seen].filter(sql => /pragma_data_version/i.test(sql)), 'statements that read data_version as a table (shadowable: DATA_VERSION READS rule)').toEqual([]);
});

it('W-SHADOW: a table named pragma_data_version cannot freeze the identity memo', () => {
  const db = database();
  reconcileMemoryRoster(rosterOf(1));
  // the shadow of the ASTRA 2fe03224ca class: any table or view of this name wins over the table-valued pragma
  db.exec('CREATE TEMP TABLE pragma_data_version(data_version INTEGER); INSERT INTO temp.pragma_data_version VALUES(7)');
  identitySourceSet(db);
  const held = identityGeneration(db);
  expect(held, 'the identity set is remembered while nothing moved').toBeGreaterThan(0);
  expect(identityGeneration(db), 'still remembered on a second look').toBe(held);
  // another connection commits: this connection's identity counter cannot see it, only the commit counter can
  const other = new DatabaseSync(databaseFile(db));
  try { other.exec('PRAGMA busy_timeout=5000'); other.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1"); } finally { other.close(); }
  expect(identityGeneration(db), 'after a foreign commit the remembered set is out of date (-1), shadow table or not').toBe(-1);
});

it('W-STEADY: a rebuild of a context that already has a view writes well under 1 MB and none of it as one-time seed', { timeout: 120_000 }, async () => {
  const built = await firstBuild(1000);
  ioBudget.sampleBytes();
  const seedFirst = ioBudget.pendingBytes('recall-seed');
  expect(seedFirst, 'the first build of a context is charged to the named seed source').toBeGreaterThan(0);
  // steady state, after a restart (nothing this process remembers says the context was built before; only its persisted publication does):
  // the roster is saved again (a new revision); the context has a publication, so this is a rebuild
  closeDatabase();
  database();
  views.stopRecallViewMaintenance();
  expect(count('SELECT count(*) AS n FROM memory_recall_contexts'), 'the publication survived the restart').toBe(1);
  const next: MemoryRoster = { ...built.roster, memoryRosterRevision: 2 };
  reconcileMemoryRoster(next);
  ioBudget.sampleBytes();
  const before = { seed: ioBudget.pendingBytes('recall-seed'), build: ioBudget.pendingBytes('recall-build') };
  const commits = await commitsDuring(() => ioBudget.withSource('recall-build', () => views.prepareRecallContext('reader', 'reader-thread', next)));
  ioBudget.sampleBytes();
  const wrote = ioBudget.pendingBytes('recall-build') - before.build;
  expect(ioBudget.pendingBytes('recall-seed') - before.seed, 'a rebuild is never one-time seed work').toBe(0);
  expect(wrote, 'the rebuild wrote its view').toBeGreaterThan(0);
  expect(wrote, 'steady-state recall-build bytes for one rebuild at 1000 threads').toBeLessThanOrEqual(1024 * 1024);
  expect(commits, 'a rebuild keeps the same bound (no new scopes)').toBeLessThanOrEqual(4 + Math.floor((built.viewScopes + built.records + built.jobs) / SLICE) + Math.floor(built.viewScopes / SLICE));
  const db = database();
  expect(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE state='ready'").get()!.n, 'the rebuilt view is published').toBeGreaterThanOrEqual(1);
  // a context whose row was retired (the reclaimer under the view cap) and is demanded again is churn, not a first build
  db.prepare('DELETE FROM memory_recall_contexts').run();
  views.evictRecallViewsForTest(db);
  const again: MemoryRoster = { ...built.roster, memoryRosterRevision: 3 };
  reconcileMemoryRoster(again);
  ioBudget.sampleBytes();
  const seedBefore = ioBudget.pendingBytes('recall-seed');
  await views.prepareRecallContext('reader', 'reader-thread', again);
  ioBudget.sampleBytes();
  expect(ioBudget.pendingBytes('recall-seed') - seedBefore, 'a retired context built again in the same process is not seed work').toBe(0);
});

it('W-STEADY-WINDOW: over a steady window at 1000 threads the recall-build bytes of every idle minute stay within 1 MB a minute', { timeout: 240_000 }, async () => {
  // The window: five minutes after the seed. Four are idle minutes of the perf rig's churn (four injected sends a minute, PERF-SPEC); in one
  // the owner saves the roster (an owner action: that minute is judged against the active budget, io-budget.ts countsAsOwnerAction) and the
  // view is rebuilt once, which also shows the meter sees recall-build on the real queue path. Bytes are the WAL bytes the process meter
  // attributes to the build queue's sources; each minute is judged by the watchdog's own verdict (IoBudget.tick).
  const MINUTES = 5, SENDS_PER_MINUTE = 4, SAVE_IN_MINUTE = 2, HISTORY = 40;
  let roster = rosterOf(1000);
  reconcileMemoryRoster(roster); usePartitions(roster);
  views.stopRecallViewMaintenance();
  const db = database(), scope = ensureScope('bot', 'reader'), reader = binding('reader', 'reader-thread');
  ensureScope('conversation', 'reader-thread');
  // history: the reader's view is not a toy (a rebuild copies every record and its terms)
  const body = (n: number) => Array.from({ length: 60 }, (_, word) => `w${n}x${word} steady${word % 7} note${(n * 31 + word) % 97}`).join(' ');
  for (let n = 0; n < HISTORY; n++) insertMemoryRecord(db, { id: `history-${n}`, version: 1, scopeId: scope, kind: 'fact', text: body(n), assertion: 'owner-statement', state: 'active', validFrom: 2, createdAt: 2 });
  /** The reader's current view, as a turn asks for it: a view that is not current is queued (the real queue, source recall-build) and
   *  awaited; a turn that still has none goes on without (the reader sees "catching up"). */
  const settle = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return views.resolveRecallView(reader, roster).handle; }
      catch { try { await views.waitForRecallConstructionIdleForTest(roster); } catch { /* still building */ } }
    }
    return undefined;
  };
  /** Upkeep pages, under no source of their own, as the maintenance timer runs them. */
  const upkeep = (handle: views.RecallViewHandle | undefined) => { for (let page = 0; handle && page < 8 && !views.maintainRecallViewSlice(handle); page++) { /* bounded */ } };
  upkeep(await settle());
  // the seed is over: everything measured from here on is steady state
  const recallBytes = () => { ioBudget.sampleBytes(); return ioBudget.pendingBytes('recall-build') + ioBudget.pendingBytes('recall-seed'); };
  let reading: IoReading = { at: 0, fsWriteBlocks: 0, cpuMicros: 0 }, idle = true;
  const lines: string[] = [];
  const judge = new IoBudget({ read: () => reading, log: line => lines.push(line), onScale: () => {}, isIdle: () => idle, systemOverloaded: () => null });
  judge.tick();
  const perMinute: number[] = [], tripped: boolean[] = [], viewCommits: number[] = [], allCommits: number[] = [];
  // every COMMIT of the window on the one connection (transaction() commits through db.exec); `view` are those the recall view code made
  const exec = db.exec, seen = { all: 0, view: 0 };
  const spy = vi.spyOn(db, 'exec').mockImplementation(sql => {
    if (/^\s*COMMIT\b/i.test(sql)) { seen.all++; if ((new Error().stack ?? '').includes('recall-view.ts')) seen.view++; }
    return exec.call(db, sql);
  });
  for (let minute = 0; minute < MINUTES; minute++) {
    const start = recallBytes(), commitsAtStart = { ...seen };
    idle = minute !== SAVE_IN_MINUTE;
    if (!idle) {
      roster = { ...roster, memoryRosterRevision: roster.memoryRosterRevision! + 1 };
      reconcileMemoryRoster(roster); usePartitions(roster);
    }
    for (let send = 0; send < SENDS_PER_MINUTE; send++) {
      // a send: the turn asks for its view, a new record lands in the reader's scope, upkeep projects it
      const handle = await settle();
      ioBudget.withSource('owner-send', () => insertMemoryRecord(db, { id: `send-${minute}-${send}`, version: 1, scopeId: scope, kind: 'fact', text: body(1000 + minute * 10 + send), assertion: 'owner-statement', state: 'active', validFrom: 3, createdAt: 3 }));
      upkeep(handle);
      try { await views.waitForRecallConstructionIdleForTest(roster); } catch { /* still building */ }
    }
    const wrote = recallBytes() - start;
    perMinute.push(wrote);
    viewCommits.push(seen.view - commitsAtStart.view); allCommits.push(seen.all - commitsAtStart.all);
    judge.noteBytes('recall-build', wrote);
    reading = { at: reading.at + 60_000, fsWriteBlocks: reading.fsWriteBlocks + Math.ceil(wrote / 512), cpuMicros: reading.cpuMicros + 0.05 * 60_000 * 1000 };
    tripped.push(judge.tick()?.tripped === true);
  }
  spy.mockRestore();
  const idleMinutes = perMinute.filter((_, minute) => minute !== SAVE_IN_MINUTE);
  const BEGIN_BAR = 3 * SENDS_PER_MINUTE + 25;
  const report = `recall-build bytes per minute over the steady window at 1000 threads: ${perMinute.join(', ')} (minute ${SAVE_IN_MINUTE} is the owner's roster save; idle minutes average ${Math.round(idleMinutes.reduce((a, b) => a + b, 0) / idleMinutes.length)} B/min)`;
  const commitReport = `write transactions per minute over the steady window at 1000 threads: recall view code ${viewCommits.join(', ')}; every writer ${allCommits.join(', ')} (minute ${SAVE_IN_MINUTE} holds the one rebuild; the perf bar allows 3 x ${SENDS_PER_MINUTE} change rows + 25 = ${BEGIN_BAR} a minute)`;
  console.log(`[W-STEADY-WINDOW] ${report}`);
  console.log(`[W-STEADY-WINDOW] ${commitReport}`);
  expect(Math.max(...idleMinutes), `${report}; the idle budget is ${IO_BUDGET_IDLE_BYTES_PER_MINUTE} B/min`).toBeLessThanOrEqual(IO_BUDGET_IDLE_BYTES_PER_MINUTE);
  expect(lines.filter(line => /^\[io-budget\] writing/.test(line)), 'over-budget lines the watchdog printed for the window').toEqual([]);
  expect(tripped, 'no minute of the window tripped').toEqual(Array.from({ length: MINUTES }, () => false));
  expect(Math.max(...allCommits), commitReport).toBeLessThanOrEqual(BEGIN_BAR);
  expect(viewCommits[SAVE_IN_MINUTE]!, 'the counter is live: the rebuild of the window committed through the recall view code').toBeGreaterThanOrEqual(4);
  expect(perMinute[SAVE_IN_MINUTE]!, 'the meter is live: the one rebuild of the window (the roster save) was measured as recall-build bytes').toBeGreaterThan(64 * 1024);
  expect(count("SELECT count(*) AS n FROM memory_recall_view_records r JOIN memory_recall_contexts c ON c.view_id=r.view_id AND c.generation=r.generation WHERE r.record_id LIKE 'send-%'"), 'the published view holds every record sent in the window').toBe(MINUTES * SENDS_PER_MINUTE);
});

it('the exported bound is the formula the witnesses state', () => {
  expect(views.recallBuildCommitBound({ newScopes: 0, rows: 0, scopes: 0 })).toBe(4);
  expect(views.recallBuildCommitBound({ newScopes: 2, rows: 600, scopes: 300, changePages: 1 })).toBe(4 + 2 + 2 + 1 + 1);
});
