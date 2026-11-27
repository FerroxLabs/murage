// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: memory V2 lane H. Test tree only. H-R3 7.2: the generated kill/fail matrix of the session-proof collector.
// Rows: every checkpoint deletion path (D1-D8, D10; D9 is the kill itself) x every guard state x every statement k of the run x {kill, fail}.
// The k values are never picked by hand: one uninterrupted child run per (D,G) counts its statements N, and the rows are k = 1..N.
//   kill: a real process is SIGKILLed right after its statement k returned; the same build then starts again on the file.
//   fail: statement k throws SQLITE_BUSY (through the harness); there is no restart and ticking goes on.
// Every row ends with: 0 orphan rows (unbounded oracle), the end state byte-equal to the uninterrupted one (or, when the deletion never
// committed, to the untouched one), done cached iff the guards are installed, 0 statements over 200 idle ticks on a guarded connection, and
// the main schema and binding ids unchanged (C1).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { stopRecallViewMaintenance } from './recall-view.ts';
import { collectSessionChecksSlice, sessionCollector, setSessionCollectorInstallFaultForTest } from './session-proof-schema.ts';
import { DatabaseSync } from '../sqlite-open.ts';
import { GUARDS, InjectedBusy, PATHS, PATH_NOTES, SLICES, STEP, T0, X, buildFixture, clock, dump, hasCheck, instrument, orphanRows, runScenario, settleSlices,
  type Guard, type Path } from './session-collector-harness.ts';

const file = () => join(DATA_DIR, 'messages.db');
const CHILD = fileURLToPath(new URL('./session-collector-child.ts', import.meta.url));
const MARKER = 'memory-v2:session-orphans';
const ALWAYS_DELETED: readonly Path[] = ['D3', 'D4']; // the collector itself deletes: a restart or a retry does it again
/** The store files of a built fixture, closed: every row starts from a byte-identical copy. */
type Template = Array<[string, Buffer]>;

