// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The age-key table (schema.ts RECORD_KEYS_SCHEMA, 1.0.3 lane 2 r3): the key every record is ordered by, newest first, in owner search
// and browse. Made empty at open; the triggers key every record written from then on. The records already there are keyed here, by a
// backfill in slices on the main connection, each slice one short transaction (stopped after the chunk that crosses the time budget,
// never near the 50 ms a send may wait) that also records the rowid it got to, so a stop anywhere resumes after the last slice that
// committed. A row is keyed at most once (the key table's primary key). Between slices the loop is handed back on a real timer; a
// slice waits while the owner is in a turn or typing (owner-first.ts) and while a writer hold is in force (it waits for the gate,
// never takes it). Until the backfill is done, owner search runs in its preparing mode (owner-list.ts) and browse reads the records
// table as before.
//
// Write budget (1.0.3 rehearsal: 1,190 MB/min in the first minute of a rebuild after "Prepare to reinstall 1.0.2" dropped the table; the
// slices were time-sliced and owner-first gated, but nothing bounded their bytes). Maintenance class: the revoke marker's figure and
// mechanism (revoke-budget.ts, 20 MB a sliding minute). A ledger of dated charges, one estimate C of the WAL bytes a keyed record costs
// (seeded and capped at RECORD_KEYS_CHANGE_CEILING_FRAMES frames, measured on the backfill's own BEGIN..COMMIT through the WAL index, a
// rows-weighted running average), a slice admitted only when the minute has room for its least rows at C and capped at that room, and
// each slice charged what it wrote (its measured bytes, or rows x C when nothing could be measured), dated at its commit, out of the
// ledger 60 s later. Slices still run only while the owner is idle (the owner-first gate and the busy check) and never take the writer
// gate. The rebuild logs its start and end: records, MB written, duration (no record content).
//
// The backfill walks memory_records by rowid ascending (write order, so records of one millisecond keep their write order) and
// allocates by the trigger's rules with rule 3 unbounded above (schema.ts ageKeyAllocationSql), so a history of any shape completes.
import type { DatabaseSync } from "node:sqlite";
import { awaitWriterGate, DEFAULT_BUSY_MS, isDatabaseBusy, setBusy } from "../database.ts";
import { ownerFirst, type OwnerFirstGate } from "../owner-first.ts";
import { ioBudget } from "../io-budget.ts";
import { frameBytes, REVOKE_WRITE_BUDGET, REVOKE_WRITE_WINDOW_MS, walIndexMark } from "./revoke-budget.ts";
import { ageKeyAllocationSql, ensureRecordKeys, RECORD_KEYS_BUILD, RECORD_KEYS_TABLE, recordKeysPresent, recordKeysReady } from "./schema.ts";

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
export const RECORD_KEYS_PAUSE_MS = 5;
export const RECORD_KEYS_LOCKED_RETRY_MS = 1000;

/** The backfill's write budget: bytes per sliding minute, the revoke budget's figure (maintenance class, not the 1 MB/min idle figure the
 * io report uses). Tests may change it. */
export const RECORD_KEYS_WRITE_BUDGET = { bytesPerMinute: REVOKE_WRITE_BUDGET.bytesPerMinute };
/** WAL frames a keyed record is charged at before anything is measured, and the most it is ever charged at: its leaf in the key table and
 * in each of its five indexes, and one more for the interior pages and the progress row a slice dirties. */
export const RECORD_KEYS_CHANGE_CEILING_FRAMES = 7;
/** The least C is lowered to, as a fraction of the ceiling. */
const RECORD_KEYS_COST_FLOOR = 1 / 64;
/** Records of memory in C's running average. */
const RECORD_KEYS_COST_MEMORY_ROWS = 8192;
/** The least slice admitted: one chunk. */
const RECORD_KEYS_MIN_SLICE = 64;

