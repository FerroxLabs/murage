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
// call, whatever it returns or throws; the charge is dated at the call; in a transaction the drain itself owns
// (a runner tick, a bounded drain) it is dated again at that transaction's COMMIT or ROLLBACK, so a transaction held open past the minute
// leaves with its whole cost together (r3.6). In a transaction the drain does not own (an owner's inline walk) it leaves 60 s after the call
// whatever happens next, and no SQL, savepoint, COMMIT or WAL index is watched for it.
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
//
// The pace (IO-IDLE-DRAIN-1018 r3.6, MurageMain 2026-11-07/08: remove mechanism, do not add it): beside the rows x C ledger, a second
// sliding minute, REVOKE_PACE (0.8 MB, under the io watchdog's 1 MB idle budget), holds what the drain's own commits MEASURED. Nothing is
// estimated or learned (r3.6 first planned a learned bound, P; it was dropped: the measurement already charges every byte at the COMMIT).
// - The cap: a drain-owned transaction (a runner tick, a bounded drain) changes at most REVOKE_PACE_COMMIT.rows rows in all, the marker's
//   step reserve past it at most. A waiting receipt flip is never planned bigger than cap + reserve (revokeFlipCutoffRows: the wildcard
//   hold takes the rest), so no flip overrides the cap. Job steps and late builds get the rows the transaction has left as input rows.
// - Admission: only when the pace is empty, or when the last minute's measured bytes, the copies still outstanding and the PREVIOUS
//   commit's measured bytes fit the minute (revokePaceNeed). An empty pace always admits, so nothing waits for ever.
// - The charge, at the COMMIT, at once (1.0.21 B1, the same on every OS, no OS counter): a transaction that changed no row costs 0; else
//   a write half and a copy half, each its OWN log frames (salt unchanged and data_version unmoved across it), or rows x W when they
//   cannot be proven its own (unreadable, a restarted log, another connection's commit in between).
// - The copy half is OUTSTANDING, undated, until the log is seen COMPLETELY copied (r3.6c): the drain proves its own copy. Right after each
//   COMMIT, and at every later wait decision outside a transaction, it runs PASSIVE itself (never waiting on a reader) and reads ITS result;
//   a log so proven copied is reset at once by a no-wait TRUNCATE, so the next drain commit appends under the salt it marked and is
//   measured exactly. Any other salt change between a commit's mark and its read is rows x W (no restart is ever attributed to the drain).
//   A copy a pinned reader holds past COPY_PROOF_MAX_MS (60 s) is dated then without proof (that minute is its copy minute), and charged
//   AGAIN in the minute it actually lands (the late copy); nothing waits for ever, on a checkpointer or a reader.
// - A job-step or late-build input row that fans out (a late build's broughtFrom origins) is bounded per input row: measured at the
//   COMMIT, charged at once, and the next step waits for room. The largest such fan-out on Sean's data copy is 0 (no bring-in sources).
// THE PROMISE (MurageMain R1, bounded, not "never"): a commit that costs more than the one before it costs at most its write minute and its
// copy minute over the pace, each by at most (REVOKE_PACE_COMMIT.rows + MARKER_STEP_RESERVE) x 2W; the watchdog counts every byte.
// Owner inline walks (revoke-commit.ts markInline, `only`) are outside the pace (R3, shipped gap): the rows x C ledger charges them.
// FGCOPY ledger owner: scperf-p1. Revoke-drain checkpoint execution owner: scperf-p1.
import { ioBudget } from "../io-budget.ts";
import { checkpointCeiling, ioMeterPageSize } from "../io-meter.ts";
import fs from "node:fs";
import { accountedPrepare, chargeReleaseWork } from "./release-budget.ts";
import { endianness } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { headFlipCost, receiptFlipCost, MARKER_SLICE_JOBS, MARKER_STEP_RESERVE, markerSlice, markerSliceDetailed, totalChanges, type MarkerSliceOptions, type MarkerSliceOutcome } from "./revoke-marker.ts";
import { walResetFence } from "../wal-maintenance.ts";

/** The budget: bytes per sliding minute (about 20 MB). Tests may lower it. */
export const REVOKE_WRITE_BUDGET = { bytesPerMinute: 20 * 1024 * 1024 };
export const REVOKE_WRITE_WINDOW_MS = 60_000;
/** 1.0.21 cause5: the floor of a commit's inline walk of its OWN memory revoke (a record or source change: revoke-commit.ts markInline,
 * `only` with `floor`; every other root kind keeps the plain budget rule, revoke-storm-holes.test.ts 4). On a long profile under
 * load the minute is always spent by the queue the marker already has, so no commit's walk ran inline: a revoke with nothing to walk (a
 * routine's once-a-minute notebook re-import that ends no receipt, "cause=import count=0") stayed an active job, and its all-threads,
 * all-scopes window made every receipt written after it read checking:pending (hand-offs could not set up, finished replies were held).
 * A spent minute therefore still admits an inline walk while fewer than this many rows were changed under the floor in the last minute.
 * Scheduling only: the walk writes exactly the marks the runner would write later, and a walk that does not finish here keeps its job and
 * its window (fail closed). Every floor row is charged to the ledger like any other, so the excess over the budget is bounded: at most
 * changesPerMinute + MIN_SLICE_CHANGES + MARKER_STEP_RESERVE rows a minute at C. 0 turns the floor off. Tests may change it.
 * The finished job rows a floored walk removes when its revoke finishes are inside that same slice cap (revoke-marker.ts INLINE_PRUNE: a
 * page, and no more than the cap and reserve have left), so a backlog of finished rows never rides on the owner's commit.
 * Limits: the floor is one shared minute, so a large memory revoke can use it up (its own window is open then anyway); and while a receipt
 * flip is queued no revoke advances, inline or not (revoke-marker.ts runMarkerSlice), so the floor walks nothing until the flips drain. */
export const INLINE_FLOOR = { changesPerMinute: 256 };
const floorLedger: Array<{ at: number; rows: number }> = [];
let floorRows = 0;
function inlineFloorLeft(now: number): number {
  while (floorLedger.length && floorLedger[0]!.at <= now - REVOKE_WRITE_WINDOW_MS) floorRows -= floorLedger.shift()!.rows;
  return INLINE_FLOOR.changesPerMinute - floorRows;
}
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
/** A dated ledger entry: `bytes` charged to admission. `tx`: the drain-owned transaction it was charged in (0: none), so its COMMIT can
 * date it with the transaction's other costs (endRevokeMeasure). */
type Entry = { at: number; bytes: number; tx: number };
/** Spent bytes by time, oldest first. A process-wide ledger: one marker per data dir, one data dir per process. */
const ledger: Entry[] = [];
let spent = 0;
/** The pace's ledger (r3.6): bound and excess bytes by time, oldest first; `tx` as above (a slice's rows x B until its COMMIT dates it). */
const paced: Entry[] = [];
let paceSpent = 0;
/** Copy halves not yet proven copied (r3.6c, H5 and H-a): debt held in the pace, undated, until the log is seen COMPLETELY copied (the
 * drain's own PASSIVE result, or the log index: nBackfill >= mxFrame; every frame of every generation is then in the main file, the
 * drain's among them), or until COPY_PROOF_MAX_MS after the latest commit that added to it. `copySince`: when debt was last added. */
