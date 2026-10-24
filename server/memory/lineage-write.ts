// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy: recording ancestry at write (DESIGN-WRITETIME 2, STORAGE-AUDIT 3).
//
// What a written line records, in the writer's transaction (one savepoint: all of it or none of it; a line with no row reads "checking"):
// - its memory_line_lineage row (thread by interned number, thread-no.ts): the lsn taken from memory_lsn, turn_lsn (generated lines only: the
//   head lsn when the producing turn's prompt was built; a generated line outside a turn rests on everything before it, its own lsn minus one;
//   owner and person lines have none), mem_lsn and footprint;
// - its turn's carries: the turn's cross-thread parents as RANGES of parent lines (one row per contiguous run shown), with the TURN
//   (thread, turn_lsn) as their child. They are resolved once per turn (and again only when the turn gains parents) and written with
//   INSERT OR IGNORE by every line of the turn: a handful of statements and no new rows after the first line, so carries grow with turns,
//   never with lines x context, and a line whose transaction rolls back never leaves its turn without them;
// - a line's own explicit refs (a copy, a hand-off result) as ranges with the LINE as child;
// - a memory_thread_flow edge per parent thread or scope (`scope:<id>`), first_lsn = the child's lsn;
// - inheritance at write (revoke-commit.ts inheritMarks) over the same ranges and memory refs.
// In-thread context is positional (deny_range), never a carry.
//
// Running values. Every row, owner rows included, holds the thread's running mem_lsn and footprint as of its write (owner rows pass them
// through; the read side never applies them to owner or person lines). So the next line folds the thread's history with ONE seek on the
// thread's newest row, whatever the thread's length; a carried range folds its parent thread's running values at the range's end.
//
// Unknown positions fail closed. A carried line with no lineage row, or a prefix of a thread that is not ready, is carried at UNKNOWN_LSN: the
// marker reaches it from ANY revoke in that thread. Its mem_lsn folds as 0 and its footprint as FOOTPRINT_STAR.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  CARRY_CHILD_CODE, CONSUMED_REF_KINDS, FIRST_LSN, FOOTPRINT_SCOPE_CAP, FOOTPRINT_STAR, lineChildRef, memoryRefKey, OBJECT_EDGE_LSN, objectCarryThread, objectFlowNode, recordChildRef, scopeFlowNode, sessionChildRef, turnChildRef, UNKNOWN_LSN,
  type CarryChildKind, type LineageParents, type LineageRef, type LineageToken, type LineInput, type MemoryRef, type SessionKey, type TurnLineage,
} from "./lineage-types.ts";
import { denyGeneration } from "./deny-read.ts";
import { inheritMarks, type CarryRange, type InheritChild } from "./revoke-commit.ts";
import { ensureThreadNo, threadNo } from "./thread-no.ts";

/** The parent position of a carry whose real position is not known yet: every range of the parent thread reaches it (fail closed). */
export const UNKNOWN_PARENT_LSN = UNKNOWN_LSN;

/** The lsn the next object will take (memory_lsn.next). A read only; the writer takes lsns inside writeLineage. 0 when the table is absent
 * (a file below v10). */
export function currentLsn(db: DatabaseSync): number {
  try { return Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()?.next ?? 0); }
  catch { return 0; }
}

// ---- statements: cached per connection, counted (the flatness tests compare the counts at 1k and 100k lines of history) ----
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
const stats = { statements: 0, rows: 0 };
/** Statements run and rows read by the writers since the last reset (flatness tests). */
export function lineageWriteStats(): { statements: number; rows: number } { return { ...stats }; }
export function resetLineageWriteStats(): void { stats.statements = 0; stats.rows = 0; }
function stmt(db: DatabaseSync, sql: string): StatementSync {
  let byDb = statements.get(db);
  if (!byDb) statements.set(db, byDb = new Map());
  let prepared = byDb.get(sql);
  if (!prepared) byDb.set(sql, prepared = db.prepare(sql));
  return prepared;
}
type Row = Record<string, unknown>;
function get(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row | undefined {
  stats.statements++;
  const row = stmt(db, sql).get(...args) as Row | undefined;
  if (row) stats.rows++;
  return row;
}
function all(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): Row[] {
  stats.statements++;
  const rows = stmt(db, sql).all(...args) as Row[];
  stats.rows += rows.length;
  return rows;
}
function run(db: DatabaseSync, sql: string, ...args: Array<string | number | null>): number {
  stats.statements++;
  return Number(stmt(db, sql).run(...args).changes);
}

const SQL = {
  takeLsn: "UPDATE memory_lsn SET next=next+1 WHERE id=1 RETURNING next-1 AS lsn",
  rowByMessage: "SELECT lsn,turn_lsn,mem_lsn,footprint FROM memory_line_lineage WHERE thread_no=? AND message_id=?",
  head: "SELECT lsn,mem_lsn,footprint FROM memory_line_lineage WHERE thread_no=? ORDER BY lsn DESC LIMIT 1",
  headAt: "SELECT lsn,mem_lsn,footprint FROM memory_line_lineage WHERE thread_no=? AND lsn<=? ORDER BY lsn DESC LIMIT 1",
  nextLsn: "SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND lsn>? ORDER BY lsn LIMIT 1",
  insertRow: "INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,?,?)",
  updateRow: "UPDATE memory_line_lineage SET mem_lsn=?, footprint=? WHERE thread_no=? AND lsn=?",
  carry: "INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,?,?,?)",
  flow: "INSERT OR IGNORE INTO memory_thread_flow(from_thread,to_thread,first_lsn) VALUES(?,?,?)",
  scopes: "SELECT scope_id FROM memory_scope_sets WHERE set_id=?",
  scopeKey: "SELECT set_id FROM memory_scope_set_keys WHERE hash=?",
  nextSet: "SELECT COALESCE(MAX(set_id),0)+1 AS id FROM memory_scope_set_keys",
  insertKey: "INSERT INTO memory_scope_set_keys(hash,set_id) VALUES(?,?)",
  insertScope: "INSERT INTO memory_scope_sets(set_id,scope_id) VALUES(?,?)",
  threadReady: "SELECT ready FROM memory_lineage_thread_ready WHERE thread_id=?",
  certReady: "SELECT ready FROM memory_lineage_cert WHERE id=1",
  setNotReady: "INSERT INTO memory_lineage_thread_ready(thread_id,ready) VALUES(?,0) ON CONFLICT(thread_id) DO UPDATE SET ready=0",
  capture: "INSERT OR IGNORE INTO memory_line_capture(thread_no,lsn,source_id) VALUES(?,?,?)",
  // S6 rule 26: door_epoch is written on INSERT only (the fresh session.started stamp, else NULL); ON CONFLICT never touches it
  session: "INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn,door_epoch) VALUES(?,?,?,?,?,CASE WHEN ?=1 THEN (SELECT value FROM memory_lineage_lsn_meta WHERE key='reader_door_epoch') END) ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET last_lsn=MAX(last_lsn,excluded.last_lsn)",
  // a line the turn's engine generated: its session ran to that line (it holds its own words), so the walk's session stage reaches it
  sessionAdvance: "UPDATE memory_session_lineage SET last_lsn=MAX(last_lsn,?) WHERE thread_id=? AND driver_instance=? AND native_session=?",
  // the marker's session rule (revoke-marker.ts rangeNode, sess stage) over the thread's deny ranges, for a session row written after the
  // walk passed the thread: begun before the range's cap and run to or past its line. Ranges per thread are bounded (DENY_RANGE_COALESCE),
  // and only ranges capped after this turn's head match: one index range on the primary key.
  sessionMarks: "INSERT OR IGNORE INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) SELECT ?1,?2,?3,d.revoke_id FROM memory_deny_range d WHERE d.thread_id=?1 AND d.from_lsn<=?4 AND d.until_turn_lsn>?5 AND NOT EXISTS (SELECT 1 FROM memory_revoke_jobs j WHERE j.revoke_id=d.revoke_id AND j.state IN ('undoing','undone'))",
} as const;
/** The writer's statements, for the plan test (every one an index seek). */
export const LINEAGE_WRITE_SQL: Readonly<Record<string, string>> = SQL;

let savepoints = 0;
/** Runs `work` under a savepoint of the caller's transaction: on any error nothing it wrote stays, and the caller gets `fallback`. A line
 * with no lineage row reads "checking" (withheld), so a failed write never shows anything. */
function atomically<T>(tx: DatabaseSync, what: string, fallback: T, work: () => T): T {
  const point = `lineage_${++savepoints}`;
  try { tx.exec(`SAVEPOINT ${point}`); }
  catch (error) { warn(what, error); return fallback; }
  try {
    const out = work();
    tx.exec(`RELEASE ${point}`);
    return out;
  } catch (error) {
    try { tx.exec(`ROLLBACK TO ${point}`); tx.exec(`RELEASE ${point}`); } catch { /* the outer transaction rolls back */ }
    warn(what, error);
    return fallback;
  }
}
function warn(what: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such table: memory_/.test(message)) return; // a file below v10: nothing is recorded, every generated line reads checking
  console.warn(`[memory] ${what} not recorded (${message.slice(0, 120)}); the line reads "checking"`);
}