let budgetClock: () => number = () => Date.now();
const charges: Array<{ at: number; bytes: number }> = [];
let charged = 0;
let rowCost: number | null = null;
/** Test hooks: a fake clock for the ledger (none: the wall clock), and an empty ledger with C back at its seed. */
export function setRecordKeysBudgetClock(next?: () => number): void { budgetClock = next ?? (() => Date.now()); }
export function resetRecordKeysWriteBudget(): void { charges.length = 0; charged = 0; rowCost = null; }
function trimCharges(now: number): void { while (charges.length && charges[0]!.at <= now - REVOKE_WRITE_WINDOW_MS) charged -= charges.shift()!.bytes; }
/** Bytes the backfill was charged in the last minute. */
export function recordKeysBytesWritten(now: number = budgetClock()): number { trimCharges(now); return charged; }
function charge(bytes: number, now: number): void {
  if (!(bytes > 0)) return;
  trimCharges(now);
  const last = charges[charges.length - 1];
  if (last && last.at === now) last.bytes += bytes; else charges.push({ at: now, bytes });
  charged += bytes;
}
/** The most C is ever charged at, for this file's page size. */
export function recordKeysCostCeiling(db: DatabaseSync): number { return RECORD_KEYS_CHANGE_CEILING_FRAMES * frameBytes(db); }
/** C: the WAL bytes a keyed record is estimated at now. */
export function recordKeysCostPerRow(db: DatabaseSync): number { return rowCost ?? (rowCost = recordKeysCostCeiling(db)); }
function noteCost(db: DatabaseSync, bytes: number, rows: number): void {
  if (!(rows > 0) || !(bytes > 0)) return;
  const W = recordKeysCostCeiling(db), from = recordKeysCostPerRow(db);
  rowCost = Math.max(W * RECORD_KEYS_COST_FLOOR, Math.min(W, (from * RECORD_KEYS_COST_MEMORY_ROWS + bytes) / (RECORD_KEYS_COST_MEMORY_ROWS + rows)));
}
/** Records the next slice may key now (0: none; wait recordKeysWriteWaitMs). */
export function recordKeysRoom(db: DatabaseSync, now: number = budgetClock()): number {
  trimCharges(now);
  const room = Math.floor((RECORD_KEYS_WRITE_BUDGET.bytesPerMinute - charged) / recordKeysCostPerRow(db));
  return room >= RECORD_KEYS_MIN_SLICE ? room : 0;
}
/** Milliseconds until the least slice fits in the minute. */
export function recordKeysWriteWaitMs(db: DatabaseSync, now: number = budgetClock()): number {
  trimCharges(now);
  const need = Math.min(RECORD_KEYS_WRITE_BUDGET.bytesPerMinute, Math.ceil(RECORD_KEYS_MIN_SLICE * recordKeysCostPerRow(db)));
  let used = charged;
  if (used + need <= RECORD_KEYS_WRITE_BUDGET.bytesPerMinute) return 0;
  for (const entry of charges) {
    used -= entry.bytes;
    if (used + need <= RECORD_KEYS_WRITE_BUDGET.bytesPerMinute) return Math.max(1, entry.at + REVOKE_WRITE_WINDOW_MS - now);
  }
  return REVOKE_WRITE_WINDOW_MS;
}
/** Bytes the WAL gained between two index marks taken with the writer lock held from the first to the commit (revoke-budget.ts
 * endRevokeMeasure's rule), or null when nothing can be trusted. */
function walBytesBetween(db: DatabaseSync, from: ReturnType<typeof walIndexMark>, to: ReturnType<typeof walIndexMark>): number | null {
  if (!from || !to || (to.salt === from.salt ? to.mxFrame < from.mxFrame : to.mxFrame === 0)) return null;
  const per = frameBytes(db);
  const bytes = to.salt !== from.salt ? 32 + to.mxFrame * per : (to.mxFrame - from.mxFrame) * per + (from.mxFrame === 0 && to.mxFrame > 0 ? 32 : 0);
  return bytes > 0 ? bytes : null;
}

/** Takes the write lock with no wait. False when another connection holds it; the busy wait is back at its default either way. */
function beginNoWait(db: DatabaseSync): boolean {
  setBusy(db, 0);
  try { db.exec("BEGIN IMMEDIATE"); return true; }
  catch (error) { if (isDatabaseBusy(error)) return false; throw error; }
  finally { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ } }
}

