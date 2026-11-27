// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: memory V2 lane H owns the session-proof collector (session-proof-schema.ts collect*, session-proof.ts seedSessionChecksSlice).
// Consumer: the recall upkeep tick (recall-view.ts, lane A) calls both and must find them free when nothing changed.
// Design: MEMORY-V2-DESIGN 4.7 and H-R3 (orphans are found from the rows; the lap marker, the guards and the done flag decide nothing about
// them). Witnesses: H-IDLE, H-ORPHAN, H-EXPIRY, H-LAP, H-SEED-IDLE, H-SEED-BACKOFF, H-PROVE-UNCHANGED, H-CRASH (its kill test is H-R3-RED1).
// The H-R3 witnesses for the other paths and the generated kill/fail matrix are in session-collector-r3.test.ts and
// session-collector-matrix-*.test.ts.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { stopRecallViewMaintenance } from './recall-view.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { collectSessionChecksSlice, deleteSessionChecks, sessionCollector } from './session-proof-schema.ts';
import { proofModule, setupProofFixture, receipts } from './session-proof-fixture.ts';
import { DatabaseSync } from '../sqlite-open.ts';

const DAY = 24 * 60 * 60 * 1000;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });

/** Counts every statement the connection is asked to prepare or exec while `run` is going. */
function statements(db: DatabaseSync, run: () => void): number {
  const raw = db as unknown as { prepare: (sql: string) => unknown; exec: (sql: string) => unknown };
  const prepare = raw.prepare.bind(db), exec = raw.exec.bind(db);
  let count = 0;
  raw.prepare = (sql: string) => { count++; return prepare(sql); };
  raw.exec = (sql: string) => { count++; return exec(sql); };
  try { run(); } finally { raw.prepare = prepare; raw.exec = exec; }
  return count;
}
const CHECK = `INSERT INTO memory_session_checks(thread_id,driver_instance,native_session,reader_key,up_to,log_seq,recall_epoch,view_id,view_generation,view_digest,policy_revision,deletion_epoch,footprint,cites,seeding,checked)
 VALUES(?,'engine',?,'reader',1,0,0,NULL,NULL,NULL,1,0,'[]',?,0,?)`;
const LINEAGE = "INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES(?,'engine',?,1,2)";
function session(db: DatabaseSync, name: string, options: { lineage?: boolean; cites?: number; messages?: number; checked?: number } = {}) {
  const { lineage = true, cites = 0, messages = 0, checked = Date.now() } = options;
  if (lineage) db.prepare(LINEAGE).run('thread', name);
  db.prepare(CHECK).run('thread', name, cites, checked);
  for (let n = 0; n < cites; n++) db.prepare("INSERT INTO memory_session_check_cites VALUES('thread','engine',?,'record',?,1,'bundle')").run(name, `r${n}`);
  for (let n = 0; n < messages; n++) db.prepare("INSERT INTO memory_session_check_messages VALUES('thread','engine',?,'source',?)").run(name, `m${n}`);
}
const count = (db: DatabaseSync, table: string, name?: string) =>
  Number(db.prepare(`SELECT count(*) AS n FROM ${table}${name ? ' WHERE native_session=?' : ''}`).get(...(name ? [name] : []))!.n);
/** Runs the paced orphan lap to its end on the injected clock (a step is one second). */
function finishLap(db: DatabaseSync, start: number): number {
  let now = start;
  for (let step = 0; step < 200; step++, now += 1500) collectSessionChecksSlice(db, now);
  return now;
}
/** Lets the orphan cycle end and cache (H-R3 3.3): a few slices at one instant. */
function quiet(db: DatabaseSync, now: number): void { for (let n = 0; n < 6; n++) collectSessionChecksSlice(db, now); }