// ---- running values: mem_lsn (oldest receipt in the ancestry) and footprint (interned scope set) ----
interface Fold { memLsn: number | null; star: boolean; scopes: Set<string> }
const emptyFold = (): Fold => ({ memLsn: null, star: false, scopes: new Set() });
/** Whether a running mem_lsn is already below the install-wide watermark (the newest policy or deletion bump): deny-read.ts withholds such a line. */
function belowWatermark(tx: DatabaseSync, memLsn: unknown): boolean {
  if (memLsn === null || memLsn === undefined) return false;
  const row = get(tx, "SELECT max(value) AS w FROM memory_lineage_lsn_meta WHERE key IN ('policy_bump_lsn','epoch_bump_lsn')");
  return row !== undefined && row.w !== null && row.w !== undefined && Number(memLsn) < Number(row.w);
}
function foldMem(fold: Fold, memLsn: unknown) {
  if (memLsn === null || memLsn === undefined) return;
  const value = Number(memLsn);
  fold.memLsn = fold.memLsn === null ? value : Math.min(fold.memLsn, value);
}
/** Folds an interned footprint into `fold`: one indexed read of at most FOOTPRINT_SCOPE_CAP rows. */
function foldSet(tx: DatabaseSync, fold: Fold, setId: unknown) {
  if (setId === null || setId === undefined || fold.star) return;
  const id = Number(setId);
  if (id === FOOTPRINT_STAR) { fold.star = true; return; }
  for (const row of all(tx, SQL.scopes, id)) fold.scopes.add(String(row.scope_id));
}
function foldUnknown(fold: Fold) { fold.memLsn = Math.min(fold.memLsn ?? 0, 0); fold.star = true; }
function mergeInto(into: Fold, from: Fold) {
  foldMem(into, from.memLsn);
  if (from.star) into.star = true;
  for (const scope of from.scopes) into.scopes.add(scope);
}
/** The footprint column for a fold: null (no memory), FOOTPRINT_STAR, the base set unchanged, or a newly interned set. */
function footprintOf(tx: DatabaseSync, fold: Fold): number | null {
  if (fold.star) return FOOTPRINT_STAR;
  if (fold.scopes.size === 0) return null;
  return internFootprint(tx, [...fold.scopes]);
}

/** Interns a scope set and returns its set id; more than FOOTPRINT_SCOPE_CAP scopes intern to FOOTPRINT_STAR. An empty set has no id: the
 * caller stores NULL; asked anyway, it answers FOOTPRINT_STAR (fail closed). */
export function internFootprint(tx: DatabaseSync, scopeIds: readonly string[]): number {
  const scopes = [...new Set(scopeIds)].sort();
  if (scopes.length === 0 || scopes.length > FOOTPRINT_SCOPE_CAP) return FOOTPRINT_STAR;
  const hash = createHash("sha256").update(scopes.join("\u0000")).digest("hex");
  const known = get(tx, SQL.scopeKey, hash);
  if (known) return Number(known.set_id);
  const id = Number(get(tx, SQL.nextSet)!.id);
  run(tx, SQL.insertKey, hash, id);
  for (const scope of scopes) run(tx, SQL.insertScope, id, scope);
  return id;
}

