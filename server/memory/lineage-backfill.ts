// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy: the upgrade from 1.0.1 (v6) and earlier 1.0.2 (v7-v9) data (DESIGN-WRITETIME 4), and the marking half of the v10 -> v9
// downgrade. S5 owns every body here.
//
// U1 (rows): every message that has no memory_line_lineage row gets one, keyed over messages.rowid (the table's own b-tree), so a slice costs
// the rows it handles whatever the history holds. The lsn of an old line is fixed by its rowid: lsn = rowid - off, off = (top rowid at U1
// start) + 2. Every old lsn is therefore below 1 (lineage_upgrade_lsn, the first lsn a 1.0.2 writer takes), so old lines sort before every
// line 1.0.2 writes in the same thread, a parent's lsn is known without its row, and a slice that is killed and run again writes the same
// rows (resumable with no rank state). Positional order inside a thread is insertion order.
//   - copyOf and cross-thread root-set members become point carries (child_kind 'line', child_ref = the child's lsn as text) and
//     thread_flow edges. A v7 chained set is read one own-rows link at a time; a set already expanded into the thread is not read again,
//     and a member already carried into an earlier line of the thread is not carried again (positional order covers it).
//   - receipts fold into mem_lsn (STALE_MEM_LSN when any receipt in the ancestry is stale, 0 when all are current, NULL with none) and the
//     footprint (interned through lineage-write.ts internFootprint; FOOTPRINT_STAR when a part is unknown). Each row holds the thread's
//     running value, so the previous row of the thread is the whole same-thread fold.
//   - memory_sources by message -> memory_line_capture, and the thread -> scope:<S> flow edge from that line on.
//     memory_session_roots -> memory_session_lineage plus session carries.
//   - A line whose ancestry cannot be read (unprovable set '', a missing root or copy origin, more than COPY_ORIGINS origins) gets NO row:
//     it reads "checking" (withheld) for good, never shown.
// U1m: the scope -> scope flow edges of the history (evidence, derivations, bring-in), which the v10 memory_flow_* triggers write for every
// new row: with them the flow closure of a revoke reaches every scope, so its '*' window can close at the end of its flow phase.
// U1f: lines 1.0.2 wrote while U1 ran fold the old tail of their thread (their writer could not see it).
// U2 (seed): every existing deny fact is committed as a revoke root (revoke-commit.ts commitRevoke): tombstones, deleted or retired
// sources, withheldFromBots lines, memory_deny rows (deleted conversations and bots), revoked receipts. A commit that answers 0 (a
// blocked commit) blocks U2 with nothing written: the certificate stays not ready and every generated line keeps reading "checking".
// The certificate turns ready (ready = 1, phase 'done') in the transaction that commits the last seed.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { beginBackground } from "../db-busy.ts";
import { BACKFILL_SLICE_MS, COPY_ORIGINS, FOOTPRINT_STAR, lineChildRef, sessionChildRef, STALE_MEM_LSN, FIRST_LSN, type RevokeRoot } from "./lineage-types.ts";
import { internFootprint, readyImportedThreads } from "./lineage-write.ts";
import { ensureThreadNo, threadIdOf, threadNo } from "./thread-no.ts";
import { activateBulkRevoke, commitRevoke, openBulkRevoke } from "./revoke-commit.ts";
import { threadCheckpointId } from "./checkpoints.ts";
import { rootSetMembers } from "./schema.ts";
import { noteReceiptOutput } from "./receipt-outputs.ts";

export interface LineageCertProgress { phase: string; done: number; total: number; ready: boolean }

/** mem_lsn of a line resting on a receipt that was already stale at the upgrade: below every watermark. */
export { STALE_MEM_LSN };
/** session_lineage.last_lsn of a session from before the upgrade: after every old line (old lsns are at most -2), before every new one. */
export const OLD_SESSION_LAST_LSN = -1;
/** memory_lineage_carry.child_ref of a session child (lineage-types.ts holds the one encoding). */
export { sessionChildRef };

/** Lines after a forgotten one that forgetBound reads at most (past it: no bound). */
const FORGET_SCAN_LINES = 20_000;
const MESSAGE_BATCH = 64, MEMBER_BATCH = 256, SEED_BATCH = 256, FIX_BATCH = 256, PROMOTED_MAX = 16, EDGE_BATCH = 256;
/** A flow edge kept at its earliest first_lsn. */
const FLOW_MIN = "INSERT INTO memory_thread_flow(from_thread,to_thread,first_lsn) VALUES(?,?,?) ON CONFLICT(from_thread,to_thread) DO UPDATE SET first_lsn=min(first_lsn,excluded.first_lsn)";
/** first_lsn of a scope -> scope edge from before the upgrade: its time is not known, so it counts from the start (since(B) = since(A)). */
const OLD_EDGE_LSN = STALE_MEM_LSN;

interface PartialLine { rowid: number; chain: string[]; after: [string, string] | null; expanded: string[]; n?: number; size?: number; mem: number | null; scopes: "star" | string[] | null;
  /** A carried parent had no row: the line is unprovable (no row of its own) once its chain is read. */
  lost?: boolean }
interface Cursor {
  off: number; top: number; low: number;
  /** U1: the last message rowid finished by the global pass. */
  rowid: number;
  /** U1: the line whose root-set chain was cut by the slice budget. */
  line?: PartialLine;
  /** U1s: the last session key finished. */
  session?: [string, string, string];
  /** U1f: the thread and lsn last folded. */
  fix?: [number, number];
  /** U1m: the memory edge step (0 evidence, 1 derivations, 2 bring-in) and the key last done in it. */
  edges?: [number, string];
  /** U2: the seed step and the key last committed in it. */
  seed?: [number, string];
  /** U1m: rows done in the current edge step; U1f: rows folded in the current thread; U2: [step, rows done] for a step with no counted total.
   * They only grow inside their step, so the strip moves through a heavy step instead of waiting for it to end (see inStep). */
  edgeRows?: number; fixRows?: number; seedRows?: [number, number];
  /** U1s: sessions to walk (counted once at the start of the phase) and sessions finished, so the strip never counts the table per slice. */
  sessions?: [number, number];
  /** U2: the seed step, the rows it has (counted once at the step's start; 0 = not counted) and the rows finished, for the strip's fraction. */
  seedCount?: [number, number, number];
  /** U2: the bulk revokes its roots go into ([every reader, audience only]; 0 = not opened yet), activated when U2 drains. */
  bulk?: [number, number];
}
type Phase = "u1" | "u1s" | "u1m" | "u1f" | "u2" | "done";

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function stmt(db: DatabaseSync, sql: string): StatementSync {
  let byDb = statements.get(db);
  if (!byDb) { byDb = new Map(); statements.set(db, byDb); }
  let found = byDb.get(sql);
  if (!found) { found = db.prepare(sql); byDb.set(sql, found); }
  return found;
}

/** What U1 learned of the 1.0.1 root sets, kept from slice to slice. Those sets are frozen (nothing writes them after the upgrade:
 * schema.ts ROOT_SETS_FROZEN), so a proof or a member list read once never goes stale; without this a 1.0.1 chain (one per thread, each
 * reply's set the one before it plus a few roots) was read whole for every reply, and the upgrade of a long history ran in its square.
 *  - proven: whether the RC could prove a set (rootSetMembers !== null), bounded;
 *  - tips: the members of the sets proven last (a chain's tip); the next set of the chain takes them over and adds its own rows;
 *  - expanded: per thread, the sets already expanded into a line of it that has its row (committed slices only). */
interface RootSetMemo { proven: Map<string, boolean>; tips: Map<string, Set<string>>; expanded: Map<string, string[]>; lsns: Map<string, number> }
const LSN_MEMO_MAX = 100_000, ROOT_SET_PROVEN_MAX = 200_000, ROOT_SET_TIPS_MAX = 256, EXPANDED_KEPT = 64;
let rootSetMemos = new WeakMap<DatabaseSync, RootSetMemo>();
function rootSetMemo(db: DatabaseSync): RootSetMemo {
  let memo = rootSetMemos.get(db);
  if (!memo) rootSetMemos.set(db, memo = { proven: new Map(), tips: new Map(), expanded: new Map(), lsns: new Map() });
  return memo;
}
/** Whether the RC could prove `setId` (schema.ts rootSetMembers: its chain present, each link strictly smaller, each link's own rows
 * exactly its size less its parent's, and no root held twice along the chain), read once per set: a set whose parent is a proven tip
 * checks only its own rows against the tip's members. */
function provenRootSet(db: DatabaseSync, memo: RootSetMemo, setId: string): boolean {
  const known = memo.proven.get(setId);
  if (known !== undefined) return known;
  let ok: boolean;
  let members: Set<string> | null = null;
  const node = stmt(db, "SELECT r.size AS z,p.parent_id AS p FROM memory_root_sets r LEFT JOIN memory_root_set_parents p ON p.set_id=r.set_id WHERE r.set_id=?").get(setId);
  const parentId = node && node.p !== null && node.p !== undefined ? String(node.p) : null;
  const tip = parentId === null ? undefined : memo.tips.get(parentId);
  if (!node) ok = false;
  else if (parentId !== null && memo.proven.get(parentId) === false) ok = false; // a link below it the RC could not prove: nor this one
  else if (parentId !== null && tip && memo.proven.get(parentId) === true) {
    const parentSize = Number(stmt(db, "SELECT size AS z FROM memory_root_sets WHERE set_id=?").get(parentId)?.z ?? -1);
    const own = stmt(db, "SELECT root_thread_id AS t,root_message_id AS m FROM memory_root_set_members WHERE set_id=?").all(setId).map(row => `${String(row.t)}\u0000${String(row.m)}`);
    ok = parentSize >= 0 && parentSize < Number(node.z) && own.length === Number(node.z) - parentSize && own.every(key => !tip.has(key));
    if (ok) {
      // the tip moves on: the parent's members become this set's (a later set resting on the parent reads its chain again)
      memo.tips.delete(parentId);
      for (const key of own) tip.add(key);
      members = tip;
    }
  } else {
    members = rootSetMembers(db, setId);
    ok = members !== null;
  }
  if (memo.proven.size >= ROOT_SET_PROVEN_MAX) memo.proven.clear();
  memo.proven.set(setId, ok);
  if (members) {
    if (memo.tips.size >= ROOT_SET_TIPS_MAX) memo.tips.delete(memo.tips.keys().next().value!);
    memo.tips.set(setId, members);
  }
  return ok;
}

