// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keeps output lineage (memory schema v7) small.
// At start-up, before the server takes traffic (database.ts), with progress
// on the upgrade screen:
//  1. converts the full root sets a v6 file holds into parent + added
//     members, one small transaction per set, so a kill loses at most the
//     set in hand and the next start carries on from the cursor;
//  2. hands the freed pages back with one VACUUM, only when the disk has
//     room for it; short of room it is skipped, said in plain words, and
//     tried again at the next start. The upgrade never fails over it.
// In the background (the memory worker's idle sweep), only short steps that
// never hold the write lock for long: collecting sets nothing points at, a
// checkpoint that cuts the write-ahead log back (never waiting on a lock),
// and incremental vacuum where the file allows it. No step changes what any
// set holds: a converted set keeps its members and its content address.
import { statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { rootSetMembers } from "./schema.ts";

const SEP = "\u0000";
const key = (thread: string, message: string) => `${thread}${SEP}${message}`;

export type LineageStorageState = "converting" | "waiting-for-disk" | "idle";
export interface LineageStorageStatus {
  state: LineageStorageState;
  /** Root sets to look at in the conversion, and how many have been. */
  total: number; done: number;
  /** 0 to 100, for a progress bar; 100 when there is nothing to do. */
  percent: number;
  /** Bytes inside the file that are free and not yet handed back. */
  freeBytes: number;
  /** Bytes of the write-ahead log. */
  walBytes: number;
  /** Plain words for the owner when space is waiting on the disk. */
  message?: string;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}
function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}
function fileBytes(path: string): number { try { return statSync(path).size; } catch { return 0; } }
function mainFile(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA database_list").all().find(entry => entry.name === "main");
  return String(row?.file ?? "");
}
function compactionRow(db: DatabaseSync) {
  return hasTable(db, "memory_root_set_compaction") ? db.prepare("SELECT total,done,finished_at,reclaimed_at FROM memory_root_set_compaction WHERE id=1").get() : undefined;
}
const unset = (value: unknown) => value === null || value === undefined;
const WAITING_MESSAGE = "Murage made your memory smaller, but needs more free disk space to hand the space back. Free up some space and restart Murage; nothing is lost in the meantime.";

export function lineageStorageStatus(db: DatabaseSync): LineageStorageStatus {
  const file = mainFile(db);
  const freeBytes = pragmaNumber(db, "freelist_count") * pragmaNumber(db, "page_size");
  const walBytes = file ? fileBytes(`${file}-wal`) : 0;
  const row = compactionRow(db);
  const total = Number(row?.total ?? 0), done = Math.min(total, Number(row?.done ?? 0));
  const converting = Boolean(row) && unset(row!.finished_at);
  const waiting = Boolean(row) && !converting && unset(row!.reclaimed_at);
  return { state: converting ? "converting" : waiting ? "waiting-for-disk" : "idle", total, done,
    percent: converting ? (total ? Math.floor(done * 100 / total) : 0) : 100, freeBytes, walBytes, ...(waiting ? { message: WAITING_MESSAGE } : {}) };
}

export interface StepBudget { maxRows?: number; maxMs?: number; now?: () => number }
export interface StepResult { remaining: boolean; examined: number; converted: number; rows: number }

/** One bounded step of the v6 -> v7 conversion. Per thread, the sets its
 * replies and sessions point at, smallest first: a full set whose next
 * smaller set is a proper subset of it keeps only what it adds, with a parent
 * row. Anything else stays full (still a valid v7 set). Resumable: a set
 * already chained is skipped, and the cursor names the last thread done. */