/** Reserves `count` consecutive lsns in `tx` and returns the first (the U1 backfill assigns lsns in messages_at order). */
export function reserveLsns(tx: DatabaseSync, count: number): number {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("reserveLsns: count must be a positive integer");
  const row = get(tx, "UPDATE memory_lsn SET next=next+? WHERE id=1 RETURNING next-? AS first", count, count);
  if (!row) throw new Error("INVALID_MEMORY_LINEAGE_META: memory_lsn has no counter");
  return Number(row.first);
}
function takeLsn(tx: DatabaseSync): number {
  const row = get(tx, SQL.takeLsn);
  if (!row) throw new Error("INVALID_MEMORY_LINEAGE_META: memory_lsn has no counter");
  return Number(row.lsn);
}
/** A revoke commit's own lsn (revoke-commit.ts commitRevoke, openBulkRevoke): the commit takes a slot of its own, in `tx`, so the cap it
 * records is that slot and every prompt built after it has a head (currentLsn - 1, openTurnLineage) at or above the cap. Without its own
 * slot, a turn opened after the commit with no new line in the thread had the same head as one opened before it, and the walk marked its
 * fresh session as one that held the revoked line (1.0.3 engine-switch). */
export function takeCommitLsn(tx: DatabaseSync): number { return takeLsn(tx); }

/** The thread's lineage is complete (deny-read.ts lineageThreadReady: the certificate is ready and no import marked the thread not ready). */
function threadReady(tx: DatabaseSync, threadId: string): boolean {
  if (Number(get(tx, SQL.certReady)?.ready ?? 0) !== 1) return false;
  const row = get(tx, SQL.threadReady, threadId);
  return !row || Number(row.ready) === 1;
}

/** The key that dedupes a ref (a turn's parents and a line's applied refs). */
export function lineageRefKey(ref: LineageRef): string {
  switch (ref.kind) {
    case "line": return `l\u0000${ref.threadId}\u0000${ref.messageId}`;
    case "prefix": return `p\u0000${ref.threadId}\u0000${ref.headLsn ?? ""}`;
    case "memory": return `m\u0000${memoryRefKey(ref.ref)}\u0000${ref.ref.scopeId ?? ""}`;
    case "receipt": return `r\u0000${ref.bundleId}`;
    case "none": return `n\u0000${ref.reason}`;
  }
}
function dedupe(refs: readonly LineageRef[]): LineageRef[] {
  const seen = new Set<string>(), out: LineageRef[] = [];
  for (const ref of refs) { const key = lineageRefKey(ref); if (!seen.has(key)) { seen.add(key); out.push(ref); } }
  return out;
}

// ---- refs resolved into ranges ----
/** What a set of refs comes to at write: the carried ranges of parent lines (other threads only), the fold of their running values and of
 * the memory and receipts, the flow sources, and the memory and receipt refs inheritance looks up. */
interface Resolved { ranges: CarryRange[]; fold: Fold; flowThreads: Set<string>; flowScopes: Set<string>; others: LineageRef[] }

/** Resolves refs (`ownThread`'s own lines are positional and skipped). Point refs of one thread merge into runs: two shown lines are one
 * range when no line of their thread lies between them (one seek per gap), so a range never names a line whose words were not shown.
 * A prefix covers every point at or below its head. Cost: a fixed number of seeks per ref; rows written per run. */
function resolveRefs(tx: DatabaseSync, ownThread: string | null, refs: readonly LineageRef[]): Resolved {
  const out: Resolved = { ranges: [], fold: emptyFold(), flowThreads: new Set(), flowScopes: new Set(), others: [] };
  const points = new Map<string, number[]>(), prefixes = new Map<string, number>(), unknown = new Set<string>();
  for (const ref of refs) {
    switch (ref.kind) {
      case "line": {
        if (ref.threadId === ownThread) break;
        out.flowThreads.add(ref.threadId);
        const no = threadNo(tx, ref.threadId);
        const parent = no === null ? undefined : get(tx, SQL.rowByMessage, no, ref.messageId);
        if (!parent) { unknown.add(ref.threadId); foldUnknown(out.fold); break; }
        foldMem(out.fold, parent.mem_lsn); foldSet(tx, out.fold, parent.footprint);
        const list = points.get(ref.threadId) ?? [];
        list.push(Number(parent.lsn)); points.set(ref.threadId, list);
        break;
      }
      case "prefix": {
        if (ref.threadId === ownThread) break;
        out.flowThreads.add(ref.threadId);
        if (!threadReady(tx, ref.threadId)) { unknown.add(ref.threadId); foldUnknown(out.fold); break; }
        const no = threadNo(tx, ref.threadId);
        const head = no === null ? undefined : ref.headLsn === undefined ? get(tx, SQL.head, no) : get(tx, SQL.headAt, no, ref.headLsn);
        if (head) { foldMem(out.fold, head.mem_lsn); foldSet(tx, out.fold, head.footprint); }
        const at = ref.headLsn ?? (head ? Number(head.lsn) : null);
        if (at !== null) prefixes.set(ref.threadId, Math.max(prefixes.get(ref.threadId) ?? FIRST_LSN, at));
        break;
      }
      case "memory": {
        out.others.push(ref);
        if (!ref.ref.scopeId) { out.fold.star = true; break; }
        out.fold.scopes.add(ref.ref.scopeId); out.flowScopes.add(ref.ref.scopeId);
        break;
      }
      case "receipt": {
        out.others.push(ref);
        foldMem(out.fold, ref.lsn);
        for (const scope of ref.scopeIds) { out.fold.scopes.add(scope); out.flowScopes.add(scope); }
        break;
      }
      case "none": break;
    }
  }
  for (const thread of unknown) out.ranges.push({ threadId: thread, from: UNKNOWN_LSN, to: UNKNOWN_LSN });
  for (const [thread, head] of prefixes) out.ranges.push({ threadId: thread, from: FIRST_LSN, to: head });
  for (const [thread, list] of points) {
    const head = prefixes.get(thread);
    const lsns = [...new Set(list)].filter(lsn => head === undefined || lsn > head).sort((a, b) => a - b);
    if (!lsns.length) continue;
    const no = threadNo(tx, thread)!;
    let from = lsns[0]!, to = lsns[0]!;
    for (const lsn of lsns.slice(1)) {
      const next = get(tx, SQL.nextLsn, no, to);
      if (next && Number(next.lsn) === lsn) { to = lsn; continue; }
      out.ranges.push({ threadId: thread, from, to });
      from = to = lsn;
    }
    out.ranges.push({ threadId: thread, from, to });
  }
  return out;
}

