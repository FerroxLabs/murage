// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The revoke marker's write budget (1.0.3 revoke storm, M3). On 1.0.2 one notebook re-import flipped 122 receipts; their walks wrote
// memory_deny_memory at 0.6-1.8 GB a minute and the Mac was hogged while they ran. The walker's total work is unchanged, but every
// background marker slice (the runner's, and the bounded drains the send fence, a refused turn's settle, the upgrade and the keep-all
// repair run) now draws on one budget of bytes per minute, over a sliding minute. Every row the slice changes counts, not only deny inserts:
// frontier enqueues, visits, pending, hold and job rows too (revoke-marker.ts totalChanges). A changed row is charged one database page,
// what it costs the WAL at least (a row lands on a page, and the page is what the commit writes).
//
// A slice runs only when the room left in the minute holds its reserve, and is capped at that room less the reserve: the marker checks the
// cap between steps, and the reserve is larger than one step writes, so the minute's writes stay inside the budget. A slice the budget
// does not admit waits until enough of the minute has passed (revokeWriteWaitMs). An owner's own commit marks inline under the same budget
// and the inline deadline (revoke-commit.ts markInline): its own revoke only, never the queued flips or other revokes.
import type { DatabaseSync } from "node:sqlite";
import { headFlipCost, MARKER_STEP_RESERVE, markerSlice, totalChanges, type MarkerSliceOptions } from "./revoke-marker.ts";

/** The budget: bytes per sliding minute (about 20 MB). Tests may lower it. */
export const REVOKE_WRITE_BUDGET = { bytesPerMinute: 20 * 1024 * 1024 };
export const REVOKE_WRITE_WINDOW_MS = 60_000;
/** The least a slice is admitted with, beyond the reserve. */
const MIN_SLICE_CHANGES = 64;

let clock: () => number = () => Date.now();
/** Spent bytes by time, oldest first. A process-wide ledger: one marker per data dir, one data dir per process. */
const ledger: Array<{ at: number; bytes: number }> = [];
let spent = 0;

/** Test hooks: a fake clock (none: the wall clock), and an empty ledger. */
export function setRevokeBudgetClock(next?: () => number): void { clock = next ?? (() => Date.now()); }
export function resetRevokeWriteBudget(): void { ledger.length = 0; spent = 0; }

function trim(now: number): void {
  while (ledger.length && ledger[0]!.at <= now - REVOKE_WRITE_WINDOW_MS) spent -= ledger.shift()!.bytes;
}
/** Bytes charged in the last minute. */
export function revokeBytesWritten(now: number = clock()): number { trim(now); return spent; }
/** Records `bytes` charged now. Entries in the same millisecond merge, so the ledger stays small. */
export function noteRevokeBytes(bytes: number, now: number = clock()): void {
  if (!(bytes > 0)) return;
  trim(now);
  const last = ledger[ledger.length - 1];
  if (last && last.at === now) last.bytes += bytes; else ledger.push({ at: now, bytes });
  spent += bytes;
}
const pageBytes = new WeakMap<DatabaseSync, number>();
/** Bytes one changed row is charged: the file's page size. */
export function bytesPerChange(db: DatabaseSync): number {
  let held = pageBytes.get(db);
  if (held === undefined) {
    try { held = Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 4096); } catch { held = 4096; }
    if (!(held > 0)) held = 4096;
    pageBytes.set(db, held);
  }
  return held;
}
/** Changed rows a whole minute's budget holds. A receipt whose per-item commit could cost more hangs on the wildcard pair instead
 * (revoke-commit.ts receiptHoldPlan), so every flip's commit fits inside one minute and no minute runs over the budget. */
export function revokeMinuteChanges(db: DatabaseSync): number {
  return Math.floor(REVOKE_WRITE_BUDGET.bytesPerMinute / bytesPerChange(db));
}
/** Bytes a slice needs room for before it is admitted: a step's reserve and a least slice, or, while a receipt flip waits, the whole commit
 * of the oldest one (no revoke advances until it is drained: revoke-marker.ts runMarkerSlice). No commit is costlier than a whole minute
 * (revokeMinuteChanges), so an empty minute always admits it. */
export function revokeSliceNeed(db: DatabaseSync): number {
  const per = bytesPerChange(db);
  const need = Math.max(MARKER_STEP_RESERVE + MIN_SLICE_CHANGES, headFlipCost(db)) * per;
  return Math.min(need, REVOKE_WRITE_BUDGET.bytesPerMinute);
}
/** Milliseconds until `need` bytes fit in the minute (0: now). */
export function revokeWriteWaitMs(need: number, now: number = clock()): number {
  trim(now);
  const budget = REVOKE_WRITE_BUDGET.bytesPerMinute;
  let used = spent;
  if (used + need <= budget) return 0;
  for (const entry of ledger) {
    used -= entry.bytes;
    if (used + need <= budget) return Math.max(1, entry.at + REVOKE_WRITE_WINDOW_MS - now);
  }
  return REVOKE_WRITE_WINDOW_MS;
}

/** One marker slice inside the budget (the caller's transaction): "budget" when the minute has no room for one (nothing ran), or when a
 * receipt flip waits and the room left cannot commit it (nothing ran: the caller waits revokeWriteWaitMs(revokeSliceNeed)), else
 * markerSlice's answer. No slice runs past the minute's budget, a receipt flip's commit included (one that could cost more than a whole
 * minute hangs on the wildcard pair: revoke-commit.ts receiptHoldPlan). What the slice changed is charged whatever it returns or throws (a
 * rolled-back slice is charged too: it wrote the pages before it rolled back). `only`: an owner's inline walk (revoke-commit.ts markInline). */
export function budgetedMarkerSlice(db: DatabaseSync, rows: number, ms: number, late: Parameters<typeof markerSlice>[3] = null, opts: Pick<MarkerSliceOptions, "only"> = {}): boolean | "budget" {
  const per = bytesPerChange(db);
  const room = Math.floor((REVOKE_WRITE_BUDGET.bytesPerMinute - revokeBytesWritten()) / per) - MARKER_STEP_RESERVE;
  if (room < MIN_SLICE_CHANGES) return "budget";
  const before = totalChanges(db);
  try {
    const moved = markerSlice(db, rows, ms, late, room, opts);
    return moved === "blocked" ? "budget" : moved;
  } finally { noteRevokeBytes(Math.max(0, totalChanges(db) - before) * per); }
}
