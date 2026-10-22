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
import { currentLsn, takeCommitLsn } from "./lineage-write.ts";
import { CONSUMED_REF_KINDS, FIRST_LSN, lineChildRef, OBJECT_EDGE_LSN, objectCarryThread, objectFlowNode, PENDING_ALL_THREADS, scopeFlowNode, UNKNOWN_LSN, type FrontierNode, type LineageRef, type MemoryRef, type RevokeRoot, type SessionKey } from "./lineage-types.ts";
import { ensureThreadNo, threadNo } from "./thread-no.ts";
import { drainReceiptFlips, receiptStart } from "./receipt-outputs.ts";
import { AUDIENCE_COALESCED } from "./lineage-types.ts";
import { BOUNDED_RANGE, bumpDenyGeneration, enqueueNode, foldRefusesUndo, hasWritetime, lineOf, markerWorkPending, markPending, PENDING_ALL_SCOPES, resolveRevoke, seedFlow, setFlipDrain, softVersion, st, writeLine, writeMemory, writeRange, writeSession } from "./revoke-marker.ts";
import { INLINE_REVOCATION, wakeIfStarted } from "./memory-revocation.ts";
import { budgetedMarkerSlice, revokeMinuteChanges } from "./revoke-budget.ts";
import "./revoke-fold.ts"; // the revoke fold registers with the marker (revoke-marker.ts setFoldHooks), as the flip drain does below

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
  const now = takeCommitLsn(tx); // the bulk revoke's own slot: its cap (commitRevoke)
  const R = Number(st(tx, "SELECT coalesce(max(revoke_id),0)+1 AS r FROM memory_revoke_jobs").get()!.r);
  st(tx, "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'bulk',?,?,?,'flow','','seeding')").run(R, JSON.stringify({ kind: "bulk", cause }), now, now);
  if (audience) st(tx, "INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(R);
  return R;
}
/** The bulk revoke's roots are all in: the marker walks it from its flow phase. Its cap (started_lsn) moves to a slot of its own taken
 * now, above every root's commit slot: while it seeded, its window held every line (deny-read.ts pendingWindows, no cap); from here a
 * prompt built after the activation has a head at or above the cap and reads outside the window, and the walk's ranges and session stage
 * cover every turn begun while the roots went in (revoke-marker.ts). A flip drain opens, fills and activates its bulk in one transaction
 * (drainFlipsIntoBulk), so no prompt is built in between. */
export function activateBulkRevoke(tx: DatabaseSync, revokeId: number): void {
  if (!(revokeId > 0) || !hasWritetime(tx)) return;
  if (st(tx, "SELECT 1 AS x FROM memory_revoke_jobs WHERE revoke_id=? AND state='seeding'").get(revokeId))
    st(tx, "UPDATE memory_revoke_jobs SET state='active',started_lsn=? WHERE revoke_id=?").run(takeCommitLsn(tx), revokeId);
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
  // the commit's own lsn: the cap of its ranges and of the walk's session stage is this slot, so a prompt built after the commit (head =
  // currentLsn - 1) is at or above it even when no line was written in between (a routine, a room member's turn, a late redispatch). A
  // policy or epoch watermark keeps the head it was always compared with. A root added to an open bulk revoke takes its own slot too: its
  // range's cap is that slot, not the bulk's open slot (a session begun on the root's line after the bulk opened held it; the walk keeps the
  // root's cap, revoke-marker.ts rangeNode).
  const now = root.kind === "policy" || root.kind === "epoch" ? currentLsn(tx) : takeCommitLsn(tx);
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
        // what read it (a note, a card, a lesson...) rests on it: the replies and objects of its consumers
        // (what read it may be older than this action: nothing marks them until the walk reaches them, so the window opens at the start, and the
        // flow phase narrows it to the threads and scopes that read the object, from the first line that did)
        if (CONSUMED_REF_KINDS.has(ref.kind)) { enqueueNode(tx, R, { kind: "object", objectKind: ref.kind, id: ref.id }); seeds.push([objectFlowNode(ref), FIRST_LSN]); rootLsn = FIRST_LSN; scopeSince = FIRST_LSN; }
        else { rootLsn = now; scopeSince = now; }
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
      if (root.cause === "receipt-revoked") holdRevokedReceipt(tx, root.bundleId, start);
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
  if (options.inline !== false) markInline(tx, R);
  wakeIfStarted();
  return R;
}
/** Most cited records and sources a revoked receipt hangs an edge on; a receipt citing more hangs on the wildcard of each kind. */
const RECEIPT_HOLD_CAP = 2048;
/** A receipt turned 'revoked' leaves memory_disclosure_refs (the v8 triggers), so a later forget of something it cites could no longer find
 * it, and a content reader (the owner's direct chat, rooms: a state flip binds audience readers only) would be shown its outputs again. The
 * receipt is held instead as a consumer of each record and source it cites: a carry from that item's interned node (lineage-write.ts
 * carryOnto does the same for objects) to the receipt's first output line, which the marker walks when the item is denied (revoke-marker.ts
 * objectNode: a denied source or record walks its consumers). A receipt citing more than RECEIPT_HOLD_CAP items, one whose lists do not
 * parse, or one whose per-item commit could cost more than a whole minute of the marker's write budget (revoke-budget.ts), hangs on the
 * kind's wildcard (every denial of the kind walks it: withholds more, never less). Astra audit, differential shape "records + hot pool". */
