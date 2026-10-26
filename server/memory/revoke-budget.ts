// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The revoke marker's write budget (1.0.3 revoke storm, M3; 1.0.3 revoke drain F2, REVOKE-BUDGET-DESIGN section 5, Option S). On 1.0.2 one
// notebook re-import flipped 122 receipts; their walks wrote memory_deny_memory at 0.6-1.8 GB a minute and the Mac was hogged while they
// ran. The walker's total work is unchanged, but every background marker slice (the runner's, and the bounded drains the send fence, a
// refused turn's settle, the upgrade and the keep-all repair run) draws on one budget of bytes over a sliding minute. Every row the slice
// changes counts, not only deny inserts: frontier enqueues, visits, pending, hold and job rows too (revoke-marker.ts totalChanges).
//
// What the budget holds: a ledger of dated charges, and one number, C, the estimated WAL bytes a changed row costs. Every slice, the
// runner's, a bounded drain's and an owner's inline walk (revoke-commit.ts markInline), is charged rows changed x C inside its own marker
// call, whatever it returns or throws; the charge is dated at the call and leaves the ledger 60 s later whatever its transaction does after
// (a COMMIT, a ROLLBACK, an abort, a transaction held open for an hour). Nothing is settled, re-dated, released or inferred, and there is no
// record of any kind: no SQL, savepoint, COMMIT or WAL index is watched for a transaction the drain does not own.
// C is measured only on transactions the drain runner itself BEGINs and COMMITs (memory-revocation.ts tick and drainRevokeMarkerBounded,
// the bench): an index mark right after the BEGIN, read again right after the COMMIT, through a descriptor this process keeps and never
// closes (walIndexMark: a close would drop SQLite's locks on the -shm, SIGBUS in the 10-19 rehearsal). C is a rows-weighted running
// average with a memory of REVOKE_COST_MEMORY_ROWS, seeded at the ceiling a row (REVOKE_CHANGE_CEILING_FRAMES: the row's leaf in its table
// and in its one index, 2.8x the largest per-row cost measured on the 5.4 GB preflight file), capped there, and floored at an eighth of it:
// the drain is never slower than at the ceiling and never admitted faster than eight times it, whatever one measurement says.
// A slice is admitted only when the window has room for its least rows at C and is capped at that room less the step reserve, so at every
// instant the last 60 s of charges hold at most the budget plus the excess of the most recent slice over its allowance (a job step past
// the cap by fewer than the reserve, a late build's fan-out); nothing is admitted until the window has room again. The receipt flip cutoff
// (revokeMinuteChanges) is priced at the ceiling, so every queued flip fits an empty window at any C and none waits for ever. An owner's own
// commit marks inline under the same budget and the inline deadline (revoke-commit.ts markInline): its own revoke only, never the queued
// flips or other revokes, charged at the runner's estimate.
import fs from "node:fs";
import { endianness } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { headFlipCost, MARKER_STEP_RESERVE, markerSlice, totalChanges, type MarkerSliceOptions } from "./revoke-marker.ts";

/** The budget: bytes per sliding minute (about 20 MB). Tests may lower it. */
export const REVOKE_WRITE_BUDGET = { bytesPerMinute: 20 * 1024 * 1024 };
export const REVOKE_WRITE_WINDOW_MS = 60_000;
/** The least a slice is admitted with, beyond the step reserve. */
const MIN_SLICE_CHANGES = 64;
/** WAL frames a changed row is sized and charged at before anything is measured, and the most it is ever charged at: its leaf in its table
 * and its leaf in its one index. A ceiling, 2.8x the largest per-row cost measured on the preflight file (2,904 bytes a row in the costliest
 * of 10,339 slices; 1.57 KB on average). */
export const REVOKE_CHANGE_CEILING_FRAMES = 2;
/** WAL frames one commit may write beyond its rows' own leaves before its measurement counts as over the ceiling: a tolerance of one leaf
 * rebalance in each of a row's two btrees (SQLite's balance_nonroot usually rewrites up to 3 sibling leaves, adds one and rewrites their
 * parent: 4 frames past the row's own leaf; a rebalance that adds two pages or reaches the grandparent is rarer still and is not covered). A
 * split is a cost of the commit, not of each row: over full slices it averages into C, but a slice the 8 ms deadline ends after a few rows
 * can land on one, and its frames over its rows read past W (1.0.6 gate B14: one commit of 5 rows wrote 11 frames, 9,064 bytes a row
 * against W = 8,240; on the same data, 5-row commits touching the deny table, its revoke index and new pages wrote 8). Judging that commit
 * against rows x W alone counted a split as a model error. Such a commit still counts when the whole run is past W a row (sustained
 * excess, below). Only the over-ceiling count uses it: C, the charge and admission are as they were. */