// H-R3 section 6 amends H-IDLE: 0 statements over any idle window shorter than 30 s, and one read of data_version per 30 s (another
// connection's delete has no other way to be noticed until lane W's foreign-commit wake exists).
it('H-IDLE: a collector tick over an unchanged connection issues no statement (one data_version read per 30 s), and one change costs a bounded read', () => {
  const db = database();
  for (let n = 0; n < 300; n++) session(db, `s${String(n).padStart(3, '0')}`, { cites: 2, messages: 1, lineage: n % 2 === 0 });
  const start = Date.now();
  let now = finishLap(db, start);
  expect(count(db, 'memory_session_checks')).toBe(150);
  quiet(db, now);
  expect(sessionCollector(db, now).orphans.done).toBe(true);
  now += 30_000;
  collectSessionChecksSlice(db, now); // the 30 s look is taken here, so the window below starts right after one
  const idle = statements(db, () => { for (let n = 0; n < 500; n++) collectSessionChecksSlice(db, now + n * 59); });
  expect(idle).toBe(0);
  const seen: string[] = [];
  const raw = db as unknown as { prepare: (sql: string) => unknown }, prepare = raw.prepare.bind(db);
  raw.prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
  try { for (let n = 0; n < 500; n++) collectSessionChecksSlice(db, now + 30_000 + n); } finally { raw.prepare = prepare; }
  expect(seen).toEqual(['PRAGMA data_version']);
  now += 31_000;
  // one write is answered by one read, not by a lap
  db.prepare("UPDATE memory_session_checks SET checked=checked+1 WHERE native_session='s000'").run();
  const one = statements(db, () => collectSessionChecksSlice(db, now));
  expect(one).toBeGreaterThan(0);
  expect(one).toBeLessThanOrEqual(3);
  expect(statements(db, () => { for (let n = 0; n < 100; n++) collectSessionChecksSlice(db, now); })).toBe(0);
});

it('H-ORPHAN: the cites and messages of a check that was deleted are gone one slice later, however much live history sorts before them', () => {
  const db = database();
  collectSessionChecksSlice(db);
  for (let n = 0; n < 40; n++) session(db, `a${String(n).padStart(2, '0')}`, { cites: 30, messages: 5 });
  session(db, 'zz-ended', { cites: 3, messages: 2 });
  const live = count(db, 'memory_session_check_cites') - 3;
  deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: 'zz-ended' });
  collectSessionChecksSlice(db);
  expect(count(db, 'memory_session_check_cites', 'zz-ended')).toBe(0);
  expect(count(db, 'memory_session_check_messages', 'zz-ended')).toBe(0);
  // and nothing of a live session went with it
  expect(count(db, 'memory_session_check_cites')).toBe(live);
  expect(count(db, 'memory_session_check_messages')).toBe(40 * 5);
});

it('H-ORPHAN: a session that still has another reader check keeps its cites', () => {
  const db = database();
  collectSessionChecksSlice(db);
  session(db, 'shared', { cites: 3, messages: 2 });
  db.prepare(CHECK.replace("'reader'", "'second-reader'")).run('thread', 'shared', 3, Date.now());
  db.prepare("DELETE FROM memory_session_checks WHERE reader_key='reader'").run();
  collectSessionChecksSlice(db);
  expect(count(db, 'memory_session_check_cites', 'shared')).toBe(3);
  expect(count(db, 'memory_session_check_messages', 'shared')).toBe(2);
});

it('H-ORPHAN: a deleted check with more dependents than one page is cleared page by page, one slice each, not in the deleting transaction', () => {
  const db = database();
  collectSessionChecksSlice(db);
  session(db, 'big', { cites: 300, messages: 0 });
  const before = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
  deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: 'big' });
  expect(Number(db.prepare('SELECT total_changes() AS n').get()!.n) - before).toBe(1);
  const pages: number[] = [];
  for (let n = 0; n < 6; n++) { collectSessionChecksSlice(db); pages.push(count(db, 'memory_session_check_cites', 'big')); }
  expect(pages).toEqual([172, 44, 0, 0, 0, 0]);
});

