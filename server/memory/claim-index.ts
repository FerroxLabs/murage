// SPDX-License-Identifier: AGPL-3.0-or-later
// The memory job claim's ready index (A10, 1.0.2).
//
// Choosing the next job used to be two aggregate queries over every eligible
// job (min scope after the last served, then that scope's oldest job): O(J)
// per claim and O(J^2) to drain a backlog of J jobs, on the server's one
// thread. The memory tables are validated against an exact schema
// (validateMemorySchema), so no index can be added to them; this index lives
// in the server process instead.
//
// What it holds: every open job (pending, partial, deferred, leased; under
// the attempt cap) whose source is at the job's revision, filed by scope in
// rowid order, plus a heap of jobs that are open but not yet due (a retry in
// the future, a live lease). Two kinds of bounded read (review finding 6: the
// planner had chosen memory_jobs_pending plus a sort over every open job on
// every claim; neither read sorts):
// - The first build and the reconcile sweep walk the OPEN statuses only,
//   through memory_jobs_pending in its own (status,retry_at,rowid) order, in
//   keyset pages of at most OPEN_PAGE_ROWS index rows (1.0.3 preflight: they
//   used to walk every rowid of the table, so every sweep re-read the whole
//   finished history on the server thread, 156k rows on the owner's file, and
//   under the revoke drain's disk load one chunk held the thread 13 to 33 s).
//   Their cost follows the open backlog, never the history. Each pass walks a snapshot (1.0.3 round 3, MEMORY-STALL-FIX-DESIGN.md):
//   the rows up to the table's end and the retry times up to the claim's `now` when it began, so jobs written later never keep it
//   going (they are filed by the read of new rows and the writers' hints), and a pass steps at most passRowCap rows whatever the
//   writers do. Jobs not due yet are filed by the due frontier as their retry time passes.
// - Rows appended since the last look are read as a rowid range (memory_jobs
//   NOT INDEXED, rowid>? AND rowid<=?, at most SCAN_CHUNK rowids).
// The first build is chunked: one page per claim and the rest
// on later turns of the event loop; until it is complete the claim is chosen
// from the rows read so far (round 2 P2-C: the SQL aggregate over every open
// job is never asked for during a build, and the claimer is woken as the build
// ends), and a large append after the build is read the same way, a few chunks
// per call and the rest on later turns, never in one synchronous block. Every candidate is re-checked by
// rowid against the exact claim rules before it is chosen, so the index can
// hold stale entries but never makes a wrong choice: a stale entry is dropped
// or moved when it is met. A job that became claimable again behind the
// index's back (a park reopen, a branch restore) is filed again by the
// reconcile sweep: a chunked re-walk of the table that runs on a timer
// (RECONCILE_INTERVAL_MS) whether or not the index has run dry, and at once
// when a writer says it reopened jobs (reopened()). A reopen during a running
// sweep does not restart it: the sweep finishes and one more pass follows at
// once, and the writer hints the jobs it reopened directly (round 2 P2-B). No
// scope waits longer than one sweep plus one pass (review finding 5).
//
// Order is the claim's documented order: the first scope after the last one
// served (scope ids ascending, as SQLite's BINARY collation compares them),
// wrapping to the lowest; inside it the lowest claimable rowid. Recent-scopes
// mode takes the highest claimable capture job across the listed scopes.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { settleRows, TOMBSTONED, type SettleCategory } from "./claim-settle.ts";
import { DENIED_PLACE } from "./deny.ts";
import { SCAN_PAGE_TARGET_MS } from "./status-scan.ts";
import { RidList } from "./rid-list.ts";

const OPEN = "('pending','partial','deferred','leased')";
/** The open walk's filing terms (the same as the rowid scan's WHERE), NULL when the job has no source at its revision. */
const OPEN_FILEABLE = "(s.state='active' AND NOT (coalesce(s.kind,'') IN ('tool-outcome','activity') AND coalesce(s.outcome,'')='failed'))";
/** The open statuses the walk goes through one after the other, pending first: nearly every open job is pending, so a page is usually one
 * read of the index, and the three seeks into the other statuses come only when pending left room (under the upgrade each read is paid for
 * by the budgeted pause). */
