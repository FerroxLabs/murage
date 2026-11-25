// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Producer owner: fix1022-revoke-ioerr (session-proof-schema.ts commitSign, memory-revocation.ts runner escalation); consumer owner: the memory
// revocation runner and every connection to messages.db in this process.
//
// 1.0.22 release gate (field report on 1.0.21): the revocation job threw "disk I/O error" on a healthy disk and retried forever, so a revoke
// never closed and every chat met checking:pending. Root cause: the session collector's commit sign (1.0.21, db1f87e27b) opened and CLOSED a
// descriptor on messages.db-shm on every slice. POSIX drops every fcntl lock a process holds on a file when ANY descriptor on it closes, and
// all of SQLite's WAL locks (read marks, writer, DMS) live on -shm: another process (a memory worker) then checkpoints and truncates the log
// under a live reader, whose next page read is past the end of the log (SQLITE_IOERR_SHORT_READ, "disk I/O error").
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { walFrameReader, walIndexReader } from '../io-written.ts';
import { closeDatabase, database } from '../database.ts';
import { stopSearchIndex } from '../message-search-index.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { ensureWorkspace } from '../workspace.ts';
import { ownerMemoryTicket } from './authority.ts';
import { awaitExactPendingCheck, settleRefusedFence } from './fence-pending.ts';
import { forgetMemory } from './forget.ts';
import { commitMemoryImport, previewMemoryImport } from './import.ts';
import { INLINE_REVOCATION, memoryRevocationStats, resetMemoryRevocationStats, stopMemoryRevocation, wakeIfStarted, wakeMemoryRevocation } from './memory-revocation.ts';
import { reconcileMemoryRoster } from './policy.ts';
import { REVOKE_PACE, REVOKE_PACE_COMMIT, REVOKE_WRITE_BUDGET, resetRevokeWriteBudget } from './revoke-budget.ts';
import { collectSessionChecksSlice } from './session-proof-schema.ts';

const FILE = () => `${DATA_DIR}/messages.db`;
const opened: DatabaseSync[] = [];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetMemoryRevocationStats(); });
afterEach(async () => {
  vi.useRealTimers(); stopMemoryRevocation(); vi.restoreAllMocks();
  for (const db of opened.splice(0)) { try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* broken on purpose */ } try { db.close(); } catch { /* closed */ } }
  closeDatabase(); await stopWalMaintenance();
});