it('H-EXPIRY: expiry is a deadline at min(checked)+30 days: nothing is read before it, the first slice after it removes the check and its rows', () => {
  const db = database();
  const t0 = Date.now();
  session(db, 'old', { cites: 2, messages: 2, checked: t0 - 10 * DAY });
  session(db, 'new', { cites: 2, messages: 2, checked: t0 });
  quiet(db, t0);
  // nothing about expiry is read before the deadline; the one statement of the first tick after a long gap is the data_version read (H-R3 6)
  const read = (now: number) => {
    const seen: string[] = [], raw = db as unknown as { prepare: (sql: string) => unknown }, prepare = raw.prepare.bind(db);
    raw.prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
    try { collectSessionChecksSlice(db, now); } finally { raw.prepare = prepare; }
    return seen;
  };
  const LOOK = ['PRAGMA data_version'];
  expect(read(t0 + 19 * DAY)).toEqual(LOOK);
  expect(statements(db, () => { for (let n = 0; n < 100; n++) collectSessionChecksSlice(db, t0 + 19 * DAY); })).toBe(0);
  expect(collectSessionChecksSlice(db, t0 + 21 * DAY)).toBe(1);
  expect(count(db, 'memory_session_checks')).toBe(1);
  collectSessionChecksSlice(db, t0 + 21 * DAY);
  expect(count(db, 'memory_session_check_cites', 'old')).toBe(0);
  expect(count(db, 'memory_session_check_cites', 'new')).toBe(2);
  quiet(db, t0 + 21 * DAY); // the expiry was a deletion: the orphan cycle runs once more and caches
  expect(read(t0 + 29 * DAY)).toEqual(LOOK);
  expect(statements(db, () => { for (let n = 0; n < 100; n++) collectSessionChecksSlice(db, t0 + 29 * DAY); })).toBe(0);
  expect(collectSessionChecksSlice(db, t0 + 31 * DAY)).toBe(1);
  expect(count(db, 'memory_session_checks')).toBe(0);
  quiet(db, t0 + 31 * DAY);
  expect(read(t0 + 40 * DAY)).toEqual(LOOK);
  expect(statements(db, () => { for (let n = 0; n < 100; n++) collectSessionChecksSlice(db, t0 + 40 * DAY); })).toBe(0);
});

it('H-EXPIRY: a check written after the collector went idle is still found when it expires', () => {
  const db = database();
  const t0 = Date.now();
  quiet(db, t0);
  expect(statements(db, () => collectSessionChecksSlice(db, t0))).toBe(0);
  session(db, 'late', { checked: t0 + DAY });
  expect(collectSessionChecksSlice(db, t0 + 40 * DAY)).toBe(1);
});

// H-R3 3.5: the lap ends the checks without a lineage; rows with no check (a stray cite here, and the rows of the checks the lap ended) are the
// orphan cycle's. The end state asserted is the one the lap alone used to reach.
it('H-LAP: checks without a lineage go in one lap, which is then written down and not run again; rows with no check go in the orphan cycle', () => {
  const db = database();
  session(db, 'live', { cites: 2 });
  session(db, 'legacy', { lineage: false, cites: 2, messages: 2 });
  db.prepare("INSERT INTO memory_session_check_cites VALUES('thread','engine','stray','record','x',1,'bundle')").run();
  db.prepare("INSERT INTO memory_scopes VALUES('lap-scope','bot','lap','[]',0)").run();
  const now = finishLap(db, Date.now());
  expect(count(db, 'memory_session_checks')).toBe(1);
  expect(count(db, 'memory_session_check_cites')).toBe(2);
  expect(count(db, 'memory_session_check_messages')).toBe(0);
  const marker = db.prepare("SELECT subject_type,subject_id,intent FROM memory_scope_bindings WHERE id='memory-v2:session-orphans'").get();
  expect(marker).toMatchObject({ subject_type: 'system', subject_id: 'session-orphan-lap' });
  // a later start (a new connection) that finds the marker does not lap again
  closeDatabase();
  const next = database();
  session(next, 'legacy2', { lineage: false, cites: 1 });
  finishLap(next, now);
  expect(count(next, 'memory_session_checks', 'legacy2')).toBe(1);
});