function holdRevokedReceipt(tx: DatabaseSync, bundleId: string, start: ReturnType<typeof receiptStart>): void {
  if (!start) return; // it produced nothing
  const plan = receiptHoldPlan(tx, bundleId, start.threadId);
  if (!plan) return;
  const childNo = ensureThreadNo(tx, start.threadId), ref = lineChildRef(start.firstLsn);
  for (const item of plan) st(tx, "INSERT OR IGNORE INTO memory_lineage_carry(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref,child_thread_no) VALUES(?,?,?,0,?,?)")
    .run(ensureThreadNo(tx, objectCarryThread(item)), OBJECT_EDGE_LSN, OBJECT_EDGE_LSN, ref, childNo);
}
type HoldItem = { kind: "record" | "source"; id: string };
const HOLD_WILD: readonly HoldItem[] = [{ kind: "record", id: "*" }, { kind: "source", id: "*" }];
/** The items a revoked receipt hangs a consumer edge on, in order (null: no receipt row). Lists that do not parse, or cite more than
 * RECEIPT_HOLD_CAP items, hang on the wildcard pair; an entry with no string id ends the list there and adds the wildcard pair. A plan
 * whose commit could cost more than a whole minute of the write budget hangs on the wildcard pair too (1.0.3 revoke storm, M3: the budget's
 * ceiling holds for every minute and the flip still commits, at the pair's few rows; see receiptPlanTooBig). */
function receiptHoldPlan(tx: DatabaseSync, bundleId: string, threadId: string): HoldItem[] | null {
  const plan = itemHoldPlan(tx, bundleId);
  return plan && receiptPlanTooBig(tx, plan, threadId) ? [...HOLD_WILD] : plan;
}
/** The most rows a receipt's commit with `plan` writes, whatever is interned already (each carry thread and the receipt's own thread taking
 * a number), with its bulk's opening. Over a whole minute's budget (revokeMinuteChanges) it could never be committed inside one minute.
 * Interns are counted at their most so the answer does not move between the drain's admission and the commit itself. */
function receiptPlanTooBig(db: DatabaseSync, plan: readonly HoldItem[], threadId: string): boolean {
  const threads = new Set<string>([threadId]);
  for (const item of plan) threads.add(objectCarryThread(item));
  return RECEIPT_ROOT_COST + (threads.size - 1) + threads.size + BULK_OPEN_COST > revokeMinuteChanges(db);
}
function itemHoldPlan(tx: DatabaseSync, bundleId: string): HoldItem[] | null {
  const row = st(tx, "SELECT record_versions,source_versions FROM memory_disclosures WHERE bundle_id=?").get(bundleId);
  if (!row) return null;
  let records: unknown, sources: unknown;
  try { records = JSON.parse(String(row.record_versions)); sources = JSON.parse(String(row.source_versions)); } catch { return [...HOLD_WILD]; }
  if (!Array.isArray(records) || !Array.isArray(sources) || records.length + sources.length > RECEIPT_HOLD_CAP) return [...HOLD_WILD];
  const plan: HoldItem[] = [];
  for (const [kind, list] of [["record", records], ["source", sources]] as const) {
    for (const item of list) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id !== "string") return [...plan, ...HOLD_WILD];
      plan.push({ kind, id });
    }
  }
  return plan;
}
/** The marker inline, in the committing transaction (1.0.3 revoke storm, M3): the owner's own revoke only, under the marker's write budget
 * and within INLINE_REVOCATION.ms from here. It never drains the queued receipt flips or walks another revoke (the runner carries that
 * backlog), and while a flip waits it walks nothing (revoke-marker.ts runMarkerSlice); what it leaves is the runner's. */
