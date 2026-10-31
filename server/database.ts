// Invariants of the serving thread's database work (1.0.2 rc13, STALLS-FINAL-DESIGN section 5):
// 1. No lock wait on the serving thread longer than BACKGROUND_BUSY_MS unless a person is waiting for that write (an owner request, a turn,
//    a channel delivery), and then at most OWNER_BUSY_MS. Every background BEGIN IMMEDIATE goes through beginBackground() or a budgeted
//    transaction(); every background autocommit write goes through withBusyBudget().
// 2. While a writer hold is in force (holdWritersForIndexBuild), no background writer starts on the serving thread; it waits on
//    awaitWriterGate() (async) and runs after. Child-worker results are queued, not dispatched, during the hold.
// 3. From server.listen on, every block over the stall threshold is logged with a named holder; the listen tick does nothing but listen and
//    gate; every post-listen job is a named step under the `startup` source.
// 4. A wait with no budget is a bug, not a tolerance: it is logged as `[sqlite] busy ... budget=none at=<caller>` (io-budget.ts).
// 5. Long writers declare themselves and bracket themselves in the log (VACUUM, CREATE INDEX): a start line, holdWritersForIndexBuild(true), an end line.
// 6. Per-pass work stays bounded: an idle visit writes at most one receipt and one mark; a slice holds the lock for at most its budget plus
//    one chunk; nothing here scales with history.
import { initializeTeamIdentityTables } from "./team-identities.ts";
import { chmodSync, closeSync, existsSync, openSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { MEMORY_PRE_V2_SNAPSHOT, MEMORY_PRE_V3_SNAPSHOT, MEMORY_PRE_V4_SNAPSHOT, MEMORY_SCHEMA_VERSION, lineageRepairPending, migrateMemorySchema, repairOutputRootBackfill } from "./memory/schema.ts";
import type { BlockingHeartbeat } from "./memory/blocking-heartbeat.ts";
import { buildEagerIndexesBeforeListen } from "./memory/optional-index.ts";
import { createProgressBoard, preListenHealthPort, setActivePreListenHealth, startPreListenHealth, type PreListenHealth, type ProgressBoard } from "./memory/upgrade-health.ts";
import { UpgradeProgressTracker, nextUpgradeSeq, restampedUpgrade, upgradeCounts } from "./memory/upgrade-progress.ts";
import { unknownUpgradeState } from "../shared/upgrade-contract.mjs";
import { bootLaunchId } from "./memory/boot-nonce.ts";
import { bumpWriteEpoch, ensureWriteRevision, installWriteRevisionTriggers } from "./app-write-revision.ts";
import { integrityPending, setIntegrityFlags } from "./memory/integrity-flags.ts";
import { memoryHeldCode } from "./memory/memory-gate.ts";
import { integrityHoldOf, integrityRunning, maxRowid, readIntegrityPass, writeIntegrityPass } from "./memory/integrity-state.ts";
import { backgroundStatus, backgroundJobsPending, upgradeOutside, startBackgroundUpgradeWork, runBackgroundUpgradeWorkToEnd, walPressureGauge, type BackgroundHandle, type BackgroundHooks } from "./memory/upgrade-background.ts";
import { memoryUpgradeReporter } from "./memory/upgrade-status.ts";
import { initializeInbox } from "./inbox.ts";
import { verifyDerivedRows } from "./branch-index.ts";
import { pendingBranchChanges } from "./memory/branch-change-flag.ts";
import { bumpMessagesVersion } from "./inbox-version.ts";
import { inStatementReusePass, instrumentDatabase, sharedRowsStamp, ioBudget, noteBusyTimeout } from "./io-budget.ts";
import { BACKGROUND_BUSY_MS, DEFAULT_BUSY_MS, DatabaseBusyError, awaitWriterGate, backgroundSourceNow, isDatabaseBusy, noteBusy, setBusy, writersHeldForIndexBuild } from "./db-busy.ts";
import { noteIdentityEpoch } from "./memory/provenance-stamp.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { startTranscriptBackfill, transcriptBackfillWorking, yieldTranscriptBackfillTo } from "./transcript-backfill.ts";
import { txScopeBegin, txScopeEnd } from "./tx-scope.ts";
import { initializeOwnerSends } from "./send-store.ts";
import { initializeBotCalls } from "./bot-calls-schema.ts";
import { initializeAppTriggers } from "./app-trigger-store.ts";
import { prepareMessageSearchBackfill } from "./message-search-index.ts";
import { startupMark } from "./startup-trace.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { upgradeRoomRequestOwed } from "./room-request-owed.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";
import { importLegacyDelegations, initializePendingDelegations, runOwnerHandoffMigration } from "./pending-delegations-schema.ts";
import { initializeProjectCardDelivery } from "./project-card-delivery-schema.ts";
import { createCountsBlock, readCountsBlock, startExactCounts, UPGRADE_COUNTS_FILE } from "./memory/upgrade-counts.ts";
import { clearOverall, overallWriter, readOverallFloor, STARTING_SHARE } from "./memory/upgrade-overall.ts";
import { backfillTurnSourceCopies, initializeTurnSourceHolds, turnSourceCopiesBackfilled } from "./turn-source-holds.ts";
import { observeLine } from "./observe.ts";
import { startWalMaintenance, stopWalMaintenance } from "./wal-maintenance.ts";
import { pathIsWithin, registerTestHandle } from "./test-handle-registry.ts";

/** A random id per opened connection: every stamp, hold and verdict cache that rests on what a connection saw carries it, so nothing judged on one
 * connection is ever reused on its replacement (two fresh connections can show identical change counters). */
const connectionIds = new WeakMap<object, string>();
export function connectionId(db: object): string {
  let id = connectionIds.get(db);
  if (!id) { id = randomUUID().slice(0, 8); connectionIds.set(db, id); }
  return id;
}
const closeHooks = new Set<() => void>();
/** Runs when the connection closes (or is replaced): holders of per-connection memory clear it. */
export function onDatabaseClose(hook: () => void): void { closeHooks.add(hook); }
/** Set when the lineage repair did not finish: replay of outputs from threads not yet repaired is withheld until a later repair succeeds. */
const unrepaired = new WeakMap<object, { failures: number; nextAt: number; timer?: ReturnType<typeof setTimeout> }>();
export function ancestryUnrepaired(db: object): boolean { return unrepaired.has(db) || integrityPending(db) || memoryHeldCode(db) !== null; }
export { integrityPending };
/** Whether the integrity pass (integrity-pass.ts) has not finished on this connection: replay of earlier outputs is withheld until it has. */
export function memoryHoldCode(): string | null { return handle ? memoryHeldCode(handle) : null; }
/** The memory version of the file, or null when it has no memory tables yet. */
function memoryVersionOf(db: DatabaseSync): number | null {
  try { const row = db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get(); return row ? Number(row.schema_version) : null; } catch { return null; }
}
/** At open: what the file says is still to do, as the flags the rest of the server reads. The lineage repair is withheld from the first
 * moment it is pending (it used to run before the server listened); the integrity pass likewise, and a hold left by a finished pass stays. */
/** The flags a pass row stands for, floors included. A pass an earlier build began has no floors: they are taken now and written down once. */
function flagsOfPass(db: DatabaseSync, row: ReturnType<typeof readIntegrityPass>) {
  const running = integrityRunning(row);
  let lessonsFloor: number | null = null, feedbackFloor: number | null = null, eventsFloor: number | null = null;
  if (running && row) {
    lessonsFloor = row.lessonsFloor; feedbackFloor = row.feedbackFloor; eventsFloor = row.eventsFloor;
    if (lessonsFloor === null || feedbackFloor === null || eventsFloor === null) {
      lessonsFloor ??= maxRowid(db, "memory_lessons"); feedbackFloor ??= maxRowid(db, "memory_feedback"); eventsFloor ??= maxRowid(db, "memory_learning_events");
      try { writeIntegrityPass(db, { lessonsFloor, feedbackFloor, eventsFloor }); } catch { /* the floors still hold for this connection */ }
    }
  }
  return { pending: running, hold: integrityHoldOf(row), startedAt: running ? row!.startedAt : null, lessonsFloor, feedbackFloor, eventsFloor };
}
function loadBackgroundFlags(db: DatabaseSync): void {
  const row = readIntegrityPass(db);
  setIntegrityFlags(db, flagsOfPass(db, row));
  if (lineageRepairPending(db) && !unrepaired.has(db)) unrepaired.set(db, { failures: 0, nextAt: 0 });
}
export const REPAIR_RETRY_BASE_MS = 5_000;
export const REPAIR_RETRY_MAX_MS = 300_000;
let repairRetryBase = REPAIR_RETRY_BASE_MS;
/** Test hook: shorten the retry delay. */
export function setRepairRetryBaseMs(ms: number): void { repairRetryBase = ms; }
/** The repair hook, replaceable by a test that injects a failure. */
/** The start-up note's writer, replaceable by a test that records the order of the notes against the work. */
let reporterFactory: typeof memoryUpgradeReporter = memoryUpgradeReporter;
export function setUpgradeReporterForTest(fn: typeof memoryUpgradeReporter | null): void { reporterFactory = fn ?? memoryUpgradeReporter; }
type RepairOptions = { onProgress?: (progress: { done: number; total: number }) => void; deadline?: number };
let repairRunner: (db: DatabaseSync, options?: RepairOptions) => unknown = repairOutputRootBackfill;
export function setRepairRunnerForTest(fn: ((db: DatabaseSync, options?: RepairOptions) => unknown) | null): void { repairRunner = fn ?? repairOutputRootBackfill; }
/** The repair's share of start-up, and of each later slice (1.0.2 lineage-cold r3): what a budget does not reach is carried on after
 * listen, a slice at a time, while the threads not yet repaired stay withheld. */
export const REPAIR_STARTUP_BUDGET_MS = 1_500;
const REPAIR_SLICE_MS = 100, REPAIR_SLICE_GAP_MS = 250;
function runRepair(db: DatabaseSync, onProgress?: (progress: { done: number; total: number }) => void, budgetMs = REPAIR_STARTUP_BUDGET_MS): void {
  // a slice never starts inside another transaction: it waits for the next gap
  if (db.isTransaction) { scheduleRepairSlice(db); return; }
  try {
    const result = repairRunner(db, { ...(onProgress ? { onProgress } : {}), deadline: Date.now() + budgetMs });
    if (result && typeof result === "object" && (result as { unfinished?: boolean }).unfinished) {
      // threads past the budget stay withheld (ancestryUnrepaired) and the rest is repaired in slices
      const state = unrepaired.get(db) ?? { failures: 0, nextAt: 0 };
      unrepaired.set(db, state);
      scheduleRepairSlice(db);
      return;
    }
    const state = unrepaired.get(db);
    if (state?.timer) clearTimeout(state.timer);
    unrepaired.delete(db);
  } catch (error) {
    const state = unrepaired.get(db) ?? { failures: 0, nextAt: 0 };
    state.failures++;
    const delay = Math.min(REPAIR_RETRY_MAX_MS, repairRetryBase * 2 ** Math.min(state.failures - 1, 10));
    state.nextAt = Date.now() + delay;
    if (state.timer) clearTimeout(state.timer);
    unrepaired.set(db, state);
    console.warn(`[memory] lineage backfill repair: ${error instanceof Error ? error.message : String(error)}; replay of earlier outputs is withheld until it succeeds (retry in ${Math.round(delay / 1000)}s)`);
    state.timer = setTimeout(() => { if (handle === db) runRepair(db, undefined, REPAIR_SLICE_MS); }, delay);
    state.timer.unref?.();
  }
}
function scheduleRepairSlice(db: DatabaseSync): void {
  const state = unrepaired.get(db) ?? { failures: 0, nextAt: 0 };
  unrepaired.set(db, state);
  if (state.timer) clearTimeout(state.timer);
  state.nextAt = Date.now() + REPAIR_SLICE_GAP_MS;
  state.timer = setTimeout(() => { if (handle === db) runRepair(db, undefined, REPAIR_SLICE_MS); }, REPAIR_SLICE_GAP_MS);
  state.timer.unref?.();
}
/** Retry the repair now (also what the background timer runs). */
export function retryAncestryRepair(): void { if (handle) runRepair(handle, undefined, REPAIR_SLICE_MS); }

let background: BackgroundHandle | null = null;
/** The handle whose jobs are still running (null once its `done` settles, it is stopped, or the connection closes). */
let runningBackground: BackgroundHandle | null = null;
function trackBackground(started: BackgroundHandle): BackgroundHandle {
  runningBackground = started.jobs.length ? started : null;
  if (runningBackground) void started.done.then(() => { if (runningBackground === started) runningBackground = null; }, () => { if (runningBackground === started) runningBackground = null; });
  return started;
}
/** Whether the upgrade work that reads the history (integrity pass, lineage, write-time backfill, message and search indexes) is running in
 * this process now. Idle memory work yields to it (memory/worker-controller.ts upgradeYield; rc13 real-data run: idle scans beside the upgrade
 * were 25 of the 44 stalls over 250 ms). */
export function backgroundUpgradeRunning(): boolean { return runningBackground !== null; }
/** The one reading every caller that yields to the upgrade uses: the background upgrade runs, or the transcript backfill is reading (not merely
 * waiting: stall r2 L1). The idle lanes, the claim index and the memory status all key on it, so a status reading never goes live while the
 * lanes still hold back (rc13 M2: the status keyed on the upgrade alone and read its tables live beside a running backfill). */
export function historyUpgradeRunning(deps: { upgrade?: () => boolean; backfill?: () => boolean } = {}): boolean {
  return (deps.upgrade ?? backgroundUpgradeRunning)() || (deps.backfill ?? transcriptBackfillWorking)();
}
/** The block the exact-count thread of this launch publishes into (upgrade-counts.ts). */
let launchCounts: SharedArrayBuffer | null = null;
/** The hooks that connect the background work (upgrade-background.ts) to this connection's flags. */
function backgroundHooks(db: DatabaseSync, extra: BackgroundHooks = {}): BackgroundHooks {
  return {
    stillOpen: () => handle === db,
    // the upgrade's writes are named to the I/O budget, and the work waits while the budget holds it back
    defer: () => ioBudget.shouldDefer("memory-upgrade"),
    walPressure: walPressureGauge(() => fileBytes(`${handlePath ?? ""}-wal`)),
    withSource: run => ioBudget.withSource("memory-upgrade", run),
    onIntegrity: row => { setIntegrityFlags(db, flagsOfPass(db, row)); },
    onLineage: (ok, error) => {
      if (ok) { const state = unrepaired.get(db); if (state?.timer) clearTimeout(state.timer); unrepaired.delete(db); return; }
      const state = unrepaired.get(db) ?? { failures: 0, nextAt: 0 };
      state.failures++; unrepaired.set(db, state);
      console.warn(`[memory] lineage backfill repair: ${error instanceof Error ? error.message : String(error)}; replay of earlier outputs is withheld until it succeeds`);
    },
    onError: (job, error) => { if (!isDatabaseBusy(error)) console.warn(`[memory] upgrade work (${job}): ${error instanceof Error ? error.message : String(error)}; it carries on from where it was`); },
    ...extra,
  };
}
/** Starts the upgrade work that reads the history (called by the server once it listens; see upgrade-background.ts). Slices of a few tens of
 * milliseconds, the writer gate honoured before each, slower while an owner turn is live. Resumable; a second call replaces the first. */
export function startBackgroundUpgrade(options: BackgroundHooks = {}): BackgroundHandle {
  const db = database();
  // An ordinary start (nothing left over from an upgrade): no counts thread, no progress tracker, no overall writer, no calibration read. What
  // remains is the empty queue, which a later call to this function (a restore, a data-dir switch) replaces.
  if (!backgroundJobsPending(db).length) {
    clearOverall(DATA_DIR);
    background = trackBackground(startBackgroundUpgradeWork(db, backgroundHooks(db, { admit: awaitWriterGate, ...options }), () => fileBytes(handlePath ?? "")));
    return background;
  }
  // There is deliberately no checkpoint here: a synchronous wal_checkpoint(TRUNCATE) after listen blocked the first responses on a large log left by a forced
  // termination (the busy timeout limits lock waiting, not checkpoint I/O). The log is cut back off the serving thread by the checkpointer of the
  // wal3 lane (PASSIVE, with journal_size_limit=0) when it merges, and meanwhile by the idle storage sweep (maintainLineageStorage), which never waits on a lock.
  background?.stop();
  // Rates a previous upgrade measured (units per second per phase, thousandths) live beside the other cursors, not in a file of their own.
  const priorRates: Record<string, number> = {};
  try { for (const row of db.prepare("SELECT name, cursor FROM transcript_index_state WHERE name LIKE 'upgrade_rate:%'").all()) priorRates[String(row.name).slice(13)] = Number(row.cursor) / 1000; } catch { /* none measured yet */ }
  const keepRates = (rates: Record<string, number>) => {
    try { for (const [phase, rate] of Object.entries(rates)) if (rate > 0) db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES (?, 1, ?, 0)").run(`upgrade_rate:${phase}`, Math.round(rate * 1000)); } catch { /* calibration is best effort */ }
  };
  // The launch-wide measure: the blocking stage owned the first STARTING_SHARE of it; the work here covers the rest, from where an earlier run of this same upgrade had got to.
  const floor = readOverallFloor(DATA_DIR, MEMORY_SCHEMA_VERSION);
  const writer = overallWriter(DATA_DIR, MEMORY_SCHEMA_VERSION, Date.now, floor);
  const launch = { from: STARTING_SHARE, to: 1, floor, persist: writer };
  // The exact counts: the thread of the blocking stage if this launch had one, else one started now (cached figures appear at once for a file nothing has written to since).
  if (!launchCounts && handlePath) { launchCounts = createCountsBlock(); startExactCounts(handlePath, join(DATA_DIR, UPGRADE_COUNTS_FILE), launchCounts); }
  const countsBlock = launchCounts;
  background = trackBackground(startBackgroundUpgradeWork(db, backgroundHooks(db, { admit: awaitWriterGate, priorRates, onRates: keepRates, launch, countsSource: () => readCountsBlock(countsBlock ?? undefined), outside: () => upgradeOutside(db, ancestryUnrepaired(db)), onComplete: () => clearOverall(DATA_DIR), ...options }), () => fileBytes(handlePath ?? "")));
  if (!background.jobs.length) clearOverall(DATA_DIR);
  return background;
}
/** Runs every pending background job to its end in this call (a test, or a caller that cannot go on until the work is done). */
export function finishBackgroundUpgradeWorkNow(options: BackgroundHooks = {}): void {
  const db = database();
  runBackgroundUpgradeWorkToEnd(db, backgroundHooks(db, options));
}
/** The upgrade work still to do on this connection, by name. */
export function pendingBackgroundUpgradeWork(): string[] { return handle ? backgroundJobsPending(handle) : []; }
/** What /api/health says under `memoryIntegrity`. */
export function memoryIntegrityStatus() {
  // With no connection nothing is known: the old fields stay as they were shaped, and `upgrade` (the contract's reading, which screens read) says "unknown" field by field.
  if (!handle) return { pending: false, phase: "", done: 0, total: 0, hold: null, holdMessage: null, repaired: 0, replayHeld: false, integrityPending: false, progress: null, overall: null, complete: false,
    upgrade: unknownUpgradeState({ launch: bootLaunchId(), seq: nextUpgradeSeq(), source: "health" }) };
  const replayHeld = ancestryUnrepaired(handle);
  const status = backgroundStatus(handle, replayHeld);
  // `complete` is the one word that the whole upgrade is over: every proof passed, every job finished, no lineage left to repair, nothing held
  return { ...status, replayHeld, integrityPending: integrityPending(handle), complete: status.complete && !replayHeld, upgrade: restampedUpgrade(status.upgrade, { source: "health" }) };
}

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;
let releaseIoBudget: (() => void) | null = null;
let savepointId = 0;
let startupMarked = false; // cold-start marks fire for the first open only
let generation = 0;

/** Changes whenever a connection opens or closes, so a reader holding something built from one connection can tell it is still the
 * current one without touching the filesystem or the database. */
export function databaseGeneration(): number { return generation; }

/** Moves when a write that changed rows names the room request or team identity tables, or undefined with no connection open. The
 * shared-bot rows are built from those tables, so a reader keeps them until this moves. The counter lives where every statement on the
 * handle is already counted (io-budget.ts), so no writer announces itself and none can be missed; unrelated writes (messages, push
 * pruning that matched nothing) leave it alone. It never opens the connection or touches the filesystem. */
export function databaseSharedRowsStamp(): number | undefined { return handle ? sharedRowsStamp(handle) : undefined; }

export function database(): DatabaseSync {
  const file = join(DATA_DIR, "messages.db");
  // (inside a synchronous pass the file cannot be swapped, so the existence check is not repeated for each of its thousands of statements)
  if (handle && handlePath === file && (inStatementReusePass() || existsSync(file))) return handle;
  closeDatabase();
  const firstOpen = !startupMarked; startupMarked = true;
  if (firstOpen) startupMark("database.begin");
  const freshInstallation = !existsSync(file);
  closeSync(openSync(file, "a", 0o600));
  try { chmodSync(file, 0o600); } catch { /* matches existing platform behavior */ }
  const db = new DatabaseSync(file);
  const release = instrumentDatabase(db);
  try {
    // secure_delete: a deleted conversation's words are overwritten in the
    // file, not left in free space for anyone reading the raw bytes.
    // A new file frees pages back to the disk in small steps (incremental
    // vacuum, root-set-compaction.ts); it can only be chosen before the first table.
    // The wait comes before the first statement that reads the file: another connection still leaving it (a worker that opened it by
    // path, a checkpointer) may hold it for a moment, and without the wait even this first pragma fails at once with "database is locked".
    db.exec("PRAGMA busy_timeout=1000");
    if (freshInstallation) db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
    // The write-ahead log keeps the size of the largest transaction it ever
    // held unless told otherwise (a 3.6 GB log after the 1.0.0 upgrade). Zero:
    // the first commit after a checkpoint has copied the whole log restarts it
    // and cuts the file back to its own frames, inside an ordinary write, so no
    // second connection ever has to take the writer lock to shrink it
    // (wal-maintenance.ts).
    db.exec(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}; PRAGMA wal_autocheckpoint=1000;`);
    noteBusyTimeout(db, DEFAULT_BUSY_MS);
    // Backstop for the Inbox disk burn: a sort that outgrows the page cache must
    // spill into memory, not into a temp file opened and closed per statement.
    // cache_size is negative = KiB (32 MiB).
    db.exec("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;");
    const upgrade = reporterFactory(DATA_DIR, basename);
    // What can hold the app closed is only the memory upgrade itself (structure, migration, commit). Everything that reads the history is
    // background work that starts when the server listens (upgrade-background.ts): the proofs about memory rows, the lineage repair, the
    // root-set conversion, the open-card index, the pending browser-check table and the search index tail. Each keeps its place in the
    // file, and the feature that depends on it stays held until it is done. While the migration runs, the start-up note is kept moving by
    // a heartbeat thread and, in the real server, a responder thread answers /api/health with 503 and the progress on the server's port.
    const from = memoryVersionOf(db), migrating = from !== null && from !== MEMORY_SCHEMA_VERSION;
    let responder: PreListenHealth | null = null;
    if (migrating) {
      // The counter the exact counts are keyed to exists before the thread starts (it reads it in the same transaction as the figures).
      try { ensureWriteRevision(db); } catch { /* without it the figures are simply not cached */ }
      // The exact counts (messages, conversations, ...) are counted by a thread on its own read-only connection, started now; the server thread counts nothing.
      const countsBlock = createCountsBlock();
      launchCounts = countsBlock;
      startExactCounts(file, join(DATA_DIR, UPGRADE_COUNTS_FILE), countsBlock);
      const board = createProgressBoard(countsBlock);
      // The checking phase reports no count (its figures are positions in the memory tables, not messages); the exact totals come from the counting thread below, never a COUNT(*) here.
      const counts = upgradeCounts(db, fileBytes(file)); // no figures yet: they are counted exactly by the thread below
      const overallFloor = readOverallFloor(DATA_DIR, MEMORY_SCHEMA_VERSION);
      const writer = overallWriter(DATA_DIR, MEMORY_SCHEMA_VERSION, Date.now, overallFloor);
      const tracker = new UpgradeProgressTracker("starting", counts, [{ id: "checking", weight: 1, total: 0 }, ...(from! <= 3 ? [{ id: "copying", weight: 4 }] : []), { id: "migrating", weight: 3 }],
        Date.now, {}, { from: 0, to: STARTING_SHARE, floor: overallFloor, persist: writer });
      tracker.setCountsSource(() => readCountsBlock(countsBlock));
      (upgrade as { attach?: (tracker: UpgradeProgressTracker, board: ProgressBoard) => void }).attach?.(tracker, board);
      const port = preListenHealthPort();
      if (port !== null) { responder = startPreListenHealth(port, board); setActivePreListenHealth(responder); }
    }
    // a page cache sized for the migration's one large transaction, for the blocking part only (the 32 MiB the connection runs with afterwards is restored below)
    if (migrating) { try { db.exec("PRAGMA cache_size=-524288"); } catch { /* the default stays */ } }
    try {
      initializeMessageTables(db, { defer: true });
      // the hold log a turn's sources are checked against (turn-source-holds.ts): its triggers record every change from here on
      initializeTurnSourceHolds(db);
    }
    catch (error) { upgrade.done(); void responder?.close(); setActivePreListenHealth(null); throw error; } if (firstOpen) startupMark("database.tables");
    // the branch and line indexes name rows by rowid (a few sampled seeks): a file whose rowids moved fills them again; and memory's claim loop asks whether a
    // branch move is still being flipped: counted once here (one seek), known after
    verifyDerivedRows(db);
    pendingBranchChanges(db);
    try {
      migrateMemorySchema(db, freshInstallation ? "active" : "off", { snapshotPath: join(DATA_DIR, MEMORY_PRE_V2_SNAPSHOT), snapshotV2Path: join(DATA_DIR, MEMORY_PRE_V3_SNAPSHOT), snapshotV3Path: join(DATA_DIR, MEMORY_PRE_V4_SNAPSHOT), onPhase: event => upgrade.phase(event), onValidating: () => upgrade.checking(), onBlocking: (first, from) => upgrade.blocking(first, from) });
      // A migration rewrites memory tables: whatever figures an earlier launch cached are void.
      if (migrating) { try { bumpWriteEpoch(db); } catch { /* as above */ } }
      // What the connection holds back until the background work has finished.
      loadBackgroundFlags(db); if (firstOpen) startupMark("database.flags");
      // The search index tail is noted here (a seek), filled in the background; the log's high-water mark is cut back while the note is
      // still up, so a long checkpoint after a big migration is never silent.
      prepareMessageSearchBackfill(db); if (firstOpen) startupMark("database.search");
      if (migrating) {
        let beat: BlockingHeartbeat | undefined;
        try { beat = upgrade.blocking("committing", from ?? undefined); } catch { /* a status write never stops an upgrade */ }
        try { db.exec("PRAGMA busy_timeout=1000"); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (error) { observeLine(`[sqlite] start checkpoint skipped: ${isDatabaseBusy(error) ? "busy" : "error"}`); }
        finally { try { beat?.end(); } catch { /* as above */ } }
      }
      if (migrating) { try { db.exec("PRAGMA cache_size=-32768"); } catch { /* as above */ } }
      // The room-request owed set (room-request-owed.ts) is seeded from an existing history HERE, in bounded batches under the same
      // start-up screen and extended boot clock, each batch refreshing the status note: a heavy 1.0.1 history shows progress and
      // never looks like a failed start. A failure leaves the marker at its cursor; the normal initializers below resume it.
      try { upgradeRoomRequestOwed(db, (done, total) => upgrade.indexing({ done, total }), { heartbeat: () => upgrade.blocking("backfill", undefined, undefined, "indexing") }); }
      catch (error) { console.warn(`[room-requests] owed set: ${error instanceof Error ? error.message : String(error)}; the next start carries on`); }
      // The queue of handoffs a 1.0.1 build kept in delegations.json moves into its table once, under the same note (pending-delegations-schema.ts).
      try { initializePendingDelegations(db); importLegacyDelegations(db, { heartbeat: () => upgrade.blocking("backfill", undefined, undefined, "indexing") }); }
      catch (error) { console.warn(`[delegations] queue import: ${error instanceof Error ? error.message : String(error)}; the next start carries on`); }
      // copies stored before the copy index existed join it once (one read of every row, under the start-up note and its heartbeat). Until they
      // have, a turn's own conversation is named line by line instead of as a range (steer-lineage.ts), so nothing is shown on a missing link.
      try {
        if (!turnSourceCopiesBackfilled(db)) {
          let beat: BlockingHeartbeat | undefined;
          try { beat = upgrade.blocking("backfill", undefined, undefined, "indexing"); } catch { /* a status write never stops an upgrade */ }
          try { backfillTurnSourceCopies(db); } finally { try { beat?.end(); } catch { /* as above */ } }
        }
      } catch (error) { console.warn(`[messages] copy index: ${error instanceof Error ? error.message : String(error)}; the next start carries on`); }
      // The eager optional indexes (small partial ones readers wait on) are made here on an upgrade launch, under the same note: after listen
      // their CREATE INDEX held the write lock the serving thread then met (rc13 real-data run: 137, 179 and 302 ms). Any left over (a failure, a
      // file that was not migrating) is built after listen as before, off the serving thread.
      if (migrating) {
        let beat: BlockingHeartbeat | undefined;
        try { beat = upgrade.blocking("backfill", undefined, undefined, "indexing"); } catch { /* a status write never stops an upgrade */ }
        try { buildEagerIndexesBeforeListen(db, { log: firstOpen }); } finally { try { beat?.end(); } catch { /* as above */ } }
      }
      upgrade.done();
    } catch (error) { upgrade.blocked(error); void responder?.close(); setActivePreListenHealth(null); throw error; } if (firstOpen) startupMark("database.noteDone");
    initializeInbox(db);
    initializeThreadSnooze(db);
    initializeArtifacts(db);
    initializeProjectTables(db); initializeTeamIdentityTables(db); initializeMobilePush(db); initializeSharedRequestProvenance(db); initializeProjectCardDelivery(db); initializeOwnerSends(db); initializePendingDelegations(db); initializeBotCalls(db); initializeAppTriggers(db); if (firstOpen) startupMark("database.tablesAll");
    runOwnerHandoffMigration(db);   // admission of hand-offs is held until it succeeds (pending-delegations-schema.ts)
    // Every counted write from here on moves the counter the upgrade screen's figures are keyed to (app-write-revision.ts).
    installWriteRevisionTriggers(db);
  } catch (error) { try { db.close(); } finally { release(); } throw error; }
  connectionId(db);
  handle = db; handlePath = file; releaseIoBudget = release; generation++;
  // After migration and before traffic: one TRUNCATE gives back a high-water WAL, then the sizes are logged.
  startupStorage(db, file, firstOpen);
  // From here the checkpoints run in a worker thread (PASSIVE only; it never takes the writer lock). The connection keeps
  // wal_autocheckpoint=1000 until the worker is ready, and goes back to it if the worker ever fails.
  startWalMaintenance(file, {
    setAutocheckpoint: pages => { if (handle === db) db.exec(`PRAGMA wal_autocheckpoint=${Math.trunc(pages)}`); },
    nudge: async () => {
      if (handle !== db || db.isTransaction) return false;
      await awaitWriterGate();
      if (handle !== db) return false;
      try {
        withBusyBudget(BACKGROUND_BUSY_MS, "wal-scrub", d => {
          // the same version written again: one page-1 frame, which restarts a fully copied log
          const version = Number((d.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0);
          d.exec(`PRAGMA user_version=${Math.trunc(version)}`);
        });
        return true;
      } catch { return false; }
    },
  });
  // The derived transcript tables of an older database fill in the background
  // (bounded chunks, event loop free between them), never on the request path.
  // its own chunks wait while the history upgrade runs, as the idle memory lanes do (transcript-backfill.ts yieldTranscriptBackfillTo)
  yieldTranscriptBackfillTo(backgroundUpgradeRunning);
  startTranscriptBackfill(db, () => handle === db);
  if (firstOpen) startupMark("database.open");
  bumpMessagesVersion(); // a different file (restore, data-dir switch) invalidates every memoised Inbox answer
  return db;
}

/** Zero: see the comment at the pragma above. */
export const JOURNAL_SIZE_LIMIT_BYTES = 0;
// The lock budgets, the busy error, the writer hold and the background begin live in db-busy.ts (a leaf module the slice runners import
// without the whole server); they are re-exported here, where the rest of the server has always found them.
export { OWNER_BUSY_MS, DEFAULT_BUSY_MS, BACKGROUND_BUSY_MS, backgroundSourceNow, currentBusy, DatabaseBusyError, DATABASE_BUSY_RETRY_AFTER_S, isDatabaseBusy,
  holdWritersForIndexBuild, writersHeldForIndexBuild, awaitWriterGate, FOREGROUND_GATE_MAX_MS, awaitWriterGateForeground, gateWriteRequest,
  setBusy, beginBackground, beginForSource, backgroundWrite } from "./db-busy.ts";
/** Wrap a background writer (a timer tick, a sweep, a retry loop): it waits ASYNCHRONOUSLY for the revocation index build
 * to release the writer lock, then runs. A lock failure that still gets through (the build started mid-run, or another
 * process) is skipped quietly for the next tick, and any other error is logged: a background writer never becomes an
 * unhandled rejection, which would end the server. Work is not lost: periodic writers run again on their next tick and
 * one-shot callers use `requeueBusy`. */
export function guardedWriter(op: string, run: () => unknown): () => Promise<void> {
  let running = false; // a tick that is still waiting or running is not stacked on by the next one
  return async () => {
    if (running) return;
    running = true;
    try { await awaitWriterGate(); await run(); }
    catch (error) {
      if (isDatabaseBusy(error)) noteBusy(op, 0);
      else console.error(`[background] ${op} failed:`, error);
    } finally { running = false; }
  };
}
export interface TransactionOptions {
  /** A fixed word naming the operation in `[sqlite]` lines. */
  op?: string;
  /** Lock wait for this call. Omitted: the handle's usual wait (1 s; background memory work takes 50 ms). With a value, a lock past it throws DatabaseBusyError. */
  busyMs?: number;
}
/** Run a statement-level write (no transaction of its own) under a lock budget. */
export function withBusyBudget<T>(busyMs: number, op: string, run: (db: DatabaseSync) => T): T {
  const db = database();
  setBusy(db, busyMs);
  const started = performance.now();
  try { return run(db); }
  catch (error) {
    if (isDatabaseBusy(error)) { const waited = performance.now() - started; noteBusy(op, waited); throw new DatabaseBusyError(op, waited); }
    throw error;
  } finally { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ } }
}

/** Synchronous callbacks only; no transaction may remain open across a promise. */
export function transaction<T>(operation: (db: DatabaseSync) => T, options: TransactionOptions = {}): T {
  const db = database();
  const nested = db.isTransaction;
  const point = `memory_tx_${++savepointId}`;
  if (!nested) noteIdentityEpoch(db);
  // a background source, or the process's own writer hold in force (a CREATE INDEX, the VACUUM holds the lock for the whole build): the background
  // budget, never the owner's 1 s on the serving thread (invariants 1 and 2; owner writes were gated before the hold, gateWriteRequest)
  const busyMs = options.busyMs ?? (backgroundSourceNow() || writersHeldForIndexBuild() ? BACKGROUND_BUSY_MS : undefined);
  const budgeted = !nested && busyMs !== undefined;
  if (budgeted) setBusy(db, busyMs!);
  const waitStart = performance.now();
  try {
    try { db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE"); }
    catch (error) {
      if (budgeted && isDatabaseBusy(error)) {
        const waited = performance.now() - waitStart, op = options.op ?? "transaction";
        noteBusy(op, waited);
        throw new DatabaseBusyError(op, waited);
      }
      throw error;
    }
    if (budgeted) { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* restored by the finally */ } }
    txScopeBegin();
    try {
      const result = operation(db);
      if (result && typeof (result as {then?: unknown}).then === "function") throw new Error("ASYNC_DATABASE_TRANSACTION");
      db.exec(nested ? `RELEASE ${point}` : "COMMIT"); txScopeEnd(true); return result;
    } catch (error) { try { db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK"); } finally { txScopeEnd(false); } throw error; }
  } finally {
    if (budgeted) { try { setBusy(db, DEFAULT_BUSY_MS); } catch { /* handle closed */ } }
  }
}

function megabytes(bytes: number) { return Math.round(bytes / 1048576); }
function fileBytes(path: string) { try { return statSync(path).size; } catch { return 0; } }
/** `[sqlite] storage file= wal= freelist=` (megabytes). */
export function storageLine(db: DatabaseSync, file: string): string {
  let freelist = 0;
  try {
    const pages = Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0), size = Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 4096);
    freelist = pages * size;
  } catch { /* closed or busy: report 0 */ }
  return `[sqlite] storage file=${megabytes(fileBytes(file))} wal=${megabytes(fileBytes(`${file}-wal`))} freelist=${megabytes(freelist)}`;
}
/** 1.0.9 Sentinel: the open messages.db's storage figures for a sealed stats generation (server/health/stats-publisher.ts).
 *  Short metadata reads on the ALREADY-OPEN connection plus two file sizes: no new connection, no row count, no
 *  checkpoint. Unknown values are null, never zero. Null when no database is open. */
export function storageObservation(now = Date.now()): { role: "messages"; sampled_at: number; page_size: number | null; page_count: number | null; freelist_pages: number | null; db_bytes: number | null; wal_bytes: number | null; pending_revocations: null; oldest_pending_at: null } | null {
  const db = handle, file = handlePath;
  if (!db || !file) return null;
  const pragma = (name: string): number | null => {
    try { const value = Number((db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined)?.[name]); return Number.isFinite(value) && value >= 0 ? value : null; } catch { return null; }
  };
  const size = (path: string): number | null => { try { return statSync(path).size; } catch { return null; } };
  return {
    role: "messages", sampled_at: now, page_size: pragma("page_size"), page_count: pragma("page_count"), freelist_pages: pragma("freelist_count"),
    db_bytes: size(file), wal_bytes: size(`${file}-wal`) ?? 0, pending_revocations: null, oldest_pending_at: null,
  };
}
let storageTimer: ReturnType<typeof setInterval> | undefined;
const WAL_REPORT_BYTES = 256 * 1024 * 1024;
function startupStorage(db: DatabaseSync, file: string, log: boolean) {
  // No checkpoint here: a migration cuts the log back under its own start-up note (above), and the background storage sweep
  // (maintainLineageStorage) no longer truncates on the serving thread (automatic checkpoints, then the wal3 lane's off-thread maintenance), so opening never waits on a large checkpoint with no note up.
  if (log) observeLine(storageLine(db, file));
  if (storageTimer) clearInterval(storageTimer);
  storageTimer = setInterval(() => {
    if (handle !== db || fileBytes(`${file}-wal`) <= WAL_REPORT_BYTES) return;
    observeLine(storageLine(db, file));
  }, 3_600_000);
  storageTimer.unref();
}

export function closeDatabase() {
  launchCounts = null; // a new connection counts again (or reads the cache)
  background?.stop(); background = null; runningBackground = null;
  if (storageTimer) { clearInterval(storageTimer); storageTimer = undefined; }
  if (handle) { const state = unrepaired.get(handle); if (state?.timer) clearTimeout(state.timer); unrepaired.delete(handle); }
  for (const hook of closeHooks) { try { hook(); } catch { /* idempotent shutdown */ } }
  try { handle?.close(); } catch { /* idempotent shutdown */ }
  // After the server connection has closed, so the checkpointer's is the last one and not this one.
  void stopWalMaintenance();
  // After the handle closes, so dropping the shm descriptor cannot release a lock SQLite still holds.
  try { releaseIoBudget?.(); } catch { /* idempotent shutdown */ }
  handle = null; handlePath = null; releaseIoBudget = null; generation++;
}
// Under vitest only: lets test cleanup close this copy of the module even after vi.resetModules() made it a stranger.
registerTestHandle("close", dir => { if (dir === undefined || (handlePath && pathIsWithin(handlePath, dir))) closeDatabase(); });
