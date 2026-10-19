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
// The backfill walks memory_records by rowid ascending (write order, so records of one millisecond keep their write order) and
// allocates by the trigger's rules with rule 3 unbounded above (schema.ts ageKeyAllocationSql), so a history of any shape completes.
import type { DatabaseSync } from "node:sqlite";
import { awaitWriterGate, DEFAULT_BUSY_MS, isDatabaseBusy, setBusy } from "../database.ts";
import { ownerFirst, type OwnerFirstGate } from "../owner-first.ts";
import { ioBudget } from "../io-budget.ts";
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
export function fillRecordKeysSlice(db: DatabaseSync, rows: number, options: { budgetMs?: number } = {}): { ready: boolean; read: number; keyed: number; busy?: true } {
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
  return { ready: ended, read, keyed };
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
}
export interface RecordKeysBuild {
  stop(): void;
  done: Promise<boolean>;
  stats: { slices: number; maxSliceMs: number; lockedRetries: number; keyed: number };
}

/** Starts the background backfill when the key table is missing or not ready. Never throws; a failure goes to `onError` and leaves the
 * file at its last committed slice. */
export function startRecordKeysBuild(db: DatabaseSync, options: RecordKeysBuildOptions = {}): RecordKeysBuild {
  const target = options.targetMs ?? RECORD_KEYS_SLICE_TARGET_MS, pause = Math.max(1, options.pauseMs ?? RECORD_KEYS_PAUSE_MS), busyPoll = Math.max(1, options.busyPollMs ?? 250);
  const gate = options.gate === undefined ? (process.env.VITEST ? null : ownerFirst) : options.gate;
  const admit = options.admit ?? awaitWriterGate;
  const stats = { slices: 0, maxSliceMs: 0, lockedRetries: 0, keyed: 0 };
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
    state = "building";
    try {
      const t0 = performance.now();
      const step = ioBudget.withSource(RECORD_KEYS_SOURCE, () => fillRecordKeysSlice(db, size, { budgetMs: target }));
      if (step.busy) { stats.lockedRetries++; state = "waiting"; later(pause); return; }
      const ms = performance.now() - t0;
      stats.slices++; stats.maxSliceMs = Math.max(stats.maxSliceMs, ms); stats.keyed += step.keyed;
      if (step.ready) {
        state = "built";
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