/** Writes `resolved` onto one child: a carry per range, a flow edge per parent thread and scope, and inheritance (a denied or pending parent
 * marks or holds the child in the same transaction). */
function carryOnto(tx: DatabaseSync, child: { kind: CarryChildKind; ref: string; thread: string | null; flowTo: string | null; flowObject?: string; flowLsn: number; inherit: InheritChild }, resolved: Resolved) {
  const childNo = child.thread === null ? 0 : ensureThreadNo(tx, child.thread); // (0: the child names no thread)
  for (const range of resolved.ranges) run(tx, SQL.carry, ensureThreadNo(tx, range.threadId), range.to, range.from, CARRY_CHILD_CODE[child.kind], child.ref, childNo);
  // the objects the child read: a durable object -> consumer edge (the marker walks it when the object is denied, revoke-marker.ts objectNode),
  // and a flow edge object -> consumer thread so the pending window reaches the consumer while that walk runs
  for (const other of resolved.others) {
    if (other.kind !== "memory" || !CONSUMED_REF_KINDS.has(other.ref.kind)) continue;
    run(tx, SQL.carry, ensureThreadNo(tx, objectCarryThread(other.ref)), OBJECT_EDGE_LSN, OBJECT_EDGE_LSN, CARRY_CHILD_CODE[child.kind], child.ref, childNo);
    if (child.flowTo) run(tx, SQL.flow, objectFlowNode(other.ref), child.flowTo, child.flowLsn);
    // an object written from another object: the pending window reaches the new object (and so its readers) from the flow phase on
    if (child.flowObject && child.flowObject !== child.flowTo) run(tx, SQL.flow, objectFlowNode(other.ref), child.flowObject, child.flowLsn);
  }
  if (child.flowTo) {
    for (const thread of resolved.flowThreads) if (thread !== child.flowTo) run(tx, SQL.flow, thread, child.flowTo, child.flowLsn);
    for (const scope of resolved.flowScopes) if (scopeFlowNode(scope) !== child.flowTo) run(tx, SQL.flow, scopeFlowNode(scope), child.flowTo, child.flowLsn);
  }
  if (resolved.ranges.length || resolved.others.length) inheritMarks(tx, child.inherit, resolved.others, resolved.ranges);
}

// ---- lines ----
/** Writes the line's memory_line_lineage row (lsn from memory_lsn in the caller's transaction `tx`), its turn's carries and its own refs'
 * carries, flow edges and inherited marks, all in the writer's transaction. The token is what writeMessage requires. Owner and person
 * lines: no parents, no turn_lsn, the running values passed through.
 *
 * A line that already has a row (a redelivered event, a streamed reply growing inside its turn) keeps its lsn and turn_lsn: only what it
 * did not carry yet is added (its values only ever widen). A write that fails leaves no row (the line reads "checking") and returns a token
 * with lsn 0. */
/** The token of a line deliberately written with no lineage row (a copy past COPY_ORIGINS: withheld by having none). lsn 0. */
export function noLineageToken(threadId: string, messageId: string): LineageToken {
  return { threadId, messageId, lsn: 0 } as LineageToken;
}
export function writeLineage(tx: DatabaseSync, line: LineInput, parents: LineageParents): LineageToken {
  return lineageRow(tx, line, parents, true);
}
/** Adds refs to a line that already has a lineage row (a reply patched inside its turn, a receipt linked to it); a line with no row is left
 * without one (it keeps reading "checking": a row made now would take a position later than the line really has). */
export function extendLineage(tx: DatabaseSync, line: LineInput, parents: LineageParents): void {
  lineageRow(tx, line, parents, false);
}
function lineageRow(tx: DatabaseSync, line: LineInput, parents: LineageParents, create: boolean): LineageToken {
  const failed = { threadId: line.threadId, messageId: line.messageId, lsn: 0 } as LineageToken;
  return atomically(tx, "line lineage", failed, () => {
    const generated = line.author === "generated";
    const no = ensureThreadNo(tx, line.threadId);
    const existing = get(tx, SQL.rowByMessage, no, line.messageId);
    if (!existing && !create) return failed;
    const lsn = existing ? Number(existing.lsn) : takeLsn(tx);
    const fold = emptyFold();
    if (existing) { foldMem(fold, existing.mem_lsn); foldSet(tx, fold, existing.footprint); }
    else {
      const head = get(tx, SQL.head, no);
      // a head whose receipts are already older than the policy or deletion watermark is withheld on its own; the new line was built without
      // it, so it does not inherit the stale value (else every later reply of the thread reads "watermark" for good)
      if (head) { if (!belowWatermark(tx, head.mem_lsn)) foldMem(fold, head.mem_lsn); foldSet(tx, fold, head.footprint); }
    }
    const before = { mem: fold.memLsn, star: fold.star, size: fold.scopes.size };
    // the turn a line is attached to is the one turn whose engine produced it (DESIGN-WRITETIME 2.3, 1.0.3 lifecycle card): a line already
    // written before the turn opened (a routine card, a notice patched now) is not that turn's output, and a merge over several open turns
    // (several members', or one member's earlier and newer turn) is no one turn. Neither makes a turn an inherit child or advances its
    // sessions; a merge's parents stay on the line as its own refs.
    const offered = generated ? parents.turn : undefined;
    const merged = offered !== undefined && openTurnsOf(offered).length > 1;
    const turn = offered && !merged && (!existing || Number(existing.lsn) > offered.turnLsn) ? offered : undefined;
    // a merge is no one turn, but its line began no later than the earliest of them: it takes the merged turn's turnLsn (the lowest,
    // runningTurnFor) or the caller's `began` (message-db.ts unattributedBegan), so a revoke committed between the merged turns still holds
    // it (deny-read.ts pendingWindows) and its ranges reach it
    const began = turn ? turn.turnLsn : merged ? offered!.turnLsn : parents.began;
    const turnLsn = existing ? (existing.turn_lsn === null || existing.turn_lsn === undefined ? null : Number(existing.turn_lsn))
      : generated ? (began !== undefined && began >= 0 ? Math.min(began, lsn - 1) : lsn - 1) : null;
    // the turn's sessions ran to this line: a revoke of the line itself (a forget of the reply as a source) reaches them at the walk's
    // session stage (last_lsn >= a). Without it a session row written before the reply (session.started, a resume) ended below the reply,
    // and the engine that generated the revoked line resumed holding it (1.0.3 engine-switch).
    if (generated && turn) for (const session of turnSessions(turn)) if (session.threadId === line.threadId) run(tx, SQL.sessionAdvance, lsn, session.threadId, session.driverInstance, session.nativeSession);
    if (generated && turn && turn.parents.length) {
      // the turn's carries: resolved once per turn, written idempotently by each of its lines (no new rows after the first)
      const resolved = turnResolved(tx, turn);
      const key = turnLsn ?? turn.turnLsn;
      ownCarry(tx, turn, () => carryOnto(tx, { kind: "turn", ref: turnChildRef(key), thread: line.threadId, flowTo: line.threadId, flowLsn: lsn, inherit: { kind: "turn", threadId: line.threadId, lsn: key, ...(existing ? {} : { holdFrom: lsn }) } }, resolved));
      mergeInto(fold, resolved.fold);
    }
    const own = generated ? dedupe([...(parents.refs ?? []), ...(merged ? offered!.parents : [])]) : [];
    if (own.length) {
      const resolved = resolveRefs(tx, line.threadId, own);
      // what a written row quotes from now on (quotedNow) is new content at this write: a revoke it rests on holds and walks the thread from
      // now, never from the row's old position (a prompt built before now could not hold it), while the row itself is marked at its own lsn
      ownCarry(tx, generated ? turn : undefined, () => carryOnto(tx, { kind: "line", ref: lineChildRef(lsn), thread: line.threadId, flowTo: line.threadId, flowLsn: lsn, inherit: { kind: "line", threadId: line.threadId, lsn, ...(existing && parents.quotedNow ? { fromNow: true } : {}) } }, resolved));
      mergeInto(fold, resolved.fold);
    }
    if (existing) {
      if (fold.memLsn !== before.mem || fold.star !== before.star || fold.scopes.size !== before.size) run(tx, SQL.updateRow, fold.memLsn, footprintOf(tx, fold), no, lsn);
    } else run(tx, SQL.insertRow, no, lsn, line.messageId, turnLsn, fold.memLsn, footprintOf(tx, fold));
    return { threadId: line.threadId, messageId: line.messageId, lsn } as LineageToken;
  });
}

