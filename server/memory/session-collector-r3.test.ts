// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: memory V2 lane H owns the session-proof collector (session-proof-schema.ts) and these witnesses. Contract sides: lane A/E own the
// upkeep tick that calls collectSessionChecksSlice; lane W owns the open hook and the foreign-commit wake (sessionCollector(db).foreignCommit).
// Design: H-R3. An orphan is a cite or message row whose session has no check; the collector finds orphans from the rows alone, whatever
// the lap marker, the guards or its done flag say. Witnesses here: H-R3-RED2a/RED2b (ASTRA 1713), RED3, RED4, H-R5-SHADOW/PRAGMA/ORDER, BUSY, RED5, LIVE, PLAN, TXN,
// PATHS, C1, the three install-fault stages, and the gate rows of the kill matrix. H-R3-RED1 (ASTRA 1587) is the kill test in
// session-collector.test.ts.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { stopRecallViewMaintenance } from './recall-view.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import * as schema from './session-proof-schema.ts';
import { collectSessionChecksSlice, deleteSessionChecks, sessionCollector, sessionProofSchemaObjects } from './session-proof-schema.ts';
import { proofModule, setupProofFixture, receipts } from './session-proof-fixture.ts';
import { DatabaseSync } from '../sqlite-open.ts';
import { addSession, instrument, orphanRows } from './session-collector-harness.ts';
import { gateRows } from './session-collector-matrix.ts';

const file = () => join(DATA_DIR, 'messages.db');
const count = (db: DatabaseSync, table: string, name?: string) =>
  Number(db.prepare(`SELECT count(*) AS n FROM ${table}${name ? ' WHERE native_session=?' : ''}`).get(...(name ? [name] : []))!.n);
const second = () => { const other = new DatabaseSync(file()); other.exec('PRAGMA busy_timeout=10000'); return other; };
/** Runs the paced lap to its end on the injected clock, as the upkeep tick would. */
function finishLap(db: DatabaseSync, start: number): number {
  let now = start;
  for (let step = 0; step < 60; step++, now += 1500) collectSessionChecksSlice(db, now);
  return now;
}
const names = (n: number) => Array.from({ length: n }, (_, i) => `s${String(i).padStart(3, '0')}`);