export const REVOKE_COMMIT_REBALANCE_FRAMES = 8;
/** The least C is ever lowered to, as a fraction of the ceiling: a quarter frame a row. A measurement of a few frames over many rows (held
 * jobs saved unchanged, rows that share a page) can lower C only this far (Astra design check, S2). */
const REVOKE_COST_FLOOR = 1 / 8;
/** Rows of memory in the running average: a measurement of r rows weighs r / (M + r) against what C was. Two full runner slices (4,096 rows
 * each) leave 44% of the old estimate. */
export const REVOKE_COST_MEMORY_ROWS = 8192;
/** A WAL frame's header. */
const FRAME_HEADER = 24;
/** The WAL file's header, measured with a commit that starts the log. */
const WAL_HEADER = 32;

let clock: () => number = () => Date.now();
type Entry = { at: number; bytes: number };
/** Spent bytes by time, oldest first. A process-wide ledger: one marker per data dir, one data dir per process. */
const ledger: Entry[] = [];
let spent = 0;
/** C: the estimated WAL bytes a changed row costs (S2). Process-wide, as the ledger is; null until a handle seeds it at its ceiling. */
let cost: number | null = null;

/** Test hooks: a fake clock (none: the wall clock), and an empty ledger with C back at its seed. */
export function setRevokeBudgetClock(next?: () => number): void { clock = next ?? (() => Date.now()); }
export function resetRevokeWriteBudget(): void {
  ledger.length = 0; spent = 0; cost = null;
  for (const key of Object.keys(revokeWriteMeter) as Array<keyof typeof revokeWriteMeter>) revokeWriteMeter[key] = 0;
}

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
/** The file's page size. */
export function bytesPerChange(db: DatabaseSync): number {
  let held = pageBytes.get(db);
  if (held === undefined) {
    try { held = Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 4096); } catch { held = 4096; }
    if (!(held > 0)) held = 4096;
    pageBytes.set(db, held);
  }
  return held;
}
/** Bytes one WAL frame holds: a page and its header. */
export function frameBytes(db: DatabaseSync): number { return bytesPerChange(db) + FRAME_HEADER; }
/** W: bytes a changed row is sized and charged at until the runner has measured, and the most it is ever charged at. */
export function revokeChangeCeiling(db: DatabaseSync): number { return REVOKE_CHANGE_CEILING_FRAMES * frameBytes(db); }
/** C: bytes a changed row is sized and charged at now (S2). */
export function revokeCostPerChange(db: DatabaseSync): number { return cost ?? (cost = revokeChangeCeiling(db)); }
/** One measurement into C (S2): `bytes` of WAL a transaction of the runner's wrote over `rows` changed rows. Rows-weighted with a memory of
 * REVOKE_COST_MEMORY_ROWS, then capped at the ceiling and floored at an eighth of it. A measurement with no rows or no bytes is not one (a
 * commit whose rows changed nothing on their pages hit no frame) and moves nothing. Called by endRevokeMeasure; a test hook too. */
export function noteRevokeCost(db: DatabaseSync, bytes: number, rows: number): void {
  if (!(rows > 0) || !(bytes > 0)) return;
  const W = revokeChangeCeiling(db), from = revokeCostPerChange(db);
  const per = bytes / rows;
  revokeWriteMeter.measured++; revokeWriteMeter.measuredBytes += bytes; revokeWriteMeter.measuredChanges += rows;
  // over: past its rows at W plus one commit's rebalances and the log header; or past W a row at all while every measurement so far, over
  // at least a memory's worth of rows, is past W a row (small commits that are each within the tolerance but costlier than W on the whole)
  const pastCommit = bytes > rows * W + REVOKE_COMMIT_REBALANCE_FRAMES * frameBytes(db) + WAL_HEADER;
  const pastRun = per > W && revokeWriteMeter.measuredChanges >= REVOKE_COST_MEMORY_ROWS && revokeWriteMeter.measuredBytes > revokeWriteMeter.measuredChanges * W;
  if (pastCommit || pastRun) revokeWriteMeter.overCeiling++;
  revokeWriteMeter.maxPerChange = Math.max(revokeWriteMeter.maxPerChange, per);
  revokeWriteMeter.maxSliceBytes = Math.max(revokeWriteMeter.maxSliceBytes, bytes);
  cost = Math.max(W * REVOKE_COST_FLOOR, Math.min(W, (from * REVOKE_COST_MEMORY_ROWS + bytes) / (REVOKE_COST_MEMORY_ROWS + rows)));
}
/** Changed rows an empty minute holds at the ceiling. A receipt whose per-item commit could cost more hangs on the wildcard pair instead
 * (revoke-commit.ts receiptHoldPlan), so every queued flip fits an empty window at any C (C is never above the ceiling). */