/** Marks a thread not ready (the legacy-file import, restore, merge and archive import: its lines are judged only once the backfill has
 * passed it). */
export function markThreadNotReady(tx: DatabaseSync, threadId: string): void {
  atomically(tx, "thread readiness", undefined, () => { run(tx, SQL.setNotReady, threadId); });
}

/** An imported thread is re-sequenced when it is written (message-db.ts importLegacy sorts the file by time, so lsn order is time order) and
 * made ready here once the certificate is: every line has its row, and the rows' lsn order agrees with the lines' time order (an import that
 * was written out of order stays not ready: its positional ranges could not be trusted, so its generated lines keep reading "checking").
 * True when the thread is ready afterwards. Reads the thread's own rows once. */
export function readyImportedThread(tx: DatabaseSync, threadId: string): boolean {
  return atomically(tx, "thread readiness", false, () => {
    if (Number(get(tx, SQL.certReady)?.ready ?? 0) !== 1) return false;
    const no = threadNo(tx, threadId);
    if (no !== null) {
      const unordered = get(tx, `SELECT 1 AS x FROM (SELECT m.at AS at, lag(m.at) OVER (ORDER BY l.lsn) AS prev FROM memory_line_lineage l JOIN messages m ON m.thread_id=? AND m.id=l.message_id WHERE l.thread_no=?) WHERE prev IS NOT NULL AND at<prev LIMIT 1`, threadId, no);
      if (unordered) return false;
    }
    run(tx, "INSERT INTO memory_lineage_thread_ready(thread_id,ready) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET ready=1", threadId);
    return true;
  });
}
/** Every thread an import marked not ready, made ready when its order allows (the transaction that drains U2 calls this for the threads
 * imported while the upgrade ran). A few rows: one per import. */
export function readyImportedThreads(tx: DatabaseSync): number {
  let ready = 0;
  for (const row of all(tx, "SELECT thread_id FROM memory_lineage_thread_ready WHERE ready=0 LIMIT 1024")) if (readyImportedThread(tx, String(row.thread_id))) ready++;
  return ready;
}

// ---- the running turns ----
interface OpenTurn extends TurnLineage { parents: LineageRef[]; ownKey: string; keys: Set<string>; resolved?: { count: number; value: Resolved }; sessions?: SessionKey[]; providers?: Set<string> }
/** The deny_generation values the running turns' own writes produced (ownCarry), one row per value, in a TEMP table on the writing
 * connection. Written in the same transaction as the bump, so a rollback (an atomically() savepoint, or the caller's transaction) takes the
 * row with it: a value a rolled-back write held and a later revoke reuses is never the turn's own (Astra 1.0.3 rollback High). Values are
 * exact, never a count, so nothing can drift. */
const OWN_GENERATIONS_DDL = "CREATE TEMP TABLE IF NOT EXISTS memory_own_generation(turn_key TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(turn_key, generation)) WITHOUT ROWID";
/** A write the turn makes itself (its session row, its lines' carries): the deny_generation values its inheritance produced are recorded as
 * the turn's own, so the send fence does not take them for a revoke committed since its prompt was built (1.0.2 Keep all P0). */
function ownCarry(tx: DatabaseSync, turn: TurnLineage | undefined, work: () => void): void {
  if (!turn) { work(); return; }
  const before = denyGeneration(tx);
  work();
  const after = denyGeneration(tx);
  if (before < 0 || after <= before) return;
  const owners = openTurnsOf(turn);
  if (!owners.length) return;
  tx.exec(OWN_GENERATIONS_DDL);
  const insert = tx.prepare("INSERT OR IGNORE INTO temp.memory_own_generation(turn_key, generation) VALUES(?, ?)");
  for (const open of owners) for (let generation = before + 1; generation <= after; generation++) insert.run(open.ownKey, generation);
}
/** How many deny_generation values in (above, upTo] the turn's own committed writes produced (ownCarry). 0 outside one open turn, or when
 * nothing was recorded on this connection: the fence then looks the parts up again. */