let copyHeld = 0, copySince = 0;
/** Where the latest commit that added debt left the log: its salt and last frame (salt null: deferred until a readable index).
 * Frames are copied in order, so its proof covers every earlier commit's too. Handed to the late record at the bound. */
let copyMark: { salt: string | null; lastFrame: number } = { salt: null, lastFrame: 0 };
/** Copies dated at the bound without proof (a pinned reader): their copy has not landed yet. ONE coalesced record (MurageMain ruling B,
 * 2026-11-07 22:33Z): the bytes summed, the newest lapse's salt and the most its last frame under that salt. It is charged again, in the
 * minute its frames are seen copied: nBackfill at or past lastFrame under its salt, another salt, or the whole log copied (ruling 2;
 * Astra r3.6c High B: never the whole log alone). */
let lateHeld = 0, lateSalt: string | null = null, lateLastFrame = 0;
let copyDeferred = false, lateDeferred = false;
/** How often a wait blocked only by outstanding copies looks again; each look retries the drain's own copy (outside a transaction). */
const COPY_POLL_MS = 1000;
/** The bound on a copy proof (MurageMain 2026-11-07: no unbounded wait for an external checkpoint): one window. A copy the drain could not
 * prove in the minute after its commit is dated then, so it holds the pace one more minute (two in all) and the drain runs on; a longer
 * bound would only stop the drain longer behind a reader it cannot move, a shorter one would date copies a checkpointer is still making. */
export const COPY_PROOF_MAX_MS = REVOKE_WRITE_WINDOW_MS;
/** The drain-owned transaction being measured now (beginRevokeMeasure), 0 when none. */
let currentTx = 0, nextTx = 0;
let currentTxDb: DatabaseSync | null = null;
/** C: the estimated WAL bytes a changed row costs (S2). Process-wide, as the ledger is; null until a handle seeds it at its ceiling. */
let cost: number | null = null;
/** The measured write and copy of the latest drain-owned commit that changed rows (r3.6): what the next admission needs room for. A
 * rolled-back transaction only raises it. 0 until one has committed (an empty pace admits anyway). */
let lastCommitBytes = 0;
/** Rows in the drain's last committed transaction, used by the reset fallback. */
let lastCommitRows = 0;
/** The change count at the open drain-owned transaction's BEGIN (null: none open): the cap counts the whole transaction. */
let txStartChanges: number | null = null;
/** Test only: what the previous commit is taken to have cost (a forced misestimate). */
export function setRevokeLastCommitForTest(bytes: number): void { lastCommitBytes = bytes; }
/** The most rows one drain commit is capped at in the pace (MurageMain: the smallest cap whose M1 stays under 86 min). The marker may run
 * past a cap by its step reserve, so one commit changes at most REVOKE_PACE_COMMIT_ROWS + MARKER_STEP_RESERVE rows: at most that x 2W
 * bytes past its bound when P is wrong. Tests may change it. */
export const REVOKE_PACE_COMMIT = { rows: 512 };
/** The pace need of the latest revokeSliceNeed (what revokeWriteWaitMs waits for in the pace's minute when not told). */
let paceNeedNow = 0;

/** The pace: the drain's bound and excess bytes per sliding minute, under the io watchdog's 1 MB idle budget with room for one step's excess
 * and the rest of the process. Tests may change it. */
export const REVOKE_PACE = { bytesPerMinute: Math.round(0.8 * 1024 * 1024) };
/** MEMORY V2 V8 (replaces the 1.0.21 mem-f3 "backlog burst": at least 64 active jobs and no live turn). CLOSING WORK IS NOT PACED PER MINUTE.
 * Closing work is the walk of a job that still holds a pending row: a reader is held "checking" under it until the walk is proven, so its
 * minute is the marker's write budget alone (REVOKE_WRITE_BUDGET, 20 MiB of rows x C: the 1.0.3 storm bound), whether or not a turn is live
 * and however few jobs wait. Only what no reader waits on keeps the idle pace (REVOKE_PACE, 0.8 MiB): the tidy of a job whose pending rows are gone, the
 * prune of finished rows, runner job steps and late builds with no pending row anywhere. The runner tells this module which it is
 * (memory-revocation.ts tick: one O(1) probe when its wake fires, kept in memory between); nothing here reads the queue. Nothing else
 * moves: a commit's row cap, the rows x C ledger, the copy proof and the 8 ms slice with its 3x pause are what they were; no job's cap
 * changes and no window closes anywhere new (P4). `jobs` is kept as the switch only: Infinity turns the closing budget off (tests). */
export const REVOKE_BACKLOG = { jobs: 1 };
let closingBudget = false;
/** 1.0.22 q1022-closing-batch (MAIN-RULING 2026-11-25T13:41:53Z, IDLECPU-1022 Cause 1): on an idle minute (io-budget.ts idleQuiet, no live turn)
 * closing work commits in transactions this many times bigger and this many times rarer: the runner's slice is this many 8 ms slices
 * (its pause stays 3x the slice, the same 25% duty) and a drain commit's row cap is this many REVOKE_PACE_COMMIT caps. Each COMMIT rewrites
 * the same hot pages (the deny tables' leaves and indexes, the cover rows, the job cursor) as whole log frames, so one commit in place of
 * `batch` carries those pages once: the same rows a minute (V8: never paced per minute) for about 1/batch of the log. Every row is still
 * charged rows x C to the 20 MiB ledger and admitted only inside its room (budgetedMarkerSlice), C measured on these commits as on any
 * other. A live turn, or a minute that is not idle, keeps the 8 ms slice and the 512-row cap. 1 turns it off (the mutant).
 * 12, not 4 or 6 (q1022-closing-opus r3, the 05b real-store shape, closing-batch-1022.test.ts WALK-05B): a commit there carries ~25 pages of
 * b-tree interior and cursor whatever its marks, plus several leaves a mark, so the log a mark falls only as the marks a commit grow; at the
 * field's ~3 marks a commit, 12 slices cut the log a mark about 2x on a long walk (4 and 6 cut less on the short one); past ~16 slices a commit holds no more marks.
 * The thread is held up to 12 x 8 ms only while no turn is live; a turn's next slice is the live half (TURN). */
export const REVOKE_IDLE_CLOSING = { batch: 12, bytesPerMinute: 4_600_000 };
/** MAIN-RULING 2026-11-25T17:44:19Z CLOSING-1022 (option 3, on top of the batch): idle closing work is PACED to a wall-clock byte budget,
 * REVOKE_IDLE_CLOSING.bytesPerMinute of its own commits' log in any minute (V8 reversed for idle closing only). Each idle closing COMMIT's
 * own bytes (what endRevokeMeasure measured, else rows x the ceiling) stay in a 61 s window; the next idle closing transaction starts only
 * when the window plus the biggest commit in it (the next one's size) fits the budget, so no wall-clock minute holds more than the budget
 * plus that estimate's error: 4.6 MB keeps every minute <= 5 MB on the 05b shape. A live turn, a turn waiting on a window, or a minute
 * that is not idle is never paced here (batch 1): the runner gates its next tick only, never a reply. Infinity turns it off (the mutant). */
