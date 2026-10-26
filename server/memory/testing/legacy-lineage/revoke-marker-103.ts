// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VENDORED COPY of the released 1.0.3 marker (dev/release/1.0.3 ac86eea99), tests only: the downgrade tests of DELETION-DRAIN-V2 (F11)
// run this marker on a 1.0.4 file. Imports point at the live modules; its own module state (hooks, rotation) is separate from 1.0.4's.
// Write-time privacy, S3: the marker (DESIGN-WRITETIME 3, Opus section 4). One owner action commits a revoke (revoke-commit.ts): its
// direct marks, a memory_revoke_jobs row, its root nodes in memory_revoke_frontier and the pending window (memory_deny_pending('*'),
// memory_deny_pending_scope('*')). This module walks the rest in short resumable slices, run by memory-revocation.ts's runner:
//   flow   closure over memory_thread_flow (threads and `scope:` nodes) from the root's threads and scopes: one pending row per reached
//          thread or scope, since(X) = min over in-edges of max(edge.first_lsn, since(from)). Cost follows threads and flow rows.
//   mark   the exact walk. Per frontier node (memory_revoke_frontier, seq > 0, oldest first):
//            line(T, l)     deny_line, then range(T, l)
//            range(T, a)    once per thread per revoke (memory_revoke_reached): deny_range(T, a, now); out-carries with parent_lsn >= a
//                           (point carries only from generated lines or a itself), captures of generated lines (and a) as source
//                           nodes, the thread's sessions begun before the range's cap and used after a as deny_session
//            source(s)      deny_memory; its message line; records resting on it (memory_evidence_by_source); copies brought in from
//                           it (memory_source_origins); receipts citing it (memory_disclosure_refs)
//            record(r, v)   deny_memory (not for a soft root: archive, correct, revise only withdraw what was shown); the forgotten
//                           record's own supporting sources (forget root only, never a room's notes); derived records; citing receipts
//            receipt(b)     its session denied; its output lines (its own state stays the bookkeeping job's, revocation.ts)
//            session, scope deny_session; a denied scope's records
//   hold   waits while the forget's bookkeeping job still has a phase readers depend on (imports: copies admitted in the hash window)
//   tidy   the revoke's visited rows and pending rows go, a page at a time; deny_generation moves; the job is done
//   undo   (undoRevoke) every mark, pending row, frontier and visited row of the revoke goes by its `_revoke` index, a page at a time
// Every unknown stays withheld: a node that does not parse fails the slice (the job stays, its pending rows with it), and the pending
// window lasts until the last mark is written. Writes and slices are serialised by the single writer, so inheritance at write
// (revoke-commit.ts inheritMarks) and the walk never both miss an edge.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { currentLsn } from "../../lineage-write.ts";
import { threadIdOf, threadNo } from "../../thread-no.ts";
import { FLIP_DRAIN_MAX, receiptStart } from "../../receipt-outputs.ts";
import { AUDIENCE_COALESCED, CONSUMED_REF_KINDS, decodeCarryChild, decodeNode, DENY_RANGE_COALESCE, encodeNode, MARKER_SLICE_ROWS, objectCarryThread, PENDING_ALL_SCOPES, PENDING_ALL_THREADS, UNKNOWN_LSN, type FrontierNode, type MemoryRefKind } from "../../lineage-types.ts";

export { PENDING_ALL_SCOPES };
/** Whether every writer records its memory_thread_flow edges: S1's line, session and record writers (thread -> thread, scope -> thread,
 * thread -> scope), the v10 memory_flow_* triggers (capture, evidence, derivations, bring-in, a record or source moving scope) and U1 for
 * the history before the upgrade. index.ts sets it at start. With it, the flow closure reaches every thread and scope a revoke can taint, so
 * the flow phase ends the '*' pending rows at once; without it (or while the upgrade certificate is not ready: U1 has not written the old
 * edges yet) they stay until the revoke's last mark (fail closed: every generated line written since the root, and every memory object of
 * unknown or later creation, reads "checking" for that time). */
