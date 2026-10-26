// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The upgrade work that no longer holds the app closed. After an update the history may need several passes over data that is not in the way of
// anything else: proofs about memory rows (integrity-pass.ts), the repair of older replies' lineage, the conversion of stored root sets, the index
// of open request cards and the table of pending browser checks. They run here, after the server listens, one at a time through one queue (so two
// writers never work the lineage tables together), each in slices of a few tens of milliseconds with the event loop handed back between them and the
// writer gate (awaitWriterGate) honoured before each. Every job keeps its place in the file, so a stopped server carries on where it was.
// A job's feature stays held (replay withheld, the card index read the long way, pending browser notes left as they were) until the job is done.
import type { DatabaseSync } from "node:sqlite";
import { readIntegrityPass, integrityHoldOf, integrityRunning, INTEGRITY_TOTAL, type IntegrityPassRow } from "./integrity-state.ts";
import { memoryHeldCode } from "./memory-gate.ts";
import { stepIntegrityPass, holdMessage, OUTPUT_END, REFERENCES_END, SHAPES_END } from "./integrity-pass.ts";
import { lineageRepairPending, repairOutputRootBackfillSteps } from "./schema.ts";
import { compactRootSetsStep, lineageStorageStatus, settleReclaim } from "./root-set-compaction.ts";
import { notifyThreadCardsReady, priorityThreadsPending, stepPriorityThreads } from "../transcript-backfill.ts";
import { walkerPending, walkMessagesChunk } from "../message-walker.ts";
import { messageSearchFillPending, stepMessageSearchBackfill } from "../message-search-index.ts";
import { lineageBackfillSlice, lineageCertProgress, upgradeMarkerJobs, upgradeMarkerWork } from "./lineage-backfill.ts";
import type { ExactCounts } from "./upgrade-counts.ts";
import { UpgradeProgressTracker, UNKNOWN_OUTSIDE, idleUpgradeState, upgradeCounts, type LaunchWindow, type UpgradeOutside, type UpgradeProgress } from "./upgrade-progress.ts";
import { memoryCaptures, memoryRecalls } from "./capture-gate.ts";
import { memoryChecking } from "./integrity-flags.ts";
import { stepScrubPass } from "./scrub-pass.ts";
import { scrubPassPending } from "./scrub-state.ts";

const SCRUB_WALKS = ["versions", "records", "details", "feedback"] as const;
import type { StorageState, StoredMode, UpgradeState } from "../../shared/upgrade-contract.mjs";
import { heldStep } from "../observe.ts";
import { drainRevokeMarkerBounded } from "./memory-revocation.ts";
import { upgradeMarkerWalked } from "./revoke-marker.ts";

export type BackgroundJob = "integrity" | "scrub" | "lineage" | "writetime" | "storage" | "message-index" | "search-index";
/** Longest a slice works before handing back. */
/** 20 ms slices, each followed by a pause at least as long (the tick adds the slice's own time): a request waits behind at most ~20 ms of work and the
 * loop is at most half busy for the hours the write-time backfill runs. The slices stay on the main connection (they write the same file the owner's
 * requests read; a worker connection would add lock contention for no gain at this duty cycle). */
export const BACKGROUND_SLICE_MS = 20;
export const BACKGROUND_PAUSE_MS = 20;
/** Back-off while a seed commit is blocked: the job stays queued and retries, doubling up to the cap. */
export const BACKGROUND_SEED_RETRY_MS = 1_000;
/** Capped so a blocked seed retries (and the strip moves) well inside a minute. */
export const BACKGROUND_SEED_RETRY_MAX_MS = 15_000;
export const BACKGROUND_BUSY_PAUSE_MS = 250;
export const BACKGROUND_LOCKED_RETRY_MS = 1_000;
export const BACKGROUND_FAILURE_RETRY_MS = 5_000;

