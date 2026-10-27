import { issueWorkAudience, issueExecutionAudience, validExecutionAudience } from "./execution-audience.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Durable room requests (SPEC-P 3.2, 5.2, 6; lane E1).
//
// Every piece of work a room or project starts is a row in `room_requests`:
// an owner's message, a member's room turn, an ask or message between bots,
// a card run, a review, a routine, and the wake that brings a result back to
// the bot that asked for it. The rows are what survives a restart: the queue,
// the lineage (who started the chain and for whom), the wait edges between
// bots, and the counters the stop rules read.
//
// One completion primitive. Every move into a terminal state goes through
// `completeRequest` in one messages.db transaction: the state, the card
// effect (only when the run is still the card's current generation), the
// usage row (whenever the request ran, fenced or not), the activity row, and
// the continuation wake. That transaction is the outbox: a wake exists only
// once the result it carries is committed, so a crash can neither lose nor
// double one. The dispatcher reads only committed `queued` wake rows.
//
// Continuations (exactly one wake per waiting asker):
//  - a turn that ends with open `ask` children goes `waiting_bot`; when its
//    last open child finishes, one `wake:<parentId>` is queued for the asker
//    with every child's outcome. If the children all finished while the
//    asker's turn was still running, the wake is queued when that turn ends.
//    An ask answered inside the asker's own turn (`outcome_note='delivered'`,
//    the synchronous ask) owes nothing.
//  - the waiting asker completes when its continuation wake completes, with
//    the wake's result (so an asker that was itself asked, or a card run that
//    asked a teammate, passes its real answer on; nesting composes).
//  - an `assign` or `review` result (or an ask with no parent row) queues a
//    `wake:<id>` for its return bot. A second result for the same bot while
//    that wake has not started is attached to it instead of queuing another.
//  - a chain that is not the owner's audience wakes nobody: its results are
//    owner-only prompt material (`continuation-results`).
//
// Lineage (6.1) is issued at the root by the server and copied to every
// child unchanged; a child can never become owner audience.
import { scopedTx } from "./tx-scope.ts";
import { ownerDeletedThread } from "./owner-deletions.ts";
import { OLD_OWNER_HANDOFF_GROUP } from "./pending-delegations-schema.ts";
import { isDispatchToken, type HandoffDispatchToken } from "./handoff-capability.ts";
import { sweepAddedOrphans } from "./added-table-lifecycle.ts";
import { writeRequestStatus } from "./room-request-status.ts";
import type { MurageStatus } from "./murage-status.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type RoomRequestVerb = "owner_send" | "room_turn" | "ask" | "assign" | "message" | "review" | "wake" | "routine";
export type RoomRequestFromKind = "owner" | "bot" | "murage" | "routine";
export type RoomRequestOrigin = "desktop" | "companion" | "unproven" | "server";
export type RoomRequestPriority = "owner" | "coordinator" | "work";
export type RoomRequestState = "queued" | "running" | "waiting_owner" | "waiting_bot" | "done" | "failed" | "cancelled" | "expired" | "unknown";
export type RoomRequestTerminalState = "done" | "failed" | "cancelled" | "expired" | "unknown";

export const ROOM_REQUEST_TERMINAL_STATES: readonly RoomRequestTerminalState[] = ["done", "failed", "cancelled", "expired", "unknown"];
export const ROOM_REQUEST_OPEN_STATES: readonly RoomRequestState[] = ["queued", "running", "waiting_owner", "waiting_bot"];
const TERMINAL_SQL = "('done','failed','cancelled','expired','unknown')";
const OPEN_SQL = "('queued','running','waiting_owner','waiting_bot')";

/** Terminal requests are pruned after this (SPEC-P section 2). */
export const ROOM_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Deadlock walk bound (5.2). */
const DEADLOCK_WALK_HOPS = 20;

export const RESTART_NOTE = "interrupted by a restart; it may have changed files";

export interface RoomRequestLineage {
  rootThreadId: string;
  origin: RoomRequestOrigin;
  audienceFingerprint: string;
  notOwnerAudience: boolean;
  unattended: boolean;
  executionAudience?: unknown;
}

export interface RoomRequest extends RoomRequestLineage {
  id: string;
  rootId: string;
  parentId: string | null;
  cardGeneration: number | null;
  attempt: number;
  groupId: string;
  targetThreadId: string | null;
  projectGoalId: string | null;
  workItemId: string | null;
  verb: RoomRequestVerb;
  fromKind: RoomRequestFromKind;
  fromBotId: string | null;
  toBotId: string | null;
  payloadText: string | null;
  replyToId: string | null;
  sendId: string | null;
  mode: "chat" | "goal" | null;
  executionAudience: unknown;
  sourceMessageId: string | null;
  returnThreadId: string | null;
  returnBotId: string | null;
  admissionKey: string;
  priority: RoomRequestPriority;
  state: RoomRequestState;
  refusal: string | null;
  createdAt: number;
  dispatchedAt: number | null;
  deadlineAt: number | null;
  finishedAt: number | null;
  ownerWaitMs: number;
  waitingSince: number | null;
  resultMessageId: string | null;
  outcomeNote: string | null;
  /** Set only on a sweep read (queuedRoomRequests with dueAt): this request is retained and has been looked at this many times. */
  retryAttempts?: number;
}

/** One continuation result, as carried by a wake's `payload_text`. */
export interface ContinuationResult {
  stopped?: boolean;
  requestId: string;
  botId: string | null;
  state: RoomRequestState;
  messageId?: string;
  note?: string;
}

export interface NewRoomRequest {
  id?: string;
  groupId: string;
  verb: RoomRequestVerb;
  fromKind: RoomRequestFromKind;
  admissionKey: string;
  now: number;
  /** A child copies its lineage from this request. */
  parentId?: string;
  /** Required for a root (no parent); ignored for a child. */
  lineage?: RoomRequestLineage;
  /** A child's own caller, when it may only narrow what the child copies
   * (a Retry from words nobody proved were the owner's): a lineage that is
   * not the owner's replaces the parent's origin and audience, and an
   * unattended one marks the child unattended. It never widens. */
  narrow?: RoomRequestLineage;
  fromBotId?: string | null;
  toBotId?: string | null;
  targetThreadId?: string | null;
  projectGoalId?: string | null;
  workItemId?: string | null;
  cardGeneration?: number | null;
  attempt?: number;
  payloadText?: string | null;
  replyToId?: string | null;
  sendId?: string | null;
  mode?: "chat" | "goal" | null;
  sourceMessageId?: string | null;
  returnThreadId?: string | null;
  returnBotId?: string | null;
  priority?: RoomRequestPriority;
  deadlineAt?: number | null;
  /** `running` for a turn that starts at once (dispatched_at = now). */
  state?: "queued" | "running";
  /** A waiting asker's continuation wake (`wake:<parent>`, inserted by `wakeWaitingParent`). Only this input, and an `ask`, engage the
   * cancelled-ancestor fence (F3): the fence is applied by call site, never by admission key or parent state, so a return wake that carries
   * the same `wake:<id>` key under a cancelled request (a cancelled card returned to its lead) is a lineage edge and is never refused. */
  continuation?: boolean;
}

/** F3 fence: an `ask` or a continuation wake under a request that is itself, or has an ancestor, `cancelled` is refused. */
export const REQUEST_ENDED = "REQUEST_ENDED";
export class RequestEndedError extends Error {
  readonly code = REQUEST_ENDED;
  readonly status = 409;
  constructor() { super("the request that asked has ended"); }
}
/** Has the request `id` (the parent of an ask or a continuation wake) ended so that what it asked for must not start (F3 fence)? Walks up `parent_id`:
 * true at a `cancelled` row on any edge, and at a `failed` row reached only through dependency edges (asks and continuation wakes), so the cards a failed
 * lead turn handed out keep their own asks (CANCEL-TREE-104 D1). No hop limit; a loop (corrupt rows) is fail-closed (D2). */
export function cancelledAncestorOrSelf(db: DatabaseSync, id: string | null | undefined): boolean {
  return endedUpChain(db, id, true);
}

/** Walks up `parent_id` from `id`: true at a `cancelled` row on any edge; with `failedEnds`, also at a `failed` row reached only through dependency
 * edges. A loop (corrupt rows) is fail-closed. */
function endedUpChain(db: DatabaseSync, id: string | null | undefined, failedEnds: boolean): boolean {
  const seen = new Set<string>();
  let bound = true;
  for (let current = id ?? null; current;) {
    if (seen.has(current)) {
      console.error("[request-fence] request chain loops; treated as ended", { id });
      return true;
    }
    seen.add(current);
    const row = roomRequest(db, current);
    if (!row) return false;
    if (row.state === "cancelled" || (failedEnds && bound && row.state === "failed")) return true;
    bound = bound && isDependencyEdge(db, row);
    current = row.parentId;
  }
  return false;
}

/** F3 start guard (CANCEL-TREE-104 D3, D4): decided on a fresh read. An `ask`, or a continuation wake, whose asker has ended (cancelledAncestorOrSelf)
 * is completed `cancelled` instead of started; returns that completion, or null when the row may start. A continuation that absorbed another
 * request's result once its asker ended (the asker no longer waiting, so the result joined it) gives that result up to a kept wake (R5) and ends. Called only before the
 * row's turn begins: while it is queued (the card executor) or just marked running by the caller's own dispatch (the room dispatcher, the shared drain).
 * A row that may start takes no write lock (a held lock never stops a start that the guard allows). */
export function closeQueuedIfAskerEnded(db: DatabaseSync, id: string, now: number, hooks: CompletionHooks = {}): CompletionResult | null {
  const unstarted = (request: RoomRequest | null): request is RoomRequest => request !== null && (request.state === "queued" || request.state === "running");
  const before = roomRequest(db, id);
  if (!unstarted(before) || !askerEnded(db, before)) return null;
  return withTx(db, () => {
    const request = roomRequest(db, id);
    if (!unstarted(request) || !askerEnded(db, request)) return null;
    return completeRequest(db, id, { state: "cancelled", now, outcomeNote: CANCELLED_WITH_ASKER }, hooks, { continuation: false });
  });
}

/** Read-only: would `closeQueuedIfAskerEnded` close this row? (the hand-off dispatch's decide(), which only returns a verdict). */
export function askerEnded(db: DatabaseSync, request: RoomRequest): boolean {
  return askerChainEnded(db, request, true);
}

/** CLOUD-COMPUTER-BOOT-105 (Grok r1 Medium): askerEnded's rows (an `ask`, a continuation wake), but ended only by a CANCEL: some request above
 * it is `cancelled`. An asker above it that FAILED does not count: what it handed out keeps running and answers on its own (requestEndedForHandoff). */
export function askerCancelled(db: DatabaseSync, request: RoomRequest): boolean {
  return askerChainEnded(db, request, false);
}

function askerChainEnded(db: DatabaseSync, request: RoomRequest, failedEnds: boolean): boolean {
  const continuation = isContinuationWake(db, request) !== null;
  return (request.verb === "ask" || continuation) && request.parentId !== null && endedUpChain(db, request.parentId, failedEnds);
}

/** What other lanes plug into the one completion transaction. Each runs
 * inside it; a throw rolls the whole completion back. */