it('H-LAP: the lap is paced: one step a second, one page a step', () => {
  const db = database();
  for (let n = 0; n < 400; n++) session(db, `s${String(n).padStart(3, '0')}`, { lineage: false });
  const t0 = Date.now();
  collectSessionChecksSlice(db, t0);
  const first = count(db, 'memory_session_checks');
  expect(first).toBeLessThan(400);
  for (let n = 0; n < 300; n++) collectSessionChecksSlice(db, t0 + 500); // the first step's own cleanup, and no further step
  expect(count(db, 'memory_session_checks')).toBe(first);
  expect(statements(db, () => { for (let n = 0; n < 50; n++) collectSessionChecksSlice(db, t0 + 500); })).toBe(0);
  collectSessionChecksSlice(db, t0 + 1001);
  expect(count(db, 'memory_session_checks')).toBeLessThan(first);
});

it('H-SEED-IDLE: once the seed answers "nothing to seed", ticks cost no statement until a receipt, a session or a checkpoint changes', async () => {
  const f = setupProofFixture('direct'), p = await proofModule(), db = database();
  await receipts(f, 2);
  expect(p.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: true })).toEqual({ kind: 'resume' });
  for (let n = 0; n < 6; n++) p.seedSessionChecksSlice();
  collectSessionChecksSlice(db);
  const idle = statements(db, () => { for (let n = 0; n < 200; n++) p.seedSessionChecksSlice(); });
  expect(idle).toBe(0);
  await receipts(f, 1);
  expect(statements(db, () => p.seedSessionChecksSlice())).toBeGreaterThan(0);
});

// H-R3 3.2: a full queue drops the key and the orphan cycle finds it again from the rows (there is no second lap any more).
it('H-LAP: more deleted checks than the event queue holds are not lost: the orphan cycle finds them again and clears their rows', () => {
  const db = database();
  db.prepare("INSERT INTO memory_scopes VALUES('lap-scope','bot','lap','[]',0)").run();
  let now = finishLap(db, Date.now());
  const insert = db.prepare(CHECK), cite = db.prepare("INSERT INTO memory_session_check_cites VALUES('thread','engine',?,'record','r',1,'bundle')");
  db.exec('BEGIN');
  for (let n = 0; n < 4300; n++) { const name = `bulk${n}`; db.prepare(LINEAGE).run('thread', name); insert.run('thread', name, 1, Date.now()); cite.run(name); }
  db.exec('COMMIT');
  db.exec('DELETE FROM memory_session_checks');
  expect(count(db, 'memory_session_check_cites')).toBe(4300);
  for (let step = 0; step < 6000 && count(db, 'memory_session_check_cites') > 0; step++, now += 1500) collectSessionChecksSlice(db, now);
  expect(count(db, 'memory_session_check_cites')).toBe(0);
});

it('H-LAP: a marker written by another release does not count: the lap runs again for a new build', () => {
  const before = process.env.MURAGE_APP_VERSION;
  try {
    process.env.MURAGE_APP_VERSION = 'release-a';
    const db = database();
    db.prepare("INSERT INTO memory_scopes VALUES('lap-scope','bot','lap','[]',0)").run();
    const now = finishLap(db, Date.now());
    expect(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-v2:session-orphans'").get()!.intent)).toContain('release-a');
    closeDatabase();
    const same = database();
    session(same, 'stray-a', { lineage: false });
    finishLap(same, now);
    expect(count(same, 'memory_session_checks', 'stray-a')).toBe(1);
    closeDatabase();
    process.env.MURAGE_APP_VERSION = 'release-b';
    const next = database();
    finishLap(next, now);
    expect(count(next, 'memory_session_checks', 'stray-a')).toBe(0);
  } finally { if (before === undefined) delete process.env.MURAGE_APP_VERSION; else process.env.MURAGE_APP_VERSION = before; }
});

it('H-SEED-IDLE: an empty answer at the end of a pass that began after a resumed session is not final: the next tick looks again from the start', async () => {
  const f = setupProofFixture('direct'), p = await proofModule(), db = database();
  await receipts(f, 2);
  expect(p.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: true })).toEqual({ kind: 'resume' });
  db.exec('DELETE FROM memory_session_checks');
  const calls: number[] = [];
  for (let n = 0; n < 5; n++) calls.push(statements(db, () => { p.seedSessionChecksSlice(); }));
  // 1: seeds the session; 2: nothing after it, the pass wraps; 3: looks again from the start; then idle
  expect(calls[0]).toBeGreaterThan(0);
  expect(calls[1]).toBeGreaterThan(0);
  expect(calls[2]).toBeGreaterThan(0);
  expect(calls[3]).toBe(0);
  expect(calls[4]).toBe(0);
});

