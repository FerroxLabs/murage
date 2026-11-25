// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: memory V2 lane H owns this test harness and the collector it drives (session-proof-schema.ts). Test tree only: nothing in the
// product imports it. It is loaded both by vitest and by a plain node child process (session-collector-child.ts), so it uses no test API.
// Design: H-R3 section 7.2. One scenario = one checkpoint deletion path (D) under one guard state (G), then collector slices on a fixed
// clock. The harness counts every statement the scenario executes, on the main connection and on the second one of D7; a row kills the process after statement k or makes statement k
// throw SQLITE_BUSY. The product is not instrumented.
import { DatabaseSync } from '../sqlite-open.ts';
import { collectSessionChecksSlice, deleteSessionChecks, noteSessionFrame, sessionCollector, setSessionCollectorInstallFaultForTest } from './session-proof-schema.ts';

export const PATHS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D10'] as const;
export const GUARDS = ['present', 'absent', 'retry'] as const;
export type Path = typeof PATHS[number];
export type Guard = typeof GUARDS[number];
/** What each path is (H-R3 section 4). D9 is a process that is gone: every kill row is one. */
export const PATH_NOTES: Record<Path, string> = {
  D1: 'deleteSessionChecks (session reset)',
  D2: 'noteSessionFrame(shown) ends the up_to=0 check',
  D3: 'expiry inside a collector slice',
  D4: 'the lap ends a check that has no lineage',
  D5: 'persisted receipt-line trigger',
  D6: 'persisted root trigger',
  D7: 'another connection deletes the check',
  D8: 'first use of the connection is inside a transaction (no guards yet)',
  D10: 'more deletes in one statement than the queue holds',
};
export const P = 128;
export const T0 = 1_800_000_000_000;
export const STEP = 4000;
export const SLICES = 24;
export const DAY = 24 * 60 * 60 * 1000;
export const X = 'x-ended';
export const clock = { now: T0 };
const KEY = { threadId: 'thread', driverInstance: 'engine', nativeSession: X };

const CHECK = `INSERT INTO memory_session_checks(thread_id,driver_instance,native_session,reader_key,up_to,log_seq,recall_epoch,view_id,view_generation,view_digest,policy_revision,deletion_epoch,footprint,cites,seeding,checked)
 VALUES('thread','engine',?,'reader',?,0,0,NULL,NULL,NULL,1,0,'[]',?,0,?)`;
