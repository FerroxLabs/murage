// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy: the revoke commit and inheritance at write (DESIGN-WRITETIME 2.3, 2.8, 3). S3 owns this file, with
// memory-revocation.ts (the runner) and revoke-marker.ts (the marker's phases).
//
// A commit is one owner action, inside the caller's transaction, O(targets): the direct marks it can name (deny_line and deny_range for
// a named line, deny_memory for a forgotten object, deny_session, the thread or scope deny), the watermark keys, a memory_revoke_jobs row,
// the root nodes in memory_revoke_frontier, the pending window (deny_pending('*', root_lsn), deny_pending_scope('*', since)) with the flow
// seeds, and deny_generation += 1. The marker (revoke-marker.ts) starts in a microtask after the caller commits.
import type { DatabaseSync } from "node:sqlite";
import { currentLsn } from "./lineage-write.ts";
import { FIRST_LSN, PENDING_ALL_THREADS, scopeFlowNode, UNKNOWN_LSN, type FrontierNode, type LineageRef, type MemoryRef, type RevokeRoot, type SessionKey } from "./lineage-types.ts";
import { threadNo } from "./thread-no.ts";
import { receiptStart } from "./receipt-outputs.ts";
import { AUDIENCE_COALESCED } from "./lineage-types.ts";
import { BOUNDED_RANGE, bumpDenyGeneration, enqueueNode, hasWritetime, lineOf, markerSlice, markerWorkPending, markPending, PENDING_ALL_SCOPES, seedFlow, setFlipCommit, softVersion, st, writeLine, writeMemory, writeRange, writeSession } from "./revoke-marker.ts";
import { INLINE_REVOCATION, wakeIfStarted } from "./memory-revocation.ts";

/** Memory roots that remove the object itself (deny_memory); the others (archive, correct, revise) withdraw what was shown from it, and
 * leave the record's own visibility to its state. */
const REMOVING = new Set(["forget", "delete", "retire", "unprovable"]);
/** Removals that change the policy or the deletion epoch (the watermark moves); an unprovable source (the backfill) changes neither. */
const BUMPING = new Set(["forget", "delete", "retire"]);