export function turnOwnGenerations(db: DatabaseSync, turn: TurnLineage, above: number, upTo: number): number {
  const open = openTurnsOf(turn);
  if (open.length !== 1 || upTo <= above) return 0;
  try {
    return Number(db.prepare("SELECT count(*) AS n FROM temp.memory_own_generation WHERE turn_key=? AND generation>? AND generation<=?").get(open[0]!.ownKey, above, upTo)?.n ?? 0);
  } catch { return 0; }
}
/** Drops the recorded values of turns no longer open (a closed turn's values are never read again). */
function pruneOwnGenerations(db: DatabaseSync): void {
  const live = [...openTurns.values()].flatMap(byTurn => [...byTurn.values()].map(open => open.ownKey));
  try {
    if (!live.length) db.exec("DELETE FROM temp.memory_own_generation");
    else db.prepare(`DELETE FROM temp.memory_own_generation WHERE turn_key NOT IN (${live.map(() => "?").join(",")})`).run(...live);
  } catch { /* no table yet: nothing recorded */ }
}
/** Open turns by thread, then by turn id. A room thread can hold one per member. */
const openTurns = new Map<string, Map<string, OpenTurn>>();
const isOpenTurn = (turn: TurnLineage): turn is OpenTurn => Array.isArray(turn.parents) && (turn as OpenTurn).keys instanceof Set;
/** The turn positions (turnLsn) of every open turn of this process, distinct and sorted. Turns run concurrently (one entry per turn per
 * thread above), so the revoke fold (revoke-fold.ts) tests each of them against a cohort's interval, never only the least
 * (REVOKE-FOLD-DESIGN r4 A1). */
export function openTurnPositions(): number[] {
  const out = new Set<number>();
  for (const byTurn of openTurns.values()) for (const open of byTurn.values()) out.add(open.turnLsn);
  return [...out].sort((a, b) => a - b);
}
/** The member turns a merged turn (runningTurnFor over several open turns) was made of. */
const mergedTurns = new WeakMap<TurnLineage, readonly OpenTurn[]>();
/** The open turns `turn` stands for: itself, or every member of a merged turn. */
function openTurnsOf(turn: TurnLineage): readonly OpenTurn[] {
  const open = openTurns.get(turn.threadId)?.get(turn.turnId) ?? (isOpenTurn(turn) ? turn : undefined);
  return open ? [open] : mergedTurns.get(turn) ?? [];
}
/** The engine sessions the turn ran in (writeSessionLineage records them): every line it generates advances their last_lsn. A merged turn
 * advances every member's (an over-attribution only ever resets more). */
function turnSessions(turn: TurnLineage): SessionKey[] {
  return openTurnsOf(turn).flatMap(open => open.sessions ?? []);
}

/** The turn's parents resolved into ranges, kept on the open turn until it gains parents. */
function turnResolved(tx: DatabaseSync, turn: TurnLineage): Resolved {
  const open = openTurns.get(turn.threadId)?.get(turn.turnId) ?? (isOpenTurn(turn) ? turn : undefined);
  if (open?.resolved && open.resolved.count === open.parents.length) return open.resolved.value;
  const value = resolveRefs(tx, turn.threadId, dedupe(turn.parents));
  if (open) open.resolved = { count: open.parents.length, value };
  return value;
}

/** A turn id for a member's turn: `${botId}\u0000<unique>`, so the turns of one member in one thread can be told apart from another's. */
export function memberTurnId(botId: string): string { return `${botId}\u0000${randomUUID()}`; }
const memberOf = (turnId: string): string => turnId.split("\u0000", 1)[0]!;

/** Starts the running turn's lineage when its prompt is built: turnLsn = the head lsn (currentLsn - 1: every line the prompt can hold is at
 * or below it), denyGeneration = deny-read.ts denyGeneration. The turn is registered for its thread until closeTurnLineage. */
export function openTurnLineage(db: DatabaseSync, turn: { threadId: string; turnId: string }): TurnLineage {
  const next = currentLsn(db);
  const open: OpenTurn = { threadId: turn.threadId, turnId: turn.turnId, turnLsn: Math.max(0, next - 1), parents: [], ownKey: randomUUID(), keys: new Set(), denyGeneration: denyGeneration(db) };
  let byTurn = openTurns.get(turn.threadId);
  if (!byTurn) openTurns.set(turn.threadId, byTurn = new Map());
  byTurn.set(turn.turnId, open);
  pruneOwnGenerations(db);
  return open;
}

/** The running turn of a thread (the most recently opened), or undefined outside any turn (a tool called from the owner UI records nothing). */
export function currentTurnLineage(threadId: string): TurnLineage | undefined {
  const byTurn = openTurns.get(threadId);
  if (!byTurn?.size) return undefined;
  return [...byTurn.values()].at(-1);
}

/** What a line written now in `threadId` rests on: the open turn of that member (memberBotId) when there is one, otherwise every open turn of
 * the thread merged (an over-attribution only ever withholds more). The merged turn's turnLsn is the lowest. Undefined outside any turn. */
export function runningTurnFor(threadId: string, memberBotId?: string): TurnLineage | undefined {
  const byTurn = openTurns.get(threadId);
  if (!byTurn?.size) return undefined;
  const turns = [...byTurn.values()];
  const member = memberBotId ? turns.filter(turn => memberOf(turn.turnId) === memberBotId) : [];
  const chosen = member.length ? member : turns;
  if (chosen.length === 1) return chosen[0];
  const parents = dedupe(chosen.flatMap(turn => turn.parents));
  const merged: TurnLineage = { threadId, turnId: chosen.map(turn => turn.turnId).join(","), turnLsn: Math.min(...chosen.map(turn => turn.turnLsn)), parents, denyGeneration: Math.min(...chosen.map(turn => turn.denyGeneration)) };
  mergedTurns.set(merged, chosen);
  return merged;
}

/** The lineage turn each provider turn ran as, by thread then provider turn id (bindProviderTurn). Kept past a supersede, so a late line of
 * an earlier turn still finds the turn that produced it and never the member's newer one; the newest PROVIDER_TURNS_KEPT per thread. */