describe('H-R3 witnesses', () => {
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); schema.setSessionCollectorInstallFaultForTest?.(0); vi.restoreAllMocks(); });

  /** A session proven by the real proof (fixture `direct`), holding one cite of its own, whose check a receipt line (D5) or a root (D6) can end. */
  async function provenSession() {
    const f = setupProofFixture('direct'), p = await proofModule();
    await receipts(f, 2);
    let access = f.access;
    const prove = () => p.proveRetainedSession(LineageAllowance.tool(), f.key, { access, disclosed: true });
    expect(prove()).toEqual({ kind: 'resume' });
    const k = [f.key.threadId, f.key.driverInstance, f.key.nativeSession] as const, db = database();
    db.prepare('DELETE FROM memory_session_check_messages WHERE thread_id=? AND driver_instance=? AND native_session=?').run(...k);
    db.prepare("INSERT OR IGNORE INTO memory_session_check_cites VALUES(?,?,?,'record','r-x',1,'bundle')").run(...k);
    db.prepare('UPDATE memory_session_checks SET up_to=0 WHERE thread_id=? AND driver_instance=? AND native_session=?').run(...k);
    db.prepare('INSERT OR IGNORE INTO memory_session_no(thread_id,driver_instance,native_session,no) VALUES(?,?,?,(SELECT coalesce(max(no),0)+1 FROM memory_session_no))').run(...k);
    let lines = 0;
    const where = 'thread_id=? AND driver_instance=? AND native_session=?';
    return {
      k, prove,
      /** After the store was closed and opened again, the reader's access is issued again (the old one named the closed view). The fixture
       * stops the upkeep timer it starts, so no collector slice runs here. */
      reissue: () => { access = f.issue(); },
      checks: () => Number(database().prepare(`SELECT count(*) AS n FROM memory_session_checks WHERE ${where}`).get(...k)!.n),
      dependents: () => Number(database().prepare(`SELECT (SELECT count(*) FROM memory_session_check_cites WHERE ${where})+(SELECT count(*) FROM memory_session_check_messages WHERE ${where}) AS n`).get(...k, ...k)!.n),
      /** D5: the persisted memory_session_proof_receipt_line_insert trigger ends the check. Raw SQL: no code of the collector runs. */
      receiptLine: (handle: DatabaseSync) => handle.prepare(`INSERT INTO memory_receipt_lines(bundle_id,thread_no,first_lsn,session_no) VALUES(?,1,1,(SELECT no FROM memory_session_no WHERE ${where}))`).run(`bundle-line-${lines++}`, ...k),
    };
  }
  /** The next guard install fails once: the product's seam, or on a build before it a registered-function failure (the same injection). */
  function failNextInstall(db: DatabaseSync): void {
    if (schema.setSessionCollectorInstallFaultForTest) schema.setSessionCollectorInstallFaultForTest(1);
    else vi.spyOn(db, 'function').mockImplementationOnce(() => { throw new Error('no registered functions here'); });
  }

  // The sequence ASTRA 1713 reported, kept as it was at ac88e3288c (RED on the 1078ca3bfc collector there). On this tree its first window
  // ran in the caller's transaction, so that cycle is never cached or paced whatever the install does: it carries no mutant receipt.
  it('H-R3-RED2a pure (ASTRA 1713 path A as reported, regression): no marker, first use inside a transaction (no guards), a receipt line ends X after the lap passed it, then the guards install: X is cleared at once and can re-prove', async () => {
    const s = await provenSession();
    let db = database();
    for (const name of names(300)) addSession(db, name, { checked: Date.now() }); // the lap's checks walk needs three steps
    db.prepare("DELETE FROM memory_scope_bindings WHERE id='memory-v2:session-orphans'").run(); // this build has not finished its lap
    closeDatabase();
    db = database(); // a start whose first use of the connection is the upkeep slice below
    let now = Date.now() + 1000;
    db.exec('BEGIN'); collectSessionChecksSlice(db, now); db.exec('COMMIT');
    expect(s.checks()).toBe(1);
    s.receiptLine(db);
    expect(s.checks()).toBe(0);
    expect(s.dependents()).toBeGreaterThan(0);
    s.reissue();
    expect(s.prove()).toMatchObject({ kind: 'fresh', reason: 'session-proof-cleanup' });
    for (let n = 0; n < 10; n++) { now += 1500; collectSessionChecksSlice(db, now); } // 15 s: the install must not wait for a 30 s look
    expect(s.dependents()).toBe(0);
    expect(s.prove()).not.toMatchObject({ reason: 'session-proof-cleanup' });
    expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-v2:session-orphans'").get()).toBeDefined();
  });

  it('H-R3-RED2a (ASTRA 1713 path A): no marker, first use inside a transaction (no guards), the first install outside it fails, a pass without guards goes over X and is paced, a receipt line ends X, then the guards install: X is cleared at once and can re-prove', async () => {
    const s = await provenSession();
    let db = database();
    for (const name of names(300)) addSession(db, name, { checked: Date.now() }); // the lap's checks walk needs three steps
    db.prepare("DELETE FROM memory_scope_bindings WHERE id='memory-v2:session-orphans'").run(); // this build has not finished its lap
    closeDatabase();
    db = database(); // a start whose first use of the connection is the upkeep slice below
    const t0 = Date.now() + 1000;
    db.exec('BEGIN');
    collectSessionChecksSlice(db, t0);
    expect(sessionCollector(db, t0).guards).toBe(false); // no install inside a transaction
    db.exec('COMMIT');
    failNextInstall(db);
    sessionCollector(db, t0); // the first install outside the transaction fails: the next try is at t0 + 30 s
    // passes without guards, outside any transaction, while X still has its check: the first ends the cycle the transaction began; the
    // second is wholly outside it, finds nothing, is not cached and paces the next pass 30 s out (t0 + 50 s). The fixture has fewer than
    // 128 sessions with cites, so each pass is two windows.
    for (let n = 0; n < 6; n++) collectSessionChecksSlice(db, t0 + 20_000);
    expect(sessionCollector(db, t0 + 20_000).guards).toBe(false);
    expect(sessionCollector(db, t0 + 20_000).orphans?.done ?? false).toBe(false);
    expect(s.checks()).toBe(1);
    s.receiptLine(db);
    expect(s.checks()).toBe(0);
    expect(s.dependents()).toBeGreaterThan(0);
    s.reissue();
    expect(s.prove()).toMatchObject({ kind: 'fresh', reason: 'session-proof-cleanup' });
    // the install succeeds at t0 + 30 s; the slices end at t0 + 44.5 s, before the paced pass: only the install's CLEAR starts a cycle
    let now = t0 + 31_000;
    for (let n = 0; n < 10; n++) { collectSessionChecksSlice(db, now); now += 1500; }
    expect(sessionCollector(db, now).guards).toBe(true);
    expect(s.dependents()).toBe(0);
    expect(s.prove()).not.toMatchObject({ reason: 'session-proof-cleanup' });
    for (let n = 0; n < 10; n++) { now += 1500; collectSessionChecksSlice(db, now); } // the lap has its three steps
    expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-v2:session-orphans'").get()).toBeDefined();
  });

  it('H-R3-RED2b (ASTRA 1713 path B): marker present, the guard install fails once, a pass goes over X, a receipt line ends X with no guards, the install then succeeds: X is cleared at once and can re-prove', async () => {
    const s = await provenSession();
    let db = database();
    const t0 = finishLap(db, Date.now());
    expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-v2:session-orphans'").get()).toBeDefined();
    closeDatabase();
    db = database();
    failNextInstall(db);
    sessionCollector(db, t0); // the install fails: the next try is at t0 + 30 s
    for (let n = 0; n < 6; n++) collectSessionChecksSlice(db, t0 + 20_000); // a whole pass, X still has its check
    expect(sessionCollector(db, t0 + 20_000).guards).toBe(false);
    // rule (e): a pass without guards is never cached, whatever it found (else only the install's CLEAR would stand between X and for ever)
    expect(sessionCollector(db, t0 + 20_000).orphans?.done ?? false).toBe(false);
    s.receiptLine(db);
    expect(s.checks()).toBe(0);
    s.reissue();
    expect(s.prove()).toMatchObject({ kind: 'fresh', reason: 'session-proof-cleanup' });
    expect(sessionCollector(db, t0 + 20_000).guards).toBe(false);
    let now = t0 + 31_000;
    for (let n = 0; n < 10; n++, now += 1000) collectSessionChecksSlice(db, now); // ends at t0 + 41 s, before any 30 s look after the pass
    expect(sessionCollector(db, now).guards).toBe(true);
    expect(s.dependents()).toBe(0);
    expect(s.prove()).not.toMatchObject({ reason: 'session-proof-cleanup' });
  });

  it.each(['receipt line (D5)', 'root (D6)'] as const)('H-R3 D5/D6 on a guarded, quiet connection: the %s trigger ends X; the TEMP guard sees the row the persisted trigger deleted, and X is cleared in the next slices', async how => {
    const s = await provenSession();
    const db = database();
    let now = finishLap(db, Date.now());
    const st = sessionCollector(db, now);
    expect(st.guards && st.orphans.done).toBe(true);
    if (how === 'root (D6)') db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,'set-1') ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET set_id='set-2'").run(...s.k);
    else s.receiptLine(db);
    expect(s.checks()).toBe(0);
    expect(st.orphans.done).toBe(false);
    expect(st.gone.size).toBe(1);
    for (let n = 0; n < 3; n++) collectSessionChecksSlice(db, ++now); // no 30 s look is needed
    expect(s.dependents()).toBe(0);
  });

  it('H-R3-RED3 (D7 after done): another connection ends X through the persisted root trigger while this one is quiet: 30 s later X is cleared, with no restart', async () => {
    const s = await provenSession();
    const db = database();
    let now = finishLap(db, Date.now());
    expect(sessionCollector(db, now).guards).toBe(true);
    // the cache is set, so only the look at other connections' commits can find X (a build before H-R3 has no such cache to assert)
    expect((sessionCollector(db, now) as Partial<ReturnType<typeof sessionCollector>>).orphans?.done ?? true).toBe(true);
    const other = second();
    other.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,'set-1') ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET set_id='set-2'").run(...s.k);
    other.close();
    expect(s.checks()).toBe(0);
    expect(s.dependents()).toBeGreaterThan(0);
    for (let n = 0; n < 20; n++) { now += 3000; collectSessionChecksSlice(db, now); }
    expect(s.dependents()).toBe(0);
    expect(orphanRows(db)).toBe(0);
  });

  it('H-R3-RED4 (D7 during a cycle): a foreign delete behind the cursor ends the cycle with nothing found, which must not be cached: the next cycle finds X', () => {
    const db = database();
    for (const name of names(200)) addSession(db, name, { cites: 1, checked: Date.now() });
    addSession(db, 'no-rows', { checked: Date.now() });
    let now = finishLap(db, Date.now());
    const st = sessionCollector(db, now);
    expect(st.orphans.done).toBe(true);
    deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: 'no-rows' }); // a deletion with no rows: a cycle starts
    collectSessionChecksSlice(db, now);
    expect(st.orphans.cycle?.table).toBe(0);
    expect(st.orphans.cycle!.after[2] > 's005').toBe(true); // the first window is past X
    const other = second();
    other.exec("DELETE FROM memory_session_checks WHERE native_session='s005'");
    other.close();
    for (let n = 0; n < 3 && st.orphans.cycle; n++) collectSessionChecksSlice(db, now);
    expect(st.orphans.cycle).toBeUndefined(); // the cycle ended, with nothing found
    expect(count(db, 'memory_session_check_cites', 's005')).toBe(1);
    expect(st.orphans.done).toBe(false);
    for (let n = 0; n < 20; n++) { now += 3000; collectSessionChecksSlice(db, now); }
    expect(count(db, 'memory_session_check_cites', 's005')).toBe(0);
    expect(orphanRows(db)).toBe(0);
    expect(st.orphans.done).toBe(true);
  });

  // CONTRACT-REQ H from lane C (board 2026-11-21T22:19:36Z) and DATA_VERSION READS (MAIN 11-21 23:30Z): a table or view named
  // pragma_data_version answers for the table function, bare or main-qualified, whether it is TEMP on this connection or persisted in main
  // by any connection, and one without the column fails to prepare. The collector reads data_version only by the PRAGMA statement on its own
  // connection, so no such object changes what it caches or how idle it is. Each cell's shadow answers the cached version where it has the
  // column (the strongest lie it can tell). These cells replace r4's three H-R3-SHADOW tests (main view, other shape, temp view), whose
  // scenarios they keep; r4 never cached while a shadow existed, and the r5 cells assert that the cache works as with no shadow.
  const SHADOWS = [
    ['main table', true], ['main table', false], ['main view', true], ['main view', false], ['temp view', true], ['temp view', false],
  ] as const;
  it.each(SHADOWS)('H-R5-SHADOW %s (data_version column: %s): a foreign delete behind the cursor is never cached as quiet and is cleared, then the cache works and the connection is idle as with no shadow, and a foreign delete while it is cached is cleared', (kind, column) => {
    const db = database();
    for (const name of names(200)) addSession(db, name, { cites: 1, checked: Date.now() });
    addSession(db, 'no-rows', { checked: Date.now() });
    addSession(db, 'xm', { cites: 2, messages: 1, checked: Date.now() }); // a session with rows in both tables
    let now = finishLap(db, Date.now());
    const st = sessionCollector(db, now);
    expect(st.orphans.done).toBe(true);
    const shape = column ? `${Number(st.orphans.doneVer)} AS data_version` : '1 AS x';
    const create = kind === 'main table'
      ? `CREATE TABLE pragma_data_version AS SELECT ${shape}`
      : `CREATE ${kind === 'temp view' ? 'TEMP ' : ''}VIEW pragma_data_version AS SELECT ${shape}`;
    const other = second();
    if (kind === 'temp view') db.exec(create); else other.exec(create);
    const all: string[] = [], seen: string[] = [], errors: string[] = [];
    const meter = instrument(db, { before(_k, sql) { all.push(sql); seen.push(sql); } });
    const slice = (at: number) => { try { collectSessionChecksSlice(db, at); } catch (error) { errors.push(String(error)); } };
    meter.start();
    try {
      deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: 'no-rows' }); // a deletion with no rows: a cycle starts
      slice(now);
      expect(errors, 'no slice fails').toEqual([]);
      expect(st.orphans.cycle?.table).toBe(0);
      expect(st.orphans.cycle!.after[2] > 's005').toBe(true); // the first window is past X
      other.exec("DELETE FROM memory_session_checks WHERE native_session='s005'");
      for (let n = 0; n < 3 && st.orphans.cycle; n++) slice(now);
      expect(errors, 'no slice fails').toEqual([]);
      expect(st.orphans.cycle).toBeUndefined();
      expect(st.orphans.done, 'the cycle saw another connection commit: its end is not cached').toBe(false);
      for (let n = 0; n < 20; n++) { now += 3000; slice(now); }
      expect(errors, 'no slice fails').toEqual([]);
      expect(count(db, 'memory_session_check_cites', 's005')).toBe(0);
      expect(orphanRows(db)).toBe(0);
      expect(count(db, 'memory_session_check_cites')).toBe(201);
      for (let n = 0; n < 20 && !st.orphans.done; n++) { now += 3000; slice(now); }
      expect(st.orphans.done, 'with the shadow still there a quiet cycle is cached').toBe(true);
      seen.length = 0;
      for (let n = 0; n < 650; n++) slice(now + n * 100); // 65 s idle
      expect(errors, 'no slice fails').toEqual([]);
      expect(seen.filter(sql => sql !== 'PRAGMA data_version'), 'idle with a shadow: nothing but the 30 s look').toEqual([]);
      expect(seen.length).toBeLessThanOrEqual(3);
      expect(st.orphans.done).toBe(true);
      now += 65_000;
      // r4's temp-view scenario, in every cell: another connection ends a session while this one holds the cache (and, with the column,
      // the shadow answers the cached version); only the 30 s PRAGMA look can see it
      other.exec("DELETE FROM memory_session_checks WHERE native_session='xm'");
      for (let n = 0; n < 25; n++) { now += 3000; slice(now); }
      expect(errors, 'no slice fails').toEqual([]);
      expect(count(db, 'memory_session_check_cites', 'xm')).toBe(0);
      expect(count(db, 'memory_session_check_messages', 'xm')).toBe(0);
      expect(orphanRows(db)).toBe(0);
      expect(count(db, 'memory_session_check_cites')).toBe(199);
      for (let n = 0; n < 20 && !st.orphans.done; n++) { now += 3000; slice(now); }
      expect(st.orphans.done).toBe(true);
    } finally { meter.stop(); meter.restore(); other.close(); }
    expect(all.filter(sql => /pragma_data_version/i.test(sql)), 'no collector statement names the table function').toEqual([]);
  });

  it('H-R5-PRAGMA: over a lap, a cycle, a foreign delete and the 30 s look, the collector reads data_version only by the PRAGMA statement on its own connection', () => {
    const db = database();
    for (const name of names(150)) addSession(db, name, { cites: 1, messages: 1, checked: Date.now() });
    const all: string[] = [];
    const meter = instrument(db, { before(_k, sql) { all.push(sql); } });
    meter.start();
    try {
      let now = finishLap(db, Date.now());
      expect(sessionCollector(db, now).orphans.done).toBe(true);
      const other = second();
      other.exec("DELETE FROM memory_session_checks WHERE native_session='s100'");
      other.close();
      for (let n = 0; n < 20; n++) { now += 3000; collectSessionChecksSlice(db, now); }
      expect(orphanRows(db)).toBe(0);
    } finally { meter.stop(); meter.restore(); }
    const reads = all.filter(sql => /data_version/i.test(sql));
    expect(reads.length).toBeGreaterThan(3); // every window and the looks
    expect([...new Set(reads)], 'every data_version read is the PRAGMA statement').toEqual(['PRAGMA data_version']);
  });

  // Where another connection's commit can land between the version read and a window's snapshot. After a window outside a transaction: the
  // version must have been read before that window. Right before the BEGIN of the window that may set done: the version must be read
  // inside the transaction (it opens the snapshot), not before the BEGIN.
  const POINTS = [
    ['after the first window, outside any transaction', (sql: string) => sql.includes('WITH RECURSIVE') && sql.includes('FROM memory_session_check_cites'), 'after'],
    ['just before the BEGIN of the last window', (sql: string) => sql === 'BEGIN', 'before'],
  ] as const;
  it.each(POINTS)('H-R5-ORDER %s: another connection\'s delete behind the cursor makes the cycle\'s end look changed; it is never cached as quiet', (_point, at, when) => {
    const db = database();
    for (const name of names(200)) addSession(db, name, { cites: 1, checked: Date.now() });
    addSession(db, 'no-rows', { checked: Date.now() });
    let now = finishLap(db, Date.now());
    const st = sessionCollector(db, now);
    expect(st.orphans.done).toBe(true);
    deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: 'no-rows' });
    const other = second();
    let fired = false;
    const inject = (sql: string) => {
      if (fired || !at(sql)) return;
      fired = true;
      expect(db.isTransaction).toBe(false); // nothing of this connection holds a snapshot here
      other.exec("DELETE FROM memory_session_checks WHERE native_session='s005'"); // behind the cursor: no later window sees it
    };
    const meter = instrument(db, when === 'after' ? { after: (_k, sql) => inject(sql) } : { before: (_k, sql) => inject(sql) });
    meter.start();
    try { for (let n = 0; n < 4 && (n === 0 || st.orphans.cycle); n++) collectSessionChecksSlice(db, now); }
    finally { meter.stop(); meter.restore(); other.close(); }
    expect(fired).toBe(true);
    expect(st.orphans.cycle).toBeUndefined();
    expect(st.orphans.done, 'the delete committed inside the cycle: it can not be cached').toBe(false);
    for (let n = 0; n < 20; n++) { now += 3000; collectSessionChecksSlice(db, now); }
    expect(count(db, 'memory_session_check_cites', 's005')).toBe(0);
    expect(orphanRows(db)).toBe(0);
    expect(st.orphans.done).toBe(true);
  });

  it('H-R3-BUSY: with another connection committing before every slice, an orphan in the last session in key order is still cleared within one cycle', () => {
    const db = database();
    for (const name of names(300)) addSession(db, name, { cites: 1, checked: Date.now() });
    let now = finishLap(db, Date.now());
    expect(sessionCollector(db, now).orphans.done).toBe(true);
    const other = second();
    try {
      other.exec("DELETE FROM memory_session_checks WHERE native_session='s299'");
      now += 30_000;
      // one cycle here: three windows of cites (128, 128, 44), then the queue drains X
      for (let n = 0; n < 6; n++) {
        other.prepare("INSERT OR REPLACE INTO memory_session_state VALUES('busy','engine',?,0)").run(`writer-${n}`);
        collectSessionChecksSlice(db, now + n);
      }
    } finally { other.close(); }
    expect(count(db, 'memory_session_check_cites', 's299')).toBe(0);
    expect(count(db, 'memory_session_check_cites')).toBe(299);
  });

  it('H-R3-RED5 (D10): 5,000 checks deleted by one statement overflow the queue; every one of their rows is cleared and the collector goes quiet', () => {
    const db = database();
    let now = finishLap(db, Date.now());
    db.exec('BEGIN');
    for (let n = 0; n < 5000; n++) addSession(db, `bulk${n}`, { cites: 1, checked: Date.now() });
    addSession(db, 'kept', { cites: 2, checked: Date.now() });
    db.exec('COMMIT');
    const st = sessionCollector(db, now);
    for (let n = 0; n < 200 && !st.orphans.done; n++) collectSessionChecksSlice(db, now); // 5,001 sessions: 40 windows
    expect(st.orphans.done).toBe(true);
    db.exec("DELETE FROM memory_session_checks WHERE native_session LIKE 'bulk%'");
    expect(st.gone.size).toBe(4096);
    expect(orphanRows(db)).toBe(5000);
    for (let n = 0; n < 1200 && !st.orphans.done; n++) { now += 100; collectSessionChecksSlice(db, now); }
    expect(orphanRows(db)).toBe(0);
    expect(count(db, 'memory_session_check_cites', 'kept')).toBe(2);
    expect(st.orphans.done).toBe(true);
  }, 120_000);

  it('H-R3-LIVE (P2): a check and cites another connection commits between the queueing and the delete are not removed: liveness is tested by the DELETE itself', () => {
    const db = database();
    addSession(db, 'kept', { cites: 2, checked: Date.now() });
    addSession(db, 'x', { cites: 3, messages: 1, checked: Date.now() });
    const now = finishLap(db, Date.now());
    deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: 'x' });
    const other = second();
    let landed = 0;
    // both handles on one meter: the hook runs right before the collector's delete of X's cites, and the other connection re-proves X there
    const meter = instrument(db, {
      before(_k, sql, handle) {
        if (handle !== 'main' || !/^\s*DELETE FROM memory_session_check_cites/.test(sql) || landed) return;
        landed++;
        other.exec('BEGIN IMMEDIATE');
        other.prepare(`INSERT INTO memory_session_checks(thread_id,driver_instance,native_session,reader_key,up_to,log_seq,recall_epoch,view_id,view_generation,view_digest,policy_revision,deletion_epoch,footprint,cites,seeding,checked)
          VALUES('thread','engine','x','reader',1,0,0,NULL,NULL,NULL,1,0,'[]',1,0,?)`).run(Date.now());
        other.exec("INSERT INTO memory_session_check_cites VALUES('thread','engine','x','record','r-new',1,'bundle')");
        other.exec('COMMIT');
      },
    });
    const detach = meter.attach(other);
    meter.start();
    try { collectSessionChecksSlice(db, now); } finally { meter.stop(); detach(); meter.restore(); other.close(); }
    expect(landed).toBe(1);
    expect(count(db, 'memory_session_checks', 'x')).toBe(1);
    expect(db.prepare("SELECT 1 FROM memory_session_check_cites WHERE native_session='x' AND ref_id='r-new'").get()).toBeDefined();
    expect(count(db, 'memory_session_check_cites', 'x')).toBe(4);
    expect(count(db, 'memory_session_check_messages', 'x')).toBe(1);
    expect(sessionCollector(db, now).gone.size).toBe(0);
  });

  it('H-R3-PLAN: the orphan query seeks; it never scans a table: each access is a primary-key seek inside a scalar subquery, and a window returns at most 128 sessions', () => {
    const db = database();
    db.exec('BEGIN');
    for (let n = 0; n < 2000; n++) addSession(db, `p${String(n).padStart(4, '0')}`, { cites: 3, messages: 1, checked: Date.now() });
    db.exec('COMMIT');
    for (const table of ['memory_session_check_cites', 'memory_session_check_messages'] as const) {
      const sql = schema.orphanQuerySql(table);
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('', '', '', 128) as Array<{ id: number; parent: number; detail: string }>;
      const byId = new Map(plan.map(row => [row.id, row]));
      const text = plan.map(row => row.detail).join('\n');
      expect(text).not.toMatch(/TEMP B-TREE/);
      const touching = plan.filter(row => /memory_session_|\bSEARCH c\b|\bSEARCH x\b|\bSCAN c\b|\bSCAN x\b/.test(row.detail));
      expect(touching.length).toBeGreaterThanOrEqual(3); // the first seek, the next-session seek, the checks seek
      for (const row of touching) {
        expect(row.detail, text).toMatch(/^SEARCH .*USING (COVERING INDEX sqlite_autoindex\S+|PRIMARY KEY) \(/);
        // a seek for the next session (or the check) is a scalar subquery; a filter over the table would sit in the FROM of a query
        let up = byId.get(row.parent), scalar = false;
        while (up) { if (/SCALAR SUBQUERY/.test(up.detail)) scalar = true; up = byId.get(up.parent); }
        expect(scalar, `${row.detail}\n${text}`).toBe(true);
      }
      for (const row of plan.filter(row => /^SCAN /.test(row.detail))) expect(row.detail, text).toMatch(/^SCAN (s|CONSTANT ROW)\b/);
      expect(sql).not.toMatch(/data_version/i); // the window reads no version (orphanWindow reads it by the PRAGMA statement)
      const window = db.prepare(sql).all('', '', '', 128);
      expect(window.length).toBe(128);
    }
  });

  it('H-R3-TXN: the window that sets done runs inside the collector\'s own transaction, right after the PRAGMA data_version that opened its snapshot', () => {
    const db = database();
    addSession(db, 'a', { cites: 1, messages: 1, checked: Date.now() });
    const st = sessionCollector(db);
    let windows: Array<{ table: string; inTransaction: boolean; version: string | undefined; versionInTransaction: boolean | undefined }> = [];
    let previous: { sql: string; inTransaction: boolean } | undefined;
    const meter = instrument(db, {
      before(_k, sql) {
        if (sql.includes('WITH RECURSIVE')) windows.push({ table: /FROM (memory_session_check_\w+)/.exec(sql)![1]!, inTransaction: db.isTransaction, version: previous?.sql, versionInTransaction: previous?.inTransaction });
        previous = { sql, inTransaction: db.isTransaction };
      },
    });
    let setting: typeof windows | undefined;
    meter.start();
    try {
      const now = Date.now();
      for (let n = 0; n < 8 && !setting; n++) { windows = []; collectSessionChecksSlice(db, now); if (st.orphans.done) setting = windows; }
    } finally { meter.stop(); meter.restore(); }
    expect(setting).toEqual([{ table: 'memory_session_check_messages', inTransaction: true, version: 'PRAGMA data_version', versionInTransaction: true }]);
    expect(db.isTransaction).toBe(false);
    // inside a caller's transaction the window still runs, and nothing is cached
    deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: 'a' });
    db.exec('BEGIN');
    for (let n = 0; n < 8; n++) collectSessionChecksSlice(db, Date.now());
    expect(orphanRows(db)).toBe(0);
    expect(st.orphans.done).toBe(false);
    db.exec('COMMIT');
    for (let n = 0; n < 4; n++) collectSessionChecksSlice(db, Date.now());
    expect(st.orphans.done).toBe(true);
  });

  it('H-R3-TXN rollback: rows the collector cleared inside a caller\'s transaction come back when it rolls back; that pass is never cached, and the next one clears them', () => {
    const db = database();
    addSession(db, 'kept', { cites: 2, checked: Date.now() });
    addSession(db, 'x', { cites: 3, checked: Date.now() }); // cites only: the messages window has nothing to find
    let now = finishLap(db, Date.now());
    const st = sessionCollector(db, now);
    expect(st.orphans.done).toBe(true);
    deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: 'x' });
    db.exec('BEGIN');
    collectSessionChecksSlice(db, now); // clears X's cites and runs the cites window, all inside the caller's transaction
    expect(count(db, 'memory_session_check_cites', 'x')).toBe(0);
    expect(st.gone.size).toBe(0);
    db.exec('ROLLBACK');
    expect(count(db, 'memory_session_check_cites', 'x')).toBe(3);
    collectSessionChecksSlice(db, now); // the messages window, in the collector's own transaction: the cycle ends
    expect(st.orphans.done).toBe(false);
    for (let n = 0; n < 6; n++) collectSessionChecksSlice(db, ++now); // no 30 s wait either
    expect(orphanRows(db)).toBe(0);
    expect(count(db, 'memory_session_check_cites', 'kept')).toBe(2);
    expect(st.orphans.done).toBe(true);
  });

  it.each([0, 1, 2] as const)('H-R3 S-guard: a guard install that fails at stage %i leaves no cache and no orphan: the retry installs, and a check deleted meanwhile is cleared', stage => {
    const db = database();
    addSession(db, 'kept', { cites: 2, checked: Date.now() });
    addSession(db, 'x', { cites: 3, messages: 1, checked: Date.now() });
    const t0 = Date.now();
    schema.setSessionCollectorInstallFaultForTest(1, stage);
    for (let n = 0; n < 6; n++) collectSessionChecksSlice(db, t0);
    const st = sessionCollector(db, t0);
    expect(st.guards).toBe(false);
    expect(st.orphans.done).toBe(false);
    db.exec("DELETE FROM memory_session_checks WHERE native_session='x'");
    let now = t0 + 30_000;
    for (let n = 0; n < 6; n++, now += 10) collectSessionChecksSlice(db, now);
    expect(st.guards).toBe(true);
    expect(orphanRows(db)).toBe(0);
    expect(count(db, 'memory_session_check_cites', 'kept')).toBe(2);
    expect(st.orphans.done).toBe(true);
  });

  it('H-R3 6: lane W\'s foreign-commit wake (foreignCommit) clears the cache at once when another connection committed, and costs nothing when none did', () => {
    const db = database();
    addSession(db, 'x', { cites: 2, checked: Date.now() });
    const now = finishLap(db, Date.now());
    const st = sessionCollector(db, now);
    expect(st.orphans.done).toBe(true);
    st.foreignCommit();
    expect(st.orphans.done).toBe(true);
    const other = second();
    other.exec("DELETE FROM memory_session_checks WHERE native_session='x'");
    other.close();
    st.foreignCommit();
    expect(st.orphans.done).toBe(false);
    for (let n = 0; n < 6; n++) collectSessionChecksSlice(db, now + n); // no 30 s wait
    expect(orphanRows(db)).toBe(0);
  });
});

