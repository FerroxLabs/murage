// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Age keys are rebuilt in short transactions, in rowid order, with a committed cursor. Every SQL operation is an indexed
// lookup or a LIMIT-bounded probe (I1). Each slice caps record steps, walk probes and time independently of history (I2).
// Continuation is seeded by the nearest surviving predecessor's value (I3). An in-process checkpoint resumes unfinished
// walks (I4); it is only a hint, and the sole insert verifies the key is free under the write lock (I5). Each slice advances
// the cursor or checkpoint (I6), preserving the row-by-row reference's keys without deletes (I7). Walk-only slices do not
// update progress and their trusted zero WAL measurement is free (I8). Search stays in preparing mode until ready.
//
// Admission and its compatibility wrappers share one formula (I9): reserve a record's overhead alongside the slice (I10),
// or admit one oversized atomic unit on an empty ledger (I11). Every charge carries its measured excess as whole-minute
// debt (I12). Blocked ticks sleep to the exact release (I13), which always admits a unit without further charges (I14).
// Ledger scans depend on the admitted write units in the budget window, never history size (I15). Owner-first and writer
// gates still run before every slice. A stop or failure leaves the cursor at the last committed record.
import type { DatabaseSync } from "node:sqlite";
import { awaitWriterGate, DEFAULT_BUSY_MS, isDatabaseBusy, setBusy } from "../database.ts";
import { ownerFirst, type OwnerFirstGate } from "../owner-first.ts";
import { ioBudget, IO_BUDGET_IDLE_BYTES_PER_MINUTE } from "../io-budget.ts";
import { frameBytes, REVOKE_WRITE_WINDOW_MS, walIndexMark } from "./revoke-budget.ts";
import { AGE_KEY_MAX, AGE_KEY_WINDOW, ageKeyAllocationSql, ensureRecordKeys, RECORD_KEYS_BUILD, RECORD_KEYS_TABLE, recordKeysPresent, recordKeysReady } from "./schema.ts";

export type RecordKeysBuildState = "absent" | "waiting" | "building" | "built" | "failed";
let state: RecordKeysBuildState = "absent";
export function recordKeysBuildState(): RecordKeysBuildState { return state; }

/** The source every statement of the backfill runs under, so a slow one is named. */
export const RECORD_KEYS_SOURCE = "record-keys-backfill";
/** Time budget of one slice's transaction: the slice ends after the chunk that crosses it. */
export const RECORD_KEYS_SLICE_TARGET_MS = 5;
/** Records one slice starts with, the most it grows to, and the chunk it checks the clock between. */
export const RECORD_KEYS_START_ROWS = 256;
export const RECORD_KEYS_MAX_ROWS = 2048;
const RECORD_KEYS_CHUNK = 64;
/** Maximum index entries per probe and probes per slice, including continuation work. */
export const RECORD_KEYS_WALK_KEYS = 128;
export const RECORD_KEYS_WALK_PROBES = 16;
export const RECORD_KEYS_PAUSE_MS = 5;
export const RECORD_KEYS_LOCKED_RETRY_MS = 1000;

/** WAL allowance per sliding minute. The remaining idle allowance covers checkpoint copies. Tests may change it. */
export const RECORD_KEYS_WRITE_BUDGET = { bytesPerMinute: IO_BUDGET_IDLE_BYTES_PER_MINUTE / 2 };
/** Normal WAL reservation cap per tick; larger pages may reserve one record plus transaction overhead. */
export const RECORD_KEYS_SLICE_WRITE_BYTES = 128 * 1024;
/** Conservative frames per keyed record: its table leaf, five index leaves, and interior/progress overhead. */
export const RECORD_KEYS_CHANGE_CEILING_FRAMES = 7;