const OPEN_WALK_STATUSES = ["pending", "partial", "deferred", "leased"] as const;
export const CLAIM_INDEX_SQL = {
  /** Rows added since the last look, in rowid order: a range scan of the primary key and one probe per row. */
  scan: `SELECT j.rowid AS rid,s.scope_id AS scope FROM memory_jobs AS j NOT INDEXED CROSS JOIN memory_sources AS s ON s.id=j.source_id AND s.revision=j.source_revision
    WHERE j.rowid>? AND j.rowid<=? AND j.status IN ${OPEN} AND j.attempts<3 AND s.state='active'
    AND NOT (coalesce(s.kind,'') IN ('tool-outcome','activity') AND coalesce(s.outcome,'')='failed') ORDER BY j.rowid`,
  /** Where the table ends: the last rowid (one step down the primary key). */
  end: `SELECT max(rowid) AS rid FROM memory_jobs`,
  /** The open jobs of one status (?1) with retry times in [?2, ?3] in memory_jobs_pending's own order, from the front of that range (?4 page
   * size), each with its scope and whether its source can be filed (the scan's terms, as a column: every index row stepped is returned,
   * so the keyset moves past it). */
  openFirst: `SELECT j.rowid AS rid,j.retry_at AS t,j.attempts AS a,s.scope_id AS scope,${OPEN_FILEABLE} AS ok
    FROM memory_jobs AS j INDEXED BY memory_jobs_pending LEFT JOIN memory_sources AS s ON s.id=j.source_id AND s.revision=j.source_revision
    WHERE j.status=?1 AND j.retry_at>=?2 AND j.retry_at<=?3 ORDER BY j.retry_at,j.rowid LIMIT ?4`,
  /** The next page after (?2 retry_at, ?3 rowid), in two seeks as the settle sweep does: the rest of that retry_at up to the walk's last
   * rowid (?5: rows written after the walk began are read as new rows, so jobs arriving at the same retry_at never keep it going), then
   * the later ones up to the pass's retry bound (?4: retry times stamped after the pass began are past it). */
  openTied: `SELECT j.rowid AS rid,j.retry_at AS t,j.attempts AS a,s.scope_id AS scope,${OPEN_FILEABLE} AS ok
    FROM memory_jobs AS j INDEXED BY memory_jobs_pending LEFT JOIN memory_sources AS s ON s.id=j.source_id AND s.revision=j.source_revision
    WHERE j.status=?1 AND j.retry_at=?2 AND j.rowid>?3 AND j.rowid<=?5 ORDER BY j.rowid LIMIT ?4`,
  openLater: `SELECT j.rowid AS rid,j.retry_at AS t,j.attempts AS a,s.scope_id AS scope,${OPEN_FILEABLE} AS ok
    FROM memory_jobs AS j INDEXED BY memory_jobs_pending LEFT JOIN memory_sources AS s ON s.id=j.source_id AND s.revision=j.source_revision
    WHERE j.status=?1 AND j.retry_at>?2 AND j.retry_at<=?4 ORDER BY j.retry_at,j.rowid LIMIT ?3`,
  /** The next existing rowid after one (a primary key probe), to jump gaps in the rowids. */
  nextRid: `SELECT rowid AS rid FROM memory_jobs WHERE rowid>? ORDER BY rowid LIMIT 1`,
  /** One candidate, by rowid, with everything the claim rules read. */
  check: `SELECT j.status,j.attempts,j.retry_at,j.lease_until,j.stage,s.state,s.outcome,s.kind,s.thread_id,s.message_id,
    ${DENIED_PLACE("s")} AS denied,${TOMBSTONED("s")} AS tombstoned
    FROM memory_jobs j LEFT JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE j.rowid=?`,
  /** A job's place, after a write that may have made it claimable again. */
  byId: `SELECT j.rowid AS rid,s.scope_id AS scope FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE j.id=?`,
} as const;

/** Rowids one read of NEW rows examines: a few ms each. */
export const SCAN_CHUNK = 4096;
/** Most index rows one page of the open walk (a build or reconcile step) reads; halved while pages run past SCAN_PAGE_TARGET_MS. */
export const OPEN_PAGE_ROWS = 1024;
/** A reconcile step at most this often while a sweep runs; a new sweep this long after the last one ended. */
export const RECONCILE_STEP_MS = 1_000;
export const RECONCILE_INTERVAL_MS = 30_000;
/** Candidates one selection may look at before it hands the choice to the SQL fallback. */
export const CLAIM_INDEX_CHECK_LIMIT = 512;
/** Chunks of NEW rows one call reads before it stops and the rest continues on later turns of the event loop (round-2 P2-C). */
export const SYNC_CHUNKS_PER_CALL = 2;
/** Time one selection may spend reading further chunks while the index is warming and still holds nothing. */
export const WARM_BUDGET_MS = 10;
const RECENT_WAITING_CHECKS = 8;
/** While the history upgrade runs (setUpgradeRunning), one turn of the index (a claim, a background step) reads at most ONE range, and the range
 * follows time as PagedScan's pages do: halved when a read took longer than SCAN_PAGE_TARGET_MS, doubled back (up to SCAN_CHUNK) when one took a
 * quarter of it (rc13 real-data run: a 4096-rowid read was 70 to 86 ms beside the upgrade's I/O, three of them in one claim). */
export const CLAIM_SCAN_MIN_ROWS = 64;
/** The most a background step of the index pauses for while the upgrade runs. The pause is budgeted, not fixed: a step whose read took t ms
 * hands the loop back for t ms (at most this), so the index holds at most half the loop beside the upgrade, and a quick read waits one turn only
 * (stall r2 L2: a fixed 20 ms pause was still paid once after the upgrade ended). A step scheduled with a pause is run at once by the first turn
 * that finds the upgrade over. */
export const CLAIM_SCAN_UPGRADE_PAUSE_MS = 20;
type Pending = { cancel(): void; paused: boolean; run: () => void };
/** One pass of the open walk over a snapshot: the status (index into OPEN_WALK_STATUSES) and the last (retry_at, rowid) read in it (t null
 * at its front); the retry times it covers [lo, hi] and the last rowid it files (`end`), both fixed when it begins; `left`, the rows it
 * may still step (passRowCap). Writers stamp a retry time of 0 (a new job), keep it, or stamp their `now` plus a delay, so after the
 * pass began a row up to `end` holds at most two keys in the range (its own, and (hi, rowid)) and a later row sits at 0 or at hi: in each
 * status the cursor passes a row at most twice, and a later row only on the one page that crosses 0 or hi. */
