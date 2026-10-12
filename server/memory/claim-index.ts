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
// the future, a live lease). Every read of the table is a BOUNDED rowid range
// (memory_jobs NOT INDEXED, rowid>? AND rowid<=?, at most SCAN_CHUNK rowids):
// the cursor advances over every rowid it examined, matching or not, so a
// backlog of finished jobs is walked once, never again (review finding 6: the
// planner had chosen memory_jobs_pending plus a sort over every open job on
// every claim). The first build is chunked: one chunk per claim and the rest
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

const OPEN = "('pending','partial','deferred','leased')";
export const CLAIM_INDEX_SQL = {
  /** Rows added since the last look, in rowid order: a range scan of the primary key and one probe per row. */
  scan: `SELECT j.rowid AS rid,s.scope_id AS scope FROM memory_jobs AS j NOT INDEXED CROSS JOIN memory_sources AS s ON s.id=j.source_id AND s.revision=j.source_revision
    WHERE j.rowid>? AND j.rowid<=? AND j.status IN ${OPEN} AND j.attempts<3 AND s.state='active'
    AND NOT (coalesce(s.kind,'') IN ('tool-outcome','activity') AND coalesce(s.outcome,'')='failed') ORDER BY j.rowid`,
  /** Where the table ends: the last rowid (one step down the primary key). */
  end: `SELECT max(rowid) AS rid FROM memory_jobs`,
  /** The next existing rowid after one (a primary key probe), to jump gaps in the rowids. */
  nextRid: `SELECT rowid AS rid FROM memory_jobs WHERE rowid>? ORDER BY rowid LIMIT 1`,
  /** One candidate, by rowid, with everything the claim rules read. */
  check: `SELECT j.status,j.attempts,j.retry_at,j.lease_until,j.stage,s.state,s.outcome,s.kind,s.thread_id,s.message_id
    FROM memory_jobs j LEFT JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE j.rowid=?`,
  /** A job's place, after a write that may have made it claimable again. */
  byId: `SELECT j.rowid AS rid,s.scope_id AS scope FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id AND s.revision=j.source_revision WHERE j.id=?`,
} as const;

/** Rowids one table read examines (the first build, new rows, a reconcile step): a few ms each. */
export const SCAN_CHUNK = 4096;
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
const OPEN_STATUSES = new Set(["pending", "partial", "deferred", "leased"]);

type Verdict = { kind: "claimable" } | { kind: "gone" } | { kind: "skip" } | { kind: "wait"; due: number };
interface ScopeList { rids: bigint[]; head: number }
interface Waiting { due: number; rid: bigint; scope: string }
export interface RecentFilter { exclude?: { threadId: string; messageIds: ReadonlySet<string> } }
/** What one selection cost, for tests and the trace. */
export interface ClaimIndexStats { checks: number; scanned: number; rebuilds: number; examined: number; reconciled: number }

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

export class MemoryClaimIndex {
  private db: DatabaseSync | null = null;
  private statements = new Map<string, StatementSync>();
  private scopes = new Map<string, ScopeList>();
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
  private buildTimer: ReturnType<typeof setImmediate> | null = null;
  private stale = true;
  /** The reconcile sweep: its cursor (null when no sweep runs) and when its next step may run (monotonic ms). */
  private reconcileFrom: bigint | null = null;
  private reconcileEnd = -1n;
  private reconcileAt = 0;
  /** A reopen was reported while the first build ran: sweep as soon as it completes. */
  private reopenAsked = false;
  /** A reopen was reported during a running sweep: the sweep carries on and one more pass follows it at once. */
  private reconcilePassQueued = false;
  /** New rows were left unread by a bounded call; they are read a few chunks per turn of the event loop. */
  private catchingUp = false;
  private catchTimer: ReturnType<typeof setImmediate> | null = null;
  private wake: (() => void) | null = null;
  private readonly clock: () => number;
  readonly stats: ClaimIndexStats = { checks: 0, scanned: 0, rebuilds: 0, examined: 0, reconciled: 0 };