const SERVER = fileURLToPath(new URL('..', import.meta.url));
function productSources(dir = SERVER, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (!/^(node_modules|testing|testdata|dist|coverage)$/.test(entry.name)) productSources(path, out); continue; }
    if (!/\.(ts|mts|mjs|js)$/.test(entry.name) || /\.test\.|\.d\.ts$|fixture|^session-collector-(harness|child|matrix)\.ts$/.test(entry.name)) continue;
    out.push(path);
  }
  return out;
}
it('H-R3-PATHS: every place the product can delete a checkpoint is one the design lists (D1-D6); a new one fails here until it is added to H-R3 section 4 and the matrix', () => {
  const patterns = { sql: /DELETE\s+FROM\s+(main\.)?memory_session_checks\b/gi, reset: /\bdeleteSessionChecks\(/g, frame: /\bnoteSessionFrame\(/g };
  const found: Record<string, Record<string, number>> = {};
  for (const path of productSources()) {
    const source = readFileSync(path, 'utf8');
    if (!source.includes('memory_session_checks') && !source.includes('SessionChecks(') && !source.includes('noteSessionFrame(')) continue;
    const hits: Record<string, number> = {};
    for (const [name, pattern] of Object.entries(patterns)) { const n = (source.match(pattern) ?? []).length; if (n) hits[name] = n; }
    if (Object.keys(hits).length) found[relative(SERVER, path).split(sep).join('/')] = hits;
  }
  expect(found).toEqual({
    // D1: session reset
    'index.ts': { reset: 6, frame: 1 }, // and D2 at the fresh-start frame
    // D2: a shown frame ends the up_to=0 check
    'memory/disclosures.ts': { frame: 1 },
    'memory/dispatch.ts': { frame: 2 },
    'memory/lineage-warm-surface.ts': { frame: 2 },
    // D5/D6: the four persisted triggers; D1/D2: the two code deletes; D3/D4: expiry and the lap call deleteSessionChecks (plus its definition)
    'memory/session-proof-schema.ts': { sql: 6, reset: 3, frame: 1 },
  });
});

it('H-R3-C1: no new persisted object: the session-proof tables, indexes and triggers are the ones of 1078ca3bfc, and the collector leaves only TEMP objects', () => {
  const objects = [...sessionProofSchemaObjects().values()].sort((a, b) => a.name.localeCompare(b.name)).map(row => [row.type, row.name, row.tbl_name, row.sql]);
  // sha256 of the same list on 1078ca3bfc (and on f6ae52c670: lane H never changed the schema text)
  expect(createHash('sha256').update(JSON.stringify(objects)).digest('hex')).toBe('8e74c4ea22aa7d643ecbfcbb53b6c41b6bd5077e5165af33aab632f6fff9bb00');
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  try {
    const db = database();
    const main = () => JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all());
    const ids = () => db.prepare('SELECT id FROM memory_scope_bindings ORDER BY id').all().map(row => String(row.id));
    const before = main(), bound = ids();
    addSession(db, 'x', { cites: 2, messages: 1, checked: Date.now() });
    finishLap(db, Date.now());
    deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: 'x' });
    finishLap(db, Date.now() + 200_000);
    expect(main()).toBe(before);
    // integrator spec-cand-1021-r9 (W-SESSION-WRITE, session-checks-idle-1021.test.ts): four more TEMP triggers, on the two dependent tables
    // (INSERT and a key-moving UPDATE of a row whose session has no check). Still TEMP only: main() and the persisted hash above are unchanged.
    expect(db.prepare('SELECT name FROM sqlite_temp_schema ORDER BY name').all().map(row => String(row.name)).filter(name => name.startsWith('mem_h_')))
      .toEqual(['mem_h_checks_delete', 'mem_h_checks_insert', 'mem_h_checks_update', 'mem_h_cites_insert', 'mem_h_cites_update', 'mem_h_disclosure_insert', 'mem_h_disclosure_update', 'mem_h_lineage_insert', 'mem_h_messages_insert', 'mem_h_messages_update']);
    // the store adds rows of its own after it opens; none of them, and nothing of lane H's but the lap marker, is new here
    expect(ids().filter(id => id !== 'memory-v2:session-orphans' && !bound.includes(id) && (id.startsWith('memory-v2:') || id.includes('session'))).length).toBe(0);
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_id='session-orphan-lap'").get()!.n)).toBeLessThanOrEqual(1);
  } finally { closeDatabase(); }
});

describe('H-R3-MATRIX gate rows', () => { gateRows(); });