function setMeta(db: DatabaseSync, key: "policy_bump_lsn" | "epoch_bump_lsn", value: number): void {
  st(db, "UPDATE memory_lineage_lsn_meta SET value=max(value,?) WHERE key=?").run(value, key);
}
const hasDenyTable = (db: DatabaseSync) => Boolean(st(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_deny'").get());
const epochNow = (db: DatabaseSync) => Number(st(db, "SELECT deletion_epoch FROM memory_meta WHERE id=1").get()?.deletion_epoch ?? 0);
/** The first lsn of a thread's lines, or (no row) 1 while the file is not certified, else the next lsn (nothing of it was written since). */
function firstLsn(db: DatabaseSync, threadId: string, now: number): number {
  const no = threadNo(db, threadId);
  const first = no === null ? undefined : st(db, "SELECT lsn FROM memory_line_lineage WHERE thread_no=? ORDER BY lsn LIMIT 1").get(no)?.lsn;
  if (first !== undefined && first !== null) return Number(first);
  return Number(st(db, "SELECT ready FROM memory_lineage_cert WHERE id=1").get()?.ready ?? 0) === 1 ? now : FIRST_LSN;
}
/** The record's created lsn (memory_record_lsn): the earliest of its versions, or 1 when unknown (made before v10). */
function recordCreated(db: DatabaseSync, id: string, version: number | undefined): number {
  const row = version && version > 0
    ? st(db, "SELECT created_lsn AS c FROM memory_record_lsn WHERE id=? AND version=?").get(id, version)
    : st(db, "SELECT created_lsn AS c FROM memory_record_lsn WHERE id=? ORDER BY version LIMIT 1").get(id);
  return row?.c === undefined || row.c === null ? FIRST_LSN : Number(row.c);
}
/** Options of one commit. `until` (line roots only): the turn lsn the root thread's range ends at instead of the commit's own lsn, for a
 * forget or hide made before now (the U2 seed of a fact from before the upgrade, when its time is known as an lsn): a generated line of the
 * thread whose turn began at or after `until` was built without the line and is not denied by position. Never above the commit's lsn. */
export interface RevokeOptions {
  readonly until?: number;
  /** Run the marker inline right after the commit, within INLINE_REVOCATION (default true): a small revoke (an identity write, a forgotten
   * recent line) is fully marked before the owner's action returns, so nothing reads "checking" for it. A large one carries on in the
   * runner. The backfill's U2 seeds pass false (its own slices bound the work). */
  readonly inline?: boolean;
  /** Add this root to an open bulk revoke (openBulkRevoke) instead of starting one of its own: the U2 seed of a 1.0.1 file. */
  readonly into?: number;
}

/** The U2 seed's bulk revoke (DESIGN-WRITETIME, U2: "every existing deny fact is a root of one bulk revoke"): one job, its roots added by
 * commitRevoke({ into }) over many slices, held 'seeding' (the marker leaves it alone, readers hold its window "checking" through its
 * pending rows) until activateBulkRevoke in the transaction that drains U2. A file with a million deny facts walks one revoke, not a
 * million (each with its own flow closure and '*' window). `audience`: its marks bind audience readers only (memory_revoke_audience). */
export function openBulkRevoke(tx: DatabaseSync, cause: string, audience: boolean): number {
  if (!hasWritetime(tx)) return 0;
  const now = currentLsn(tx);
  const R = Number(st(tx, "SELECT coalesce(max(revoke_id),0)+1 AS r FROM memory_revoke_jobs").get()!.r);
  st(tx, "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'bulk',?,?,?,'flow','','seeding')").run(R, JSON.stringify({ kind: "bulk", cause }), now, now);
  if (audience) st(tx, "INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(R);
  return R;
}
/** The bulk revoke's roots are all in: the marker walks it from its flow phase. */
export function activateBulkRevoke(tx: DatabaseSync, revokeId: number): void {
  if (!(revokeId > 0) || !hasWritetime(tx)) return;
  st(tx, "UPDATE memory_revoke_jobs SET state='active' WHERE revoke_id=? AND state='seeding'").run(revokeId);
  bumpDenyGeneration(tx);
  wakeIfStarted();
}

/** The job row's root: the root without its id lists (they are frontier nodes), so the row stays under 1 KB. */
function compactRoot(root: RevokeRoot, until?: number): string {
  switch (root.kind) {
    case "line": return JSON.stringify({ kind: root.kind, threadId: root.threadId, cause: root.cause, lines: root.messageIds.length, ...(until === undefined ? {} : { until }) });
    case "bot": return JSON.stringify({ kind: root.kind, botId: root.botId, cause: root.cause, threads: root.threadIds.length });
    default: return JSON.stringify(root);
  }
}

/** One owner action, in the caller's transaction (see the file header). O(targets): the named lines, the bot's threads and scopes, one
 * memory object, one receipt or session. Returns the revoke id (0 on a file without the v10 tables). */
export function commitRevoke(tx: DatabaseSync, root: RevokeRoot, options: RevokeOptions = {}): number {
  if (!hasWritetime(tx)) return 0;
  const now = currentLsn(tx);
  const until = root.kind === "line" && options.until !== undefined && Number.isSafeInteger(options.until) ? Math.min(options.until, now) : undefined;
  const bulk = options.into !== undefined && options.into > 0 ? options.into : undefined;
  const R = bulk ?? Number(st(tx, "SELECT coalesce(max(revoke_id),0)+1 AS r FROM memory_revoke_jobs").get()!.r);
  if (root.kind === "policy" || root.kind === "epoch") {
    // the watermark: an audience reader loses every generated line whose oldest receipt predates this (replay-lineage.ts:945 parity)
    setMeta(tx, root.kind === "policy" ? "policy_bump_lsn" : "epoch_bump_lsn", now);
    if (bulk) { bumpDenyGeneration(tx); return R; }
    st(tx, "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,?,?,'done','','done')").run(R, root.kind, compactRoot(root), now, now);
    st(tx, "DELETE FROM memory_revoke_jobs WHERE state IN ('done','undone') AND revoke_id<?").run(R);
    bumpDenyGeneration(tx);
    return R;
  }
  if (!bulk) {
    st(tx, "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,?,?,?,?,'flow','','active')").run(R, root.kind, compactRoot(root, until), now, now);
    // a receipt whose state turned 'revoked': every mark of this revoke binds audience readers only (deny-read.ts AUDIENCE_ONLY)
    if (root.kind === "receipt" && root.cause === "receipt-revoked") st(tx, "INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(R);
  } else if ((root.kind === "receipt" && root.cause === "receipt-revoked") !== Boolean(st(tx, "SELECT 1 AS x FROM memory_revoke_audience WHERE revoke_id=?").get(R))) {
    throw new Error("MEMORY_REVOKE_BULK_AUDIENCE"); // an audience-only root goes only into the audience bulk, and only it
  }
  const reason = root.cause;
  let rootLsn = now, scopeSince = now;
  const seeds: Array<[string, number | null]> = []; // flow seeds; null since = the root lsn
  switch (root.kind) {
    case "line": {
      for (const messageId of root.messageIds) {
        const line = lineOf(tx, root.threadId, messageId);
        if (line) {
          writeLine(tx, R, root.threadId, Number(line.lsn), reason);
          writeRange(tx, R, root.threadId, Number(line.lsn), until ?? now, until === undefined ? reason : `${reason}${BOUNDED_RANGE}`);
          enqueueNode(tx, R, { kind: "line", threadId: root.threadId, lsn: Number(line.lsn) });
          rootLsn = Math.min(rootLsn, Number(line.lsn));
        } else {
          // a line with no lineage row yet (written before the upgrade reached it): its position is unknown, so the whole thread is
          // denied up to now (fail closed; the U2 seed and the ranges written here withhold more, never less)
          writeRange(tx, R, root.threadId, FIRST_LSN, until ?? now, `${reason}-unplaced`);
          enqueueNode(tx, R, { kind: "range", threadId: root.threadId, fromLsn: FIRST_LSN });
          rootLsn = FIRST_LSN;
        }
        const source = st(tx, "SELECT scope_id FROM memory_sources WHERE thread_id=? AND message_id=? LIMIT 1").get(root.threadId, messageId)?.scope_id;
        if (typeof source === "string") seeds.push([scopeFlowNode(source), null]);
      }
      seeds.push([root.threadId, null]);
      scopeSince = rootLsn;
      break;
    }
    case "thread": {
      // a deleted conversation is denied as a direct fact whatever was captured from it (revbound r3 A1/F2)
      if (hasDenyTable(tx)) st(tx, "INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES('thread',?,?,?)").run(root.threadId, epochNow(tx), Date.now());
      setMeta(tx, "epoch_bump_lsn", now);
      rootLsn = firstLsn(tx, root.threadId, now);
      writeRange(tx, R, root.threadId, FIRST_LSN, now, reason);
      enqueueNode(tx, R, { kind: "range", threadId: root.threadId, fromLsn: FIRST_LSN });
      seeds.push([root.threadId, null]);
      scopeSince = rootLsn;
      break;
    }
    case "bot": {
      setMeta(tx, "epoch_bump_lsn", now); setMeta(tx, "policy_bump_lsn", now);
      const scopes = st(tx, "SELECT id FROM memory_scopes WHERE kind='bot' AND (owner_key=? OR substr(owner_key,1,?)=?)").all(root.botId, root.botId.length + 1, `${root.botId}#`).map(row => String(row.id));
      for (const threadId of root.threadIds) {
        writeRange(tx, R, threadId, FIRST_LSN, now, reason);
        enqueueNode(tx, R, { kind: "range", threadId, fromLsn: FIRST_LSN });
        seeds.push([threadId, FIRST_LSN]);
      }
      for (const scopeId of scopes) { enqueueNode(tx, R, { kind: "scope", scopeId }); seeds.push([scopeFlowNode(scopeId), FIRST_LSN]); }
      rootLsn = FIRST_LSN; scopeSince = FIRST_LSN;
      break;
    }
    case "memory": {
      const ref = root.ref, removing = REMOVING.has(root.cause);
      if (BUMPING.has(root.cause)) { setMeta(tx, "epoch_bump_lsn", now); setMeta(tx, "policy_bump_lsn", now); }
      if (ref.kind === "record") {
        if (removing) writeMemory(tx, R, "record", ref.id, ref.version ?? 0);
        enqueueNode(tx, R, { kind: "record", id: ref.id, version: removing ? ref.version ?? 0 : softVersion(ref.version ?? 0) });
        const scope = st(tx, "SELECT scope_id FROM memory_records WHERE id=? LIMIT 1").get(ref.id)?.scope_id;
        if (typeof scope === "string") seeds.push([scopeFlowNode(scope), FIRST_LSN]);
        // a forgotten record's supporting material is older than the record: everything resting on it may be (A2)
        rootLsn = removing ? FIRST_LSN : recordCreated(tx, ref.id, ref.version);
        scopeSince = removing ? FIRST_LSN : rootLsn;
      } else if (ref.kind === "source") {
        if (removing) writeMemory(tx, R, "source", ref.id, 0);
        const at = st(tx, "SELECT scope_id,thread_id,message_id FROM memory_sources WHERE id=?").get(ref.id);
        rootLsn = FIRST_LSN;
        if (typeof at?.thread_id === "string" && typeof at.message_id === "string") {
          const line = lineOf(tx, at.thread_id, at.message_id);
          if (line && removing) {
            writeLine(tx, R, at.thread_id, Number(line.lsn), reason);
            writeRange(tx, R, at.thread_id, Number(line.lsn), now, reason);
            rootLsn = Number(line.lsn);
          }
          seeds.push([at.thread_id, null]);
        }
        if (typeof at?.scope_id === "string") seeds.push([scopeFlowNode(at.scope_id), FIRST_LSN]);
        enqueueNode(tx, R, { kind: "source", id: ref.id });
        scopeSince = FIRST_LSN;
      } else {
        // a lesson or a PIP claim: its mark is the whole of it (lessons.ts reads it; nothing is derived from one by lineage)
        writeMemory(tx, R, ref.kind, ref.id, ref.version ?? 0);
        rootLsn = now; scopeSince = now;
      }
      break;
    }
    case "scope": {
      if (hasDenyTable(tx)) st(tx, "INSERT OR IGNORE INTO memory_deny(kind,id,epoch,created_at) VALUES('scope',?,?,?)").run(root.scopeId, epochNow(tx), Date.now());
      enqueueNode(tx, R, { kind: "scope", scopeId: root.scopeId });
      seeds.push([scopeFlowNode(root.scopeId), FIRST_LSN]);
      rootLsn = FIRST_LSN; scopeSince = FIRST_LSN;
      break;
    }
    case "receipt": {
      // the receipt range (receipt-outputs.ts): the window starts exactly at its first output; one with no output has nothing to hold
      const start = receiptStart(tx, root.bundleId);
      rootLsn = start ? start.firstLsn : now;
      const thread = st(tx, "SELECT thread_id FROM memory_disclosures WHERE bundle_id=?").get(root.bundleId)?.thread_id;
      if (typeof thread === "string") seeds.push([thread, null]);
      enqueueNode(tx, R, { kind: "receipt", bundleId: root.bundleId });
      scopeSince = rootLsn;
      break;
    }
    case "session": {
      const s = root.session;
      writeSession(tx, R, s.threadId, s.driverInstance, s.nativeSession);
      const first = st(tx, "SELECT first_lsn FROM memory_session_lineage WHERE thread_id=? AND driver_instance=? AND native_session=?").get(s.threadId, s.driverInstance, s.nativeSession)?.first_lsn;
      rootLsn = first === undefined || first === null ? FIRST_LSN : Number(first);
      seeds.push([s.threadId, null]);
      scopeSince = rootLsn;
      break;
    }
  }
  st(tx, bulk ? "UPDATE memory_revoke_jobs SET root_lsn=min(root_lsn,?) WHERE revoke_id=?" : "UPDATE memory_revoke_jobs SET root_lsn=? WHERE revoke_id=?").run(rootLsn, R);
  // the window: nothing derived is older than its root, so every generated line from root_lsn on, and every memory object made since
  // scopeSince, reads "checking" until the marker has written its last mark (or the flow phase proves a narrower set)
  markPending(tx, R, PENDING_ALL_THREADS, rootLsn);
  st(tx, "INSERT OR IGNORE INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES(?,?,?)").run(PENDING_ALL_SCOPES, scopeSince, R);
  for (const [node, since] of seeds) seedFlow(tx, R, node, since ?? rootLsn);
  bumpDenyGeneration(tx);
  if (bulk) return R; // held 'seeding' until activateBulkRevoke
  if (options.inline !== false) markInline(tx);
  wakeIfStarted();
  return R;
}
/** The marker inline, in the committing transaction, for at most INLINE_REVOCATION.ms (memory-revocation.ts). */
function markInline(tx: DatabaseSync): void {
  if (!(INLINE_REVOCATION.ms > 0)) return;
  const deadline = performance.now() + INLINE_REVOCATION.ms;
  while (performance.now() < deadline && markerWorkPending(tx)) {
    if (!markerSlice(tx, INLINE_REVOCATION.rows, Math.max(0, deadline - performance.now()))) break;
  }
}

/** Undo (unhide, restore): the revoke stops and every mark, pending row and queue row with its id goes, through the `_revoke` indexes, as
 * a job of the same cost. A coalesced range (revoke -1) is not undone: it withholds more, never less. */
export function undoRevoke(tx: DatabaseSync, revokeId: number): void {
  if (!(revokeId > 0) || !hasWritetime(tx)) return;
  const held = st(tx, "SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(revokeId);
  if (held) st(tx, "UPDATE memory_revoke_jobs SET phase='undo',cursor='',state='undoing' WHERE revoke_id=?").run(revokeId);
  else { const now = currentLsn(tx); st(tx, "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'undo','{}',?,?,'undo','','undoing')").run(revokeId, now, now); }
  bumpDenyGeneration(tx);
  wakeIfStarted();
}

/** A carried run of parent lines (lineage-write.ts): thread, first and last lsn (UNKNOWN_LSN for a position not known). */
export interface CarryRange { readonly threadId: string; readonly from: number; readonly to: number }
/** What inherits: a line (its own refs), a turn (every line of the thread from its turn_lsn on: a range node), an object, a session. */
export type InheritChild =
  | { readonly kind: "line"; readonly threadId: string; readonly lsn: number }
  | { readonly kind: "turn"; readonly threadId: string; readonly lsn: number }
  | { readonly kind: "record"; readonly ref: MemoryRef; readonly lsn: number }
  | { readonly kind: "session"; readonly session: SessionKey; readonly lsn: number };

type Found = Map<number, boolean>;
function addRows(out: Found, rows: Array<Record<string, unknown>>, denied: boolean): void {
  for (const row of rows) { const r = Number(row.revoke_id); out.set(r, denied || (out.get(r) ?? false)); }
}
/** The revokes that deny or hold a carried range, as [revoke, denied]: denied = a line of the range is marked, or a positional range of its
 * thread starts inside it (over-approximated: the child is marked, never left out); otherwise pending at or before its end. */
function rangeRevokes(tx: DatabaseSync, range: CarryRange, out: Found): void {
  const T = range.threadId, to = range.to;
  const unknown = to >= UNKNOWN_LSN;
  addRows(out, (unknown ? st(tx, "SELECT revoke_id FROM memory_deny_line WHERE thread_id=? LIMIT 64").all(T)
    : st(tx, "SELECT revoke_id FROM memory_deny_line WHERE thread_id=? AND lsn BETWEEN ? AND ? LIMIT 64").all(T, range.from, to)) as Array<Record<string, unknown>>, true);
  addRows(out, (unknown ? st(tx, "SELECT revoke_id FROM memory_deny_range WHERE thread_id=? LIMIT 256").all(T)
    : st(tx, "SELECT revoke_id FROM memory_deny_range WHERE thread_id=? AND from_lsn<? LIMIT 256").all(T, to)) as Array<Record<string, unknown>>, true);
  addRows(out, st(tx, "SELECT revoke_id FROM memory_deny_pending WHERE thread_id IN (?,?) AND since_lsn<=?").all(T, PENDING_ALL_THREADS, unknown ? Number.MAX_SAFE_INTEGER : to) as Array<Record<string, unknown>>, false);
}
/** The revokes that deny or hold one memory or receipt ref. */
function refRevokes(tx: DatabaseSync, ref: LineageRef, out: Found): void {
  switch (ref.kind) {
    case "memory": {
      const m = ref.ref;
      addRows(out, st(tx, "SELECT revoke_id FROM memory_deny_memory WHERE kind=? AND id=? AND version IN (0,?)").all(m.kind, m.id, m.version ?? 0) as Array<Record<string, unknown>>, true);
      const created = m.kind === "record" ? recordCreated(tx, m.id, m.version) : 0;
      addRows(out, st(tx, "SELECT revoke_id FROM memory_deny_pending_scope WHERE scope_id IN (?,?) AND since_lsn<=?").all(m.scopeId ?? PENDING_ALL_SCOPES, PENDING_ALL_SCOPES, created > FIRST_LSN ? created : Number.MAX_SAFE_INTEGER) as Array<Record<string, unknown>>, false);
      return;
    }
    case "receipt": {
      for (const scopeId of ref.scopeIds.slice(0, 64)) addRows(out, st(tx, "SELECT revoke_id FROM memory_deny_pending_scope WHERE scope_id IN (?,?) AND since_lsn<=?").all(scopeId, PENDING_ALL_SCOPES, ref.lsn) as Array<Record<string, unknown>>, false);
      return;
    }
    default: return; // lines and prefixes come as ranges
  }
}
/** The child as the frontier node a denying revoke walks next. */
function childNode(child: InheritChild): FrontierNode | null {
  switch (child.kind) {
    case "line": return { kind: "line", threadId: child.threadId, lsn: child.lsn };
    case "turn": return { kind: "range", threadId: child.threadId, fromLsn: child.lsn };
    case "session": return { kind: "session", session: child.session };
    case "record": return child.ref.kind === "record" ? { kind: "record", id: child.ref.id, version: child.ref.version ?? 0 } : child.ref.kind === "source" ? { kind: "source", id: child.ref.id } : null;
  }
}
/** The pending node that holds the child while a revoke it rests on is in flight (a scopeless object reads "checking" under any pending row). */
function childPending(child: InheritChild): [string, number] | null {
  switch (child.kind) {
    case "line": case "turn": return [child.threadId, child.lsn];
    case "session": return [child.session.threadId, child.lsn];
    case "record": return child.ref.scopeId ? [scopeFlowNode(child.ref.scopeId), child.lsn] : null;
  }
}
/** Inheritance at write, called by the writers in the writer's transaction (DESIGN-WRITETIME 2.3): when a carried parent is denied, the
 * child enters that revoke's frontier (a finished revoke is reopened); when it is denied or pending, the child is held pending, so it reads
 * "checking" until the revoke's last mark. A parent under a coalesced range (revoke -1, no job) makes the child the root of a new revoke.
 * O(ranges + refs), flat in history. */
export function inheritMarks(tx: DatabaseSync, child: InheritChild, refs: readonly LineageRef[], ranges: readonly CarryRange[] = []): void {
  if ((!refs.length && !ranges.length) || !hasWritetime(tx)) return;
  const found: Found = new Map();
  for (const range of ranges) rangeRevokes(tx, range, found);
  for (const ref of refs) refRevokes(tx, ref, found);
  if (!found.size) return;
  const now = currentLsn(tx);
  const node = childNode(child), hold = childPending(child);
  const mark = (R: number) => {
    if (node) enqueueNode(tx, R, node);
    else if (child.kind === "record") writeMemory(tx, R, child.ref.kind, child.ref.id, child.ref.version ?? 0); // a lesson, a claim, a Murage object: the mark is the whole of it
  };
  for (const [R, denied] of found) {
    if (R === -1 || R === AUDIENCE_COALESCED) {
      const fresh = Number(st(tx, "SELECT coalesce(max(revoke_id),0)+1 AS r FROM memory_revoke_jobs").get()!.r);
      st(tx, "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit',?,?,?,'mark','','active')").run(fresh, JSON.stringify({ kind: "inherit", cause: "inherit" }), child.lsn, now);
      if (R === AUDIENCE_COALESCED) st(tx, "INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(fresh);
      mark(fresh);
      if (hold) markPending(tx, fresh, hold[0], hold[1]);
      continue;
    }
    const job = st(tx, "SELECT state,phase FROM memory_revoke_jobs WHERE revoke_id=?").get(R);
    if (job && (job.state === "undoing" || job.state === "undone")) continue;
    if (denied) {
      if (!job) st(tx, "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit',?,?,?,'mark','','active')").run(R, JSON.stringify({ kind: "inherit", cause: "inherit" }), child.lsn, now);
      else if (job.state === "done" || job.phase === "hold" || job.phase === "tidy") st(tx, "UPDATE memory_revoke_jobs SET phase='mark',cursor='',state='active' WHERE revoke_id=?").run(R);
      mark(R);
    } else if (!job || job.state === "done") continue; // pending rows of a finished revoke are already gone: nothing holds the parent
    if (hold) markPending(tx, R, hold[0], hold[1]);
  }
  bumpDenyGeneration(tx);
  wakeIfStarted();
}

// receipts turned 'revoked' by any path are committed as receipt roots by the marker (receipt-outputs.ts, the v10 flip trigger)
setFlipCommit((db, bundleId) => { commitRevoke(db, { kind: "receipt", bundleId, cause: "receipt-revoked" }, { inline: false }); });
