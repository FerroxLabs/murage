// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one-time 1.0.3 repair of a data dir that 1.0.2 left refusing every turn after "Keep all" or any install-wide revoke (P0-KEEPALL-REFUSED
// F5). No setting: it runs once at start, in bounded steps, and a second start does nothing.
//
// What 1.0.2 left behind, and what each step does with it:
//  1. deny_session marks of audience-only revokes (memory_revoke_audience: receipts a roster or settings change flipped) on the owner's own
//     direct chats. The owner's chat is judged by content now (deny-read.ts sessionLookup), so they are inert there; deleting them also stops
//     every later session of the thread from being reset by them. Only the owner's own direct chats: on any other thread a reader with an
//     audience still honours them.
//  2. Revoke jobs reopened with nothing left to walk: the marker is drained within a small bound, and the runner finishes the rest.
//  3. Resume cursors that point at a session the thread's reader would reset anyway: cleared (index.ts, with the store), so the first turn
//     starts a fresh session instead of resetting one.
// The 1.0.2 walk also marked sessions begun after a revoke's commit (the 1.0.3 cap no longer writes them). Those rows are kept: a session
// begun after the commit can also have been marked because it carried the revoked content (inheritance at write), and the rows do not say
// which, so deleting them could resume a session that holds what was revoked. Each such mark resets its session once, then the thread runs.
//
// The flag lives beside the data (memory-repairs.json, never in messages.db: the memory schema's meta keys are fixed), keyed on the memory
// file's installation id, so a restored or replaced file is repaired again. Every step is idempotent, so a run cut short is simply run again.
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MEMORY_REPAIRS_FILE = "memory-repairs.json";
export const KEEPALL_UNWEDGE = "keepallUnwedge103";
export interface UnwedgeCounts { readonly denySessions: number; readonly ownerThreads: number; readonly openJobs: number; readonly done: boolean }

function installationId(db: DatabaseSync): string | null {
  try { const id = db.prepare("SELECT installation_id FROM memory_meta WHERE id=1").get()?.installation_id; return typeof id === "string" ? id : null; }
  catch { return null; }
}
function readRepairs(dataDir: string): Record<string, unknown> {
  try { const file = join(dataDir, MEMORY_REPAIRS_FILE); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : {}; }
  catch { return {}; }
}
/** Whether this memory file was already repaired (the flag names its installation id). */
export function keepAllUnwedged(db: DatabaseSync, dataDir: string): boolean {
  const id = installationId(db);
  const done = readRepairs(dataDir)[KEEPALL_UNWEDGE] as { installationId?: unknown } | undefined;
  return id !== null && done?.installationId === id;
}
function markUnwedged(db: DatabaseSync, dataDir: string, counts: UnwedgeCounts): void {
  const id = installationId(db);
  if (id === null) return;
  const next = { ...readRepairs(dataDir), [KEEPALL_UNWEDGE]: { installationId: id, at: Date.now(), denySessions: counts.denySessions, openJobs: counts.openJobs } };
  const file = join(dataDir, MEMORY_REPAIRS_FILE), tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next));
  renameSync(tmp, file);
}

const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name));

/** Steps 1 and 2 on the memory file (step 3 needs the store: index.ts). `ownerDirectThread` says whether a thread is the owner's own direct
 * chat. `drain` walks the marker within a bound (memory-revocation.ts drainRevokeMarkerBounded). Returns what it did; `done` is false only
 * when the row bound ran out first (the next start carries on). Never inside a transaction of the caller's. */
export function unwedgeKeepAllRows(db: DatabaseSync, ownerDirectThread: (threadId: string) => boolean, drain?: (db: DatabaseSync) => void, maxRows = 50_000): UnwedgeCounts {
  if (!hasTable(db, "memory_deny_session") || !hasTable(db, "memory_revoke_audience")) return { denySessions: 0, ownerThreads: 0, openJobs: 0, done: true };
  let denySessions = 0, ownerThreads = 0, done = true;
  const threads = db.prepare("SELECT DISTINCT thread_id FROM memory_deny_session WHERE revoke_id IN (SELECT revoke_id FROM memory_revoke_audience)").all().map(row => String(row.thread_id));
  // one thread's rows per transaction (a thread holds a row per session and revoke: small); the row bound is checked between threads
  const remove = db.prepare("DELETE FROM memory_deny_session WHERE thread_id=? AND revoke_id IN (SELECT revoke_id FROM memory_revoke_audience)");
  for (const threadId of threads) {
    if (!ownerDirectThread(threadId)) continue;
    if (denySessions >= maxRows) { done = false; break; }
    ownerThreads++;
    db.exec("BEGIN IMMEDIATE");
    try { denySessions += Number(remove.run(threadId).changes); db.exec("COMMIT"); }
    catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
  }
  // jobs a 1.0.2 inherit reopened and never finished: the marker drains them within its bound, the runner (woken at listen) does the rest
  const openJobs = Number(db.prepare("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state IN ('active','undoing')").get()?.n ?? 0);
  if (openJobs && drain) { try { drain(db); } catch { /* the runner finishes it */ } }
  return { denySessions, ownerThreads, openJobs, done };
}

/** The whole repair, once per memory file: steps 1 and 2, then `clearCursors` (step 3), then the flag. Logs one line with counts. */
export function runKeepAllUnwedge(db: DatabaseSync, dataDir: string, deps: { ownerDirectThread: (threadId: string) => boolean; drain?: (db: DatabaseSync) => void; clearCursors: () => number; log?: (line: string) => void }): UnwedgeCounts & { cursors: number; skipped: boolean } {
  if (keepAllUnwedged(db, dataDir)) return { denySessions: 0, ownerThreads: 0, openJobs: 0, done: true, cursors: 0, skipped: true };
  const counts = unwedgeKeepAllRows(db, deps.ownerDirectThread, deps.drain);
  const cursors = deps.clearCursors();
  if (counts.done) markUnwedged(db, dataDir, counts);
  (deps.log ?? console.log)(`[memory] keep-all repair: owner-chat session marks removed=${counts.denySessions} threads=${counts.ownerThreads} open-jobs=${counts.openJobs} cursors-cleared=${cursors}${counts.done ? "" : " (continues next start)"}`);
  return { ...counts, cursors, skipped: false };
}