export function compactRootSetsStep(db: DatabaseSync, budget: StepBudget = {}): StepResult {
  const { maxRows = 200_000, maxMs = 150, now = () => performance.now() } = budget;
  const result: StepResult = { remaining: false, examined: 0, converted: 0, rows: 0 };
  if (!hasTable(db, "memory_root_set_compaction")) return result;
  const state = db.prepare("SELECT total,done,cursor,finished_at FROM memory_root_set_compaction WHERE id=1").get();
  if (!state || (state.finished_at !== null && state.finished_at !== undefined)) return result;
  const started = now();
  // The cursor is the last thread finished, or \u0001{t, s, id}: inside thread t,
  // the last set looked at (sets go smallest first, then by id). Every set
  // looked at moves it, so a step always makes progress, however small its budget.
  let after = String(state.cursor ?? ""), within: { t: string; s: number; id: string } | null = null;
  if (after.startsWith("\u0001")) { within = JSON.parse(after.slice(1)) as { t: string; s: number; id: string }; }
  let done = Number(state.done ?? 0);
  const save = (cursor: string, finished = false) => db.prepare("UPDATE memory_root_set_compaction SET done=?,cursor=?,finished_at=? WHERE id=1")
    .run(finished ? Number(state.total) : Math.min(done, Number(state.total)), cursor, finished ? Date.now() : null);
  const nextThread = db.prepare(`SELECT thread_id FROM (SELECT thread_id FROM memory_output_roots WHERE thread_id>?1 ORDER BY thread_id LIMIT 1)
    UNION SELECT thread_id FROM (SELECT thread_id FROM memory_session_roots WHERE thread_id>?1 ORDER BY thread_id LIMIT 1) ORDER BY thread_id LIMIT 1`);
  const setsOf = db.prepare(`SELECT r.set_id,r.size FROM memory_root_sets r WHERE r.set_id IN (
      SELECT set_id FROM memory_output_roots WHERE thread_id=?1 AND set_id<>'' UNION SELECT set_id FROM memory_session_roots WHERE thread_id=?1 AND set_id<>'')
      AND (r.size>?2 OR (r.size=?2 AND r.set_id>?3))
    ORDER BY r.size,r.set_id`);
  const sizeOf = db.prepare("SELECT size FROM memory_root_sets WHERE set_id=?");
  const chained = db.prepare("SELECT 1 FROM memory_root_set_parents WHERE set_id=?");
  const rowsOf = db.prepare("SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=?");
  const dropAll = db.prepare("DELETE FROM memory_root_set_members WHERE set_id=?");
  const addOwn = db.prepare("INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?,value->>0,value->>1 FROM json_each(?)");
  const link = db.prepare("INSERT INTO memory_root_set_parents(set_id,parent_id) VALUES(?,?)");
  const count = db.prepare("SELECT count(*) AS n FROM memory_root_set_members WHERE set_id=?");
  for (;;) {
    let thread: string, previous: { id: string; size: number; members: Set<string> | null } | null = null, from = { s: -1, id: "" };
    if (within) {
      thread = within.t; from = { s: within.s, id: within.id };
      const size = sizeOf.get(within.id);
      if (size) previous = { id: within.id, size: Number(size.size), members: null };
      within = null;
    } else {
      const next = nextThread.get(after)?.thread_id;
      if (next === undefined || next === null) { save(after, true); return result; }
      thread = String(next);
    }
    for (const row of setsOf.all(thread, from.s, from.id)) {
      const id = String(row.set_id), size = Number(row.size);
      result.examined++; done++;
      if (chained.get(id)) previous = { id, size, members: null };
      else {
        const own = rowsOf.all(id).map(entry => key(String(entry.root_thread_id), String(entry.root_message_id)));
        result.rows += own.length;
        const members = new Set(own);
        if (previous && previous.size < size && members.size === size) {
          previous.members ??= rootSetMembers(db, previous.id);
          const inherited = previous.members;
          if (inherited && inherited.size === previous.size && [...inherited].every(member => members.has(member))) {
            db.exec("SAVEPOINT memory_root_set_compaction");
            try {
              // the set's rows become just what it adds to its parent
              dropAll.run(id);
              addOwn.run(id, JSON.stringify(own.filter(member => !inherited.has(member)).map(member => { const at = member.indexOf(SEP); return [member.slice(0, at), member.slice(at + 1)]; })));
              link.run(id, previous.id);
              if (Number(count.get(id)?.n) !== size - previous.size) throw new Error("MEMORY_ROOT_SET_COMPACTION_MISMATCH");
              db.exec("RELEASE memory_root_set_compaction");
              result.converted++; result.rows += inherited.size;
            } catch (error) { db.exec("ROLLBACK TO memory_root_set_compaction; RELEASE memory_root_set_compaction"); throw error; }
          }
        }
        previous = { id, size, members };
      }
      if (result.rows >= maxRows || now() - started >= maxMs) { save(`\u0001${JSON.stringify({ t: thread, s: size, id })}`); result.remaining = true; return result; }
    }
    after = thread;
    save(after);
    if (result.rows >= maxRows || now() - started >= maxMs) { result.remaining = true; return result; }
  }
}