let idleClosing = false, idleClosingSpent = 0;
const idleClosingDone: Array<{ at: number; bytes: number }> = [];
const IDLE_CLOSING_WINDOW_MS = 61_000;
/** How long the next idle closing transaction still waits for its byte budget, ms (0 when it is not idle closing work). */
export function revokeIdleClosingWaitMs(now: number = clock()): number {
  const budget = REVOKE_IDLE_CLOSING.bytesPerMinute;
  if (!idleClosing || !(budget > 0) || !Number.isFinite(budget)) return 0;
  while (idleClosingDone.length && idleClosingDone[0].at <= now - IDLE_CLOSING_WINDOW_MS) idleClosingSpent -= idleClosingDone.shift()!.bytes;
  if (idleClosingDone.length === 0) return 0;
  let need = 0;
  for (const done of idleClosingDone) need = Math.max(need, done.bytes);
  let over = idleClosingSpent + need - budget;
  if (over <= 0) return 0;
  for (const done of idleClosingDone) { over -= done.bytes; if (over <= 0) return Math.max(1, done.at + IDLE_CLOSING_WINDOW_MS - now); }
  return Math.max(1, idleClosingDone[idleClosingDone.length - 1].at + IDLE_CLOSING_WINDOW_MS - now);
}
/** The runner's word before each admission: whether a pending row (or a waiting turn) stands, so this minute is the write budget, and
 * whether it runs on an idle minute with no live turn (`idle`: its commits are batched, REVOKE_IDLE_CLOSING). */
export function noteRevokeClosing(closing: boolean, idle = false): void { closingBudget = closing && Number.isFinite(REVOKE_BACKLOG.jobs); idleClosing = closingBudget && idle; }
/** How many 8 ms slices (and REVOKE_PACE_COMMIT caps) one runner transaction is now: REVOKE_IDLE_CLOSING.batch for idle closing work, else 1. */
export function revokeIdleClosingBatch(): number { return idleClosing ? Math.max(1, Math.floor(REVOKE_IDLE_CLOSING.batch)) : 1; }
/** Whether the drain's minute is the write budget now (diagnostics, tests). The name is the mem-f3 one. */
export const revokeBacklogBurst = (): boolean => closingBudget;
/** The pace's minute now: the idle pace; none while closing work stands. Closing work is admitted by the rows x C ledger alone (20 MiB of
 * memory's own rows a minute, design M2): the pace is measured bytes (log frames, the OS term, the copy half), a second and smaller count
 * of the same writes, and it is what held the owner's queue for hours. The copy proof and every meter go on as before. */
function paceLimit(): number { return closingBudget ? Number.POSITIVE_INFINITY : REVOKE_PACE.bytesPerMinute; }

/** MEMORY V2 V8, the floor [O]: closing work is NEVER below this many changed rows a minute, whatever the two ledgers hold (a foreground
 * that spent the minute, a process-wide OS counter that filled the pace). Without it a queue under bots that never stop grows without
 * bound and every window under it reads "checking" for as long. A floor slice is an ordinary marker slice with this as its write cap (it
 * may run past it by one step, as every capped slice may); what it changes is charged to the rows x C ledger and measured into the pace
 * like any drain commit, so the next minute pays for it. Tests may change it; 0 turns the floor off (the mutant). */
export const REVOKE_CLOSING_FLOOR = { rowsPerMinute: 256 };
const closingDone: Entry[] = []; // `bytes` holds changed rows here
let closingRows = 0;
function trimFloor(now: number): void { while (closingDone.length && now - closingDone[0]!.at >= REVOKE_WRITE_WINDOW_MS) closingRows -= closingDone.shift()!.bytes; }
function noteClosingRows(rows: number, now: number): void { if (rows > 0) { closingDone.push({ at: now, bytes: rows, tx: 0 }); closingRows += rows; } }
/** Changed rows the floor still owes this sliding minute (0: closing work already did that much, by either path). */
export function revokeFloorRows(now: number = clock()): number { trimFloor(now); return Math.max(0, Math.floor(REVOKE_CLOSING_FLOOR.rowsPerMinute) - closingRows); }
/** Milliseconds until the floor owes rows again (0: it does now). */
export function revokeFloorWaitMs(now: number = clock()): number {
  if (!(REVOKE_CLOSING_FLOOR.rowsPerMinute > 0)) return Number.POSITIVE_INFINITY;
  if (revokeFloorRows(now) > 0) return 0;
  let rows = closingRows;
  for (const entry of closingDone) { rows -= entry.bytes; if (rows < REVOKE_CLOSING_FLOOR.rowsPerMinute) return Math.max(1, entry.at + REVOKE_WRITE_WINDOW_MS - now); }
  return REVOKE_WRITE_WINDOW_MS;
}
/** One floor slice (the runner's transaction, when a ledger refused closing work): "budget" when the floor owes nothing or nothing could
 * move inside it (a queued flip dearer than the floor: it waits for the ledger, as before), else markerSlice's answer. */
export function floorMarkerSlice(db: DatabaseSync, rows: number, ms: number, late: Parameters<typeof markerSlice>[3] = null): boolean | "budget" {
  chargeReleaseWork();
  const owed = revokeFloorRows();
  if (!(owed > 0)) return "budget";
  const per = revokeCostPerChange(db), before = totalChanges(db);
  try {
    const moved = markerSlice(db, Math.min(rows, owed), ms, late, owed, { jobs: MARKER_SLICE_JOBS.max });
    return moved === "blocked" ? "budget" : moved;
  } finally {
    const changed = Math.max(0, totalChanges(db) - before);
    if (changed > 0) {
      const at = clock();
      revokeWriteMeter.slices++; revokeWriteMeter.charged += Math.ceil(changed * per); revokeWriteMeter.floorRows += changed;
      noteRevokeBytes(Math.ceil(changed * per), at); noteClosingRows(changed, at);
    }
  }
}
/** Test only: make every measurement unreadable (fail-closed checks). `osUnknown`: kept for older tests; since 1.0.21 B1 no OS counter is
 * read, so it changes nothing. `dataVersion`: what the log reset's guard reads as data_version. `betweenSampleAndVersion`: runs between
 * the measure's frame sample and its data_version read (B1 witness: a foreign commit landing there). */
export const revokePaceTestHooks: { unmeasurable: boolean; osUnknown: boolean; beforeResetGuard: (() => void) | null; inResetWindow: (() => void) | null; dataVersion: (() => number | null) | null; betweenSampleAndVersion: (() => void) | null } = { unmeasurable: false, osUnknown: false, beforeResetGuard: null, inResetWindow: null, dataVersion: null, betweenSampleAndVersion: null };

/** Test hooks: a fake clock (none: the wall clock), and an empty ledger with C back at its seed. */
export function setRevokeBudgetClock(next?: () => number): void { clock = next ?? (() => Date.now()); }
export function resetRevokeWriteBudget(): void {
  floorLedger.length = 0; floorRows = 0;
  ledger.length = 0; spent = 0; paced.length = 0; paceSpent = 0; copyHeld = 0; copySince = 0; copyMark = { salt: null, lastFrame: 0 }; lateHeld = 0; lateSalt = null; lateLastFrame = 0; currentTx = 0; currentTxDb = null; txStartChanges = null; cost = null; lastCommitBytes = 0; lastCommitRows = 0; copyDeferred = false; lateDeferred = false; paceNeedNow = 0; closingBudget = false; idleClosing = false; idleClosingDone.length = 0; idleClosingSpent = 0; closingDone.length = 0; closingRows = 0;
  for (const key of Object.keys(revokeWriteMeter) as Array<keyof typeof revokeWriteMeter>) revokeWriteMeter[key] = 0;
}