let budgetClock: () => number = () => Date.now();
type Charge = { at: number; bytes: number; until: number };
// I15: for fixed budget B, reservation U = 2 * per and minimum positive charge m, the exact maximum is
// max(1, floor((B - U) / m) + 1): immediately before each admitted charge, earlier entries total <= B - U;
// each holds >= m bytes, and this charge adds at most one entry. Oversized mode (U > B) admits only an empty
// ledger. Expiry/merging only reduce the count; zero writes add none. Distinct-time minimum charges attain it.
// Measured WAL writes have m = frameBytes(db) (fallback reservations are larger), so at 4 KiB pages:
// B = 524288, U = 57680, m = 4120 => 114 entries; restricting charges to >= per = 28840 gives 17, not 12.
// The bound depends on budget/page size, never record history or debt duration.
const charges: Charge[] = [];
let charged = 0;
type WalkCheckpoint = { rowid: number; at: number; from: number };
let walkCheckpoints = new WeakMap<DatabaseSync, WalkCheckpoint>();
/** Test hooks: a fake clock for the ledger (none: the wall clock), and empty ledger/walk hints. */
export function setRecordKeysBudgetClock(next?: () => number): void { budgetClock = next ?? (() => Date.now()); }
export function resetRecordKeysWriteBudget(): void { charges.length = 0; charged = 0; walkCheckpoints = new WeakMap(); }
function trimCharges(now: number): void {
  for (let i = charges.length - 1; i >= 0; i--) {
    if (charges[i]!.until <= now) { charged -= charges[i]!.bytes; charges.splice(i, 1); }
  }
}
/** Bytes still held by the write ledger, including debt from oversized or over-ceiling writes. */
export function recordKeysBytesWritten(now: number = budgetClock()): number { trimCharges(now); return charged; }
function charge(bytes: number, now: number): void {
  if (!(bytes > 0)) return;
  trimCharges(now);
  const until = now + REVOKE_WRITE_WINDOW_MS * Math.max(1, Math.ceil(bytes / RECORD_KEYS_WRITE_BUDGET.bytesPerMinute));
  const last = charges[charges.length - 1];
  if (last && last.at === now && last.until === until) last.bytes += bytes; else charges.push({ at: now, bytes, until });
  charged += bytes;
}
/** Inject a synthetic measured write and return a detached ledger snapshot for admission property tests. */
export function chargeRecordKeysWriteForTest(bytes: number, now: number): readonly Readonly<Charge>[] {
  charge(bytes, now); return charges.map(entry => ({ ...entry }));
}
/** Conservative WAL bytes per keyed record, for this file's page size. */
export function recordKeysCostCeiling(db: DatabaseSync): number { return RECORD_KEYS_CHANGE_CEILING_FRAMES * frameBytes(db); }
/** Admission never learns a cheaper per-row cost: small slices cannot amortize page splits like large rebuilds. */
export function recordKeysCostPerRow(db: DatabaseSync): number { return recordKeysCostCeiling(db); }
/** Admit a bounded normal slice, or one indivisible oversized unit when all earlier debt has expired. */
export function recordKeysAdmission(db: DatabaseSync, now: number = budgetClock()): { rows: number; waitMs: number; oversized: boolean } {
  trimCharges(now);
  const budget = RECORD_KEYS_WRITE_BUDGET.bytesPerMinute, per = recordKeysCostPerRow(db), unit = 2 * per;
  const maxUntil = () => Math.max(now + 1, ...charges.map(c => c.until));
  if (unit > budget) return charged === 0 ? { rows: 1, waitMs: 0, oversized: true }
    : { rows: 0, waitMs: Math.max(1, maxUntil() - now), oversized: true };
  const tickBytes = Math.max(RECORD_KEYS_SLICE_WRITE_BYTES, unit);
  const rows = Math.floor((Math.min(budget - charged, tickBytes) - per) / per);
  if (rows >= 1) return { rows, waitMs: 0, oversized: false };
  let left = charged;
  for (const c of [...charges].sort((a, b) => a.until - b.until)) {
    left -= c.bytes;
    if (budget - left >= unit) return { rows: 0, waitMs: Math.max(1, c.until - now), oversized: false };
  }
  return { rows: 0, waitMs: Math.max(1, maxUntil() - now), oversized: false };
}
/** Compatibility accessors share admission's rows and exact release time. */
export function recordKeysRoom(db: DatabaseSync, now: number = budgetClock()): number { return recordKeysAdmission(db, now).rows; }
export function recordKeysWriteWaitMs(db: DatabaseSync, now: number = budgetClock()): number { return recordKeysAdmission(db, now).waitMs; }
/** Bytes the WAL gained between two index marks taken with the writer lock held from the first to the commit (revoke-budget.ts
 * endRevokeMeasure's rule), or null when nothing can be trusted. */