interface Walk { si: number; t: bigint | null; r: bigint; lo: bigint; hi: bigint; end: bigint; left: number }
const RETRY_MIN = -(2n ** 63n);
/** The rows one pass may step: twice per status for each rowid up to its end (rowids start at 1) and a page per status at 0 and at hi.
 * Never reached while writers keep the rule above; a pass that reaches it ends (stats.cut), so every pass ends whatever happens. */
export function passRowCap(end: bigint): number { return 8 * Math.max(0, Number(end) + 1) + 8 * OPEN_PAGE_ROWS; }
function later(run: () => void, pauseMs: number): Pending {
  if (pauseMs > 0) { const timer = setTimeout(run, pauseMs); timer.unref?.(); return { cancel: () => clearTimeout(timer), paused: true, run }; }
  const immediate = setImmediate(run); immediate.unref?.();
  return { cancel: () => clearImmediate(immediate), paused: false, run };
}
const OPEN_STATUSES = new Set(["pending", "partial", "deferred", "leased"]);

/** `settle`: the job is blocked for good (or parked, for a retired source); the claim closes it out in its transaction (claim-settle.ts). */
type Verdict = { kind: "claimable" } | { kind: "gone" } | { kind: "skip" } | { kind: "settle"; category: SettleCategory } | { kind: "wait"; due: number };
interface Waiting { due: number; rid: bigint; scope: string }
export interface RecentFilter { exclude?: { threadId: string; messageIds: ReadonlySet<string> } }
/** What one selection cost, for tests and the trace. */
export interface ClaimIndexStats { checks: number; scanned: number; rebuilds: number; examined: number; reconciled: number; cut: number }

const ascii = /^[\x00-\x7f]*$/;
/** SQLite's BINARY collation: UTF-8 bytes. JS `<` compares UTF-16 units, which agrees for ASCII. */
export function compareScope(a: string, b: string): number {
  if (ascii.test(a) && ascii.test(b)) return a < b ? -1 : a > b ? 1 : 0;
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
function lowerBound<T>(list: readonly T[], value: T, compare: (a: T, b: T) => number, from = 0): number {
  let lo = from, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (compare(list[mid]!, value) < 0) lo = mid + 1; else hi = mid; }
  return lo;
}
const compareRid = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
/** The last retry time a pass started at `now` covers (retry times are whole ms). */
const retryBound = (now: number): bigint => BigInt(Math.floor(now));

export class MemoryClaimIndex {
  private db: DatabaseSync | null = null;
  private statements = new Map<string, StatementSync>();
  private scopes = new Map<string, RidList>();
  private order: string[] = [];
  private ready = new Set<bigint>();
  private waiting: Waiting[] = [];
  private waitingSet = new Set<bigint>();
  /** The same waiting jobs by scope, so a recent-scopes claim re-checks its own scopes' waiting jobs (one may have
   * been put back behind the index's back, e.g. a lease released by a restore). */
  private waitingByScope = new Map<string, Set<bigint>>();
  /** Every rowid up to here has been examined. */
  private high = -1n;
  /** The first build is complete up to `buildEnd` (the table's end when it started). */
  private building = false;
  private buildEnd = -1n;
  /** The first build's pass (null once it is done). */
  private buildWalk: Walk | null = null;
  /** The due frontier: every retry time up to here has been walked; its pass over (frontier, now] while one runs. */
  private frontier = RETRY_MIN;
  private frontierWalk: Walk | null = null;
  /** Which reader is first in line for a turn's one read while the upgrade runs: 0 new rows, 1 the sweep, 2 the frontier (the one after the last reader). */
  private turn = 0;
  private buildTimer: Pending | null = null;
  private stale = true;
  /** The reconcile sweep: its pass (null when no sweep runs), and when its next step may run (monotonic ms). */
  private reconcileWalk: Walk | null = null;
  private reconcileAt = 0;
  /** A reopen was reported while the first build ran: sweep as soon as it completes. */
  private reopenAsked = false;
  /** A reopen was reported during a running sweep: the sweep carries on and one more pass follows it at once. */
  private reconcilePassQueued = false;
  /** New rows were left unread by a bounded call; they are read a few chunks per turn of the event loop. */
  private catchingUp = false;
  private catchTimer: Pending | null = null;
  private wake: (() => void) | null = null;
  /** Blocked jobs met by the selection under way: closed out once, in the claim's transaction. */
  private settleRids: bigint[] = [];
  private settleCategories = new Set<SettleCategory>();
  private readonly clock: () => number;
  /** Whether the history upgrade runs now (database.ts backgroundUpgradeRunning): the index then reads one adaptive range per turn. */
  private upgradeRunning: () => boolean = () => false;
  /** Ranges this turn may still read (Infinity when no upgrade runs), and the rowids the next range covers while one does. */
  private scansLeft = Infinity;
  private scanRows = SCAN_CHUNK;
  /** What the last read under the upgrade took (ms): the pause before the next background step (budgeted, see CLAIM_SCAN_UPGRADE_PAUSE_MS). */
  private lastReadMs = 0;
  readonly stats: ClaimIndexStats = { checks: 0, scanned: 0, rebuilds: 0, examined: 0, reconciled: 0, cut: 0 };