it('H-SEED-BACKOFF: a seed attempt that fails is not repeated every tick; it waits, and a new receipt ends the wait', async () => {
  const f = setupProofFixture('direct'), p = await proofModule(), db = database();
  await receipts(f, 2);
  expect(p.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: true })).toEqual({ kind: 'resume' });
  db.exec('DELETE FROM memory_session_checks');
  let attempts = 0;
  p.setSessionProofCommitFaultForTest?.(() => { attempts++; throw new Error('SQLITE_BUSY'); });
  const tick = () => { try { p.seedSessionChecksSlice(); } catch { /* the upkeep tick reports and goes on */ } };
  try {
    for (let n = 0; n < 40; n++) tick();
    expect(attempts).toBe(1);
    const real = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(real + 1500);
    try {
      for (let n = 0; n < 40; n++) tick();
      expect(attempts).toBe(2);
      // the second wait is longer than the first (1 s, then 2 s)
      clock.mockReturnValue(real + 1500 + 1500);
      for (let n = 0; n < 40; n++) tick();
      expect(attempts).toBe(2);
      clock.mockReturnValue(real + 1500 + 2100);
      for (let n = 0; n < 40; n++) tick();
      expect(attempts).toBe(3);
    } finally { clock.mockRestore(); }
    // a receipt is an event: the wait ends at once
    p.setSessionProofCommitFaultForTest?.(undefined);
    await receipts(f, 1);
    p.setSessionProofCommitFaultForTest?.(() => { attempts++; throw new Error('SQLITE_BUSY'); });
    tick();
    expect(attempts).toBe(4);
  } finally { p.setSessionProofCommitFaultForTest?.(undefined); }
});

it('H-PROVE-UNCHANGED: the proof (proveRetainedSession and everything it calls in this file) is byte-identical to the base build', () => {
  const source = readFileSync(fileURLToPath(new URL('./session-proof.ts', import.meta.url)), 'utf8');
  const from = source.indexOf('/** The only retained-session decision.'), to = source.indexOf('/** One bounded session slice');
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const region = source.slice(from, to);
  // sha256 of the same region of f6ae52c670 (rewriting any line of the proof, including its comments, changes it; lane H never edits it)
  expect(createHash('sha256').update(region).digest('hex')).toBe('649cc6ad9e4aff92e509ae04d9054320412b21e3eeca4418884e7306b55d4a30');
});

/** A real process that opens the store, ends two sessions' checks and one reader's check of a third, and runs the collector, killed (SIGKILL) right after its `kill`-th committed write (1 = the checks' delete);
 * -1 runs to the end and exits. Nothing it held in memory survives the kill. */
