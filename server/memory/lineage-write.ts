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
  CARRY_CHILD_CODE, FIRST_LSN, FOOTPRINT_SCOPE_CAP, FOOTPRINT_STAR, lineChildRef, memoryRefKey, recordChildRef, scopeFlowNode, sessionChildRef, turnChildRef, UNKNOWN_LSN,
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
  session: "INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES(?,?,?,?,?) ON CONFLICT(thread_id,driver_instance,native_session) DO UPDATE SET last_lsn=MAX(last_lsn,excluded.last_lsn)",
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
function carryOnto(tx: DatabaseSync, child: { kind: CarryChildKind; ref: string; thread: string | null; flowTo: string | null; flowLsn: number; inherit: InheritChild }, resolved: Resolved) {
  const childNo = child.thread === null ? null : ensureThreadNo(tx, child.thread);
  for (const range of resolved.ranges) run(tx, SQL.carry, ensureThreadNo(tx, range.threadId), range.to, range.from, CARRY_CHILD_CODE[child.kind], child.ref, childNo);
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
    else { const head = get(tx, SQL.head, no); if (head) { foldMem(fold, head.mem_lsn); foldSet(tx, fold, head.footprint); } }
    const before = { mem: fold.memLsn, star: fold.star, size: fold.scopes.size };
    const turn = generated ? parents.turn : undefined;
    const turnLsn = existing ? (existing.turn_lsn === null || existing.turn_lsn === undefined ? null : Number(existing.turn_lsn))
      : generated ? (turn && turn.turnLsn > 0 ? Math.min(turn.turnLsn, lsn - 1) : lsn - 1) : null;
    if (generated && turn && turn.parents.length) {
      // the turn's carries: resolved once per turn, written idempotently by each of its lines (no new rows after the first)
      const resolved = turnResolved(tx, turn);
      const key = turnLsn ?? turn.turnLsn;
      carryOnto(tx, { kind: "turn", ref: turnChildRef(key), thread: line.threadId, flowTo: line.threadId, flowLsn: lsn, inherit: { kind: "turn", threadId: line.threadId, lsn: key } }, resolved);
      mergeInto(fold, resolved.fold);
    }
    const own = generated ? dedupe(parents.refs ?? []) : [];
    if (own.length) {
      const resolved = resolveRefs(tx, line.threadId, own);
      carryOnto(tx, { kind: "line", ref: lineChildRef(lsn), thread: line.threadId, flowTo: line.threadId, flowLsn: lsn, inherit: { kind: "line", threadId: line.threadId, lsn } }, resolved);
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
interface OpenTurn extends TurnLineage { parents: LineageRef[]; keys: Set<string>; resolved?: { count: number; value: Resolved } }
/** Open turns by thread, then by turn id. A room thread can hold one per member. */
const openTurns = new Map<string, Map<string, OpenTurn>>();
const isOpenTurn = (turn: TurnLineage): turn is OpenTurn => Array.isArray(turn.parents) && (turn as OpenTurn).keys instanceof Set;

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
  const open: OpenTurn = { threadId: turn.threadId, turnId: turn.turnId, turnLsn: Math.max(0, next - 1), parents: [], keys: new Set(), denyGeneration: denyGeneration(db) };
  let byTurn = openTurns.get(turn.threadId);
  if (!byTurn) openTurns.set(turn.threadId, byTurn = new Map());
  byTurn.set(turn.turnId, open);
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
  return { threadId, turnId: chosen.map(turn => turn.turnId).join(","), turnLsn: Math.min(...chosen.map(turn => turn.turnLsn)), parents, denyGeneration: Math.min(...chosen.map(turn => turn.denyGeneration)) };
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
export function closeThreadTurns(threadId: string): void { openTurns.delete(threadId); }

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
    carryOnto(tx, { kind: "record", ref: recordChildRef(record), thread: null, flowTo: scopeNode, flowLsn: Math.max(1, now), inherit: { kind: "record", ref: record, lsn: Math.max(1, now) } }, resolved);
  });
}

/** An object written outside any thread's turn from what it was shown (a procedure review publishing a skill revision over its evidence):
 * ranges of each ref onto the object, no prefix. Same encoding, flow edges and inheritance as writeRecordLineage. */
export function writeObjectLineage(tx: DatabaseSync, record: MemoryRef, refs: readonly LineageRef[]): void {
  atomically(tx, "object lineage", undefined, () => {
    const now = Math.max(1, currentLsn(tx));
    const scopeNode = record.scopeId ? scopeFlowNode(record.scopeId) : null;
    carryOnto(tx, { kind: "record", ref: recordChildRef(record), thread: null, flowTo: scopeNode, flowLsn: now, inherit: { kind: "record", ref: record, lsn: now } }, resolveRefs(tx, null, dedupe(refs)));
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

/** The turn's session: memory_session_lineage.last_lsn moves (first_lsn is set once); the turn's cross-thread ranges also carry onto the
 * session, and a denied or pending parent marks or holds it now. */
export function writeSessionLineage(tx: DatabaseSync, session: SessionKey, turn: TurnLineage): void {
  atomically(tx, "session lineage", undefined, () => {
    const now = Math.max(turn.turnLsn, currentLsn(tx) - 1);
    run(tx, SQL.session, session.threadId, session.driverInstance, session.nativeSession, now, now);
    carryOnto(tx, { kind: "session", ref: sessionChildRef(session.driverInstance, session.nativeSession), thread: session.threadId, flowTo: session.threadId, flowLsn: Math.max(1, now), inherit: { kind: "session", session, lsn: now } },
      turnResolved(tx, turn));
  });
}
