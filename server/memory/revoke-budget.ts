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
// - The charge, at the COMMIT, at once: a write half, the most of its OS bytes (Linux, the thread's write_bytes; macOS, the addon's
//   diskWritten; win32 has no OS floor in the watchdog) and its log frames; and a copy half, its log frames. An unreadable component, or a
//   log restarted under a new salt, counts as rows x W.
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
import fs from "node:fs";
import { endianness } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { headFlipCost, receiptFlipCost, MARKER_STEP_RESERVE, markerSlice, markerSliceDetailed, totalChanges, type MarkerSliceOptions, type MarkerSliceOutcome } from "./revoke-marker.ts";
import { darwinWrittenBytes } from "../os-disk-written.ts";
import { walResetFence } from "../wal-maintenance.ts";

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
/** Test only: make every measurement unreadable (fail-closed checks); `osUnknown`: the OS write count reads as unavailable. */
export const revokePaceTestHooks: { unmeasurable: boolean; osUnknown: boolean; beforeResetGuard: (() => void) | null; inResetWindow: (() => void) | null; resetCounter: (() => number | null) | null; dataVersion: (() => number | null) | null; platform: string | null } = { unmeasurable: false, osUnknown: false, beforeResetGuard: null, inResetWindow: null, resetCounter: null, dataVersion: null, platform: null };

/** Test hooks: a fake clock (none: the wall clock), and an empty ledger with C back at its seed. */
export function setRevokeBudgetClock(next?: () => number): void { clock = next ?? (() => Date.now()); }
export function resetRevokeWriteBudget(): void {
  ledger.length = 0; spent = 0; paced.length = 0; paceSpent = 0; copyHeld = 0; copySince = 0; copyMark = { salt: null, lastFrame: 0 }; lateHeld = 0; lateSalt = null; lateLastFrame = 0; currentTx = 0; currentTxDb = null; txStartChanges = null; cost = null; lastCommitBytes = 0; lastCommitRows = 0; copyDeferred = false; lateDeferred = false; paceNeedNow = 0;
  for (const key of Object.keys(revokeWriteMeter) as Array<keyof typeof revokeWriteMeter>) revokeWriteMeter[key] = 0;
}

/** Ages out charges older than the minute, except those of the drain-owned transaction still open (r3.6, Medium): they leave only after its
 * COMMIT dates them again, so a transaction held open past the minute never drops out while it runs. (An open entry at the head keeps the
 * entries behind it a little longer too: conservative.) */