export interface BackgroundHooks {
  /** Awaited before each slice (the writer gate). */
  admit?: () => Promise<void>;
  /** True while an owner turn is live: the pause between slices is longer, never infinite. */
  busy?: () => boolean;
  /** I/O throttling permits at most one slice per BACKGROUND_DEFER_PROGRESS_MS; owner work still takes precedence. */
  defer?: () => boolean;
  /** True while the write-ahead log is large and still growing (the checkpointer is not keeping up): the work pauses between slices
   *  (BACKGROUND_WAL_PAUSE_MS), still at least one slice per BACKGROUND_DEFER_PROGRESS_MS. */
  walPressure?: () => boolean;
  /** Runs a slice under its I/O source, so the budget names this work when it writes too much (io-budget.ts withSource). */
  withSource?: <T>(run: () => T) => T;
  /** False once the connection is closed or replaced: the run ends quietly. */
  stillOpen?: () => boolean;
  /** The integrity pass moved or finished. */
  onIntegrity?: (row: IntegrityPassRow | null) => void;
  /** The lineage repair finished (true) or a slice failed (false: replay stays withheld, the job retries). */
  onLineage?: (ok: boolean, error?: unknown) => void;
  /** Progress changed (paced). */
  onProgress?: (progress: UpgradeProgress) => void;
  onError?: (job: BackgroundJob, error: unknown) => void;
  /** Test hook: called after each slice with the job it ran. A throw here is a kill. */
  afterSlice?: (job: BackgroundJob) => void;
  /** Rates (units per second per phase) a previous upgrade measured: they give the first estimate before this run has measured its own. */
  priorRates?: Record<string, number>;
  /** The rates this run measured, when it finishes. */
  onRates?: (rates: Record<string, number>) => void;
  /** The part of the launch-wide range the background work covers (see upgrade-overall.ts). */
  launch?: LaunchWindow;
  /** Where the exact counts come from (upgrade-counts.ts): merged into the progress once they exist. */
  countsSource?: () => ExactCounts | null;
  /** What the contract's reading says about the rest of the server (whether the whole upgrade is over, any hold, the owner's mode, the storage conversion); defaults to upgradeOutside(db). */
  outside?: () => Partial<UpgradeOutside>;
  /** The table of pending browser notes has just become complete: the recovery that waited for it can run now. */
  onBrowserChecksIndexed?: () => void;
  /** Every job has finished: the launch-wide mark can be cleared. */
  onComplete?: () => void;
  /** The clock a slice's deadline is kept on (performance.now() by default); a test gives a simulated one. */
  now?: () => number;
  /** Test hook: called after each row the message walker handles (a test charges a simulated cost per row here). */
  walkRow?: () => void;
  sliceMs?: number; pauseMs?: number; busyPauseMs?: number; lockedRetryMs?: number; failureRetryMs?: number;
  /** Test hook: the integrity pass's slice sizes. */
  integrity?: { receiptSlice?: number; referenceSlice?: number; shapeSlice?: number; learningSlice?: number };
}

/** The most rows of messages one slice of the walker covers; the slice's time (sliceMs) stops it sooner on a slow disk or a heavy row. */
const WALK_ROWS = 2_000;
// (DATABASE_BUSY: a slice's own background budget ran out, database.ts beginBackground: the same "try later")
const lockedError = (error: unknown) => { const e = error as { errcode?: unknown; message?: unknown; code?: unknown } | null; if (e?.code === "DATABASE_BUSY") return true; return typeof e?.errcode === "number" ? (e.errcode & 0xff) === 5 : /database is locked|SQLITE_BUSY/i.test(String(e?.message ?? "")); };

/** The jobs this file still has to run, in the order they run. */
export function backgroundJobsPending(db: DatabaseSync): BackgroundJob[] {
  const jobs: BackgroundJob[] = [];
  // The walker over the messages comes first: it fills the derived structures readers fall back to the long way for (the open request cards an owner has to
  // answer, the pending browser notes), so an approval is exact for every thread as early as possible. Then the proofs, the lineage, the sets.
  try { if (walkerPending(db).length) jobs.push("message-index"); } catch { /* absent */ }
  try { if (integrityRunning(readIntegrityPass(db))) jobs.push("integrity"); } catch { /* absent */ }
  // The 1.0.4 scrub of bank, card, account and id numbers in earlier memory (scrub-pass.ts), after the proofs: it rewrites only rows they passed.
  try { if (scrubPassPending(db)) jobs.push("scrub"); } catch { /* absent */ }
  try { if (lineageRepairPending(db)) jobs.push("lineage"); } catch { /* absent */ }
  // The write-time lineage of the history (lineage-backfill.ts, DESIGN-WRITETIME 4), after the repair it reads: until it is done every
  // generated line of an upgraded file reads "checking". The strip shows its rows walked of rows to walk (memory_lineage_cert).
  // (a certificate that is ready while the marker still walks the revokes its seed opened keeps the job, so the strip says so)
  try { const cert = lineageCertProgress(db); if (cert.phase !== "absent" && (!cert.ready || upgradeMarkerJobs(db) > 0)) jobs.push("writetime"); } catch { /* absent */ }
  // (the v6 -> v7 root-set conversion, "storage", is off from v10: no root set is written again, STORAGE-AUDIT 2)
  try { if (messageSearchFillPending(db)) jobs.push("search-index"); } catch { /* absent */ }
  return jobs;
}