  constructor(clock: () => number = () => performance.now()) { this.clock = clock; }

  /** Forget everything; the next selection rebuilds from the table (chunked). */
  invalidate(): void { this.stale = true; }
  /** A writer made jobs claimable again behind the index (a park reopen, a branch restore): sweep now. */
  reopened(): void {
    // A sweep that is running keeps its cursor (restarting it on every notification starves it); one more pass is
    // queued behind it for jobs reopened below the cursor. Otherwise a pass is due now.
    if (this.reconcileFrom !== null) { this.reconcilePassQueued = true; return; }
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
    const rows = this.statement(db, CLAIM_INDEX_SQL.scan).all(from, to) as Array<{ rid: bigint; scope: string }>;
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
  /** One chunk of the first build. True when the build is complete. */
  private buildStep(db: DatabaseSync): boolean {
    this.high = this.skipGap(db, this.high, this.buildEnd);
    const to = this.high + BigInt(SCAN_CHUNK) < this.buildEnd ? this.high + BigInt(SCAN_CHUNK) : this.buildEnd;
    this.walk(db, this.high, to, false);
    this.high = to;
    if (this.high >= this.buildEnd) {
      this.building = false;
      this.wake?.();
      this.reconcileFrom = null; this.reconcileAt = this.reopenAsked ? 0 : this.clock() + RECONCILE_INTERVAL_MS; this.reopenAsked = false;
      return true;
    }
    return false;
  }
  /** The rest of the first build runs a chunk per turn of the event loop, never in one block. */
  private continueBuild(db: DatabaseSync): void {
    if (this.buildTimer) return;
    this.buildTimer = setImmediate(() => {
      this.buildTimer = null;
      if (this.db !== db || this.stale || !this.building) return;
      try { if (!this.buildStep(db)) { this.continueBuild(db); if (this.ready.size) this.wake?.(); } }
      catch { this.stale = true; } // a closed or busy handle: the next selection starts again
    });
    this.buildTimer.unref?.();
  }

  /** Read at most `chunks` chunks of new rows. True when the index has reached the table's end. */
  private advance(db: DatabaseSync, chunks: number): boolean {
    const end = this.tableEnd(db);
    for (let n = 0; this.high < end; n++) {
      if (n >= chunks) return false;
      this.high = this.skipGap(db, this.high, end);
      if (this.high >= end) break;
      const to = this.high + BigInt(SCAN_CHUNK) < end ? this.high + BigInt(SCAN_CHUNK) : end;
      this.walk(db, this.high, to, false);
      this.high = to;
    }
    return true;
  }
  /** The rest of a large append is read a few chunks per turn of the event loop, never in one block. */
  private continueCatchUp(db: DatabaseSync): void {
    if (this.catchTimer) return;
    this.catchTimer = setImmediate(() => {
      this.catchTimer = null;
      if (this.db !== db || this.stale || this.building) { this.catchingUp = false; return; }
      try {
        if (this.advance(db, SYNC_CHUNKS_PER_CALL)) this.catchingUp = false; else this.continueCatchUp(db);
        this.wake?.();
      } catch { this.stale = true; this.catchingUp = false; } // a closed or busy handle: the next selection starts again
    });
    this.catchTimer.unref?.();
  }

  /** Bring the index up to date with `db`, within a bounded amount of work. False while the first build is still
   * running; while it (or a catch-up of a large append) runs, the index answers from what it holds so far. */
  private sync(db: DatabaseSync): boolean {
    if (db !== this.db || this.stale) {
      // A timer left from the previous build or handle would make continueBuild believe one is pending.
      if (this.buildTimer) { clearImmediate(this.buildTimer); this.buildTimer = null; }
      if (this.catchTimer) { clearImmediate(this.catchTimer); this.catchTimer = null; }
      this.db = db; this.statements.clear(); this.scopes.clear(); this.order = []; this.ready.clear();
      this.waiting = []; this.waitingSet.clear(); this.waitingByScope.clear(); this.high = -1n; this.stale = false; this.stats.rebuilds++;
      this.building = true; this.catchingUp = false; this.buildEnd = this.tableEnd(db); this.reconcileFrom = null; this.reconcilePassQueued = false;
    }
    if (this.building) {
      if (this.buildStep(db)) return true;
      this.continueBuild(db);
      return false;
    }
    // New rows since the last look: a bounded range of the primary key, nothing when nothing was added.
    if (!this.advance(db, SYNC_CHUNKS_PER_CALL)) { this.catchingUp = true; this.continueCatchUp(db); return true; }
    this.catchingUp = false;
    this.reconcileStep(db);
    return true;
  }

  /** One step of the reconcile sweep, when one is due: re-file open jobs the index lost track of. */
  private reconcileStep(db: DatabaseSync): void {
    const now = this.clock();
    if (now < this.reconcileAt) return;
    if (this.reconcileFrom === null) { this.reconcileFrom = -1n; this.reconcileEnd = this.high; this.reopenAsked = false; this.reconcilePassQueued = false; }
    const from = this.skipGap(db, this.reconcileFrom, this.reconcileEnd);
    const to = from + BigInt(SCAN_CHUNK) < this.reconcileEnd ? from + BigInt(SCAN_CHUNK) : this.reconcileEnd;
    this.walk(db, from, to, true);
    if (to >= this.reconcileEnd) { this.reconcileFrom = null; this.reconcileAt = this.reconcilePassQueued ? now : now + RECONCILE_INTERVAL_MS; }
    else { this.reconcileFrom = to; this.reconcileAt = now + RECONCILE_STEP_MS; }
  }

  private list(scope: string): ScopeList {
    let list = this.scopes.get(scope);
    if (!list) {
      list = { rids: [], head: 0 };
      this.scopes.set(scope, list);
      this.order.splice(lowerBound(this.order, scope, compareScope), 0, scope);
    }
    return list;
  }

  private addReady(rid: bigint, scope: string): void {
    if (this.ready.has(rid)) return;
    const list = this.list(scope);
    const tail = list.rids.length ? list.rids[list.rids.length - 1]! : -1n;
    if (rid > tail) list.rids.push(rid);
    else {
      // Out of order (a job coming back from the heap or a hint): insert in place, unless a stale copy is still there.
      const at = lowerBound(list.rids, rid, compareRid, list.head);
      if (list.rids[at] !== rid) list.rids.splice(at, 0, rid);
    }
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
    if (!row || !OPEN_STATUSES.has(String(row.status)) || Number(row.attempts) >= 3) return { kind: "gone" };
    // No source at the job's revision, a source that is not active, a failed tool outcome: not claimable until
    // something reopens it, which the fallback notices (the index is rebuilt then).
    if (row.state == null || row.state !== "active" || ((row.kind === "tool-outcome" || row.kind === "activity") && row.outcome === "failed")) return { kind: "gone" };
    if (row.outcome === "working") return { kind: "skip" };
    const retryAt = Number(row.retry_at), leaseUntil = Number(row.lease_until);
    if (retryAt > now) return { kind: "wait", due: retryAt };
    if (row.status === "leased" && leaseUntil >= now) return { kind: "wait", due: Math.max(retryAt, leaseUntil + 1) };
    if (recent) {
      if (row.stage !== "capture") return { kind: "skip" };
      const exclude = recent.exclude;
      if (exclude && row.thread_id === exclude.threadId && exclude.messageIds.has(String(row.message_id))) return { kind: "skip" };
    }
    return { kind: "claimable" };
  }

  private compact(list: ScopeList): void {
    if (list.head > 1024 && list.head * 2 > list.rids.length) { list.rids = list.rids.slice(list.head); list.head = 0; }
  }

  /** The oldest claimable job of `scope`, dropping or moving the stale entries met on the way. */
  private head(db: DatabaseSync, scope: string, now: number, budget: { left: number }): bigint | null | undefined {
    const list = this.scopes.get(scope);
    if (!list) return null;
    for (let at = list.head; at < list.rids.length; at++) {
      const rid = list.rids[at]!;
      const contiguous = at === list.head;
      if (!this.ready.has(rid)) { if (contiguous) list.head++; continue; }
      if (budget.left-- <= 0) return undefined;
      const verdict = this.verdict(db, rid, now);
      if (verdict.kind === "claimable") { this.compact(list); return rid; }
      if (verdict.kind === "skip") continue;
      if (verdict.kind === "gone") this.ready.delete(rid);
      else this.addWaiting(rid, scope, verdict.due);
      if (contiguous) list.head++;
    }
    this.compact(list);
    return null;
  }

  /** Round robin over scopes. `undefined` when the check budget ran out (the caller asks SQL instead). */
  next(db: DatabaseSync, now: number, lastScope: string): { rid: bigint; scope: string } | null | undefined {
    // While the first build runs the choice comes from the rows read so far (a bounded answer; the order among
    // scopes may differ until the build ends). The SQL aggregate over every open job is never asked for it.
    this.sync(db);
    // Nothing filed yet while rows are still unread (finished history ahead of a pending backlog): keep reading
    // chunks, inside a small time budget, until a candidate appears. The rest continues on later turns.
    if (!this.order.length && (this.building || this.catchingUp)) {
      const stop = performance.now() + WARM_BUDGET_MS;
      try {
        while (!this.order.length && performance.now() < stop) {
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
        if (list && list.head >= list.rids.length) emptied.push(scope);
      }
      return null;
    } finally {
      // Scopes with nothing left are forgotten (they come back when a job arrives).
      for (const scope of emptied) {
        const list = this.scopes.get(scope);
        if (!list || list.head < list.rids.length) continue;
        this.scopes.delete(scope);
        const at = lowerBound(this.order, scope, compareScope);
        if (this.order[at] === scope) this.order.splice(at, 1);
      }
    }
  }

  /** Recent-scopes mode: the highest claimable capture job across `scopes`. `undefined` when the budget ran out. */
  recent(db: DatabaseSync, now: number, scopes: readonly string[], filter: RecentFilter = {}): bigint | null | undefined {
    // A catch-up leaves the newest rows (what this mode wants) unread: the SQL lookup by scope answers instead.
    if (!this.sync(db) || this.catchingUp) return undefined;
    this.promote(now);
    const budget = { left: CLAIM_INDEX_CHECK_LIMIT };
    let best: bigint | null = null;
    for (const scope of new Set(scopes)) {
      const list = this.scopes.get(scope);
      if (!list) continue;
      for (let at = list.rids.length - 1; at >= list.head; at--) {
        const rid = list.rids[at]!;
        if (best !== null && rid <= best) break;
        if (!this.ready.has(rid)) continue;
        if (budget.left-- <= 0) return undefined;
        const verdict = this.verdict(db, rid, now, filter);
        if (verdict.kind === "claimable") { best = rid; break; }
        if (verdict.kind === "gone") this.ready.delete(rid);
        else if (verdict.kind === "wait") this.addWaiting(rid, scope, verdict.due);
      }
      // This scope's newest waiting jobs (a few: a turn's catch-up is about the newest): one may be claimable again.
      const waiting = this.waitingByScope.get(scope);
      if (waiting) for (const rid of [...waiting].sort((a, b) => compareRid(b, a)).slice(0, RECENT_WAITING_CHECKS)) {
        if (best !== null && rid <= best) break;
        const verdict = this.verdict(db, rid, now, filter);
        if (verdict.kind === "gone") { waiting.delete(rid); continue; }
        if (verdict.kind === "claimable") { waiting.delete(rid); this.addReady(rid, scope); best = rid; }
      }
    }
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
    else if (verdict.kind === "wait") this.addWaiting(row.rid, String(row.scope), verdict.due);
    else this.ready.delete(row.rid);
  }

  /** For tests: how many candidates are filed (ready, waiting). */
  size(): { ready: number; waiting: number; scopes: number } { return { ready: this.ready.size, waiting: this.waitingSet.size, scopes: this.scopes.size }; }
}

/** The one index of the server's messages.db. */
export const memoryClaimIndex = new MemoryClaimIndex();