const providerTurns = new Map<string, Map<string, OpenTurn>>();
const PROVIDER_TURNS_KEPT = 16;
/** Names the provider turn a dispatch was accepted as (index.ts, at acceptance): its lines are attached to `turn` by that id. */
export function bindProviderTurn(turn: TurnLineage, providerTurnId: string | undefined): void {
  const open = openTurns.get(turn.threadId)?.get(turn.turnId) ?? (isOpenTurn(turn) ? turn : undefined);
  if (!open || !providerTurnId) return;
  let byProvider = providerTurns.get(turn.threadId);
  if (!byProvider) providerTurns.set(turn.threadId, byProvider = new Map());
  byProvider.delete(providerTurnId);
  byProvider.set(providerTurnId, open);
  (open.providers ??= new Set()).add(providerTurnId);
  while (byProvider.size > PROVIDER_TURNS_KEPT) byProvider.delete(byProvider.keys().next().value!);
}
/** The parents of every open turn a line names no one turn of: the member's (memberBotId), or with no member named the thread's; empty
 * when that member has none open. What such a line rests on as its own refs (message-db.ts unattributedRefs), never a turn it is attached to. */
export function openTurnsParents(threadId: string, memberBotId?: string): LineageRef[] {
  const turns = [...(openTurns.get(threadId)?.values() ?? [])].filter(turn => !memberBotId || memberOf(turn.turnId) === memberBotId);
  return dedupe(turns.flatMap(turn => turn.parents));
}
/** The lowest turn lsn of the turns open in `threadId` (of `memberBotId` when given), or undefined when none is open. */
export function openTurnsBegan(threadId: string, memberBotId?: string): number | undefined {
  const turns = [...(openTurns.get(threadId)?.values() ?? [])].filter(turn => !memberBotId || memberOf(turn.turnId) === memberBotId);
  return turns.length ? Math.min(...turns.map(turn => turn.turnLsn)) : undefined;
}
/** The lineage turn a provider turn was bound to (bindProviderTurn), or undefined. */
export function turnOfProvider(threadId: string, providerTurnId: string | undefined): TurnLineage | undefined {
  return providerTurnId ? providerTurns.get(threadId)?.get(providerTurnId) : undefined;
}

/** Every turn a provider turn id was bound to, in any conversation. A line Murage mirrors into another conversation (a room copy of a bot's
 * message) names the turn that wrote its words, which runs in the sender's conversation. Provider turn ids are unique, so this is one turn; if
 * an id ever repeats the line rests on all of them (an over-attribution only withholds more). */
export function turnsOfProviderAnywhere(providerTurnId: string | undefined): TurnLineage[] {
  if (!providerTurnId) return [];
  const found: TurnLineage[] = [];
  for (const byId of providerTurns.values()) { const turn = byId.get(providerTurnId); if (turn && !found.includes(turn)) found.push(turn); }
  return found;
}

/** The one turn a line written now in `threadId` is the engine output of, by turn id: the lineage turn its provider turn (providerTurnId, the
 * row's turnId) was bound to, when it is that member's (memberBotId). With no binding, the member's only open turn (with no member named, the
 * thread's only open turn) unless that turn is bound to other provider turns only. Undefined when no one turn is named: the member (or the
 * thread) holds several open turns, an earlier one and the newer that superseded it included. Never a merge of open turns: a line is
 * attached to no turn but its producer (message-db.ts lineTurnOf; lineageRow refuses any merge). */
export function writerTurnFor(threadId: string, memberBotId?: string, providerTurnId?: string): TurnLineage | undefined {
  const bound = turnOfProvider(threadId, providerTurnId);
  if (bound) return !memberBotId || memberOf(bound.turnId) === memberBotId ? bound : undefined;
  const byTurn = openTurns.get(threadId);
  if (!byTurn?.size) return undefined;
  const candidates = [...byTurn.values()].filter(turn => !memberBotId || memberOf(turn.turnId) === memberBotId);
  const only = candidates.length === 1 ? candidates[0] : undefined;
  return only && (!providerTurnId || !only.providers?.size) ? only : undefined;
}

/** Ends the running turn (its replies and session are written). */
export function closeTurnLineage(turn: TurnLineage): void {
  const byTurn = openTurns.get(turn.threadId);
  if (!byTurn) return;
  byTurn.delete(turn.turnId);
  if (!byTurn.size) openTurns.delete(turn.threadId);
}

/** Closes every other open turn of the same member in the same thread (a new dispatch replaces the member's earlier turn). */
export function supersedeMemberTurns(turn: TurnLineage): void {
  const byTurn = openTurns.get(turn.threadId);
  if (!byTurn) return;
  const member = memberOf(turn.turnId);
  for (const [id] of byTurn) if (id !== turn.turnId && memberOf(id) === member) byTurn.delete(id);
}

/** Every open turn of a thread ends (the conversation was deleted). */
export function closeThreadTurns(threadId: string): void { openTurns.delete(threadId); providerTurns.delete(threadId); }

/** Adds what the engine was shown during the turn: prompt parts (buildPrompt calls it), tool results, steer quotes (a steer adds parents,
 * never moves turnLsn), receipts. Any role, owner lines included. */
export function addTurnParents(turn: TurnLineage, refs: readonly LineageRef[]): void {
  const open = openTurns.get(turn.threadId)?.get(turn.turnId) ?? (isOpenTurn(turn) ? turn : undefined);
  if (!open) return;
  for (const ref of refs) {
    const key = lineageRefKey(ref);
    if (open.keys.has(key)) continue;
    open.keys.add(key);
    open.parents.push(ref);
  }
}

// ---- objects, captures, sessions ----
/** A note, record, lesson, PIP claim or feedback written by a bot in a turn: a prefix range of the turn's thread (up to its head now, never
 * below turnLsn) onto the object, plus the turn's cross-thread parents' ranges; a record of a known scope is a node of the flow closure
 * (the turn's thread and every parent flow into its scope). Inheritance: a denied or pending parent marks or holds the object now. */
export function writeRecordLineage(tx: DatabaseSync, record: MemoryRef, turn: TurnLineage): void {
  atomically(tx, "record lineage", undefined, () => {
    const now = currentLsn(tx);
    const head = Math.max(turn.turnLsn, now - 1);
    const prefix: CarryRange = threadReady(tx, turn.threadId) ? { threadId: turn.threadId, from: FIRST_LSN, to: head } : { threadId: turn.threadId, from: UNKNOWN_LSN, to: UNKNOWN_LSN };
    const parents = turnResolved(tx, turn);
    const resolved: Resolved = { ranges: [prefix, ...parents.ranges], fold: parents.fold, flowThreads: new Set([turn.threadId, ...parents.flowThreads]), flowScopes: parents.flowScopes, others: parents.others };
    const scopeNode = record.scopeId ? scopeFlowNode(record.scopeId) : null;
    carryOnto(tx, { kind: "record", ref: recordChildRef(record), thread: null, flowTo: scopeNode, ...(CONSUMED_REF_KINDS.has(record.kind) ? { flowObject: objectFlowNode(record) } : {}), flowLsn: Math.max(1, now), inherit: { kind: "record", ref: record, lsn: Math.max(1, now) } }, resolved);
    // an object others read: the threads it rests on flow into its node, which flows into its consumers' threads (carryOnto)
    if (CONSUMED_REF_KINDS.has(record.kind)) for (const thread of resolved.flowThreads) run(tx, SQL.flow, thread, objectFlowNode(record), Math.max(1, now));
  });
}