const stageOf = (path: Path) => (PATHS.indexOf(path) % 3) as 0 | 1 | 2; // as the scenario: every install stage fails somewhere
function reset(): void { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
/** One file holds everything: the log is folded into it first, so a copy never depends on a -wal or -shm file that a closing handle removes. */
function snapshot(): Template {
  const fold = new DatabaseSync(file());
  try { fold.exec('PRAGMA busy_timeout=10000'); fold.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { fold.close(); }
  return [['messages.db', readFileSync(file())]];
}
function restore(template: Template): void { reset(); for (const [name, bytes] of template) writeFileSync(join(DATA_DIR, name), bytes); }
function schemaRows(db: DatabaseSync): string {
  return JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all());
}
function bindingIds(db: DatabaseSync): string[] {
  return db.prepare('SELECT id FROM memory_scope_bindings ORDER BY id').all().map(row => String(row.id));
}
function child(path: Path, guard: Guard, kill: number) {
  closeDatabase();
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CHILD, path, guard, String(kill)],
    { encoding: 'utf8', timeout: 120_000, env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR } });
  expect(run.error, run.stderr).toBeUndefined();
  return run;
}
/** Ticks an open connection until the collector had every chance to finish (H-R3 7.2 assertion 1), on the fixed clock. */
function settle(db: DatabaseSync, sessions: number): void {
  const slices = settleSlices(sessions, 2);
  for (let n = 0; n < slices; n++) { clock.now += STEP; collectSessionChecksSlice(db, clock.now); }
}
type Plan = { template: Template; schema: string; bindings: string[]; sessions: number; statements: number; commitAt: number; full: string; untouched: string | undefined };
const RESET = /^DELETE FROM memory_session_checks WHERE thread_id=\? AND driver_instance=\? AND native_session=\?$/; // deleteSessionChecks
/** The statement that commits each path's deletion, as the child's trace prints it (a `foreign:` prefix is the D7 second connection). */
const DELETES: Record<Path, RegExp> = {
  D1: RESET, D2: /^DELETE FROM memory_session_checks WHERE thread_id=\? AND driver_instance=\? AND native_session=\? AND up_to=0$/, D3: RESET, D4: RESET,
  D5: /^INSERT INTO memory_receipt_lines/, D6: /^INSERT INTO memory_session_roots/,
  D7: /^foreign: DELETE FROM memory_session_checks WHERE native_session=\?/, D8: /^COMMIT$/, D10: /^DELETE FROM memory_session_checks WHERE native_session LIKE/,
};
const plans = new Map<string, Plan>();
/** One uninterrupted run of (D,G) in a real process: its statement count, the statement that committed the deletion and its end state. */
function plan(path: Path, guard: Guard): Plan {
  const known = plans.get(`${path} ${guard}`);
  if (known) return known;
  reset();
  const fresh = database();
  const schema = schemaRows(fresh);
  buildFixture(fresh, path);
  const sessions = Number(fresh.prepare('SELECT count(DISTINCT native_session) AS n FROM memory_session_checks').get()!.n);
  closeDatabase();
  const template = snapshot();
  expect(template.map(([name]) => name)).toContain('messages.db');
  let untouched: string | undefined;
  if (!ALWAYS_DELETED.includes(path)) {
    setSessionCollectorInstallFaultForTest(0);
    clock.now = T0;
    const db = database();
    settle(db, sessions);
    expect(hasCheck(db)).toBe(true);
    expect(orphanRows(db)).toBe(0);
    untouched = dump(db);
    restore(template);
  }
  const run = child(path, guard, 0);
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const counted = JSON.parse(/^H-MATRIX (.*)$/m.exec(run.stdout)![1]!) as { statements: number; commitAt: number; trace: string[] };
  // the run really deleted the check, through a statement on the meter (for D7 the second connection's DELETE), and really had statements
  // to kill at
  expect(counted.commitAt, `${path} ${guard}`).toBeGreaterThanOrEqual(1);
  expect(counted.trace[counted.commitAt - 1], `${path} ${guard}: the statement that committed the deletion`).toMatch(DELETES[path]);
  expect(counted.statements, `${path} ${guard}`).toBeGreaterThan(Math.max(4, counted.commitAt));
  setSessionCollectorInstallFaultForTest(guard === 'absent' ? Infinity : 0, stageOf(path));
  clock.now = T0 + SLICES * STEP;
  const db = database();
  settle(db, sessions);
  expect(orphanRows(db), `${path} ${guard} uninterrupted`).toBe(0);
  const full = dump(db);
  expect(full).not.toContain(`"native_session":"${X}"`);
  expect(full).toContain('"native_session":"zz-live"');
  expect(full).toContain('"native_session":"live0"');
  if (path === 'D10') expect(full).not.toContain('"native_session":"ov');
  // the store writes binding rows of its own after it opens; lane H's only one is the lap marker (1078ca3bfc has it too)
  const bindings = bindingIds(db).filter(id => id !== MARKER);
  expect(bindings.filter(id => id.startsWith('memory-v2:'))).toEqual([]);
  const made: Plan = { template, schema, bindings, sessions, statements: counted.statements, commitAt: counted.commitAt, full, untouched };
  console.log(`H-MATRIX-ROWS ${guard} ${path} statements=${made.statements} commitAt=${made.commitAt}`); // the receipt of how many rows each cell has
  plans.set(`${path} ${guard}`, made);
  return made;
}
/** The assertions of one row, on the connection that ends it. */
function verify(label: string, db: DatabaseSync, made: Plan, must: 'full' | 'untouched' | 'either', guardsAtEnd: boolean): void {
  expect(orphanRows(db), `${label}: orphan rows`).toBe(0);
  const gone = !hasCheck(db);
  if (must !== 'either') expect(gone ? 'full' : 'untouched', `${label}: was the check deleted`).toBe(must);
  expect(dump(db), `${label}: end state equals the ${gone ? 'uninterrupted' : 'untouched'} one`).toBe(gone ? made.full : made.untouched);
  const st = sessionCollector(db, clock.now);
  expect(st.guards, `${label}: guards`).toBe(guardsAtEnd);
  expect(st.orphans.done, `${label}: done is cached iff the guards are installed`).toBe(guardsAtEnd);
  expect(st.gone.size, `${label}: queue`).toBe(0);
  if (guardsAtEnd) {
    collectSessionChecksSlice(db, clock.now); // takes the 30 s data_version look if it is due
    const seen: string[] = [];
    const meter = instrument(db, { before(_k, sql) { seen.push(sql); } });
    meter.start();
    try {
      for (let n = 0; n < 200; n++) collectSessionChecksSlice(db, clock.now);
      expect(seen, `${label}: idle statements`).toEqual([]);
      // and over 29 s of idle time, nothing but the one data_version look (H-R3 section 6)
      for (let n = 0; n < 290; n++) collectSessionChecksSlice(db, clock.now + n * 100);
      expect(seen.length, `${label}: idle statements over 29 s`).toBeLessThanOrEqual(1);
      expect(seen.filter(sql => sql !== 'PRAGMA data_version'), `${label}: idle statements over 29 s`).toEqual([]);
    } finally { meter.stop(); meter.restore(); }
  }
  expect(schemaRows(db) === made.schema, `${label}: main schema unchanged`).toBe(true);
  // the same ids as the uninterrupted run, and of lane H's only the lap marker
  expect(bindingIds(db).filter(id => id !== MARKER), `${label}: binding ids`).toEqual(made.bindings);
}
function killRow(path: Path, guard: Guard, made: Plan, k: number): void {
  restore(made.template);
  const run = child(path, guard, k);
  // the run did not reach its end (it prints H-MATRIX there); Windows ends a killed process with no signal name
  expect(/^H-MATRIX /m.test(run.stdout), `${path} ${guard} kill ${k}: ${run.stdout}${run.stderr}`).toBe(false);
  if (process.platform !== 'win32') expect(run.signal, `${path} ${guard} kill ${k}: ${run.stdout}${run.stderr}`).toBe('SIGKILL');
  else expect(run.status, `${path} ${guard} kill ${k}`).not.toBe(0);
  // the same build starts again; `retry` restarts with working guards
  setSessionCollectorInstallFaultForTest(guard === 'absent' ? Infinity : 0, stageOf(path));
  clock.now = T0 + SLICES * STEP;
  const db = database();
  settle(db, made.sessions);
  const committed = ALWAYS_DELETED.includes(path) || k >= made.commitAt;
  verify(`${path} ${guard} kill ${k}/${made.statements}`, db, made, committed ? 'full' : 'untouched', guard !== 'absent');
}
function failRow(path: Path, guard: Guard, made: Plan, k: number): void {
  restore(made.template);
  const db = database(), busy = new InjectedBusy();
  let fired = '';
  const meter = instrument(db, { before(n, sql, handle) { if (n === k) { fired = `${handle === 'foreign' ? 'foreign: ' : ''}${sql.trim().replace(/\s+/g, ' ')}`; throw busy; } } });
  try { runScenario(db, file(), path, guard, meter, busy); } finally { meter.restore(); }
  expect(fired, `${path} ${guard} fail ${k}: the statement was reached`).not.toBe('');
  settle(db, made.sessions);
  const committed = ALWAYS_DELETED.includes(path) || k > made.commitAt;
  // the deleting statement itself (for D7 the second connection's DELETE) failed, or one before it: the check is still there (nothing but
  // the collector, which is ALWAYS_DELETED, deletes again)
  if (!ALWAYS_DELETED.includes(path) && k === made.commitAt) expect(fired, `${path} ${guard} fail ${k}: the row failed the deleting statement`).toMatch(DELETES[path]);
  verify(`${path} ${guard} fail ${k}/${made.statements} (${fired.slice(0, 40)})`, db, made, committed ? 'full' : 'untouched', guard !== 'absent');
}
function hooks(): void {
  beforeEach(() => { vi.spyOn(Date, 'now').mockImplementation(() => clock.now); clock.now = T0; reset(); });
  afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); setSessionCollectorInstallFaultForTest(0); vi.restoreAllMocks(); });
}