export function revokeMinuteChanges(db: DatabaseSync): number {
  return Math.max(0, Math.floor(REVOKE_WRITE_BUDGET.bytesPerMinute / revokeChangeCeiling(db)));
}
/** Rows a slice needs room for: a step's reserve and a least slice, or, while a receipt flip waits, the whole commit of the oldest one (no
 * revoke advances while a flip waits: revoke-marker.ts runMarkerSlice). */
function needRows(db: DatabaseSync, opts: Pick<MarkerSliceOptions, "only">): number {
  return Math.max(MARKER_STEP_RESERVE + MIN_SLICE_CHANGES, opts.only === undefined ? headFlipCost(db) : 0);
}
/** Bytes a slice needs room for before it is admitted (budgetedMarkerSlice admits it the same way): its least rows at C. At most the whole
 * budget: a flip never costs more than an empty minute holds (revokeMinuteChanges), so the wait for room always ends. */
export function revokeSliceNeed(db: DatabaseSync): number {
  return Math.min(Math.ceil(revokeCostPerChange(db) * needRows(db, {})), REVOKE_WRITE_BUDGET.bytesPerMinute);
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

/** Counters for tests and the drain bench: slices that changed rows and the bytes they were charged; the runner's measurements, their bytes
 * and rows; measurements over the ceiling (more than rows x W plus one commit's leaf rebalances, REVOKE_COMMIT_REBALANCE_FRAMES, or past W
 * a row while the whole run is); the
 * largest cost a row (raw: bytes over rows, splits included) and the largest commit measured. */
export const revokeWriteMeter = { slices: 0, charged: 0, measured: 0, measuredBytes: 0, measuredChanges: 0, overCeiling: 0, maxPerChange: 0, maxSliceBytes: 0 };

/** One marker slice inside the budget (the caller's transaction): "budget" when the minute has no room for its least rows at C (nothing
 * ran: the caller waits revokeWriteWaitMs(revokeSliceNeed)), else markerSlice's answer. The slice's cap in rows is its allowance at C, less
 * the step reserve the marker may run past its cap. What it changed is charged rows x C, at the C it was admitted with, whatever it returns
 * or throws (a rolled-back slice too: it dirtied its pages), dated now; the charge ages out in 60 s and nothing moves it. `only`: an owner's
 * inline walk (revoke-commit.ts markInline), inside the owner's own transaction, charged the same way. */
export function budgetedMarkerSlice(db: DatabaseSync, rows: number, ms: number, late: Parameters<typeof markerSlice>[3] = null, opts: Pick<MarkerSliceOptions, "only"> = {}): boolean | "budget" {
  const now = clock();
  trim(now);
  const per = revokeCostPerChange(db);
  let room = Math.floor((REVOKE_WRITE_BUDGET.bytesPerMinute - spent) / per);
  const need = needRows(db, opts);
  if (room < need) {
    // the one fallback: a flip planned when the budget was larger than today's (tests) costs more than an empty minute holds; an empty
    // minute admits it with the whole budget as its allowance rather than never (its excess is at most its planning-time minute)
    if (!(spent === 0 && opts.only === undefined && need === headFlipCost(db) && need > revokeMinuteChanges(db))) return "budget";
    room = need;
  }
  const before = totalChanges(db);
  try {
    const moved = markerSlice(db, rows, ms, late, room - MARKER_STEP_RESERVE, opts);
    return moved === "blocked" ? "budget" : moved;
  } finally {
    const changed = Math.max(0, totalChanges(db) - before);
    if (changed > 0) {
      const bytes = Math.ceil(changed * per);
      revokeWriteMeter.slices++; revokeWriteMeter.charged += bytes;
      noteRevokeBytes(bytes, clock());
    }
  }
}

/** The WAL index header (the -shm file, native byte order): frames in the log and the salt of its current generation. */
type WalIndexMark = { mxFrame: number; salt: string };
const shmFiles = new WeakMap<DatabaseSync, string | null>();
function shmFileOf(db: DatabaseSync): string | null {
  if (shmFiles.has(db)) return shmFiles.get(db)!;
  let file: string | null = null;
  try {
    const main = (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main");
    file = main?.file ? `${main.file}-shm` : null;
  } catch { file = null; }
  shmFiles.set(db, file);
  return file;
}
const WALINDEX_VERSION = 3007000;
/** The read-only descriptors this process keeps on -shm files, one per shm inode it has measured, NEVER closed. The -shm is the file SQLite
 * maps and takes POSIX locks on in this very process, and closing ANY descriptor on a file drops every lock the process holds on it
 * (io-budget.ts walFrameReader): an open, read and close here let the memory worker run wal-index recovery and reset the shm under
 * SQLite's live mapping, SIGBUS (1.0.3 rehearsal, 10-19). No close can drop a lock, so none is ever made: not when the path's inode changes
 * (that proves nothing about the inode SQLite still holds) and not when a DatabaseSync is collected (another connection of this process
 * may hold locks on the same inode). The cost is one descriptor per shm inode the process ever measured, keyed by what the descriptor
 * itself holds (fstat), so a file replaced between the path's stat and the open cannot be mislabelled. */
const shmFds = new Map<string, number>();
/** Reads the committed WAL index header through the kept descriptor of the -shm the path names now; null when there is none to trust (no
 * WAL, an in-memory file, the two header copies differ). */
export function walIndexMark(db: DatabaseSync): WalIndexMark | null {
  const file = shmFileOf(db);
  if (!file) return null;
  try {
    const now = fs.statSync(file); // a stat opens no descriptor
    let fd = shmFds.get(`${now.dev}:${now.ino}`);
    if (fd === undefined) {
      const opened = fs.openSync(file, "r");
      const got = fs.fstatSync(opened), key = `${got.dev}:${got.ino}`;
      const first = shmFds.get(key);
      if (first === undefined) shmFds.set(key, opened); // else this inode already has one: both stay open, the first is used
      fd = first ?? opened;
    }
    const head = Buffer.alloc(96);
    if (fs.readSync(fd, head, 0, 96, 0) !== 96 || !head.subarray(0, 48).equals(head.subarray(48, 96))) return null;
    const u32 = (at: number) => endianness() === "LE" ? head.readUInt32LE(at) : head.readUInt32BE(at);
    if (u32(0) !== WALINDEX_VERSION || head[12] !== 1) return null;
    return { mxFrame: u32(16), salt: head.subarray(32, 40).toString("hex") };
  } catch { return null; }
}
/** A runner transaction's starting point for its measurement: the index mark right after its BEGIN (null: no readable index) and the
 * handle's change count. */
export type RevokeMeasure = { mark: WalIndexMark | null; changes: number };
/** Right after the BEGIN of a transaction the caller itself will COMMIT (the runner tick, drainRevokeMarkerBounded, the bench), with the
 * writer lock held: what the measurement at its COMMIT counts from. */
export function beginRevokeMeasure(db: DatabaseSync): RevokeMeasure {
  let inside = false;
  try { inside = db.isTransaction; } catch { inside = false; }
  return { mark: inside ? walIndexMark(db) : null, changes: totalChanges(db) };
}
/** Right after that transaction's own COMMIT: the bytes it wrote to the WAL over the rows it changed, into C (noteRevokeCost). The writer
 * lock was held from the mark to the commit, so the frames the index gained up to the commit are this transaction's: the count since the
 * mark, plus the log's 32-byte header when the mark was at frame 0, or, when the log restarted under this transaction (a new salt: its
 * spill, or its commit after a checkpoint that copied the whole log back), every frame of the new log and its header. The lock is gone
 * once COMMIT returns, so another writer of the file can append frames before the read (the sample is pulled up, at most to the cap) or
 * checkpoint and restart the log (a new salt with its own few frames: pulled down, at most to the floor, by one sample's weight); a stated
 * limit (REVOKE-BUDGET-DESIGN section 5, known limit 4). Nothing to trust (no index at the mark or now, fewer frames under the same salt,
 * a new salt with no frame, no rows changed): nothing is measured, C stays. Measures only a transaction that held the marker's slice and
 * nothing else (the caller's gate). The measured bytes, or null. */
export function endRevokeMeasure(db: DatabaseSync, from: RevokeMeasure): number | null {
  const rows = totalChanges(db) - from.changes;
  if (!from.mark || !(rows > 0)) return null;
  const index = walIndexMark(db);
  if (!index || (index.salt === from.mark.salt ? index.mxFrame < from.mark.mxFrame : index.mxFrame === 0)) return null;
  const per = frameBytes(db);
  const bytes = index.salt !== from.mark.salt ? 32 + index.mxFrame * per : (index.mxFrame - from.mark.mxFrame) * per + (from.mark.mxFrame === 0 && index.mxFrame > 0 ? 32 : 0);
  if (!(bytes > 0)) return null;
  noteRevokeCost(db, bytes, rows);
  return bytes;
}