const WEIGHTS: Record<string, number> = { masking: 2, settling: 0.5, "output-index": 3, references: 3, shapes: 2, learning: 0.5, lineage: 3, writetime: 3, marker: 1, storage: 2, "message-index": 3, "search-index": 1 };
const phasesOf = (jobs: BackgroundJob[]) => jobs.flatMap(job => job === "integrity" ? ["output-index", "references", "shapes", "learning"] : job === "writetime" ? ["writetime", "marker"] : job === "scrub" ? ["masking", "settling"] : [job]).map(id => ({ id, weight: WEIGHTS[id] ?? 1, total: 0 }));

export interface BackgroundStatus {
  pending: boolean;
  /** Phase id running, "" when nothing is. */
  phase: string;
  done: number; total: number;
  hold: string | null;
  holdMessage: string | null;
  repaired: number;
  progress: UpgradeProgress | null;
  /** 0 to 1 over the whole launch, never lower than shown before; 1 when there is no background work. */
  overall: number;
  /** True only when every proof and every background job has really finished and found nothing wrong (a held pass is finished but not complete). */
  complete: boolean;
  /** The same facts in the contract's shape (shared/upgrade-contract.mjs): what the screens read. */
  upgrade: UpgradeState;
}
const statuses = new WeakMap<object, { tracker: UpgradeProgressTracker | null; jobs: BackgroundJob[]; refresh?: () => void }>();
const MODES: ReadonlySet<string> = new Set(["off", "capture", "active", "paused"]);
/** What the rest of the server contributes to the contract's reading of this connection. `replayHeld` is the lineage repair still owing (database.ts knows it). Facts it cannot read are "unknown", never guessed. */
export function upgradeOutside(db: DatabaseSync, replayHeld = false): UpgradeOutside {
  let row: IntegrityPassRow | null = null;
  try { row = readIntegrityPass(db); } catch { return UNKNOWN_OUTSIDE; }
  // the hold the capture path reads (the connection's flags), or the one the pass row carries: either switches capture and recall off
  const hold = memoryHeldCode(db) ?? integrityHoldOf(row), state = statuses.get(db);
  let mode: string | undefined;
  try { mode = db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode as string | undefined; } catch { mode = undefined; }
  let storage: StorageState = "unknown";
  try { const state = lineageStorageStatus(db).state; storage = state === "waiting" ? "idle" : state; } catch { /* the conversion's state is not readable now */ }
  const known = mode !== undefined && MODES.has(mode);
  const held = hold !== null;
  // a hold is not completion (known), whatever else is not yet known
  const complete = held ? false : !state ? "unknown" as const : !state.jobs.length && !integrityRunning(row) && !held && (row === null || row.result === "passed") && !replayHeld;
  return {
    complete, held, holdKey: held ? "memoryStrip.hold" : null,
    // the same predicates as the capture path (capture-gate.ts); a hold switches both off whatever the stored mode is
    capture: held ? "off" : known ? (memoryCaptures(mode, hold) ? "on" : "off") : "unknown",
    recall: held ? "off" : known ? (memoryRecalls(mode, hold) ? "on" : "off") : "unknown",
    storedMode: known ? mode as StoredMode : "unknown", storage,
    // a large set's proof waiting or running in this process: the owner sees "Checking earlier memory" until it is done
    checking: memoryChecking(),
  };
}
/** What the health answer says about the background work of this connection. */
export function backgroundStatus(db: DatabaseSync, replayHeld = false): BackgroundStatus {
  let row: IntegrityPassRow | null = null;
  try { row = readIntegrityPass(db); } catch { /* closed */ }
  const hold = integrityHoldOf(row), state = statuses.get(db);
  state?.refresh?.();
  const pending = Boolean(state?.jobs.length);
  const progress = state?.tracker ? state.tracker.snapshot(pending) : null;
  const upgrade = progress?.upgrade ?? idleUpgradeState(upgradeOutside(db, replayHeld));
  return { pending, phase: progress?.phase ?? "", done: progress?.done ?? 0, total: progress?.total ?? 0, hold, holdMessage: hold ? holdMessage(hold) : null, repaired: row?.repaired ?? 0, progress, overall: progress?.overall ?? (pending ? 0 : 1), upgrade,
    complete: !pending && !integrityRunning(row) && hold === null && (row === null || row.result === "passed") };
}