export function addSession(db: DatabaseSync, name: string, options: { lineage?: boolean; cites?: number; messages?: number; checked?: number; upTo?: number } = {}): void {
  const { lineage = true, cites = 0, messages = 0, checked = T0, upTo = 1 } = options;
  if (lineage) db.prepare("INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES('thread','engine',?,1,2)").run(name);
  db.prepare(CHECK).run(name, upTo, cites, checked);
  for (let n = 0; n < cites; n++) db.prepare("INSERT INTO memory_session_check_cites VALUES('thread','engine',?,'record',?,1,'bundle')").run(name, `r${n}`);
  for (let n = 0; n < messages; n++) db.prepare("INSERT INTO memory_session_check_messages VALUES('thread','engine',?,'source',?)").run(name, `m${n}`);
}
/** The rows every scenario starts from. X has more cites than one page, so clearing it takes more than one statement of each kind. */
export function buildFixture(db: DatabaseSync, path: Path): void {
  db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES('lap-scope','bot','lap','[]',0)").run();
  for (let n = 0; n < 5; n++) addSession(db, `live${n}`, { cites: 4, messages: 2 });
  addSession(db, 'zz-live', { cites: 2, messages: 1 }); // sorts after X: a cycle has to pass X to reach it
  addSession(db, X, { cites: 130, messages: 2, upTo: 0, lineage: path !== 'D4', checked: path === 'D3' ? T0 - 30 * DAY + 10_000 : T0 });
  if (path === 'D5') db.prepare("INSERT INTO memory_session_no(thread_id,driver_instance,native_session,no) VALUES('thread','engine',?,7)").run(X);
  if (path === 'D10') for (let n = 0; n < 8; n++) addSession(db, `ov${n}`, { cites: 1 });
}
/** Test oracle only: every dependent row whose session has no check, by an unbounded scan the product never runs. */
export function orphanRows(db: DatabaseSync): number {
  let total = 0;
  for (const table of ['memory_session_check_cites', 'memory_session_check_messages']) total += Number(db.prepare(`SELECT count(*) AS n FROM ${table} d WHERE NOT EXISTS
    (SELECT 1 FROM memory_session_checks c WHERE c.thread_id=d.thread_id AND c.driver_instance=d.driver_instance AND c.native_session=d.native_session)`).get()!.n);
  return total;
}
export function dump(db: DatabaseSync): string {
  return ['memory_session_checks', 'memory_session_check_cites', 'memory_session_check_messages']
    .map(table => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3,4,5`).all())).join('\n');
}
export function hasCheck(db: DatabaseSync, name = X): boolean {
  return !!db.prepare('SELECT 1 FROM memory_session_checks WHERE native_session=? LIMIT 1').get(name);
}

/** Which handle ran a statement: the scenario's own connection, or the second connection a D7 row opens. */
export type Handle = 'main' | 'foreign';
export type Hooks = { before?: (k: number, sql: string, handle: Handle) => void; after?: (k: number, sql: string, handle: Handle) => void };
export type Meter = { start(): void; stop(): void; count(): number; restore(): void; /** Runs `fn` uncounted (the harness's own reads). */ aside<T>(fn: () => T): T;
  /** Puts another handle on the same count, so a row can kill or fail at its statements too (D7). Returns its restore. */ attach(other: DatabaseSync): () => void };
/** Counts each statement the connection executes (every run/get/all of a prepared statement, every exec) while started. One count spans
 * every attached handle: statement k is the k-th statement of the scenario, whichever handle ran it. */
export function instrument(db: DatabaseSync, hooks: Hooks = {}): Meter {
  let n = 0, active = false;
  const step = <T>(handle: Handle, sql: string, fn: () => T): T => {
    if (!active) return fn();
    const k = ++n;
    hooks.before?.(k, sql, handle);
    const result = fn();
    hooks.after?.(k, sql, handle);
    return result;
  };
  const patch = (target: DatabaseSync, handle: Handle): (() => void) => {
    const raw = target as unknown as { prepare: (sql: string) => Record<string, (...a: unknown[]) => unknown>; exec: (sql: string) => unknown };
    const prepare = raw.prepare.bind(target), exec = raw.exec.bind(target);
    raw.prepare = (sql: string) => {
      const s = prepare(sql);
      for (const method of ['run', 'get', 'all']) { const real = s[method]!.bind(s); s[method] = (...a: unknown[]) => step(handle, sql, () => real(...a)); }
      return s;
    };
    raw.exec = (sql: string) => step(handle, sql, () => exec(sql));
    return () => { raw.prepare = prepare; raw.exec = exec; };
  };
  const restore = patch(db, 'main');
  return { start() { active = true; }, stop() { active = false; }, count: () => n, restore,
    aside<T>(fn: () => T): T { const was = active; active = false; try { return fn(); } finally { active = was; } },
    attach: other => patch(other, 'foreign') };
}
export class InjectedBusy extends Error {
  code = 'ERR_SQLITE_ERROR'; errcode = 5; errstr = 'database is locked';
  constructor() { super('database is locked'); }
}

/** The guard state before the delete. `present`: installed and the collector quiet. `absent`: every install fails. `retry`: the install
 * failed once, 20 s ago; a whole pass without guards went over X while it had its check; the delete then happens with no guards and the
 * install succeeds 10 s later, well inside the 30 s the collector waits after a pass that found nothing. (D8 has no earlier use of the
 * connection: its one failure is the first install after the delete.) The failing stage is one of the three, by path. */
function before(db: DatabaseSync, path: Path, guard: Guard): void {
  const stage = (PATHS.indexOf(path) % 3) as 0 | 1 | 2;
  setSessionCollectorInstallFaultForTest(guard === 'present' ? 0 : guard === 'absent' ? Infinity : 1, stage);
  if (path === 'D8') return; // the connection's first use is the delete itself
  if (guard === 'retry') sessionCollector(db, clock.now - 20_000);
  if (path === 'D4') { sessionCollector(db, clock.now); return; } // the lap is the deletion path: it has not run yet
  for (let n = 0; n < 6; n++) collectSessionChecksSlice(db, clock.now);
  const st = sessionCollector(db, clock.now);
  if (guard === 'present' && !(st.guards && st.orphans.done)) throw new Error('harness: the collector was not quiet before the delete');
  if (guard !== 'present' && st.guards) throw new Error('harness: guards were installed in a state that has none');
  if (path === 'D10') st.goneCap = 4;
}
function remove(db: DatabaseSync, file: string, path: Path, meter: Meter): void {
  if (path === 'D1') deleteSessionChecks(db, KEY);
  else if (path === 'D2') noteSessionFrame(db, KEY, true);
  else if (path === 'D5') db.prepare("INSERT INTO memory_receipt_lines(bundle_id,thread_no,first_lsn,session_no) VALUES('bundle-x',1,1,7)").run();
  else if (path === 'D6') db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES('thread','engine',?,'set-1')").run(X);
  else if (path === 'D7') {
    // the second connection is on the same meter: a row kills right after its DELETE committed, or makes that DELETE throw SQLITE_BUSY
    const other = new DatabaseSync(file), detach = meter.attach(other);
    try { other.exec('PRAGMA busy_timeout=10000'); other.prepare('DELETE FROM memory_session_checks WHERE native_session=?').run(X); } finally { detach(); other.close(); }
  } else if (path === 'D8') {
    db.exec('BEGIN');
    try { deleteSessionChecks(db, KEY); db.exec('COMMIT'); } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  } else if (path === 'D10') db.prepare("DELETE FROM memory_session_checks WHERE native_session LIKE 'ov%' OR native_session=?").run(X);
  // D3 and D4: the collector's own slices do it
}
/** Runs one scenario on an open connection. `swallow` is the one error a fail row injects: the caller of a real tick reports and goes on. */
export function runScenario(db: DatabaseSync, file: string, path: Path, guard: Guard, meter: Meter, swallow?: Error): void {
  clock.now = T0;
  before(db, path, guard);
  const guarded = <T>(fn: () => T): void => { try { fn(); } catch (error) { if (error !== swallow) throw error; } };
  meter.start();
  guarded(() => remove(db, file, path, meter));
  for (let n = 0; n < SLICES; n++) { clock.now += STEP; guarded(() => collectSessionChecksSlice(db, clock.now)); }
  meter.stop();
}
/** H-R3 7.2 assertion (1): slices enough for one cycle to queue, the queue to drain, a second cycle to cache, and 30 s without guards. */
export function settleSlices(sessions: number, gonePages: number): number {
  return 2 * Math.ceil(sessions / P) + gonePages + Math.ceil(30_000 / STEP) + 10;
}