function walBytesBetween(db: DatabaseSync, from: ReturnType<typeof walIndexMark>, to: ReturnType<typeof walIndexMark>): number | null {
  if (!from || !to || (to.salt === from.salt ? to.mxFrame < from.mxFrame : to.mxFrame === 0)) return null;
  const per = frameBytes(db);
  const bytes = to.salt !== from.salt ? 32 + to.mxFrame * per : (to.mxFrame - from.mxFrame) * per + (from.mxFrame === 0 && to.mxFrame > 0 ? 32 : 0);
  return bytes >= 0 ? bytes : null;
}

/** Takes the write lock with no wait. False when another connection holds it; the busy wait is back at its default either way. */
function beginNoWait(db: DatabaseSync): boolean {
  setBusy(db, 0);
  try { db.exec("BEGIN IMMEDIATE"); return true; }
  catch (error) { if (isDatabaseBusy(error)) return false; throw error; }
  finally { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ } }
}

/** Reference only (age-order.test.ts): the original allocator. Never prepared or run by the backfill. */
export function keyRecordSql(): string {
  return `INSERT INTO ${RECORD_KEYS_TABLE} SELECT r.id,r.version,r.scope_id,r.state,r.owner_pinned,r.kind,${ageKeyAllocationSql("r.created_at", false)} FROM memory_records r
 WHERE r.rowid=? AND NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} k WHERE k.record_id=r.id AND k.record_version=r.version)`;
}

/** One bounded slice, under a single write lock. Unfinished rule-3 walks retain a process-local hint and leave the committed
 * cursor at the last finished record. Losing the hint only repeats bounded read work; every insert checks for a free key. */