interface Slice { more: boolean; done: number; total: number; phase?: string; /** things handled, where the job counts them exactly (rows walked) */ counted?: number | null }
type JobRunner = { id: BackgroundJob; slice(): Slice | "busy" | "failed"; observe?(): Slice };
/** A slice that must stay queued and run again after `retryMs` (a blocked seed): not a failure, never dropped. */
interface RetryLater extends Slice { retryMs: number }

/** One runner per job. A slice does about `sliceMs` of work and commits what it did before it returns. */
function runners(db: DatabaseSync, hooks: BackgroundHooks): Map<BackgroundJob, JobRunner> {
  const sliceMs = hooks.sliceMs ?? BACKGROUND_SLICE_MS;
  const out = new Map<BackgroundJob, JobRunner>();
  out.set("integrity", { id: "integrity", slice() {
    const step = stepIntegrityPass(db, { budgetMs: sliceMs, ...(hooks.now ? { now: hooks.now } : {}), ...hooks.integrity });
    hooks.onIntegrity?.(step.row);
    const row = step.row;
    const phase = row?.phase === "done" || !row ? "learning" : row.phase;
    const edge = phase === "output-index" ? [0, OUTPUT_END] : phase === "references" ? [OUTPUT_END, REFERENCES_END] : phase === "shapes" ? [REFERENCES_END, SHAPES_END] : [SHAPES_END, INTEGRITY_TOTAL];
    const within = Math.max(0, Math.min(1, ((row?.done ?? 0) - edge[0]!) / (edge[1]! - edge[0]!)));
    return { more: step.more, done: Math.round(within * 1000), total: 1000, phase };
  } });
  out.set("scrub", { id: "scrub", slice() {
    const step = stepScrubPass(db, { budgetMs: sliceMs, ...(hooks.now ? { now: hooks.now } : {}) });
    // one bar for the four walks (each a quarter, by its rowid against the table's newest), and one for settling
    const walk = SCRUB_WALKS.indexOf(step.phase as typeof SCRUB_WALKS[number]);
    const phase = walk >= 0 ? "masking" : "settling";
    const done = walk >= 0 ? Math.round(((walk + Math.min(1, step.done / Math.max(step.total, 1))) / SCRUB_WALKS.length) * 1000) : step.more ? 0 : 1000;
    if (step.retryMs !== undefined && step.more) return { more: true, retryMs: step.retryMs, done, total: 1000, phase } as RetryLater;
    return { more: step.more, done, total: 1000, phase };
  } });
  let lineage: ReturnType<typeof repairOutputRootBackfillSteps> | null = null, lineageProgress = { done: 0, total: 0 };
  out.set("lineage", { id: "lineage", slice() {
    try {
      lineage ??= repairOutputRootBackfillSteps(db, { sliceMs, waitBusy: true, onProgress: progress => { lineageProgress = progress; } });
      // a thread that finishes early does not end the slice: the next one starts, until the slice has used its time
      const began = performance.now();
      for (;;) {
        const step = lineage.next();
        if (step.done) { lineage = null; hooks.onLineage?.(true); return { more: false, done: lineageProgress.total, total: lineageProgress.total }; }
        if (step.value === "busy") return "busy";
        if (performance.now() - began >= sliceMs) return { more: true, done: lineageProgress.done, total: lineageProgress.total };
      }
    } catch (error) {
      lineage = null;
      if (lockedError(error)) return "busy";
      hooks.onLineage?.(false, error);
      throw error;
    }
  } });
  let markerDone = 0, seedBlocks = 0;
  const observeWritetime = (): Slice => {
    const cert = lineageCertProgress(db);
    if (!cert.ready) return { more: true, done: cert.done, total: Math.max(cert.total, 1) };
    markerDone = Math.max(markerDone, upgradeMarkerWalked(db));
    const left = upgradeMarkerWork(db), more = upgradeMarkerJobs(db) > 0;
    const total = Math.max(markerDone + (more ? Math.max(1, left) : 0), 1);
    return { more, done: more ? markerDone : total, total, phase: "marker" };
  };
  out.set("writetime", { id: "writetime", observe: observeWritetime, slice() {
    const step = lineageBackfillSlice(db, { budgetMs: sliceMs, ...(hooks.now ? { now: hooks.now } : {}) });
    const cert = lineageCertProgress(db);
    // a blocked seed commit: the job stays queued and retries with a growing pause (it used to end the job, so write time was dropped for the process)
    if (step.blocked) { seedBlocks++; return { more: true, retryMs: Math.min(BACKGROUND_SEED_RETRY_MAX_MS, BACKGROUND_SEED_RETRY_MS * 2 ** Math.min(seedBlocks - 1, 6)), done: Math.min(cert.done, Math.max(cert.total, 1)), total: Math.max(cert.total, 1) } as RetryLater; }
    seedBlocks = 0;
    if (!cert.ready) return { more: step.more, done: Math.min(cert.done, Math.max(cert.total, 1)), total: Math.max(cert.total, 1) };
    // The certificate is ready, and the marker walks the revokes the seed opened (lines read "checking" until it has): its own phase, counted in
    // those revokes. It is the job's last phase, so it ends the job.
    const queuedBefore = upgradeMarkerWork(db);
    if (queuedBefore === 0) return observeWritetime();
    try { drainRevokeMarkerBounded(db, { rows: 512, ms: sliceMs }, { background: true }); } catch { /* the revocation runner carries on with what is left */ }
    // done counts the work the walk has done (rows read and written, and frontier nodes finished): it only grows, however fast the queue refills as
    // it drains. total is that plus what is queued now, so it may grow as a node fans out; done never goes past it.
    return observeWritetime();
  } });
  out.set("storage", { id: "storage", slice() {
    const step = compactRootSetsStep(db, { maxMs: sliceMs });
    const status = lineageStorageStatus(db);
    if (!step.remaining) settleReclaim(db);
    return { more: step.remaining, done: status.done, total: status.total };
  } });
  // One walk, every structure that needs the whole history (open cards, pending browser notes, first rows of turns): the rows of a window are read once.
  // A thread an owner request asked about while the walk was unfinished is prepared first (transcript-backfill.ts stepPriorityThreads).
  // Both stop at the slice's deadline (looked at after every row) and keep their cursors at the last row handled, so the next slice carries on from there.
  const now = hooks.now ?? (() => performance.now());
  let lastWalk = { done: 0, total: 0, counted: null as number | null };
  out.set("message-index", { id: "message-index", slice() {
    const deadline = now() + sliceMs;
    if (priorityThreadsPending(db)) heldStep("upgrade.message-index.priority", () => stepPriorityThreads(db, { rows: WALK_ROWS, deadline, now }));
    // a prepared thread that used the whole slice leaves the walk to the next one (the slice never runs past its time by more than one row)
    if (now() >= deadline) return { more: true, done: lastWalk.done, total: lastWalk.total, counted: lastWalk.counted };
    const step = heldStep("upgrade.message-index.walk", () => walkMessagesChunk(db, { rows: WALK_ROWS, deadline, now, ...(hooks.walkRow ? { onRow: hooks.walkRow } : {}) }));
    lastWalk = { done: step.done, total: step.total, counted: step.rowsWalked };
    if (step.completed.includes("open_card")) notifyThreadCardsReady(null);
    if (step.completed.includes("browser_check")) { try { hooks.onBrowserChecksIndexed?.(); } catch { /* a recovery failure never stops the walk */ } }
    return { more: step.more, done: step.done, total: step.total, counted: step.rowsWalked };
  } });
  out.set("search-index", { id: "search-index", slice() {
    const step = stepMessageSearchBackfill(db);
    return { more: step.more, done: step.done, total: step.total };
  } });
  return out;
}