/** Verdicts U2 reached on what receipts cite, kept per connection across slices (slices are 50 ms; a Work object lasts one) and dropped when the
 * file's data revision, policy or deletion epoch moves, so a stale "good" never outlives a change. */
const citedMemos = new WeakMap<DatabaseSync, { stamp: string; verdicts: Map<string, boolean> }>();
const CITED_MAX = 200_000;
function citedMemo(db: DatabaseSync, stamp: string): Map<string, boolean> {
  let memo = citedMemos.get(db);
  if (!memo || memo.stamp !== stamp || memo.verdicts.size >= CITED_MAX) citedMemos.set(db, memo = { stamp, verdicts: new Map() });
  return memo.verdicts;
}

/** Threads a turn arrived on, served before the global pass (insertion order; the newest promotion goes first). */
const promoted = new Map<string, number | null>();

/** Test hook: the revoke commit U2 seeds through (a commit that answers 0 blocks U2). */
let seedCommit: ((tx: DatabaseSync, root: RevokeRoot) => number) | null = null;
export function setLineageSeedCommitForTest(commit: ((tx: DatabaseSync, root: RevokeRoot) => number) | null): void { seedCommit = commit; }

class SliceOver extends Error {}
class SeedBlocked extends Error {}

/** One slice of U1 (rows) or U2 (seed) under the recovery scheduler's admission, at most budgetMs (default BACKFILL_SLICE_MS), cursor committed
 * in the slice. more = false when the certificate is ready, or when U2 is blocked on a revoke commit that is not built yet (nothing is
 * shown early: the certificate stays not ready). */
export function lineageBackfillSlice(db: DatabaseSync, options: { budgetMs?: number; now?: () => number } = {}): { more: boolean; blocked?: true } {
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.budgetMs ?? BACKFILL_SLICE_MS);
  let cert: { phase: string; cursor: string; done: number; total: number; ready: number } | undefined;
  try {
    const row = stmt(db, "SELECT phase,cursor,done,total,ready FROM memory_lineage_cert WHERE id=1").get();
    if (row) cert = { phase: String(row.phase), cursor: String(row.cursor), done: Number(row.done), total: Number(row.total), ready: Number(row.ready) };
  } catch { return { more: false }; } // below v10
  if (!cert || cert.ready === 1 || cert.phase === "done") return { more: false };
  if (cert.phase === "down") {
    // a downgrade was interrupted and 1.0.2 runs again: the backfill carries on where it was (the marks the downgrade wrote only withhold more)
    try {
      const [phase, cursor] = JSON.parse(String(JSON.parse(cert.cursor).prev)) as [string, string];
      stmt(db, "UPDATE memory_lineage_cert SET phase=?,cursor=? WHERE id=1").run(phase, cursor);
      cert = { ...cert, phase, cursor };
    } catch { return { more: false }; }
    if (cert.phase === "done" || cert.phase === "down") return { more: false };
  }
  if (db.isTransaction) return { more: true }; // a caller's transaction is open: try again in the next slice
  beginBackground(db, "lineage-backfill"); // a background slice: no wait past the background budget (a busy start is retried by the job loop)
  try {
    let phase = cert.phase as Phase;
    const cursor = cert.cursor ? JSON.parse(cert.cursor) as Cursor : startCursor(db);
    const work = new Work(db, cursor, now, deadline);
    try {
      if (phase === "u1") { if (work.u1()) phase = "u1s"; }
      if (phase === "u1s") { if (work.sessions()) phase = "u1m"; }
      if (phase === "u1m") { if (work.memoryEdges()) phase = "u1f"; }
      if (phase === "u1f") { if (work.fixLive()) phase = "u2"; }
      if (phase === "u2") { if (work.seed()) { phase = "done"; work.activateSeeds(); } }
    } catch (error) { if (!(error instanceof SliceOver)) throw error; }
    // Count completed work, including members inside one message. A rounded cursor fraction can stay unchanged across many committed slices.
    // Keep the previous reading as the resume floor; the cursor fraction estimates remaining work only. The final unit is the certificate commit.
    const done = cert.done + work.worked + (phase === "done" ? 1 : 0);
    const span = progressTotal(cursor);
    const remaining = Math.max(1, Math.ceil((span - lineageProgress(db, phase, cursor, span)) / PROGRESS_SCALE));
    const total = phase === "done" ? done : done + remaining;
    stmt(db, "UPDATE memory_lineage_cert SET phase=?,cursor=?,done=?,total=?,ready=? WHERE id=1").run(phase, JSON.stringify(cursor), done, total, phase === "done" ? 1 : 0);
    // threads a legacy-file import marked not ready while the upgrade ran are judged from now on (lineage-write.ts readyImportedThread)
    if (phase === "done") readyImportedThreads(db);
    db.exec("COMMIT");
    if (phase === "done") { rootSetMemos.delete(db); citedMemos.delete(db); } else work.keepExpanded();
    return { more: phase !== "done" };
  } catch (error) {
    if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } }
    if (error instanceof SeedBlocked) return { more: false, blocked: true };
    throw error;
  }
}

/** The phases after the walk of the history (U1s, U1m, U1f, U2) each get a share of the bar, so the strip moves through every one of them and never
 * waits on "one item left": the walk of the history takes the first `span` units, the four later phases `phaseUnit(span)` each, the last unit is the
 * certificate turning ready. */
const PHASE_UNITS = 4;
const progressTotal = (cursor: Cursor): number => { const span = Math.max(1, cursor.top - cursor.low + 1); return PROGRESS_SCALE * (span + PHASE_UNITS * phaseUnit(span)) + 1; };
/** Each unit of the bar is this many steps, so the work inside one message or one phase unit moves the bar between two finished units. */
export const PROGRESS_SCALE = 64;
const phaseUnit = (span: number): number => Math.max(1, Math.ceil(span / 8));
/** How far through its phase a cursor is, 0..1, from the cursor and a cheap count (never the history). */
function phaseFraction(db: DatabaseSync, phase: Phase, cursor: Cursor): number {
  try {
    if (phase === "u1s") {
      // counted once for the phase (and, on a cursor from an earlier build, once for the sessions already done), then carried in the cursor
      if (!cursor.sessions) {
        const all = Number(stmt(db, "SELECT count(*) AS n FROM memory_session_roots").get()?.n ?? 0);
        const finished = cursor.session ? Number(stmt(db, "SELECT count(*) AS n FROM memory_session_roots WHERE (thread_id,driver_instance,native_session)<=(?,?,?)").get(...cursor.session)?.n ?? 0) : 0;
        cursor.sessions = [all, finished];
      }
      const [all, finished] = cursor.sessions;
      return all ? Math.min(1, finished / all) : 1;
    }
    if (phase === "u1m") return Math.min(1, ((cursor.edges?.[0] ?? 0) + inStep(cursor.edgeRows ?? 0)) / 3);
    if (phase === "u1f") {
      const top = Number(stmt(db, "SELECT max(no) AS n FROM memory_thread_no").get()?.n ?? 0);
      return top ? Math.min(1, (Number(cursor.fix?.[0] ?? 0) + inStep(cursor.fixRows ?? 0)) / top) : 1;
    }
    if (phase === "u2") return Math.min(1, ((cursor.seed?.[0] ?? 0) + seedStepFraction(cursor)) / SEED_STEPS);
  } catch { /* a missing table reads as the start of the phase */ }
  return 0;
}
const SEED_STEPS = 6;
/** How far a step that has no known size is, 0..<1, from the rows it has done: n/(n+unit). It rises with every row and never reaches 1, so a heavy step
 * moves the bar at least a little each slice, and the step's end is the only thing that finishes it. */
const STEP_UNIT_ROWS = 20_000;
const inStep = (rows: number): number => rows > 0 ? rows / (rows + STEP_UNIT_ROWS) : 0;
/** How far through its own step U2 is, 0..1, from the key (the message rowid for the hidden-lines step) or from the rows counted at the step's
 * start; a step with neither reads 0 until it is over. */
function seedStepFraction(cursor: Cursor): number {
  const step = cursor.seed?.[0] ?? 0;
  if (step >= SEED_STEPS) return 0;
  if (step === 2) {
    const span = Math.max(1, cursor.top - cursor.low + 1), at = Number(cursor.seed?.[1] || cursor.low - 1);
    return Math.max(0, Math.min(1, (at - (cursor.low - 1)) / span));
  }
  const count = cursor.seedCount;
  if (count && count[0] === step && count[1] > 0) return Math.max(0, Math.min(1, count[2] / count[1]));
  return cursor.seedRows?.[0] === step ? inStep(cursor.seedRows[1]) : 0;
}
/** Units of the bar done: the history's rows in U1, then the finished phases plus the fraction of the current one; never the last unit before ready. */
function lineageProgress(db: DatabaseSync, phase: Phase, cursor: Cursor, total: number): number {
  const span = Math.max(1, cursor.top - cursor.low + 1), unit = phaseUnit(span);
  if (phase === "u1") return Math.max(0, Math.min(total - 1, PROGRESS_SCALE * (cursor.rowid - cursor.low + 1) + Math.floor((PROGRESS_SCALE - 1) * lineFraction(cursor.line))));
  const finished = ({ u1s: 0, u1m: 1, u1f: 2, u2: 3 } as Record<string, number>)[phase] ?? 0;
  return Math.max(0, Math.min(total - 1, PROGRESS_SCALE * span + Math.floor((finished + phaseFraction(db, phase, cursor)) * unit * PROGRESS_SCALE)));
}

/** How far through a cut line's root-set expansion it is, 0..<1: members handled n against the first set's size, as n/(n+size), so it only
 * grows while the line runs and never reaches 1 (the size is cumulative, but sets already expanded are skipped, so n can pass it). */
function lineFraction(line: PartialLine | undefined): number {
  const n = line?.n ?? 0;
  return n > 0 ? n / (n + Math.max(1, line?.size ?? MEMBER_BATCH)) : 0;
}

/** Moves a thread to the front of the backfill queue (the thread a turn arrives on). Constant time; a thread already done costs one seek. */
export function promoteLineageThread(threadId: string): void {
  promoted.delete(threadId);
  promoted.set(threadId, null);
  while (promoted.size > PROMOTED_MAX) promoted.delete(promoted.keys().next().value!);
}
/** Test hook: the promotion queue as it stands. */
export function promotedLineageThreadsForTest(): string[] { return [...promoted.keys()]; }
export function resetLineageBackfillForTest(): void { promoted.clear(); rootSetMemos = new WeakMap(); }
/** Test hook: the cited-verdict memo of a connection as it stands (entries kept across slices). */
export function citedMemoSizeForTest(db: DatabaseSync): number { return citedMemos.get(db)?.verdicts.size ?? 0; }