export function fillRecordKeysSlice(db: DatabaseSync, rows: number, options: { budgetMs?: number } = {}): { ready: boolean; read: number; keyed: number; probed: number; walkPending?: true; busy?: true; walBytes?: number | null } {
  const budget = options.budgetMs ?? RECORD_KEYS_SLICE_TARGET_MS;
  if (!recordKeysPresent(db)) { if (db.isTransaction) return { ready: false, read: 0, keyed: 0, probed: 0, busy: true }; ensureRecordKeys(db); }
  const build = db.prepare(`SELECT ready,cursor_rowid FROM ${RECORD_KEYS_BUILD} WHERE id=1`).get();
  if (!build || Number(build.ready) === 1) return { ready: true, read: 0, keyed: 0, probed: 0 };
  const next = db.prepare("SELECT rowid AS rr,created_at AS at FROM memory_records WHERE rowid>? ORDER BY rowid LIMIT ?");
  const pred = db.prepare(`SELECT r.created_at AS at,k.age_key AS k FROM memory_records r LEFT JOIN ${RECORD_KEYS_TABLE} k
 ON k.record_id=r.id AND k.record_version=r.version WHERE r.rowid<=? ORDER BY r.rowid DESC LIMIT 1`);
  const isKeyed = db.prepare(`SELECT 1 FROM memory_records r JOIN ${RECORD_KEYS_TABLE} k ON k.record_id=r.id AND k.record_version=r.version WHERE r.rowid=?`);
  const base = `(CAST(? AS INTEGER)*${AGE_KEY_WINDOW})`, top = `(${base}+${AGE_KEY_WINDOW - 1})`;
  // Rules 1-3's cheap arms only: rule 3's gap search is the bounded, resumable walk below.
  const windowRule = db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} WHERE age_key BETWEEN ${base} AND ${top}) THEN ${base}
 WHEN NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} WHERE age_key=${top}) THEN (SELECT max(age_key)+1 FROM ${RECORD_KEYS_TABLE} WHERE age_key BETWEEN ${base} AND ${top})
 WHEN NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} WHERE age_key=${top}+1) THEN ${top}+1 ELSE NULL END AS k`.replaceAll("?", "?1"));
  const walk = db.prepare(`SELECT a.age_key AS k FROM ${RECORD_KEYS_TABLE} a WHERE a.age_key>? ORDER BY a.age_key LIMIT ?`);
  const put = db.prepare(`INSERT INTO ${RECORD_KEYS_TABLE} SELECT r.id,r.version,r.scope_id,r.state,r.owner_pinned,r.kind,?2 FROM memory_records r
 WHERE r.rowid=?1 AND NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} k WHERE k.record_id=r.id AND k.record_version=r.version) AND NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} WHERE age_key=?2)`);
  const startCursor = Number(build.cursor_rowid), savedCheckpoint = walkCheckpoints.get(db);
  let cursor = startCursor, runAt: number | null = null, runKey: number | null = null;
  const started = performance.now();
  let read = 0, keyed = 0, probed = 0, probes = 0, ended = false, walkPending: true | undefined;
  if (!beginNoWait(db)) return { ready: false, read: 0, keyed: 0, probed: 0, busy: true };
  const mark = walIndexMark(db);
  try {
    const p = pred.get(cursor);
    if (p) { runAt = Number(p.at); runKey = p.k === null ? null : Number(p.k); }
    const insert = (rowid: number, k: number) => {
      if (k > AGE_KEY_MAX) throw new Error("MEMORY_AGE_KEY_WINDOW");
      if (Number(put.run(rowid, k).changes) !== 1) throw new Error("MEMORY_RECORD_KEY_COLLISION");
    };
    slice: while (read < rows) {
      const want = Math.min(RECORD_KEYS_CHUNK, rows - read);
      const chunk = next.all(cursor, want) as Array<{ rr: number; at: number }>;
      for (const row of chunk) {
        const rr = Number(row.rr), at = Number(row.at);
        read++;
        let done = 0;
        if (runAt === at && runKey !== null && runKey < AGE_KEY_MAX) done = Number(put.run(rr, runKey + 1).changes);
        if (done) runKey!++;
        else if (!isKeyed.get(rr)) {
          let k = windowRule.get(at)?.k;
          if (k === null || k === undefined) {
            const top = Math.trunc(at) * AGE_KEY_WINDOW + AGE_KEY_WINDOW - 1;
            let from = runAt === at && runKey !== null && runKey > top ? runKey : top;
            const cp = walkCheckpoints.get(db);
            if (cp && cp.rowid === rr && cp.at === at) from = Math.max(from, cp.from);
            for (;;) {
              // A slice always gets its first probe for progress; further probes require both time and count room.
              if (probes >= RECORD_KEYS_WALK_PROBES || (probes > 0 && performance.now() - started >= budget)) {
                walkCheckpoints.set(db, { rowid: rr, at, from }); walkPending = true; break slice;
              }
              const found = walk.all(from, RECORD_KEYS_WALK_KEYS) as Array<{ k: number }>;
              probes++; probed += found.length;
              let candidate = from + 1;
              for (const entry of found) { if (Number(entry.k) !== candidate) break; candidate++; }
              const spent = performance.now() - started >= budget;
              if (candidate <= from + found.length || found.length < RECORD_KEYS_WALK_KEYS) { k = candidate; break; }
              from = candidate - 1;
              if (probes >= RECORD_KEYS_WALK_PROBES || spent) {
                walkCheckpoints.set(db, { rowid: rr, at, from }); walkPending = true; break slice;
              }
            }
          }
          insert(rr, Number(k)); runAt = at; runKey = Number(k); done = 1;
        }
        keyed += done; cursor = rr; walkCheckpoints.delete(db);
      }
      if (chunk.length < want) { ended = true; break; }
      if (performance.now() - started >= budget) break;
    }
    if (ended) db.prepare(`UPDATE ${RECORD_KEYS_BUILD} SET ready=1,cursor_rowid=0 WHERE id=1`).run();
    else if (cursor !== startCursor) db.prepare(`UPDATE ${RECORD_KEYS_BUILD} SET cursor_rowid=? WHERE id=1`).run(cursor);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    // Hints must not retain keys taken only by the rolled-back transaction.
    if (savedCheckpoint) walkCheckpoints.set(db, savedCheckpoint); else walkCheckpoints.delete(db);
    throw error;
  }
  return { ready: ended, read, keyed, probed, walkPending, walBytes: walBytesBetween(db, mark, walIndexMark(db)) };
}

/** Runs the whole backfill now, slice after slice (tests, and a caller that has the time). */
export function fillRecordKeysNow(db: DatabaseSync): void {
  while (!fillRecordKeysSlice(db, RECORD_KEYS_MAX_ROWS, { budgetMs: Number.POSITIVE_INFINITY }).ready) { /* next slice */ }
}

export interface RecordKeysBuildOptions {
  /** True while the owner is in a turn: the slice waits (on top of the owner-first gate). */
  busy?: () => boolean;
  /** The owner-first gate (default: the process's; null: none). */
  gate?: Pick<OwnerFirstGate, "admit"> | null;
  /** Waited before each slice (default: the writer gate, awaited, never held). */
  admit?: () => Promise<void>;
  targetMs?: number;
  pauseMs?: number;
  busyPollMs?: number;
  onBuilt?: () => void;
  onError?: (error: Error) => void;
  /** Where the start and end of a rebuild are reported (default: console.log). */
  log?: (line: string) => void;
}
export interface RecordKeysBuild {
  stop(): void;
  done: Promise<boolean>;
  stats: { slices: number; maxSliceMs: number; lockedRetries: number; keyed: number; bytes: number; budgetWaits: number; ticks: number };
}

/** Starts the background backfill when the key table is missing or not ready. Never throws; a failure goes to `onError` and leaves the
 * file at its last committed slice. */
export function startRecordKeysBuild(db: DatabaseSync, options: RecordKeysBuildOptions = {}): RecordKeysBuild {
  const target = options.targetMs ?? RECORD_KEYS_SLICE_TARGET_MS, pause = Math.max(1, options.pauseMs ?? RECORD_KEYS_PAUSE_MS), busyPoll = Math.max(1, options.busyPollMs ?? 250);
  const gate = options.gate === undefined ? (process.env.VITEST ? null : ownerFirst) : options.gate;
  const admit = options.admit ?? awaitWriterGate;
  const stats = { slices: 0, maxSliceMs: 0, lockedRetries: 0, keyed: 0, bytes: 0, budgetWaits: 0, ticks: 0 };
  const log = options.log ?? ((line: string) => console.log(line));
  const say = (line: string) => { try { log(line); } catch { /* reporting never stops anything */ } };
  const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
  let began = 0;
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, finish!: (built: boolean) => void;
  const done = new Promise<boolean>(resolve => { finish = resolve; });
  const end = (built: boolean) => { stopped = true; if (timer) clearTimeout(timer); timer = null; finish(built); };
  const fail = (error: unknown) => {
    state = "failed";
    try { options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* reporting never stops anything */ }
    end(false);
  };
  try { if (recordKeysReady(db)) { state = "built"; end(true); return { stop() {}, done, stats }; } }
  catch (error) { fail(error); return { stop() {}, done, stats }; }
  let size = RECORD_KEYS_START_ROWS;
  state = "waiting";
  began = performance.now();
  {
    // (the rowids left to walk, not a count(*): a scan of a million rows is not paid on the loop for a log line)
    let total = "unknown";
    try {
      const at = Number(db.prepare(`SELECT cursor_rowid AS c FROM ${RECORD_KEYS_BUILD} WHERE id=1`).get()?.c ?? 0);
      total = String(Math.max(0, Number(db.prepare("SELECT max(rowid) AS n FROM memory_records").get()?.n ?? 0) - at));
    } catch { /* only a report */ }
    say(`[memory] record keys rebuild started: about ${total} records to key, budget ${mb(RECORD_KEYS_WRITE_BUDGET.bytesPerMinute)} MB/min`);
  }
  const later = (ms: number) => { if (!stopped) { timer = setTimeout(() => { void tick(); }, ms); timer.unref?.(); } };
  const tick = async () => {
    stats.ticks++;
    timer = null;
    if (stopped) return;
    if (options.busy?.()) { state = "waiting"; later(busyPoll); return; }
    const admission = gate?.admit("owner-search-backfill");
    if (admission && !admission.admitted) { state = "waiting"; later(admission.retryInMs); return; }
    try { await admit(); } catch { /* a gate that fails holds nothing back */ }
    if (stopped) return;
    // a connection closed under the wait (shutdown, a restore) ends the build as stop() does, never an unhandled rejection; the next start carries on
    try { if ((db as { isTransaction?: boolean }).isTransaction) { later(pause); return; } }
    catch { if (state === "waiting" || state === "building") state = "absent"; end(false); return; }
    // the write budget: a slice only when the minute has room for its least rows, and no more rows than the room holds
    let a: ReturnType<typeof recordKeysAdmission>;
    try { a = recordKeysAdmission(db); } catch (error) { fail(error); return; }
    if (a.rows === 0) { stats.budgetWaits++; state = "waiting"; later(Math.max(pause, a.waitMs)); return; }
    state = "building";
    try {
      const t0 = performance.now();
      const per = recordKeysCostPerRow(db);
      let step: ReturnType<typeof fillRecordKeysSlice>;
      try { step = ioBudget.withSource(RECORD_KEYS_SOURCE, () => fillRecordKeysSlice(db, Math.min(size, a.rows), { budgetMs: target })); }
      catch (error) {
        // A failed slice can dirty pages too: charge its whole reservation, including transaction overhead.
        charge(Math.ceil((Math.min(size, a.rows) + 1) * per), budgetClock());
        throw error;
      }
      if (step.busy) { stats.lockedRetries++; state = "waiting"; later(pause); return; }
      const ms = performance.now() - t0;
      // Charge measured WAL bytes; if unreadable, charge the entire admitted reservation including transaction overhead.
      const written = step.walBytes ?? Math.ceil((Math.min(size, a.rows) + 1) * per);
      charge(written, budgetClock());
      stats.bytes += written;
      stats.slices++; stats.maxSliceMs = Math.max(stats.maxSliceMs, ms); stats.keyed += step.keyed;
      if (step.ready) {
        state = "built";
        say(`[memory] record keys rebuild done: ${stats.keyed} records keyed, ${mb(stats.bytes)} MB written, ${((performance.now() - began) / 1000).toFixed(1)} s, ${stats.slices} slices, ${stats.budgetWaits} budget waits`);
        try { options.onBuilt?.(); } catch { /* as above */ }
        end(true); return;
      }
      if (!step.walkPending) size = ms <= target ? Math.min(RECORD_KEYS_MAX_ROWS, Math.ceil(size * 1.25)) : Math.max(RECORD_KEYS_CHUNK, Math.floor(size / 2));
    } catch (error) {
      if (isDatabaseBusy(error)) { stats.lockedRetries++; later(RECORD_KEYS_LOCKED_RETRY_MS); return; }
      fail(error); return;
    }
    later(pause);
  };
  later(0);
  return { stop() { if (state === "waiting" || state === "building") state = "absent"; end(false); }, done, stats };
}