function trim(now: number): void {
  const open = (e: Entry) => currentTx !== 0 && e.tx === currentTx;
  while (ledger.length && ledger[0]!.at <= now - REVOKE_WRITE_WINDOW_MS && !open(ledger[0]!)) spent -= ledger.shift()!.bytes;
  while (paced.length && paced[0]!.at <= now - REVOKE_WRITE_WINDOW_MS && !open(paced[0]!)) paceSpent -= paced.shift()!.bytes;
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
  const limit = REVOKE_PACE.bytesPerMinute, need = Math.min(Math.max(0, paceNeed), limit);
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
  return Math.min(lastCommitBytes, REVOKE_PACE.bytesPerMinute);
}
/** Whether the pace admits a drain commit now: empty, or room for the previous commit's bytes. */
function paceAdmits(): boolean {
  const used = paceSpent + copyHeld;
  return used === 0 || used + Math.min(lastCommitBytes, REVOKE_PACE.bytesPerMinute) <= REVOKE_PACE.bytesPerMinute;
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
function logCopied(db: DatabaseSync): boolean {
  if (revokePaceTestHooks.unmeasurable) return false;
  const index = walIndexMark(db);
  if (index === null) return false;
  let copied = index.nBackfill >= index.mxFrame, proved = index.mxFrame;
  if (!copied && !db.isTransaction && (index.mxFrame - index.nBackfill) * frameBytes(db) <= copyHeld + lateHeld + (REVOKE_PACE_COMMIT.rows + MARKER_STEP_RESERVE) * revokeChangeCeiling(db)) {
    revokeWriteMeter.selfCopies++;
    try {
      const result = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { log?: number; checkpointed?: number } | undefined;
      const log = Number(result?.log), done = Number(result?.checkpointed);
      copied = log >= 0 && done >= log; proved = log;
    } catch { copied = false; }
  }
  if (copied && proved > 0) resetCopiedLog(db, index.salt, proved);
  return copied;
}
/** Darwin reset bytes stay unknown until the gate Mac proves checkpoint writes in diskWritten. */
const DARWIN_RESET_COUNTER_TRUSTED = false;
function resetOsBytes(): number | null {
  if (revokePaceTestHooks.resetCounter) return revokePaceTestHooks.resetCounter();
  const platform = revokePaceTestHooks.platform ?? process.platform;
  if (platform === "linux") { const blocks = threadWriteBlocks(); return blocks === null ? null : blocks * 512; }
  if (platform === "darwin" && DARWIN_RESET_COUNTER_TRUSTED) return darwinWrittenBytes();
  return null;
}
function resetDataVersion(db: DatabaseSync): number | null {
  if (revokePaceTestHooks.dataVersion) return revokePaceTestHooks.dataVersion();
  try { const value = Number(db.prepare("PRAGMA data_version").get()?.data_version); return Number.isFinite(value) ? value : null; } catch { return null; }
}
/** Resets a copied log with no busy wait. Foreign commits in the guard window are detected by data_version and charged even on busy.
 * Unknown or zero counters take the mandated rows x W fallback; that fallback does not bound arbitrary foreign writes. */
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
    const os0 = resetOsBytes();
    try {
      revokePaceTestHooks.inResetWindow?.();
      const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
      if (Number(result?.busy) === 0) revokeWriteMeter.logResets++; else revokeWriteMeter.logResetsBusy++;
    } catch { revokeWriteMeter.logResetsBusy++; }
    finally {
      const os1 = resetOsBytes(), dv1 = resetDataVersion(db), now = clock();
      if (dv1 === null || dv1 !== dv0) {
        const delta = dv1 !== null && os0 !== null && os1 !== null ? os1 - os0 : null;
        const bytes = delta !== null && delta > 0 ? delta : Math.max(lastCommitRows, REVOKE_PACE_COMMIT.rows + 512) * revokeChangeCeiling(db);
        if (delta !== null && delta > 0) revokeWriteMeter.resetForeignMeasured++; else revokeWriteMeter.resetForeignUnknown++;
        notePace(bytes, now, 0);
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
export const revokeWriteMeter = { slices: 0, charged: 0, osBeyond: 0, osMeasured: 0, paceMeasured: 0, paceUnmeasured: 0, paceWaits: 0, paceDated: 0, copiesSettled: 0, copiesLapsed: 0, copiesLanded: 0, selfCopies: 0, logResets: 0, logResetsBusy: 0, logResetsSkipped: 0, resetForeignMeasured: 0, resetForeignUnknown: 0, measured: 0, measuredBytes: 0, measuredChanges: 0, overCeiling: 0, maxPerChange: 0, maxSliceBytes: 0 };

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
  // the pace (r3.6): a background slice runs only when the pace admits a commit (empty, or room for the previous commit's measured bytes),
  // and its cap is what the transaction has left of REVOKE_PACE_COMMIT.rows; a waiting flip (planned at most cap + reserve,
  // revokeFlipCutoffRows) gets its whole commit. The marker may run past a cap by its step reserve. An owner's inline walk (`only`) is outside
  // the pace (R3).
  if (opts.only === undefined) {
    settleCopies(db, now);
    if (!paceAdmits()) { revokeWriteMeter.paceWaits++; return "budget"; }
    const left = Math.max(REVOKE_PACE_COMMIT.rows, headFlipCost(db) - MARKER_STEP_RESERVE) - txRows(db);
    room = Math.min(room, MARKER_STEP_RESERVE + Math.max(0, left));
  }
  const before = totalChanges(db);
  try {
    const moved = markerSlice(db, rows, ms, late, room - MARKER_STEP_RESERVE, opts);
    return moved === "blocked" ? "budget" : moved;
  } finally {
    const changed = Math.max(0, totalChanges(db) - before);
    if (changed > 0) {
      const bytes = Math.ceil(changed * per), at = clock();
      revokeWriteMeter.slices++; revokeWriteMeter.charged += bytes;
      noteRevokeBytes(bytes, at);
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
    // the two header copies, then the checkpoint info's nBackfill (offset 96: frames already copied into the main file; r3.6, H5)
    const head = Buffer.alloc(100);
    if (fs.readSync(fd, head, 0, 100, 0) !== 100 || !head.subarray(0, 48).equals(head.subarray(48, 96))) return null;
    const u32 = (at: number) => endianness() === "LE" ? head.readUInt32LE(at) : head.readUInt32BE(at);
    if (u32(0) !== WALINDEX_VERSION || head[12] !== 1) return null;
    return { mxFrame: u32(16), salt: head.subarray(32, 40).toString("hex"), nBackfill: u32(96) };
  } catch { return null; }
}
/** This thread's OS-accounted write blocks (Linux /proc/thread-self/io write_bytes >> 9: its own part of getrusage's ru_oublock, which
 * io-budget reads as resourceUsage().fsWrite); null off Linux or when unreadable. IO-IDLE-DRAIN-1018 r3.3. */
function threadWriteBlocks(): number | null {
  if (process.platform !== "linux") return null;
  try {
    const m = /^write_bytes:\s*(\d+)\s*$/m.exec(fs.readFileSync("/proc/thread-self/io", "utf8"));
    const bytes = m ? Number(m[1]) : Number.NaN;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? Math.floor(bytes / 512) : null;
  } catch { return null; }
}
/** The drain's OS write blocks for one transaction (r3.6): Linux, its thread's; macOS, the whole process's (the addon's diskWritten / 512:
 * other threads' writes in the same span only add to it). null elsewhere or when unreadable. */
function txOsBlocks(): number | null {
  if (process.platform === "linux") return threadWriteBlocks();
  if (process.platform !== "darwin") return null;
  const bytes = darwinWrittenBytes();
  return bytes === null ? null : bytes / 512;
}
/** Diagnostics: the OS bytes the marker's own transactions wrote beyond what they were charged, and then charged (revokeWriteMeter.osBeyond). */
export function revokeOsOverheadBytes(): number { return revokeWriteMeter.osBeyond; }
/** A drain-owned transaction's starting point for its measurement: the index mark right after its BEGIN (null: no readable index), the
 * handle's change count, this thread's OS write blocks, the bytes charged so far, and the transaction's tag (its charges and paced bytes). */
export type RevokeMeasure = { mark: WalIndexMark | null; changes: number; os: number | null; charged: number; tx: number };
/** Right after the BEGIN of a transaction the caller itself will COMMIT (the runner tick, drainRevokeMarkerBounded, the bench), with the
 * writer lock held: what the measurement at its COMMIT counts from. Every such transaction is then measured for the pace (endRevokeMeasure),
 * whatever it held. */
export function beginRevokeMeasure(db: DatabaseSync): RevokeMeasure {
  let inside = false;
  try { inside = db.isTransaction; } catch { inside = false; }
  // Obtain every fallible input before publishing ownership of the measurement.
  const unreadable = revokePaceTestHooks.unmeasurable, changes = totalChanges(db);
  const mark = inside && !unreadable ? walIndexMark(db) : null;
  const os = inside && !unreadable && !revokePaceTestHooks.osUnknown ? txOsBlocks() : null;
  const tx = inside ? ++nextTx : 0;
  currentTx = tx; currentTxDb = inside ? db : null;
  txStartChanges = inside ? changes : null;
  return { mark, changes, os, charged: revokeWriteMeter.charged, tx };
}
/** Right after that transaction's own COMMIT (or its ROLLBACK: `cost` false), before anything else runs on this thread.
 * The pace (r3.6), for every such transaction, charged now: a write half = the most of its OS bytes (Linux thread / macOS process;
 * unreadable: rows x W; win32: none) and its log frames (unreadable, fewer, or the log restarted under a new salt: rows x W); and a copy
 * half = its log frames (same rule), held outstanding until the log is proven copied (settleCopies: the drain's own copy, right after this
 * COMMIT). Their sum is what
 * the next admission needs room for (`committed`; a ROLLBACK only raises it).
 * Admission: its rows x C charges are dated now, at its COMMIT, so the whole transaction leaves the minute together; when it held the
 * marker's slice and nothing else (`cost`), its OS bytes beyond them are charged too and the frames over the rows it changed go into C
 * (noteRevokeCost, same salt only). The measured log bytes, or null. */
export function endRevokeMeasure(db: DatabaseSync, from: RevokeMeasure, cost: boolean = true, committed: boolean = true): number | null {
  try {
    // First, before anything else runs on this thread: what the transaction cost the OS counter.
    const unreadable = revokePaceTestHooks.unmeasurable;
    const os = from.os === null || unreadable ? null : txOsBlocks();
    const osBytes = os !== null && from.os !== null && os >= from.os ? (os - from.os) * 512 : null;
    const rows = Math.max(0, totalChanges(db) - from.changes);
    // frames: only under the salt of the mark, never fewer than at the mark. ANY restart in between is rows x W (r3.6c: the restart rule is
    // gone; no generation is ever attributed to the drain): another connection can checkpoint the drain's frames and restart the log smaller
    // after its COMMIT (Astra r3.6b High). The drain's own copy resets a copied log before its next BEGIN (resetCopiedLog), so its commits
    // append under the salt they marked.
    let bytes: number | null = null;
    const index = !unreadable ? walIndexMark(db) : null;
    if (from.mark && index && index.salt === from.mark.salt && index.mxFrame >= from.mark.mxFrame) {
      bytes = (index.mxFrame - from.mark.mxFrame) * frameBytes(db) + (from.mark.mxFrame === 0 && index.mxFrame > 0 ? 32 : 0);
    }
    const now = clock();
    trim(now); // the open transaction's entries are still protected here (trim), so none ages out before it is taken
    const strict = rows * revokeChangeCeiling(db);
    const ledgerHeld = from.tx ? takeTx(ledger, from.tx) : 0;
    spent -= ledgerHeld;
    if (currentTx === from.tx) { currentTx = 0; currentTxDb = null; txStartChanges = null; }
    const osTerm = process.platform === "win32" ? 0 : osBytes ?? strict;
    const frameTerm = bytes ?? strict;
    const write = Math.ceil(Math.max(osTerm, frameTerm)), copy = Math.ceil(frameTerm);
    if (osBytes === null && process.platform !== "win32" || bytes === null) revokeWriteMeter.paceUnmeasured += write + copy;
    else revokeWriteMeter.paceMeasured += write + copy;
    notePace(write, now, 0);
    if (committed) lastCommitRows = rows;
    if (rows > 0 && (committed || write + copy > lastCommitBytes)) lastCommitBytes = write + copy;
    if (copy > 0) { copyHeld += copy; copySince = now; copyMark = index !== null ? { salt: index.salt, lastFrame: index.mxFrame } : { salt: null, lastFrame: 0 }; copyDeferred = index === null; }
    // the drain proves its own copy (r3.6c, H-a), with or without a checkpointer thread: right after its COMMIT, outside the transaction, it
    // copies the log itself (PASSIVE: it never waits on a reader) and resets it when that left it completely copied. A reader that pins the
    // copy leaves the debt held; every later wait decision tries again, and COPY_PROOF_MAX_MS bounds it
    settleCopies(db, now);
    // admission: the transaction's charges dated at its COMMIT (they and its overhead leave the minute together), then the overhead
    if (ledgerHeld > 0) { push(ledger, ledgerHeld, now, 0); spent += ledgerHeld; }
    if (!cost) return null;
    if (osBytes !== null) {
      revokeWriteMeter.osMeasured += osBytes;
      const beyond = Math.max(0, osBytes - Math.max(0, revokeWriteMeter.charged - from.charged));
      if (beyond > 0) { revokeWriteMeter.osBeyond += beyond; revokeWriteMeter.charged += beyond; noteRevokeBytes(beyond, now); }
    }
    if (bytes === null || !(rows > 0) || !(bytes > 0)) return null;
    noteRevokeCost(db, bytes, rows);
    return bytes;
  } finally {
    if (currentTx === from.tx) { currentTx = 0; currentTxDb = null; txStartChanges = null; }
  }
}