/** Removes up to `limit` root sets nothing points at: no reply, no session,
 * no set chained to it. Returns how many went. */
export function collectRootSets(db: DatabaseSync, limit = 50): number {
  if (!hasTable(db, "memory_root_set_parents")) return 0;
  const ids = db.prepare(`SELECT r.set_id FROM memory_root_sets r WHERE NOT EXISTS (SELECT 1 FROM memory_output_roots o WHERE o.set_id=r.set_id)
    AND NOT EXISTS (SELECT 1 FROM memory_session_roots s WHERE s.set_id=r.set_id) AND NOT EXISTS (SELECT 1 FROM memory_root_set_parents p WHERE p.parent_id=r.set_id) LIMIT ?`).all(limit).map(row => String(row.set_id));
  if (!ids.length) return 0;
  db.exec("SAVEPOINT memory_root_set_collect");
  try {
    const json = JSON.stringify(ids);
    db.prepare("DELETE FROM memory_root_sets WHERE set_id IN (SELECT value FROM json_each(?))").run(json);
    db.prepare("DELETE FROM memory_root_set_parents WHERE set_id IN (SELECT value FROM json_each(?))").run(json);
    db.prepare("DELETE FROM memory_root_set_members WHERE set_id IN (SELECT value FROM json_each(?))").run(json);
    db.exec("RELEASE memory_root_set_collect");
  } catch (error) { db.exec("ROLLBACK TO memory_root_set_collect; RELEASE memory_root_set_collect"); throw error; }
  return ids.length;
}

/** The write-ahead log is cut back to nothing once it passes this (and at idle). */
export const WAL_TRUNCATE_BYTES = 64 * 1048576;
/** Free pages worth a VACUUM at start-up: past this, and past a fifth of the file. */
const RECLAIM_MIN_BYTES = 64 * 1048576;
const VACUUM_SPARE_BYTES = 256 * 1048576;
function diskFree(path: string): number | null {
  try { const stats = statfsSync(dirname(path)); return Number(stats.bavail) * Number(stats.bsize); } catch { return null; }
}

export type StartupStorageEvent = { phase: "converting"; done: number; total: number } | { phase: "reclaiming"; dbBytes: number };
export interface StartupStorageOptions {
  onProgress?: (event: StartupStorageEvent) => void;
  freeDiskBytes?: (path: string) => number | null;
  reclaimMinBytes?: number;
  reclaimFraction?: number;
  sliceMs?: number;
}
export interface StartupStorageResult { converted: boolean; vacuumed: boolean; skippedForDisk: boolean }

/** At start-up, before the server listens: finishes a pending conversion
 * (resumable, one transaction per set, progress after every slice), then
 * reclaims its space once with a VACUUM when the disk has room for the
 * rewrite. Never throws for want of disk: the VACUUM is skipped, the owner is
 * told in plain words (lineageStorageStatus), and the next start tries again. */
