// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner-tail table (schema.ts OWNER_TAIL_SCHEMA): the never-indexed records owner search reads newest first (1.0.2 msearch2).
//
// An earlier build made a partial index here instead, in ONE `CREATE INDEX` that read every record while the writer gate held every
// foreground write back (up to 3 s for a send, msearch2 r2c P1). Nothing here holds the writers. Making the table and its triggers
// reads no record (a schema change of a few pages); from then on the triggers keep it for every record written, changed or deleted.
// The records that were already there are added by a backfill in slices: each slice is one short transaction on the main connection
// (stopped after the chunk that crosses BACKFILL_SLICE_TARGET_MS, never near the 50 ms a send may wait), which also records the record
// key it got to, so a stop anywhere resumes after the last slice that committed. Between slices the loop is handed back on a real
// timer; a slice waits while the owner is in a turn or typing (the owner-first gate, owner-first.ts) and while a writer hold is in force
// (it waits for the gate, it never takes it). Until the backfill is done owner search reads the newest records for these kinds and says
// that it did (owner-list.ts).
import type { DatabaseSync } from "node:sqlite";
import { awaitWriterGate, DEFAULT_BUSY_MS, isDatabaseBusy, setBusy } from "../database.ts";
import { ownerFirst, type OwnerFirstGate } from "../owner-first.ts";
import { LEGACY_OWNER_TAIL_INDEX, OWNER_TAIL_BUILD, OWNER_TAIL_KINDS_SQL, OWNER_TAIL_SCHEMA, OWNER_TAIL_TABLE, ownerTailPresent, ownerTailReady } from "./schema.ts";

/** Where the background backfill of this process stands: nothing to do, waiting for a quiet moment, filling, done, or failed (the next start carries on). */
export type OwnerTailIndexState = "absent" | "waiting" | "building" | "built" | "failed";
let state: OwnerTailIndexState = "absent";
export function ownerTailIndexBuildState(): OwnerTailIndexState { return state; }

/** Time budget of one slice's transaction: the slice ends after the chunk that crosses it. */
export const OWNER_TAIL_SLICE_TARGET_MS = 5;
/** Records one slice starts with, the most it grows to, and the size of the chunks it checks the clock between. */
export const OWNER_TAIL_START_ROWS = 256;
export const OWNER_TAIL_MAX_ROWS = 4096;
const OWNER_TAIL_CHUNK = 64;
/** The pause between slices (a real timer), and the retry after a lock held by another connection. */
export const OWNER_TAIL_PAUSE_MS = 5;
export const OWNER_TAIL_LOCKED_RETRY_MS = 1000;

const lockedError = isDatabaseBusy;
/** The lock wait of the backfill's write transactions: none. A slice that meets another writer returns at once and the loop tries again
 * after its next pause, so the event loop never sits in a synchronous busy wait (the handle's usual wait is 1 s). */
export const OWNER_TAIL_BUSY_MS = 0;

/** Takes the write lock with no wait. False when another connection holds it; the busy wait is back at its default either way. */
function beginNoWait(db: DatabaseSync): boolean {
  setBusy(db, OWNER_TAIL_BUSY_MS);
  try { db.exec("BEGIN IMMEDIATE"); return true; }
  catch (error) { if (lockedError(error)) return false; throw error; }
  finally { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ } }
}

const legacyIndexPresent = (db: DatabaseSync): boolean => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(LEGACY_OWNER_TAIL_INDEX);

/** Drops the partial index an earlier development build made in place of the table. It is no longer read by anything; the drop frees
 * pages of a history-sized index (secure_delete rewrites them), so it is never part of a slice and runs only as its own step once the
 * table is ready, behind the same gates as the backfill. Takes the lock with no wait: "busy" means try again later. */
export function dropLegacyOwnerTailIndex(db: DatabaseSync): "dropped" | "none" | "busy" {
  if (!legacyIndexPresent(db)) return "none";
  if (!beginNoWait(db)) return "busy";
  try { db.exec(`DROP INDEX IF EXISTS ${LEGACY_OWNER_TAIL_INDEX}`); db.exec("COMMIT"); }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  return "dropped";
}