/** The jobs whose output is derived from rows that stay in the file (indexes over messages) commit with synchronous=NORMAL: a power cut can lose the
 * last slices of them, which are simply made again, and every slice stops paying for a full sync. The proofs and the lineage keep FULL. */
const DERIVED_JOBS: ReadonlySet<BackgroundJob> = new Set(["message-index", "search-index"]);
function derivedSlice<T>(db: DatabaseSync, job: BackgroundJob, run: () => T): T {
  if (!DERIVED_JOBS.has(job)) return run();
  db.exec("PRAGMA synchronous=NORMAL");
  try { return run(); } finally { try { db.exec("PRAGMA synchronous=FULL"); } catch { /* closed */ } }
}

export interface BackgroundHandle { done: Promise<void>; stop(): void; slices: number; jobs: BackgroundJob[] }
/** Even under I/O throttling, one small slice can run each interval when no owner work is waiting. */
export const BACKGROUND_DEFER_PROGRESS_MS = 15_000;
/** The pause between slices while the write-ahead log is under pressure (walPressure). */
export const BACKGROUND_WAL_PAUSE_MS = 1_000;
/** The log size past which its growth counts as pressure. */
export const WAL_PRESSURE_BYTES = 256 * 1024 * 1024;
/** A walPressure reading from the log's size: over WAL_PRESSURE_BYTES and larger than at the last reading (a log the checkpointer is
 *  draining shrinks, or restarts, and is no pressure). */