  constructor(clock: () => number = () => performance.now()) { this.clock = clock; }

  /** Say how to know whether the history upgrade runs (null: never constrained). */
  setUpgradeRunning(running: (() => boolean) | null): void { this.upgradeRunning = running ?? (() => false); }
  /** The rowids the next range covers while the upgrade runs (for tests and the trace). */
  get upgradeScanRows(): number { return this.scanRows; }
  /** Opens one turn of the index: under the upgrade it may read one range, otherwise as many as its own bounds allow. */
  private beginTurn(): boolean {
    let constrained = false;
    try { constrained = this.upgradeRunning(); } catch { constrained = false; }
    this.scansLeft = constrained ? 1 : Infinity;
    // the upgrade is over: a background step still waiting out a pause taken under it runs now
    if (!constrained) { this.buildTimer = this.hurry(this.buildTimer); this.catchTimer = this.hurry(this.catchTimer); }
    return constrained;
  }
  private hurry(pending: Pending | null): Pending | null {
    if (!pending?.paused) return pending;
    pending.cancel();
    return later(pending.run, 0);
  }
  private get constrained(): boolean { return this.scansLeft !== Infinity; }
  private canScan(): boolean { return this.scansLeft > 0; }
  /** The rowids one range read covers now. */
  private chunkRows(): bigint { return BigInt(this.constrained ? this.scanRows : SCAN_CHUNK); }
  /** The pause before the next background step (none unless the upgrade runs). */
  private pauseMs(): number {
    if (!this.constrained || this.lastReadMs < SCAN_PAGE_TARGET_MS / 4) return 0;
    return Math.min(CLAIM_SCAN_UPGRADE_PAUSE_MS, Math.ceil(this.lastReadMs));
  }
  /** Forget everything; the next selection rebuilds from the table (chunked). */
  invalidate(): void { this.stale = true; }
  /** A writer made jobs claimable again behind the index (a park reopen, a branch restore): sweep now. */
  reopened(): void {
    // A sweep that is running keeps its cursor (restarting it on every notification starves it); one more pass is
    // queued behind it for jobs reopened below the cursor. Otherwise a pass is due now.
    if (this.reconcileWalk !== null) { this.reconcilePassQueued = true; return; }
    this.reconcileAt = 0; this.reopenAsked = true;
  }
  /** Say what to call when a background step of the index finishes (the claimer has something new to look at). */
  onProgress(wake: (() => void) | null): void { this.wake = wake; }
  /** True while the first build is still walking the table, or new rows are still being read. */
  get warming(): boolean { return this.stale || this.building || this.catchingUp; }