/** An object written outside any thread's turn from what it was shown (a procedure review publishing a skill revision over its evidence):
 * ranges of each ref onto the object, no prefix. Same encoding, flow edges and inheritance as writeRecordLineage. */
export function writeObjectLineage(tx: DatabaseSync, record: MemoryRef, refs: readonly LineageRef[]): void {
  atomically(tx, "object lineage", undefined, () => {
    const now = Math.max(1, currentLsn(tx));
    const scopeNode = record.scopeId ? scopeFlowNode(record.scopeId) : null;
    carryOnto(tx, { kind: "record", ref: recordChildRef(record), thread: null, flowTo: scopeNode, ...(CONSUMED_REF_KINDS.has(record.kind) ? { flowObject: objectFlowNode(record) } : {}), flowLsn: now, inherit: { kind: "record", ref: record, lsn: now } }, resolveRefs(tx, null, dedupe(refs)));
  });
}

/** A message becoming a memory source: memory_line_capture(thread, lsn, source). A line with no lineage row is captured at UNKNOWN_LSN, which
 * every range of its thread reaches. (The thread -> scope flow edge is the v10 memory_flow_capture trigger's.) */
export function writeCaptureLineage(tx: DatabaseSync, line: { threadId: string; messageId: string }, sourceId: string): void {
  atomically(tx, "capture lineage", undefined, () => {
    const no = ensureThreadNo(tx, line.threadId);
    const row = get(tx, SQL.rowByMessage, no, line.messageId);
    run(tx, SQL.capture, no, row ? Number(row.lsn) : UNKNOWN_LSN, sourceId);
  });
}

/** The turn's session: memory_session_lineage.last_lsn moves (first_lsn is set once: the head its first prompt was built on, turnLsn, so
 * [first_lsn, last_lsn] is the span of lines the session ran across; the marker's session stage reads it so); the turn's cross-thread
 * ranges also carry onto the session, and a denied or pending parent marks or holds it now. True once the row is written; false when a
 * statement failed and nothing stayed, so the caller withholds the session's resume cursor (a COMMIT failure throws from the transaction). */
/** `fresh`: the session.started of a turn started with no cursor (S6 rule 26) stamps the door epoch on the row it inserts; a resumed turn never does. */
export function writeSessionLineage(tx: DatabaseSync, session: SessionKey, turn: TurnLineage, fresh = false): boolean {
  // the turn runs in this session from now on: each line it generates advances the session's last_lsn (lineageRow)
  for (const open of openTurnsOf(turn)) {
    const known = open.sessions ??= [];
    if (!known.some(s => s.threadId === session.threadId && s.driverInstance === session.driverInstance && s.nativeSession === session.nativeSession)) known.push({ ...session });
  }
  return atomically(tx, "session lineage", false, () => {
    const now = Math.max(turn.turnLsn, currentLsn(tx) - 1);
    run(tx, SQL.session, session.threadId, session.driverInstance, session.nativeSession, turn.turnLsn, now, fresh ? 1 : 0);
    // a session row written after the walk's session stage for its thread (a late-handback engine writes it at session.started, after the
    // prompt was delivered): a revoke or edit committed since this turn's head whose range in the thread the session ran across marks it
    // now, in this transaction, as the walk would have. One the walk has not reached yet is marked by the walk too (INSERT OR IGNORE).
    run(tx, SQL.sessionMarks, session.threadId, session.driverInstance, session.nativeSession, now, turn.turnLsn);
    ownCarry(tx, turn, () => carryOnto(tx, { kind: "session", ref: sessionChildRef(session.driverInstance, session.nativeSession), thread: session.threadId, flowTo: session.threadId, flowLsn: Math.max(1, now), inherit: { kind: "session", session, lsn: now } },
      turnResolved(tx, turn)));
    return true;
  });
}

/** True only while `turn` itself (this object, not another with the same ids) is still the open turn of its thread (thread tools bind to the
 * dispatch's turn; a superseded or closed turn is not open). */
export function isTurnOpen(turn: TurnLineage): boolean {
  return openTurns.get(turn.threadId)?.get(turn.turnId) === turn;
}

const READS_FAILED = Symbol("recordTurnReads failed");
/** Persists what a running turn read (thread tools): for every session the turn ran in, writes what writeSessionLineage writes for `refs`
 * (the session row with the turn's turnLsn and the head now, its deny marks, the refs' carries onto the session child, inherited marks), all
 * INSERT OR IGNORE or MAX() upserts, so a repeat is additive. Never adds the refs to the turn (addTurnParents is the caller's, after commit).
 * False when a statement failed and nothing stayed (the caller throws inside its transaction); true when there is no session to persist. */
export function recordTurnReads(tx: DatabaseSync, turn: TurnLineage, refs: readonly LineageRef[]): boolean {
  const sessions = turnSessions(turn);
  if (!sessions.length) return true;
  const out = atomically<true | typeof READS_FAILED>(tx, "turn reads", READS_FAILED, () => {
    const resolved = resolveRefs(tx, turn.threadId, dedupe(refs));
    const now = Math.max(turn.turnLsn, currentLsn(tx) - 1);
    for (const session of sessions) {
      run(tx, SQL.session, session.threadId, session.driverInstance, session.nativeSession, turn.turnLsn, now);
      run(tx, SQL.sessionMarks, session.threadId, session.driverInstance, session.nativeSession, now, turn.turnLsn);
      carryOnto(tx, { kind: "session", ref: sessionChildRef(session.driverInstance, session.nativeSession), thread: session.threadId, flowTo: session.threadId, flowLsn: Math.max(1, now), inherit: { kind: "session", session, lsn: now } }, resolved);
    }
    return true;
  });
  return out !== READS_FAILED;
}