export function walPressureGauge(walBytes: () => number): () => boolean {
  let last = 0;
  return () => {
    let now = 0;
    try { now = walBytes(); } catch { return false; }
    const pressed = now > WAL_PRESSURE_BYTES && now > last;
    last = now;
    return pressed;
  };
}

/** Starts the queue. Resolves `done` when every job is finished or the run is stopped. A failure of one job is reported, the job is tried again
 * later, and the others carry on. */
export function startBackgroundUpgradeWork(db: DatabaseSync, hooks: BackgroundHooks = {}, dbBytes: () => number | null = () => null): BackgroundHandle {
  const jobs = backgroundJobsPending(db);
  const tracker = jobs.length ? new UpgradeProgressTracker("background", upgradeCounts(db, dbBytes()), phasesOf(jobs), Date.now, hooks.priorRates, hooks.launch) : null;
  if (tracker && hooks.countsSource) tracker.setCountsSource(hooks.countsSource);
  tracker?.setOutside(hooks.outside ?? (() => upgradeOutside(db)));
  statuses.set(db, { tracker, jobs: [...jobs] });
  const handle: BackgroundHandle = { done: Promise.resolve(), stop() {}, slices: 0, jobs };
  if (!jobs.length) return handle;
  const table = runners(db, hooks);
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, resolve!: () => void;
  handle.done = new Promise<void>(r => { resolve = r; });
  const queue = [...jobs];
  const report = (job: BackgroundJob, reading: Slice) => {
    // Marker is the next phase of this job. Publish the certificate's final count before the tracker closes writetime.
    if (job === "writetime" && reading.phase === "marker") {
      const cert = lineageCertProgress(db);
      if (cert.ready) tracker?.update("writetime", cert.done, cert.total, true);
    }
    tracker?.update(reading.phase ?? job, reading.done, reading.total, !reading.more, reading.counted ?? null);
  };
  // A revocation runner can finish work while this queue is deferred. Reading progress never starts more work.
  const refresh = () => {
    if (db.isTransaction) return;
    const job = queue[0], reading = job === undefined ? undefined : table.get(job)?.observe?.();
    if (reading) {
      const phase = reading.phase ?? job!;
      const prior = tracker?.snapshot(true).phases.find(item => item.id === phase);
      if (prior?.done === reading.done && prior.total === reading.total && prior.state === (reading.more ? "running" : "done")) return;
      report(job!, reading);
    }
  };
  statuses.set(db, { tracker, jobs: [...queue], refresh });
  const failures = new Map<BackgroundJob, number>();
  const finish = () => { stopped = true; if (timer) clearTimeout(timer); statuses.set(db, { tracker, jobs: [...queue] }); resolve(); };
  handle.stop = finish;
  let lastProgress = 0;
  let lastSliceAt = Date.now();
  const tick = async () => {
    timer = null;
    if (stopped) return;
    let delay = hooks.pauseMs ?? BACKGROUND_PAUSE_MS;
    try {
      if (hooks.admit) await hooks.admit();
      if (stopped) return;
      if (hooks.stillOpen && !hooks.stillOpen()) { finish(); return; }
      const job = queue[0];
      if (job === undefined) { tracker?.finishAll(); const last = tracker!.snapshot(false); hooks.onProgress?.(last); try { hooks.onRates?.(last.rates); } catch { /* calibration is best effort */ } try { hooks.onComplete?.(); } catch { /* as above */ } finish(); return; }
      if (db.isTransaction) { timer = setTimeout(() => { void tick(); }, delay); return; }
      // an owner turn waiting on its preparation goes first: no slice starts while one is live (the check after a slice alone let a slice begin
      // in front of a turn that had just been admitted)
      // I/O throttling spaces out small slices without indefinitely starving unfinished upgrade work.
      if (hooks.busy?.() || (hooks.defer?.() && Date.now() - lastSliceAt < BACKGROUND_DEFER_PROGRESS_MS)) {
        refresh();
        timer = setTimeout(() => { void tick(); }, hooks.busyPauseMs ?? BACKGROUND_BUSY_PAUSE_MS); return;
      }
      // the log grows faster than the checkpointer drains it: give it a moment between slices (RC12, 58.5 s: a 259 ms commit while the log grew 17 MB/s)
      if (Date.now() - lastSliceAt < BACKGROUND_DEFER_PROGRESS_MS && hooks.walPressure?.()) {
        refresh();
        timer = setTimeout(() => { void tick(); }, BACKGROUND_WAL_PAUSE_MS); return;
      }
      lastSliceAt = Date.now();
      const sliceStarted = performance.now();
      // every slice is a named holder: a stall line that falls in one says which job held the loop
      const run = () => heldStep(`upgrade.${job}`, () => table.get(job)!.slice());
      const result = derivedSlice(db, job, () => hooks.withSource ? hooks.withSource(run) : run());
      // at most half the time: the pause after a slice is at least as long as the slice, so the background never writes back to back
      delay = Math.max(delay, Math.round(performance.now() - sliceStarted));
      handle.slices++;
      if (result === "busy") delay = hooks.lockedRetryMs ?? BACKGROUND_LOCKED_RETRY_MS;
      else if (result === "failed") delay = hooks.failureRetryMs ?? BACKGROUND_FAILURE_RETRY_MS;
      else if ("retryMs" in result) { delay = Math.max(delay, (result as RetryLater).retryMs); tracker?.update(result.phase ?? job, result.done, result.total, false, null); }
      else {
        failures.delete(job);
        report(job, result);
        // the integrity job covers three phases: finishing one phase must not close the next
        if (!result.more) { queue.shift(); statuses.set(db, { tracker, jobs: [...queue], refresh }); }
        if (hooks.onProgress && Date.now() - lastProgress >= 500) { lastProgress = Date.now(); hooks.onProgress(tracker!.snapshot(true)); }
        hooks.afterSlice?.(job);
        if (hooks.busy?.()) delay = hooks.busyPauseMs ?? BACKGROUND_BUSY_PAUSE_MS;
      }
    } catch (error) {
      if (hooks.stillOpen && !hooks.stillOpen()) { finish(); return; }
      const job = queue[0];
      if (lockedError(error)) delay = hooks.lockedRetryMs ?? BACKGROUND_LOCKED_RETRY_MS;
      else if (job !== undefined) {
        const count = (failures.get(job) ?? 0) + 1; failures.set(job, count);
        if (count === 1 || count % 10 === 0) { try { hooks.onError?.(job, error); } catch { /* reporting never throws into the loop */ } }
        // a kill from a test hook ends the run; any other failure is retried with growing patience
        if ((error as { killed?: boolean } | null)?.killed) { finish(); return; }
        delay = Math.min(300_000, (hooks.failureRetryMs ?? BACKGROUND_FAILURE_RETRY_MS) * 2 ** Math.min(count - 1, 6));
        // the others carry on: a job that keeps failing goes to the back of the queue
        if (queue.length > 1) queue.push(queue.shift()!);
      }
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, delay);
  };
  timer = setTimeout(() => { void tick(); }, 0);
  return handle;
}

/** Runs every pending job to its end in this call. For tests, and for a caller that needs the work done before it goes on. Throws what a job throws. */
export function runBackgroundUpgradeWorkToEnd(db: DatabaseSync, hooks: BackgroundHooks = {}): void {
  const jobs = backgroundJobsPending(db);
  if (!jobs.length) { statuses.set(db, { tracker: null, jobs: [] }); return; }
  const table = runners(db, { ...hooks, sliceMs: hooks.sliceMs ?? 250 });
  for (const job of jobs) {
    for (;;) {
      const result = heldStep(`upgrade.${job}`, () => table.get(job)!.slice());
      if (result === "busy") throw new Error("database is locked");
      if (result === "failed") throw new Error(`${job} failed`);
      hooks.afterSlice?.(job);
      if (!result.more || "retryMs" in result) break;
    }
  }
  statuses.set(db, { tracker: null, jobs: [] });
}