/** A checkpoint from ANOTHER PROCESS (as a memory worker's connection is): [busy, log frames, checkpointed frames]. */
function foreignTruncate(file: string): number[] {
  const code = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { timeout: 200 });
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); process.stdout.write(JSON.stringify(Object.values(row))); db.close();`;
  const run = spawnSync(process.execPath, ['-e', code, file], { encoding: 'utf8', timeout: 30_000 });
  if (run.status !== 0) throw new Error(`foreign checkpoint failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as number[];
}
/** Rows big enough that a 1-page cache must read them back from the log frames. */
function fill(db: DatabaseSync, table: string, rows: number): void {
  db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY, b BLOB)`);
  db.exec('BEGIN'); const insert = db.prepare(`INSERT INTO ${table}(b) VALUES(randomblob(1000))`);
  for (let n = 0; n < rows; n++) insert.run();
  db.exec('COMMIT');
}

it('W-SHM-LOCK the session collector keeps this process\'s WAL locks: a foreign TRUNCATE checkpoint cannot cut the log under a live reader, whose read stays whole (no disk I/O error)', async () => {
  const db = database();
  await stopWalMaintenance(); // nothing in this process checkpoints behind the witness
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fill(db, 'w1022_rows', 2000); // ~2 MB of frames in the log, none copied
  expect(statSync(`${FILE()}-wal`).size).toBeGreaterThan(1_000_000);
  // a reader of this process (the server's own connections read like this) holds a snapshot that lives in the log
  const reader = new DatabaseSync(FILE()); opened.push(reader);
  reader.exec('PRAGMA cache_size=1'); reader.exec('BEGIN');
  expect(Number(reader.prepare('SELECT count(*) AS n FROM w1022_rows').get()!.n)).toBe(2000);
  // the production upkeep slices on the server connection: each one reads the commit sign (session-proof-schema.ts commitSign)
  const now = Date.now();
  for (let slice = 0; slice < 40; slice++) collectSessionChecksSlice(db, now + slice * 50);
  // another process checkpoints: with this process's read mark held it may copy the frames but never reset or truncate the log
  const [busy] = foreignTruncate(FILE());
  let read: unknown, failure: unknown = null;
  try { read = Number(reader.prepare('SELECT sum(length(b)) AS n FROM w1022_rows').get()!.n); } catch (error) { failure = error; }
  // base 435d038d9c: the slice's closeSync dropped the read mark, the foreign TRUNCATE ran (busy 0) and the reader's next page is past the
  // end of the truncated log: "disk I/O error"
  expect(failure === null ? null : String((failure as Error).message)).toBeNull();
  expect(read).toBe(2_000_000);
  expect(busy).toBe(1);
});

/** A connection whose log index names frames the log no longer has: every statement's first page read is past the end of the file, a
 * real and lasting SQLITE_IOERR_SHORT_READ (what the field log shows: the same "disk I/O error" on every retry for hours). */
function brokenConnection(): DatabaseSync {
  const db = database();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('CREATE TABLE w1022_tail(x)'); // page 1 (the schema) now lives only in the log
  truncateSync(`${FILE()}-wal`, 0); // the server connection keeps the index alive: no recovery runs for the next open
  const broken = new DatabaseSync(FILE(), { timeout: 50 }); opened.push(broken);
  let message = '';
  try { broken.prepare('SELECT count(*) FROM sqlite_schema').get(); } catch (error) { message = String((error as Error).message); }
  expect(message).toMatch(/disk I\/O error/);
  return broken;
}

it('W-REVOKE-IOERR-BOUNDED a revocation runner meeting a lasting disk I/O error escalates and parks after a bounded number of tries: no endless retry', async () => {
  const broken = brokenConnection();
  await stopWalMaintenance();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  wakeMemoryRevocation(() => broken, { retryMs: 5, pauseMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 2500));
  const lines = warn.mock.calls.map(call => String(call[0]));
  // the failure the runner met is the real one, SQLite's own storage message (the broken log reads as IOERR first, then NOTADB)
  expect(lines.some(line => /^\[memory\] revocation job: .*(disk I\/O error|file is not a database)/.test(line))).toBe(true);
  const after = memoryRevocationStats.errorRetries;
  // a queued revoke's wake and the M2 migration step's (wakeIfStarted, the commit bus) do not unpark it: the bound holds
  wakeIfStarted();
  await new Promise(resolve => setTimeout(resolve, 1500));
  // the behaviour first, on a stat base 435d038d9c has too: base keeps retrying (5 ms doubling, more tries every window), so it is RED here
  expect(memoryRevocationStats.errorRetries).toBe(after);
  expect((memoryRevocationStats as Record<string, number>).parkedNow).toBe(1);
  expect((memoryRevocationStats as Record<string, number>).storageParks).toBe(1);
  expect(lines.filter(line => line.includes('parked')).length).toBe(1);
});

it('W-REVOKE-IOERR-RESET a parked runner is reset by a direct wake (the start): a healed connection runs with no further failure', async () => {
  const broken = brokenConnection();
  await stopWalMaintenance();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let current: DatabaseSync = broken;
  wakeMemoryRevocation(() => current, { retryMs: 5, pauseMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 2500));
  // precondition is the behaviour the reset undoes: the runner stopped retrying (base 435d038d9c never stops, so it is RED here;
  // base has no park to reset; the reset itself is proven by M4 at the storageResets assertion below)
  const parkedAt = memoryRevocationStats.errorRetries;
  await new Promise(resolve => setTimeout(resolve, 1500));
  expect(memoryRevocationStats.errorRetries).toBe(parkedAt);
  expect((memoryRevocationStats as Record<string, number>).storageParks).toBe(1);
  // the storage heals (here: a recovered connection, as the next start has); a wake resets the parked runner, which drains an empty queue
  broken.close(); opened.splice(opened.indexOf(broken), 1);
  // the fixture's cut log also spoiled the file (the closing checkpoint read past its end), so the healed storage is a fresh data directory:
  // what is under test is the runner's reset, not a repair of the file
  closeDatabase(); await stopSearchIndex(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  current = database();
  const retries = memoryRevocationStats.errorRetries;
  wakeMemoryRevocation(() => current, undefined, true); // the owner's Forget (forget.ts) resumes like this; the start passes options
  await new Promise(resolve => setTimeout(resolve, 1500));
  // base 435d038d9c has no park and no reset; with the reset dropped the runner stays parked on the healed connection
  expect((memoryRevocationStats as Record<string, number>).storageResets).toBe(1);
  expect((memoryRevocationStats as Record<string, number>).parkedNow).toBe(0);
  expect(memoryRevocationStats.errorRetries).toBe(retries);
});

/** A real refusal as the send fence throws it for a chat whose memory is still being checked (send-fence.ts fenceRefusalDiagnosis). */
const refusal = { fence: { state: 'checking', reason: 'pending' } };
// Astra 73cbd5d493: every turn that met checking:pending woke the runner through these production waits, and the wake unparked it, so a
// lasting storage failure was retried once per turn forever. One row per wake site that is not the start or the owner's Forget.
const FENCE_WAKE_SITES: Array<[string, (db: DatabaseSync) => Promise<unknown>]> = [
  ['fence-pending.ts settleRefusedFence (a refused send re-prepares)', db => settleRefusedFence(db, refusal, () => false, 0)],
  ['fence-pending.ts awaitExactPendingCheck (a turn waits on its own pending check)', db => awaitExactPendingCheck(db, refusal, () => false, 0)],
];
it.each(FENCE_WAKE_SITES)('W-FENCE-WAKE %s on a runner parked by a lasting disk I/O error leaves it parked: no retry per turn', async (_site, enter) => {
  const broken = brokenConnection();
  await stopWalMaintenance();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  wakeMemoryRevocation(() => broken, { retryMs: 5, pauseMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 2500));
  const retries = memoryRevocationStats.errorRetries;
  // ten turns meet the hold and wait through the production fence (each wakes the runner), 100 ms apart
  for (let turn = 0; turn < 10; turn++) { await enter(broken); await new Promise(resolve => setTimeout(resolve, 100)); }
  await new Promise(resolve => setTimeout(resolve, 500));
  const stats = memoryRevocationStats as Record<string, number>;
  // base 435d038d9c: no park at all (resets/parked undefined, retries go on); 73cbd5d493: each turn's wake unparked it (resets 10)
  expect({ resets: stats.storageResets, parked: stats.parkedNow, retries: memoryRevocationStats.errorRetries - retries }).toEqual({ resets: 0, parked: 1, retries: 0 });
});

it('W-CLOSE-LOCK closing the server connection keeps the WAL locks of this process\'s other connections: a foreign TRUNCATE cannot cut the log under them', async () => {
  const db = database();
  await stopWalMaintenance();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fill(db, 'w1022_close', 2000);
  // another connection of this process (the checkpointer and search worker threads outlive the server handle) holds a log snapshot
  const reader = new DatabaseSync(FILE()); opened.push(reader);
  reader.exec('PRAGMA cache_size=1'); reader.exec('BEGIN');
  expect(Number(reader.prepare('SELECT count(*) AS n FROM w1022_close').get()!.n)).toBe(2000);
  // the production close (shutdown, data-writers.ts; a reopen, database.ts): it lets go of the io-budget shm readers (io-written.ts)
  closeDatabase();
  const [busy] = foreignTruncate(FILE());
  let read: unknown, failure: unknown = null;
  try { read = Number(reader.prepare('SELECT sum(length(b)) AS n FROM w1022_close').get()!.n); } catch (error) { failure = error; }
  // base 435d038d9c: the reader's close() closeSync'd its shm descriptor, the read mark went with it and the foreign TRUNCATE ran
  expect(failure === null ? null : String((failure as Error).message)).toBeNull();
  expect(read).toBe(2_000_000);
  expect(busy).toBe(1);
});

// Astra d2632b27f9 (memory-revocation.ts:1312, forget.ts:27): the three-reset limit is reached only by the runner's own reset deadlines (the
// deadline registry, revoke-wake.ts, raising RUNNER_WAKE at parkResetAt: onRunnerWake), and the owner's Forget is the real forgetMemory.
// The clock is faked so 5-minute resets take no real time; nothing below wakes the runner after its start except the Forget.
const RESET_MS = 5 * 60_000; // REVOKE_STORAGE_RESET_MS as shipped (written out: a mutant of the constant must not move the witness)
async function clock(ms: number): Promise<void> { for (let t = 0; t < ms; t += 1000) await vi.advanceTimersByTimeAsync(1000); }
/** Parks a runner on a lasting disk I/O error and lets its own reset deadlines run out. Returns the retries seen after each park's window. */
async function parkToLimit(broken: DatabaseSync): Promise<number[]> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date'] });
  wakeMemoryRevocation(() => broken, { retryMs: 5, pauseMs: 5 }); // the start at listen (index.ts passes options)
  const trace: number[] = [];
  await clock(1000); trace.push(memoryRevocationStats.errorRetries);
  for (let reset = 0; reset < 3; reset++) { await clock(RESET_MS); trace.push(memoryRevocationStats.errorRetries); }
  return trace;
}

it('W-REVOKE-IOERR-PARK-LIMIT a lasting disk I/O error: the runner\'s own reset deadline tries again at most three times, then it stays parked (no retry in 60 min of clock)', async () => {
  const broken = brokenConnection();
  await stopWalMaintenance();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const trace = await parkToLimit(broken);
  const atLimit = memoryRevocationStats.errorRetries;
  await clock(60 * 60_000);
  const stats = memoryRevocationStats as Record<string, number>;
  // the behaviour first, on a stat base 435d038d9c has too: base retries on (doubling to 60 s), so it is RED here; with the limit at
  // memory-revocation.ts:1312 dropped, the fourth park's own deadline resets it again 5 min later (RED here too)
  expect(memoryRevocationStats.errorRetries - atLimit).toBe(0);
  // each window: one park of REVOKE_STORAGE_PARK_AFTER failures, and only the park's own deadline started the next (3 of them)
  expect({ trace, parks: stats.storageParks, resets: stats.storageResets, parked: stats.parkedNow }).toEqual({ trace: [5, 10, 15, 20], parks: 4, resets: 3, parked: 1 });
  const parks = warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('parked'));
  expect(parks.length).toBe(4);
  expect(parks.at(-1)).toMatch(/tried again at the next start$/);
}, 120_000);

it('W-REVOKE-IOERR-FORGET past the three-reset limit, the owner\'s Forget (forgetMemory) resumes the parked runner: the Forget\'s own job runs to its end on healed storage', async () => {
  const broken = brokenConnection();
  await stopWalMaintenance();
  vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {});
  await parkToLimit(broken);
  const atLimit = memoryRevocationStats.errorRetries;
  await clock(60 * 60_000);
  // precondition is the state only the owner can now end: retries stopped for good (base 435d038d9c never stops, so it is RED here)
  expect(memoryRevocationStats.errorRetries - atLimit).toBe(0);
  vi.useRealTimers(); // the limit is reached; the rest runs on the real clock (no deadline of the runner is armed: parkResetAt is infinite)
  // the storage heals (a fresh data directory, as RESET: the cut log spoiled the file); the server connection is what the Forget hands over
  broken.close(); opened.splice(opened.indexOf(broken), 1);
  closeDatabase(); await stopSearchIndex(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const roster = { bots: [{ id: 'a', threadId: 'thread-a' }], groups: [] };
  reconcileMemoryRoster(roster);
  database().exec("UPDATE memory_meta SET mode='active'");
  await stopWalMaintenance();
  writeFileSync(join(ensureWorkspace('a'), 'MEMORY.md'), Array.from({ length: 40 }, (_, i) => `Line ${i}: the owner keeps ledger notes here\n`).join(''));
  commitMemoryImport(ownerMemoryTicket(), previewMemoryImport(ownerMemoryTicket(), [{ kind: 'bot', botId: 'a' }], roster).previewId, roster, true);
  const record = String(database().prepare('SELECT id FROM memory_records ORDER BY id LIMIT 1').get()!.id);
  const jobs = () => Number(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'").get()!.n);
  // fixture: the Forget's inline slice is spent before its first step (a busy machine), so its job is the runner's; the write pace is off
  const inline = INLINE_REVOCATION.ms, budget = REVOKE_WRITE_BUDGET.bytesPerMinute, pace = REVOKE_PACE.bytesPerMinute, rows = REVOKE_PACE_COMMIT.rows;
  INLINE_REVOCATION.ms = 0; REVOKE_WRITE_BUDGET.bytesPerMinute = Number.POSITIVE_INFINITY; REVOKE_PACE.bytesPerMinute = Number.POSITIVE_INFINITY; REVOKE_PACE_COMMIT.rows = 1_000_000; resetRevokeWriteBudget();
  try {
    const retries = memoryRevocationStats.errorRetries;
    expect(forgetMemory(ownerMemoryTicket(), { kind: 'record', id: record }).derivedCleanup).toBe('pending');
    for (let wait = 0; wait < 100 && jobs() > 0; wait++) await new Promise(resolve => setTimeout(resolve, 100));
    // with forget.ts:27's resume dropped, the Forget's wake is a no-op on the parked runner and its job row stays (RED here)
    expect(jobs()).toBe(0);
    const stats = memoryRevocationStats as Record<string, number>;
    expect({ resets: stats.storageResets, parked: stats.parkedNow, retries: memoryRevocationStats.errorRetries - retries }).toEqual({ resets: 4, parked: 0, retries: 0 });
  } finally {
    INLINE_REVOCATION.ms = inline; REVOKE_WRITE_BUDGET.bytesPerMinute = budget; REVOKE_PACE.bytesPerMinute = pace; REVOKE_PACE_COMMIT.rows = rows; resetRevokeWriteBudget();
  }
}, 120_000);

/** The descriptors this process has open on `path` (Linux /proc/self/fd), a deleted file's (" (deleted)") counted too; with `ino`, only
 * those on that inode (earlier tests of this file leave other descriptors on older, deleted sidecars at the same path); with `deleted`,
 * only those on a deleted file (once the old inode is freed the filesystem may give its number to the fresh sidecar at the same path). */
function descriptorsOn(path: string, ino?: bigint, deleted = false): number {
  return readdirSync('/proc/self/fd').filter(fd => {
    try { const link = readlinkSync(`/proc/self/fd/${fd}`); return (deleted ? link === `${path} (deleted)` : link.replace(/ \(deleted\)$/, '') === path) && (ino === undefined || statSync(`/proc/self/fd/${fd}`, { bigint: true }).ino === ino); } catch { return false; }
  }).length;
}
const LINUX = process.platform === 'linux';

it('W-SHM-RELEASE once SQLite deletes messages.db-shm (its last connection closed), the reopened database keeps no descriptor on the old sidecar: the collector and the WAL readers let it go (on Windows a held handle leaves it delete-pending and the next open fails ERROR_ACCESS_DENIED)', async () => {
  const db = database();
  await stopWalMaintenance(); // nothing in this process checkpoints behind the witness
  db.exec('CREATE TABLE w1022_release(x)'); db.exec('INSERT INTO w1022_release VALUES (1)');
  const shm = `${realpathSync(DATA_DIR)}/messages.db-shm`;
  // the production upkeep slices on the server connection: each one reads the commit sign through the -shm header (commitSign)
  const now = Date.now();
  for (let slice = 0; slice < 5; slice++) collectSessionChecksSlice(db, now + slice * 50);
  const old = statSync(shm, { bigint: true }).ino; // the sidecar inode this connection and the collector read
  if (LINUX) expect(descriptorsOn(shm, old)).toBeGreaterThan(0); // precondition: the sidecar is open (SQLite's own mapping, the collector's read)
  // the real close path: the server connection, the search index and the checkpointer
  closeDatabase(); await stopSearchIndex(); await stopWalMaintenance();
  // with no connection left the sidecar may go (SQLite's last read-write close deletes it; a read-only one closing last does not): the
  // fixture does what that close does, so the old inode is gone at the path on every run
  if (LINUX) expect(descriptorsOn(shm.slice(0, -4), statSync(shm.slice(0, -4), { bigint: true }).ino)).toBe(0); // precondition: no connection of this process is left on the database
  rmSync(shm, { force: true });
  expect(existsSync(shm)).toBe(false);
  // a later open of the same database: a fresh sidecar, the upkeep slice reads its header again
  const again = database(); await stopWalMaintenance();
  collectSessionChecksSlice(again, now + 1000);
  again.exec('INSERT INTO w1022_release VALUES (2)');
  expect(Number(again.prepare('SELECT count(*) AS n FROM w1022_release').get()!.n)).toBe(2);
  expect(existsSync(shm)).toBe(true);
  // ad0054df6c kept both descriptors for the life of the process (the collector's, io-written's): 2 on the deleted inode here
  if (LINUX) expect(descriptorsOn(shm, old, true)).toBe(0);
}, 60_000);

// SITES rows: each reader with its own stillKept guard (io-written.ts walFrameReader, walIndexReader), driven as the live reader. POSIX only (KEEP_SHM): Windows keeps no descriptor.
(process.platform === 'win32' ? it.skip : it).each([
  { site: 'walIndexReader', open: (file: string) => { const r = walIndexReader(file); return { read: () => r()?.mxFrame, close: r.close }; } },
  { site: 'walFrameReader', open: (file: string) => { const r = walFrameReader(file); return { read: () => r(), close: r.close }; } },
])('W-SHM-STALE $site: a kept -shm descriptor stays while its sidecar is at its path; once a reader close releases it (sidecar gone), a live reader never reads through the closed number the next open reuses for another file', ({ open }) => {
  const dir = join(DATA_DIR, 'stale'); mkdirSync(dir, { recursive: true });
  // two sidecars with different wal-index headers (frames, salt), copied while their writers are open; no SQLite connection is left on either copy
  const sidecar = (name: string, rows: number): number => {
    const db = new DatabaseSync(join(dir, `${name}-src.db`));
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x)');
      for (let i = 0; i < rows; i++) db.exec('INSERT INTO t VALUES (randomblob(1000))');
      copyFileSync(join(dir, `${name}-src.db-shm`), join(dir, `${name}.db-shm`));
    } finally { db.close(); }
    return readFileSync(join(dir, `${name}.db-shm`)).readUInt32LE(16);
  };
  expect(sidecar('own', 2)).not.toBe(sidecar('other', 9)); // precondition: the two headers are told apart
  const own = join(dir, 'own.db'), live = open(own), closing = walFrameReader(own);
  const decoys: number[] = [];
  try {
    const before = live.read(); // index reader: the frames in own's log; frame reader: bytes counted so far (own's header is its baseline)
    closing(); const kept = closing.fd()!;
    expect(kept).toBeDefined();
    closing.close();
    // no connection is on the sidecar, but it is still at its path (a thread could be opening it): the descriptor stays
    expect((() => { try { return fstatSync(kept).ino; } catch { return 'closed'; } })()).toBe(statSync(`${own}-shm`).ino);
    // moved away, the path names no inode: the next reader close releases it; moved back, the same inode is at the path again
    renameSync(`${own}-shm`, `${own}-shm.away`);
    walFrameReader(own).close();
    renameSync(`${own}-shm.away`, `${own}-shm`);
    // the next opens take the lowest free numbers: one of them gets the released number, on the other sidecar
    for (let i = 0; i < 256 && decoys.at(-1) !== kept; i++) decoys.push(openSync(join(dir, 'other.db-shm'), 'r'));
    expect(decoys.at(-1)).toBe(kept); // precondition: the released number now names the other sidecar
    expect(live.read()).toBe(before); // own's header again: no frames of another file read or counted
  } finally { live.close(); for (const fd of decoys) closeSync(fd); }
});

it.runIf(process.platform !== 'win32')('W-SHM-KEEP a reader close keeps the kept -shm descriptor while a connection of this process is still on that inode, even with the sidecar moved off its path (closing it would drop that connection\'s WAL locks)', () => {
  const dir = join(DATA_DIR, 'keep'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'keep.db'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1)');
    const reader = walFrameReader(file); reader(); const kept = reader.fd()!;
    expect(kept).toBeDefined();
    renameSync(`${file}-shm`, `${file}-shm.away`); // the path names no inode; SQLite's own descriptor (and its locks) stay on it
    try {
      reader.close();
      expect((() => { try { return fstatSync(kept).ino; } catch { return 'closed'; } })()).toBe(statSync(`${file}-shm.away`).ino);
    } finally { renameSync(`${file}-shm.away`, `${file}-shm`); }
    db.exec('INSERT INTO t VALUES (2)');
    expect(Number(db.prepare('SELECT count(*) AS n FROM t').get()!.n)).toBe(2);
  } finally { db.close(); }
});