  private statement(db: DatabaseSync, sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = db.prepare(sql); statement.setReadBigInts(true); this.statements.set(sql, statement); }
    return statement;
  }

  private tableEnd(db: DatabaseSync): bigint {
    const row = this.statement(db, CLAIM_INDEX_SQL.end).get() as { rid: bigint | null } | undefined;
    return row?.rid == null ? -1n : BigInt(row.rid);
  }
  /** The first rowid after `from` that exists, minus one: a gap in the rowids (a huge sparse rowid) is jumped, not walked. */
  private skipGap(db: DatabaseSync, from: bigint, end: bigint): bigint {
    const row = this.statement(db, CLAIM_INDEX_SQL.nextRid).get(from) as { rid: bigint | null } | undefined;
    if (row?.rid == null) return end;
    const next = BigInt(row.rid) - 1n;
    return next > from ? (next < end ? next : end) : from;
  }
  /** Examine the rowids (from, to] and file the open ones; a reconcile files only what the index lost. */
  private walk(db: DatabaseSync, from: bigint, to: bigint, reconcile: boolean): void {
    if (to <= from) return;
    const started = performance.now();
    const rows = this.statement(db, CLAIM_INDEX_SQL.scan).all(from, to) as Array<{ rid: bigint; scope: string }>;
    if (this.constrained) {
      this.scansLeft--;
      // PagedScan's rule: halve when the read ran past the target, double back when it took a quarter of it
      const took = performance.now() - started;
      this.lastReadMs = took;
      if (took > SCAN_PAGE_TARGET_MS) this.scanRows = Math.max(CLAIM_SCAN_MIN_ROWS, Math.floor(this.scanRows / 2));
      else if (took < SCAN_PAGE_TARGET_MS / 4) this.scanRows = Math.min(SCAN_CHUNK, this.scanRows * 2);
    }
    this.stats.examined += Number(to - from);
    this.stats.scanned += rows.length;
    for (const row of rows) {
      if (reconcile) {
        if (this.ready.has(row.rid) || this.waitingSet.has(row.rid)) continue;
        this.stats.reconciled++;
      }
      this.addReady(row.rid, String(row.scope));
    }
  }
  /** A pass over the retry times [lo, hi] and the rowids up to `end`, fixed now. */
  private pass(lo: bigint, hi: bigint, end: bigint): Walk { return { si: 0, t: null, r: -1n, lo, hi, end, left: passRowCap(end) }; }
  /** One page of a pass: at most a page of memory_jobs_pending rows, in its own order, across the open statuses. Files the open jobs with
   * rowids up to the pass's end (later rows are read as new rows) that the index does not hold yet. True when the pass is done. */
  private page(db: DatabaseSync, walk: Walk, reconcile: boolean): boolean {
    const started = performance.now();
    const size = Math.min(this.scanRows, OPEN_PAGE_ROWS);
    let room = Math.min(size, walk.left);
    let done = false;
    const rows: Array<Record<string, unknown>> = [];
    // at most `size` index rows in all: a page moves on to the next status while it has room (at most two seeks per status)
    while (!done && room > 0) {
      const status = OPEN_WALK_STATUSES[walk.si]!;
      const got: Array<Record<string, unknown>> = walk.t === null
        ? this.statement(db, CLAIM_INDEX_SQL.openFirst).all(status, walk.lo, walk.hi, room) as Array<Record<string, unknown>>
        : this.statement(db, CLAIM_INDEX_SQL.openTied).all(status, walk.t, walk.r, room, walk.end) as Array<Record<string, unknown>>;
      if (walk.t !== null && got.length < room) got.push(...this.statement(db, CLAIM_INDEX_SQL.openLater).all(status, walk.t, room - got.length, walk.hi) as Array<Record<string, unknown>>);
      for (const row of got) rows.push(row);
      room -= got.length; walk.left -= got.length;
      const last: Record<string, unknown> | undefined = got[got.length - 1];
      if (last) { walk.t = last.t as bigint; walk.r = last.rid as bigint; }
      // fewer rows than asked: this status is read to the pass's bound
      if (room > 0) { if (walk.si + 1 < OPEN_WALK_STATUSES.length) { walk.si++; walk.t = null; walk.r = -1n; } else done = true; }
    }
    if (!done && walk.left <= 0) { done = true; this.stats.cut++; }
    // what the reads took (the filing is the index's own work): the budgeted pause before the next background step, as after a range read
    if (this.constrained) { this.scansLeft--; this.lastReadMs = performance.now() - started; }
    this.stats.examined += rows.length;
    let filed = 0;
    for (const row of rows) {
      const rid = row.rid as bigint;
      if (rid > walk.end || row.scope == null || !Number(row.ok) || Number(row.a) >= 3) continue;
      if (this.ready.has(rid) || this.waitingSet.has(rid)) continue;
      if (reconcile) this.stats.reconciled++;
      this.addReady(rid, String(row.scope));
      filed++;
    }
    this.stats.scanned += filed;
    // PagedScan's rule, always, on the whole step (reads and filing): a page that ran long makes the next one half the size of this one
    const took = performance.now() - started;
    if (took > SCAN_PAGE_TARGET_MS) this.scanRows = Math.max(CLAIM_SCAN_MIN_ROWS, Math.floor(size / 2));
    else if (took < SCAN_PAGE_TARGET_MS / 4) this.scanRows = Math.min(SCAN_CHUNK, this.scanRows * 2);
    return done;
  }
  /** One page of the first build. True when the build is complete. */
  private buildStep(db: DatabaseSync): boolean {
    if (this.buildWalk !== null) {
      if (!this.canScan()) return false;
      if (!this.page(db, this.buildWalk, false)) return false;
      this.buildWalk = null;
    }
    this.building = false;
    this.wake?.();
    this.reconcileWalk = null; this.reconcileAt = this.reopenAsked ? 0 : this.clock() + RECONCILE_INTERVAL_MS; this.reopenAsked = false;
    return true;
  }
  /** The rest of the first build runs a page per turn of the event loop, never in one block. */
  private continueBuild(db: DatabaseSync): void {
    if (this.buildTimer) return;
    this.buildTimer = later(() => {
      this.buildTimer = null;
      if (this.db !== db || this.stale || !this.building) return;
      this.beginTurn();
      try { if (!this.buildStep(db)) { this.continueBuild(db); if (this.ready.size) this.wake?.(); } }
      catch { this.stale = true; } // a closed or busy handle: the next selection starts again
    }, this.pauseMs());
  }

  /** Read at most `chunks` chunks of new rows. True when the index has reached the table's end. */
  private advance(db: DatabaseSync, chunks: number): boolean {
    const end = this.tableEnd(db);
    for (let n = 0; this.high < end; n++) {
      if (n >= chunks || !this.canScan()) return false;
      this.high = this.skipGap(db, this.high, end);
      if (this.high >= end) break;
      const chunk = this.chunkRows();
      const to = this.high + chunk < end ? this.high + chunk : end;
      this.walk(db, this.high, to, false);
      this.high = to;
    }
    return true;
  }
  /** The rest of a large append is read a few chunks per turn of the event loop, never in one block. */
  private continueCatchUp(db: DatabaseSync): void {
    if (this.catchTimer) return;
    this.catchTimer = later(() => {
      this.catchTimer = null;
      if (this.db !== db || this.stale || this.building) { this.catchingUp = false; return; }
      this.beginTurn();
      try {
        if (this.advance(db, SYNC_CHUNKS_PER_CALL)) this.catchingUp = false; else this.continueCatchUp(db);
        this.wake?.();
      } catch { this.stale = true; this.catchingUp = false; } // a closed or busy handle: the next selection starts again
    }, this.pauseMs());
  }

  /** Bring the index up to date with `db`, within a bounded amount of work. False while the first build is still
   * running; while it (or a catch-up of a large append) runs, the index answers from what it holds so far. */
  private sync(db: DatabaseSync, now: number): boolean {
    if (db !== this.db || this.stale) {
      // A timer left from the previous build or handle would make continueBuild believe one is pending.
      if (this.buildTimer) { this.buildTimer.cancel(); this.buildTimer = null; }
      if (this.catchTimer) { this.catchTimer.cancel(); this.catchTimer = null; }
      if (db !== this.db) this.scanRows = SCAN_CHUNK; // another file: its reads are measured afresh
      this.db = db; this.statements.clear(); this.scopes.clear(); this.order = []; this.ready.clear();
      this.waiting = []; this.waitingSet.clear(); this.waitingByScope.clear(); this.high = -1n; this.stale = false; this.stats.rebuilds++;
      this.building = true; this.catchingUp = false; this.buildEnd = this.tableEnd(db); this.reconcileWalk = null; this.reconcilePassQueued = false;
      // the build walks the open statuses up to the table's end and the jobs due now; rows written after it are read as new rows, and
      // jobs due later by the due frontier
      const due = retryBound(now);
      this.high = this.buildEnd; this.buildWalk = this.pass(RETRY_MIN, due, this.buildEnd);
      this.frontier = due; this.frontierWalk = null;
    }
    if (this.building) {
      if (this.buildStep(db)) return true;
      this.continueBuild(db);
      return false;
    }
    if (!this.constrained) {
      // New rows since the last look: a bounded range of the primary key, nothing when nothing was added.
      if (!this.advance(db, SYNC_CHUNKS_PER_CALL)) { this.catchingUp = true; this.continueCatchUp(db); return true; }
      this.catchingUp = false;
      // the sweep first: it steps at most once per RECONCILE_STEP_MS, so the frontier has every other turn
      this.reconcileStep(db, now);
      this.frontierStep(db, now);
      return true;
    }
    // Under the upgrade a turn reads once, so the three readers take the read in turn: new rows, the sweep, the frontier (Astra build3 H2:
    // new rows alone took every turn's read while jobs kept arriving, and a job due after the build waited out the whole upgrade). The one
    // first in line reads if it has work to do, else the next; the reader after the one that read is first next turn, so a reader with work
    // waits at most two turns. New rows left unread go on in the background catch-up, on its own turns.
    const first = this.turn;
    let caughtUp = true, reader = -1;
    for (let k = 0; k < 3; k++) {
      const who = (first + k) % 3;
      if (who === 0) caughtUp = this.advance(db, SYNC_CHUNKS_PER_CALL);
      else if (who === 1) this.reconcileStep(db, now);
      else this.frontierStep(db, now);
      if (reader < 0 && !this.canScan()) reader = who;
    }
    if (reader >= 0) this.turn = (reader + 1) % 3;
    if (!caughtUp) { this.catchingUp = true; this.continueCatchUp(db); } else this.catchingUp = false;
    return true;
  }

  /** One page of the due frontier, when retry times have passed since it last ran: jobs that were not due when the index walked them. */
  private frontierStep(db: DatabaseSync, now: number): void {
    if (!this.canScan()) return;
    if (this.frontierWalk === null) {
      const due = retryBound(now);
      if (due <= this.frontier) return;
      this.frontierWalk = this.pass(this.frontier + 1n, due, this.high);
    }
    if (this.page(db, this.frontierWalk, false)) { this.frontier = this.frontierWalk.hi; this.frontierWalk = null; }
  }

  /** One step of the reconcile sweep, when one is due: re-file open jobs the index lost track of (a page of the open walk). */
  private reconcileStep(db: DatabaseSync, now: number): void {
    const at = this.clock();
    if (at < this.reconcileAt || !this.canScan()) return;
    if (this.reconcileWalk === null) { this.reconcileWalk = this.pass(RETRY_MIN, retryBound(now), this.high); this.reopenAsked = false; this.reconcilePassQueued = false; }
    if (this.page(db, this.reconcileWalk, true)) { this.reconcileWalk = null; this.reconcileAt = this.reconcilePassQueued ? at : at + RECONCILE_INTERVAL_MS; }
    else this.reconcileAt = at + RECONCILE_STEP_MS;
  }

  private list(scope: string): RidList {
    let list = this.scopes.get(scope);
    if (!list) {
      list = new RidList();
      this.scopes.set(scope, list);
      this.order.splice(lowerBound(this.order, scope, compareScope), 0, scope);
    }
    return list;
  }

  private addReady(rid: bigint, scope: string): void {
    if (this.ready.has(rid)) return;
    // in rowid order, out of order too (a job back from the heap, a hint, a page of the open walk); a stale copy still there is kept once
    this.list(scope).insert(rid);
    this.ready.add(rid);
  }

  private addWaiting(rid: bigint, scope: string, due: number): void {
    this.ready.delete(rid);
    // A second entry for the same job is allowed (a lease, then an earlier retry): whichever comes due first is
    // re-checked, and the other finds the job already filed.
    this.waitingSet.add(rid);
    let byScope = this.waitingByScope.get(scope);
    if (!byScope) this.waitingByScope.set(scope, byScope = new Set());
    byScope.add(rid);
    const heap = this.waiting;
    heap.push({ due, rid, scope });
    for (let at = heap.length - 1; at > 0;) {
      const parent = (at - 1) >> 1;
      if (heap[parent]!.due <= heap[at]!.due) break;
      [heap[parent], heap[at]] = [heap[at]!, heap[parent]!]; at = parent;
    }
  }

  private promote(now: number): void {
    const heap = this.waiting;
    while (heap.length && heap[0]!.due <= now) {
      const top = heap[0]!, last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let at = 0; ;) {
          const left = at * 2 + 1, right = left + 1;
          let least = at;
          if (left < heap.length && heap[left]!.due < heap[least]!.due) least = left;
          if (right < heap.length && heap[right]!.due < heap[least]!.due) least = right;
          if (least === at) break;
          [heap[least], heap[at]] = [heap[at]!, heap[least]!]; at = least;
        }
      }
      this.waitingSet.delete(top.rid);
      this.waitingByScope.get(top.scope)?.delete(top.rid);
      this.addReady(top.rid, top.scope);
    }
  }

  private verdict(db: DatabaseSync, rid: bigint, now: number, recent?: RecentFilter): Verdict {
    this.stats.checks++;
    const row = this.statement(db, CLAIM_INDEX_SQL.check).get(rid) as Record<string, unknown> | undefined;
    if (!row || !OPEN_STATUSES.has(String(row.status))) return { kind: "gone" };
    // A live lease is never settled (its holder may still publish); the job is looked at again when the lease runs out.
    const retryAt = Number(row.retry_at), leaseUntil = Number(row.lease_until);
    const liveLease = row.status === "leased" && leaseUntil >= now;
    const blocked = (category: SettleCategory): Verdict => (liveLease ? { kind: "gone" } : { kind: "settle", category });
    if (Number(row.attempts) >= 3) return blocked("attempts");
    // No source at the job's revision, a deleted or retired source, a failed tool outcome, a turn still running: blocked
    // for good (a retired source is parked, and reopened by the branch-change paths).
    if (row.state == null || row.state === "deleted") return blocked("superseded");
    // Its conversation or scope was deleted, or the source is tombstoned at its revision: permanent (memory_deny and tombstones are
    // only ever inserted), and checked before `retired` so such a job is cancelled, never parked to be reopened.
    if (Number(row.denied) || Number(row.tombstoned)) return blocked("denied");
    if (row.state === "retired") return blocked("retired");
    if (row.state !== "active") return { kind: "gone" };
    if ((row.kind === "tool-outcome" || row.kind === "activity") && row.outcome === "failed") return blocked("tool");
    if (row.outcome === "working") return blocked("working");
    if (retryAt > now) return { kind: "wait", due: retryAt };
    if (liveLease) return { kind: "wait", due: Math.max(retryAt, leaseUntil + 1) };
    if (recent) {
      if (row.stage !== "capture") return { kind: "skip" };
      const exclude = recent.exclude;
      if (exclude && row.thread_id === exclude.threadId && exclude.messageIds.has(String(row.message_id))) return { kind: "skip" };
    }
    return { kind: "claimable" };
  }
  /** File a blocked job for closing out and drop it from the ready set. */
  private noteSettle(rid: bigint, category: SettleCategory): void {
    this.ready.delete(rid);
    this.settleRids.push(rid);
    this.settleCategories.add(category);
  }
  /** Close out the blocked jobs the selection met: at most six statements, inside the caller's (claim) transaction. */
  private flushSettle(db: DatabaseSync, now: number): void {
    if (!this.settleRids.length) return;
    const rids = this.settleRids, categories = this.settleCategories;
    this.settleRids = []; this.settleCategories = new Set();
    settleRows(db, rids, now, categories);
  }
  /** Jobs another path closed out (the fallback's windows): they leave the ready set, so a later selection does not spend a check on each. */
  dropped(rids: readonly bigint[]): void { for (const rid of rids) this.ready.delete(rid); }

  /** The oldest claimable job of `scope`, dropping or moving the stale entries met on the way. */
  private head(db: DatabaseSync, scope: string, now: number, budget: { left: number }): bigint | null | undefined {
    const list = this.scopes.get(scope);
    if (!list) return null;
    // the entries passed from the front with nothing kept before them are dropped once the walk stops
    let drop = 0, contiguous = true;
    try {
      for (const rid of list.ascending()) {
        if (!this.ready.has(rid)) { if (contiguous) drop++; continue; }
        if (budget.left-- <= 0) return undefined;
        const verdict = this.verdict(db, rid, now);
        if (verdict.kind === "claimable") return rid;
        if (verdict.kind === "skip") { contiguous = false; continue; }
        if (verdict.kind === "settle") this.noteSettle(rid, verdict.category);
        else if (verdict.kind === "gone") this.ready.delete(rid);
        else this.addWaiting(rid, scope, verdict.due);
        if (contiguous) drop++;
      }
      return null;
    } finally { list.dropFront(drop); }
  }

  /** Round robin over scopes. `undefined` when the check budget ran out (the caller asks SQL instead). */
  next(db: DatabaseSync, now: number, lastScope: string): { rid: bigint; scope: string } | null | undefined {
    // While the first build runs the choice comes from the rows read so far (a bounded answer; the order among
    // scopes may differ until the build ends). The SQL aggregate over every open job is never asked for it.
    this.beginTurn();
    this.sync(db, now);
    // Nothing filed yet while rows are still unread (finished history ahead of a pending backlog): keep reading
    // chunks, inside a small time budget, until a candidate appears. The rest continues on later turns.
    if (!this.order.length && (this.building || this.catchingUp)) {
      const stop = performance.now() + WARM_BUDGET_MS;
      try {
        while (!this.order.length && performance.now() < stop && this.canScan()) {
          if (this.building) { if (this.buildStep(db)) break; }
          else if (this.catchingUp) { if (this.advance(db, 1)) { this.catchingUp = false; break; } }
          else break;
        }
      } catch { this.stale = true; }
    }
    this.promote(now);
    const order = this.order;
    if (!order.length) return null;
    let start = lowerBound(order, lastScope, compareScope);
    if (start < order.length && compareScope(order[start]!, lastScope) === 0) start++;
    const budget = { left: CLAIM_INDEX_CHECK_LIMIT };
    const emptied: string[] = [];
    try {
      for (let step = 0; step < order.length; step++) {
        const scope = order[(start + step) % order.length]!;
        const rid = this.head(db, scope, now, budget);
        if (rid === undefined) return undefined;
        if (rid !== null) return { rid, scope };
        const list = this.scopes.get(scope);
        if (list && list.size === 0) emptied.push(scope);
      }
      return null;
    } finally {
      this.flushSettle(db, now);
      // Scopes with nothing left are forgotten (they come back when a job arrives).
      for (const scope of emptied) {
        const list = this.scopes.get(scope);
        if (!list || list.size > 0) continue;
        this.scopes.delete(scope);
        const at = lowerBound(this.order, scope, compareScope);
        if (this.order[at] === scope) this.order.splice(at, 1);
      }
    }
  }

  /** Recent-scopes mode: the highest claimable capture job across `scopes`. `undefined` when the budget ran out. */
  recent(db: DatabaseSync, now: number, scopes: readonly string[], filter: RecentFilter = {}): bigint | null | undefined {
    // A catch-up leaves the newest rows (what this mode wants) unread: the SQL lookup by scope answers instead.
    this.beginTurn();
    if (!this.sync(db, now) || this.catchingUp) return undefined;
    // The newest claimable may be a job that came due since the frontier last finished (Astra build3 Medium): while a frontier pass runs, or
    // one is owed and the turn's read went elsewhere, the index may hold an older due job and not the newest, so it does not answer.
    if (this.frontierWalk !== null || this.frontier < retryBound(now)) return undefined;
    this.promote(now);
    const budget = { left: CLAIM_INDEX_CHECK_LIMIT };
    let best: bigint | null = null;
    try {
      for (const scope of new Set(scopes)) {
        const list = this.scopes.get(scope);
        if (!list) continue;
        for (const rid of list.descending()) {
          if (best !== null && rid <= best) break;
          if (!this.ready.has(rid)) continue;
          if (budget.left-- <= 0) return undefined;
          const verdict = this.verdict(db, rid, now, filter);
          if (verdict.kind === "claimable") { best = rid; break; }
          if (verdict.kind === "settle") this.noteSettle(rid, verdict.category);
          else if (verdict.kind === "gone") this.ready.delete(rid);
          else if (verdict.kind === "wait") this.addWaiting(rid, scope, verdict.due);
        }
        // This scope's newest waiting jobs (a few: a turn's catch-up is about the newest): one may be claimable again.
        const waiting = this.waitingByScope.get(scope);
        if (waiting) for (const rid of [...waiting].sort((a, b) => compareRid(b, a)).slice(0, RECENT_WAITING_CHECKS)) {
          if (best !== null && rid <= best) break;
          const verdict = this.verdict(db, rid, now, filter);
          if (verdict.kind === "settle") { waiting.delete(rid); this.noteSettle(rid, verdict.category); continue; }
          if (verdict.kind === "gone") { waiting.delete(rid); continue; }
          if (verdict.kind === "claimable") { waiting.delete(rid); this.addReady(rid, scope); best = rid; }
        }
      }
    } finally { this.flushSettle(db, now); }
    return best;
  }

  /** The chosen job was leased until `leaseUntil`: it waits in the heap in case the lease runs out. */
  leased(rid: bigint, scope: string, leaseUntil: number): void {
    if (this.db === null || this.stale || rid > this.high) return;
    this.addWaiting(rid, scope, leaseUntil + 1);
  }

  /** A job may be claimable again (requeued, partly done, deferred): file it by its current state. */
  hint(db: DatabaseSync, jobId: string, now = Date.now()): void {
    if (db !== this.db || this.stale) return; // the next selection rebuilds anyway
    const row = this.statement(db, CLAIM_INDEX_SQL.byId).get(jobId) as { rid: bigint; scope: string } | undefined;
    if (!row || row.rid > this.high) return; // not walked yet: the build or the next read of new rows files it
    const verdict = this.verdict(db, row.rid, now);
    if (verdict.kind === "claimable" || verdict.kind === "skip") this.addReady(row.rid, String(row.scope));
    // a blocked job is not filed: the claim that meets it (or the sweep) closes it out; hint runs after the commit, so it writes nothing
    else if (verdict.kind === "wait") this.addWaiting(row.rid, String(row.scope), verdict.due);
    else this.ready.delete(row.rid);
  }

  /** For tests: how many candidates are filed (ready, waiting). */
  size(): { ready: number; waiting: number; scopes: number } { return { ready: this.ready.size, waiting: this.waitingSet.size, scopes: this.scopes.size }; }
}

/** The one index of the server's messages.db. */
export const memoryClaimIndex = new MemoryClaimIndex();