/** Keys the record at `rowid` when it has no key yet (the backfill's rule set: the trigger's, rule 3 unbounded above). */
export function keyRecordSql(): string {
  return `INSERT INTO ${RECORD_KEYS_TABLE} SELECT r.id,r.version,r.scope_id,r.state,r.owner_pinned,r.kind,${ageKeyAllocationSql("r.created_at", false)} FROM memory_records r
 WHERE r.rowid=? AND NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} k WHERE k.record_id=r.id AND k.record_version=r.version)`;
}

/** One slice of the backfill: the next `rows` records by rowid after the recorded one, each keyed when it has no key, chunk by chunk
 * until `budgetMs`, and the rowid it got to recorded, all in one transaction. Returns whether every record is keyed. */
export function fillRecordKeysSlice(db: DatabaseSync, rows: number, options: { budgetMs?: number } = {}): { ready: boolean; read: number; keyed: number; busy?: true; walBytes?: number | null } {
  const budget = options.budgetMs ?? RECORD_KEYS_SLICE_TARGET_MS;
  if (!recordKeysPresent(db)) { if (db.isTransaction) return { ready: false, read: 0, keyed: 0, busy: true }; ensureRecordKeys(db); }
  const build = db.prepare(`SELECT ready,cursor_rowid FROM ${RECORD_KEYS_BUILD} WHERE id=1`).get();
  if (!build || Number(build.ready) === 1) return { ready: true, read: 0, keyed: 0 };
  const next = db.prepare("SELECT rowid AS rr,created_at AS at FROM memory_records WHERE rowid>? ORDER BY rowid LIMIT ?");
  const key = db.prepare(keyRecordSql());
  // The run of one millisecond: the record after one this slice keyed at the same created_at takes the next key up when it is free (one
  // probe; the gap walk of rule 3 would find the same key, after walking the run it just made), so a same-millisecond history is keyed
  // in time proportional to its length, not its square.
  const nextUp = db.prepare(`INSERT INTO ${RECORD_KEYS_TABLE} SELECT r.id,r.version,r.scope_id,r.state,r.owner_pinned,r.kind,?2 FROM memory_records r
 WHERE r.rowid=?1 AND NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} k WHERE k.record_id=r.id AND k.record_version=r.version) AND NOT EXISTS(SELECT 1 FROM ${RECORD_KEYS_TABLE} WHERE age_key=?2)`);
  const keyOf = db.prepare(`SELECT k.age_key AS k FROM memory_records r JOIN ${RECORD_KEYS_TABLE} k ON k.record_id=r.id AND k.record_version=r.version WHERE r.rowid=?`);
  let cursor = Number(build.cursor_rowid), runAt: number | null = null, runKey: number | null = null;
  const started = performance.now();
  let read = 0, keyed = 0, ended = false;
  if (!beginNoWait(db)) return { ready: false, read: 0, keyed: 0, busy: true };
  const mark = walIndexMark(db);
  try {
    while (read < rows) {
      const want = Math.min(RECORD_KEYS_CHUNK, rows - read);
      const chunk = next.all(cursor, want) as Array<{ rr: number; at: number }>;
      for (const row of chunk) {
        const at = Number(row.at);
        let done = 0;
        if (runAt === at && runKey !== null && runKey + 1 <= Number.MAX_SAFE_INTEGER) done = Number(nextUp.run(Number(row.rr), runKey + 1).changes);
        if (done) runKey! += 1; else { done = Number(key.run(Number(row.rr)).changes); if (done) { runAt = at; runKey = Number(keyOf.get(Number(row.rr))?.k); } }
        keyed += done; cursor = Number(row.rr);
      }
      read += chunk.length;
      if (chunk.length < want) { ended = true; break; }
      if (performance.now() - started >= budget) break;
    }
    if (ended) db.prepare(`UPDATE ${RECORD_KEYS_BUILD} SET ready=1,cursor_rowid=0 WHERE id=1`).run();
    else db.prepare(`UPDATE ${RECORD_KEYS_BUILD} SET cursor_rowid=? WHERE id=1`).run(cursor);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  return { ready: ended, read, keyed, walBytes: walBytesBetween(db, mark, walIndexMark(db)) };
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
  stats: { slices: number; maxSliceMs: number; lockedRetries: number; keyed: number; bytes: number; budgetWaits: number };
}

/** Starts the background backfill when the key table is missing or not ready. Never throws; a failure goes to `onError` and leaves the
 * file at its last committed slice. */
export function startRecordKeysBuild(db: DatabaseSync, options: RecordKeysBuildOptions = {}): RecordKeysBuild {
  const target = options.targetMs ?? RECORD_KEYS_SLICE_TARGET_MS, pause = Math.max(1, options.pauseMs ?? RECORD_KEYS_PAUSE_MS), busyPoll = Math.max(1, options.busyPollMs ?? 250);
  const gate = options.gate === undefined ? (process.env.VITEST ? null : ownerFirst) : options.gate;
  const admit = options.admit ?? awaitWriterGate;
  const stats = { slices: 0, maxSliceMs: 0, lockedRetries: 0, keyed: 0, bytes: 0, budgetWaits: 0 };
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
    timer = null;
    if (stopped) return;
    if (options.busy?.()) { state = "waiting"; later(busyPoll); return; }
    const admission = gate?.admit("owner-search-backfill");
    if (admission && !admission.admitted) { state = "waiting"; later(admission.retryInMs); return; }
    try { await admit(); } catch { /* a gate that fails holds nothing back */ }
    if (stopped) return;
    if ((db as { isTransaction?: boolean }).isTransaction) { later(pause); return; }
    // the write budget: a slice only when the minute has room for its least rows, and no more rows than the room holds
    let room: number;
    try { room = recordKeysRoom(db); } catch (error) { fail(error); return; }
    if (room === 0) { stats.budgetWaits++; state = "waiting"; later(Math.max(pause, recordKeysWriteWaitMs(db))); return; }
    state = "building";
    try {
      const t0 = performance.now();
      const per = recordKeysCostPerRow(db);
      let step: ReturnType<typeof fillRecordKeysSlice>;
      try { step = ioBudget.withSource(RECORD_KEYS_SOURCE, () => fillRecordKeysSlice(db, Math.min(size, room), { budgetMs: target })); }
      catch (error) {
        // a slice that failed after its BEGIN dirtied its pages all the same: charged at C for the rows it was admitted with
        charge(Math.ceil(Math.min(size, room) * per), budgetClock());
        throw error;
      }
      if (step.busy) { stats.lockedRetries++; state = "waiting"; later(pause); return; }
      const ms = performance.now() - t0;
      // charged what it wrote: the measured WAL bytes (and they move C), else its rows at C (a slice that read but keyed nothing still
      // wrote its progress row)
      const written = step.walBytes ?? Math.ceil(Math.max(1, step.keyed) * per);
      if (step.walBytes) noteCost(db, step.walBytes, Math.max(1, step.keyed));
      charge(written, budgetClock());
      stats.bytes += written;
      stats.slices++; stats.maxSliceMs = Math.max(stats.maxSliceMs, ms); stats.keyed += step.keyed;
      if (step.ready) {
        state = "built";
        say(`[memory] record keys rebuild done: ${stats.keyed} records keyed, ${mb(stats.bytes)} MB written, ${((performance.now() - began) / 1000).toFixed(1)} s, ${stats.slices} slices, ${stats.budgetWaits} budget waits`);
        try { options.onBuilt?.(); } catch { /* as above */ }
        end(true); return;
      }
      size = ms <= target ? Math.min(RECORD_KEYS_MAX_ROWS, Math.ceil(size * 1.25)) : Math.max(RECORD_KEYS_CHUNK, Math.floor(size / 2));
    } catch (error) {
      if (isDatabaseBusy(error)) { stats.lockedRetries++; later(RECORD_KEYS_LOCKED_RETRY_MS); return; }
      fail(error); return;
    }
    later(pause);
  };
  later(0);
  return { stop() { if (state === "waiting" || state === "building") state = "absent"; end(false); }, done, stats };
}