export interface CompletionHooks {
  /** Is the request's `card_generation` still the card's current one (5.1)?
   * Absent: no card is involved or lane R has not merged (always current). */
  cardGenerationCurrent?: (db: DatabaseSync, request: RoomRequest) => boolean;
  /** Lane R: apply the 5.1 / 5.1a card effect. Called only when fenced-current. */
  cardEffect?: (db: DatabaseSync, request: RoomRequest) => void;
  /** Lane B: insert the usage row. Called whenever the request ran. */
  settleUsage?: (db: DatabaseSync, request: RoomRequest) => void;
  /** Lane R: the activity row. */
  activity?: (db: DatabaseSync, request: RoomRequest) => void;
  /** Where a card run's or review's result goes back to when the row names
   * a return bot but no thread (lane R's card rows): the room's main thread. */
  returnThread?: (db: DatabaseSync, request: RoomRequest) => string | null;
  /** Status only: boot must never dispatch a turn for interrupted cards. */
  restartCards?: (groupId: string, cardIds: string[]) => void;
  /** Who moves on a card that a run nobody handed over (an owner card) put
   * in review in goal mode: the lead, in the room (lane R's rows decide). */
  reviewWake?: (db: DatabaseSync, request: RoomRequest) => { botId: string; threadId: string } | null;
  /** An owner's queued message ended without a transcript line (the room closed it, it expired,
   * it could not start): keep the owner's words as a chip. Called inside the completing
   * transaction, so the closure and the chip commit together. See `ownerWordsOwed`. */
  ownerWords?: (db: DatabaseSync, request: RoomRequest) => void;
}

/** The note of a request the OWNER cancelled: the one closure that needs no chip, because the owner chose it. */
export const OWNER_CANCEL_NOTE = "cancelled by you";
/** Recorded on a closed owner send once its words are a chip (the durable receipt of that). */
export const OWNER_WORDS_KEPT = "owner_words_kept";
/** The note a restore leaves on a waiting request it expired: its owner words come back as a restore-held chip. */
export const RESTORE_EXPIRED_NOTE = "restored";

/** SQL twin of `ownerWordsOwed` (binds: OWNER_CANCEL_NOTE, OWNER_WORDS_KEPT, in that order): a closed owner send
 * whose words are neither a chip nor in a transcript yet. No age or size based prune may delete such a row. */
export const OWNER_WORDS_OWED_SQL = `(verb='owner_send' AND state IN ('cancelled','failed','expired','unknown')
    AND COALESCE(outcome_note,'')<>? AND COALESCE(refusal,'')<>? AND payload_text IS NOT NULL AND payload_text<>'')`;
/** The same predicate with its two binds written in, so it matches the partial index `room_requests_owner_words` (project-tables.ts)
 * and startup recovery reads only the owed rows, never the history of closed sends. */
export const OWNER_WORDS_OWED_LITERAL_SQL = OWNER_WORDS_OWED_SQL.replace("?", `'${OWNER_CANCEL_NOTE}'`).replace("?", `'${OWNER_WORDS_KEPT}'`);

/** Left by a restore on a `done` owner send whose room turns were never created: startup must not fan it out
 * on its own. Its words come back as a restore-held chip, and only a post-restore Send again runs them. */
export const RESTORE_FANOUT_HELD = "restored_fanout";

/** Does a closed owner_send still owe its owner a chip? Every terminal state but done (its line is
 * the receipt) and the owner's own cancel. A failed or unknown one that had started may have its
 * line already: the caller checks the transcript for those. */
export function ownerWordsOwed(request: RoomRequest): boolean {
  return request.verb === "owner_send" && Boolean(request.payloadText)
    && ["cancelled", "failed", "expired", "unknown"].includes(request.state)
    && request.outcomeNote !== OWNER_CANCEL_NOTE && request.refusal !== OWNER_WORDS_KEPT;
}

/** Record that a closed owner send's words are kept (called in the same transaction as the chip). */
export function markOwnerWordsKept(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE room_requests SET refusal=? WHERE id=? AND verb='owner_send'").run(OWNER_WORDS_KEPT, id);
}

/** Closed owner sends whose chip was never made (the write failed, or the process died between the
 * closure and the chip): startup recovery gives each its chip. */
export function ownerSendsOwingWords(db: DatabaseSync, _now: number = Date.now()): RoomRequest[] {
  // No age cut: owed words are recovered however old the closure is, and `OWNER_WORDS_OWED_SQL` keeps
  // the row out of every prune until the words are a chip (or in the transcript).
  const rows = db.prepare(`SELECT * FROM room_requests WHERE ${OWNER_WORDS_OWED_LITERAL_SQL} ORDER BY finished_at, id`)
    .all() as Record<string, unknown>[];
  return rows.map(fromRow);
}

/** A deleted conversation takes its owner words with it: every owner send aimed at the thread loses
 * its payload (so no chip is ever made from it, at closure or by recovery), and one still waiting is
 * closed as the owner's own cancel so nothing dispatches an empty message. Returns how many changed. */
export function scrubOwnerSendsOfThread(db: DatabaseSync, threadId: string, now: number = Date.now()): number {
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='room_requests'").get()) return 0;
  const where = "verb='owner_send' AND (target_thread_id=?1 OR (target_thread_id IS NULL AND root_thread_id=?1))";
  db.prepare(`UPDATE room_requests SET state='cancelled', finished_at=?2, waiting_since=NULL, outcome_note=?3 WHERE state='queued' AND ${where}`)
    .run(threadId, now, OWNER_CANCEL_NOTE);
  const info = db.prepare(`UPDATE room_requests SET payload_text=NULL WHERE payload_text IS NOT NULL AND ${where}`).run(threadId);
  return Number(info.changes);
}

/** Startup: owner sends whose conversation the owner deleted (a recorded deletion) but whose words survived are scrubbed the same way. */
export function scrubOwnerSendsOfGoneThreads(db: DatabaseSync, isLive: (threadId: string) => boolean, now: number = Date.now()): number {
  // Absence from the registry proves nothing (a file may be missing or partly loaded): only a recorded owner deletion scrubs.
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='room_requests'").get()) return 0;
  const rows = db.prepare("SELECT DISTINCT COALESCE(target_thread_id, root_thread_id) AS t FROM room_requests WHERE verb='owner_send' AND payload_text IS NOT NULL")
    .all() as Array<{ t: string }>;
  let changed = 0;
  for (const { t } of rows) if (!isLive(t) && ownerDeletedThread(db, t)) changed += scrubOwnerSendsOfThread(db, t, now);
  return changed;
}

export interface CompletionResult {
  request: RoomRequest;
  /** Wakes this completion queued (committed with it). */
  wakes: RoomRequest[];
  changed: boolean;
  /** Descendants this completion cancelled (F3: a request that ends other than `done` cancels its open subtree first). */
  cancelled?: RoomRequest[];
  /** Of those, the ones whose turn was running: the caller interrupts each after the commit (`adapter.interruptTurn`, idempotent). */
  interrupt?: RoomRequest[];
}

function withTx<T>(db: DatabaseSync, operation: () => T): T {
  // The tx-scope frame spans the whole transaction, COMMIT included: a transcript line or send chip
  // announced by `operation` reaches clients only once this (or an enclosing) transaction commits.
  return scopedTx(() => {
    const nested = db.isTransaction;
    const point = `room_requests_${randomUUID().replace(/-/g, "")}`;
    db.exec(nested ? `SAVEPOINT ${point}` : "BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec(nested ? `RELEASE ${point}` : "COMMIT");
      return result;
    } catch (error) {
      db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : "ROLLBACK");
      throw error;
    }
  });
}
/** Runs `operation` in one transaction (a savepoint inside an enclosing one); used by recovery to record a decision with its work. */
export function roomRequestsTransaction<T>(db: DatabaseSync, operation: () => T): T { return withTx(db, operation); }

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function fromRow(row: Record<string, unknown>): RoomRequest {
  let executionAudience: unknown = null;
  if (typeof row.execution_audience === "string") {
    try { executionAudience = JSON.parse(row.execution_audience); } catch { executionAudience = null; }
  }
  return {
    id: String(row.id),
    rootId: String(row.root_id),
    parentId: str(row.parent_id),
    cardGeneration: num(row.card_generation),
    attempt: Number(row.attempt),
    groupId: String(row.group_id),
    targetThreadId: str(row.target_thread_id),
    projectGoalId: str(row.project_goal_id),
    workItemId: str(row.work_item_id),
    verb: row.verb as RoomRequestVerb,
    fromKind: row.from_kind as RoomRequestFromKind,
    fromBotId: str(row.from_bot_id),
    toBotId: str(row.to_bot_id),
    payloadText: str(row.payload_text),
    replyToId: str(row.reply_to_id),
    sendId: str(row.send_id),
    mode: (str(row.mode) as "chat" | "goal" | null),
    origin: row.origin as RoomRequestOrigin,
    rootThreadId: String(row.root_thread_id),
    audienceFingerprint: String(row.audience_fingerprint),
    notOwnerAudience: Number(row.not_owner_audience) === 1,
    unattended: Number(row.unattended) === 1,
    executionAudience,
    sourceMessageId: str(row.source_message_id),
    returnThreadId: str(row.return_thread_id),
    returnBotId: str(row.return_bot_id),
    admissionKey: String(row.admission_key),
    priority: row.priority as RoomRequestPriority,
    state: row.state as RoomRequestState,
    refusal: str(row.refusal),
    createdAt: Number(row.created_at),
    dispatchedAt: num(row.dispatched_at),
    deadlineAt: num(row.deadline_at),
    finishedAt: num(row.finished_at),
    ownerWaitMs: Number(row.owner_wait_ms ?? 0),
    waitingSince: num(row.waiting_since),
    resultMessageId: str(row.result_message_id),
    outcomeNote: str(row.outcome_note),
    ...(row.retry_attempts !== undefined && row.retry_attempts !== null ? { retryAttempts: Number(row.retry_attempts) } : {}),
  };
}

export function isTerminalRoomRequestState(state: RoomRequestState): state is RoomRequestTerminalState {
  return (ROOM_REQUEST_TERMINAL_STATES as readonly string[]).includes(state);
}

