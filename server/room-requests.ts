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
}

export interface CompletionResult {
  request: RoomRequest;
  /** Wakes this completion queued (committed with it). */
  wakes: RoomRequest[];
  changed: boolean;
}

function withTx<T>(db: DatabaseSync, operation: () => T): T {
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
}

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
  };
}

export function isTerminalRoomRequestState(state: RoomRequestState): state is RoomRequestTerminalState {
  return (ROOM_REQUEST_TERMINAL_STATES as readonly string[]).includes(state);
}

export function roomRequest(db: DatabaseSync, id: string): RoomRequest | null {
  const row = db.prepare("SELECT * FROM room_requests WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? fromRow(row) : null;
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

/** The dispatch order (5.2): owner, then coordinator, then work; then
 * created_at; then id. */
export function queuedRoomRequests(db: DatabaseSync, filter: { groupId?: string } = {}): RoomRequest[] {
  const rows = db.prepare(`SELECT * FROM room_requests WHERE state='queued'${filter.groupId ? " AND group_id=?" : ""}
    ORDER BY CASE priority WHEN 'owner' THEN 0 WHEN 'coordinator' THEN 1 ELSE 2 END, created_at, id`)
    .all(...(filter.groupId ? [filter.groupId] : [])) as Record<string, unknown>[];
  return rows.map(fromRow);
}

/** queued -> running. False when the row is no longer queued (a second
 * dispatcher, a cancel that won): the caller must not start the turn. */
export function markRequestDispatched(
  db: DatabaseSync,
  id: string,
  input: { now: number; targetThreadId?: string },
): boolean {
  const result = db.prepare(`UPDATE room_requests SET state='running', dispatched_at=?, refusal=NULL,
      target_thread_id=COALESCE(?, target_thread_id) WHERE id=? AND state='queued'`)
    .run(input.now, input.targetThreadId ?? null, id);
  return Number(result.changes) === 1;
}

/** The arbiter's last refusal for a queued request (7.2 codes). */
export function recordRoomRequestRefusal(db: DatabaseSync, id: string, refusal: string | null): void {
  db.prepare("UPDATE room_requests SET refusal=? WHERE id=? AND state='queued'").run(refusal, id);
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
  const { request, created } = insertRoomRequest(db, {
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
  });
  return created ? request : null;
}

/**
 * The one completion primitive (SPEC-P 5.2). Idempotent: completing a
 * terminal request changes nothing and queues nothing.
 */
export function completeRequest(
  db: DatabaseSync,
  id: string,
  outcome: { state: RoomRequestTerminalState; now: number; resultMessageId?: string | null; outcomeNote?: string | null },
  hooks: CompletionHooks = {},
  options: { continuation?: boolean; suppressReturnWake?: boolean; stopped?: boolean } = {},
): CompletionResult {
  return withTx(db, () => {
    const current = roomRequest(db, id);
    if (!current) throw new Error(`no room request ${id}`);
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
        outcome_note=?, waiting_since=NULL, owner_wait_ms=owner_wait_ms+? WHERE id=?`)
      .run(outcome.state, outcome.now, outcome.resultMessageId ?? null, note === null ? null : note.slice(0, 200), ownerWait, id);
    const done = roomRequest(db, id)!;
    // A card's effect is applied once, by the card's own request: a
    // continuation wake finishes the waiting card request, which applies it.
    if (!fenced && done.workItemId && (done.verb !== "wake" || done.state === "unknown")) hooks.cardEffect?.(db, done);
    // a review's card effect may re-point its result to the current lead (lane review)
    if (done.verb === "review") Object.assign(done, roomRequest(db, id)!);
    if (ran) hooks.settleUsage?.(db, done);
    hooks.activity?.(db, done);
    // An interrupted card is an owner decision, including a card whose
    // continuation was interrupted. Retry or Skip must precede another wake.
    if (!fenced && done.state === "unknown" && done.workItemId && done.verb === "wake" && done.parentId && done.admissionKey === `wake:${done.parentId}`) {
      const parent = roomRequest(db, done.parentId);
      if (parent?.state === "waiting_bot") completeRequest(db, parent.id, { state: "unknown", now: outcome.now, outcomeNote: done.outcomeNote }, hooks, { continuation: false });
    }
    if (fenced || options.continuation === false || (done.state === "unknown" && done.workItemId !== null)) return { request: done, wakes: [], changed: true };
    return { request: done, wakes: continueFrom(db, done, outcome.now, hooks, options.suppressReturnWake, options.stopped), changed: true };
  });
}

function continueFrom(db: DatabaseSync, done: RoomRequest, now: number, hooks: CompletionHooks, suppressReturnWake = false, stopped = false): RoomRequest[] {
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
    return completeRequest(db, parent.id, { state, now, resultMessageId: done.resultMessageId, ...(done.state === "unknown" || suppressReturnWake ? { outcomeNote: done.outcomeNote } : {}) }, hooks, { suppressReturnWake, stopped }).wakes;
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

function wakeWaitingParent(db: DatabaseSync, parent: RoomRequest, now: number, hooks: CompletionHooks = {}): RoomRequest[] {
  // Nobody to hand the results to (a chain that is not the owner's, or no
  // bot or thread): the asker finishes here instead of waiting forever.
  if (parent.notOwnerAudience || !parent.toBotId || !parent.targetThreadId) {
    if (parent.state === "waiting_bot") return completeRequest(db, parent.id, { state: "done", now, outcomeNote: "answers posted, nobody woken" }, hooks, { continuation: false }).wakes;
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
  });
  return wake ? [wake] : [];
}

/**
 * A request's turn ended (the engine's terminal event, or a setup failure).
 * With open asks it waits for them; with asks that finished while it ran it
 * waits for the one wake that hands their results over; otherwise it
 * completes.
 */
export function finishRequestTurn(
  db: DatabaseSync,
  id: string,
  input: { ok: boolean; now: number; resultMessageId?: string | null; outcomeNote?: string | null },
  hooks: CompletionHooks = {},
): CompletionResult {
  return withTx(db, () => {
    const current = roomRequest(db, id);
    if (!current) throw new Error(`no room request ${id}`);
    if (isTerminalRoomRequestState(current.state) || current.state === "waiting_bot") {
      return { request: current, wakes: [], changed: false };
    }
    if (!input.ok) return completeRequest(db, id, { state: "failed", now: input.now, resultMessageId: input.resultMessageId, outcomeNote: input.outcomeNote }, hooks);
    const waitOnAsks = () => {
      const ownerWait = current.waitingSince !== null ? Math.max(0, input.now - current.waitingSince) : 0;
      // Waiting on teammates is not this request's work either: the wait is
      // timed from here and joins owner_wait_ms at completion (work time is
      // terminal - dispatched - owner_wait_ms, SPEC-P 3.8).
      db.prepare(`UPDATE room_requests SET state='waiting_bot', waiting_since=?, owner_wait_ms=owner_wait_ms+?,
          result_message_id=COALESCE(?, result_message_id) WHERE id=?`).run(input.now, ownerWait, input.resultMessageId ?? null, id);
    };
    if (openAskChildren(db, id).length > 0) {
      waitOnAsks();
      return { request: roomRequest(db, id)!, wakes: [], changed: true };
    }
    if (undeliveredAskResults(db, id).length > 0 && !current.notOwnerAudience) {
      waitOnAsks();
      const wakes = wakeWaitingParent(db, roomRequest(db, id)!, input.now);
      return { request: roomRequest(db, id)!, wakes, changed: true };
    }
    return completeRequest(db, id, { state: "done", now: input.now, resultMessageId: input.resultMessageId, outcomeNote: input.outcomeNote }, hooks);
  });
}

/**
 * Cancel a `queued` or `waiting_bot` request (the owner's Cancel, Stop all,
 * room deletion). A waiting asker's open asks are cancelled with it and
 * nobody is woken. Returns null when the request cannot be cancelled here
 * (running: interrupt the turn instead), plus the asks that were still
 * running so the caller can interrupt their turns.
 */
export function cancelRoomRequest(
  db: DatabaseSync,
  id: string,
  input: { now: number; note?: string },
  hooks: CompletionHooks = {},
): (RoomRequest & { runningChildren: RoomRequest[] }) | null {
  return withTx(db, () => {
    const current = roomRequest(db, id);
    if (!current || (current.state !== "queued" && current.state !== "waiting_bot")) return null;
    const children = current.state === "waiting_bot" ? openAskChildren(db, id) : [];
    const noWake = current.state === "waiting_bot";
    const done = completeRequest(db, id, { state: "cancelled", now: input.now, outcomeNote: input.note ?? "cancelled" }, hooks, { continuation: !noWake }).request;
    const runningChildren: RoomRequest[] = [];
    for (const child of children) {
      if (child.state === "running" || child.state === "waiting_owner") runningChildren.push(child);
      if (child.state === "waiting_bot") cancelRoomRequest(db, child.id, input, hooks);
      else completeRequest(db, child.id, { state: "cancelled", now: input.now, outcomeNote: "cancelled with the request that asked" }, hooks);
    }
    return { ...done, runningChildren };
  });
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
    const rows = (db.prepare("SELECT * FROM room_requests WHERE state IN ('running','waiting_owner') OR (state='queued' AND work_item_id IS NOT NULL AND dispatched_at IS NOT NULL) ORDER BY created_at, id").all() as Record<string, unknown>[]).map(fromRow);
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

/** Queued requests past their deadline (`room_turn` 2 hours) expire. */
export function expireOverdueRoomRequests(db: DatabaseSync, now: number, hooks: CompletionHooks = {}, include: (row: RoomRequest) => boolean = () => true): RoomRequest[] {
  const rows = (db.prepare("SELECT * FROM room_requests WHERE state='queued' AND deadline_at IS NOT NULL AND deadline_at < ? ORDER BY created_at, id").all(now) as Record<string, unknown>[]).map(fromRow);
  return rows.filter(include).map((row) => completeRequest(db, row.id, { state: "expired", now, outcomeNote: "not answered in time" }, hooks).request);
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

/**
 * Pruning (SPEC-P section 2): terminal requests older than 30 days go,
 * except a row still referenced by an open request (`parent_id`) or by a
 * card that is not archived. An archived card's reference to a pruned row is
 * cleared in the same transaction.
 */
export function pruneTerminalRoomRequests(db: DatabaseSync, now: number): number {
  return withTx(db, () => {
    const cutoff = now - ROOM_REQUEST_RETENTION_MS;
    const cards = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_work_items'").get());
    const activity = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_activity'").get());
    // every row of a root that still has open work keeps its durable counters
    const keep = `root_id IN (SELECT root_id FROM room_requests WHERE state IN ${OPEN_SQL})`
      + (cards ? " OR id IN (SELECT request_id FROM project_work_items WHERE archived_at IS NULL AND request_id IS NOT NULL)"
        + " OR id IN (SELECT review_request_id FROM project_work_items WHERE archived_at IS NULL AND review_request_id IS NOT NULL)" : "")
      + (activity ? ` OR id IN (SELECT summary_request_id FROM (${LIVE_PROJECT_CLOSES_SQL}) WHERE summary_request_id IS NOT NULL)` : "");
    const doomed = `SELECT id FROM room_requests WHERE state IN ${TERMINAL_SQL} AND finished_at < ? AND NOT (${keep})`;
    if (cards) {
      db.prepare(`UPDATE project_work_items SET request_id=NULL WHERE archived_at IS NOT NULL AND request_id IN (${doomed})`).run(cutoff);
      db.prepare(`UPDATE project_work_items SET review_request_id=NULL WHERE archived_at IS NOT NULL AND review_request_id IN (${doomed})`).run(cutoff);
    }
    const result = db.prepare(`DELETE FROM room_requests WHERE id IN (${doomed})`).run(cutoff);
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