/** Ages out charges older than the minute, except those of the drain-owned transaction still open (r3.6, Medium): they leave only after its
 * COMMIT dates them again, so a transaction held open past the minute never drops out while it runs. (An open entry at the head keeps the
 * entries behind it a little longer too: conservative.) */
function trim(now: number): void {
  const open = (e: Entry) => currentTx !== 0 && e.tx === currentTx;
  while (ledger.length && ledger[0]!.at <= now - REVOKE_WRITE_WINDOW_MS && !open(ledger[0]!)) { chargeReleaseWork(); spent -= ledger.shift()!.bytes; }
  while (paced.length && paced[0]!.at <= now - REVOKE_WRITE_WINDOW_MS && !open(paced[0]!)) { chargeReleaseWork(); paceSpent -= paced.shift()!.bytes; }
}
/** Bytes charged in the last minute: what admission holds the drain to (every charge, the commit overhead included). */
export function revokeBytesWritten(now: number = clock()): number { trim(now); return spent; }
/** The drain's bytes in the pace now (r3.6): the last minute's bound and excess charges plus the copy halves still outstanding. */
export function revokePacedBytes(now: number = clock()): number { trim(now); return paceSpent + copyHeld; }
/** The copy halves still outstanding (r3.6, H5). */
export function revokeOutstandingCopyBytes(): number { return copyHeld; }
/** Copies dated at the bound whose copy has not landed yet (r3.6c): charged again when it does. */
export function revokeLateCopyBytes(): number { return lateHeld; }
function push(on: Entry[], bytes: number, now: number, tx: number): void {
  const last = on[on.length - 1];
  if (last && last.at === now && last.tx === tx) last.bytes += bytes; else on.push({ at: now, bytes, tx });
}
/** Records `bytes` charged now. Entries in the same millisecond merge, so the ledger stays small. */
export function noteRevokeBytes(bytes: number, now: number = clock()): void {
  if (!(bytes > 0)) return;
  trim(now);
  push(ledger, bytes, now, currentTx);
  spent += bytes;
}
function notePace(bytes: number, now: number, tx: number): void {
  if (!(bytes > 0)) return;
  trim(now);
  push(paced, bytes, now, tx);
  paceSpent += bytes; revokeWriteMeter.paceDated += bytes;
}
/** A transaction's entries leave `on` (they are re-dated or replaced at its COMMIT): their bytes. */
function takeTx(on: Entry[], tx: number): number {
  let bytes = 0;
  for (let i = on.length - 1; i >= 0; i--) if (on[i]!.tx === tx) { bytes += on[i]!.bytes; on.splice(i, 1); }
  return bytes;
}
const pageBytes = new WeakMap<DatabaseSync, number>();
/** The file's page size. */
export function bytesPerChange(db: DatabaseSync): number {
  let held = pageBytes.get(db);
  if (held === undefined) {
    try { held = Number(accountedPrepare(db, "PRAGMA page_size").get()?.page_size ?? 4096); } catch { held = 4096; }
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
export type SliceTarget =
  | { kind: "global" }
  | { kind: "only"; revokeId: number }
  | { kind: "flips" }
  | { kind: "flows" };
export type SlicePolicy = "inline" | "drain";
export type { BlockedCause } from "./revoke-marker.ts";
export type SliceResult =
  | { admitted: false; refused: "ledger" | "pace" }
  | ({ admitted: true; changed: number } & MarkerSliceOutcome);

/** One calculation for drain waiting and admission, including the precise empty-minute escape. */
function targetNeed(db: DatabaseSync, target: SliceTarget) {
  let flipTerm: number;
  switch (target.kind) {
    case "global": flipTerm = headFlipCost(db); break;
    case "flips": flipTerm = receiptFlipCost(db); break;
    case "only": case "flows": flipTerm = 0; break;
    default: throw new Error("MEMORY_REVOKE_TARGET");
  }
  const per = revokeCostPerChange(db), rows = Math.max(MARKER_STEP_RESERVE + MIN_SLICE_CHANGES, flipTerm);
  const escape = rows === flipTerm && flipTerm > revokeMinuteChanges(db);
  const bytes = Math.ceil(per * rows);
  return { per, rows, flipTerm, escape, bytes: escape ? Math.min(bytes, REVOKE_WRITE_BUDGET.bytesPerMinute) : bytes };
}
/** A targeted drain waits for both ledgers. An impossible minute is not a zero wait or an escape. */
export function revokeSettleWaitMs(db: DatabaseSync, target: SliceTarget): number {
  const paceNeed = revokePaceNeed(db);
  const need = targetNeed(db, target);
  const now = clock(); // copy accounting may have consumed time or charged new bytes
  if (need.bytes > REVOKE_WRITE_BUDGET.bytesPerMinute) return Number.POSITIVE_INFINITY;
  return revokeWriteWaitMs(need.bytes, now, paceNeed);
}

/** Target-specific admission, deliberately not wired into legacy callers. */
export function admitMarkerSlice(db: DatabaseSync, rows: number, ms: number, late: Parameters<typeof markerSlice>[3], target: SliceTarget, policy: SlicePolicy): SliceResult {
  if (policy !== "drain" && policy !== "inline" || policy === "inline" && target.kind !== "only") throw new Error("MEMORY_REVOKE_POLICY");
  const measured = currentTx !== 0 && currentTxDb === db;
  if (!db.isTransaction || (policy === "drain" ? !measured : measured)) throw new Error("MEMORY_REVOKE_TRANSACTION");
  const deadline = performance.now() + ms;
  if (policy === "drain") revokePaceNeed(db);
  trim(clock());
  const need = targetNeed(db, target);
  let room = Math.floor((REVOKE_WRITE_BUDGET.bytesPerMinute - spent) / need.per);
  if (room < need.rows) {
    if (!(spent === 0 && need.escape)) return { admitted: false, refused: "ledger" };
    room = need.rows;
  }
  if (policy === "drain") {
    if (!paceAdmits()) { revokeWriteMeter.paceWaits++; return { admitted: false, refused: "pace" }; }
    const left = Math.max(REVOKE_PACE_COMMIT.rows, need.flipTerm - MARKER_STEP_RESERVE) - txRows(db);
    room = Math.min(room, MARKER_STEP_RESERVE + Math.max(0, left));
  }
  const remaining = deadline - performance.now();
  // Admission's accounting shares the caller's slice allowance; never start new marker work after it expires.
  if (!(remaining > 0)) return { admitted: true, outcome: "idle", changed: 0 };
  const opts: MarkerSliceOptions = target.kind === "only" ? { only: target.revokeId }
    : target.kind === "flips" ? { flipsOnly: true } : target.kind === "flows" ? { flowsOnly: true } : {};
  const before = totalChanges(db);
  try {
    const result = markerSliceDetailed(db, rows, remaining, late, room - MARKER_STEP_RESERVE, opts);
    return { admitted: true, ...result, changed: Math.max(0, totalChanges(db) - before) };
  } finally {
    const changed = Math.max(0, totalChanges(db) - before);
    if (changed > 0) {
      const bytes = Math.ceil(changed * need.per);
      revokeWriteMeter.slices++; revokeWriteMeter.charged += bytes;
      noteRevokeBytes(bytes, clock());
    }
  }
}

/** Bytes a slice needs room for before it is admitted (budgetedMarkerSlice admits it the same way): its least rows at C. At most the whole
 * budget: a flip never costs more than an empty minute holds (revokeMinuteChanges), so the wait for room always ends. */
export function revokeSliceNeed(db: DatabaseSync): number {
  paceNeedNow = revokePaceNeed(db); // and the same slice's need in the pace's minute, for revokeWriteWaitMs
  return Math.min(Math.ceil(revokeCostPerChange(db) * needRows(db, {})), REVOKE_WRITE_BUDGET.bytesPerMinute);
}
/** Milliseconds until `need` bytes fit in the minute (0: now): in the rows x C ledger, and `paceNeed` (revokePaceNeed, by default the one
 * the latest revokeSliceNeed computed) in the pace's. */
export function revokeWriteWaitMs(need: number, now: number = clock(), paceNeed: number = paceNeedNow): number {
  trim(now);
  return Math.max(waitIn(ledger, spent, need, REVOKE_WRITE_BUDGET.bytesPerMinute, now), revokePaceWaitMs(paceNeed, now));
}
/** Milliseconds until the pace has room for `paceNeed` bytes (0: now). A need of the whole pace or more (a flip that runs alone) waits for an
 * EMPTY pace, as admission does; outstanding copies that alone leave no room are looked at again every COPY_POLL_MS, or at their bound
 * if sooner (each look retries the drain's own copy). Never 0 while admission would refuse, so the runner never spins. */
export function revokePaceWaitMs(paceNeed: number = 0, now: number = clock()): number {
  trim(now);
  const limit = paceLimit(), need = Math.min(Math.max(0, paceNeed), limit);
  if (paceSpent + copyHeld + need <= limit) return 0;
  if (copyHeld + need > limit) return Math.max(1, Math.min(COPY_POLL_MS, copySince + COPY_PROOF_MAX_MS - now));
  return waitIn(paced, paceSpent, need + copyHeld, limit, now);
}
/** Rows the open drain-owned transaction has changed so far (0: none open). */
function txRows(db: DatabaseSync): number { return txStartChanges === null ? 0 : Math.max(0, totalChanges(db) - txStartChanges); }
/** The most rows a queued receipt flip is planned at (r3.6, Astra r3.6d High 6): a minute of the write budget at the ceiling, and never more
 * than one drain commit (cap + step reserve). A bigger plan hangs on the wildcard pair (revoke-commit.ts receiptPlanTooBig), so every flip,
 * a persisted one too (its plan is read again when it drains), commits inside the cap. */
export function revokeFlipCutoffRows(db: DatabaseSync): number {
  return Math.min(revokeMinuteChanges(db), REVOKE_PACE_COMMIT.rows + MARKER_STEP_RESERVE);
}
/** Bytes a drain commit needs room for in the pace's minute before it is admitted (r3.6): the previous commit's measured bytes, at most the
 * whole pace (then it waits for an empty pace). Settles the proven copies first (Astra r3.6d: every wait decision does). */
export function revokePaceNeed(db: DatabaseSync): number {
  const now = clock();
  trim(now); settleCopies(db, now);
  return Math.min(lastCommitBytes, paceLimit());
}
/** Whether the pace admits a drain commit now: empty, or room for the previous commit's bytes. */
function paceAdmits(): boolean {
  const used = paceSpent + copyHeld;
  const limit = paceLimit();
  return used === 0 || used + Math.min(lastCommitBytes, limit) <= limit;
}
/** Settles the copy debt (r3.6c): when the log is proven completely copied now (logCopied: the drain's own copy, or the index), the debt
 * and any late copies are dated now, in the minute the copy landed. Otherwise debt older than COPY_PROOF_MAX_MS is dated now without proof
 * (its copy minute) and kept as a late copy, to be charged again when it lands. Called before every admission and wait decision. */
function settleCopies(db: DatabaseSync, now: number): void {
  if (!(copyHeld > 0) && !(lateHeld > 0)) { readyLog(db); return; }
  const copied = logCopied(db);
  const index = copied || revokePaceTestHooks.unmeasurable ? null : walIndexMark(db);
  if (copyDeferred && index !== null) { copyMark = { salt: index.salt, lastFrame: index.mxFrame }; copyDeferred = false; }
  if (lateHeld > 0) {
    // the late record lands when ITS frames are copied, whatever the rest of the log (a newer reader may still pin later frames)
    const adopted = lateDeferred && index !== null;
    if (lateDeferred && index !== null) { lateSalt = index.salt; lateLastFrame = index.mxFrame; lateDeferred = false; }
    if (copied || (!adopted && (index !== null && lateSalt !== null && (index.salt !== lateSalt || index.nBackfill >= lateLastFrame)))) {
      revokeWriteMeter.copiesLanded += lateHeld; notePace(lateHeld, now, 0);
      lateHeld = 0; lateSalt = null; lateLastFrame = 0; lateDeferred = false;
    }
  }
  if (copied && copyHeld > 0) {
    revokeWriteMeter.copiesSettled += copyHeld; notePace(copyHeld, now, 0); copyHeld = 0;
    return;
  }
  if (copyHeld > 0 && now - copySince >= COPY_PROOF_MAX_MS) {
    revokeWriteMeter.copiesLapsed += copyHeld;
    // coalesced: the newest lapse is the latest in the log, so its frames being copied proves every earlier one's
    lateLastFrame = lateHeld > 0 && lateSalt === copyMark.salt ? Math.max(lateLastFrame, copyMark.lastFrame) : copyMark.lastFrame;
    lateSalt = copyMark.salt; lateDeferred = copyDeferred; lateHeld += copyHeld;
    notePace(copyHeld, now, 0); copyHeld = 0;
  }
}
/** Before a drain transaction (every wait decision outside one, the runner tick and the bounded drain run it first): a log another
 * connection's checkpoint left completely copied is reset now, so the drain's next commit appends under the salt it marks rather than
 * restarting the log (rows x W). Never waits (resetCopiedLog). */
function readyLog(db: DatabaseSync): void {
  if (revokePaceTestHooks.unmeasurable || db.isTransaction) return;
  const index = walIndexMark(db);
  if (index !== null && index.mxFrame > 0 && index.nBackfill >= index.mxFrame) resetCopiedLog(db, index.salt, index.mxFrame);
}
/** Whether the log is proven completely copied now (r3.6c): the log index says so (nBackfill >= mxFrame), or, outside a transaction, the
 * drain's own PASSIVE checkpoint copied all of it (its own result, read at once: checkpointed >= log, so no other connection's restart can
 * stand in for it). The drain copies only when the uncopied tail is at most its own debt plus one commit at the ceiling ((cap + reserve) x W)
 * of frames, whoever wrote them: the serving thread never copies a backlog larger than that. (The reset's TRUNCATE copies whatever landed
 * after its guard; data_version detects those foreign commits and the reset charges them.) A log proven copied, with frames in it, is reset (resetCopiedLog). Never waits. */
function foregroundCheckpoint(db:DatabaseSync,mode:"PASSIVE"|"TRUNCATE",copy:()=>unknown):{log?:number;checkpointed?:number;busy?:number}|undefined {
  const mark=walIndexMark(db);if(!mark)return undefined;
  const ceiling=checkpointCeiling(Math.max(0,mark.mxFrame-mark.nBackfill),bytesPerChange(db),ioMeterPageSize());
  const row=ioBudget.foregroundCopy(ceiling,copy) as {log?:number;checkpointed?:number;busy?:number}|undefined;
  if(row&&Number(row.checkpointed)>=0){
    const complete=mode==="TRUNCATE"?Number(row.busy)===0:Number(row.checkpointed)>=Number(row.log);
    ioBudget.backfilled({salt:mark.salt,frame:complete?mark.mxFrame:Number(row.checkpointed),complete});
  }
  return row;
}
function logCopied(db: DatabaseSync): boolean {
  if (revokePaceTestHooks.unmeasurable) return false;
  const index = walIndexMark(db);
  if (index === null) return false;
  let copied = index.nBackfill >= index.mxFrame, proved = index.mxFrame;
  if (!copied && !db.isTransaction && (index.mxFrame - index.nBackfill) * frameBytes(db) <= copyHeld + lateHeld + (REVOKE_PACE_COMMIT.rows + MARKER_STEP_RESERVE) * revokeChangeCeiling(db)) {
    revokeWriteMeter.selfCopies++;
    try {
      const result = foregroundCheckpoint(db,"PASSIVE",()=>db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get());
      const log = Number(result?.log), done = Number(result?.checkpointed);
      copied = log >= 0 && done >= log; proved = log;
    } catch { copied = false; }
  }
  if (copied && proved > 0) resetCopiedLog(db, index.salt, proved);
  return copied;
}
/** PRAGMA data_version on this handle: it moves for another connection's commit, never for this one's; null when unreadable. */
function sqlDataVersion(db: DatabaseSync): number | null {
  try { const value = Number(db.prepare("PRAGMA data_version").get()?.data_version); return Number.isFinite(value) ? value : null; } catch { return null; }
}
function resetDataVersion(db: DatabaseSync): number | null {
  if (revokePaceTestHooks.dataVersion) return revokePaceTestHooks.dataVersion();
  return sqlDataVersion(db);
}
/** Resets a copied log with no busy wait. Foreign commits in the guard window are detected by data_version and charged even on busy, at
 * the rows x W fallback on every OS (1.0.21 B1: no OS counter is an input; that fallback does not bound arbitrary foreign writes). */
function resetCopiedLog(db: DatabaseSync, salt: string, mxFrame: number): void {
  if (db.isTransaction) return;
  let timeout: number;
  try { timeout = Number((db.prepare("PRAGMA busy_timeout").get() as { timeout?: number } | undefined)?.timeout); } catch { return; }
  if (!Number.isSafeInteger(timeout) || timeout < 0) return;
  // C2 r3.8: the reset enters wal-maintenance's fence before it reads its guard. enter() never blocks the server thread (r3.6): false means
  // a checkpointer pass is in flight, so the reset defers: it is skipped now and the next drain step tries again (this function never
  // waits). Never starved: a deferred reset leaves its intent up for at most FENCE_HOLD_MS, so the worker holds back the next timed pass
  // (it yields to a pending resetWant, capped at 250 ms there) and the retry at the next step finds the worker idle. The intent is dropped
  // in the finally on a run, and by the timer when no retry comes.
  const fence = walResetFence();
  if (!fence.enter()) {
    revokeWriteMeter.logResetsSkipped++;
    // leaves through a fresh fence: the worker may have restarted since the skip
    if (fenceHold === null) {
      fenceHoldFire = () => { fenceHold = null; fenceHoldFire = null; walResetFence().leave(); };
      fenceHold = setTimeout(fenceHoldFire, resetFenceTestHooks.holdMs); fenceHold.unref();
    }
    return;
  }
  if (fenceHold !== null) { clearTimeout(fenceHold); fenceHold = null; fenceHoldFire = null; }
  try { resetCopiedLogFenced(db, salt, mxFrame, timeout); } finally { fence.leave(); }
}
const FENCE_HOLD_MS = 250;
/** Test only: the hold of a deferred reset's intent (default FENCE_HOLD_MS). */
export const resetFenceTestHooks: { holdMs: number; fireNow(): void } = {
  holdMs: FENCE_HOLD_MS,
  /** Runs the pending hold-timer callback now (no wall clock in tests). */
  fireNow() { const fire = fenceHoldFire; if (fire !== null) { if (fenceHold !== null) clearTimeout(fenceHold); fire(); } },
};
let fenceHoldFire: (() => void) | null = null;
let fenceHold: ReturnType<typeof setTimeout> | null = null;
function resetCopiedLogFenced(db: DatabaseSync, salt: string, mxFrame: number, timeout: number): void {
  try {
    db.exec("PRAGMA busy_timeout=0");
    revokePaceTestHooks.beforeResetGuard?.();
    const dv0 = resetDataVersion(db);
    if (dv0 === null) { revokeWriteMeter.logResetsSkipped++; return; }
    const again = revokePaceTestHooks.unmeasurable ? null : walIndexMark(db);
    if (again === null || again.salt !== salt || again.mxFrame !== mxFrame || again.nBackfill < again.mxFrame) { revokeWriteMeter.logResetsSkipped++; return; }
    try {
      revokePaceTestHooks.inResetWindow?.();
      const result = foregroundCheckpoint(db,"TRUNCATE",()=>db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get());
      if (Number(result?.busy) === 0) revokeWriteMeter.logResets++; else revokeWriteMeter.logResetsBusy++;
    } catch { revokeWriteMeter.logResetsBusy++; }
    finally {
      const dv1 = resetDataVersion(db), now = clock();
      if (dv1 === null || dv1 !== dv0) {
        revokeWriteMeter.resetForeignUnknown++;
        notePace(Math.max(lastCommitRows, REVOKE_PACE_COMMIT.rows + 512) * revokeChangeCeiling(db), now, 0);
      }
    }
  } catch { revokeWriteMeter.logResetsBusy++; }
  finally { try { db.exec(`PRAGMA busy_timeout=${timeout}`); } catch { /* closed */ } }
}
/** Input rows a runner job step or late build may take now (r3.6, H4): the rows the open transaction has left under the cap, or 0 when the
 * pace does not admit it (the runner then waits revokeWriteWaitMs(revokeSliceNeed)). */
export function revokePaceRows(db: DatabaseSync, now: number = clock()): number {
  trim(now); settleCopies(db, now);
  return paceAdmits() ? Math.max(0, REVOKE_PACE_COMMIT.rows - txRows(db)) : 0;
}
/** Charges `changed` rows a runner job step or late build wrote in the rows x C ledger, now, tagged with the drain-owned transaction (its
 * COMMIT dates them again). The pace charges them, measured, at that COMMIT (endRevokeMeasure). */
export function chargeRevokeRows(db: DatabaseSync, changed: number): void {
  if (!(changed > 0)) return;
  const bytes = Math.ceil(changed * revokeCostPerChange(db));
  revokeWriteMeter.slices++; revokeWriteMeter.charged += bytes;
  noteRevokeBytes(bytes, clock());
}
function waitIn(on: Entry[], total: number, need: number, budget: number, now: number): number {
  let used = total;
  if (used + need <= budget) return 0;
  for (const entry of on) {
    used -= entry.bytes;
    if (used + need <= budget) return Math.max(1, entry.at + REVOKE_WRITE_WINDOW_MS - now);
  }
  return REVOKE_WRITE_WINDOW_MS;
}

/** Counters for tests and the drain bench: slices that changed rows and the bytes they were charged; the runner's measurements, their bytes
 * and rows; measurements over the ceiling (more than rows x W plus one commit's leaf rebalances, REVOKE_COMMIT_REBALANCE_FRAMES, or past W
 * a row while the whole run is); the
 * largest cost a row (raw: bytes over rows, splits included) and the largest commit measured. */
export const revokeWriteMeter = { slices: 0, charged: 0, osBeyond: 0, osMeasured: 0, paceMeasured: 0, paceUnmeasured: 0, paceWaits: 0, paceDated: 0, copiesSettled: 0, copiesLapsed: 0, copiesLanded: 0, selfCopies: 0, logResets: 0, logResetsBusy: 0, logResetsSkipped: 0, resetForeignMeasured: 0, resetForeignUnknown: 0, foreignSamples: 0, measured: 0, measuredBytes: 0, measuredChanges: 0, overCeiling: 0, maxPerChange: 0, maxSliceBytes: 0, floorRows: 0, inlineOverLedger: 0 };

/** V13: the rows the latest owner walk on a handle changed while the ledger was shut (a revoke id is walked inline by its own commit only). */
const overWalks = new WeakMap<DatabaseSync, { id: number; rows: number }>();
/** One marker slice inside the budget (the caller's transaction): "budget" when the minute has no room for its least rows at C (nothing
 * ran: the caller waits revokeWriteWaitMs(revokeSliceNeed)), else markerSlice's answer. The slice's cap in rows is its allowance at C, less
 * the step reserve the marker may run past its cap. What it changed is charged rows x C, at the C it was admitted with, whatever it returns
 * or throws (a rolled-back slice too: it dirtied its pages), dated now; the charge ages out in 60 s and nothing moves it. `only`: an owner's
 * inline walk (revoke-commit.ts markInline), inside the owner's own transaction, charged the same way. `floor`: that walk is of a memory
 * root and may use the inline floor (INLINE_FLOOR) when the minute is spent. */
export function budgetedMarkerSlice(db: DatabaseSync, rows: number, ms: number, late: Parameters<typeof markerSlice>[3] = null, opts: Pick<MarkerSliceOptions, "only"> & { floor?: boolean } = {}): boolean | "budget" {
  chargeReleaseWork();
  const now = clock();
  trim(now);
  const per = revokeCostPerChange(db);
  let room = Math.floor((REVOKE_WRITE_BUDGET.bytesPerMinute - spent) / per);
  const need = needRows(db, opts);
  let floored = false, overDone = -1;
  if (room < need) {
    // the one fallback: a flip planned when the budget was larger than today's (tests) costs more than an empty minute holds; an empty
    // minute admits it with the whole budget as its allowance rather than never (its excess is at most its planning-time minute)
    // MEMORY V2 V13 (F31), which generalises the 1.0.21 cause5 inline floor: an owner's root always walks inline up to the inline cap
    // (`need`: 576 rows, inside the caller's 8 ms), whatever the minute holds and whatever its root kind. It is still charged below, so
    // the background pays for it; before, a spent minute left the owner's own forget queued behind the whole backlog with its windows
    // open. `floored` is kept as cause5's count of the memory-root rows walked this way inside its floor (INLINE_FLOOR above; a meter now,
    // no longer the condition).
    // The inline cap is the WALK's, not each slice's: the committing writer (revoke-commit.ts markInline) asks slice after slice inside its
    // 8 ms, and a shut ledger no longer ends that loop, so the rows one revoke's walk changed past the ledger are counted here and the walk
    // gets its least slice once (MIN_SLICE_CHANGES, and the one step the marker may run past it: 576 rows in all, the bound cause5's floor
    // gave a commit: cause5-import-window-1021.test.ts C5-6, C5-7). What is left stays queued for the runner, window open (fail closed).
    if (opts.only !== undefined) {
      const walk = overWalks.get(db);
      overDone = walk !== undefined && walk.id === opts.only ? walk.rows : 0;
      if (overDone >= MIN_SLICE_CHANGES) return "budget";
      floored = opts.floor === true && inlineFloorLeft(now) > 0; revokeWriteMeter.inlineOverLedger++;
      room = need - overDone;
    } else if (!(spent === 0 && need === headFlipCost(db) && need > revokeMinuteChanges(db))) return "budget";
    else room = need;
  }
  // the pace (r3.6): a background slice runs only when the pace admits a commit (empty, or room for the previous commit's measured bytes),
  // and its cap is what the transaction has left of REVOKE_PACE_COMMIT.rows; a waiting flip (planned at most cap + reserve,
  // revokeFlipCutoffRows) gets its whole commit. The marker may run past a cap by its step reserve. An owner's inline walk (`only`) is outside
  // the pace (R3).
  if (opts.only === undefined) {
    settleCopies(db, now);
    if (!paceAdmits()) { revokeWriteMeter.paceWaits++; return "budget"; }
    const left = Math.max(REVOKE_PACE_COMMIT.rows * revokeIdleClosingBatch(), headFlipCost(db) - MARKER_STEP_RESERVE) - txRows(db);
    room = Math.min(room, MARKER_STEP_RESERVE + Math.max(0, left));
  }
  const before = totalChanges(db);
  try {
    // the paced drain serves several jobs inside this same cap and deadline (revoke-marker.ts MARKER_SLICE_JOBS); an owner's inline walk stays its own revoke
    // (1.0.21 mem-f3 c) and commits the queued head flips first, inside this same cap and deadline: while one waited it walked nothing
    const moved = markerSlice(db, rows, ms, late, room - MARKER_STEP_RESERVE, opts.only === undefined ? { jobs: MARKER_SLICE_JOBS.max } : { only: opts.only, headFlips: true });
    return moved === "blocked" ? "budget" : moved;
  } finally {
    const changed = Math.max(0, totalChanges(db) - before);
    if (changed > 0) {
      const bytes = Math.ceil(changed * per), at = clock();
      revokeWriteMeter.slices++; revokeWriteMeter.charged += bytes;
      noteRevokeBytes(bytes, at);
      if (opts.only === undefined) noteClosingRows(changed, at); // the floor counts what either path did (V8)
      if (floored) { floorLedger.push({ at, rows: changed }); floorRows += changed; }
      if (overDone >= 0 && opts.only !== undefined) {
        // the count ends with the synchronous run of the commit that walks (markInline asks slice after slice without yielding): a revoke
        // id taken again after a rollback, or a job reopened by a later transaction, starts from 0
        if (!overWalks.has(db)) queueMicrotask(() => { overWalks.delete(db); });
        overWalks.set(db, { id: opts.only, rows: overDone + changed });
      }
    }
  }
}

/** The WAL index header (the -shm file, native byte order): frames in the log and the salt of its current generation. */
type WalIndexMark = { mxFrame: number; salt: string; nBackfill: number };
const shmFiles = new WeakMap<DatabaseSync, string | null>();
function shmFileOf(db: DatabaseSync): string | null {
  if (shmFiles.has(db)) return shmFiles.get(db)!;
  let file: string | null = null;
  try {
    const main = (accountedPrepare(db, "PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main");
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
  // Reserve the bounded file metadata/header operations even on failed probes.
  chargeReleaseWork(8);
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
    // the two header copies, then the checkpoint info's nBackfill (offset 96: frames already copied into the main file; r3.6, H5)
    const head = Buffer.alloc(100);
    if (fs.readSync(fd, head, 0, 100, 0) !== 100 || !head.subarray(0, 48).equals(head.subarray(48, 96))) return null;
    const u32 = (at: number) => endianness() === "LE" ? head.readUInt32LE(at) : head.readUInt32BE(at);
    if (u32(0) !== WALINDEX_VERSION || head[12] !== 1) return null;
    return { mxFrame: u32(16), salt: head.subarray(32, 40).toString("hex"), nBackfill: u32(96) };
  } catch { return null; }
}
/** Diagnostics, kept for older callers: since 1.0.21 B1 no OS byte is charged, so this stays 0. */
export function revokeOsOverheadBytes(): number { return revokeWriteMeter.osBeyond; }
/** A drain-owned transaction's starting point for its measurement: the index mark right after its BEGIN (null: no readable index), the
 * data_version then (B1), the handle's change count, `os` (always null since B1), the bytes charged so far, and the transaction's tag (its charges and paced bytes). */
export type RevokeMeasure = { mark: WalIndexMark | null; dataVersion?: number | null; changes: number; os: number | null; charged: number; tx: number };
/** Right after the BEGIN of a transaction the caller itself will COMMIT (the runner tick, drainRevokeMarkerBounded, the bench), with the
 * writer lock held: what the measurement at its COMMIT counts from. Every such transaction is then measured for the pace (endRevokeMeasure),
 * whatever it held. */
export function beginRevokeMeasure(db: DatabaseSync): RevokeMeasure {
  chargeReleaseWork();
  let inside = false;
  try { inside = db.isTransaction; } catch { inside = false; }
  // Obtain every fallible input before publishing ownership of the measurement.
  const unreadable = revokePaceTestHooks.unmeasurable, changes = totalChanges(db);
  const mark = inside && !unreadable ? walIndexMark(db) : null;
  // 1.0.21 B1: the commit count other connections have made, read with the writer lock held; the frames counted at the COMMIT are this
  // transaction's own only while it has not moved (data_version moves for another connection's commit, never for this one's).
  const dataVersion = mark !== null ? sqlDataVersion(db) : null;
  const tx = inside ? ++nextTx : 0;
  currentTx = tx; currentTxDb = inside ? db : null;
  txStartChanges = inside ? changes : null;
  return { mark, dataVersion, changes, os: null, charged: revokeWriteMeter.charged, tx };
}
/** Right after that transaction's own COMMIT (or its ROLLBACK: `cost` false), before anything else runs on this thread.
 * 1.0.21 B1 (MEMORY-V2-DESIGN 4.8, one measure everywhere, never another writer's bytes): a transaction that changed 0 rows costs 0 and
 * takes no sample. Otherwise it costs its own log frames (mxFrame now minus mxFrame right after its BEGIN) ONLY when that difference is
 * provably its own: the log salt is unchanged and PRAGMA data_version, read after this sample, has not moved since the BEGIN. COMMIT
 * releases the writer lock before this runs, so another connection's commit can land between the COMMIT and the sample (Astra High,
 * mem-f3-opusrace revoke-budget.ts:694); its frames would be counted, but it also moves data_version, so the sample is then refused. In
 * every other case (unreadable, salt changed, data_version moved or unreadable) it costs rows x W, the ceiling. No OS counter is an
 * input on any OS (the io watchdog keeps them for its alarm line), so the same transaction is charged the same on darwin, win32 and linux.
 * The pace, for every such transaction, charged now: a write half and a copy half, each that cost; the copy half is held outstanding until
 * the log is proven copied (settleCopies: the drain's own copy, right after this COMMIT). Their sum is what the next admission needs room
 * for (`committed`; a ROLLBACK only raises it).
 * Admission: its rows x C charges are dated now, at its COMMIT, so the whole transaction leaves the minute together; when it held the
 * marker's slice and nothing else (`cost`), its own frames over the rows it changed go into C (noteRevokeCost). The measured own log bytes,
 * or null. */
export function endRevokeMeasure(db: DatabaseSync, from: RevokeMeasure, cost: boolean = true, committed: boolean = true): number | null {
  try {
    chargeReleaseWork();
    const unreadable = revokePaceTestHooks.unmeasurable;
    const rows = Math.max(0, totalChanges(db) - from.changes);
    // frames: only under the salt of the mark, never fewer than at the mark, and only while no other connection committed (data_version
    // read AFTER the index, so a commit landing after the sample also refuses it). A zero-row transaction takes no sample at all.
    let bytes: number | null = null, index: WalIndexMark | null = null;
    if (rows > 0 && !unreadable) {
      index = walIndexMark(db);
      revokePaceTestHooks.betweenSampleAndVersion?.();
      const own = from.mark && index && index.salt === from.mark.salt && index.mxFrame >= from.mark.mxFrame
        && from.dataVersion != null && sqlDataVersion(db) === from.dataVersion;
      if (own) bytes = (index!.mxFrame - from.mark!.mxFrame) * frameBytes(db) + (from.mark!.mxFrame === 0 && index!.mxFrame > 0 ? WAL_HEADER : 0);
      else if (from.mark && index && index.salt === from.mark.salt) revokeWriteMeter.foreignSamples++;
    }
    const now = clock();
    trim(now); // the open transaction's entries are still protected here (trim), so none ages out before it is taken
    const strict = rows * revokeChangeCeiling(db);
    const ledgerHeld = from.tx ? takeTx(ledger, from.tx) : 0;
    spent -= ledgerHeld;
    if (currentTx === from.tx) { currentTx = 0; currentTxDb = null; txStartChanges = null; }
    const own = rows === 0 ? 0 : Math.ceil(bytes ?? strict);
    const write = own, copy = own;
    if (rows > 0 && bytes === null) revokeWriteMeter.paceUnmeasured += write + copy;
    else revokeWriteMeter.paceMeasured += write + copy;
    if (write > 0) notePace(write, now, 0);
    if (committed) lastCommitRows = rows;
    if (rows > 0 && (committed || write + copy > lastCommitBytes)) lastCommitBytes = write + copy;
    // CLOSING-1022: an idle closing commit's own bytes enter its wall-clock minute (revokeIdleClosingWaitMs)
    if (idleClosing && committed && own > 0) { idleClosingDone.push({ at: now, bytes: own }); idleClosingSpent += own; }
    if (copy > 0) { copyHeld += copy; copySince = now; copyMark = index !== null ? { salt: index.salt, lastFrame: index.mxFrame } : { salt: null, lastFrame: 0 }; copyDeferred = index === null; }
    // the drain proves its own copy (r3.6c, H-a), with or without a checkpointer thread: right after its COMMIT, outside the transaction, it
    // copies the log itself (PASSIVE: it never waits on a reader) and resets it when that left it completely copied. A reader that pins the
    // copy leaves the debt held; every later wait decision tries again, and COPY_PROOF_MAX_MS bounds it
    settleCopies(db, now);
    // admission: the transaction's charges dated at its COMMIT (they and its overhead leave the minute together)
    if (ledgerHeld > 0) { push(ledger, ledgerHeld, now, 0); spent += ledgerHeld; }
    if (!cost) return null;
    if (bytes === null || !(rows > 0) || !(bytes > 0)) return null;
    noteRevokeCost(db, bytes, rows);
    return bytes;
  } finally {
    if (currentTx === from.tx) { currentTx = 0; currentTxDb = null; txStartChanges = null; }
  }
}