export function finishLineageStorageAtStartup(db: DatabaseSync, options: StartupStorageOptions = {}): StartupStorageResult {
  const result: StartupStorageResult = { converted: false, vacuumed: false, skippedForDisk: false };
  const row = compactionRow(db);
  if (!row) return result;
  const report = (event: StartupStorageEvent) => { try { options.onProgress?.(event); } catch { /* a status note never stops start-up */ } };
  if (unset(row.finished_at)) {
    // Lineage rows hold ids, never words, and the VACUUM below rewrites the
    // file: the conversion need not zero every page it frees.
    const secure = pragmaNumber(db, "secure_delete");
    db.exec("PRAGMA secure_delete=FAST");
    try {
    for (;;) {
      const step = compactRootSetsStep(db, { maxMs: options.sliceMs ?? 250 });
      const now = compactionRow(db)!;
      report({ phase: "converting", done: Math.min(Number(now.total), Number(now.done)), total: Number(now.total) });
      if (!step.remaining) break;
    }
    } finally { db.exec(`PRAGMA secure_delete=${secure === 1 ? "ON" : secure === 2 ? "FAST" : "OFF"}`); }
    result.converted = true;
  }
  if (!unset(compactionRow(db)?.reclaimed_at)) return result;
  const file = mainFile(db), total = file ? fileBytes(file) : 0;
  const free = pragmaNumber(db, "freelist_count") * pragmaNumber(db, "page_size");
  const mark = () => db.prepare("UPDATE memory_root_set_compaction SET reclaimed_at=? WHERE id=1").run(Date.now());
  if (free === 0 || free < (options.reclaimMinBytes ?? RECLAIM_MIN_BYTES) || free < total * (options.reclaimFraction ?? 0.2)) { mark(); return result; }
  // VACUUM writes the whole file again beside the old one: about its size free.
  const available = (options.freeDiskBytes ?? diskFree)(file);
  if (available !== null && available < total + VACUUM_SPARE_BYTES) {
    result.skippedForDisk = true;
    console.warn(`[memory] ${WAITING_MESSAGE}`);
    return result;
  }
  report({ phase: "reclaiming", dbBytes: total });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // later frees come back in small steps (incremental vacuum in the idle sweep)
    db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    mark();
    result.vacuumed = true;
  } catch (error) {
    // short of disk after all, or anything else: memory is whole either way, the next start tries again
    result.skippedForDisk = true;
    console.warn(`[memory] the space hand-back was skipped (${error instanceof Error ? error.message : String(error)}); the next start tries again`);
  }
  return result;
}

/** A checkpoint that never waits on a lock: busy, it is simply skipped. */
export function truncateWal(db: DatabaseSync): boolean {
  const timeout = pragmaNumber(db, "busy_timeout");
  try {
    db.exec("PRAGMA busy_timeout=0");
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
    return Number(row?.busy ?? 0) === 0;
  } catch { return false; }
  finally { db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(timeout))}`); }
}

export interface StorageMaintenanceOptions {
  database: () => DatabaseSync;
  /** No turn running and no recent owner action. */
  idle: () => boolean;
  /** Whether the I/O budget asks background work to wait. */
  defer?: () => boolean;
  pauseMs?: number;
  signal?: AbortSignal;
}
const pause = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** One background pass (the memory worker's idle sweep): only short writes,
 * with pauses between them, so turns and the UI keep the event loop and the
 * lock. Collects unused sets, cuts the log back, and where the file has
 * incremental vacuum, hands free pages back a few megabytes at a time. */
export async function maintainLineageStorage(options: StorageMaintenanceOptions): Promise<LineageStorageStatus> {
  const { pauseMs = 60, signal } = options;
  const stop = () => Boolean(signal?.aborted) || Boolean(options.defer?.());
  while (!stop()) {
    if (collectRootSets(options.database()) === 0) break;
    await pause(pauseMs);
  }
  let db = options.database();
  if (!stop() && pragmaNumber(db, "auto_vacuum") === 2) {
    let rounds = 0;
    while (!stop() && pragmaNumber(db, "freelist_count") > 0 && rounds++ < 64) {
      db.exec("PRAGMA incremental_vacuum(512)");
      await pause(pauseMs);
      db = options.database();
    }
  }
  const status = lineageStorageStatus(db);
  if (!stop() && (status.walBytes > WAL_TRUNCATE_BYTES || (options.idle() && status.walBytes > 0))) truncateWal(db);
  return lineageStorageStatus(db);
}