const CRASH_CHILD = `
const [dbUrl, schemaUrl, kill] = process.argv.slice(1);
const { database } = await import(dbUrl), { collectSessionChecksSlice, deleteSessionChecks } = await import(schemaUrl);
const db = database(), limit = Number(kill);
let writes = 0;
const prepare = db.prepare.bind(db);
const boundary = () => { if (writes >= 0 && ++writes === limit) process.kill(process.pid, 'SIGKILL'); };
db.prepare = (sql) => { const s = prepare(sql); if (!/^\\s*(DELETE|INSERT|UPDATE)/i.test(sql)) return s; const run = s.run.bind(s); s.run = (...a) => { const r = run(...a); boundary(); return r; }; return s; };
let now = Date.now();
collectSessionChecksSlice(db, now); // the upkeep tick ran before the reset
// the three ends commit together (write 1), so every kill leaves the same intent behind
db.exec('BEGIN'); writes = -1;
for (const name of ['big', 'small']) deleteSessionChecks(db, { threadId: 'thread', driverInstance: 'engine', nativeSession: name });
db.prepare("DELETE FROM memory_session_checks WHERE native_session='shared' AND reader_key='reader'").run();
db.exec('COMMIT'); writes = 0; boundary();
for (let n = 0; n < 40; n++, now += 1500) collectSessionChecksSlice(db, now);
process.stdout.write('writes=' + writes);
process.exit(0);
`;
const CRASH_AT = Date.now(); // every run builds the same rows, so two end states compare byte for byte
function crashRun(kill: number): { status: number | null; signal: string | null; stdout: string; stderr: string } {
  const db = database();
  db.prepare("INSERT INTO memory_scopes VALUES('lap-scope','bot','lap','[]',0)").run();
  for (let n = 0; n < 5; n++) session(db, `live${n}`, { cites: 4, messages: 2, checked: CRASH_AT });
  session(db, 'big', { cites: 300, messages: 140, checked: CRASH_AT });
  session(db, 'small', { cites: 3, messages: 2, checked: CRASH_AT });
  session(db, 'shared', { cites: 3, messages: 1, checked: CRASH_AT });
  db.prepare(CHECK.replace("'reader'", "'second-reader'")).run('thread', 'shared', 3, CRASH_AT);
  finishLap(db, Date.now()); // this build's lap is done and written down before the crash
  closeDatabase();
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', CRASH_CHILD,
    new URL('../database.ts', import.meta.url).href, new URL('./session-proof-schema.ts', import.meta.url).href, String(kill)],
  { encoding: 'utf8', timeout: 60_000, env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR } });
  expect(child.error, child.stderr).toBeUndefined();
  return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
}
/** The same build starts again (its lap marker is there) and runs its collector until it is quiet. */
function restartState(): string {
  const db = database();
  finishLap(db, Date.now());
  const dump = ['memory_session_checks', 'memory_session_check_cites', 'memory_session_check_messages']
    .map(table => JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3,4,5`).all()));
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  return dump.join('\n');
}

// H-R3-RED1 (ASTRA 1587 on 22bf92a4ef): the marker of this build is written before the kill, so nothing but the rows can name the work.
it('H-CRASH / H-R3-RED1: a kill at every write boundary of ending checks and clearing their rows, then a restart of the same build, ends where an uninterrupted run ends', () => {
  const full = crashRun(-1);
  expect(full.status, full.stdout + full.stderr).toBe(0);
  const writes = Number(/writes=(\d+)/.exec(full.stdout)![1]);
  const expected = restartState();
  // the uninterrupted end: the two ended sessions' rows are gone except the shared session's (it keeps a reader), all live rows stay
  expect(expected).not.toContain('"native_session":"big"');
  expect(expected).not.toContain('"native_session":"small"');
  expect(expected).toContain('"native_session":"shared"');
  expect(writes).toBeGreaterThanOrEqual(6); // the checks' delete, then each page of each ended session
  const ends: Record<number, string> = {};
  for (let kill = 1; kill <= writes; kill++) {
    const run = crashRun(kill);
    if (kill < writes) expect(run.signal, `kill ${kill}: ${run.stdout}`).toBe('SIGKILL');
    ends[kill] = restartState();
  }
  const differ = Object.entries(ends).filter(([, end]) => end !== expected).map(([kill]) => Number(kill));
  expect(differ).toEqual([]);
}, 600_000);

it('H-CRASH: the orphan cycle reads one bounded window of sessions a slice, never their rows, finds rows a delete without guards left, then is quiet', () => {
  const db = database();
  db.prepare("INSERT INTO memory_scopes VALUES('lap-scope','bot','lap','[]',0)").run();
  for (let n = 0; n < 400; n++) session(db, `s${String(n).padStart(3, '0')}`, { cites: 20, messages: 3 });
  let now = finishLap(db, Date.now());
  // the lap ends even though its two dependent walks (8,000 and 1,200 rows) wrap on different steps
  expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-v2:session-orphans'").get()).toBeDefined();
  closeDatabase();
  // another process ended two sessions without this build's guards (an older build, a worker) and was gone
  const other = new DatabaseSync(join(DATA_DIR, 'messages.db'));
  other.exec('PRAGMA busy_timeout=10000');
  other.exec("DELETE FROM memory_session_checks WHERE native_session IN ('s007','s390')");
  other.exec("INSERT INTO memory_session_check_messages VALUES('thread','engine','words-only','source','w0')"); // a session with messages and no cites
  other.close();
  const next = database();
  const raw = next as unknown as { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown } };
  const prepare = raw.prepare.bind(next);
  let reads = 0;
  raw.prepare = (sql: string) => {
    const s = prepare(sql), get = s.get.bind(s), all = s.all.bind(s);
    s.get = (...a) => { reads++; return get(...a); };
    s.all = (...a) => { const rows = all(...a); reads += Math.max(1, rows.length); return rows; };
    return s;
  };
  const perSlice: number[] = [];
  try {
    for (let n = 0; n < 30; n++, now += 1500) { reads = 0; collectSessionChecksSlice(next, now); perSlice.push(reads); }
  } finally { raw.prepare = prepare; }
  // 800 distinct sessions (two tables), one window of at most 128 sessions a slice (plus the start's expiry and marker reads), 9,200 rows never read
  expect(Math.max(...perSlice), perSlice.join(" ")).toBeLessThanOrEqual(128 + 8);
  // a cycle is 4 windows a table; the first one finds the three sessions, so only the second one can be cached (H-R3 3.3 b): 16 windows.
  // A walk by row would need 8,000 / 128 = 63 slices for the cites alone.
  expect(perSlice.filter(n => n > 0).length).toBeGreaterThanOrEqual(14);
  expect(perSlice.filter(n => n > 0).length).toBeLessThanOrEqual(18);
  expect(count(next, 'memory_session_check_cites', 's007')).toBe(0);
  expect(count(next, 'memory_session_check_messages', 's390')).toBe(0);
  expect(count(next, 'memory_session_check_messages', 'words-only')).toBe(0);
  expect(count(next, 'memory_session_check_cites')).toBe(398 * 20);
  expect(statements(next, () => { for (let n = 0; n < 200; n++) collectSessionChecksSlice(next, now); })).toBe(0);
});

it('H-CRASH: a connection whose guards could not be installed never caches: it cycles again every 30 s, so its own deletes do not wait for a restart', () => {
  const db = database();
  db.prepare("INSERT INTO memory_scopes VALUES('lap-scope','bot','lap','[]',0)").run();
  session(db, 'kept', { cites: 2, messages: 1 });
  session(db, 'ended', { cites: 2, messages: 1 });
  const install = vi.spyOn(db, 'function').mockImplementation(() => { throw new Error('no registered functions here'); });
  try {
    let now = finishLap(db, Date.now());
    expect(sessionCollector(db, now).guards).toBe(false);
    expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-v2:session-orphans'").get()).toBeDefined();
    db.prepare("DELETE FROM memory_session_checks WHERE native_session='ended'").run();
    for (let n = 0; n < 60; n++, now += 1500) collectSessionChecksSlice(db, now);
    expect(count(db, 'memory_session_check_cites', 'ended')).toBe(0);
    expect(count(db, 'memory_session_check_messages', 'ended')).toBe(0);
    expect(count(db, 'memory_session_check_cites', 'kept')).toBe(2);
    expect(sessionCollector(db, now).orphans.done).toBe(false);
  } finally { install.mockRestore(); }
});