function markInline(tx: DatabaseSync, revokeId: number): void {
  if (!(INLINE_REVOCATION.ms > 0)) return;
  const deadline = performance.now() + INLINE_REVOCATION.ms;
  while (performance.now() < deadline && markerWorkPending(tx)) {
    const moved = budgetedMarkerSlice(tx, INLINE_REVOCATION.rows, Math.max(0, deadline - performance.now()), null, { only: revokeId });
    if (!moved || moved === "budget") break;
  }
}

/** Undo (unhide, restore): the revoke stops and every mark, pending row and queue row with its id goes, through the `_revoke` indexes, as
 * a job of the same cost. A coalesced range (revoke -1) is not undone: it withholds more, never less. */
export function undoRevoke(tx: DatabaseSync, revokeId: number): void {
  if (!(revokeId > 0) || !hasWritetime(tx)) return;
  // a folded id, a fold bulk (also once its job row was pruned or recreated) or a member of a seeding fold: the fold bulk's marks are shared
  // by every root it took over and cannot be withdrawn for one (1.0.3 REVOKE-FOLD-DESIGN F1.7, r4 A2): withholds more, never less
  if (foldRefusesUndo(tx, revokeId)) throw new Error("MEMORY_REVOKE_UNDO_BULK");
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
  /** fromNow: refs added to a line already written (lineage-write.ts lineageRow): the hold and the walk start at a slot taken now, the mark
   * is the line's own. */
  | { readonly kind: "line"; readonly threadId: string; readonly lsn: number; readonly fromNow?: boolean }
  /** holdFrom: the generated line whose write carried the turn (its own lsn, above the turn's head); unset for a row patched in place, whose
   * hold takes the inherit slot. */
  | { readonly kind: "turn"; readonly threadId: string; readonly lsn: number; readonly holdFrom?: number }
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
  // a positional range denies a carried line only when the read rule does (deny-read.ts): the line is after the range's start and its turn
  // began before the range's end. A clean reply written after the forget lies outside it (Astra audit P1 6); the carried run is checked for
  // such a line in one seek per range row. A thread with no number has no lines to look at: any range of it counts (fail closed).
  const no = unknown ? null : threadNo(tx, T);
  addRows(out, (unknown || no === null ? st(tx, "SELECT revoke_id FROM memory_deny_range WHERE thread_id=? LIMIT 256").all(T)
    : st(tx, `SELECT d.revoke_id FROM memory_deny_range d WHERE d.thread_id=?1 AND d.from_lsn<?3 AND EXISTS (SELECT 1 FROM memory_line_lineage l WHERE l.thread_no=?2 AND l.lsn>d.from_lsn AND l.lsn>=?4 AND l.lsn<=?3 AND l.turn_lsn IS NOT NULL AND l.turn_lsn<d.until_turn_lsn) LIMIT 256`).all(T, no, to, range.from)) as Array<Record<string, unknown>>, true);
  // a pending window holds the carried range as the read rule does (deny-read.ts pendingWindows): a line of it at or after the window's
  // since whose turn began before the revoke's commit (started_lsn). A window with no cap (a bulk still seeding, no job row, a hold written
  // after the commit), a range whose lines are not known, or a window over no stored line of the range holds it whole, as before. Every
  // matching window is read, with no row limit: a window left out here would leave the child unheld (Astra delta High 2)
  addRows(out, (unknown || no === null ? st(tx, "SELECT revoke_id FROM memory_deny_pending WHERE thread_id IN (?,?) AND since_lsn<=?").all(T, PENDING_ALL_THREADS, unknown ? Number.MAX_SAFE_INTEGER : to)
    : st(tx, `SELECT p.revoke_id FROM memory_deny_pending p LEFT JOIN memory_revoke_jobs j ON j.revoke_id=p.revoke_id WHERE p.thread_id IN (?1,?2) AND p.since_lsn<=?3 AND (j.revoke_id IS NULL OR j.state='seeding' OR p.since_lsn>j.started_lsn
      OR EXISTS (SELECT 1 FROM memory_line_lineage l WHERE l.thread_no=?4 AND l.lsn>=max(p.since_lsn,?5) AND l.lsn<=?3 AND coalesce(l.turn_lsn,0)<j.started_lsn)
      OR NOT EXISTS (SELECT 1 FROM memory_line_lineage l WHERE l.thread_no=?4 AND l.lsn>=max(p.since_lsn,?5) AND l.lsn<=?3))`).all(T, PENDING_ALL_THREADS, to, no, range.from)) as Array<Record<string, unknown>>, false);
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
export function inheritMarks(tx: DatabaseSync, child: InheritChild, refs: readonly LineageRef[], ranges: readonly CarryRange[] = [], edge = false): void {
  if ((!refs.length && !ranges.length) || !hasWritetime(tx)) return;
  const found: Found = new Map();
  for (const range of ranges) rangeRevokes(tx, range, found);
  for (const ref of refs) refRevokes(tx, ref, found);
  if (!found.size) return;
  // a revoke folded into a fold bulk is that bulk now (1.0.3 REVOKE-FOLD-DESIGN F1.6): every found id is resolved, one seek each, and the
  // map merged by destination (denied = OR), so a child under marks of several folded ids is enqueued and held once
  const byDest: Found = new Map();
  for (const [R, denied] of found) { const to = R > 0 ? resolveRevoke(tx, R) : R; byDest.set(to, denied || (byDest.get(to) ?? false)); }
  // a fresh inherit job's started_lsn (the cap of its walk) is a slot of its own, taken here after the child's lsn: a prompt built after
  // this write has a head at or above it, so it is not taken for one that held the child (the same-head shape commitRevoke closes)
  let started: number | undefined;
  const startedLsn = () => started ??= takeCommitLsn(tx);
  // a line given refs after it was written: its hold and walk start at the inherit slot (a prompt built before this write held none of
  // them), so a routine card or notice patched now never holds an earlier prompt's prefix (1.0.3 lifecycle card)
  const from = child.kind === "line" && child.fromNow ? startedLsn() : undefined;
  const node: FrontierNode | null = from !== undefined && child.kind === "line" ? { kind: "line", threadId: child.threadId, lsn: child.lsn, from } : childNode(child);
  const pendingAt = childPending(child);
  // a session or turn child is written at the head its prompt was built on (writeSessionLineage at session.started, a turn's carry at its
  // turn lsn): held there, the hold sat at the prompt's own head and the send fence refused the turn's own prompt (the late-handback engines,
  // 1.0.2 Keep all P0). Its hold takes the inherit slot instead, above every prompt already built: those read it shown (they could not hold
  // what was carried after them) and any prompt built later reads it checking. The walk still starts at the child (node), so nothing the
  // child holds is left unmarked. A turn carried by a newly written line holds from that line (above the head, and the line itself is held);
  // a line keeps its own lsn (fresh at write) unless it was patched (fromNow).
  const fresh = child.kind === "session" ? startedLsn() : child.kind === "turn" ? (child.holdFrom !== undefined && child.holdFrom > child.lsn ? child.holdFrom : startedLsn()) : from;
  const hold: [string, number] | null = fresh !== undefined && pendingAt ? [pendingAt[0], fresh] : pendingAt;
  const mark = (R: number) => {
    if (node) enqueueNode(tx, R, node);
    else if (child.kind === "record") {
      writeMemory(tx, R, child.ref.kind, child.ref.id, child.ref.version ?? 0); // a lesson, a claim, a Murage object: the mark is the whole of it
      if (CONSUMED_REF_KINDS.has(child.ref.kind)) enqueueNode(tx, R, { kind: "object", objectKind: child.ref.kind, id: child.ref.id }); // and its readers
    }
  };
  for (const [R, denied] of byDest) {
    // a late edge's child (inheritEdge) under a revoke that has finished (its job row gone or done, or the coalesced audience row) takes the
    // mark at its write and nothing else: a just-written child has no consumers, so there is nothing to walk and nothing to hold. Reopening
    // the revoke, or opening a fresh inherit job with a new walk cap, re-walked the whole store from every memory-idle consolidation
    // (1.0.3 drain reopen)
    if (edge && denied && child.kind === "record" && R !== -1) {
      const job = R === AUDIENCE_COALESCED ? undefined : st(tx, "SELECT state FROM memory_revoke_jobs WHERE revoke_id=?").get(R);
      if (R === AUDIENCE_COALESCED || !job || job.state === "done") { writeMemory(tx, R, child.ref.kind, child.ref.id, child.ref.version ?? 0); continue; }
    }
    if (R === -1 || R === AUDIENCE_COALESCED) {
      const fresh = Number(st(tx, "SELECT coalesce(max(revoke_id),0)+1 AS r FROM memory_revoke_jobs").get()!.r);
      st(tx, "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit',?,?,?,'mark','','active')").run(fresh, JSON.stringify({ kind: "inherit", cause: "inherit" }), child.lsn, startedLsn());
      if (R === AUDIENCE_COALESCED) st(tx, "INSERT OR IGNORE INTO memory_revoke_audience(revoke_id) VALUES(?)").run(fresh);
      mark(fresh);
      if (hold) markPending(tx, fresh, hold[0], hold[1]);
      continue;
    }
    const job = st(tx, "SELECT state,phase FROM memory_revoke_jobs WHERE revoke_id=?").get(R);
    if (job && (job.state === "undoing" || job.state === "undone")) continue;
    if (denied) {
      if (!job) st(tx, "INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'inherit',?,?,?,'mark','','active')").run(R, JSON.stringify({ kind: "inherit", cause: "inherit" }), child.lsn, startedLsn());
      else if (job.state === "done" || job.phase === "hold" || job.phase === "tidy") st(tx, "UPDATE memory_revoke_jobs SET phase='mark',cursor='',state='active' WHERE revoke_id=?").run(R);
      mark(R);
    } else if (!job || job.state === "done") continue; // pending rows of a finished revoke are already gone: nothing holds the parent
    if (hold) markPending(tx, R, hold[0], hold[1]);
  }
  bumpDenyGeneration(tx);
  wakeIfStarted();
}

/** A late edge's parent: a memory object, or a stored line (a capture's message). */
export type EdgeParent = MemoryRef | { readonly threadId: string; readonly messageId: string };
const scopeOf = (tx: DatabaseSync, ref: MemoryRef): string | undefined => {
  if (ref.scopeId) return ref.scopeId;
  const row = ref.kind === "source" ? st(tx, "SELECT scope_id FROM memory_sources WHERE id=?").get(ref.id)
    : ref.kind === "record" ? (ref.version && ref.version > 0 ? st(tx, "SELECT scope_id FROM memory_records WHERE id=? AND version=?").get(ref.id, ref.version)
      : st(tx, "SELECT scope_id FROM memory_records WHERE id=? LIMIT 1").get(ref.id)) : undefined;
  return typeof row?.scope_id === "string" ? row.scope_id : undefined;
};
/** Late cap-free fan-out inherits at write (DRAIN-104 2.11): a memory object written by a background job or an owner action with an edge
 * the walk follows (evidence, a derivation, a capture, a copy) inherits its parent's marks in the writer's transaction, as lines, turns,
 * sessions and records written in a turn do (lineage-write.ts carryOnto). So a source captured from a denied line, a record extracted or
 * derived from a denied object, or a copy of a denied source, written after a walk passed, is marked under the denying revoke (or held
 * pending while it is in flight) at its own lsn: the record's created lsn, a source's current lsn. A line with no lineage row is UNKNOWN_LSN,
 * which every revoke of its thread matches (fail closed). O(parents) seeks. Call once per inserted edge, after the child row is written. */
export function inheritEdge(tx: DatabaseSync, child: MemoryRef, parent: EdgeParent): void {
  if (!hasWritetime(tx)) return;
  const scopeId = scopeOf(tx, child);
  const ref: MemoryRef = scopeId ? { ...child, scopeId } : child;
  const lsn = child.kind === "record" ? recordCreated(tx, child.id, child.version) : currentLsn(tx);
  if ("threadId" in parent) {
    const line = lineOf(tx, parent.threadId, parent.messageId);
    const at = line ? Number(line.lsn) : UNKNOWN_LSN;
    inheritMarks(tx, { kind: "record", ref, lsn }, [], [{ threadId: parent.threadId, from: at, to: at }], true);
    return;
  }
  const parentScope = scopeOf(tx, parent);
  inheritMarks(tx, { kind: "record", ref, lsn }, [{ kind: "memory", ref: parentScope ? { ...parent, scopeId: parentScope } : parent }], [], true);
}
/** inheritEdge for every evidence source and derivation parent of one record version (the copy sites: INSERT ... SELECT of a version's edges). */
export function inheritEdges(tx: DatabaseSync, child: { id: string; version: number }): void {
  if (!hasWritetime(tx)) return;
  const ref: MemoryRef = { kind: "record", id: child.id, version: child.version };
  for (const row of st(tx, "SELECT DISTINCT source_id AS s FROM memory_evidence WHERE record_id=? AND record_version=?").all(child.id, child.version)) inheritEdge(tx, ref, { kind: "source", id: String(row.s) });
  for (const row of st(tx, "SELECT parent_id AS p,parent_version AS v FROM memory_derivations WHERE child_id=? AND child_version=?").all(child.id, child.version)) inheritEdge(tx, ref, { kind: "record", id: String(row.p), version: Number(row.v) });
}

/** Rows opening and activating a bulk writes (its job and audience rows, the generation). */
const BULK_OPEN_COST = 8;
/** Rows committing a receipt root writes before its hold: the commit slot, the job's root, the frontier node, pending and seed rows, the
 * generation and the flip row's delete. */
const RECEIPT_ROOT_COST = 16;
/** The rows committing one receipt root writes (revoke-marker.ts write budget, M3), never fewer: RECEIPT_ROOT_COST, one consumer edge per
 * distinct item it hangs on (receiptHoldPlan), and one intern row per thread holdRevokedReceipt takes a number for that has none yet (the
 * receipt's own thread, and each item's carry thread). */
export function receiptCommitCost(db: DatabaseSync, bundleId: string): number {
  const start = receiptStart(db, bundleId);
  const plan = start ? receiptHoldPlan(db, bundleId, start.threadId) : null;
  if (!start || !plan) return RECEIPT_ROOT_COST;
  const threads = new Set<string>([start.threadId]);
  for (const item of plan) threads.add(objectCarryThread(item));
  let interns = 0;
  for (const thread of threads) if (threadNo(db, thread) === null) interns++;
  return RECEIPT_ROOT_COST + (threads.size - 1) + interns;
}
/** The cost of the oldest queued flip with its bulk's opening (0: none waits): revoke-budget.ts admits a slice only with room for it. */
function headFlipCommitCost(db: DatabaseSync): number {
  // the same query as drainReceiptFlips (receipt-outputs.ts), so the head is the flip a drain commits first
  const head = st(db, "SELECT thread_no,first_lsn,bundle_id FROM memory_receipt_flips LIMIT 1").get();
  return head ? receiptCommitCost(db, String(head.bundle_id)) + BULK_OPEN_COST : 0;
}
/** One drain of the receipt flips (1.0.3 revoke storm, M5): ONE NEW audience bulk revoke for the flips it drains, every flip a root of it
 * with its own window and seeds (commitRevoke({ into }): each root keeps its own since and its own cap slot, never a minimum of the others),
 * activated with all of its roots in this transaction, before any marking starts. Nothing is admitted into a bulk that is already marking: a
 * later drain opens its own. A receipt flipped again while a drain's bulk walks is a root of a later bulk, whose marks are its own (dedupe
 * is within one revoke id only, revoke-marker.ts). The policy watermark is not this drain's: the action that flipped the receipts wrote it
 * at its own scope (revocation.ts revokeAllDisclosures), and the consumer edges are written per receipt as before (holdRevokedReceipt).
 * Returns how many flips it committed. */
export function drainFlipsIntoBulk(db: DatabaseSync, limit: number, fits: (cost: number, first: boolean) => boolean = () => true): number {
  let bulk = 0;
  const done = drainReceiptFlips(db, bundleId => {
    if (!bulk) bulk = openBulkRevoke(db, "receipt-revoked", true);
    commitRevoke(db, { kind: "receipt", bundleId, cause: "receipt-revoked" }, { inline: false, ...(bulk > 0 ? { into: bulk } : {}) });
  }, limit, (bundleId, first) => fits(receiptCommitCost(db, bundleId) + (first ? BULK_OPEN_COST : 0), first));
  if (bulk > 0) activateBulkRevoke(db, bulk);
  return done;
}
// receipts turned 'revoked' by any path are committed as roots of one audience bulk per drain by the marker (receipt-outputs.ts, the v10 flip trigger)
setFlipDrain(drainFlipsIntoBulk, headFlipCommitCost);