/** The whole matrix of one guard state: every k of every path, both modes. */
export function matrix(guard: Guard): void {
  hooks();
  for (const path of PATHS) {
    it(`H-R3-MATRIX ${guard} ${path} kill: ${PATH_NOTES[path]}; a SIGKILL after each statement, then a restart, ends where the uninterrupted run ends`, () => {
      const made = plan(path, guard);
      for (let k = 1; k <= made.statements; k++) killRow(path, guard, made, k);
    }, 1_200_000);
    it(`H-R3-MATRIX ${guard} ${path} fail: ${PATH_NOTES[path]}; SQLITE_BUSY at each statement, no restart, ends where the uninterrupted run ends`, () => {
      const made = plan(path, guard);
      for (let k = 1; k <= made.statements; k++) failRow(path, guard, made, k);
    }, 1_200_000);
  }
}
/** The gate rows: one kill per (D,G), right after the statement that committed the deletion. */
export function gateRows(): void {
  hooks();
  for (const guard of GUARDS) for (const path of PATHS) {
    it(`H-R3-MATRIX gate ${guard} ${path}: ${PATH_NOTES[path]}; killed right after the delete committed, the restart leaves no orphan`, () => {
      const made = plan(path, guard);
      killRow(path, guard, made, made.commitAt);
    }, 300_000);
  }
}