/** Bulk revokes the seed opened that the marker has not finished walking (the strip's last phase). */
export function upgradeMarkerJobs(db: DatabaseSync): number {
  try { return Number(stmt(db, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE kind='bulk' AND state IN ('active','undoing') AND root LIKE '%\"upgrade-seed\"%'").get()?.n ?? 0); }
  catch { return 0; }
}

/** The marker's work left, in units finer than jobs: one per job plus the frontier nodes still queued for the seed's revokes (the walk deletes a node
 * as it handles it), counted to a bound so the count is never a scan of a huge queue. The bar moves with the walk instead of sitting at 0/2. */
export const MARKER_WORK_COUNT_CAP = 200_000;
export function upgradeMarkerWork(db: DatabaseSync): number {
  const jobs = upgradeMarkerJobs(db);
  if (!jobs) return 0;
  try {
    const queued = Number(stmt(db, `SELECT count(*) AS n FROM (SELECT 1 FROM memory_revoke_frontier WHERE revoke_id IN (SELECT revoke_id FROM memory_revoke_jobs WHERE kind='bulk' AND state IN ('active','undoing') AND root LIKE '%"upgrade-seed"%') LIMIT ${MARKER_WORK_COUNT_CAP})`).get()?.n ?? 0);
    return jobs + queued;
  } catch { return jobs; }
}

/** How far the frontier nodes being walked are through their own fan-out, in whole nodes (< 1 per active job): rows the current node has spent
 * w become w/(w+MARKER_FANOUT_UNIT), which only grows while the node runs and never reaches 1, so a count of nodes that stands still for a
 * minute on one large node still moves. Read from the jobs' cursors (revoke-marker.ts markStep), at most 16 rows. */
export const MARKER_FANOUT_UNIT = 512;
export function upgradeMarkerFanout(db: DatabaseSync): number {
  try {
    let sum = 0;
    for (const row of stmt(db, "SELECT cursor FROM memory_revoke_jobs WHERE kind='bulk' AND state IN ('active','undoing') AND phase='mark' AND root LIKE '%\"upgrade-seed\"%' LIMIT 16").all()) {
      let w = 0;
      try { w = Number(JSON.parse(String(row.cursor)).w ?? 0); } catch { /* an empty cursor */ }
      if (w > 0) sum += w / (w + MARKER_FANOUT_UNIT);
    }
    return sum;
  } catch { return 0; }
}

/** memory_lineage_cert as the upgrade screen shows it ("Checking earlier memory"). Not ready when the row cannot be read. */
export function lineageCertProgress(db: DatabaseSync): LineageCertProgress {
  try {
    const row = db.prepare("SELECT phase,done,total,ready FROM memory_lineage_cert WHERE id=1").get();
    if (row) return { phase: String(row.phase), done: Number(row.done), total: Number(row.total), ready: Number(row.ready) === 1 };
  } catch { /* below v10 */ }
  return { phase: "absent", done: 0, total: 0, ready: false };
}

function startCursor(db: DatabaseSync): Cursor {
  // a memory file without the transcript tables (a test file, a bare inspector copy): no history to walk
  if (!stmt(db, "SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name='messages'").get()) return { off: 2, top: 0, low: 1, rowid: 0 };
  const top = Number(stmt(db, "SELECT max(rowid) AS r FROM messages").get()?.r ?? 0);
  const low = Number(stmt(db, "SELECT min(rowid) AS r FROM messages").get()?.r ?? 1);
  return { off: top + 2, top, low, rowid: low - 1 };
}

interface Message { rowid: number; thread: string; id: string; role: string; json: string }
interface Fold { mem: number | null; scopes: Set<string> | "star" | null }

class Work {
  worked = 0;
  private readonly policy: number; private readonly epoch: number; private readonly citedVerdicts: Map<string, boolean>;
  /** set ids already expanded into a line of a thread that has its row: the committed slices' (rootSetMemo) and this slice's. */
  private readonly expanded = new Map<string, Set<string>>();
  private readonly memo: RootSetMemo;
  // (no parameter properties: the server runs as TypeScript with types stripped, which cannot express them)
  private readonly db: DatabaseSync; private readonly c: Cursor; private readonly now: () => number; private readonly deadline: number;
  constructor(db: DatabaseSync, c: Cursor, now: () => number, deadline: number) {
    this.db = db; this.c = c; this.now = now; this.deadline = deadline;
    this.memo = rootSetMemo(db);
    const meta = stmt(db, "SELECT policy_revision AS p,deletion_epoch AS e,data_revision AS d FROM memory_meta WHERE id=1").get();
    this.policy = Number(meta?.p ?? 0); this.epoch = Number(meta?.e ?? 0);
    this.citedVerdicts = citedMemo(db, `${Number(meta?.d ?? 0)}:${this.policy}:${this.epoch}`);
  }
  private over(): boolean { return this.now() >= this.deadline; }
  private lsnOf(rowid: number): number { return rowid - this.c.off; }

  // ---- U1 ----
  /** True when the global pass has walked every old message. */
  u1(): boolean {
    if (this.c.top === 0) return true;
    // a line cut part-way has no row yet: a promoted thread must not write the lines after it first (their fold would miss it)
    if (!this.c.line) this.promotedWork();
    for (;;) {
      if (this.c.line) {
        const m = this.messageAt(this.c.line.rowid);
        const partial = m ? this.line(m, this.c.line, true) : null;
        if (partial && partial !== "parent-missing") { this.c.line = partial; throw new SliceOver(); }
        this.c.rowid = this.c.line.rowid; delete this.c.line; this.worked++;
        if (this.over()) throw new SliceOver();
      }
      const batch = stmt(this.db, "SELECT rowid AS r,thread_id AS t,id,role,json FROM messages WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?").all(this.c.rowid, this.c.top, MESSAGE_BATCH);
      if (!batch.length) return true;
      for (const row of batch) {
        const m: Message = { rowid: Number(row.r), thread: String(row.t), id: String(row.id), role: String(row.role), json: String(row.json) };
        const partial = this.line(m, null, true);
        if (partial && partial !== "parent-missing") { this.c.line = partial; throw new SliceOver(); }
        this.c.rowid = m.rowid; this.worked++;
        if (this.over()) throw new SliceOver();
      }
    }
  }
  /** The promoted threads first, each from where the global pass is. A line whose cross-thread parent has no row yet ends that thread's
   * promotion (the global pass, which reaches parents first, finishes it): a guess would be a fold that can never be corrected. */
  private promotedWork(): void {
    for (const thread of [...promoted.keys()].reverse()) {
      let from = Math.max(promoted.get(thread) ?? this.c.rowid, this.c.rowid);
      for (;;) {
        if (this.over()) { promoted.set(thread, from); throw new SliceOver(); }
        const batch = stmt(this.db, "SELECT rowid AS r,thread_id AS t,id,role,json FROM messages WHERE thread_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?").all(thread, from, this.c.top, MESSAGE_BATCH);
        if (!batch.length) { promoted.delete(thread); break; }
        let stop = false;
        for (const row of batch) {
          const m: Message = { rowid: Number(row.r), thread: String(row.t), id: String(row.id), role: String(row.role), json: String(row.json) };
          const result = this.line(m, null, false);
          if (result === "parent-missing" || result) { stop = true; break; }
          from = m.rowid; this.worked++;
          if (this.over()) break;
        }
        if (stop) { promoted.delete(thread); break; }
      }
    }
  }
  private messageAt(rowid: number): Message | null {
    const row = stmt(this.db, "SELECT rowid AS r,thread_id AS t,id,role,json FROM messages WHERE rowid=?").get(rowid);
    return row ? { rowid: Number(row.r), thread: String(row.t), id: String(row.id), role: String(row.role), json: String(row.json) } : null;
  }
  /** The thread's interned number (thread-no.ts), taken now when it has none. */
  private no(thread: string): number { return ensureThreadNo(this.db, thread); }
  /** A generated line left without a row (its ancestry cannot be proven: it reads "checking" for good). What was captured from it is held
   * the same way: its captures are parked at FIRST_LSN (which no positional walk reaches: the source is denied as a whole) and U2 commits
   * each such source as an `unprovable` memory root, so a record or a receipt resting on it is withheld as the RC withheld it (a captured
   * reply the judge could not prove made its citing receipts bad). */
  private unprovable(m: Message, lsn: number): null {
    for (const source of stmt(this.db, "SELECT id FROM memory_sources WHERE thread_id=? AND message_id=?").all(m.thread, m.id))
      stmt(this.db, "INSERT OR IGNORE INTO memory_line_capture(thread_no,lsn,source_id) VALUES(?,?,?)").run(this.no(m.thread), FIRST_LSN, String(source.id));
    // its position is known (its rowid) even with no row: the receipts it is an output of start there, so revoking one reaches every later
    // line of the thread (receipt-outputs.ts)
    for (const receipt of stmt(this.db, "SELECT o.bundle_id AS b,d.driver_instance AS di,d.native_session AS ns FROM memory_disclosure_outputs o JOIN memory_disclosures d ON d.bundle_id=o.bundle_id WHERE o.thread_id=? AND o.message_id=?").all(m.thread, m.id))
      noteReceiptOutput(this.db, String(receipt.b), m.thread, lsn, { driverInstance: String(receipt.di), nativeSession: receipt.ns === null ? null : String(receipt.ns) });
    return null;
  }
  /** Whether the RC could prove a stored set (schema.ts rootSetMembers), kept from slice to slice (provenRootSet). */
  private provable(setId: string): boolean { return provenRootSet(this.db, this.memo, setId); }
  private expandedInto(thread: string): Set<string> | undefined {
    let into = this.expanded.get(thread);
    if (!into) {
      const kept = this.memo.expanded.get(thread);
      if (kept) this.expanded.set(thread, into = new Set(kept));
    }
    return into;
  }
  /** After the slice committed: the sets expanded into each thread's lines (the last few: a 1.0.1 chain grows one set per reply, so the
   * next reply's walk stops at its parent) are kept for the next slice. */
  keepExpanded(): void {
    for (const [thread, ids] of this.expanded) {
      const list = [...ids];
      this.memo.expanded.set(thread, list.length > EXPANDED_KEPT ? list.slice(-EXPANDED_KEPT) : list);
    }
  }
  private hasRow(thread: string, id: string): boolean { return Boolean(stmt(this.db, "SELECT 1 AS x FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(this.no(thread), id)); }
  /** The lsn of a stored line: an old one by its rowid, a line 1.0.2 wrote by its row. undefined when the message is gone. */
  private lsnOfMessage(thread: string, id: string): number | undefined {
    const key = `${thread}\u0000${id}`;
    const known = this.memo.lsns.get(key);
    if (known !== undefined) return known;
    const row = stmt(this.db, "SELECT rowid AS r FROM messages WHERE thread_id=? AND id=?").get(thread, id);
    if (!row) return undefined;
    const rowid = Number(row.r);
    if (rowid <= this.c.top) {
      // a message of the old history keeps its rowid, so a big line read again by the next slice does not look every member up again
      if (this.memo.lsns.size >= LSN_MEMO_MAX) this.memo.lsns.clear();
      this.memo.lsns.set(key, this.lsnOf(rowid));
      return this.lsnOf(rowid);
    }
    const live = stmt(this.db, "SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(this.no(thread), id);
    return live ? Number(live.lsn) : undefined;
  }
  private rowFold(thread: string, lsn: number): Fold | undefined {
    const row = stmt(this.db, "SELECT mem_lsn AS m,footprint AS f FROM memory_line_lineage WHERE thread_no=? AND lsn=?").get(this.no(thread), lsn);
    return row ? { mem: row.m === null ? null : Number(row.m), scopes: this.scopesOf(row.f) } : undefined;
  }
  private prevFold(thread: string | number, lsn: number): Fold {
    const row = stmt(this.db, "SELECT mem_lsn AS m,footprint AS f FROM memory_line_lineage WHERE thread_no=? AND lsn<? ORDER BY lsn DESC LIMIT 1").get(typeof thread === "number" ? thread : this.no(thread), lsn);
    return row ? { mem: row.m === null ? null : Number(row.m), scopes: this.scopesOf(row.f) } : { mem: null, scopes: null };
  }
  private scopesOf(footprint: unknown): Set<string> | "star" | null {
    if (footprint === null || footprint === undefined) return null;
    const id = Number(footprint);
    if (id === FOOTPRINT_STAR) return "star";
    return new Set(stmt(this.db, "SELECT scope_id AS s FROM memory_scope_sets WHERE set_id=?").all(id).map(row => String(row.s)));
  }

  /** One message. Returns null when finished (row written, or left without one when unprovable), a PartialLine when the slice budget
   * cut its root-set chain (global pass only), or "parent-missing" (promoted pass only) when a cross-thread parent has no row yet. */
  private line(m: Message, resume: PartialLine | null, global: boolean): PartialLine | "parent-missing" | null {
    if (this.hasRow(m.thread, m.id)) return null;
    const lsn = this.lsnOf(m.rowid);
    const generated = m.role !== "user";
    let fold = this.prevFold(m.thread, lsn);
    let parsed: { copyOf?: { threadId?: unknown; messageIds?: unknown }; turnId?: unknown; withheldFromBots?: unknown } = {};
    try { parsed = JSON.parse(m.json) ?? {}; } catch { parsed = {}; }
    const carries: Array<{ thread: string; lsn: number }> = [];
    if (resume) fold = mergeFold(fold, { mem: resume.mem, scopes: resume.scopes === null || resume.scopes === "star" ? resume.scopes : new Set(resume.scopes) });
    let lost = resume?.lost === true;
    // a carried parent's fold joins the line's at once (a cut line keeps it in its cursor). The global pass walks rowids in order, so a parent
    // with no row was left without one (unprovable): no revoke could ever reach the line through it, so the line is unprovable too (no row:
    // it reads "checking", never shown), as the RC withheld a copy or a reply whose origin or root it could not prove
    const carry = (thread: string, at: number): boolean => {
      carries.push({ thread, lsn: at });
      const parentFold = this.rowFold(thread, at);
      if (!parentFold) {
        if (!global) return false;
        lost = true;
        fold = mergeFold(fold, { mem: STALE_MEM_LSN, scopes: "star" });
      } else fold = mergeFold(fold, parentFold);
      return true;
    };
    let expandedHere = new Set<string>();
    if (generated) {
      // copies: a point carry to each original
      const copy = parsed.copyOf;
      if (copy) {
        const ids = Array.isArray(copy.messageIds) ? copy.messageIds : null;
        if (typeof copy.threadId !== "string" || !ids || ids.length > COPY_ORIGINS) return this.unprovable(m, lsn); // unprovable: no row
        for (const id of ids) {
          const at = typeof id === "string" ? this.lsnOfMessage(copy.threadId, id) : undefined;
          if (at === undefined) return this.unprovable(m, lsn);
          if ((copy.threadId !== m.thread || at > lsn) && !carry(copy.threadId, at)) return "parent-missing";
          // an earlier line of its own thread is positional, but one left without a row (unprovable) proves nothing: the copy is unprovable
          if (copy.threadId === m.thread && at < lsn && !this.rowFold(m.thread, at)) lost = true;
        }
      }
      // root sets: own rows of each link of the chain, members not already positional or carried into this thread
      let state = resume;
      if (!state) {
        const set = stmt(this.db, "SELECT set_id AS s FROM memory_output_roots WHERE thread_id=? AND message_id=?").get(m.thread, m.id);
        if (set && String(set.s) === "") return this.unprovable(m, lsn); // the unprovable marker
        // a set the RC could not prove (a chain link whose rows are not its size less its parent's, a member held twice along the chain:
        // schema.ts rootSetMembers) withheld the line in the RC: here it is unprovable too (no row)
        if (set && !this.provable(String(set.s))) return this.unprovable(m, lsn);
        state = { rowid: m.rowid, chain: set ? [String(set.s)] : [], after: null, expanded: [], n: 0, size: set ? Number(stmt(this.db, "SELECT size AS z FROM memory_root_sets WHERE set_id=?").get(String(set.s))?.z ?? 0) : 0, mem: null, scopes: null };
      }
      // sets expanded into earlier lines of this thread (this slice), and sets expanded for this line; the latter join the former only
      // once this line's row is written (a line left without a row covers nothing)
      const earlier = this.expandedInto(m.thread);
      const seen = new Set<string>(state.expanded);
      while (state.chain.length) {
        const setId = state.chain[0]!;
        if ((seen.has(setId) || earlier?.has(setId)) && !state.after) { state.chain.shift(); continue; }
        if (!state.after && !stmt(this.db, "SELECT 1 AS x FROM memory_root_sets WHERE set_id=?").get(setId)) return this.unprovable(m, lsn); // incomplete set
        const members = state.after
          ? stmt(this.db, "SELECT root_thread_id AS t,root_message_id AS m FROM memory_root_set_members WHERE set_id=? AND (root_thread_id,root_message_id)>(?,?) ORDER BY root_thread_id,root_message_id LIMIT ?").all(setId, state.after[0], state.after[1], MEMBER_BATCH)
          : stmt(this.db, "SELECT root_thread_id AS t,root_message_id AS m FROM memory_root_set_members WHERE set_id=? ORDER BY root_thread_id,root_message_id LIMIT ?").all(setId, MEMBER_BATCH);
        state.n = (state.n ?? 0) + members.length;
        this.worked += members.length;
        for (const member of members) {
          const thread = String(member.t), id = String(member.m);
          const at = this.lsnOfMessage(thread, id);
          if (at === undefined) return this.unprovable(m, lsn); // a root that is gone: unprovable
          if (thread === m.thread && at < lsn) { if (!this.rowFold(thread, at)) lost = true; continue; } // positional (a root left without a row: unprovable)
          // carried into an earlier line of this thread already: positional order covers this line too
          if (stmt(this.db, "SELECT 1 AS x FROM memory_lineage_carry c WHERE c.parent_thread_no=? AND c.to_lsn=? AND c.from_lsn=? AND c.child_kind=0 AND c.child_thread_no=? AND CAST(c.child_ref AS INTEGER)<? AND EXISTS(SELECT 1 FROM memory_line_lineage l WHERE l.thread_no=c.child_thread_no AND l.lsn=CAST(c.child_ref AS INTEGER)) LIMIT 1").get(this.no(thread), at, at, this.no(m.thread), lsn)) continue;
          if (!carry(thread, at)) return "parent-missing";
        }
        if (members.length === MEMBER_BATCH) {
          const last = members[members.length - 1]!;
          state.after = [String(last.t), String(last.m)];
        } else {
          state.after = null; seen.add(setId); state.expanded = [...seen].slice(-64);
          expandedHere = seen;
          state.chain.shift();
          const parent = stmt(this.db, "SELECT parent_id AS p FROM memory_root_set_parents WHERE set_id=?").get(setId);
          if (parent) state.chain.push(String(parent.p));
        }
        // the carries found so far are written now (a carry without its child's row is inert: the child reads "checking")
        if (state.chain.length && global && this.over()) {
          this.writeCarries(m, lsn, carries);
          return { ...state, mem: fold.mem, scopes: fold.scopes === null || fold.scopes === "star" ? fold.scopes : [...fold.scopes], ...(lost ? { lost } : {}) };
        }
      }
    }
    if (lost) return this.unprovable(m, lsn); // unprovable: no row (the carries written so far are inert without their child's row)
    if (expandedHere.size) {
      const into = this.expandedInto(m.thread) ?? new Set<string>();
      for (const id of expandedHere) into.add(id);
      this.expanded.set(m.thread, into);
    }
    // folds: receipts on this line, the thread's running value, every carried parent's
    const receiptScopes = new Set<string>();
    if (generated) {
      for (const receipt of stmt(this.db, "SELECT d.bundle_id AS b,d.driver_instance AS di,d.native_session AS ns,d.policy_revision AS p,d.deletion_epoch AS e,d.record_versions AS rv,d.source_versions AS sv FROM memory_disclosure_outputs o JOIN memory_disclosures d ON d.bundle_id=o.bundle_id WHERE o.thread_id=? AND o.message_id=?").all(m.thread, m.id)) {
        // the receipt's range starts at its earliest output (receipt-outputs.ts); U1 walks lines in order, so the first one seen is it
        noteReceiptOutput(this.db, String(receipt.b), m.thread, lsn, { driverInstance: String(receipt.di), nativeSession: receipt.ns === null ? null : String(receipt.ns) });
        const stale = Number(receipt.p) !== this.policy || Number(receipt.e) !== this.epoch;
        fold = mergeFold(fold, { mem: stale ? STALE_MEM_LSN : 0, scopes: null });
        for (const scope of stmt(this.db, "SELECT DISTINCT r.scope_id AS s FROM json_each(?) j JOIN memory_records r ON r.id=j.value->>'id' AND r.version=j.value->>'version'").all(String(receipt.rv))) receiptScopes.add(String(scope.s));
        for (const scope of stmt(this.db, "SELECT DISTINCT s.scope_id AS s FROM json_each(?) j JOIN memory_sources s ON s.id=j.value->>'id'").all(String(receipt.sv))) receiptScopes.add(String(scope.s));
      }
    }
    if (receiptScopes.size) fold = mergeFold(fold, { mem: null, scopes: receiptScopes });
    let turnLsn: number | null = null;
    if (generated) {
      const first = typeof parsed.turnId === "string" ? stmt(this.db, "SELECT first_rowid AS r FROM turn_first WHERE thread_id=? AND turn_id=?").get(m.thread, parsed.turnId) : undefined;
      const firstRowid = first ? Number(first.r) : NaN;
      turnLsn = Number.isFinite(firstRowid) && firstRowid <= m.rowid && firstRowid >= this.c.low ? this.lsnOf(firstRowid) : lsn;
    }
    const footprint = fold.scopes === null ? null : fold.scopes === "star" ? FOOTPRINT_STAR : internFootprint(this.db, [...fold.scopes].sort());
    this.writeCarries(m, lsn, carries);
    for (const scope of receiptScopes) stmt(this.db, "INSERT INTO memory_thread_flow(from_thread,to_thread,first_lsn) VALUES(?,?,?) ON CONFLICT(from_thread,to_thread) DO UPDATE SET first_lsn=min(first_lsn,excluded.first_lsn)").run(`scope:${scope}`, m.thread, lsn);
    for (const source of stmt(this.db, "SELECT id,scope_id FROM memory_sources WHERE thread_id=? AND message_id=?").all(m.thread, m.id)) {
      stmt(this.db, "INSERT OR IGNORE INTO memory_line_capture(thread_no,lsn,source_id) VALUES(?,?,?)").run(this.no(m.thread), lsn, String(source.id));
      // the capture is flow from the thread into the source's scope, from this line on (the live writer's edge: schema.ts memory_flow_capture)
      stmt(this.db, FLOW_MIN).run(m.thread, `scope:${String(source.scope_id)}`, lsn);
    }
    stmt(this.db, "INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,?,?)").run(this.no(m.thread), lsn, m.id, turnLsn, fold.mem, footprint);
    return null;
  }
  private writeCarries(m: Message, lsn: number, carries: Array<{ thread: string; lsn: number }>): void {
    for (const parent of carries) {
      stmt(this.db, "INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,0,?,?)").run(this.no(parent.thread), parent.lsn, parent.lsn, lineChildRef(lsn), this.no(m.thread));
      if (parent.thread !== m.thread) stmt(this.db, "INSERT INTO memory_thread_flow(from_thread,to_thread,first_lsn) VALUES(?,?,?) ON CONFLICT(from_thread,to_thread) DO UPDATE SET first_lsn=min(first_lsn,excluded.first_lsn)").run(parent.thread, m.thread, lsn);
    }
    carries.length = 0;
  }

  // ---- U1s: retained sessions ----
  sessions(): boolean {
    if (this.c.top === 0) return true;
    for (;;) {
      const after = this.c.session ?? ["", "", ""];
      const rows = stmt(this.db, "SELECT thread_id AS t,driver_instance AS d,native_session AS n,set_id AS s FROM memory_session_roots WHERE (thread_id,driver_instance,native_session)>(?,?,?) ORDER BY thread_id,driver_instance,native_session LIMIT ?").all(after[0], after[1], after[2], 16);
      if (!rows.length) return true;
      for (const row of rows) {
        const thread = String(row.t), d = String(row.d), n = String(row.n), setId = String(row.s);
        this.session(thread, d, n, setId);
        this.worked++;
        this.c.session = [thread, d, n];
        if (this.c.sessions) this.c.sessions = [this.c.sessions[0], Math.min(this.c.sessions[0], this.c.sessions[1] + 1)];
        if (this.over()) throw new SliceOver();
      }
    }
  }
  /** A session with an unprovable or unreadable set gets no row: it resets (sessionLookup reads "checking"). A large set is read in one
   * slice (sessions are few; the slice runs over its budget rather than leave a session half carried). */
  private session(thread: string, d: string, n: string, setId: string): void {
    if (stmt(this.db, "SELECT 1 AS x FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?").get(thread, d, n)) return;
    if (setId && !this.provable(setId)) return; // a set the RC could not prove: no row, the session resets
    const carries: Array<{ thread: string; lsn: number }> = [];
    const chain = setId ? [setId] : [];
    const seen = new Set<string>();
    while (chain.length) {
      const id = chain.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!stmt(this.db, "SELECT 1 AS x FROM memory_root_sets WHERE set_id=?").get(id)) return;
      let after: [string, string] | null = null;
      for (;;) {
        const members: Array<Record<string, unknown>> = after
          ? stmt(this.db, "SELECT root_thread_id AS t,root_message_id AS m FROM memory_root_set_members WHERE set_id=? AND (root_thread_id,root_message_id)>(?,?) ORDER BY root_thread_id,root_message_id LIMIT ?").all(id, after[0], after[1], MEMBER_BATCH)
          : stmt(this.db, "SELECT root_thread_id AS t,root_message_id AS m FROM memory_root_set_members WHERE set_id=? ORDER BY root_thread_id,root_message_id LIMIT ?").all(id, MEMBER_BATCH);
        for (const member of members) {
          const at = this.lsnOfMessage(String(member.t), String(member.m));
          if (at === undefined) return;
          if (String(member.t) !== thread || at > OLD_SESSION_LAST_LSN) carries.push({ thread: String(member.t), lsn: at });
        }
        if (members.length < MEMBER_BATCH) break;
        after = [String(members[members.length - 1]!.t), String(members[members.length - 1]!.m)];
      }
      const parent = stmt(this.db, "SELECT parent_id AS p FROM memory_root_set_parents WHERE set_id=?").get(id);
      if (parent) chain.push(String(parent.p));
    }
    const ref = sessionChildRef(d, n);
    for (const parent of carries) {
      stmt(this.db, "INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,2,?,?)").run(this.no(parent.thread), parent.lsn, parent.lsn, ref, this.no(thread));
      if (parent.thread !== thread) stmt(this.db, "INSERT INTO memory_thread_flow(from_thread,to_thread,first_lsn) VALUES(?,?,?) ON CONFLICT(from_thread,to_thread) DO UPDATE SET first_lsn=min(first_lsn,excluded.first_lsn)").run(parent.thread, thread, OLD_SESSION_LAST_LSN);
    }
    stmt(this.db, "INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES(?,?,?,?,?)").run(thread, d, n, this.lsnOf(this.c.low), OLD_SESSION_LAST_LSN);
  }

  // ---- U1m: the memory flow edges of the history (scope -> scope), which the v10 triggers write for every new row ----
  /** Records resting on a source of another scope (memory_evidence), records derived from one of another scope (memory_derivations), and
   * sources brought in from another scope (memory_source_versions broughtFrom): one edge per scope pair, at OLD_EDGE_LSN. Keyset pages over
   * each table's primary key. True when every step is done. */
  memoryEdges(): boolean {
    const steps: Array<(after: string) => { rows: number; last: string }> = [
      after => this.edgePage("SELECT e.record_id AS k1,e.record_version AS k2,e.source_id AS k3,e.source_revision AS k4,e.start_byte AS k5,so.scope_id AS a,re.scope_id AS z FROM memory_evidence e LEFT JOIN memory_sources so ON so.id=e.source_id LEFT JOIN memory_records re ON re.id=e.record_id AND re.version=e.record_version WHERE (e.record_id,e.record_version,e.source_id,e.source_revision,e.start_byte)>(?,?,?,?,?) ORDER BY e.record_id,e.record_version,e.source_id,e.source_revision,e.start_byte LIMIT ?", after, ["", -1, "", -1, -1]),
      after => this.edgePage("SELECT d.parent_id AS k1,d.parent_version AS k2,d.child_id AS k3,d.child_version AS k4,p.scope_id AS a,c.scope_id AS z FROM memory_derivations d LEFT JOIN memory_records p ON p.id=d.parent_id AND p.version=d.parent_version LEFT JOIN memory_records c ON c.id=d.child_id AND c.version=d.child_version WHERE (d.parent_id,d.parent_version,d.child_id,d.child_version)>(?,?,?,?) ORDER BY d.parent_id,d.parent_version,d.child_id,d.child_version LIMIT ?", after, ["", -1, "", -1]),
      after => this.broughtPage(after),
    ];
    for (;;) {
      const [step, after] = this.c.edges ?? [0, ""];
      if (step >= steps.length) return true;
      const page = steps[step]!(after);
      this.worked += page.rows;
      this.c.edges = page.rows < EDGE_BATCH ? [step + 1, ""] : [step, page.last];
      this.c.edgeRows = page.rows < EDGE_BATCH ? 0 : (this.c.edgeRows ?? 0) + page.rows;
      if (this.over()) throw new SliceOver();
    }
  }
  /** One page of a two-scope join over a primary key (columns k1..kN, starting after `first`): an edge per row whose two scopes differ. A row
   * whose source or record is gone has no scope to flow from or to, and is passed over (its record reads by its own facts). */
  private edgePage(sql: string, after: string, first: ReadonlyArray<string | number>): { rows: number; last: string } {
    const key = after ? JSON.parse(after) as Array<string | number> : [...first];
    const rows = stmt(this.db, sql).all(...key, EDGE_BATCH) as Array<Record<string, unknown>>;
    for (const row of rows) if (row.a !== null && row.z !== null && row.a !== row.z) stmt(this.db, FLOW_MIN).run(`scope:${String(row.a)}`, `scope:${String(row.z)}`, OLD_EDGE_LSN);
    const last = rows.at(-1);
    return { rows: rows.length, last: last ? JSON.stringify(first.map((_, k) => last[`k${k + 1}`] as string | number)) : after };
  }
  private broughtPage(after: string): { rows: number; last: string } {
    const [id, revision] = after ? JSON.parse(after) as [string, number] : ["", -1];
    const rows = stmt(this.db, "SELECT v.source_id AS s,v.revision AS r,n.scope_id AS z,json_extract(v.payload,'$.broughtFrom.sources') AS b FROM memory_source_versions v LEFT JOIN memory_sources n ON n.id=v.source_id WHERE (v.source_id,v.revision)>(?,?) ORDER BY v.source_id,v.revision LIMIT ?").all(id, revision, EDGE_BATCH) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row.b !== "string" || row.z === null) continue;
      let origins: unknown;
      try { origins = JSON.parse(row.b); } catch { continue; }
      if (!Array.isArray(origins)) continue;
      for (const origin of origins.slice(0, COPY_ORIGINS)) {
        const originId = origin && typeof origin === "object" ? (origin as { id?: unknown }).id : undefined;
        if (typeof originId !== "string") continue;
        const scope = stmt(this.db, "SELECT scope_id AS a FROM memory_sources WHERE id=?").get(originId)?.a;
        if (typeof scope === "string" && scope !== row.z) stmt(this.db, FLOW_MIN).run(`scope:${scope}`, `scope:${String(row.z)}`, OLD_EDGE_LSN);
      }
    }
    const last = rows.at(-1);
    return { rows: rows.length, last: last ? JSON.stringify([String(last.s), Number(last.r)]) : after };
  }

  // ---- U1f: lines written while U1 ran fold their thread's old tail ----
  fixLive(): boolean {
    for (;;) {
      const at = this.c.fix ?? [0, Number.MAX_SAFE_INTEGER];
      let thread = Number(at[0]), from = at[1];
      if (from === Number.MAX_SAFE_INTEGER) {
        const next = stmt(this.db, "SELECT no AS t FROM memory_thread_no WHERE no>? ORDER BY no LIMIT 1").get(thread);
        if (!next) return true;
        thread = Number(next.t); from = 0;
      }
      const tail = this.prevFold(thread, 1);
      const rows = tail.mem === null && tail.scopes === null ? [] : stmt(this.db, "SELECT lsn,mem_lsn AS m,footprint AS f FROM memory_line_lineage WHERE thread_no=? AND lsn>? ORDER BY lsn LIMIT ?").all(thread, from, FIX_BATCH);
      for (const row of rows) {
        const own: Fold = { mem: row.m === null ? null : Number(row.m), scopes: this.scopesOf(row.f) };
        const merged = mergeFold(own, tail);
        const footprint = merged.scopes === null ? null : merged.scopes === "star" ? FOOTPRINT_STAR : internFootprint(this.db, [...merged.scopes].sort());
        stmt(this.db, "UPDATE memory_line_lineage SET mem_lsn=?,footprint=? WHERE thread_no=? AND lsn=?").run(merged.mem, footprint, thread, Number(row.lsn));
        from = Number(row.lsn);
      }
      this.c.fix = rows.length === FIX_BATCH ? [thread, from] : [thread, Number.MAX_SAFE_INTEGER];
      this.worked += Math.max(1, rows.length);
      this.c.fixRows = rows.length === FIX_BATCH ? (this.c.fixRows ?? 0) + rows.length : 0;
      if (this.over()) throw new SliceOver();
    }
  }

  // ---- U2: every existing deny fact becomes a revoke root ----
  seed(): boolean {
    const steps: Array<() => boolean> = [() => this.seedTombstones(), () => this.seedSources(), () => this.seedHidden(), () => this.seedDeny(), () => this.seedReceipts(), () => this.seedUnprovable()];
    for (;;) {
      const [step] = this.c.seed ?? [0, ""];
      if (step >= steps.length) return true;
      this.countSeedStep(step);
      if (steps[step]!()) this.c.seed = [step + 1, ""];
      if (this.over()) throw new SliceOver();
    }
  }
  /** Every deny fact goes into one of two bulk revokes (revoke-commit.ts openBulkRevoke): a receipt only revoked by state into the
   * audience-only one, everything else into the other. */
  private commit(root: RevokeRoot, until?: number): void {
    if (seedCommit) { if (!(seedCommit(this.db, root) > 0)) throw new SeedBlocked(); return; }
    const audience = root.kind === "receipt" && root.cause === "receipt-revoked";
    const bulk = this.c.bulk ?? [0, 0];
    if (!bulk[audience ? 1 : 0]) bulk[audience ? 1 : 0] = openBulkRevoke(this.db, "upgrade-seed", audience);
    this.c.bulk = bulk;
    if (!(commitRevoke(this.db, root, { inline: false, into: bulk[audience ? 1 : 0], ...(until === undefined ? {} : { until }) }) > 0)) throw new SeedBlocked();
  }
  /** The proven bound of a forget made BEFORE the upgrade (`until` of its range): the turn lsn at which a generated line of the thread, written
   * after the forgotten one, can no longer have been put together before the forget. 1 + the newest turn lsn among the lines that may have been:
   *   - a line written before the forget (its time is earlier than the tombstone's), or
   *   - a line of a turn that began before it. A turn began no earlier than the time of what it was put together from: its first row's own
   *     time when that is the owner's line (the owner's words exist before the engine is prompted with them), else its first row's parent's
   *     time. A turn whose beginning cannot be read counts as begun before the forget (fail closed).
   * A turn whose first row is later than the forget, and whose beginning is later too, is not covered: it was built without the line. Undefined
   * (no bound: the range runs to the upgrade, as before) when the line has no row, the forget has no time, or more than FORGET_SCAN_LINES lines
   * follow it (the pass would not fit a slice). Only the owner's own forgets have a time that means "the forget happened at this moment" (the
   * reasons the RC's positional rule used). */
  private forgetBound(threadId: string, messageId: string, forgetAt: number): number | undefined {
    if (!Number.isFinite(forgetAt)) return undefined;
    const no = threadNo(this.db, threadId);
    if (no === null) return undefined;
    const line = stmt(this.db, "SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(no, messageId);
    if (!line) return undefined;
    const from = Number(line.lsn);
    const firstRow = stmt(this.db, "SELECT m.role AS role,m.at AS at,json_extract(m.json,'$.parentId') AS parent FROM memory_line_lineage l JOIN messages m ON m.thread_id=?1 AND m.id=l.message_id WHERE l.thread_no=?2 AND l.lsn=?3");
    const parentAt = stmt(this.db, "SELECT at FROM messages WHERE thread_id=? AND id=?");
    const began = new Map<number, boolean>();
    const turnBeganBefore = (turnLsn: number): boolean => {
      const kept = began.get(turnLsn);
      if (kept !== undefined) return kept;
      const first = firstRow.get(threadId, no, turnLsn);
      let bound: number | null = null;
      if (first) {
        if (first.role === "user") bound = Number(first.at);
        else if (typeof first.parent === "string") { const parent = parentAt.get(threadId, first.parent); if (parent) bound = Number(parent.at); }
      }
      const before = bound === null || !Number.isFinite(bound) || bound < forgetAt;
      began.set(turnLsn, before);
      return before;
    };
    const page = stmt(this.db, "SELECT l.lsn AS lsn,l.turn_lsn AS tl,m.at AS at FROM memory_line_lineage l JOIN messages m ON m.thread_id=?1 AND m.id=l.message_id WHERE l.thread_no=?2 AND l.lsn>?3 AND l.turn_lsn IS NOT NULL ORDER BY l.lsn LIMIT 512");
    let newest = Number.NEGATIVE_INFINITY, after = from, scanned = 0;
    for (;;) {
      const rows = page.all(threadId, no, after);
      for (const row of rows) {
        after = Number(row.lsn);
        const turn = Number(row.tl);
        if (turn > newest && (!(Number(row.at) >= forgetAt) || turnBeganBefore(turn))) newest = turn;
      }
      scanned += rows.length;
      if (rows.length < 512) break;
      if (scanned >= FORGET_SCAN_LINES) return undefined;
    }
    return newest === Number.NEGATIVE_INFINITY ? from : newest + 1;
  }
  /** U2 drained: its bulk revokes are walked from now on. */
  activateSeeds(): void { for (const R of this.c.bulk ?? []) if (R > 0) activateBulkRevoke(this.db, R); }
  private key(): string { return this.c.seed?.[1] ?? ""; }
  private advance(key: string): void {
    this.worked++;
    this.c.seed = [this.c.seed?.[0] ?? 0, key];
    if (this.c.seedCount) this.c.seedCount = [this.c.seedCount[0], this.c.seedCount[1], this.c.seedCount[2] + 1];
    const step = this.c.seed[0];
    this.c.seedRows = [step, (this.c.seedRows?.[0] === step ? this.c.seedRows[1] : 0) + 1];
  }
  /** The rows of a seed step, counted once when the step begins (and the rows a cursor from an earlier build already finished), for the strip. */
  private countSeedStep(step: number): void {
    if (this.c.seedCount?.[0] === step) return;
    const table = ({ 0: ["memory_tombstones", "id"], 1: ["memory_sources", "id"], 3: ["memory_deny", ""], 4: ["memory_disclosures", "bundle_id"] } as Record<number, [string, string]>)[step];
    let total = 0, finished = 0;
    if (table) {
      try {
        total = Number(stmt(this.db, `SELECT count(*) AS n FROM ${table[0]}`).get()?.n ?? 0);
        if (table[1] && this.key()) finished = Number(stmt(this.db, `SELECT count(*) AS n FROM ${table[0]} WHERE ${table[1]}<=?`).get(this.key())?.n ?? 0);
      } catch { /* a missing table reads as a step with nothing to count */ }
    }
    this.c.seedCount = [step, total, Math.min(total, finished)];
  }
  private seedTombstones(): boolean {
    const rows = stmt(this.db, "SELECT id,target_type AS ty,target_id AS ti,revision AS rv,reason AS why,created_at AS at FROM memory_tombstones WHERE id>? ORDER BY id LIMIT ?").all(this.key(), SEED_BATCH);
    for (const row of rows) {
      const type = String(row.ty), target = String(row.ti);
      if (type === "source") {
        const source = stmt(this.db, "SELECT thread_id AS t,message_id AS m FROM memory_sources WHERE id=?").get(target);
        if (source && typeof source.t === "string" && typeof source.m === "string") {
          // the owner's own forget has a time that means "at this moment": the range ends at what a turn begun after it could not hold
          const owned = row.why === "owner-forget" || row.why === "forgotten-supporting-source";
          const until = owned && typeof row.at === "number" ? this.forgetBound(source.t, source.m, row.at) : undefined;
          this.commit({ kind: "line", threadId: source.t, messageIds: [source.m], cause: "forget" }, until);
        }
        this.commit({ kind: "memory", ref: { kind: "source", id: target }, cause: "forget" });
      } else if (type === "record") this.commit({ kind: "memory", ref: { kind: "record", id: target, ...(row.rv === null ? {} : { version: Number(row.rv) }) }, cause: "forget" });
      this.advance(String(row.id));
      if (this.over()) throw new SliceOver();
    }
    return rows.length < SEED_BATCH;
  }
  private seedSources(): boolean {
    const rows = stmt(this.db, "SELECT id,state FROM memory_sources WHERE id>? ORDER BY id LIMIT ?").all(this.key(), SEED_BATCH);
    for (const row of rows) {
      const state = String(row.state);
      if (state === "deleted" || state === "retired") this.commit({ kind: "memory", ref: { kind: "source", id: String(row.id) }, cause: state === "deleted" ? "delete" : "retire" });
      this.advance(String(row.id));
      if (this.over()) throw new SliceOver();
    }
    return rows.length < SEED_BATCH;
  }
  private seedHidden(): boolean {
    if (this.c.top === 0) return true;
    const from = Number(this.key() || this.c.low - 1);
    const rows = stmt(this.db, "SELECT rowid AS r,thread_id AS t,id,json_extract(json,'$.withheldFromBots') AS w FROM messages WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?").all(from, this.c.top, SEED_BATCH);
    for (const row of rows) {
      const flag = row.w;
      // "checking" was a transient hold (nothing withdrawn); true and "forgotten" are the owner's or the judge's withdrawal
      if (flag !== null && flag !== undefined && flag !== 0 && flag !== "checking") this.commit({ kind: "line", threadId: String(row.t), messageIds: [String(row.id)], cause: flag === "forgotten" ? "forget" : "hide" });
      this.advance(String(row.r));
      if (this.over()) throw new SliceOver();
    }
    return rows.length < SEED_BATCH;
  }
  private seedDeny(): boolean {
    const [kind, id] = this.key() ? JSON.parse(this.key()) as [string, string] : ["", ""];
    const rows = stmt(this.db, "SELECT kind,id FROM memory_deny WHERE (kind,id)>(?,?) ORDER BY kind,id LIMIT ?").all(kind, id, SEED_BATCH);
    for (const row of rows) {
      if (row.kind === "thread") this.commit({ kind: "thread", threadId: String(row.id), cause: "delete-conversation" });
      else this.commit({ kind: "scope", scopeId: String(row.id), cause: "scope-deny" });
      this.advance(JSON.stringify([String(row.kind), String(row.id)]));
      if (this.over()) throw new SliceOver();
    }
    return rows.length < SEED_BATCH;
  }
  /** Every receipt the RC judge held bad on content becomes a receipt root: revoked, or citing a record version that is gone, not active (a
   * superseded rolling checkpoint of its own thread excepted) or tombstoned, or a source that is gone, not active, at another revision or
   * tombstoned (replay-lineage.ts contentRevoked, frozen in testing/legacy-lineage). Stale receipts need no root: the watermark covers them. */
  private seedReceipts(): boolean {
    const rows = stmt(this.db, "SELECT bundle_id AS b,thread_id AS t,state,record_versions AS rv,source_versions AS sv FROM memory_disclosures WHERE bundle_id>? ORDER BY bundle_id LIMIT ?").all(this.key(), SEED_BATCH);
    for (const row of rows) {
      // what it cites is gone: every reader; only its state revoked: audience readers (lineage-types.ts RevokeRoot)
      if (this.receiptContentBad(String(row.t), String(row.rv), String(row.sv))) this.commit({ kind: "receipt", bundleId: String(row.b), cause: "receipt-content" });
      else if (row.state === "revoked") this.commit({ kind: "receipt", bundleId: String(row.b), cause: "receipt-revoked" });
      this.advance(String(row.b));
      if (this.over()) throw new SliceOver();
    }
    return rows.length < SEED_BATCH;
  }
  /** Sources captured from lines U1 could not prove (captures parked at FIRST_LSN), thread by thread: each an `unprovable` memory root. */
  private seedUnprovable(): boolean {
    const [fromNo, fromSource] = this.key() ? JSON.parse(this.key()) as [number, string] : [0, ""];
    const rows = stmt(this.db, "SELECT c.thread_no AS t,c.source_id AS s FROM memory_thread_no n JOIN memory_line_capture c ON c.thread_no=n.no AND c.lsn=? WHERE (n.no,c.source_id)>(?,?) ORDER BY n.no,c.source_id LIMIT ?").all(FIRST_LSN, fromNo, fromSource, SEED_BATCH);
    for (const row of rows) {
      this.commit({ kind: "memory", ref: { kind: "source", id: String(row.s) }, cause: "unprovable" });
      this.advance(JSON.stringify([Number(row.t), String(row.s)]));
      if (this.over()) throw new SliceOver();
    }
    return rows.length < SEED_BATCH;
  }
  /** Verdicts of cited objects, kept from slice to slice on this connection (citedMemo): a session's receipts cite the same frame again and again. */
  private get cited(): Map<string, boolean> { return this.citedVerdicts; }
  /** What the frozen judge also asks of a cited record (replay-lineage.ts refBad): every record it was derived from still holds (active, or
   * history of a correction or an earlier version; none tombstoned), and every source the record and its ancestors cite is still active at
   * the revision they cited (Astra audit P1 2). A chain or evidence list too long to judge does not stand (the judge threw: unproven). */
  private recordRestsOnBad(id: string, version: number): boolean {
    const parents = stmt(this.db, `WITH RECURSIVE parents(id,version) AS (
        SELECT ?,? UNION SELECT d.parent_id,d.parent_version FROM memory_derivations d
        JOIN parents p ON d.child_id=p.id AND d.child_version=p.version
        LEFT JOIN memory_records child ON child.id=d.child_id AND child.version=d.child_version
        WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=d.parent_id) LIMIT 1025)
        SELECT id,version FROM parents`).all(id, version);
    if (parents.length > 1024) return true;
    const edges = stmt(this.db, `WITH RECURSIVE edges(parent_id,parent_version,child_id,child_version) AS (
        SELECT parent_id,parent_version,child_id,child_version FROM memory_derivations WHERE child_id=? AND child_version=?
        UNION SELECT d.parent_id,d.parent_version,d.child_id,d.child_version FROM memory_derivations d
        JOIN edges e ON d.child_id=e.parent_id AND d.child_version=e.parent_version
        LEFT JOIN memory_records child ON child.id=e.child_id AND child.version=e.child_version
        WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=e.parent_id) LIMIT 1025)
        SELECT e.parent_id,e.parent_version,e.child_id,p.state,c.supersedes_id FROM edges e
        LEFT JOIN memory_records p ON p.id=e.parent_id AND p.version=e.parent_version
        LEFT JOIN memory_records c ON c.id=e.child_id AND c.version=e.child_version`).all(id, version);
    if (edges.length > 1024) return true;
    const replacing = new Set(edges.map(edge => String(edge.supersedes_id ?? "")));
    const self = stmt(this.db, "SELECT supersedes_id FROM memory_records WHERE id=? AND version=?").get(id, version);
    if (self?.supersedes_id) replacing.add(String(self.supersedes_id));
    for (const edge of edges) {
      const history = replacing.has(String(edge.parent_id)) && (edge.state === "superseded" || edge.state === "archived");
      if (!edge.state || (edge.state !== "active" && !history)) return true;
      if (stmt(this.db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(edge.parent_id, edge.parent_version)) return true;
    }
    for (const parent of parents) {
      const evidence = stmt(this.db, "SELECT e.source_revision,s.revision,s.state FROM memory_evidence e LEFT JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? LIMIT 1025").all(parent.id, parent.version);
      if (evidence.length > 1024) return true;
      for (const source of evidence) if (source.state !== "active" || source.revision !== source.source_revision) return true;
    }
    return false;
  }
  private receiptContentBad(threadId: string, recordsJson: string, sourcesJson: string): boolean {
    let records: Array<{ id?: unknown; version?: unknown }> = [], sources: Array<{ id?: unknown; revision?: unknown }> = [];
    try { records = JSON.parse(recordsJson) ?? []; sources = JSON.parse(sourcesJson) ?? []; } catch { return true; }
    if (!Array.isArray(records) || !Array.isArray(sources)) return true;
    for (const record of records) {
      const id = String(record?.id), version = Number(record?.version);
      const key = `r\u0000${threadId}\u0000${id}\u0000${version}`;
      let bad = this.cited.get(key);
      if (bad === undefined) {
        const row = stmt(this.db, "SELECT scope_id AS s,kind,state,owner_pinned AS p FROM memory_records WHERE id=? AND version=?").get(id, version);
        bad = !row || (row.state !== "active" && !(row.kind === "checkpoint" && row.state === "archived" && Number(row.p) !== 1 && id === threadCheckpointId(String(row.s), threadId)
          && Boolean(stmt(this.db, "SELECT 1 AS x FROM memory_records WHERE id=? AND version>? AND state='active' ORDER BY version DESC LIMIT 1").get(id, version))))
          || Boolean(stmt(this.db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(id, version))
          || this.recordRestsOnBad(id, version);
        this.cited.set(key, bad);
      }
      if (bad) return true;
    }
    for (const source of sources) {
      const id = String(source?.id), revision = Number(source?.revision);
      const key = `s\u0000${id}\u0000${revision}`;
      let bad = this.cited.get(key);
      if (bad === undefined) {
        const row = stmt(this.db, "SELECT state,revision FROM memory_sources WHERE id=?").get(id);
        bad = !row || row.state !== "active" || Number(row.revision) !== revision
          || Boolean(stmt(this.db, "SELECT 1 AS x FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(id, revision));
        this.cited.set(key, bad);
      }
      if (bad) return true;
    }
    return false;
  }
}

function mergeFold(a: Fold, b: Fold): Fold {
  const mem = a.mem === null ? b.mem : b.mem === null ? a.mem : Math.min(a.mem, b.mem);
  let scopes: Fold["scopes"];
  if (a.scopes === "star" || b.scopes === "star") scopes = "star";
  else if (a.scopes === null) scopes = b.scopes;
  else if (b.scopes === null) scopes = a.scopes;
  else scopes = new Set([...a.scopes, ...b.scopes]);
  return { mem, scopes };
}

// ---- The marking half of the v10 -> v9 downgrade (schema.ts downgradeMemorySchema runs it before the tables drop) ----
//
// 1.0.1 and the RC read memory_output_roots: a generated line 1.0.2 wrote (lsn >= lineage_upgrade_lsn) has no root set, so each gets
// set_id '' (unprovable: the older build withholds it). Every line a deny mark covers (deny_line, deny_range) gets withheldFromBots, and every
// session a deny_session row covers gets the unprovable set. The pass is sliced (each slice its own transaction, at most budgetMs), keeps its
// place in memory_lineage_cert (phase 'down'), and records memory_lsn.next and deny_generation when it starts: if either moved before the
// tables drop (1.0.2 ran in between), the marking starts again from the top, so nothing written after a slice is missed.

interface DownCursor { step: number; thread: string; lsn: number; key: string; hw: number; gen: number; prev: string }
const DOWN_STEPS = 5;
function writtenState(db: DatabaseSync): { hw: number; gen: number } {
  return { hw: Number(stmt(db, "SELECT next FROM memory_lsn WHERE id=1").get()?.next ?? 0), gen: Number(stmt(db, "SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'").get()?.value ?? 0) };
}

/** One slice of the downgrade marking. done = true when every mark is written and nothing moved since the pass began. */
export function lineageDowngradeSlice(db: DatabaseSync, options: { budgetMs?: number; now?: () => number; everyLine?: boolean } = {}): { done: boolean } {
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.budgetMs ?? BACKFILL_SLICE_MS);
  citedMemos.delete(db);
  rootSetMemos.delete(db); // the rows the memo's expansions rest on are being marked: a backfill after this reads the chains again
  beginBackground(db, "lineage-downgrade");
  try {
    const cert = stmt(db, "SELECT phase,cursor FROM memory_lineage_cert WHERE id=1").get();
    if (!cert) throw new Error("INVALID_MEMORY_LINEAGE_META");
    const state = writtenState(db);
    let c: DownCursor = String(cert.phase) === "down" ? JSON.parse(String(cert.cursor)) as DownCursor : { step: 0, thread: "", lsn: 0, key: "", ...state, prev: JSON.stringify([String(cert.phase), String(cert.cursor)]) };
    // 1.0.2 wrote since the pass began: everything again from the top
    if (c.hw !== state.hw || c.gen !== state.gen) c = { step: 0, thread: "", lsn: 0, key: "", ...state, prev: c.prev };
    const upgradeLsn = Number(stmt(db, "SELECT value FROM memory_lineage_lsn_meta WHERE key='lineage_upgrade_lsn'").get()?.value ?? 1);
    const over = () => now() >= deadline;
    const hide = (thread: string, id: string) => stmt(db, "UPDATE messages SET json=json_set(json,'$.withheldFromBots',json('true')) WHERE thread_id=? AND id=? AND role<>'user' AND (json_extract(json,'$.withheldFromBots') IS NULL OR json_extract(json,'$.withheldFromBots')='checking')").run(thread, id);
    outer: while (c.step < DOWN_STEPS) {
      if (c.step === 0) {
        // generated lines 1.0.2 wrote: the unprovable root set, thread by thread (a primary-key range per thread)
        for (;;) {
          // (c.thread holds the thread's interned number; its text id is read with it)
          if (c.lsn === Number.MAX_SAFE_INTEGER || c.thread === "") {
            const next = stmt(db, "SELECT no AS n FROM memory_thread_no WHERE no>? ORDER BY no LIMIT 1").get(Number(c.thread || 0));
            if (!next) { c = { ...c, step: 1, thread: "", lsn: 0, key: "" }; continue outer; }
            // (after the root sets were handed back, every generated line, old ones included: none can be proven by an older build)
            c.thread = String(next.n); c.lsn = options.everyLine ? Number.MIN_SAFE_INTEGER : upgradeLsn - 1;
          }
          const text = threadIdOf(db, Number(c.thread));
          const rows = stmt(db, "SELECT lsn,message_id AS m FROM memory_line_lineage WHERE thread_no=? AND lsn>? AND turn_lsn IS NOT NULL ORDER BY lsn LIMIT ?").all(Number(c.thread), c.lsn, FIX_BATCH);
          for (const row of rows) stmt(db, "INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,'') ON CONFLICT(thread_id,message_id) DO UPDATE SET set_id=''").run(text, String(row.m));
          c.lsn = rows.length === FIX_BATCH ? Number(rows[rows.length - 1]!.lsn) : Number.MAX_SAFE_INTEGER;
          if (over()) break outer;
        }
      }
      if (c.step === 1) {
        // deny_line: the named lines
        const [t, l, r] = c.key ? JSON.parse(c.key) as [string, number, number] : ["", -Number.MAX_SAFE_INTEGER, 0];
        const rows = stmt(db, "SELECT d.thread_id AS t,d.lsn AS l,d.revoke_id AS r,ll.message_id AS m FROM memory_deny_line d LEFT JOIN memory_thread_no tn ON tn.thread_id=d.thread_id LEFT JOIN memory_line_lineage ll ON ll.thread_no=tn.no AND ll.lsn=d.lsn WHERE (d.thread_id,d.lsn,d.revoke_id)>(?,?,?) ORDER BY d.thread_id,d.lsn,d.revoke_id LIMIT ?").all(t, l, r, FIX_BATCH);
        for (const row of rows) if (row.m !== null) hide(String(row.t), String(row.m));
        if (rows.length < FIX_BATCH) c = { ...c, step: 2, key: "", thread: "", lsn: 0 };
        else { const last = rows[rows.length - 1]!; c.key = JSON.stringify([String(last.t), Number(last.l), Number(last.r)]); }
        if (over()) break;
        continue;
      }
      if (c.step === 2) {
        // deny_range: every generated line after `from` whose turn began before `until`, range by range, lines by primary-key range
        const range = c.key ? JSON.parse(c.key) as [string, number, number, number, number] : null; // thread, from, revoke, until, at lsn
        const next = range
          ? { t: range[0], f: range[1], r: range[2], u: range[3], at: range[4] }
          : (() => { const row = stmt(db, "SELECT thread_id AS t,from_lsn AS f,revoke_id AS r,until_turn_lsn AS u FROM memory_deny_range ORDER BY thread_id,from_lsn,revoke_id LIMIT 1").get(); return row ? { t: String(row.t), f: Number(row.f), r: Number(row.r), u: Number(row.u), at: Number(row.f) } : null; })();
        if (!next) { c = { ...c, step: 3, key: "" }; continue; }
        const rangeNo = threadNo(db, next.t);
        const rows = rangeNo === null ? [] : stmt(db, "SELECT lsn,message_id AS m,turn_lsn AS tl FROM memory_line_lineage WHERE thread_no=? AND lsn>? AND turn_lsn IS NOT NULL ORDER BY lsn LIMIT ?").all(rangeNo, next.at, FIX_BATCH);
        for (const row of rows) if (row.tl === null || Number(row.tl) < next.u) hide(next.t, String(row.m));
        if (rows.length === FIX_BATCH) c.key = JSON.stringify([next.t, next.f, next.r, next.u, Number(rows[rows.length - 1]!.lsn)]);
        else {
          const after = stmt(db, "SELECT thread_id AS t,from_lsn AS f,revoke_id AS r,until_turn_lsn AS u FROM memory_deny_range WHERE (thread_id,from_lsn,revoke_id)>(?,?,?) ORDER BY thread_id,from_lsn,revoke_id LIMIT 1").get(next.t, next.f, next.r);
          if (after) c.key = JSON.stringify([String(after.t), Number(after.f), Number(after.r), Number(after.u), Number(after.f)]);
          else c = { ...c, step: 3, key: "" };
        }
        if (over()) break;
        continue;
      }
      if (c.step === 3) {
        // deny_session: the unprovable set, so the older build resets the session
        const [t, d, n, r] = c.key ? JSON.parse(c.key) as [string, string, string, number] : ["", "", "", 0];
        const rows = stmt(db, "SELECT thread_id AS t,driver_instance AS d,native_session AS n,revoke_id AS r FROM memory_deny_session WHERE (thread_id,driver_instance,native_session,revoke_id)>(?,?,?,?) ORDER BY thread_id,driver_instance,native_session,revoke_id LIMIT ?").all(t, d, n, r, FIX_BATCH);
        for (const row of rows) stmt(db, "INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,'') ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET set_id=''").run(String(row.t), String(row.d), String(row.n));
        if (rows.length < FIX_BATCH) c = { ...c, step: 4, key: "" };
        else { const last = rows[rows.length - 1]!; c.key = JSON.stringify([String(last.t), String(last.d), String(last.n), Number(last.r)]); }
        if (over()) break;
        continue;
      }
      if (c.step === 4) {
        // After the root sets were handed back, a generated message U1 left WITHOUT a lineage row (unprovable: a legacy reply whose set was '', a lost root)
        // lost its original denial with the sets, and the pass above only walks rows. The older build would read such a reply as rootless and readable, so
        // each one gets the unprovable set here (a message-table rowid window per slice, so the work is bounded however many rows have none).
        if (!options.everyLine) { c = { ...c, step: 5, key: "" }; continue; }
        const rows = stmt(db, "SELECT rowid AS r,thread_id AS t,id AS i FROM messages WHERE rowid>? AND role<>'user' ORDER BY rowid LIMIT ?").all(Number(c.key || 0), FIX_BATCH);
        for (const row of rows) {
          const rowed = stmt(db, "SELECT 1 AS x FROM memory_thread_no tn JOIN memory_line_lineage ll ON ll.thread_no=tn.no WHERE tn.thread_id=? AND ll.message_id=?").get(String(row.t), String(row.i));
          if (!rowed) stmt(db, "INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,'') ON CONFLICT(thread_id,message_id) DO UPDATE SET set_id=''").run(String(row.t), String(row.i));
        }
        if (rows.length < FIX_BATCH) c = { ...c, step: 5, key: "" };
        else c.key = String(Number(rows[rows.length - 1]!.r));
        if (over()) break;
      }
    }
    stmt(db, "UPDATE memory_lineage_cert SET phase='down',cursor=? WHERE id=1").run(JSON.stringify(c));
    db.exec("COMMIT");
    return { done: c.step >= DOWN_STEPS };
  } catch (error) {
    if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } }
    throw error;
  }
}

/** True when the downgrade marking finished and nothing was written since it began (checked inside the transaction that drops the tables). */
export function lineageDowngradeMarked(db: DatabaseSync): boolean {
  const cert = db.prepare("SELECT phase,cursor FROM memory_lineage_cert WHERE id=1").get();
  if (!cert || String(cert.phase) !== "down") return false;
  const c = JSON.parse(String(cert.cursor)) as DownCursor;
  const state = writtenState(db);
  return c.step >= DOWN_STEPS && c.hw === state.hw && c.gen === state.gen;
}