let scopeFlowEdgesRecorded = false;
export function setScopeFlowEdgesRecorded(value: boolean): void { scopeFlowEdgesRecorded = value; }

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
export function st(db: DatabaseSync, sql: string): StatementSync {
  let held = statements.get(db);
  if (!held) statements.set(db, held = new Map());
  let statement = held.get(sql);
  if (!statement) { statement = db.prepare(sql); if (held.size < 256) held.set(sql, statement); }
  return statement;
}
const writetime = new WeakMap<DatabaseSync, boolean>();
/** Whether this file holds the v10 write-time tables (a file below v10, an archive or an offline copy does not: nothing to mark). */
export function hasWritetime(db: DatabaseSync): boolean {
  const known = writetime.get(db);
  if (known) return true;
  const has = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_revoke_jobs'").get());
  if (has) writetime.set(db, true); // (only a positive answer is kept: a migration may add the tables later on this connection)
  return has;
}
const hasTable = (db: DatabaseSync, name: string) => Boolean(st(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const foldTable = new WeakMap<DatabaseSync, boolean>();
/** Whether this file holds the revoke fold's map (schema.ts REVOKE_LATE_SQL; only a positive answer is kept). */
export function hasFoldMap(db: DatabaseSync): boolean {
  if (foldTable.get(db)) return true;
  const has = hasTable(db, "memory_revoke_fold");
  if (has) foldTable.set(db, true);
  return has;
}
/** The revoke id that now carries `revokeId`'s work: the fold bulk it was folded into, or itself (1.0.3 revoke fold, F1.6). One seek; the map
 * is one hop (a fold bulk is never folded), so no chain is followed. Applied at every entry that takes a revoke id from a mark row or a
 * caller (inheritance, enqueueReceipts, holds). */
export function resolveRevoke(db: DatabaseSync, revokeId: number): number {
  if (!(revokeId > 0) || !hasFoldMap(db)) return revokeId;
  const to = st(db, "SELECT bulk_id FROM memory_revoke_fold WHERE old_id=?").get(revokeId)?.bulk_id;
  return to === undefined || to === null ? revokeId : Number(to);
}
/** Whether undoing `revokeId` is refused (1.0.3 REVOKE-FOLD-DESIGN F1.7, r4 A2): it was folded (a map row), it is a fold bulk (a map
 * destination, whatever its job row now is, or a root with cause "fold"), or it is listed in a seeding fold bulk's cohort and not yet
 * enrolled. Read before the job row, so a pruned or recreated fold bulk is refused too. */
export function foldRefusesUndo(db: DatabaseSync, revokeId: number): boolean {
  if (hasFoldMap(db) && st(db, "SELECT 1 AS x FROM memory_revoke_fold WHERE old_id=?1 OR bulk_id=?1 LIMIT 1").get(revokeId)) return true;
  const job = st(db, "SELECT root FROM memory_revoke_jobs WHERE revoke_id=?").get(revokeId);
  if (job && isFoldBulk(db, revokeId, String(job.root))) return true;
  return Boolean(st(db, `SELECT 1 AS x FROM memory_revoke_jobs j, json_each(CASE WHEN json_valid(j.root) THEN j.root ELSE '{}' END,'$.cohort.ids') e
    WHERE j.state='seeding' AND j.kind='bulk' AND e.value=? LIMIT 1`).get(revokeId));
}
/** Whether `revokeId` is a fold bulk: its root says so, or (after its job row was pruned and perhaps recreated by inheritance) it is the
 * destination of a fold map row (REVOKE-FOLD-DESIGN r4 A2). */
export function isFoldBulk(db: DatabaseSync, revokeId: number, root?: string): boolean {
  if (root !== undefined) { try { if (JSON.parse(root)?.cause === "fold") return true; } catch { /* unreadable root: the map decides */ } }
  return hasFoldMap(db) && Boolean(st(db, "SELECT 1 AS x FROM memory_revoke_fold WHERE bulk_id=? LIMIT 1").get(revokeId));
}

/** 'folded' (1.0.3 revoke fold, revoke-fold.ts): the job's work was copied into a fold bulk; no slice serves it, and the bulk's tidy
 * deletes its row. 'seeding': a bulk revoke whose roots are still being added (revoke-commit.ts openBulkRevoke). */
export type JobState = "active" | "undoing" | "done" | "undone" | "folded" | "seeding";
export type JobPhase = "flow" | "mark" | "hold" | "tidy" | "undo" | "done";
type JobRow = { revoke_id: number; kind: string; root: string; root_lsn: number; started_lsn: number; phase: JobPhase; cursor: string; state: JobState };
type Budget = { rows: number; deadline: number; over?: () => boolean };
const spend = (budget: Budget, n: number) => { budget.rows -= Math.max(1, n); };
const exhausted = (budget: Budget) => budget.rows <= 0 || performance.now() >= budget.deadline || Boolean(budget.over?.());
/** Rows this connection changed so far (inserts, updates and deletes, trigger writes included): the marker's write meter. */
export const totalChanges = (db: DatabaseSync): number => Number(st(db, "SELECT total_changes() AS n").get()?.n ?? 0);
/** Rows one step reads. A step that enqueues a node per row (several statements each) reads at most a quarter of MARKER_SLICE_ROWS, so
 * one step stays well inside a slice: the deadline is checked between steps. */
const page = (budget: Budget) => Math.max(1, Math.min(MARKER_SLICE_ROWS / 4, budget.rows));

export function bumpDenyGeneration(db: DatabaseSync): void {
  st(db, "UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
}
/** Next frontier seq of a revoke (exact nodes are positive, oldest first). */
function nextSeq(db: DatabaseSync, revokeId: number): number {
  const last = st(db, "SELECT seq FROM memory_revoke_frontier WHERE revoke_id=? ORDER BY seq DESC LIMIT 1").get(revokeId)?.seq;
  return Math.max(0, Number(last ?? 0)) + 1;
}
export function enqueueNode(db: DatabaseSync, revokeId: number, node: FrontierNode): void {
  st(db, "INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,?,?)").run(revokeId, nextSeq(db, revokeId), encodeNode(node));
}
function enqueueNodes(db: DatabaseSync, revokeId: number, nodes: readonly FrontierNode[]): void {
  if (!nodes.length) return;
  let seq = nextSeq(db, revokeId);
  const insert = st(db, "INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,?,?)");
  for (const node of nodes) insert.run(revokeId, seq++, encodeNode(node));
}
/** The flow phase's queue lives in the same table at negative seqs (breadth first: the one nearest zero goes first). */
function pushFlow(db: DatabaseSync, revokeId: number, node: string, since: number): void {
  const first = st(db, "SELECT seq FROM memory_revoke_frontier WHERE revoke_id=? ORDER BY seq LIMIT 1").get(revokeId)?.seq;
  const seq = Math.min(0, Number(first ?? 0)) - 1;
  st(db, "INSERT INTO memory_revoke_frontier(revoke_id,seq,node) VALUES(?,?,?)").run(revokeId, seq, JSON.stringify({ node, since }));
}
/** Pending row for a thread or `scope:` node of a revoke, kept at the smallest since. True when it was new or moved earlier.
 * A thread row at or before the revoke's commit (started_lsn) holds only lines of turns begun before the commit (deny-read.ts
 * pendingWindows); a row after it (an inherit hold for a line derived after the commit) holds every line from its since. So an earlier row
 * covers a later one only on the same side of the commit: a post-commit hold is kept beside the revoke's own window, never folded into it. */
export function markPending(db: DatabaseSync, revokeId: number, node: string, since: number): boolean {
  const scope = node.startsWith("scope:");
  const table = scope ? "memory_deny_pending_scope" : "memory_deny_pending", column = scope ? "scope_id" : "thread_id";
  const key = scope ? node.slice("scope:".length) : node;
  const started = scope ? undefined : st(db, "SELECT started_lsn FROM memory_revoke_jobs WHERE revoke_id=?").get(revokeId)?.started_lsn;
  const after = started !== undefined && started !== null && since > Number(started);
  const held = after
    ? st(db, `SELECT min(since_lsn) AS s FROM ${table} WHERE ${column}=? AND revoke_id=? AND since_lsn>?`).get(key, revokeId, Number(started))?.s
    : st(db, `SELECT min(since_lsn) AS s FROM ${table} WHERE ${column}=? AND revoke_id=?`).get(key, revokeId)?.s;
  if (held !== null && held !== undefined && Number(held) <= since) return false;
  st(db, `INSERT OR IGNORE INTO ${table}(${column},since_lsn,revoke_id) VALUES(?,?,?)`).run(key, since, revokeId);
  return true;
}
/** Seeds the flow closure at a thread or `scope:` node (commit and inheritance). */
export function seedFlow(db: DatabaseSync, revokeId: number, node: string, since: number): void {
  if (markPending(db, revokeId, node, since)) pushFlow(db, revokeId, node, since);
}
/** A stored line's position: lsn, generated (it has a turn_lsn) and turn_lsn; undefined when it has no lineage row. */
export function lineOf(db: DatabaseSync, threadId: string, messageId: string): { lsn: number; generated: number; turn_lsn: number | null } | undefined {
  const no = threadNo(db, threadId);
  if (no === null) return undefined;
  const row = st(db, "SELECT lsn,turn_lsn FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(no, messageId);
  return row ? { lsn: Number(row.lsn), generated: row.turn_lsn === null ? 0 : 1, turn_lsn: row.turn_lsn === null ? null : Number(row.turn_lsn) } : undefined;
}

/** deny_range(T, from, until, R), merging a thread's rows into one sticky row (never undone) once it holds DENY_RANGE_COALESCE of them:
 * withholds more, never less (DESIGN-WRITETIME 1, coalescing). Audience-only rows (memory_revoke_audience) merge apart from the others,
 * into revoke AUDIENCE_COALESCED, so a content reader never inherits them; the others into revoke -1. */
/** The reason suffix of a range row written with a proven `until` (revoke-commit.ts): the marker reads the bound back from the row. */
export const BOUNDED_RANGE = ":until";
export function writeRange(db: DatabaseSync, revokeId: number, threadId: string, from: number, until: number, reason: string): void {
  // a proven bound is never widened by another root of the same revoke at the same line (the U2 seed commits a forgotten line's tombstone and its
  // deleted source as two roots of one owner action)
  if (!reason.endsWith(BOUNDED_RANGE)) {
    const held = st(db, "SELECT reason FROM memory_deny_range WHERE thread_id=? AND from_lsn=? AND revoke_id=?").get(threadId, from, revokeId);
    if (held && String(held.reason).endsWith(BOUNDED_RANGE)) return;
  }
  st(db, "INSERT OR REPLACE INTO memory_deny_range(thread_id,from_lsn,until_turn_lsn,revoke_id,reason) VALUES(?,?,?,?,?)").run(threadId, from, until, revokeId, reason);
  const n = Number(st(db, "SELECT count(*) AS n FROM (SELECT 1 FROM memory_deny_range WHERE thread_id=? LIMIT ?)").get(threadId, DENY_RANGE_COALESCE + 1)?.n);
  if (n < DENY_RANGE_COALESCE) return;
  const AUD = `(revoke_id=${AUDIENCE_COALESCED} OR revoke_id IN (SELECT revoke_id FROM memory_revoke_audience))`;
  for (const [cls, id, reason2] of [[`NOT ${AUD}`, -1, "coalesced"], [AUD, AUDIENCE_COALESCED, "coalesced-audience"]] as const) {
    const all = st(db, `SELECT count(*) AS n,min(from_lsn) AS f,max(until_turn_lsn) AS u FROM memory_deny_range WHERE thread_id=? AND ${cls}`).get(threadId)!;
    if (!Number(all.n)) continue;
    st(db, `DELETE FROM memory_deny_range WHERE thread_id=? AND ${cls}`).run(threadId);
    st(db, "INSERT INTO memory_deny_range(thread_id,from_lsn,until_turn_lsn,revoke_id,reason) VALUES(?,?,?,?,?)").run(threadId, Number(all.f), Number(all.u), id, reason2);
  }
}
export function writeLine(db: DatabaseSync, revokeId: number, threadId: string, lsn: number, reason: string): void {
  st(db, "INSERT OR IGNORE INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES(?,?,?,?,?)").run(threadId, lsn, revokeId, currentLsn(db), reason);
}
export function writeMemory(db: DatabaseSync, revokeId: number, kind: MemoryRefKind, id: string, version: number): void {
  st(db, "INSERT OR IGNORE INTO memory_deny_memory(kind,id,version,revoke_id) VALUES(?,?,?,?)").run(kind, id, Math.max(0, version), revokeId);
}
export function writeSession(db: DatabaseSync, revokeId: number, threadId: string, driverInstance: string, nativeSession: string): void {
  st(db, "INSERT OR IGNORE INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES(?,?,?,?)").run(threadId, driverInstance, nativeSession, revokeId);
}
/** A record node's version: a soft node (a root that withdraws what was shown but leaves the record readable) is stored as -(v+1). */
export const softVersion = (version: number) => -(Math.max(0, version) + 1);
const visit = (db: DatabaseSync, revokeId: number, key: string): boolean =>
  Number(st(db, "INSERT OR IGNORE INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(?,?,0)").run(revokeId, key).changes) > 0;
/** Holds keep the revoke's pending rows while a bookkeeping job (memory-revocation.ts) still has work readers depend on. */
export const HOLD_PREFIX = "hold:";
export function holdRevoke(db: DatabaseSync, revokeId: number, bookkeepingJobId: string): void {
  if (revokeId > 0 && hasWritetime(db)) revokeId = resolveRevoke(db, revokeId);
  if (revokeId > 0 && hasWritetime(db)) st(db, "INSERT OR IGNORE INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(?,?,0)").run(revokeId, `${HOLD_PREFIX}${bookkeepingJobId}`);
}
export function releaseHold(db: DatabaseSync, revokeId: number, bookkeepingJobId: string): void {
  if (revokeId > 0 && hasWritetime(db)) revokeId = resolveRevoke(db, revokeId);
  if (revokeId > 0 && hasWritetime(db)) st(db, "DELETE FROM memory_revoke_reached WHERE revoke_id=? AND thread_id=?").run(revokeId, `${HOLD_PREFIX}${bookkeepingJobId}`);
}
/** The receipts a bookkeeping job flipped for a revoke: their refs rows are gone with the flip (schema v8 triggers), so the marker could
 * not find them again by what they cite; they enter its frontier here. */
export function enqueueReceipts(db: DatabaseSync, revokeId: number, bundleIds: readonly string[]): void {
  if (!(revokeId > 0) || !bundleIds.length || !hasWritetime(db)) return;
  revokeId = resolveRevoke(db, revokeId);
  const job = st(db, "SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(revokeId);
  if (!job || job.state === "undoing" || job.state === "undone") return;
  enqueueNodes(db, revokeId, bundleIds.map(bundleId => ({ kind: "receipt" as const, bundleId })));
  if (job.state === "done") st(db, "UPDATE memory_revoke_jobs SET phase='mark',state='active' WHERE revoke_id=?").run(revokeId);
  else st(db, "UPDATE memory_revoke_jobs SET phase=CASE WHEN phase IN ('hold','tidy') THEN 'mark' ELSE phase END WHERE revoke_id=?").run(revokeId);
}

type Cursor = Record<string, any>;
type Step = "progress" | "wait" | "late";
type LateBuild = (db: DatabaseSync, rows: number) => boolean;
const lateReady = (db: DatabaseSync, name: "evidence" | "origins") => {
  try { return Number(st(db, "SELECT ready FROM memory_late_build WHERE name=?").get(name)?.ready) === 1; } catch { return false; }
};

// ---- flow
function flowStep(db: DatabaseSync, job: JobRow, c: Cursor, budget: Budget): boolean {
  const head = st(db, "SELECT seq,node FROM memory_revoke_frontier WHERE revoke_id=? AND seq<0 ORDER BY seq DESC LIMIT 1").get(job.revoke_id);
  spend(budget, 1);
  if (!head) return true;
  let item: { node: string; since: number };
  try { item = JSON.parse(String(head.node)); } catch { throw new Error("MEMORY_REVOKE_NODE_UNREADABLE"); }
  if (typeof item?.node !== "string" || !Number.isSafeInteger(item.since)) throw new Error("MEMORY_REVOKE_NODE_UNREADABLE");
  const n = page(budget);
  const after = c.f === Number(head.seq) ? String(c.after ?? "") : "";
  const edges = st(db, "SELECT to_thread,first_lsn FROM memory_thread_flow WHERE from_thread=? AND to_thread>? ORDER BY to_thread LIMIT ?").all(item.node, after, n);
  for (const edge of edges) seedFlow(db, job.revoke_id, String(edge.to_thread), Math.max(Number(edge.first_lsn), item.since));
  spend(budget, edges.length);
  if (edges.length === n) { c.f = Number(head.seq); c.after = String(edges[edges.length - 1]!.to_thread); return false; }
  st(db, "DELETE FROM memory_revoke_frontier WHERE revoke_id=? AND seq=?").run(job.revoke_id, Number(head.seq));
  delete c.f; delete c.after;
  return false;
}

// ---- mark
type Handler = (db: DatabaseSync, job: JobRow, node: any, c: Cursor, budget: Budget) => boolean | "late";
const reasonOf = (job: JobRow) => { try { return String(JSON.parse(job.root)?.cause ?? job.kind); } catch { return job.kind; } };
function rootOf(job: JobRow): Record<string, any> { try { return JSON.parse(job.root) ?? {}; } catch { return {}; } }

function lineNode(db: DatabaseSync, job: JobRow, node: { threadId: string; lsn: number; from?: number }): boolean {
  writeLine(db, job.revoke_id, node.threadId, node.lsn, reasonOf(job));
  enqueueNode(db, job.revoke_id, { kind: "range", threadId: node.threadId, fromLsn: node.from ?? node.lsn });
  return true;
}
/** A carry's child as a frontier node (lineage-types.ts decodeCarryChild: the one child_ref encoding every writer uses). A child_ref that does
 * not parse fails the slice (the job and its pending rows stay): never skipped. A turn child is a range of its thread from its turn_lsn:
 * every line the turn wrote, and every later generated line built on them. */
function carryChild(db: DatabaseSync, job: JobRow, row: { child_kind: number; child_ref: string; child_thread_no: number | null }): void {
  const childThread = row.child_thread_no === null || Number(row.child_thread_no) === 0 ? null : threadIdOf(db, Number(row.child_thread_no));
  const child = decodeCarryChild(Number(row.child_kind), String(row.child_ref), childThread);
  if (!child) throw new Error("MEMORY_REVOKE_NODE_UNREADABLE");
  switch (child.kind) {
    case "line": enqueueNode(db, job.revoke_id, { kind: "line", threadId: child.threadId, lsn: child.lsn }); return;
    case "turn": enqueueNode(db, job.revoke_id, { kind: "range", threadId: child.threadId, fromLsn: child.turnLsn }); return;
    case "session": writeSession(db, job.revoke_id, child.session.threadId, child.session.driverInstance, child.session.nativeSession); return;
    case "memory": {
      const ref = child.ref;
      if (ref.kind === "record") enqueueNode(db, job.revoke_id, { kind: "record", id: ref.id, version: ref.version ?? 0 });
      else if (ref.kind === "source") enqueueNode(db, job.revoke_id, { kind: "source", id: ref.id });
      else {
        writeMemory(db, job.revoke_id, ref.kind, ref.id, ref.version ?? 0); // a lesson, a claim, a Murage object: its mark is the whole of it
        if (CONSUMED_REF_KINDS.has(ref.kind)) enqueueNode(db, job.revoke_id, { kind: "object", objectKind: ref.kind, id: ref.id }); // and whatever read it
      }
      return;
    }
  }
}
/** Whether a revoke from line `a` of thread `no` reaches what rests on parent lines from..to: the range holds `a` itself, its position is
 * unknown, or it holds a generated line after `a` that the revoke's range denies (positional: every such line is withheld with `a`; in a
 * line root's own thread with `until`, only the lines whose turn began before it: a later turn is a new branch). One seek. */
function rangeReached(db: DatabaseSync, no: number, a: number, from: number, to: number, untilTurn?: number): boolean {
  if (to >= UNKNOWN_LSN || from >= UNKNOWN_LSN || (from <= a && a <= to)) return true;
  return untilTurn === undefined
    ? Boolean(st(db, "SELECT 1 AS x FROM memory_line_lineage WHERE thread_no=? AND lsn>=? AND lsn<=? AND turn_lsn IS NOT NULL LIMIT 1").get(no, Math.max(from, a + 1), to))
    : Boolean(st(db, "SELECT 1 AS x FROM memory_line_lineage WHERE thread_no=? AND lsn>=? AND lsn<=? AND turn_lsn IS NOT NULL AND turn_lsn<? LIMIT 1").get(no, Math.max(from, a + 1), to, untilTurn));
}
function rangeNode(db: DatabaseSync, job: JobRow, node: { threadId: string; fromLsn: number }, c: Cursor, budget: Budget): boolean {
  const T = node.threadId, a = node.fromLsn, R = job.revoke_id;
  if (!c.stage) {
    // a line root committed with a proven `until` (a forget with a time: the U2 seed of a 1.0.1 forget, or an edit's branch): its range row was
    // written at the commit with that bound and is left as it is (also in a bulk revoke, whose job row holds no root). The walk from it reaches
    // only what rests on the lines that range denies; it is not recorded as walked, so an unbounded walk of the thread from a later line still runs.
    const bound = st(db, "SELECT until_turn_lsn AS u,reason AS why FROM memory_deny_range WHERE thread_id=? AND from_lsn=? AND revoke_id=?").get(T, a, R);
    if (bound && String(bound.why).endsWith(BOUNDED_RANGE)) {
      c.stage = "carry"; c.hi = null; c.at = null; c.until = Number(bound.u);
      spend(budget, 1);
      return false;
    }
    const held = st(db, "SELECT from_lsn FROM memory_revoke_reached WHERE revoke_id=? AND thread_id=?").get(R, T)?.from_lsn;
    if (held !== undefined && held !== null && Number(held) <= a) return true; // this thread is walked from an earlier line already
    st(db, "INSERT OR REPLACE INTO memory_revoke_reached(revoke_id,thread_id,from_lsn) VALUES(?,?,?)").run(R, T, a);
    // a line root's `until` (revoke-commit.ts RevokeOptions) bounds the range in the root's own thread; every other thread reached is
    // denied up to now
    const root = rootOf(job);
    const bounded = root.kind === "line" && root.threadId === T && Number.isSafeInteger(root.until);
    // (a walk that runs after a turn began is capped at the revoke's own commit: a turn begun after the owner's action is a new turn, not one the
    // action reached; a line of such a turn that rests on a denied parent is written into the frontier at write time, DESIGN-WRITETIME 2.3)
    // a root's own range row, written at its commit with its own slot as the cap (revoke-commit.ts commitRevoke), keeps that cap: a root
    // added to a bulk revoke after it opened commits later than the job's started_lsn
    const rootCap = bound ? Number(bound.u) : Number(job.started_lsn);
    const until = bounded ? Math.min(Number(root.until), currentLsn(db)) : Math.min(currentLsn(db), Math.max(Number(job.started_lsn), rootCap));
    writeRange(db, R, T, a, until, reasonOf(job));
    c.stage = "carry"; c.hi = held === undefined || held === null ? null : Number(held); c.at = null;
    // what rests on a line of a later turn is not reached through this range (rangeReached): an ordinary revoke's range ends at its commit
    // just as a bounded root's ends at its bound, and a clean answer whose turn began at or after the cap is outside it (Astra audit P1 7)
    c.until = until;
    spend(budget, 2);
    return false;
  }
  // [a, hi): hi is where an earlier walk of this thread by the same revoke began (it covered every carry ending from there on); none =
  // unbounded, which takes in the carries and captures written at UNKNOWN_LSN (a parent whose position was not known at write: every revoke
  // of its thread reaches it, fail closed). Two statement shapes, so each stays one index range with a stop. A thread with no number has
  // nothing carried or captured from it.
  const n = page(budget), bounded = c.hi !== null && c.hi !== undefined, hi = bounded ? Number(c.hi) : 0;
  const no = threadNo(db, T);
  if (no === null) { c.stage = "sess"; c.at = null; }
  if (c.stage === "carry") {
    // (the carry key ends with the child's thread: rows that differ only by it are paged apart)
    const cols = "SELECT to_lsn,from_lsn,child_kind,child_ref,child_thread_no FROM memory_lineage_carry WHERE parent_thread_no=?1";
    const order = "ORDER BY to_lsn,from_lsn,child_kind,child_ref,child_thread_no LIMIT ?";
    const after = c.at ? [c.at[0], c.at[1], c.at[2], c.at[3], c.at[4] ?? -1] : [];
    const rows = (c.at
      ? (bounded ? st(db, `${cols} AND (to_lsn,from_lsn,child_kind,child_ref,child_thread_no)>(?2,?3,?4,?5,?6) AND to_lsn<?7 ${order}8`).all(no, ...after, hi, n)
        : st(db, `${cols} AND (to_lsn,from_lsn,child_kind,child_ref,child_thread_no)>(?2,?3,?4,?5,?6) ${order}7`).all(no, ...after, n))
      : (bounded ? st(db, `${cols} AND to_lsn>=?2 AND to_lsn<?3 ${order}4`).all(no, a, hi, n)
        : st(db, `${cols} AND to_lsn>=?2 ${order}3`).all(no, a, n))) as Array<{ to_lsn: number; from_lsn: number; child_kind: number; child_ref: string; child_thread_no: number | null }>;
    for (const row of rows) if (rangeReached(db, no!, a, Number(row.from_lsn), Number(row.to_lsn), c.until)) carryChild(db, job, row);
    spend(budget, rows.length * 2);
    if (rows.length === n) { const last = rows[rows.length - 1]!; c.at = [Number(last.to_lsn), Number(last.from_lsn), Number(last.child_kind), String(last.child_ref), Number(last.child_thread_no ?? 0)]; return false; }
    c.stage = "cap"; c.at = null;
    return false;
  }
  if (c.stage === "cap") {
    const cols = "SELECT lsn,source_id FROM memory_line_capture WHERE thread_no=?1", order = "ORDER BY lsn,source_id LIMIT ?";
    const rows = (c.at
      ? (bounded ? st(db, `${cols} AND (lsn,source_id)>(?2,?3) AND lsn<?4 ${order}5`).all(no, c.at[0], c.at[1], hi, n)
        : st(db, `${cols} AND (lsn,source_id)>(?2,?3) ${order}4`).all(no, c.at[0], c.at[1], n))
      : (bounded ? st(db, `${cols} AND lsn>=?2 AND lsn<?3 ${order}4`).all(no, a, hi, n)
        : st(db, `${cols} AND lsn>=?2 ${order}3`).all(no, a, n))) as Array<{ lsn: number; source_id: string }>;
    for (const row of rows) { const at = Number(row.lsn); if (rangeReached(db, no!, a, at, at, c.until)) enqueueNode(db, R, { kind: "source", id: String(row.source_id) }); }
    spend(budget, rows.length);
    if (rows.length === n) { const last = rows[rows.length - 1]!; c.at = [Number(last.lsn), String(last.source_id)]; return false; }
    c.stage = "sess"; c.at = null;
    return false;
  }
  // sessions of the thread that held the line: begun before the range's cap (first_lsn, the head its first prompt was built on, below
  // c.until: the revoke's commit, its own lsn slot, or a bounded root's own bound) and run to or past the line (last_lsn >= a: a session
  // begun on the line itself as its head held it, and an in-place edit of that line leaves it holding the old words). A session row written
  // after this stage ran is marked at its write (lineage-write.ts writeSessionLineage). A session begun at or after the cap
  // never held the line: its first prompt was built under the window this revoke opened, or on the new branch a bounded root (an edit, a
  // regenerate) stops at (1.0.3 engine-switch: a long walk on a large thread marked every session started while it ran, so each resume
  // reset, Claude included). One begun between the line and the cap did hold it (an engine switched in mid-thread is replayed the
  // transcript), so it is still marked.
  const rows = (c.at
    ? st(db, "SELECT driver_instance,native_session,first_lsn,last_lsn FROM memory_session_lineage WHERE thread_id=? AND (driver_instance,native_session)>(?,?) ORDER BY driver_instance,native_session LIMIT ?").all(T, c.at[0], c.at[1], n)
    : st(db, "SELECT driver_instance,native_session,first_lsn,last_lsn FROM memory_session_lineage WHERE thread_id=? ORDER BY driver_instance,native_session LIMIT ?").all(T, n)) as Array<{ driver_instance: string; native_session: string; first_lsn: number; last_lsn: number }>;
  const cap = Number(c.until ?? Math.min(currentLsn(db), Number(job.started_lsn)));
  for (const row of rows) if (Number(row.first_lsn) < cap && Number(row.last_lsn) >= a) writeSession(db, R, T, String(row.driver_instance), String(row.native_session));
  spend(budget, rows.length);
  if (rows.length === n) { const last = rows[rows.length - 1]!; c.at = [String(last.driver_instance), String(last.native_session)]; return false; }
  return true;
}
/** One id's citing receipts (memory_disclosure_refs, index on (kind, CAST(ref_id AS TEXT))), a rowid page after c.rid. */
function citing(db: DatabaseSync, job: JobRow, kind: "record" | "source", id: string, version: number, c: Cursor, budget: Budget): boolean {
  const n = page(budget);
  const rows = st(db, `SELECT x.rowid AS rid,x.bundle_id AS b,x.ref_version AS v FROM memory_disclosure_refs x WHERE x.kind=? AND CAST(x.ref_id AS TEXT)=? AND x.rowid>? ORDER BY x.rowid LIMIT ?`).all(kind, id, Number(c.rid ?? 0), n) as Array<{ rid: number; b: string; v: unknown }>;
  for (const row of rows) if (!(version > 0) || Number(row.v) === version) enqueueNode(db, job.revoke_id, { kind: "receipt", bundleId: String(row.b) });
  spend(budget, rows.length);
  if (rows.length === n) { c.rid = Number(rows[rows.length - 1]!.rid); return false; }
  return true;
}
function sourceNode(db: DatabaseSync, job: JobRow, node: { id: string }, c: Cursor, budget: Budget): boolean | "late" {
  const R = job.revoke_id, id = node.id;
  if (!c.stage) {
    if (!visit(db, R, `s:${id}`)) return true;
    writeMemory(db, R, "source", id, 0);
    // the revoked receipts that cite it (their refs left the index when they were revoked: revoke-commit.ts holdRevokedReceipt)
    enqueueNodes(db, R, [{ kind: "object", objectKind: "source", id }, { kind: "object", objectKind: "source", id: "*" }]);
    // a forgotten source forgets its line: the line and every generated line after it in its thread (revbound's positional rule)
    const at = st(db, "SELECT thread_id,message_id FROM memory_sources WHERE id=?").get(id);
    if (typeof at?.thread_id === "string" && typeof at.message_id === "string") {
      const line = lineOf(db, at.thread_id, at.message_id);
      if (line) enqueueNode(db, R, { kind: "line", threadId: at.thread_id, lsn: Number(line.lsn) });
    }
    c.stage = "recs"; spend(budget, 3);
    return false;
  }
  const n = page(budget);
  if (c.stage === "recs") {
    if (!lateReady(db, "evidence")) return "late";
    const rows = (c.at
      ? st(db, "SELECT source_revision AS r,record_id AS i,record_version AS v,start_byte AS b FROM memory_evidence_by_source WHERE source_id=? AND (source_revision,record_id,record_version,start_byte)>(?,?,?,?) ORDER BY source_revision,record_id,record_version,start_byte LIMIT ?").all(id, ...(c.at as [number, string, number, number]), n)
      : st(db, "SELECT source_revision AS r,record_id AS i,record_version AS v,start_byte AS b FROM memory_evidence_by_source WHERE source_id=? ORDER BY source_revision,record_id,record_version,start_byte LIMIT ?").all(id, n)) as Array<{ r: number; i: string; v: number; b: number }>;
    let last = "";
    for (const row of rows) { const key = `${row.i}\u0000${row.v}`; if (key !== last) enqueueNode(db, R, { kind: "record", id: String(row.i), version: Number(row.v) }); last = key; }
    spend(budget, rows.length);
    if (rows.length === n) { const l = rows[rows.length - 1]!; c.at = [Number(l.r), String(l.i), Number(l.v), Number(l.b)]; return false; }
    c.stage = "copies"; c.at = null;
    return false;
  }
  if (c.stage === "copies") {
    if (!lateReady(db, "origins")) return "late";
    const rows = st(db, "SELECT bring_in_id AS id FROM memory_source_origins WHERE origin_id=? AND bring_in_id>? ORDER BY bring_in_id LIMIT ?").all(id, String(c.at ?? ""), n);
    for (const row of rows) enqueueNode(db, R, { kind: "source", id: String(row.id) });
    spend(budget, rows.length);
    if (rows.length === n) { c.at = String(rows[rows.length - 1]!.id); return false; }
    c.stage = "rcpt"; c.at = null;
    return false;
  }
  return citing(db, job, "source", id, 0, c, budget);
}
function recordNode(db: DatabaseSync, job: JobRow, node: { id: string; version: number }, c: Cursor, budget: Budget): boolean {
  const R = job.revoke_id, soft = node.version < 0, version = soft ? -node.version - 1 : node.version, id = node.id;
  if (!c.stage) {
    if (!visit(db, R, `r:${soft ? "~" : ""}${id}:${version}`)) return true;
    if (!soft) writeMemory(db, R, "record", id, version);
    enqueueNodes(db, R, [{ kind: "object", objectKind: "record", id }, { kind: "object", objectKind: "record", id: "*" }]);
    // the forgotten record's own supporting sources go with it (forget.ts tombstones the newest; the rest are reached here, so a record
    // citing one of them is withheld by mark, not when the bookkeeping job gets to it); a room's notes keep what they quoted
    const root = rootOf(job);
    const supporting = !soft && root.kind === "memory" && root.cause === "forget" && root.ref?.kind === "record" && root.ref.id === id
      && !st(db, "SELECT 1 FROM memory_records WHERE id=? AND kind='checkpoint' LIMIT 1").get(id);
    c.stage = supporting ? "ev" : "kids"; c.at = null;
    spend(budget, 2);
    return false;
  }
  const n = page(budget);
  if (c.stage === "ev") {
    const where = version > 0 ? "record_id=? AND record_version=?" : "record_id=?", args: unknown[] = version > 0 ? [id, version] : [id];
    const rows = (c.at
      ? st(db, `SELECT record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence WHERE ${where} AND (record_version,source_id,source_revision,start_byte)>(?,?,?,?) ORDER BY record_version,source_id,source_revision,start_byte LIMIT ?`).all(...args as never[], ...(c.at as never[]), n)
      : st(db, `SELECT record_version AS v,source_id AS s,source_revision AS r,start_byte AS b FROM memory_evidence WHERE ${where} ORDER BY record_version,source_id,source_revision,start_byte LIMIT ?`).all(...args as never[], n)) as Array<{ v: number; s: string; r: number; b: number }>;
    for (const row of rows) enqueueNode(db, R, { kind: "source", id: String(row.s) });
    spend(budget, rows.length);
    if (rows.length === n) { const l = rows[rows.length - 1]!; c.at = [Number(l.v), String(l.s), Number(l.r), Number(l.b)]; return false; }
    c.stage = "kids"; c.at = null;
    return false;
  }
  if (c.stage === "kids") {
    const where = version > 0 ? "parent_id=? AND parent_version=?" : "parent_id=?", args: unknown[] = version > 0 ? [id, version] : [id];
    const rows = (c.at
      ? st(db, `SELECT parent_version AS p,child_id AS i,child_version AS v FROM memory_derivations WHERE ${where} AND (parent_version,child_id,child_version)>(?,?,?) ORDER BY parent_version,child_id,child_version LIMIT ?`).all(...args as never[], ...(c.at as never[]), n)
      : st(db, `SELECT parent_version AS p,child_id AS i,child_version AS v FROM memory_derivations WHERE ${where} ORDER BY parent_version,child_id,child_version LIMIT ?`).all(...args as never[], n)) as Array<{ p: number; i: string; v: number }>;
    for (const row of rows) enqueueNode(db, R, { kind: "record", id: String(row.i), version: soft ? softVersion(Number(row.v)) : Number(row.v) });
    spend(budget, rows.length);
    if (rows.length === n) { const l = rows[rows.length - 1]!; c.at = [Number(l.p), String(l.i), Number(l.v)]; return false; }
    c.stage = "rcpt"; c.at = null; c.rid = 0;
    return false;
  }
  return citing(db, job, "record", id, version, c, budget);
}
function receiptNode(db: DatabaseSync, job: JobRow, node: { bundleId: string }, _c: Cursor, budget: Budget): boolean {
  const R = job.revoke_id, b = node.bundleId;
  if (!visit(db, R, `b:${b}`)) return true;
  // (the receipt's own state is the bookkeeping job's, as today: the marker withholds what it produced, by its outputs and its session)
  // The receipt range (receipt-outputs.ts): its first output, as a line (whose positional range covers every later line resting on it), and
  // its session. A receipt that produced no output resets its session only.
  const start = receiptStart(db, b);
  if (start?.session) writeSession(db, R, start.session.threadId, start.session.driverInstance, start.session.nativeSession);
  if (start) enqueueNode(db, R, { kind: "line", threadId: start.threadId, lsn: start.firstLsn });
  spend(budget, 3);
  return true;
}
function scopeNode(db: DatabaseSync, job: JobRow, node: { scopeId: string }, c: Cursor, budget: Budget): boolean {
  const R = job.revoke_id;
  if (!c.stage) { if (!visit(db, R, `S:${node.scopeId}`)) return true; c.stage = "recs"; c.at = null; spend(budget, 1); return false; }
  const n = page(budget);
  const rows = (c.at
    ? st(db, "SELECT rowid AS rid,state,id,version FROM memory_records WHERE scope_id=?1 AND (state>?2 OR (state=?2 AND rowid>?3)) ORDER BY state,rowid LIMIT ?4").all(node.scopeId, c.at[0], c.at[1], n)
    : st(db, "SELECT rowid AS rid,state,id,version FROM memory_records WHERE scope_id=? ORDER BY state,rowid LIMIT ?").all(node.scopeId, n)) as Array<{ rid: number; state: string; id: string; version: number }>;
  for (const row of rows) enqueueNode(db, R, { kind: "record", id: String(row.id), version: Number(row.version) });
  spend(budget, rows.length);
  if (rows.length === n) { const l = rows[rows.length - 1]!; c.at = [String(l.state), Number(l.rid)]; return false; }
  return true;
}
/** The consumers of a denied object (memory_lineage_carry rows hanging from the object's interned node, written by lineage-write.ts carryOnto):
 * each is a frontier node as any carry's child is. Once per object per revoke. */
function objectNode(db: DatabaseSync, job: JobRow, node: { objectKind: MemoryRefKind; id: string }, c: Cursor, budget: Budget): boolean {
  const R = job.revoke_id;
  if (!c.stage) { if (!visit(db, R, `o:${node.objectKind}:${node.id}`)) return true; c.stage = "kids"; c.at = null; spend(budget, 1); return false; }
  const no = threadNo(db, objectCarryThread({ kind: node.objectKind, id: node.id }));
  if (no === null) return true; // nothing ever read it
  const n = page(budget);
  const cols = "SELECT to_lsn,from_lsn,child_kind,child_ref,child_thread_no FROM memory_lineage_carry WHERE parent_thread_no=?1";
  const order = "ORDER BY to_lsn,from_lsn,child_kind,child_ref,child_thread_no LIMIT ?";
  const rows = (c.at
    ? st(db, `${cols} AND (to_lsn,from_lsn,child_kind,child_ref,child_thread_no)>(?2,?3,?4,?5,?6) ${order}7`).all(no, c.at[0], c.at[1], c.at[2], c.at[3], c.at[4], n)
    : st(db, `${cols} ${order}2`).all(no, n)) as Array<{ to_lsn: number; from_lsn: number; child_kind: number; child_ref: string; child_thread_no: number | null }>;
  for (const row of rows) carryChild(db, job, row);
  spend(budget, rows.length * 2);
  if (rows.length === n) { const last = rows[rows.length - 1]!; c.at = [Number(last.to_lsn), Number(last.from_lsn), Number(last.child_kind), String(last.child_ref), Number(last.child_thread_no ?? 0)]; return false; }
  return true;
}
const HANDLERS: Record<FrontierNode["kind"], Handler> = {
  line: (db, job, node) => lineNode(db, job, node),
  range: rangeNode, source: sourceNode, record: recordNode, receipt: receiptNode, scope: scopeNode, object: objectNode,
  session: (db, job, node) => { writeSession(db, job.revoke_id, node.session.threadId, node.session.driverInstance, node.session.nativeSession); return true; },
};
// ---- the upgrade strip's counter: work the marker has done for the upgrade's own revokes, only ever added to
// (the strip used to show "largest queue so far minus the queue now", which stands still while the walk fans out as fast as it drains)
const upgradeWork = new WeakMap<object, number>();
const isUpgradeSeed = (job: { root?: unknown }) => typeof job.root === "string" && job.root.includes('"upgrade-seed"');
function noteUpgradeWork(db: DatabaseSync, job: { root?: unknown }, units: number): void {
  if (units > 0 && isUpgradeSeed(job)) upgradeWork.set(db, (upgradeWork.get(db) ?? 0) + units);
}
/** Committed work, shared by every runner and retained when a finished job is pruned or the connection reopens. */
export function upgradeMarkerWalked(db: DatabaseSync): number {
  return Number(st(db, "SELECT CASE WHEN json_valid(cursor) THEN coalesce(json_extract(cursor,'$.markerWork'),0) ELSE 0 END AS n FROM memory_lineage_cert WHERE id=1").get()?.n ?? 0);
}

function markStep(db: DatabaseSync, job: JobRow, c: Cursor, budget: Budget): boolean | "late" {
  const head = st(db, "SELECT seq,node FROM memory_revoke_frontier WHERE revoke_id=? AND seq>0 ORDER BY seq LIMIT 1").get(job.revoke_id);
  if (!head) { spend(budget, 1); return true; }
  const seq = Number(head.seq);
  const node = decodeNode(String(head.node));
  if (!node) throw new Error("MEMORY_REVOKE_NODE_UNREADABLE"); // never skipped: the job (and its pending rows) stays
  if (c.seq !== seq) { c.seq = seq; c.n = {}; c.w = 0; }
  const before = budget.rows;
  const done = HANDLERS[node.kind](db, job, node, c.n, budget);
  // the rows this node's fan-out has spent so far, kept in the cursor so the upgrade strip moves inside one large node (lineage-backfill.ts upgradeMarkerFanout)
  c.w = Number(c.w ?? 0) + Math.max(0, before - budget.rows);
  if (done === "late") return "late";
  if (done) { st(db, "DELETE FROM memory_revoke_frontier WHERE revoke_id=? AND seq=?").run(job.revoke_id, seq); delete c.seq; delete c.n; delete c.w; noteUpgradeWork(db, job, 1); }
  return false;
}

// ---- tidy and undo: pages through the `_revoke` indexes
const BY_REVOKE: Array<[string, string]> = [
  ["memory_deny_line", "thread_id,lsn,revoke_id"], ["memory_deny_range", "thread_id,from_lsn,revoke_id"],
  ["memory_deny_session", "thread_id,driver_instance,native_session,revoke_id"], ["memory_deny_memory", "kind,id,version,revoke_id"],
  ["memory_deny_pending", "thread_id,since_lsn,revoke_id"], ["memory_deny_pending_scope", "scope_id,since_lsn,revoke_id"],
];
function deletePage(db: DatabaseSync, table: string, key: string, revokeId: number, n: number): number {
  return Number(st(db, `DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} WHERE revoke_id=?1 LIMIT ?2)`).run(revokeId, n).changes);
}
const deleteOwn = (db: DatabaseSync, table: "memory_revoke_frontier" | "memory_revoke_reached", revokeId: number, n: number) =>
  Number(st(db, `DELETE FROM ${table} WHERE revoke_id=?1 AND ${table === "memory_revoke_frontier" ? "seq" : "thread_id"} IN (SELECT ${table === "memory_revoke_frontier" ? "seq" : "thread_id"} FROM ${table} WHERE revoke_id=?1 LIMIT ?2)`).run(revokeId, n).changes);
/** The revoke's visited rows, then its pending rows (only once every mark is written). True when none is left. */
function tidyStep(db: DatabaseSync, job: JobRow, budget: Budget): boolean {
  const n = page(budget);
  let gone = deleteOwn(db, "memory_revoke_reached", job.revoke_id, n);
  if (gone < n) gone += deletePage(db, "memory_deny_pending", "thread_id,since_lsn,revoke_id", job.revoke_id, n - gone);
  if (gone < n) gone += deletePage(db, "memory_deny_pending_scope", "scope_id,since_lsn,revoke_id", job.revoke_id, n - gone);
  spend(budget, gone);
  return gone < n;
}
function undoStep(db: DatabaseSync, job: JobRow, budget: Budget): boolean {
  const n = page(budget);
  let gone = deleteOwn(db, "memory_revoke_frontier", job.revoke_id, n);
  for (const [table, key] of BY_REVOKE) if (gone < n) gone += deletePage(db, table, key, job.revoke_id, n - gone);
  if (gone < n) gone += deleteOwn(db, "memory_revoke_reached", job.revoke_id, n - gone);
  spend(budget, gone);
  return gone < n;
}
/** Finished revokes leave no row, except the newest, which keeps revoke ids from being taken again (INTEGER PRIMARY KEY, no AUTOINCREMENT). */
function pruneFinished(db: DatabaseSync): void {
  st(db, "DELETE FROM memory_revoke_jobs WHERE state IN ('done','undone') AND revoke_id<(SELECT max(revoke_id) FROM memory_revoke_jobs)").run();
}

/** `flowOnly` (1.0.3 revoke drain, F3): the slice is running every pending job's flow phase before any job marks; the job stops at the end
 * of its flow phase (its '*' rows already gone, its phase 'mark') so the next job's flow runs next. */
function advance(db: DatabaseSync, job: JobRow, budget: Budget, late: LateBuild | null, flowOnly = false): Step {
  let c: Cursor = {};
  try { c = job.cursor ? JSON.parse(job.cursor) : {}; } catch { c = {}; }
  let progressed = false;
  const save = () => st(db, "UPDATE memory_revoke_jobs SET phase=?,cursor=?,state=? WHERE revoke_id=?").run(job.phase, JSON.stringify(c), job.state, job.revoke_id);
  while (!exhausted(budget)) {
    const rowsBefore = budget.rows;
    let countWork = true;
    try {
    if (job.phase === "flow") {
      if (flowStep(db, job, c, budget)) {
        // a fold bulk keeps its '*' rows to its tidy (REVOKE-FOLD-DESIGN F1.4): nothing rests on its members' earlier flow passes
        if (scopeFlowEdgesRecorded && Number(st(db, "SELECT ready FROM memory_lineage_cert WHERE id=1").get()?.ready ?? 0) === 1 && !isFoldBulk(db, job.revoke_id, job.root)) {
          st(db, "DELETE FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?").run(PENDING_ALL_THREADS, job.revoke_id);
          st(db, "DELETE FROM memory_deny_pending_scope WHERE scope_id=? AND revoke_id=?").run(PENDING_ALL_SCOPES, job.revoke_id);
          bumpDenyGeneration(db);
        }
        job.phase = "mark"; c = {};
        if (flowOnly) { save(); return "progress"; }
      }
    } else if (job.phase === "mark") {
      const done = markStep(db, job, c, budget);
      if (done === "late") {
        // a lookup table the walk needs is still being built: build a window of it now (the walk resumes on the next slice)
        save();
        if (late?.(db, page(budget))) return "progress";
        return progressed ? "progress" : "wait";
      }
      if (done) { job.phase = "hold"; c = {}; }
    } else if (job.phase === "hold") {
      const hold = st(db, "SELECT thread_id FROM memory_revoke_reached WHERE revoke_id=? AND thread_id>=? AND thread_id<? LIMIT 1").get(job.revoke_id, HOLD_PREFIX, "hold;");
      spend(budget, 1);
      if (hold) {
        const jobId = String(hold.thread_id).slice(HOLD_PREFIX.length);
        if (hasTable(db, "memory_scope_bindings") && st(db, "SELECT 1 FROM memory_scope_bindings WHERE id=?").get(`memory-revocation:${jobId}`)) { countWork = false; save(); return progressed ? "progress" : "wait"; }
        releaseHold(db, job.revoke_id, jobId); // the bookkeeping job is gone (finished or dropped): nothing left to wait for
      } else if (st(db, "SELECT 1 FROM memory_revoke_frontier WHERE revoke_id=? LIMIT 1").get(job.revoke_id)) job.phase = "mark"; // inherited since
      else { job.phase = "tidy"; c = {}; }
    } else if (job.phase === "tidy") {
      if (st(db, "SELECT 1 FROM memory_revoke_frontier WHERE revoke_id=? LIMIT 1").get(job.revoke_id)) { job.phase = "mark"; continue; }
      if (tidyStep(db, job, budget)) {
        // a fold bulk's members leave their 'folded' rows last (F1.4), a page per step (a cohort holds up to FLIP_DRAIN_MAX members): the
        // bulk is done only once none is left, and a restart resumes the tidy. Their ids stay in the map and in memory_revoke_audience.
        if (hasFoldMap(db)) {
          const n = page(budget);
          const gone = Number(st(db, `DELETE FROM memory_revoke_jobs WHERE revoke_id IN (SELECT f.old_id FROM memory_revoke_fold f JOIN memory_revoke_jobs j
            ON j.revoke_id=f.old_id WHERE f.bulk_id=?1 AND j.state='folded' LIMIT ?2)`).run(job.revoke_id, n).changes);
          if (gone) spend(budget, gone);
          if (gone >= n) { progressed = true; continue; }
        }
        job.phase = "done"; job.state = "done"; c = {}; bumpDenyGeneration(db); save(); pruneFinished(db); return "progress";
      }
    } else if (job.phase === "undo") {
      if (undoStep(db, job, budget)) { job.phase = "done"; job.state = "undone"; c = {}; bumpDenyGeneration(db); save(); pruneFinished(db); return "progress"; }
    } else { job.state = job.state === "undoing" ? "undone" : "done"; save(); return "progress"; }
    progressed = true;
    } finally { if (countWork) noteUpgradeWork(db, job, Math.max(0, rowsBefore - budget.rows)); }
  }
  save();
  return "progress";
}

const ACTIVE_JOBS = "SELECT revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state FROM memory_revoke_jobs WHERE state IN ('active','undoing') ORDER BY revoke_id LIMIT 16";
/** The oldest job still narrowing (1.0.3 revoke drain, F3). */
const FLOW_JOB = "SELECT revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state FROM memory_revoke_jobs WHERE state='active' AND phase='flow' ORDER BY revoke_id LIMIT 1";
const ACTIVE_JOB_ONE = "SELECT revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state FROM memory_revoke_jobs WHERE state IN ('active','undoing') AND revoke_id=?";
/** One marker slice (caller's transaction): the oldest revoke with work moves within the budget. True when it did work; false when no
 * revoke waits or every waiting one is held by its bookkeeping job (the runner then runs that job). */
/** The flip drain (revoke-commit.ts drainFlipsIntoBulk: one audience bulk per drain; set there, which imports this module). A `var` with no
 * initializer: revoke-commit.ts may set it while this module is still being evaluated (the lineage-write -> revoke-commit import cycle),
 * when a `let` would still be in its temporal dead zone and an initializer would later overwrite the value. */
// eslint-disable-next-line no-var
var drainFlips: ((db: DatabaseSync, limit: number, fits: (cost: number, first: boolean) => boolean) => number) | undefined;
/** The rows committing the oldest queued flip writes, its bulk's opening included (revoke-commit.ts receiptCommitCost); 0 when none waits. */
// eslint-disable-next-line no-var
var headFlipCostOf: ((db: DatabaseSync) => number) | undefined;
export function setFlipDrain(drain: (db: DatabaseSync, limit: number, fits: (cost: number, first: boolean) => boolean) => number, headCost?: (db: DatabaseSync) => number): void {
  drainFlips = drain;
  if (headCost) headFlipCostOf = headCost;
}
/** Rows the oldest queued receipt flip's commit writes (0: no flip waits). revoke-budget.ts admits a slice only with room for it. */
export function headFlipCost(db: DatabaseSync): number {
  try { return hasWritetime(db) ? Math.max(headFlipCostOf ? headFlipCostOf(db) : 0, foldHooks ? foldHooks.need(db) : 0) : 0; } catch { return 0; }
}
/** One fold slice's view of the marker's budget (revoke-fold.ts). */
export type FoldBudget = { rows: () => number; spend: (n: number) => void; exhausted: () => boolean; fits: (cost: number, first: boolean) => boolean };
/** The revoke fold (revoke-fold.ts, 1.0.3 REVOKE-FOLD-DESIGN): `slice` moves a seeding fold bulk or opens one (null: no fold work this
 * slice); `need`: rows its next indivisible step writes (0: none); `pending`: a fold bulk is still seeding. Set there, as setFlipDrain is. */
export type FoldHooks = { slice: (db: DatabaseSync, budget: FoldBudget) => boolean | "blocked" | null; need: (db: DatabaseSync) => number; pending: (db: DatabaseSync) => boolean };
// eslint-disable-next-line no-var
var foldHooks: FoldHooks | undefined;
export function setFoldHooks(hooks: FoldHooks): void { foldHooks = hooks; }
const flipQueued = (db: DatabaseSync) => Boolean(st(db, "SELECT 1 FROM memory_receipt_flips LIMIT 1").get());
/** Changes a write-capped slice may run past its cap: more than one marker step writes (a step reads at most MARKER_SLICE_ROWS / 4 rows).
 * revoke-budget.ts holds it back from every slice's cap, so the minute's writes stay inside the budget. The first flip of a drain may use
 * it too (its whole cost is then at most the minute's room; no flip costs more than a whole minute: revoke-commit.ts receiptHoldPlan). */
export const MARKER_STEP_RESERVE = 512;
/** Options of one capped slice. `only`: an owner's inline walk (revoke-commit.ts markInline) moves only its own revoke and never drains
 * the queued flips (unrelated backlog the runner carries). */
export type MarkerSliceOptions = { only?: number };
/** One marker slice. `maxChanges` (1.0.3 revoke storm, M3): the most rows the slice may change, every write counted (marks, frontier
 * enqueues, visits, pending, hold and job rows; SQLite's total_changes(), which counts trigger writes too). It is checked between steps, so a
 * slice ends within one step of it (revoke-budget.ts holds the per-minute budget this comes from). "blocked": a receipt flip waits and the
 * cap had no room to commit it, so nothing moved (no revoke advances while a flip waits: see runMarkerSlice). */
export function markerSlice(db: DatabaseSync, rows: number = MARKER_SLICE_ROWS, ms: number = Number.POSITIVE_INFINITY, late: LateBuild | null = null, maxChanges: number = Number.POSITIVE_INFINITY, opts: MarkerSliceOptions = {}): boolean | "blocked" {
  const before = upgradeWork.get(db) ?? 0;
  const moved = runMarkerSlice(db, rows, ms, late, maxChanges, opts);
  const worked = (upgradeWork.get(db) ?? 0) - before;
  // The count lives in the certificate's cursor JSON. A ready certificate's empty default cursor becomes '{...}' (the backfill no longer reads
  // it); an unstarted backfill's empty cursor is left alone, because the backfill reads any non-empty cursor as its own position.
  if (worked > 0) st(db, `UPDATE memory_lineage_cert SET cursor=json_set(CASE WHEN json_valid(cursor) THEN cursor ELSE '{}' END,
    '$.markerWork',CASE WHEN json_valid(cursor) THEN coalesce(json_extract(cursor,'$.markerWork'),0) ELSE 0 END + ?) WHERE id=1 AND (json_valid(cursor) OR ready=1)`).run(worked);
  return moved;
}
function runMarkerSlice(db: DatabaseSync, rows: number, ms: number, late: LateBuild | null, maxChanges: number, opts: MarkerSliceOptions): boolean | "blocked" {
  if (!hasWritetime(db)) return false;
  // the slice's deadline and write cap hold from its start, the flip drain included
  const capped = Number.isFinite(maxChanges), start = capped ? totalChanges(db) : 0;
  const over = capped ? () => totalChanges(db) - start >= maxChanges : undefined;
  const budget: Budget = { rows: Math.max(1, rows), deadline: performance.now() + ms, ...(over ? { over } : {}) };
  // A queued flip has already left memory_disclosure_refs, and its consumer edges are written only when it is drained (revoke-commit.ts
  // holdRevokedReceipt). Until then a content forget walking the items it cites would find neither, so NO revoke advances while a flip
  // waits: the flips are drained first, and a slice that cannot drain one moves nothing ("blocked"; the runner waits for room).
  if (flipQueued(db)) {
    if (opts.only !== undefined || !drainFlips) return false; // an owner's inline walk never drains the backlog; the runner does
    // a flip is committed only when its whole cost fits the cap and the deadline; the first of a drain may use the step reserve
    const fits = (cost: number, first: boolean) => {
      if (!first && performance.now() >= budget.deadline) return false;
      return !capped || totalChanges(db) - start + cost <= maxChanges + (first ? MARKER_STEP_RESERVE : 0);
    };
    return drainFlips(db, FLIP_DRAIN_MAX, fits) > 0 ? true : "blocked";
  }
  // Every pending job's flow phase runs before any job marks (1.0.3 revoke drain, F3). A flow phase is the cheap narrowing of the job's own
  // windows: from a '*' pending row over every thread and scope to one row per thread or scope its root can reach (its end is where the
  // design drops the '*' rows: the module header, "the flow phase ends the '*' pending rows at once"). Only the order across jobs changes,
  // never a job's own phases: each job still narrows, then marks, holds and tidies in that order, and its pending rows stay until its
  // last mark (REVOKE-STORM-DESIGN-M M1: the pending windows and the flow narrowing as they are; M3: bounded slices under the budget;
  // M4: each existing job finishes as it is). No job's marks read another job's flow rows, so marking later withholds no less. The queued
  // flips still go first (above), and an owner's inline walk (`only`) still moves only its own revoke.
  // The revoke fold (1.0.3 REVOKE-FOLD-DESIGN F1.1): after the flips, before any job's flow or marks. A seeding fold bulk takes the marker's
  // turn (no slice advances a member while its rows are copied); at listen, and in the runner when two or more flow-phase bulks wait, the
  // cohorts are tested and one is folded per slice. An owner's inline walk never folds.
  if (opts.only === undefined && foldHooks) {
    const folded = foldHooks.slice(db, {
      rows: () => budget.rows, spend: n => spend(budget, n), exhausted: () => exhausted(budget),
      // a step's whole cost must fit the cap; the slice's first step may use the step reserve (as the first flip of a drain does)
      fits: (cost, firstStep) => !capped || totalChanges(db) - start + cost <= maxChanges + (firstStep ? MARKER_STEP_RESERVE : 0),
    });
    if (folded !== null) return folded;
  }
  if (opts.only === undefined) {
    for (let flow = st(db, FLOW_JOB).get() as JobRow | undefined; flow; flow = st(db, FLOW_JOB).get() as JobRow | undefined) {
      advance(db, { ...flow, revoke_id: Number(flow.revoke_id) } as JobRow, budget, late, true);
      if (exhausted(budget)) return true;
    }
  }
  for (const row of st(db, opts.only === undefined ? ACTIVE_JOBS : ACTIVE_JOB_ONE).all(...(opts.only === undefined ? [] : [opts.only])) as JobRow[]) {
    const job = { ...row, revoke_id: Number(row.revoke_id) } as JobRow;
    if (advance(db, job, budget, late) === "progress") return true;
  }
  return false;
}
/** Whether any revoke still has work (a start-up VACUUM and the idle wait both wait for it). */
export function markerWorkPending(db: DatabaseSync): boolean {
  try { return hasWritetime(db) && (Boolean(st(db, "SELECT 1 FROM memory_revoke_jobs WHERE state IN ('active','undoing') LIMIT 1").get()) || Boolean(st(db, "SELECT 1 FROM memory_receipt_flips LIMIT 1").get()) || Boolean(foldHooks?.pending(db))); }
  catch { return false; }
}