export function roomRequest(db: DatabaseSync, id: string): RoomRequest | null {
  const row = db.prepare("SELECT * FROM room_requests WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? fromRow(row) : null;
}

/** The request a hand-off stands for, found by its ID (a hand-off and its request share one id by construction, at the one place they are created). Never by the
 * spelling of the admission key: a key is a label, the id is the identity. An earlier build's stand-in record is not a request. */
export function handoffRequest(db: DatabaseSync, id: string): RoomRequest | null {
  const request = roomRequest(db, id);
  return request !== null && request.groupId !== OLD_OWNER_HANDOFF_GROUP ? request : null;
}

export function roomRequestByKey(db: DatabaseSync, admissionKey: string): RoomRequest | null {
  const row = db.prepare("SELECT * FROM room_requests WHERE admission_key=?").get(admissionKey) as Record<string, unknown> | undefined;
  return row ? fromRow(row) : null;
}

/** Insert a request, or return the one already holding its admission key
 * (an HTTP retry, a repeated tool call or envelope: SPEC-P 5.2). */
export function insertRoomRequest(db: DatabaseSync, input: NewRoomRequest): { request: RoomRequest; created: boolean } {
  return withTx(db, () => {
    const existing = roomRequestByKey(db, input.admissionKey);
    if (existing) return { request: existing, created: false };
    const id = input.id ?? randomUUID();
    let rootId = id;
    let lineage: RoomRequestLineage;
    let executionAudience: unknown = null;
    let projectGoalId = input.projectGoalId ?? null;
    if (input.parentId) {
      const parent = roomRequest(db, input.parentId);
      if (!parent) throw new Error(`room request parent ${input.parentId} does not exist`);
      // F3 fence, inside this write transaction: no new ask and no continuation wake under a cancelled request. Lineage edges pass.
      if ((input.verb === "ask" || input.continuation === true) && cancelledAncestorOrSelf(db, parent.id)) throw new RequestEndedError();
      rootId = parent.rootId;
      lineage = {
        rootThreadId: parent.rootThreadId,
        origin: parent.origin,
        audienceFingerprint: parent.audienceFingerprint,
        notOwnerAudience: parent.notOwnerAudience,
        unattended: parent.unattended,
      };
      if (input.narrow) {
        if (input.narrow.notOwnerAudience && !lineage.notOwnerAudience) {
          lineage = { ...lineage, origin: input.narrow.origin, audienceFingerprint: input.narrow.audienceFingerprint, notOwnerAudience: true };
        }
        if (input.narrow.unattended) lineage = { ...lineage, unattended: true };
      }
      executionAudience = parent.executionAudience;
      // a child works for the same goal unless told otherwise
      if (input.projectGoalId === undefined) projectGoalId = parent.projectGoalId;
    } else {
      if (!input.lineage) throw new Error("a root room request needs its lineage");
      lineage = input.lineage;
      executionAudience = lineage.executionAudience ?? issueExecutionAudience(input.fromBotId ?? undefined, lineage.rootThreadId, id);
      if (executionAudience && !validExecutionAudience(executionAudience)) throw new Error("Invalid execution audience");
    }
    if (executionAudience != null && !validExecutionAudience(executionAudience)) throw new Error("Invalid execution audience");
    executionAudience = issueWorkAudience(input.fromBotId ?? undefined, input.toBotId ?? undefined, (input.parentId ? roomRequest(db, input.parentId)?.targetThreadId : null) ?? input.returnThreadId ?? lineage.rootThreadId, validExecutionAudience(executionAudience) ? executionAudience : null, id, !lineage.notOwnerAudience);
    const state = input.state ?? "queued";
    db.prepare(`INSERT INTO room_requests
      (id, root_id, parent_id, card_generation, attempt, group_id, target_thread_id, project_goal_id, work_item_id, verb,
       from_kind, from_bot_id, to_bot_id, payload_text, reply_to_id, send_id, mode, origin, root_thread_id,
       audience_fingerprint, not_owner_audience, unattended, execution_audience, source_message_id, return_thread_id,
       return_bot_id, admission_key, priority, state, created_at, dispatched_at, deadline_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, rootId, input.parentId ?? null, input.cardGeneration ?? null, input.attempt ?? 1, input.groupId,
      input.targetThreadId ?? null, projectGoalId, input.workItemId ?? null, input.verb,
      input.fromKind, input.fromBotId ?? null, input.toBotId ?? null, input.payloadText ?? null,
      input.replyToId ?? null, input.sendId ?? null, input.mode ?? null, lineage.origin, lineage.rootThreadId,
      lineage.audienceFingerprint, lineage.notOwnerAudience ? 1 : 0, lineage.unattended ? 1 : 0,
      executionAudience === null || executionAudience === undefined ? null : JSON.stringify(executionAudience),
      input.sourceMessageId ?? null, input.returnThreadId ?? null, input.returnBotId ?? null, input.admissionKey,
      input.priority ?? "work", state, input.now, state === "running" ? input.now : null, input.deadlineAt ?? null,
    );
    return { request: roomRequest(db, id)!, created: true };
  });
}

export function listRoomRequests(
  db: DatabaseSync,
  filter: { groupId?: string; open?: boolean; before?: number; limit?: number; rootId?: string } = {},
): RoomRequest[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (filter.groupId) { where.push("group_id=?"); args.push(filter.groupId); }
  if (filter.rootId) { where.push("root_id=?"); args.push(filter.rootId); }
  if (filter.open) where.push(`state IN ${OPEN_SQL}`);
  if (filter.before !== undefined) { where.push("created_at < ?"); args.push(filter.before); }
  const limit = Math.max(1, Math.min(filter.limit ?? 1000, 1000));
  const sql = `SELECT * FROM room_requests${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id LIMIT ${limit}`;
  return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(fromRow);
}

/** The dispatch order (5.2): owner, then coordinator, then work; then created_at; then id. */
export interface QueuedRoomRequestFilter {
  groupId?: string;
  /** Only this bot's rows. */
  toBotId?: string;
}
/** Parked (inactive) requests carry this marker in `refusal` together with their `room_request_retry` row: they are kept, never settled, and
 * leave the runnable set (Q1) until their persisted `retry_at` falls due (Q2). Written only by `deferRetainedRoomRequest`. */
export const RETAINED_UNRESOLVED = "retained_unresolved";
export const RETAINED_SWEEP_BATCH = 100;
const RETAINED_BACKOFF_MIN_MS = 30_000;
const RETAINED_BACKOFF_MAX_MS = 3_600_000;
export function retainedBackoffMs(attempts: number): number {
  return Math.min(RETAINED_BACKOFF_MAX_MS, RETAINED_BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(attempts, 20)));
}
const PRIORITY_RANK: Record<string, number> = { owner: 0, coordinator: 1 };

/** Q1, the runnable ids: every queued request that is not parked, in age order. The WHERE text repeats the literal predicate of the partial
 * index `room_requests_runnable`, so the plan is an index walk over the queued rows only, never a scan of the table's history. */
export function runnableRoomRequestIds(db: DatabaseSync, filter: QueuedRoomRequestFilter = {}): string[] {
  const args: Array<string | number> = [];
  if (filter.groupId) args.push(filter.groupId);
  // The bot variant repeats the index's literal term (`to_bot_id IS NOT NULL`) so room_requests_runnable_bot applies and only that bot's runnable rows are read.
  if (filter.toBotId) args.push(filter.toBotId);
  return (db.prepare(runnableRoomRequestIdsSql(filter)).all(...args) as Array<{ id: string }>).map(row => row.id);
}
/** The text of Q1 for a filter (exported so a test can measure the rows the production statement visits). */
export function runnableRoomRequestIdsSql(filter: QueuedRoomRequestFilter = {}): string {
  const where = ["state='queued'", `refusal IS NOT '${RETAINED_UNRESOLVED}'`];
  if (filter.groupId) where.push("group_id=?");
  if (filter.toBotId) where.push("to_bot_id=?", "to_bot_id IS NOT NULL");
  return `SELECT id FROM room_requests WHERE ${where.join(" AND ")} ORDER BY created_at, id`;
}
/** The requests with these ids, in the given order (one primary-key lookup each). */
function requestsByIds(db: DatabaseSync, ids: readonly string[], extra: ReadonlyMap<string, number> = new Map()): RoomRequest[] {
  const select = db.prepare("SELECT * FROM room_requests WHERE id=?");
  const out: RoomRequest[] = [];
  for (const id of ids) {
    const row = select.get(id) as Record<string, unknown> | undefined;
    if (!row) continue;
    out.push(fromRow(extra.has(id) ? { ...row, retry_attempts: extra.get(id) } : row));
  }
  return out;
}
/** The runnable queue (Q1 then a primary-key fetch), with the priority order (owner, coordinator, work) applied here: the runnable set is small. */
export function queuedRoomRequests(db: DatabaseSync, filter: QueuedRoomRequestFilter = {}): RoomRequest[] {
  const rows = requestsByIds(db, runnableRoomRequestIds(db, filter));
  const rank = (r: RoomRequest) => PRIORITY_RANK[r.priority] ?? 2;
  return rows.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
/** Q2, the parked requests whose wait is over: through `room_request_retry_due` with a LIMIT, so the cost follows the work that is due and never
 * the parked backlog. Each carries `retryAttempts`. */
export function dueRetainedRoomRequests(db: DatabaseSync, now: number, limit = RETAINED_SWEEP_BATCH): RoomRequest[] {
  const due = db.prepare("SELECT request_id, attempts FROM room_request_retry WHERE retry_at<=? ORDER BY retry_at, request_id LIMIT ?")
    .all(now, Math.max(1, Math.trunc(limit))) as Array<{ request_id: string; attempts: number }>;
  return requestsByIds(db, due.map(row => row.request_id), new Map(due.map(row => [row.request_id, Number(row.attempts)])));
}

/** Park a queued request that cannot be decided yet, and look at it again later: 30 s, doubling, at most 1 hour (persisted `retry_at`). The row
 * leaves the runnable set through the marker in the same transaction. Returns the next time. */
export function deferRetainedRoomRequest(db: DatabaseSync, id: string, now: number): number {
  return withTx(db, () => {
    const row = db.prepare("SELECT attempts FROM room_request_retry WHERE request_id=?").get(id) as { attempts: number } | undefined;
    const attempts = Number(row?.attempts ?? 0);
    const retryAt = now + retainedBackoffMs(attempts);
    db.prepare(`INSERT INTO room_request_retry(request_id, retry_at, attempts) SELECT id, ?, ? FROM room_requests WHERE id=? AND state='queued'
      ON CONFLICT(request_id) DO UPDATE SET retry_at=excluded.retry_at, attempts=excluded.attempts`).run(retryAt, attempts + 1, id);
    db.prepare("UPDATE room_requests SET refusal=? WHERE id=? AND state='queued'").run(RETAINED_UNRESOLVED, id);
    return retryAt;
  });
}
/** The request is decidable now (known, or being handled): it is runnable again. True when it was parked. */
export function clearRetainedRoomRequest(db: DatabaseSync, id: string): boolean {
  return withTx(db, () => {
    db.prepare("UPDATE room_requests SET refusal=NULL WHERE id=? AND state='queued' AND refusal=?").run(id, RETAINED_UNRESOLVED);
    return Number(db.prepare("DELETE FROM room_request_retry WHERE request_id=?").run(id).changes) > 0;
  });
}
/** Make every parked request due now (the harness finished booting, so a registry that was not loaded is). Bounded work: one statement over the
 * retry set only. The attempts stay: a request that is still unresolved goes back to its long wait, never to the first short one. */
export function wakeRetainedRoomRequests(db: DatabaseSync, now: number): number {
  return Number(db.prepare("UPDATE room_request_retry SET retry_at=? WHERE retry_at>?").run(now, now).changes);
}

/** queued -> running. False when the row is no longer queued (a second
 * dispatcher, a cancel that won): the caller must not start the turn. */
export function markRequestDispatched(
  db: DatabaseSync,
  id: string,
  input: { now: number; targetThreadId?: string },
  token?: HandoffDispatchToken,
): boolean {
  return withTx(db, () => {
    // A request that has a hand-off row is the hand-off's: only the hand-off dispatch (it holds the token) may mark it running. Anything else, a plain starter
    // included, finds it not dispatchable, whatever its key is spelled like.
    const partnered = isDispatchToken(token) || !tableExists(db, "pending_delegations") ? "" : " AND NOT EXISTS (SELECT 1 FROM pending_delegations WHERE pending_delegations.id=room_requests.id)";
    const result = db.prepare(`UPDATE room_requests SET state='running', dispatched_at=?, refusal=NULL,
      target_thread_id=COALESCE(?, target_thread_id) WHERE id=? AND state='queued'${partnered}`)
      .run(input.now, input.targetThreadId ?? null, id);
    if (Number(result.changes) !== 1) return false;
    // The hand-off row of the same id (if any) is stamped by the hand-off dispatch (handoff-dispatch.ts), in the transaction that writes the turn's prompt, never here:
    // a request that is dispatched and then waits on the owner has not started its hand-off.
    return true;
  });
}
const pendingTableKnown = new WeakSet<DatabaseSync>();
function tableExists(db: DatabaseSync, name: string): boolean {
  if (pendingTableKnown.has(db)) return true;
  const found = Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  if (found) pendingTableKnown.add(db);
  return found;
}

/** The arbiter's last refusal for a queued request (7.2 codes). */
export function recordRoomRequestRefusal(db: DatabaseSync, id: string, refusal: string | null): void {
  // A parked request keeps its marker: only `clearRetainedRoomRequest` and a dispatch take it off.
  db.prepare(`UPDATE room_requests SET refusal=? WHERE id=? AND state='queued' AND refusal IS NOT '${RETAINED_UNRESOLVED}'`).run(refusal, id);
}

/** running -> waiting_owner (an approval or question is open). */
export function enterOwnerWait(db: DatabaseSync, id: string, now: number): void {
  db.prepare("UPDATE room_requests SET state='waiting_owner', waiting_since=? WHERE id=? AND state='running'").run(now, id);
}

/** waiting_owner -> running; the wait is not work (5.4). */
export function leaveOwnerWait(db: DatabaseSync, id: string, now: number): void {
  db.prepare(`UPDATE room_requests SET state='running', owner_wait_ms=owner_wait_ms+MAX(0, ?-COALESCE(waiting_since, ?)),
      waiting_since=NULL WHERE id=? AND state='waiting_owner'`).run(now, now, id);
}

export function openAskChildren(db: DatabaseSync, parentId: string): RoomRequest[] {
  return (db.prepare(`SELECT * FROM room_requests WHERE parent_id=? AND verb='ask' AND state IN ${OPEN_SQL} ORDER BY created_at, id`)
    .all(parentId) as Record<string, unknown>[]).map(fromRow);
}

/** Terminal ask children whose outcome the asker has not seen yet. */
function undeliveredAskResults(db: DatabaseSync, parentId: string): ContinuationResult[] {
  return (db.prepare(`SELECT * FROM room_requests WHERE parent_id=? AND verb='ask' AND state IN ${TERMINAL_SQL}
      AND (outcome_note IS NULL OR outcome_note <> 'delivered') ORDER BY created_at, id`)
    .all(parentId) as Record<string, unknown>[]).map(fromRow).map(resultOf);
}

function resultOf(request: RoomRequest): ContinuationResult {
  return {
    requestId: request.id,
    botId: request.toBotId,
    state: request.state,
    ...(request.resultMessageId ? { messageId: request.resultMessageId } : {}),
    ...(request.outcomeNote && request.outcomeNote !== "delivered" ? { note: request.outcomeNote } : {}),
  };
}

export function continuationResults(request: RoomRequest): ContinuationResult[] {
  if (request.verb !== "wake" || !request.payloadText) return [];
  try {
    const parsed = JSON.parse(request.payloadText) as unknown;
    return Array.isArray(parsed) ? parsed as ContinuationResult[] : [];
  } catch {
    return [];
  }
}

function insertWake(
  db: DatabaseSync,
  input: {
    parent: RoomRequest;
    key: string;
    toBotId: string;
    threadId: string;
    results: ContinuationResult[];
    now: number;
    card?: boolean;
    absorb: boolean;
    /** A waiting asker's continuation wake: the only wake the cancelled-ancestor fence refuses. */
    continuation?: boolean;
  },
): RoomRequest | null {
  if (input.parent.notOwnerAudience) return null;
  if (input.absorb) {
    // A result for a bot whose wake has not started joins that wake. Not a
    // review wake held for a lead that is not a member: its next split keeps
    // only the owner cards' results there (round 15).
    const pending = (db.prepare(`SELECT w.* FROM room_requests w LEFT JOIN room_requests p ON p.id=w.parent_id
        WHERE w.verb='wake' AND w.state='queued' AND w.group_id=? AND w.to_bot_id=? AND w.target_thread_id=?
          AND w.payload_text LIKE '[%' AND w.admission_key NOT LIKE 'continue:%'
          AND (w.refusal IS NULL OR w.refusal <> 'lead_not_member')
          AND (p.id IS NULL OR p.state <> 'waiting_bot') ORDER BY w.created_at, w.id LIMIT 1`)
      .get(input.parent.groupId, input.toBotId, input.threadId) as Record<string, unknown> | undefined);
    if (pending) {
      const wake = fromRow(pending);
      const merged = [...continuationResults(wake), ...input.results];
      db.prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run(JSON.stringify(merged), wake.id);
      return null;
    }
  }
  let inserted: { request: RoomRequest; created: boolean };
  try {
    inserted = insertRoomRequest(db, {
    groupId: input.parent.groupId,
    verb: "wake",
    fromKind: "murage",
    toBotId: input.toBotId,
    targetThreadId: input.threadId,
    parentId: input.parent.id,
    projectGoalId: input.parent.projectGoalId,
    ...(input.card ? { workItemId: input.parent.workItemId, cardGeneration: input.parent.cardGeneration, attempt: input.parent.attempt } : {}),
    payloadText: JSON.stringify(input.results),
    admissionKey: input.key,
    priority: "coordinator",
    now: input.now,
    ...(input.continuation ? { continuation: true } : {}),
    });
  } catch (error) {
    if (error instanceof RequestEndedError) return null;
    throw error;
  }
  return inserted.created ? inserted.request : null;
}

/** What one completion did below its own row (F3): the descendants it cancelled and, among them, the ones whose turn was running. */
interface TreeEffects {
  cancelled: RoomRequest[]; interrupt: RoomRequest[];
  /** results a cancelled wake carried from outside the cancelled work, re-queued once every write of the completion is done (CANCEL-TREE-104 R5) */
  orphaned?: Array<{ wake: RoomRequest; results: ContinuationResult[] }>;
  /** the wakes that re-queued them */
  kept?: RoomRequest[];
}
/** The note on a descendant cancelled because a request above it ended other than `done`. */
export const CANCELLED_WITH_ASKER = "cancelled with the request that asked";

/** Can a waiting request be handed its asks' results by a continuation wake (the gate of `wakeWaitingParent`)? */
function canBeWoken(request: RoomRequest): boolean {
  return !request.notOwnerAudience && Boolean(request.toBotId) && Boolean(request.targetThreadId);
}

/**
 * The one completion primitive (SPEC-P 5.2). Idempotent: completing a
 * terminal request changes nothing and queues nothing.
 *
 * F3, one completion rule for every caller (a turn's end, a hand-off's
 * finalizer, the sync close, the receipt listener, both boot passes): a
 * request does not finish `done` while it has a completion dependency:
 *  (i) an open `ask` child: it is parked `waiting_bot`, its last ask's end wakes it;
 *  (ii) finished asks whose results it has not seen, while it has no `wake:<id>`
 *       at all and can be woken: parked, and its one continuation wake is queued now;
 *  (iii) its own open continuation wake: nothing changes, that wake's end completes it.
 * Any other terminal state cancels its whole open subtree first (one walk, every
 * verb), returning the running descendants in `interrupt` for the caller to stop.
 */
export function completeRequest(
  db: DatabaseSync,
  id: string,
  outcome: { state: RoomRequestTerminalState; now: number; resultMessageId?: string | null; outcomeNote?: string | null;
    /** How it ended, as Murage's own line: kept in its own field (server/room-request-status.ts), never in the note. */
    ending?: MurageStatus;
    /** The engine's own words about it, for the owner only. */
    diagnostic?: string },
  hooks: CompletionHooks = {},
  options: { continuation?: boolean; suppressReturnWake?: boolean; stopped?: boolean } = {},
): CompletionResult {
  return withTx(db, () => {
    const current = roomRequest(db, id);
    if (!current) throw new Error(`no room request ${id}`);
    if (isTerminalRoomRequestState(current.state)) return { request: current, wakes: [], changed: false, cancelled: [], interrupt: [] };
    if (outcome.state === "done") {
      const unchanged = (): CompletionResult => ({ request: current, wakes: [], changed: false, cancelled: [], interrupt: [] });
      const park = () => {
        if (current.state === "waiting_bot") return;
        const ownerWait = current.waitingSince !== null ? Math.max(0, outcome.now - current.waitingSince) : 0;
        // Waiting on teammates is not this request's work either: the wait is
        // timed from here and joins owner_wait_ms at completion (work time is
        // terminal - dispatched - owner_wait_ms, SPEC-P 3.8).
        db.prepare(`UPDATE room_requests SET state='waiting_bot', waiting_since=?, owner_wait_ms=owner_wait_ms+?,
            result_message_id=COALESCE(?, result_message_id) WHERE id=?`).run(outcome.now, ownerWait, outcome.resultMessageId ?? null, id);
      };
      // (i) open asks: the last one to end wakes it (continueFrom)
      if (openAskChildren(db, id).length > 0) {
        if (current.state === "waiting_bot") return unchanged();
        park();
        return { request: roomRequest(db, id)!, wakes: [], changed: true, cancelled: [], interrupt: [] };
      }
      const ownWake = roomRequestByKey(db, `wake:${id}`);
      // (iii) its continuation wake is open: that wake's end completes it
      if (ownWake && ownWake.parentId === id && !isTerminalRoomRequestState(ownWake.state)) return unchanged();
      // (ii) results it has not seen, no wake yet, and someone to hand them to: the one wake, now
      if (!ownWake && canBeWoken(current) && undeliveredAskResults(db, id).length > 0) {
        park();
        const wakes = wakeWaitingParent(db, roomRequest(db, id)!, outcome.now, hooks);
        if (wakes.length > 0) return { request: roomRequest(db, id)!, wakes, changed: true, cancelled: [], interrupt: [] };
        // the fence refused the wake (a request above it was cancelled): nobody takes the results, so it completes here
      }
    }
    const effects: TreeEffects = { cancelled: [], interrupt: [] };
    // CANCEL-TREE-104 R5 root rule: a cancelled wake with results owns its parent's result (a return wake) and, when it is the parent's own
    // continuation (isContinuationWake: it carries the parent's asks' results; a return wake shares the `wake:<id>` key but not this), the parent's whole subtree; results absorbed from outside that are kept
    // (keepResults, after the terminal write). An ordinary return wake's parent is done and its subtree is not this wake's: a sibling's result is kept.
    const rootOwn = new Set<string>();
    let rootOutside: ContinuationResult[] = [];
    if (outcome.state === "cancelled" && current.verb === "wake" && current.parentId && continuationResults(current).length > 0) {
      rootOwn.add(current.parentId);
      if (isContinuationWake(db, current) !== null) for (const row of collectSubtree(db, current.parentId, "whole")) rootOwn.add(row.id);
    }
    // an explicit cancel (the owner's Cancel, Stop all, deletion) closes everything below it; any other ending (failed, expired, unknown: a
    // failed turn, a restart) closes only what depends on this request's answer, never the work it handed out (SPEC-P line 488: restart of a card run)
    if (outcome.state !== "done") cancelOpenSubtree(db, id, outcome.now, hooks, effects, outcome.state === "cancelled" ? "whole" : "dependencies", rootOwn);
    if (rootOwn.size > 0) {
      const own = new Set<string>([id, ...rootOwn, ...collectSubtree(db, id, "whole").map((row) => row.id)]);
      rootOutside = outsideResults(db, current, own);
      stripOutsideResults(db, current, rootOutside);
    }
    const ended = terminalWrite(db, current, outcome, hooks, options, effects);
    // every write of this completion is done (the walk, the root, its cascade): now the kept results, so none can be absorbed into a row this cancel ends
    for (const { wake, results } of effects.orphaned ?? []) keepResults(db, wake, results, outcome.now, effects);
    keepResults(db, current, rootOutside, outcome.now, effects);
    return { ...ended, wakes: [...ended.wakes, ...(effects.kept ?? [])], cancelled: effects.cancelled, interrupt: effects.interrupt };
  });
}

/** Does `row` exist only to answer its parent: an `ask` (a hand-off whose result the asker waits on) or the parent's own continuation wake?
 * Cards (`assign`, `review`), member room turns and return wakes are work handed out, not dependencies. */
function isDependencyEdge(db: DatabaseSync, row: RoomRequest): boolean {
  return row.verb === "ask" || isContinuationWake(db, row) !== null;
}

/** The ONE subtree walk (F3). `whole` (an explicit cancel): every descendant by `parent_id`, any verb, any state (so a queued return wake under a
 * finished intermediate is found). `dependencies` (failed, expired, unknown): only the asks and continuation wakes below it, recursively; the
 * cards a lead's turn created inherit that turn as parent but are not waiting on it, so they keep running (or wait for Retry after a restart).
 * Each open row reached is written `cancelled` with no continuation (nothing inside the subtree continues), and the running ones are listed for
 * interruption. Inside the caller's transaction. */
function cancelOpenSubtree(db: DatabaseSync, rootId: string, now: number, hooks: CompletionHooks, effects: TreeEffects, scope: "whole" | "dependencies", ownScope: ReadonlySet<string> = new Set()): void {
  // the scope first (CANCEL-TREE-104 R5), then the writes: a wake's results are judged against everything this cancel ends
  const rows = collectSubtree(db, rootId, scope);
  const own = new Set<string>([rootId, ...ownScope, ...rows.map((row) => row.id)]);
  const orphaned: Array<{ wake: RoomRequest; results: ContinuationResult[] }> = [];
  for (const row of rows) {
    if (isTerminalRoomRequestState(row.state)) continue;
    const running = row.state === "running" || row.state === "waiting_owner";
    const outside = row.verb === "wake" ? outsideResults(db, row, own) : [];
    stripOutsideResults(db, row, outside);
    const ended = terminalWrite(db, row, { state: "cancelled", now, outcomeNote: CANCELLED_WITH_ASKER }, hooks, { continuation: false }, effects);
    if (!ended.changed) continue;
    effects.cancelled.push(ended.request);
    if (running) effects.interrupt.push(ended.request);
    if (outside.length) orphaned.push({ wake: row, results: outside });
  }
  // re-queued by completeRequest after its own terminal write: a kept wake can only join a wake this completion leaves alone (never the root)
  (effects.orphaned ??= []).push(...orphaned);
}

/** The terminal write itself: state, card effect, usage, activity, owner words, and the continuation (SPEC-P 5.2). Only `completeRequest` and the
 * subtree walk call it. */
function terminalWrite(
  db: DatabaseSync,
  current: RoomRequest,
  outcome: Parameters<typeof completeRequest>[2],
  hooks: CompletionHooks,
  options: { continuation?: boolean; suppressReturnWake?: boolean; stopped?: boolean },
  effects: TreeEffects,
): { request: RoomRequest; wakes: RoomRequest[]; changed: boolean } {
    const id = current.id;
    if (isTerminalRoomRequestState(current.state)) return { request: current, wakes: [], changed: false };
    const ran = current.dispatchedAt !== null;
    // only a run that started can be superseded: a queued card run carries
    // the generation its dispatch will write (lane R), not the card's current one
    const fenced = ran && current.workItemId !== null && current.cardGeneration !== null && hooks.cardGenerationCurrent
      ? !hooks.cardGenerationCurrent(db, current)
      : false;
    const ownerWait = current.waitingSince !== null ? Math.max(0, outcome.now - current.waitingSince) : 0;
    // Completion/cancellation changes the run's state, never its recorded
    // review evidence. Generation fencing below still prevents stale effects.
    const reviewVerdict = current.verb === "review" && (current.outcomeNote === "pass" || current.outcomeNote === "changes");
    // lane review: a review run that finished without any verdict says so
    const noVerdict = current.verb === "review" && !reviewVerdict && !fenced && outcome.state === "done" && !outcome.outcomeNote && !current.outcomeNote;
    const note = reviewVerdict ? current.outcomeNote : fenced ? "superseded" : noVerdict ? "No verdict given" : (outcome.outcomeNote ?? current.outcomeNote);
    db.prepare(`UPDATE room_requests SET state=?, finished_at=?, result_message_id=COALESCE(?, result_message_id),
        outcome_note=?, waiting_since=NULL, owner_wait_ms=owner_wait_ms+?,
        refusal=CASE WHEN refusal='retained_unresolved' THEN NULL ELSE refusal END WHERE id=?`)
      .run(outcome.state, outcome.now, outcome.resultMessageId ?? null, note === null ? null : note.slice(0, 200), ownerWait, id);
    writeRequestStatus(db, id, outcome.ending, outcome.diagnostic);
    const done = roomRequest(db, id)!;
    // A card's effect is applied once, by the card's own request: a
    // continuation wake finishes the waiting card request, which applies it.
    if (!fenced && done.workItemId && (done.verb !== "wake" || done.state === "unknown")) hooks.cardEffect?.(db, done);
    // a review's card effect may re-point its result to the current lead (lane review)
    if (done.verb === "review") Object.assign(done, roomRequest(db, id)!);
    if (ran) hooks.settleUsage?.(db, done);
    hooks.activity?.(db, done);
    if (hooks.ownerWords && ownerWordsOwed(done)) hooks.ownerWords(db, done);
    // An interrupted card is an owner decision, including a card whose
    // continuation was interrupted. Retry or Skip must precede another wake.
    if (!fenced && done.state === "unknown" && done.workItemId && done.verb === "wake" && done.parentId && done.admissionKey === `wake:${done.parentId}`) {
      const parent = roomRequest(db, done.parentId);
      if (parent?.state === "waiting_bot") absorb(effects, completeRequest(db, parent.id, { state: "unknown", now: outcome.now, outcomeNote: done.outcomeNote }, hooks, { continuation: false }));
    }
    if (fenced || options.continuation === false || (done.state === "unknown" && done.workItemId !== null)) return { request: done, wakes: [], changed: true };
    return { request: done, wakes: continueFrom(db, done, outcome.now, hooks, options.suppressReturnWake, options.stopped, effects), changed: true };
}

/** A nested completion's cancellations reach the outermost caller. */
function absorb(effects: TreeEffects, result: CompletionResult): CompletionResult {
  effects.cancelled.push(...(result.cancelled ?? []));
  effects.interrupt.push(...(result.interrupt ?? []));
  return result;
}

/** The rows a walk from `rootId` visits, in BFS order, root excluded: every descendant (`whole`) or only the asks and continuation wakes (`dependencies`). */
function collectSubtree(db: DatabaseSync, rootId: string, scope: "whole" | "dependencies"): RoomRequest[] {
  const children = db.prepare("SELECT * FROM room_requests WHERE parent_id=? ORDER BY created_at, id");
  const seen = new Set<string>([rootId]);
  const rows: RoomRequest[] = [];
  for (let frontier = [rootId]; frontier.length > 0;) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const row of (children.all(parentId) as Record<string, unknown>[]).map(fromRow)) {
        if (seen.has(row.id)) continue;
        if (scope === "dependencies" && !isDependencyEdge(db, row)) continue;
        seen.add(row.id);
        next.push(row.id);
        rows.push(row);
      }
    }
    frontier = next;
  }
  return rows;
}

/** CANCEL-TREE-104 R5: the results a wake carries that belong outside `own` (the work being cancelled), whose request still exists. A result whose request row
 * is gone has nobody to return to: it ends with the wake. */
function outsideResults(db: DatabaseSync, wake: RoomRequest, own: ReadonlySet<string>): ContinuationResult[] {
  return continuationResults(wake).filter((result) => {
    if (typeof result?.requestId !== "string" || own.has(result.requestId)) return false;
    if (roomRequest(db, result.requestId) !== null) return true;
    console.error("[request-fence] a cancelled wake carried a result whose request is gone; it ends with the wake", { wake: wake.id, result: result.requestId });
    return false;
  });
}

/** The cancelled wake keeps only its own results; the outside ones are re-queued after every write of the walk (keepResults). */
function stripOutsideResults(db: DatabaseSync, wake: RoomRequest, outside: readonly ContinuationResult[]): void {
  if (!outside.length) return;
  const gone = new Set(outside.map((result) => result.requestId));
  db.prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run(JSON.stringify(continuationResults(wake).filter((result) => !gone.has(result.requestId))), wake.id);
}

/** Re-queues the results a cancelled wake carried from outside the cancelled work: one wake to the same bot and thread (absorb: it joins a queued wake of
 * theirs, never a cancelled one, since every write of the walk is done), under `wake:kept:<cancelled wake>` (`:2`, `:3` when taken), parent = the request of
 * the first result (outside the cancelled work, so no fence refuses it). */
function keepResults(db: DatabaseSync, wake: RoomRequest, results: ContinuationResult[], now: number, effects: TreeEffects): void {
  if (!results.length || !wake.toBotId || !wake.targetThreadId) return;
  const parent = roomRequest(db, results[0]!.requestId);
  if (!parent) return;
  let key = `wake:kept:${wake.id}`;
  for (let n = 2; roomRequestByKey(db, key); n++) key = `wake:kept:${wake.id}:${n}`;
  const kept = insertWake(db, { parent, key, toBotId: wake.toBotId, threadId: wake.targetThreadId, results, now, absorb: true });
  if (kept) (effects.kept ??= []).push(kept);
}

function continueFrom(db: DatabaseSync, done: RoomRequest, now: number, hooks: CompletionHooks, suppressReturnWake = false, stopped = false, effects: TreeEffects = { cancelled: [], interrupt: [] }): RoomRequest[] {
  const parent = done.parentId ? roomRequest(db, done.parentId) : null;
  // An asker waiting on its asks: the last one to finish wakes it, once.
  if (done.verb === "ask" && parent && parent.state === "waiting_bot") {
    if (openAskChildren(db, parent.id).length > 0) return [];
    return wakeWaitingParent(db, parent, now, hooks);
  }
  if (done.verb === "ask" && parent) return []; // the asker's turn is still running: its end decides
  // A waiting asker's continuation finished: the asker finishes with it.
  if (done.verb === "wake" && parent && parent.state === "waiting_bot" && done.admissionKey === `wake:${parent.id}`) {
    // a restart that cut the continuation off is a restart for the asker too,
    // not a failure of its work (a card waits for Retry step, SPEC-P 5.6)
    const state: RoomRequestTerminalState = done.state === "done" ? "done" : done.state === "cancelled" ? "cancelled" : done.state === "unknown" ? "unknown" : "failed";
    return absorb(effects, completeRequest(db, parent.id, { state, now, resultMessageId: done.resultMessageId, ...(done.state === "unknown" || suppressReturnWake ? { outcomeNote: done.outcomeNote } : {}) }, hooks, { suppressReturnWake, stopped })).wakes;
  }
  // Stop still settles the waiting parent and its card effect; only the
  // outgoing handoff to the lead is suppressed.
  if (suppressReturnWake) return [];
  // A handed-over piece of work comes back to whoever handed it over.
  const returns = done.verb === "assign" || done.verb === "review" || (done.verb === "ask" && !parent);
  const returnThreadId = done.returnThreadId ?? (done.workItemId ? hooks.returnThread?.(db, done) ?? null : null);
  if (returns && done.returnBotId && returnThreadId) {
    // `wake:<id>` is also the key of this request's own continuation wake when
    // it waited on asks (a card run that asked a teammate): its result to the
    // return bot then takes the `:return` form, so neither swallows the other.
    const continued = Boolean(roomRequestByKey(db, `wake:${done.id}`));
    const key = done.state === "unknown" ? `wake:restart:${done.id}` : continued ? `wake:${done.id}:return` : `wake:${done.id}`;
    const wake = insertWake(db, { parent: done, key, toBotId: done.returnBotId, threadId: returnThreadId, results: [{ ...resultOf(done), ...(stopped ? { stopped: true } : {}) }], now, absorb: true });
    return wake ? [wake] : [];
  }
  // An owner card has nobody to return to. When its run put it in review in
  // goal mode the lead is the one who moves it on (AFTER-PF: three owner
  // cards sat in review and the lead never heard of them).
  const review = done.verb === "assign" && !done.returnBotId ? hooks.reviewWake?.(db, done) : null;
  if (review) {
    const wake = queueReviewWake(db, done, { toBotId: review.botId, threadId: review.threadId, now });
    return wake ? [wake] : [];
  }
  return [];
}

/** The lead's `wake:review:<run>` for an owner card's run that put its card
 * in review: at the run's completion, or later once there is a lead to wake
 * (project-turn-engine.ts queueHeldReviewWakes, under its own `key` when the
 * base key's wake ended undelivered). It joins a wake of the lead's that has
 * not started. */
export function queueReviewWake(db: DatabaseSync, run: RoomRequest, input: { toBotId: string; threadId: string; now: number; key?: string }): RoomRequest | null {
  return insertWake(db, { parent: run, key: input.key ?? `wake:review:${run.id}`, toBotId: input.toBotId, threadId: input.threadId, results: [resultOf(run)], now: input.now, absorb: true });
}

/** An owner card's run: a handed-over `assign` of a card nobody returns to. */
function ownerCardResult(db: DatabaseSync, result: ContinuationResult): boolean {
  const run = typeof result.requestId === "string" ? roomRequest(db, result.requestId) : null;
  return Boolean(run && run.verb === "assign" && run.workItemId && !run.returnBotId);
}

/** A review wake (an owner card waiting in review, `wake:review:<run>`) is
 * addressed to the lead when the run completed. The lead can change before
 * the wake is admitted: then the owner cards' results in it go to the
 * current lead instead, joining a wake of theirs that has not started. Any
 * other result it absorbed (an answer to the old lead's own ask) goes to
 * the old lead in a wake of its own while it is still a member
 * (`keepForOldLead`, `wake:kept:<wake>`, round 18); the wake completes as
 * absorbed. Nothing changes while there is
 * no lead (the wake is held, room-dispatcher.ts), for a wake with no owner card result,
 * or for any other wake. A lead that is not a member of the room is not
 * handed the wake (as reviewWakeTarget refuses it): the wake is `held`
 * where it is until the lead is one (round 13), holding only the owner
 * cards' results; the rest go to the old lead now in a wake of their own
 * (`wake:kept:<wake>`, then `wake:kept:<wake>:<n>`) while it is a member
 * (rounds 14, 15). Returns the new
 * wake, when one was queued. */
export function readdressReviewWake(db: DatabaseSync, request: RoomRequest, input: { leadBotId: string | null | undefined; memberIds: readonly string[]; now: number; keepForOldLead?: boolean }): { readdressed: boolean; held?: true; wakes: RoomRequest[] } {
  if (request.verb !== "wake" || request.state !== "queued" || !request.admissionKey.startsWith("wake:review:") || !request.parentId || !request.targetThreadId) return { readdressed: false, wakes: [] };
  if (!input.leadBotId || input.leadBotId === request.toBotId) return { readdressed: false, wakes: [] };
  const lead = input.leadBotId;
  return withTx(db, () => {
    const parent = roomRequest(db, request.parentId!);
    const current = roomRequest(db, request.id);
    if (!parent || current?.state !== "queued") return { readdressed: false, wakes: [] };
    const results = continuationResults(current);
    const moving = results.filter((result) => ownerCardResult(db, result));
    if (!moving.length) return { readdressed: false, wakes: [] };
    const staying = results.filter((result) => !moving.includes(result));
    // nothing is queued for an old lead that is not a member (round 19)
    const keep = Boolean(input.keepForOldLead && input.memberIds.includes(request.toBotId!));
    if (!input.memberIds.includes(lead)) {
      if (!staying.length || !keep) return { readdressed: false, held: true, wakes: [] };
      // not absorbed: the old lead's pending wake is this held one. Only once
      // the kept wake has them does the held wake drop them (round 15).
      const kept = keepOldLeadAnswers(db, request, parent, staying, input.now);
      if (!kept.ok) return { readdressed: false, held: true, wakes: [] };
      db.prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run(JSON.stringify(moving), request.id);
      return { readdressed: false, held: true, wakes: kept.wake ? [kept.wake] : [] };
    }
    // the base wake stays addressed to the old lead, no longer the lead, so
    // nothing may run it: its answers go in a kept wake too (round 18)
    // Not kept: the base wake stays put, held, rather than run by a bot no
    // longer the lead (round 19)
    const kept = staying.length && keep ? keepOldLeadAnswers(db, request, parent, staying, input.now) : null;
    if (kept && !kept.ok) return { readdressed: false, held: true, wakes: [] };
    completeRequest(db, request.id, { state: "done", now: input.now, outcomeNote: "absorbed" }, {}, { continuation: false });
    const wake = insertWake(db, { parent, key: `wake:review:${parent.id}:${request.id}`, toBotId: lead, threadId: request.targetThreadId!,
      results: moving, now: input.now, absorb: true });
    return { readdressed: true, wakes: [...(kept?.wake ? [kept.wake] : []), ...(wake ? [wake] : [])] };
  });
}

/** The old lead's own answers split from its review wake: they join its
 * kept wake while that has not started, else a new one under a fresh key
 * (`wake:kept:<wake>`, then `wake:kept:<wake>:<n>`). Not ok when neither
 * took them. */
function keepOldLeadAnswers(db: DatabaseSync, request: RoomRequest, parent: RoomRequest, staying: ContinuationResult[], now: number): { ok: boolean; wake?: RoomRequest } {
  const keptRows = db.prepare("SELECT * FROM room_requests WHERE admission_key=? OR admission_key LIKE ? ORDER BY created_at, id")
    .all(`wake:kept:${request.id}`, `wake:kept:${request.id}:%`) as Array<Record<string, unknown>>;
  const open = keptRows.map(fromRow).find((wake) => wake.state === "queued");
  if (open) {
    db.prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run(JSON.stringify([...continuationResults(open), ...staying]), open.id);
    return { ok: true };
  }
  const key = keptRows.length ? `wake:kept:${request.id}:${keptRows.length + 1}` : `wake:kept:${request.id}`;
  const kept = insertWake(db, { parent, key, toBotId: request.toBotId!, threadId: request.targetThreadId!, results: staying, now, absorb: false });
  return kept ? { ok: true, wake: kept } : { ok: false };
}

/** SPEC-P 10: what a bot's reply or result answers, always in its own
 * thread: the request's source message when it is in that thread, else the
 * nearest one up the request's lineage (a wake continues its asker's turn; a
 * handed-over result answers what the asker was answering). Cross-thread
 * lineage stays in `requestId`. */
export function requestReplyTarget(db: DatabaseSync, request: RoomRequest | null, inThread: (messageId: string) => boolean): string | undefined {
  const seen = new Set<string>();
  for (let current = request; current && !seen.has(current.id) && seen.size < 50; current = current.parentId ? roomRequest(db, current.parentId) : null) {
    seen.add(current.id);
    if (current.sourceMessageId && inThread(current.sourceMessageId)) return current.sourceMessageId;
  }
  return undefined;
}

/** Whether a wake is a continuation of a request that runs on its worker's own thread (a desk or home thread that is not one of the room's
 * tasks): the bot that asked on the parent request, woken on the thread that request was started in, with what its own asks returned. Such
 * a wake is the parent's to continue, not a room turn, so the room does not have to own the thread (it is started there). */
export function wakeContinuesOnParentThread(db: DatabaseSync, request: Pick<RoomRequest, "verb" | "parentId" | "toBotId" | "targetThreadId" | "admissionKey">): boolean {
  if (request.verb !== "wake" || !request.parentId || !request.targetThreadId || request.admissionKey !== `wake:${request.parentId}`) return false;
  const parent = roomRequest(db, request.parentId);
  return Boolean(parent && parent.toBotId && parent.toBotId === request.toBotId && parent.targetThreadId === request.targetThreadId);
}

function wakeWaitingParent(db: DatabaseSync, parent: RoomRequest, now: number, hooks: CompletionHooks = {}): RoomRequest[] {
  // Nobody to hand the results to (a chain that is not the owner's, or no
  // bot or thread): the asker finishes here instead of waiting forever.
  if (parent.notOwnerAudience || !parent.toBotId || !parent.targetThreadId) {
    // a normal completion (F3): its own asker, non-owner too, is reached through continueFrom and ends the same way
    if (parent.state === "waiting_bot") return completeRequest(db, parent.id, { state: "done", now, outcomeNote: "answers posted, nobody woken" }, hooks).wakes;
    return [];
  }
  const wake = insertWake(db, {
    parent,
    key: `wake:${parent.id}`,
    toBotId: parent.toBotId,
    threadId: parent.targetThreadId,
    results: undeliveredAskResults(db, parent.id),
    now,
    card: parent.workItemId !== null,
    absorb: false,
    continuation: true,
  });
  return wake ? [wake] : [];
}

/**
 * A request's turn ended (the engine's terminal event, or a setup failure).
 * The turn-end entry of the one completion rule (`completeRequest`): with open
 * asks it waits for them; with asks that finished while it ran it waits for the
 * one wake that hands their results over; otherwise it completes.
 */
export function finishRequestTurn(
  db: DatabaseSync,
  id: string,
  input: { ok: boolean; now: number; resultMessageId?: string | null; outcomeNote?: string | null; ending?: MurageStatus; diagnostic?: string },
  hooks: CompletionHooks = {},
): CompletionResult {
  return withTx(db, () => {
    const current = roomRequest(db, id);
    if (!current) throw new Error(`no room request ${id}`);
    if (isTerminalRoomRequestState(current.state) || current.state === "waiting_bot") {
      return { request: current, wakes: [], changed: false };
    }
    if (!input.ok) return completeRequest(db, id, { state: "failed", now: input.now, resultMessageId: input.resultMessageId, outcomeNote: input.outcomeNote,
      ...(input.ending ? { ending: input.ending } : {}), ...(input.diagnostic !== undefined ? { diagnostic: input.diagnostic } : {}) }, hooks);
    return completeRequest(db, id, { state: "done", now: input.now, resultMessageId: input.resultMessageId, outcomeNote: input.outcomeNote }, hooks);
  });
}

/**
 * Cancel a `queued` or `waiting_bot` request (the owner's Cancel, Stop all,
 * room deletion) and, in the same transaction, its whole open subtree (F3):
 * every descendant, any verb, is cancelled and nothing inside it continues;
 * the running ones come back in `interrupt` for the caller to stop after the
 * commit. The cancelled request itself keeps its continuation (a waiting
 * asker above it is woken by its last open child, as ever). Returns null when
 * the request cannot be cancelled here (running: interrupt the turn instead).
 */
export function cancelRoomRequest(
  db: DatabaseSync,
  id: string,
  input: { now: number; note?: string },
  hooks: CompletionHooks = {},
): { request: RoomRequest; cancelled: RoomRequest[]; interrupt: RoomRequest[] } | null {
  return withTx(db, () => {
    const current = roomRequest(db, id);
    if (!current || (current.state !== "queued" && current.state !== "waiting_bot")) return null;
    const ended = completeRequest(db, id, { state: "cancelled", now: input.now, outcomeNote: input.note ?? "cancelled" }, hooks, { continuation: true });
    return { request: ended.request, cancelled: ended.cancelled ?? [], interrupt: ended.interrupt ?? [] };
  });
}

/** A waiting asker's own continuation wake (`wake:<parent>` addressed to the asker itself), as opposed to a return wake under the same key. A return
 * wake carries its parent's own result; a continuation never does (it carries the parent's asks' results), so a same-bot return (the lead reviewing
 * a card it returns to) is told apart by its payload, not by key and bot alone (CANCEL-TREE-104 H1). */
function isContinuationWake(db: DatabaseSync, request: RoomRequest): RoomRequest | null {
  if (request.verb !== "wake" || !request.parentId || request.admissionKey !== `wake:${request.parentId}`) return null;
  if (continuationResults(request).some((result) => result?.requestId === request.parentId)) return null;
  const parent = roomRequest(db, request.parentId);
  return parent && parent.toBotId !== null && parent.toBotId === request.toBotId ? parent : null;
}

/** The coordination trace a request's turn carries (F3, 02-3), derived from the request tree, never stored: the execution-chain root R is the
 * nearest ancestor-or-self that is neither an `ask` nor a continuation wake (a row whose depth-0 turn ran it: a member or usage `room_turn`,
 * `routine`, `assign`, `review`, a return or review wake); `rootId` is `req:<R.id>`; `path` is R's bot then the bot of each ask from R down to
 * the request, continuation wakes skipped; `commsDepth` is `path.length - 1`. Null for a parentless `ask` (a shared ask from a direct
 * conversation: the caller derives its trace from its admission key or carries its hand-off row's), for an owner root (no bot), and for a
 * chain the walk cannot finish (a missing row, more than 50 hops). */
export function requestTrace(db: DatabaseSync, request: RoomRequest): { rootId: string; path: string[]; commsDepth: number } | null {
  const asks: string[] = [];
  const seen = new Set<string>();
  for (let current: RoomRequest | null = request; current && !seen.has(current.id) && seen.size < 50;) {
    seen.add(current.id);
    if (current.verb === "ask") {
      if (!current.toBotId || !current.parentId) return null;
      asks.push(current.toBotId);
      current = roomRequest(db, current.parentId);
      continue;
    }
    const asker = isContinuationWake(db, current);
    if (asker) { current = asker; continue; }
    if (!current.toBotId) return null;
    const path = [current.toBotId, ...asks.reverse()];
    return { rootId: `req:${current.id}`, path, commsDepth: path.length - 1 };
  }
  return null;
}

/** The turn generation in a sync ask's admission key (`ask:<thread>:<generation>:<hash>`, server/index.ts roomAskKey): the asker's depth-0 root
 * when the ask has no request tree (a shared ask from a direct conversation). */
export function askKeyGeneration(admissionKey: string): string | null {
  if (!admissionKey.startsWith("ask:") || admissionKey.startsWith("ask:delegation:")) return null;
  const parts = admissionKey.split(":");
  return parts.length >= 4 && parts[parts.length - 2] ? parts[parts.length - 2] : null;
}

/**
 * Would an ask from `fromBotId` to `toBotId` close a wait cycle (5.2)? Walk
 * from the target's waiting requests along their open asks; reaching the
 * asker is a deadlock. Running requests with open asks count as waiting.
 */
export function askWouldDeadlock(db: DatabaseSync, fromBotId: string, toBotId: string): boolean {
  if (fromBotId === toBotId) return true;
  const seen = new Set<string>([toBotId]);
  let frontier = [toBotId];
  for (let hop = 0; hop < DEADLOCK_WALK_HOPS && frontier.length; hop += 1) {
    const next: string[] = [];
    for (const botId of frontier) {
      const rows = db.prepare(`SELECT c.to_bot_id AS waits_on FROM room_requests p JOIN room_requests c ON c.parent_id=p.id
          WHERE p.to_bot_id=? AND p.state IN ('waiting_bot','running','waiting_owner') AND c.verb='ask' AND c.state IN ${OPEN_SQL}
            AND c.to_bot_id IS NOT NULL`).all(botId) as Array<{ waits_on: string }>;
      for (const { waits_on } of rows) {
        if (waits_on === fromBotId) return true;
        if (!seen.has(waits_on)) { seen.add(waits_on); next.push(waits_on); }
      }
    }
    frontier = next;
  }
  return false;
}

/** The durable root budget (6.2): wakes, assignments and reviews under one
 * owner message, and the team's work time (dispatch to finish, less owner
 * waits). Settled work comes from the ledger, never restart wall time. */
export function rootCounters(db: DatabaseSync, rootId: string, now: number): { wakes: number; assigns: number; reviews: number; workMs: number } {
  const counts = db.prepare(`SELECT
      SUM(CASE WHEN verb='wake' AND dispatched_at IS NOT NULL THEN 1 ELSE 0 END) AS wakes,
      SUM(CASE WHEN verb='assign' THEN 1 ELSE 0 END) AS assigns,
      SUM(CASE WHEN verb='review' THEN 1 ELSE 0 END) AS reviews,
      SUM(CASE WHEN dispatched_at IS NOT NULL AND verb <> 'owner_send' AND state IN ('running','waiting_owner')
        THEN MAX(0, COALESCE(finished_at, ?) - dispatched_at - owner_wait_ms
          - CASE WHEN waiting_since IS NOT NULL AND finished_at IS NULL THEN ? - waiting_since ELSE 0 END)
        ELSE 0 END) AS work
    FROM room_requests WHERE root_id=?`).get(now, now, rootId) as Record<string, unknown>;
  return {
    wakes: Number(counts.wakes ?? 0),
    assigns: Number(counts.assigns ?? 0),
    reviews: Number(counts.reviews ?? 0),
    workMs: Number(counts.work ?? 0) + Number(db.prepare("SELECT COALESCE(SUM(work_ms),0) AS work FROM usage_ledger WHERE root_id=?").get(rootId)!.work),
  };
}

/**
 * The conversation cap's budget (plan 3.2: "6 lead wakes or 30 minutes of
 * team work per owner message"): the steps taken in this room thread since
 * the owner's last message there. Counting from the owner's message rather
 * than by root means work that waited behind "Say continue" goes on under
 * the new message's budget with its own lineage untouched (a waiting asker
 * still completes when its continuation does). Rows, so a restart keeps it.
 */
export function conversationCounters(db: DatabaseSync, input: { groupId: string; threadId: string; now: number }): { wakes: number; workMs: number } {
  const last = db.prepare(`SELECT MAX(COALESCE(finished_at, created_at)) AS at FROM room_requests
      WHERE group_id=? AND verb='owner_send' AND state='done' AND COALESCE(target_thread_id, root_thread_id)=?`).get(input.groupId, input.threadId) as { at: number | null };
  const since = Number(last.at ?? 0);
  // Steps are the wakes dispatched since the message; work is the active
  // time inside the window, so a handoff still running when the owner wrote
  // counts from that moment on (its earlier time belonged to the last budget).
  const row = db.prepare(`SELECT
      SUM(CASE WHEN verb='wake' AND dispatched_at >= ? THEN 1 ELSE 0 END) AS wakes,
      SUM(CASE WHEN state IN ('running','waiting_owner') THEN MAX(0, ? - MAX(dispatched_at, ?)
        - CASE WHEN dispatched_at >= ? THEN owner_wait_ms ELSE 0 END
        - CASE WHEN waiting_since IS NOT NULL THEN ? - MAX(waiting_since, ?) ELSE 0 END) ELSE 0 END) AS work
    FROM room_requests WHERE group_id=? AND verb <> 'owner_send' AND dispatched_at IS NOT NULL
      AND (target_thread_id=? OR return_thread_id=?)`).get(since, input.now, since, since, input.now, since, input.groupId, input.threadId, input.threadId) as Record<string, unknown>;
  const settled = db.prepare(`SELECT COALESCE(SUM(MIN(work_ms, MAX(0, at - ?))),0) AS work FROM usage_ledger
    WHERE group_id=? AND at > ? AND root_id IN (
      SELECT root_id FROM room_requests WHERE group_id=? AND (target_thread_id=? OR return_thread_id=? OR root_thread_id=?)
    )`).get(since, input.groupId, since, input.groupId, input.threadId, input.threadId, input.threadId) as { work: number };
  return { wakes: Number(row.wakes ?? 0), workMs: Number(row.work ?? 0) + Number(settled.work) };
}

/**
 * Boot, first step (SPEC-P 6.3): an ask whose result message was written
 * (it carries the request id) before the process ended is answered, not
 * interrupted, so it completes with that message; the rest go `unknown`.
 */
export function recoverCommittedAskResults(
  db: DatabaseSync,
  now: number,
  findResult: (request: RoomRequest) => { messageId: string; ok: boolean } | null,
  hooks: CompletionHooks = {},
): RoomRequest[] {
  const rows = (db.prepare("SELECT * FROM room_requests WHERE state IN ('running','waiting_owner') AND verb='ask' ORDER BY created_at, id").all() as Record<string, unknown>[]).map(fromRow);
  const woke: RoomRequest[] = [];
  for (const row of rows) {
    const result = findResult(row);
    if (!result) continue;
    woke.push(...completeRequest(db, row.id, { state: result.ok ? "done" : "failed", now, resultMessageId: result.messageId }, hooks).wakes);
  }
  return woke;
}

/** The running asks a restart is about to end as `unknown` with nobody told: an ask from a direct chat to a teammate (no parent request, no return
 * thread, and no hand-off row to decide it). Nothing wakes the asker and no result is owed for it, so the chat it was made in is told once.
 * Read before `reconcileRoomRequestsAtBoot`, which is what ends them. */
export function parentlessAsksInterruptedByRestart(db: DatabaseSync): Array<{ id: string; toBotId: string; threadId: string }> {
  const partner = tableExists(db, "pending_delegations") ? " AND NOT EXISTS (SELECT 1 FROM pending_delegations p WHERE p.id=room_requests.id)" : "";
  const rows = db.prepare(`SELECT id, to_bot_id, root_thread_id FROM room_requests WHERE state IN ('running','waiting_owner') AND verb='ask' AND parent_id IS NULL AND return_thread_id IS NULL AND work_item_id IS NULL${partner} ORDER BY created_at, id`)
    .all() as Array<{ id: string; to_bot_id: string | null; root_thread_id: string }>;
  return rows.filter(row => row.to_bot_id).map(row => ({ id: row.id, toBotId: row.to_bot_id!, threadId: row.root_thread_id }));
}

/**
 * Boot (7.2 last bullet): before anything is admitted, every running request
 * (and one waiting on the owner) is `unknown`: the process that ran it is
 * gone, and nothing re-runs by itself. Interrupted cards wait for the owner
 * to choose Retry or Skip; they do not queue a lead wake.
 * Never-dispatched `queued` and `waiting_bot` requests are kept. A card
 * queued for a rate-limited start retry has dispatched_at and also parks.
 */
export function reconcileRoomRequestsAtBoot(db: DatabaseSync, now: number, hooks: CompletionHooks = {}): { unknown: number; wakes: RoomRequest[] } {
  return withTx(db, () => {
    // A request whose handoff row is still there is that row's partner: the row decides it (a start cut short before the provider took it is
    // run once more, server/delegations.ts reconcileStartedDelegations), so the sweep leaves it running.
    // BOOT-SETTLE-108 3: a held row (started, no start time) is a partner too: the hand-off's own settling ends its request, from the receipt it saved
    // when it has one, so a restart between that receipt and its settle never ends the request as interrupted first.
    const partner = tableExists(db, "pending_delegations") ? " AND NOT EXISTS (SELECT 1 FROM pending_delegations p WHERE p.id=room_requests.id)" : "";
    const rows = (db.prepare(`SELECT * FROM room_requests WHERE (state IN ('running','waiting_owner') OR (state='queued' AND work_item_id IS NOT NULL AND dispatched_at IS NOT NULL))${partner} ORDER BY created_at, id`).all() as Record<string, unknown>[]).map(fromRow);
    const wakes: RoomRequest[] = [];
    let unknown = 0;
    for (const row of rows) {
      const current = roomRequest(db, row.id);
      if (!current || isTerminalRoomRequestState(current.state)) continue;
      unknown += 1;
      wakes.push(...completeRequest(db, row.id, { state: "unknown", now, outcomeNote: RESTART_NOTE }, hooks).wakes);
    }
    const groups = new Map<string, Set<string>>();
    for (const row of rows) if (row.workItemId && (!hooks.cardGenerationCurrent || hooks.cardGenerationCurrent(db, row))) {
      const cards = groups.get(row.groupId) ?? new Set<string>();
      cards.add(row.workItemId); groups.set(row.groupId, cards);
    }
    for (const [groupId, cards] of groups) hooks.restartCards?.(groupId, [...cards]);
    return { unknown, wakes };
  });
}

/** Q3, the queued requests past their deadline, oldest first, at most `limit` (default 100) per call. `deadline_at` is fixed when the row is created,
 * so expiry never depends on the registry; the partial index `room_requests_queued_deadline` holds queued rows with a deadline only, so an
 * expired row leaves it. A backlog clears over successive ticks. */
export function overdueRoomRequests(db: DatabaseSync, now: number, limit = RETAINED_SWEEP_BATCH): RoomRequest[] {
  const ids = db.prepare("SELECT id FROM room_requests WHERE state='queued' AND deadline_at IS NOT NULL AND deadline_at<? ORDER BY deadline_at, id LIMIT ?")
    .all(now, Math.max(1, Math.trunc(limit))) as Array<{ id: string }>;
  return requestsByIds(db, ids.map(row => row.id));
}
/** Queued requests past their deadline (`room_turn` 2 hours, shared work 24 hours) expire, a bounded batch per call. `expire` closes one
 * (the default completes it as expired); shared work passes its own closer, which also tells the requester. */
export function expireOverdueRoomRequests(db: DatabaseSync, now: number, hooks: CompletionHooks = {}, expire?: (row: RoomRequest) => RoomRequest | null, limit = RETAINED_SWEEP_BATCH): RoomRequest[] {
  const closed: RoomRequest[] = [];
  for (const row of overdueRoomRequests(db, now, limit)) {
    const done = expire ? expire(row) : completeRequest(db, row.id, { state: "expired", now, outcomeNote: "not answered in time" }, hooks).request;
    if (done) closed.push(done);
  }
  return closed;
}

/** The (group, closeSeq) of every close still running: after the group's last
 * Reopen or End marker and short of step 3. Only these outlive retention. */
export const LIVE_PROJECT_CLOSES_SQL = `SELECT a.group_id AS group_id, json_extract(a.detail,'$.closeSeq') AS close_seq,
    MAX(json_extract(a.detail,'$.summaryRequestId')) AS summary_request_id
  FROM project_activity a
  WHERE a.kind='close' AND json_type(a.detail,'$.closeSeq')='integer'
    AND a.rowid > COALESCE((SELECT MAX(m.rowid) FROM project_activity m WHERE m.group_id=a.group_id
      AND (m.kind='reopen' OR (m.kind='settings' AND json_extract(m.detail,'$.project')=0))),0)
  GROUP BY a.group_id, json_extract(a.detail,'$.closeSeq')
  HAVING MAX(json_extract(a.detail,'$.step')) < 3`;

/** The statement that decides one hold: does this request have nothing left to keep. Exported so a test can read its plan. */
export function settledHoldSql(db: DatabaseSync): string {
  const exists = (name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  // Existence probes (NOT EXISTS on an indexed request id), never a list built from the owed set: cost per hold is flat in how much is owed.
  const owedRow = exists("room_request_owed") ? " AND NOT EXISTS (SELECT 1 FROM room_request_owed o WHERE o.kind IN ('shared_delivery','fanout') AND o.request_id=room_requests.id)" : "";
  const cardRow = exists("project_card_delivery_owed") ? " AND NOT EXISTS (SELECT 1 FROM project_card_delivery_owed c WHERE c.request_id=room_requests.id)" : "";
  const dismissal = exists("room_request_dismissal_receipts") ? " AND NOT EXISTS (SELECT 1 FROM room_request_dismissal_receipts d WHERE d.request_id=room_requests.id)" : "";
  return `SELECT 1 AS x FROM room_requests WHERE id=? AND state IN ${TERMINAL_SQL} AND NOT ${OWNER_WORDS_OWED_LITERAL_SQL}${owedRow}${cardRow}${dismissal}`;
}
/** A restore holds every open request ("room_request") and then expires it. The hold exists for the recovery that request still owes: the owner's words
 * not yet a chip, a finished card's result still owed to its room, a shared result still owed to its requester. When none of those is left (the request is
 * terminal and the chip exists, or its delivery is settled) the hold has nothing more to keep and is retired, so the request can be pruned like any other
 * and repeated restores do not leave expired requests behind. A hold whose request is gone is retired too. Cost follows the holds, which only restores create. */
export function retireSettledRoomRequestHolds(db: DatabaseSync): number {
  if (!db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name='restore_holds'").get()) return 0;
  // each hold is decided by primary-key probes, never by a pass over the request history
  const settled = db.prepare(settledHoldSql(db));
  const retire = db.prepare("DELETE FROM restore_holds WHERE kind='room_request' AND row_id=?");
  const gone = db.prepare("SELECT 1 AS x FROM room_requests WHERE id=?");
  let retired = 0;
  for (const { row_id: id } of db.prepare("SELECT row_id FROM restore_holds WHERE kind='room_request'").all() as Array<{ row_id: string }>) {
    if (!gone.get(id) || settled.get(id)) { retire.run(id); retired++; }
  }
  return retired;
}

/**
 * Pruning (SPEC-P section 2): terminal requests older than 30 days go,
 * except a row still referenced by an open request (`parent_id`) or by a
 * card that is not archived. An archived card's reference to a pruned row is
 * cleared in the same transaction.
 */
export function pruneTerminalRoomRequests(db: DatabaseSync, now: number): number {
  return withTx(db, () => {
    retireSettledRoomRequestHolds(db);
    const cutoff = now - ROOM_REQUEST_RETENTION_MS;
    const cards = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_work_items'").get());
    const activity = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_activity'").get());
    // every row of a root that still has open work keeps its durable counters
    const keep = `root_id IN (SELECT root_id FROM room_requests WHERE state IN ${OPEN_SQL})`
      + (cards ? " OR id IN (SELECT request_id FROM project_work_items WHERE archived_at IS NULL AND request_id IS NOT NULL)"
        + " OR id IN (SELECT review_request_id FROM project_work_items WHERE archived_at IS NULL AND review_request_id IS NOT NULL)" : "")
      + (activity ? ` OR id IN (SELECT summary_request_id FROM (${LIVE_PROJECT_CLOSES_SQL}) WHERE summary_request_id IS NOT NULL)` : "");
    // a result, request or card delivery a restore is holding waits for the owner's release, however old
    const holds = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='restore_holds'").get());
    const heldKeep = holds ? " OR id IN (SELECT row_id FROM restore_holds WHERE kind IN ('room_request','shared_result','card_delivery'))" : "";   // room_request holds were just retired where nothing is left to recover
    // a finished result still owed to its requester, or a send still to fan out, is delivery debt: it is never pruned, however old,
    // and neither is its owed row (a Resume that released a hold must not let the pruner erase the result before it is delivered)
    const debt = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='room_request_owed'").get());
    const dismissals = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='room_request_dismissal_receipts'").get());
    // a request whose handoff row is still in the queue (waiting, or started and not yet receipted) is that row's partner: never pruned from under it
    const handoffs = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='pending_delegations'").get());
    const debtKeep = (debt ? " OR id IN (SELECT request_id FROM room_request_owed)" : "") + (dismissals ? " OR id IN (SELECT request_id FROM room_request_dismissal_receipts)" : "")
      + (handoffs ? " OR id IN (SELECT id FROM pending_delegations)" : "");
    // an owner send whose words are not yet a chip or a transcript line is never pruned, however old
    const owed = OWNER_WORDS_OWED_LITERAL_SQL;
    const doomed = `SELECT id FROM room_requests WHERE state IN ${TERMINAL_SQL} AND finished_at < ? AND NOT (${keep}${heldKeep}${debtKeep}) AND NOT ${owed}`;
    if (cards) {
      db.prepare(`UPDATE project_work_items SET request_id=NULL WHERE archived_at IS NOT NULL AND request_id IN (${doomed})`).run(cutoff);
      db.prepare(`UPDATE project_work_items SET review_request_id=NULL WHERE archived_at IS NOT NULL AND review_request_id IN (${doomed})`).run(cutoff);
    }
    const result = db.prepare(`DELETE FROM room_requests WHERE id IN (${doomed})`).run(cutoff);
    // rows that belonged to those requests go with them, also on a connection where the cascade does not run
    sweepAddedOrphans(db);
    return Number(result.changes);
  });
}

/** A dispatched request whose turn could not start after all (the arbiter
 * refused it in the turn's own check, a race with another start): back to
 * `queued`, as if it had never been dispatched. */
export function requeueRoomRequest(db: DatabaseSync, id: string, refusal: string | null): boolean {
  const result = db.prepare("UPDATE room_requests SET state='queued', dispatched_at=NULL, refusal=? WHERE id=? AND state='running'").run(refusal, id);
  return Number(result.changes) === 1;
}

/** A hand-off's request whose turn did not start (a wait, a restart that cut the start short): back to `queued` from `running` or `waiting_owner`, the
 * refusal recorded, so the dispatch that follows finds both records agreeing. Never terminal: a request that finished is left alone. */
export function requeueRequest(db: DatabaseSync, id: string, refusal: string | null = null): boolean {
  const result = db.prepare("UPDATE room_requests SET state='queued', dispatched_at=NULL, waiting_since=NULL, refusal=? WHERE id=? AND state IN ('running','waiting_owner')").run(refusal, id);
  return Number(result.changes) === 1;
}

/** The same ask, to the same bot, with the same words, already made under this parent (a room turn): in ANY state. A repeated tool call is answered from this request's
 * own outcome (queued or running: the same task; finished: its receipt), never by starting the work again (SPEC-P 5.2 idempotency). */
export function findRoomAskDuplicate(db: DatabaseSync, parentId: string, toBotId: string, message: string): RoomRequest | null {
  const row = db.prepare("SELECT id FROM room_requests WHERE parent_id=? AND verb='ask' AND to_bot_id=? AND payload_text=? ORDER BY created_at LIMIT 1")
    .get(parentId, toBotId, message.slice(0, 100_000)) as { id: string } | undefined;
  return row ? roomRequest(db, row.id) : null;
}