/** Makes the table and its triggers when they are not there (no record is read), taking the lock with no wait; false when it is held elsewhere. A file with no records is complete at once. */
export function createOwnerTail(db: DatabaseSync): boolean {
  if (ownerTailPresent(db)) return true;
  if (!beginNoWait(db)) return false;
  try {
    db.exec(OWNER_TAIL_SCHEMA);
    const empty = !db.prepare("SELECT 1 FROM memory_records LIMIT 1").get();
    db.prepare(`INSERT INTO ${OWNER_TAIL_BUILD}(id,ready,cursor_id,cursor_version) VALUES(1,?,NULL,NULL)`).run(empty ? 1 : 0);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  return true;
}

/** One slice of the backfill: the next records in key order after the recorded key, the ones of the owner-tail kinds added, chunk by
 * chunk until `budgetMs`, and the key it got to recorded, all in one transaction. Returns whether the table is ready. */
export function fillOwnerTailSlice(db: DatabaseSync, rows: number, options: { budgetMs?: number } = {}): { ready: boolean; read: number; busy?: true } {
  const budget = options.budgetMs ?? OWNER_TAIL_SLICE_TARGET_MS;
  if (!createOwnerTail(db)) return { ready: false, read: 0, busy: true };
  const build = db.prepare(`SELECT ready,cursor_id,cursor_version FROM ${OWNER_TAIL_BUILD} WHERE id=1`).get();
  if (!build || Number(build.ready) === 1) return { ready: true, read: 0 };
  const first = db.prepare(`SELECT id,version,created_at,${OWNER_TAIL_KINDS_SQL} AS tail FROM memory_records ORDER BY id,version LIMIT ?`);
  const after = db.prepare(`SELECT id,version,created_at,${OWNER_TAIL_KINDS_SQL} AS tail FROM memory_records WHERE (id,version)>(?,?) ORDER BY id,version LIMIT ?`);
  const add = db.prepare(`INSERT OR IGNORE INTO ${OWNER_TAIL_TABLE} VALUES(?,?,?)`);
  let cursor: [string, number] | null = build.cursor_id === null ? null : [String(build.cursor_id), Number(build.cursor_version)];
  const started = performance.now();
  let read = 0, ended = false;
  if (!beginNoWait(db)) return { ready: false, read: 0, busy: true };
  try {
    while (read < rows) {
      const want = Math.min(OWNER_TAIL_CHUNK, rows - read);
      const chunk = cursor ? after.all(cursor[0], cursor[1], want) : first.all(want);
      for (const row of chunk) if (Number(row.tail) === 1) add.run(Number(row.created_at), String(row.id), Number(row.version));
      read += chunk.length;
      if (chunk.length) { const last = chunk.at(-1)!; cursor = [String(last.id), Number(last.version)]; }
      if (chunk.length < want) { ended = true; break; }
      if (performance.now() - started >= budget) break;
    }
    if (ended) {
      db.prepare(`UPDATE ${OWNER_TAIL_BUILD} SET ready=1,cursor_id=NULL,cursor_version=NULL WHERE id=1`).run();
      // (The partial index an earlier development build made is dropped by its own step, dropLegacyOwnerTailIndex, never here.)
    } else {
      db.prepare(`UPDATE ${OWNER_TAIL_BUILD} SET cursor_id=?,cursor_version=? WHERE id=1`).run(cursor?.[0] ?? null, cursor?.[1] ?? null);
    }
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  return { ready: ended, read };
}

/** Runs the whole backfill now, slice after slice (tests, and a caller that has the time). */
export function fillOwnerTailNow(db: DatabaseSync): void {
  while (!fillOwnerTailSlice(db, OWNER_TAIL_MAX_ROWS, { budgetMs: Number.POSITIVE_INFINITY }).ready) { /* next slice */ }
}

export interface OwnerTailIndexBuildOptions {
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
export interface OwnerTailIndexBuild {
  stop(): void;
  done: Promise<boolean>;
  stats: { slices: number; maxSliceMs: number; lockedRetries: number };
}

/** Starts the background backfill when the owner-tail table is missing or not ready. Never throws; a failure goes to `onError` and leaves
 * the file at its last committed slice. */
export function startOwnerTailIndexBuild(db: DatabaseSync, options: OwnerTailIndexBuildOptions = {}): OwnerTailIndexBuild {
  const target = options.targetMs ?? OWNER_TAIL_SLICE_TARGET_MS, pause = Math.max(1, options.pauseMs ?? OWNER_TAIL_PAUSE_MS), busyPoll = Math.max(1, options.busyPollMs ?? 250);
  const gate = options.gate === undefined ? (process.env.VITEST ? null : ownerFirst) : options.gate;
  const admit = options.admit ?? awaitWriterGate;
  const stats = { slices: 0, maxSliceMs: 0, lockedRetries: 0 };
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, finish!: (built: boolean) => void;
  const done = new Promise<boolean>(resolve => { finish = resolve; });
  const end = (built: boolean) => { stopped = true; if (timer) clearTimeout(timer); timer = null; finish(built); };
  const fail = (error: unknown) => {
    state = "failed";
    try { options.onError?.(error instanceof Error ? error : new Error(String(error))); } catch { /* reporting never stops anything */ }
    end(false);
  };
  let tableReady = false;
  try {
    if (ownerTailReady(db)) {
      if (!legacyIndexPresent(db)) { state = "absent"; end(false); return { stop() {}, done, stats }; }
      tableReady = true;
    }
  } catch (error) { fail(error); return { stop() {}, done, stats }; }
  let size = OWNER_TAIL_START_ROWS;
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
    // A transaction some other code left open on this connection is not ours to join: try again shortly.
    if ((db as { isTransaction?: boolean }).isTransaction) { later(pause); return; }
    state = "building";
    try {
      if (tableReady) {
        // Ready: the one thing left is the legacy index, dropped here on its own with no lock wait, never in a slice.
        if (dropLegacyOwnerTailIndex(db) === "busy") { stats.lockedRetries++; later(OWNER_TAIL_LOCKED_RETRY_MS); return; }
        state = "built"; end(true); return;
      }
      const t0 = performance.now();
      const step = fillOwnerTailSlice(db, size, { budgetMs: target });
      if (step.busy) { stats.lockedRetries++; state = "waiting"; later(pause); return; }
      const ms = performance.now() - t0;
      stats.slices++; stats.maxSliceMs = Math.max(stats.maxSliceMs, ms);
      if (step.ready) {
        state = "built";
        try { options.onBuilt?.(); } catch { /* as above */ }
        tableReady = true;
        if (legacyIndexPresent(db)) { later(pause); return; }
        end(true); return;
      }
      size = ms <= target ? Math.min(OWNER_TAIL_MAX_ROWS, Math.ceil(size * 1.25)) : Math.max(OWNER_TAIL_CHUNK, Math.floor(size / 2));
    } catch (error) {
      if (lockedError(error)) { stats.lockedRetries++; later(OWNER_TAIL_LOCKED_RETRY_MS); return; }
      fail(error); return;
    }
    later(pause);
  };
  later(0);
  return { stop() { if (state === "waiting" || state === "building") state = "absent"; end(false); }, done, stats };
}
