import { threadHumanPrincipal } from "./human-principals.ts";
import { handoffRequest, isTerminalRoomRequestState, type RoomRequest, completeRequest, requeueRequest } from "./room-requests.ts";
import { awaitWriterGate, database, isDatabaseBusy, transaction } from "./database.ts";
import { afterCommit } from "./tx-scope.ts";
import { registerLegacyDelegationParser, importLegacyDelegations, delegationTurnKey, holdForReconcile, ownerRecordMigrationPending } from "./pending-delegations-schema.ts";
import { _forgetInFlight, dispatchHandoff } from "./handoff-dispatch.ts";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { botDeleted, onOwnerDeletion, ownerDeletedThread } from "./owner-deletions.ts";
import { defaultThreadId, audienceTask, authorizeWork, issueWorkAudience, issueExecutionAudience, validExecutionAudience } from "./execution-audience.ts";
import { storedMessage } from "./message-db.ts";
import { endAllLivePairedRequests, endLiveRequestsOfThread } from "./handoff-pair.ts";
import type { ExecutionAudience } from "./work-admission.ts";
// Async peer handoff (delegate_bot).
//
// A bot that finishes one task can hand the NEXT task to a peer without
// blocking its own turn - the source bot's turn.completed fires after it
// settles, and the queued delegation runs then. The peer gets a fresh
// depth-1 turn (depth cap still blocks A→B→C chains, see index.ts).
//
// Visiblity rides on the same comms-visibility helpers ask_bot uses
// (channel mirror + 1:1 chips) so a delegated exchange looks like an
// exchanged one. The optional approval gate (A2) is checked at drain
// time, never at queue time, because the user might have just turned
// approvePeerComms on between queueing and draining.

import { DELEGATION_OUTCOMES } from "../shared/record-values.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MurageStatus, outboundWords, status, storedStatusShapeOk, type BotName, type FailureCode, type Outbound } from "./murage-status.ts";
import { ReleasedText, type EgressOrigin } from "./released-text.ts";
import { writeFileAtomic } from "./atomic.ts";
import { coordinationTraceSchema, MAX_HANDOFFS_PER_TURN, type CoordinationTrace } from "./coordination-budget.ts";
import { messagedRow, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import { ROUTINE_PERMISSION_MODES, type RoutinePeerSource } from "./routine-permissions.ts";

import type { BotRecord, Store } from "./store.ts";
import { owedReplyOf, type OwedReply } from "./handoff-reply.ts";
import { murageLine } from "./murage-line.ts";

/** Every row a handoff leaves in its source conversation names who handed
 * off when that conversation is a room. Several bots delegate in a room, and
 * a failure row without `from` rendered unattributed, so nobody could tell
 * whose handoff failed (0.1.60 low). A bot's own thread is the sender's, so
 * its rows stay as they were. */
export function appendDelegationRow(
  bus: CommsBus,
  threadId: string,
  senderId: string | undefined,
  message: Parameters<CommsBus["store"]["appendMessage"]>[1],
): ReturnType<CommsBus["store"]["appendMessage"]> {
  const sender = senderId && bus.store.groupByThread(threadId) ? bus.store.bot(senderId) : undefined;
  // every row a delegation writes here is Murage's own chip about the hand-off, never a turn's engine output (murage-line.ts)
  const row = murageLine(message);
  return bus.store.appendMessage(threadId, sender ? { ...row, from: { botId: sender.id, name: sender.name, color: sender.color } } : row);
}

export interface DelegationItem {
  executionAudience?: ExecutionAudience;
  toBotId: string;
  message: string;
  reason?: string;
  /** The user already approved this exact peer message while it was still
   * an ask_bot request. If that peer became busy before dispatch, the
   * fallback handoff must not ask them to approve the same action twice. */
  approvalAlreadyGranted?: boolean;
  /** Queued from a Full access turn the owner started, so the contact card
   * is skipped at drain time - if the sender's conversation is still on
   * Full access then. Never set for a webhook, channel or routine turn. */
  fullAccessWaived?: boolean;
  /** Queued by a turn that was not owner audience (owner-audience.ts): the
   *  peer's turn is not either, after a restart too. */
  notOwnerAudience?: boolean;
  /** Queued by an unattended turn (no one proved the owner was there): the
   *  peer's turn runs unattended too, after a restart too, so Full access
   *  keeps the owner's cards for it. */
  unattended?: boolean;
  /** The provider turn that queued this hand-off, read from the server's own turn state when it is queued (never from the item a caller passes). The
   * hand-off can start after that turn ended, and the room copy of the message names this turn so revoking its inputs withholds the copy. `null`
   * when no turn was running (the message rests on none). A queue row from before it was kept has the field absent: its room copy is withheld. */
  senderTurnId?: string | null;
  /** The sender's "Messaged @target" row, written into the source conversation in the queue transaction as the sending turn's engine row
   * (LINEAGE-DESIGN-S6 rule 6): the room copy names it by copyOf. Absent on a queue row from before it was kept: its room copy is withheld. */
  sourceMessageId?: string;
  /** The effective parent routine ceiling, captured before its turn ends. */
  routineAuthority?: RoutinePeerSource;
  /** Trusted originating event identity. Survives handoff/retry/restart so
   * the harness can retain the event's budget and provenance boundary. */
  eventId?: string;
  /** Source depth; the child runs at depth+1. Tools stay available while
   * the server enforces depth, lineage and root allowances at admission. */
  depth: number;
  /** Durable server-issued ancestry, never model-supplied. */
  coordination?: CoordinationTrace;
}

export interface PendingDelegationItem extends DelegationItem {
  /** Stable acknowledgement key for a removal from the queue that survives a crash,
   * and the task id the delegating bot uses with check/wait_delegation. */
  id: string;
  /** Who queued this handoff. A 1:1 source thread identifies its owner, so
   * the drain used to recover the sender with botByThread alone - which is
   * null for a ROOM thread, and the whole queue was then deleted with no
   * receipt and no turn. Persisted so that survives a restart too. */
  fromBotId?: string;
  /** Busy-target retries so far. The item stays queued (not canceled) while
   * the target is busy, and is retried when any of the target's turns
   * settles - up to MAX_BUSY_ATTEMPTS. */
  attempts: number;
  /** True after this item observed the target's current busy period. Other
   * queue activity must not count that same period again; the target's idle
   * transition clears this marker before the next retry. */
  waitingOnBusy?: boolean;
  /** When this item last parked. The fallback timer retries a parked item
   * that no idle transition has woken for BUSY_RETRY_FALLBACK_MS. */
  waitingSince?: number;
  /** The newest "waiting" line on the source thread, which carries the Stop
   * control while the item waits. Cleared once the item leaves the queue. */
  waitMessageId?: string;
  /** Parked because its target is not in the registry and no recorded deletion
   * says it is gone (a registry not loaded yet, a pre-release deleted bot).
   * It is kept, never settled, but it is INACTIVE: it does not count as running
   * work for backups, engine changes or Stop, the owner can stop it, and a timer
   * retries it at `unknownRetryAt` with a growing wait. */
  unknownTarget?: boolean;
  unknownRetryAt?: number;
  unknownAttempts?: number;
  /** In memory only: the wait is over and the next drain must look again (the item stays parked and stoppable until it does). */
  unknownRecheck?: boolean;
  /** Read from the row's column, never stored in the payload: who owns the request side of this handoff (pending-delegations-schema.ts). */
  origin?: DelegationOrigin;
  /** Why a held hand-off is held, when it is not a restart that cut it off after the provider may have taken it. In both cases it was never sent:
   * `busy` the teammate stayed busy through every retry; `didNotStart` its start was cut short before the provider, again and again. The category is kept as it
   * happened. Kept in the payload (the held row is not read as a queued one again). */
  heldReason?: HeldReason;
}
export type DelegationOrigin = "owner" | "room" | "shared" | "legacy";
/** Why a hand-off that was never sent is held for the owner. */
export type HeldReason = "busy" | "didNotStart";

/** Wait before the next look for an unknown target: 1 minute, doubling, at most 1 hour. */
export const UNKNOWN_TARGET_BACKOFF_MIN_MS = 60_000;
export const UNKNOWN_TARGET_BACKOFF_MAX_MS = 3_600_000;
export function unknownTargetBackoffMs(attempts: number): number {
  return Math.min(UNKNOWN_TARGET_BACKOFF_MAX_MS, UNKNOWN_TARGET_BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(attempts, 20)));
}

/** Declared in shared/record-values.ts, which the backup reads too. */
export type DelegationOutcome = typeof DELEGATION_OUTCOMES[number];

/** The durable terminal record of one handoff: what the delegating bot reads
 * back with check_delegation / wait_delegation. Bounded and pruned - this is
 * a receipt drawer, not a transcript. */
export interface DelegationReceipt {
  id: string;
  sourceThreadId: string;
  toBotId: string;
  toBotName: string;
  status: DelegationOutcome;
  /** the peer's reply on success; the failure name otherwise (bounded) */
  result?: string;
  /** When the result is one of Murage's own status lines: its key and the plain values it was made from, so a replay writes the same line. */
  resultStatus?: { key: string; data?: Record<string, string | number> };
  /** Where the reply came from, so reading it back follows the original:
   * withheld when it is (server/memory/replay-lineage.ts). */
  copyOf?: { threadId: string; messageIds: string[] };
  /** The room request this receipt answers; every replay of its text re-asks the delivery authorization for it. */
  requestId?: string;
  /** The delegated turn itself read memory as a non-owner audience. */
  notOwnerAudience?: true;
  /** Written by a build whose results carry their origin (copyOf when there
   * is text). Without it the result cannot be checked and is withheld. */
  lineage?: boolean;
  /** The line the source conversation is owed by a finished hand-off (handoff-reply.ts), kept only until the final commit lands (finishHandoff): a receipt
   * that reached disk without that commit (the process died in between) still carries it, and the settle that recovers the hand-off writes it then. */
  reply?: OwedReply;
  /** The reply is HELD (REPLY-WITHHELD-CONTRACT C3, R3): the gate read it as checking, so the source conversation keeps the words flagged "checking"
   * under `messageId` (the owner reads them, bots read the checking line) until the hold settles (server/held-replies.ts). `since`: when the hold
   * began; `judgedAt`: the last time it was judged again. A held receipt is never replaced by a later outcome and never pruned while held. */
  held?: { messageId: string; since: number; judgedAt?: number };
  finishedAt: number;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many" | "source_deleted";

/** What queueDelegation hands back: the verdict, and on success the task id
 * the delegating bot can later read back with check/wait_delegation. */
export interface QueuedDelegation {
  result: QueueResult;
  id?: string;
}

/** The queue of handoffs not yet run is the `pending_delegations` table (server/pending-delegations-schema.ts), one row per handoff:
 * a change writes that one row and a pass reads the rows that are due by index, so the cost of a pass follows the work it does and never the size
 * of the backlog. It is read at boot, so a handoff queued right before a restart runs after it. (Provider PERMISSIONS still die with the process;
 * queued work is not a permission, and the target and approvePeerComms are re-checked at drain time as always.) Only the threads being drained
 * and the redrain requests live in memory. */
const drainingThreads = new Set<string>();

type Phase = "fresh" | "busy" | "parked";
interface StoredRow { id: string; source_thread_id: string; to_bot_id: string; from_bot_id: string | null; phase: Phase; retry_at: number | null; item: string; origin: DelegationOrigin }
const COLUMNS = "id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin";
/** How many due items one retry pass looks at. The rest stay due and are taken by the next pass. */
export const DUE_PARKED_BATCH = 100;
/** Busy items, per target bot, whose "can it start now" question one pass asks. */
const BUSY_START_BATCH = 100;
/** A due item whose thread is draining is looked at again after this. */
const POSTPONE_MS = 30_000;
/** How many handoffs one page of the boot and capacity drains takes. */
export const DRAIN_PAGE = 100;
/** The retry pass gives up its write lock wait after this: the next sweep tries again. */
const SWEEP_BUSY_MS = 50;

/** The production statements, exported so the scaling tests can plan and count them. */
export const PENDING_SQL = Object.freeze({
  due: `SELECT ${COLUMNS} FROM pending_delegations WHERE retry_at IS NOT NULL AND retry_at<=? AND retry_at<=CASE phase WHEN 'busy' THEN ? ELSE ? END ORDER BY retry_at, id LIMIT ${DUE_PARKED_BATCH}`,
  byThread: `SELECT ${COLUMNS} FROM pending_delegations WHERE source_thread_id=? AND phase<>'started' ORDER BY rowid`,
  startedPage: `SELECT id, source_thread_id, to_bot_id, from_bot_id, origin, target_thread_id, turn_key, accepted_turn_id, start_attempts, submitted_at FROM pending_delegations WHERE started_at>=0 ORDER BY started_at LIMIT ${DRAIN_PAGE}`,
  nextBusyBot: "SELECT to_bot_id FROM pending_delegations INDEXED BY pd_busy WHERE phase='busy' AND to_bot_id>? ORDER BY to_bot_id LIMIT 1",
  busyOfBot: `SELECT id, source_thread_id FROM pending_delegations INDEXED BY pd_busy WHERE phase='busy' AND to_bot_id=? AND source_thread_id>? ORDER BY source_thread_id LIMIT ${BUSY_START_BATCH}`,
  forgetThread: "DELETE FROM pending_delegations WHERE source_thread_id=?",
  /** A source conversation's own (not shared) waiting hand-offs, a page after a queue position: what its drain walks. */
  ownOfThread: `SELECT rowid AS pos, ${COLUMNS} FROM pending_delegations INDEXED BY pd_thread_own WHERE source_thread_id=? AND phase<>'started' AND origin<>'shared' AND rowid>? ORDER BY rowid LIMIT ?`,
  /** A source conversation's waiting SHARED hand-offs, one page after a queue position (the shared round owns them; its drain looks at one page per turn). */
  sharedOfThread: `SELECT rowid AS pos, ${COLUMNS} FROM pending_delegations INDEXED BY pd_thread_shared WHERE source_thread_id=? AND phase<>'started' AND origin='shared' AND rowid>? ORDER BY rowid LIMIT ?`,
  /** The boot settling's page of started hand-offs after a cursor (started_at, rowid): a row that cannot be settled is passed over, never read again this start. */
  startedAfter: `SELECT rowid AS pos, started_at, id FROM pending_delegations WHERE started_at>=0 AND (started_at, rowid)>(?, ?) ORDER BY started_at, rowid LIMIT ${DRAIN_PAGE}`,
});

interface Statements {
  byId: StatementSync; byThread: StatementSync; byThreadPage: StatementSync; byThreadTail: StatementSync; sharedOfThread: StatementSync; removeStarted: StatementSync; removeHeld: StatementSync; heldPage: StatementSync; startedPage: StatementSync; countThread: StatementSync; insert: StatementSync; update: StatementSync; remove: StatementSync;
  removeThread: StatementSync; due: StatementSync; postpone: StatementSync; release: StatementSync;
  nextBusyBot: StatementSync; busyOfBot: StatementSync; waitingSame: StatementSync; waitingAfter: StatementSync; releaseOfBot: StatementSync;
}
const prepared = new WeakMap<DatabaseSync, Statements>();
function stmts(): Statements {
  const db = database();
  let s = prepared.get(db);
  if (!s) {
    s = {
      byId: db.prepare(`SELECT ${COLUMNS} FROM pending_delegations WHERE id=? AND phase<>'started'`),
      byThread: db.prepare(PENDING_SQL.byThread),
      byThreadPage: db.prepare(PENDING_SQL.ownOfThread),
      byThreadTail: db.prepare("SELECT id FROM pending_delegations INDEXED BY pd_thread_own WHERE source_thread_id=? AND phase<>'started' AND origin<>'shared' AND rowid>? ORDER BY rowid LIMIT ?"),
      sharedOfThread: db.prepare(PENDING_SQL.sharedOfThread),
      countThread: db.prepare("SELECT COUNT(*) AS n FROM pending_delegations WHERE source_thread_id=? AND phase<>'started'"),
      insert: db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?)"),
      update: db.prepare("UPDATE pending_delegations SET phase=?, retry_at=?, item=? WHERE id=? AND phase<>'started'"),
      remove: db.prepare("DELETE FROM pending_delegations WHERE id=?"),
      removeStarted: db.prepare("DELETE FROM pending_delegations WHERE id=? AND phase='started' AND started_at IS NOT NULL"),
      removeHeld: db.prepare("DELETE FROM pending_delegations WHERE id=? AND phase='started' AND started_at IS NULL"),
      heldPage: db.prepare("SELECT id, source_thread_id, to_bot_id, from_bot_id, submitted_at, item FROM pending_delegations INDEXED BY pd_held WHERE phase='started' AND started_at IS NULL AND id>? ORDER BY id LIMIT 100"),
      startedPage: db.prepare(PENDING_SQL.startedPage),
      removeThread: db.prepare(PENDING_SQL.forgetThread),
      due: db.prepare(PENDING_SQL.due),
      postpone: db.prepare("UPDATE pending_delegations SET retry_at=? WHERE id=?"),
      release: db.prepare("UPDATE pending_delegations SET phase='fresh', retry_at=NULL WHERE id=?"),
      nextBusyBot: db.prepare(PENDING_SQL.nextBusyBot),
      busyOfBot: db.prepare(PENDING_SQL.busyOfBot),
      waitingSame: db.prepare(WAITING_PAGE_SQL.same),
      waitingAfter: db.prepare(WAITING_PAGE_SQL.after),
      releaseOfBot: db.prepare("UPDATE pending_delegations SET phase='fresh', retry_at=NULL WHERE source_thread_id=? AND to_bot_id=? AND phase='busy'"),
    };
    prepared.set(db, s);
  }
  return s;
}

/** Items and threads the last retry pass looked at (due rows plus busy rows asked about). */
let lookedAt = 0;
export function _delegationPassLooked(): number { return lookedAt; }
/** Test helper: how many threads are being drained right now (no query). */
export function _drainingCount(): number { return drainingThreads.size; }
/** Test and diagnostics counter: how many statements wrote a queue row. */
let persistWrites = 0;
export function _delegationQueueWrites(): number { return persistWrites; }

const placement = (item: PendingDelegationItem): { phase: Phase; retryAt: number | null } =>
  item.unknownTarget ? { phase: "parked", retryAt: item.unknownRetryAt ?? 0 }
  : item.waitingOnBusy ? { phase: "busy", retryAt: (item.waitingSince ?? Date.now()) + BUSY_RETRY_FALLBACK_MS }
  : { phase: "fresh", retryAt: null };
/** The stored payload: everything the columns do not carry. */
function itemJson(item: PendingDelegationItem): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, toBotId, fromBotId, waitingOnBusy, waitingSince, unknownTarget, unknownRetryAt, unknownRecheck, origin, ...rest } = item;
  return JSON.stringify(rest);
}
function itemOf(row: StoredRow): PendingDelegationItem | null {
  let raw: unknown;
  try { raw = JSON.parse(row.item); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = parsePendingItem({
    ...raw as object, id: row.id, toBotId: row.to_bot_id, ...(row.from_bot_id ? { fromBotId: row.from_bot_id } : {}),
    ...(row.phase === "busy" ? { waitingOnBusy: true, waitingSince: (row.retry_at ?? Date.now()) - BUSY_RETRY_FALLBACK_MS } : {}),
    ...(row.phase === "parked" ? { unknownTarget: true, unknownRetryAt: row.retry_at ?? 0 } : {}),
  });
  if (item && recheckIds.has(row.id)) item.unknownRecheck = true;
  if (item) item.origin = row.origin;
  return item;
}
/** The parked items whose wait is over and whose next drain must look again (in memory only: a restart forgets it, and the boot sweep marks them again). */
const recheckIds = new Set<string>();
/** A row that no longer validates is removed with an error receipt, never run and never kept forever. */
function readable(row: StoredRow): PendingDelegationItem | null {
  const item = itemOf(row);
  if (item) return item;
  try { transaction(() => { deliverOwedBeforeRemoval(row.id); stmts().remove.run(row.id); }, { op: "delegation-remove-unreadable" }); persistWrites++; } catch (error) { console.error("delegations: could not remove an unreadable queue row", error); }
  recordDelegationReceipt({ id: row.id, sourceThreadId: row.source_thread_id, toBotId: row.to_bot_id, toBotName: row.to_bot_id, status: "error", result: status("receipt_unreadable") });
  return null;
}
function queuedItem(id: string): { threadId: string; item: PendingDelegationItem } | null {
  const row = stmts().byId.get(id) as StoredRow | undefined;
  const item = row ? readable(row) : null;
  return row && item ? { threadId: row.source_thread_id, item } : null;
}
function queuedItems(threadId: string): PendingDelegationItem[] {
  const out: PendingDelegationItem[] = [];
  for (const row of stmts().byThread.all(threadId) as unknown as StoredRow[]) { const item = readable(row); if (item) out.push(item); }
  return out;
}
/** One-row write of an item's current state. A failure is logged: the queue row keeps its last good state. */
function saveItem(item: PendingDelegationItem): void {
  const { phase, retryAt } = placement(item);
  if (item.unknownRecheck) recheckIds.add(item.id); else recheckIds.delete(item.id);
  try { persistWrites++; stmts().update.run(phase, retryAt, itemJson(item), item.id); }
  catch (error) { console.error("delegations: could not persist queue", error); }
}
/** Deletes one queue row. True only when the DELETE committed; a failure is logged and reported to the caller, which must not
 * tell anyone the handoff is cancelled or finished (the row would still be runnable). */
function removeItem(id: string): boolean {
  try { persistWrites++; settleHandoffPair(id, { state: "cancelled", note: "the handoff was removed" }); } catch (error) { console.error("delegations: could not persist queue", error); return false; }
  recheckIds.delete(id);
  return true;
}
/** Ends the request a hand-off stands for and removes the hand-off's row in ONE transaction: the row is never deleted while its request is still live, and the
 * request is never left live behind a deleted row (the hand-off's partner is not a thing that can be lost on its own). A request that already ended keeps its
 * own outcome. The database refuses the other order too (pending_delegation_live_pair, pending-delegations-schema.ts). */
export function settleHandoffPair(id: string, outcome: { state: "cancelled" | "failed" | "expired"; note: string }): void {
  transaction((db) => {
    deliverOwedBeforeRemoval(id);
    const request = handoffRequest(db, id);
    if (request && !isTerminalRoomRequestState(request.state)) completeRequest(db, id, { state: outcome.state, now: Date.now(), outcomeNote: outcome.note });
    stmts().remove.run(id);
  }, { op: "delegation-settle-pair" });
}
/** Every removal of a hand-off's row calls this first, inside the removal's transaction: if the hand-off's receipt still owes its source conversation a line,
 * the line is written now (stable id: exactly once), so the row never goes before its line. With no writer it throws, and the removal does not happen. */
function deliverOwedBeforeRemoval(id: string): void {
  const receipt = receipts.find((kept) => kept.id === id && owes(kept));
  if (!receipt) return;
  if (!owedReplyWriter) throw new Error("the line this hand-off owes has no writer yet");
  if (owedReplyWriter(receipt) !== FINALIZER_WRITES) afterCommit(() => replyDelivered(id));
}
const queuedCount = (threadId: string): number => Number((stmts().countThread.get(threadId) as { n: number }).n);

/** Threads whose drain was requested WHILE a drain was already running.
 * Dropping such a request loses real work: the waiting-on retry fires the
 * moment a busy target settles, and that can land mid-drain. */
const queuedRedrains = new Set<string>();
const RECEIPTS_FILE = join(DATA_DIR, "delegation-receipts.json");
const MAX_RECEIPTS = 100;
const RECEIPT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const RESULT_MAX_CHARS = 4_000;
export const MAX_BUSY_ATTEMPTS = 3;
/** How long a parked handoff waits for its wake-up before the fallback timer
 * retries it anyway. The wake-up is the target going idle, and some of those
 * transitions happen while the target still cannot take the handoff (a room
 * that holds its members until its whole turn ends); nothing fires after
 * that, so without this the handoff waited until a restart (0.1.60 L4-1).
 * A retry the timer finds still busy spends an attempt, so a teammate who
 * stays busy ends in the usual "canceled" line rather than an endless wait. */
export const BUSY_RETRY_FALLBACK_MS = 5 * 60_000;

const validEventId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

let receipts: DelegationReceipt[] = [];

function saveReceipts(): boolean {
  try {
    writeFileAtomic(RECEIPTS_FILE, JSON.stringify(receipts, null, 2), { mode: 0o600 });
    return true;
  } catch (error) {
    console.error("delegations: could not persist receipts", error);
    return false;
  }
}

/** One listener told of every terminal outcome after it is recorded: the
 * turn engine completes the handoff's `ask` request with it (lane E1), so a
 * handoff the ledger ends without a turn (cancelled, refused, target gone)
 * still reaches the bot waiting on it. */
/** The listener runs INSIDE the transaction that removes the started row (settleReceipted): the writes it makes commit or roll back with the row's removal. What it
 * returns, if anything, runs after that commit (wakes, notices): never inside it. */
let receiptListener: ((receipt: DelegationReceipt, delivered: { id: string } | null) => (() => void) | void) | undefined;
export function onDelegationReceipt(listener: ((receipt: DelegationReceipt, delivered: { id: string } | null) => (() => void) | void) | undefined): void {
  receiptListener = listener;
}

/** What delivering a receipt's owed line came to: the line (written now, or found already written under its stable id), null when there is nowhere to write it
 * (the source conversation is gone), or FINALIZER_WRITES when the finalizer running in this same transaction writes it itself. */
export const FINALIZER_WRITES = "finalizer";
export type OwedReplyDelivery = { id: string } | null | typeof FINALIZER_WRITES;
/** Writes a receipt's owed line into its source conversation (the server: handoff-reply.ts replayOwedReply under the hand-off's stable id, so exactly once). It runs
 * INSIDE the settle's transaction, before the row's removal, for EVERY hand-off whatever its origin (an owner conversation's direct hand-off has no room request). */
let owedReplyWriter: ((receipt: DelegationReceipt) => OwedReplyDelivery) | undefined;
export function onOwedHandoffReply(writer: ((receipt: DelegationReceipt) => OwedReplyDelivery) | undefined): void {
  owedReplyWriter = writer;
}
/** A receipt that still owes its source conversation a line. It never expires and is never pruned: only its delivery (replyDelivered) ends the obligation. */
const owes = (receipt: DelegationReceipt): boolean => receipt.reply !== undefined;
/** How long a reply may stay held before its hold is settled finally as checking (REPLY-WITHHELD-CONTRACT C4, R3): the row keeps its flag, no
 * words reach a bot, the request completes with the checking line, and the owner's note says the check did not finish. */
export const HELD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A receipt whose reply is still held: kept until its hold settles, whatever its age or the count. */
const holds = (receipt: DelegationReceipt): boolean => receipt.held !== undefined;
/** The owed line is in the source conversation (its commit landed): the receipt no longer owes it, on disk as well, and may now age out like any other. */
/** A direct hand-off's owed reply is kept past its final commit until its asker's wake is on disk (finishHandoff `keepOwed`), so a crash in between
 * is delivered again by the boot (deliverOwedReplies), whose wake AskerWakes dedupes (NOHOLD-DELEGATION.md, the asker's one wake). */
export function releaseOwedReply(id: string): void { replyDelivered(id); }
function replyDelivered(id: string): void {
  const kept = receipts.find((receipt) => receipt.id === id);
  if (!kept || !owes(kept)) return;
  delete kept.reply;
  saveReceipts();
}
/** Age and count pruning of the receipt drawer: a receipt that still owes a line, or whose reply is still held, is kept whatever its age, and does not
 * count against the bound (a held one is settled finally by the hold sweep after HELD_MAX_AGE_MS, server/held-replies.ts). */
function pruneReceipts(list: DelegationReceipt[], now: number): DelegationReceipt[] {
  const owed = list.filter((receipt) => owes(receipt) || holds(receipt));
  const rest = list.filter((receipt) => !owes(receipt) && !holds(receipt) && now - receipt.finishedAt <= RECEIPT_MAX_AGE_MS).slice(0, MAX_RECEIPTS);
  const keep = new Set([...owed, ...rest]);
  return list.filter((receipt) => keep.has(receipt));
}

function markHandoffRequest(id: string): void {
  try { database().prepare("UPDATE room_requests SET handoff=1 WHERE id=? AND handoff IS NOT 1").run(id); }
  catch { /* no request table or no mark column yet (an older database): the receipt itself still names the hand-off */ }
}
/** Record one terminal outcome. Newest first; pruned by count and age so the
 * drawer can never grow without bound. Returns whether the receipt reached disk. */
export function recordDelegationReceipt(receipt: Omit<DelegationReceipt, "finishedAt" | "result" | "resultStatus"> & { result?: Outbound; finishedAt?: number }): boolean {
  const now = Date.now();
  // A held receipt is never replaced by a later outcome that is not itself a hold (a restart's "interrupted", a stop): the hand-off finished and its reply
  // is held for the owner; only the hold settle (settleHeldReceipt) changes it (REPLY-WITHHELD-CONTRACT S17). Looked at first: nothing of the later
  // outcome is read.
  if (!validHold(receipt.held) && receipts.some((existing) => existing.id === receipt.id && holds(existing))) return true;
  const bounded: DelegationReceipt = {
    id: receipt.id,
    sourceThreadId: receipt.sourceThreadId,
    toBotId: receipt.toBotId,
    toBotName: receipt.toBotName,
    status: receipt.status,
    finishedAt: receipt.finishedAt ?? now,
  };
  if (receipt.result !== undefined) {
    bounded.result = outboundWords(receipt.result).slice(0, RESULT_MAX_CHARS);
    if (MurageStatus.is(receipt.result) && !ReleasedText.is(receipt.result)) bounded.resultStatus = { key: receipt.result.key, ...(receipt.result.data ? { data: { ...receipt.result.data } } : {}) };
  }
  // one past the check's width budget, so a longer link reads as unestablished
  if (receipt.copyOf) bounded.copyOf = { threadId: receipt.copyOf.threadId, messageIds: receipt.copyOf.messageIds.slice(0, 65) };
  if (typeof receipt.requestId === "string" && receipt.requestId) bounded.requestId = receipt.requestId;
  if (receipt.notOwnerAudience === true) bounded.notOwnerAudience = true;
  if (receipt.lineage === true) bounded.lineage = true;
  if (validOwedReply(receipt.reply)) bounded.reply = receipt.reply;
  const held = validHold(receipt.held);
  if (held) bounded.held = held;
  // A receipt that still owes its source conversation a line is never replaced by a later outcome for the same hand-off (a restart's "interrupted"): the
  // hand-off finished, and its line is delivered first. The kept receipt is settled instead.
  const owing = receipts.find((existing) => existing.id === bounded.id && owes(existing));
  if (owing && !owes(bounded) && !holds(bounded)) { settleReceipted(owing); return true; }
  receipts = pruneReceipts([bounded, ...receipts.filter((existing) => existing.id !== bounded.id)], now);
  const persisted = saveReceipts();
  // a request with a hand-off receipt is a hand-off's: its row says so for its whole life (room_requests.handoff, the identity the hand-back prefilter reads)
  markHandoffRequest(bounded.id);
  // The receipt is the end of a started handoff. Its request's terminal state, the removal of its row and nothing else are ONE transaction (settleReceipted): either the
  // hand-off is over in every record, or none of them changed and the receipt (which is kept) tells the next pass to settle it again.
  settleReceipted(bounded);
  /** False when the receipt is only in memory (the file write failed): a caller that owes the receipt keeps its obligation and writes it again. */
  return persisted;
}

/** The end of a finished hand-off's turn, all or nothing: the receipt (written to disk first, kept whatever happens), the removal of its row (settleReceipted,
 * nested) and `work` (the result in the source conversation, the request's terminal write) commit in ONE transaction. If the row's removal did not commit, or
 * `work` throws, nothing in the database changed: the row and the request are as they were, and the next pass that finds the row (the dispatch, the boot sweep)
 * settles both through the kept receipt. The caller runs its follow-ups after this returns. */
export function finishHandoff<T>(receipt: Parameters<typeof recordDelegationReceipt>[0] | undefined, work: () => T, options: { keepOwed?: boolean } = {}): T {
  try {
    const done = transaction(() => {
      if (receipt) {
        recordDelegationReceipt(receipt);
        if (handoffRow(receipt.id)) throw coded(HANDOFF_NOT_SETTLED, "the handoff's row could not be settled with its receipt; the next pass settles it");
      }
      return work();
    }, { op: "delegation-finalize" });
    // the final commit landed (the line is written): the receipt no longer owes it, and the next write of the receipts file leaves it out
    // (after the OUTERMOST commit: inside a caller's transaction that later rolls back, the line is still owed)
    if (receipt && !options.keepOwed) afterCommit(() => replyDelivered(receipt.id));
    return done;
  } catch (error) {
    // nothing committed: the row and the request are as they were and the receipt is kept. This process settles it again (resettleStranded, on the parked-
    // delegation sweep), so the request does not stay running (holding its team's slot) until the next start.
    if (receipt && handoffRow(receipt.id)) stranded.add(receipt.id);
    throw error;
  }
}
function validOwedReply(value: unknown): value is OwedReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owed = value as Record<string, unknown>;
  if (typeof owed.text === "string") {
    if (Object.keys(owed).length === 1) return true;
    // a held reply (REPLY-WITHHELD-CONTRACT R3): the words and the originals they rest on, written flagged "checking"
    const hold = owed.held as { copyOf?: unknown } | undefined;
    return Object.keys(owed).length === 2 && Boolean(hold) && typeof hold === "object" && validOrigin(hold!.copyOf);
  }
  return typeof owed.line === "string" && typeof owed.ok === "boolean" && Object.keys(owed).length === 2;
}
function validOrigin(value: unknown): value is { threadId: string; messageIds: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origin = value as { threadId?: unknown; messageIds?: unknown };
  return typeof origin.threadId === "string" && Array.isArray(origin.messageIds) && origin.messageIds.length > 0 && origin.messageIds.every((id) => typeof id === "string");
}
function validHold(value: unknown): DelegationReceipt["held"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const hold = value as { messageId?: unknown; since?: unknown; judgedAt?: unknown };
  if (typeof hold.messageId !== "string" || !hold.messageId || typeof hold.since !== "number" || !Number.isFinite(hold.since)) return undefined;
  return { messageId: hold.messageId, since: hold.since, ...(typeof hold.judgedAt === "number" && Number.isFinite(hold.judgedAt) ? { judgedAt: hold.judgedAt } : {}) };
}

/** The receipts whose reply is still held (REPLY-WITHHELD-CONTRACT C4, R11): never judged first (oldest hold first), then least recently judged, so
 * a hold that stays checking never takes a pass ahead of a newer one. */
export function heldReceipts(): DelegationReceipt[] {
  return receipts.filter(holds).sort((a, b) => {
    const aj = a.held!.judgedAt, bj = b.held!.judgedAt;
    if (aj === undefined || bj === undefined) return aj === undefined && bj === undefined ? a.held!.since - b.held!.since : aj === undefined ? -1 : 1;
    return aj - bj;
  });
}

/** One hold's end on its receipt (server/held-replies.ts retires an earlier build's holds; frozen-replies.ts restores), saved at once: `held: null`
 * ends the hold; `result` replaces the words the receipt kept; `copyOf` replaces the originals and `copyOf: null` removes them. */
export function settleHeldReceipt(id: string, patch: { judgedAt?: number; held?: null; reply?: null; result?: Outbound; copyOf?: EgressOrigin | null }): void {
  const kept = receipts.find((receipt) => receipt.id === id);
  if (!kept) return;
  if (patch.judgedAt !== undefined && kept.held) kept.held = { ...kept.held, judgedAt: patch.judgedAt };
  if (patch.held === null) delete kept.held;
  if (patch.reply === null) delete kept.reply; // the held row it owed is in the conversation
  if (patch.result !== undefined) {
    kept.result = outboundWords(patch.result).slice(0, RESULT_MAX_CHARS);
    if (MurageStatus.is(patch.result) && !ReleasedText.is(patch.result)) kept.resultStatus = { key: patch.result.key, ...(patch.result.data ? { data: { ...patch.result.data } } : {}) };
    else delete kept.resultStatus;
  }
  if (patch.copyOf === null) delete kept.copyOf;
  else if (patch.copyOf) kept.copyOf = { threadId: patch.copyOf.threadId, messageIds: patch.copyOf.messageIds.slice(0, 65) };
  saveReceipts();
}
/** Finished hand-offs whose final commit failed in this process: their row and receipt are still there, waiting to be settled together. */
const stranded = new Set<string>();
/** How many stranded hand-offs one sweep settles at most. */
export const RESETTLE_PAGE = 100;
/** Settles the hand-offs whose final commit failed (finishHandoff), from their kept receipt: the request's end and the row's removal in one commit (settleReceipted).
 * One that fails again stays for the next sweep; one whose row or receipt is gone is forgotten (it was settled some other way). At most RESETTLE_PAGE per call.
 * Returns how many it settled. The server calls this on the parked-delegation sweep (every 30 s). */
export function resettleStranded(): number {
  let settled = 0, looked = 0;
  for (const id of [...stranded]) {
    if (looked++ >= RESETTLE_PAGE) break;
    const receipt = findDelegationReceipt(id);
    // a receipt that still owes its line is settled even with its row gone: the settle writes the line (stable id) before anything else
    if (!receipt || (!handoffRow(id) && !owes(receipt))) { stranded.delete(id); continue; }
    if (settleReceipted(receipt)) { stranded.delete(id); settled++; }
  }
  return settled;
}
export const HANDOFF_NOT_SETTLED = "HANDOFF_NOT_SETTLED";

/** What a repeated hand-off tool call is told: the earlier request's own outcome, whatever state it is in. A request that is still queued or running is the same task;
 * one that finished answers with its receipt (its row is gone by then, so the row's existence says nothing). Never a reason to queue the work again. */
export function repeatedHandoffReply(repeated: Pick<RoomRequest, "id" | "state">, targetName: BotName): { queued: true; taskId: string; message: MurageStatus; done?: true; status?: string } {
  if (!isTerminalRoomRequestState(repeated.state)) return { queued: true, taskId: repeated.id, message: status("handed_over_turn", { name: targetName }) };
  const receipt = findDelegationReceipt(repeated.id);
  return { queued: true, taskId: repeated.id, done: true, status: receipt?.status ?? repeated.state, message: status("handed_over_finished", { name: targetName }) };
}

/** Settles a started hand-off whose receipt is recorded: the request's terminal state (the receipt listener's writes) and the row's removal commit together. On a failure
 * nothing is removed and nothing is ended: the row stays, the receipt stays, and a later pass (the dispatch, the boot sweep) calls this again. True when it settled. */
export function settleReceipted(receipt: DelegationReceipt): boolean {
  let after: (() => void) | void = undefined;
  let written = false;
  try {
    transaction(() => {
      // The owed line first, whatever the hand-off's origin, then the request's end, then the row's removal: the row never goes before its line is written.
      let delivered: { id: string } | null = null;
      if (owes(receipt)) {
        // with nobody to write it, nothing settles: the row and the receipt stay, and a later pass (once the writer is there) settles them
        if (!owedReplyWriter) throw new Error("the line this hand-off owes has no writer yet");
        const outcome = owedReplyWriter(receipt);
        if (outcome !== FINALIZER_WRITES) { delivered = outcome; written = true; }
      }
      after = receiptListener?.(receipt, delivered);
      stmts().removeStarted.run(receipt.id);
    }, { op: "delegation-receipt-settle" });
  } catch (error) {
    // the next pass is THIS process's stranded sweep (resettleStranded, every 30 s), not only the next start: a boot settling that meets a held lock
    // (isDatabaseBusy) has already moved its cursor past this started row, and ordinary drains never look at started rows. The sweep only settles
    // (the line under its stable id, the request's end, the row's removal); it never dispatches, and it forgets the id once the row and the owed line are gone.
    stranded.add(receipt.id);
    console.error("delegations: a finished handoff could not be settled; its row stays and the next pass settles it", error);
    return false;
  }
  // the line committed with the settle: the receipt owes nothing any more (after the OUTERMOST commit, so a rollback around this leaves it owed)
  if (written) afterCommit(() => replyDelivered(receipt.id));
  // the follow-ups (wakes announced, the pump) wait for the OUTERMOST commit: inside an enclosing transaction that later rolls back, nobody is told of a completion that did not happen
  const followUp = after as (() => void) | void;
  if (followUp) afterCommit(() => { try { followUp(); } catch (error) { console.error("delegations: receipt follow-up failed", error); } });
  return true;
}

/** What stopWaitingDelegation throws when the queue row could not be deleted: nothing was stopped and the handoff is still waiting. */
export const DELEGATION_STOP_FAILED = "DELEGATION_STOP_FAILED: the handoff could not be stopped; it is still waiting";

/** A deleted conversation takes its handoffs with it: queued ones and the
 * results peers sent back to it. The queued rows themselves already left in the transaction that recorded the owner's deletion
 * (owner-deletions.ts), so a committed deletion never leaves a runnable row; this removes any a later write added and the receipts. */
export function forgetDelegationsForThreads(threadIds: readonly string[]): void {
  const gone = new Set(threadIds);
  if (gone.size) {
    try { transaction(() => { const forget = stmts().removeThread; for (const threadId of gone) { persistWrites++; endLiveRequestsOfThread(database(), threadId, "source-deleted"); forget.run(threadId); } }, { op: "delegation-forget" }); }
    catch (error) { console.error("delegations: could not forget a deleted conversation's handoffs", error); }
  }
  const kept = receipts.filter((receipt) => !gone.has(receipt.sourceThreadId));
  if (kept.length !== receipts.length) {
    receipts = kept;
    saveReceipts();
  }
}

export function findDelegationReceipt(id: string): DelegationReceipt | null {
  // A receipt past its retention is gone on read too, so an idle process never serves one that a write would have pruned.
  const found = receipts.find((receipt) => receipt.id === id);
  // ...except one that still owes its source conversation a line, or whose reply is still held: that never expires, however long Murage was closed.
  return found && (owes(found) || holds(found) || Date.now() - found.finishedAt <= RECEIPT_MAX_AGE_MS) ? found : null;
}

/** A still-queued task's routing info, or null once it dispatched/settled. */
export function pendingDelegationInfo(id: string): { sourceThreadId: string; toBotId: string; attempts: number } | null {
  const found = queuedItem(id);
  return found ? { sourceThreadId: found.threadId, toBotId: found.item.toBotId, attempts: found.item.attempts } : null;
}

export function hasPendingBotDelegations(bot: BotRecord): boolean {
  const db = database();
  const threads = new Set([bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)]);
  // by index: the bot as target, the bot as sender, and a sender-less item on one of the bot's own threads (a parked item is not pending work)
  if (db.prepare("SELECT 1 AS x FROM pending_delegations WHERE to_bot_id=? AND phase IN ('fresh','busy') LIMIT 1").get(bot.id)) return true;
  if (db.prepare("SELECT 1 AS x FROM pending_delegations WHERE from_bot_id=? AND phase IN ('fresh','busy') LIMIT 1").get(bot.id)) return true;
  const own = db.prepare("SELECT 1 AS x FROM pending_delegations WHERE source_thread_id=? AND from_bot_id IS NULL AND phase IN ('fresh','busy') LIMIT 1");
  for (const threadId of threads) if (own.get(threadId)) return true;
  return false;
}

/** How many waiting hand-offs one idle-release pass looks at (admission questions and writes both stay within this, however they are spread over source threads). */
export const IDLE_RELEASE_BATCH = 100;
/** Where each target's rotating look at its waiting hand-offs stands: the last (source thread, row position) the previous pass reached. A pass resumes after it. */
const idleCursor = new Map<string, { thread: string; pos: number }>();
/** Whether a target's last idle-release pass stopped at a full page, so the caller should run another pass (after the event loop has had its turn). */
export function idleReleaseHasMore(toBotId: string): boolean { return idleCursor.has(toBotId); }

/** One bounded page of the busy hand-offs waiting for this bot, in (source thread, queue position) order after the bot's cursor: at most IDLE_RELEASE_BATCH rows,
 * found by the pd_busy index, so the cost follows the page and never the backlog, and one source thread holding the whole backlog is paged exactly like many. */
export const WAITING_PAGE_SQL = Object.freeze({
  same: `SELECT rowid AS pos, id, source_thread_id FROM pending_delegations INDEXED BY pd_busy WHERE to_bot_id=? AND phase='busy' AND source_thread_id=? AND rowid>? ORDER BY rowid LIMIT ?`,
  after: `SELECT rowid AS pos, id, source_thread_id FROM pending_delegations INDEXED BY pd_busy WHERE to_bot_id=? AND phase='busy' AND source_thread_id>? ORDER BY source_thread_id, rowid LIMIT ?`,
});
function waitingPage(toBotId: string): Array<{ pos: number; id: string; source_thread_id: string }> {
  type Row = { pos: number; id: string; source_thread_id: string };
  const at = idleCursor.get(toBotId);
  const rest = at ? (stmts().waitingSame.all(toBotId, at.thread, at.pos, IDLE_RELEASE_BATCH) as unknown as Row[]) : [];
  if (rest.length >= IDLE_RELEASE_BATCH) return rest;
  const more = stmts().waitingAfter.all(toBotId, at?.thread ?? "", IDLE_RELEASE_BATCH - rest.length) as unknown as Row[];
  return rest.concat(more);
}
/** The source threads of the next bounded page of hand-offs waiting for this busy bot - the set its idle transition re-drains. A read: it does not move the pass's cursor.
 * Fresh items are excluded: they run when their SOURCE turn settles, and draining them early would start the peer too soon. */
export function threadsWaitingOn(toBotId: string): string[] {
  return [...new Set(waitingPage(toBotId).map((row) => row.source_thread_id))];
}

/** Mark a target's observed busy period as finished and return the source
 * threads that should be retried. This makes retries count distinct busy
 * periods, not unrelated drain requests on the same source thread.
 *
 * Each call takes one bounded page (IDLE_RELEASE_BATCH hand-offs, rotating, whatever mix of source threads they belong to); while `idleReleaseHasMore` the caller
 * runs another pass.
 *
 * `admit`, when given, limits the release to the source threads whose
 * handoff could start right now. A bot still busy in one thread can free a
 * slot another handoff could use (upstream #1678), but releasing every
 * waiting handoff then would spend a busy retry on each one whose own
 * thread is still taken, and MAX_BUSY_ATTEMPTS would cancel it while the
 * teammate was only ever busy on something else. */
export function releaseDelegationsWaitingOn(toBotId: string, admit?: (sourceThreadId: string, handoffId: string) => boolean): string[] {
  const page = waitingPage(toBotId);
  if (!page.length) { idleCursor.delete(toBotId); return []; }
  const released = new Set<string>();
  try {
    transaction(() => {
      // each waiting hand-off of the page is asked the dispatch's own question (admit)
      for (const row of page) {
        let ready = !admit;
        if (admit) { try { ready = admit(row.source_thread_id, row.id); } catch { ready = false; } }
        if (!ready) continue;
        persistWrites++;
        stmts().release.run(row.id);
        released.add(row.source_thread_id);
      }
    }, { op: "delegation-release" });
  } catch (error) { console.error("delegations: could not release handoffs waiting on a teammate", error); return []; }
  const last = page[page.length - 1]!;
  if (page.length < IDLE_RELEASE_BATCH) idleCursor.delete(toBotId); else idleCursor.set(toBotId, { thread: last.source_thread_id, pos: last.pos });
  return [...released];
}

/** Release every parked handoff that should be retried now, whoever it
 * waits on, and return the source threads to drain.
 *
 * Two reasons release an item. Its target can take it right now: the idle
 * transition that should have woken it already passed while the target was
 * still held (a room keeps its members until the whole room turn ends, and
 * nothing fires after that). Or it has waited BUSY_RETRY_FALLBACK_MS with
 * no wake-up at all: the drain then re-checks, and a target still busy
 * costs an attempt, so the wait ends in the usual "canceled" line. The
 * server calls this when a room turn ends and on a timer. */
export function releaseParkedDelegations(
  canStart: (toBotId: string, sourceThreadId: string, handoffId: string) => boolean,
  now = Date.now(),
  fallbackMs = BUSY_RETRY_FALLBACK_MS,
): string[] {
  const woke = new Set<string>();
  lookedAt = 0;
  const s = stmts();
  const busyCut = now + BUSY_RETRY_FALLBACK_MS - fallbackMs;
  // One transaction for the whole pass; a writer lock held by someone else for longer than the background wait skips this sweep (the next one tries again).
  try {
    transaction(() => {
      // Items whose wait is over, by index (bounded per pass; nothing else is read). A parked unresolved item is looked at again once its wait is over: it
      // stays parked (inactive, stoppable) until a drain actually looks again, and the next wait starts now, so a drain that cannot run (its sender is
      // not known either) is not repeated every sweep. A busy item past the fallback is released for a drain. A due item whose thread is draining is postponed.
      for (const row of s.due.all(Math.max(now, busyCut), busyCut, now) as unknown as StoredRow[]) {
        lookedAt++;
        if (drainingThreads.has(row.source_thread_id)) { persistWrites++; s.postpone.run(now + POSTPONE_MS, row.id); continue; }
        if (row.phase === "parked") {
          // The wait is over: the next drain of its thread looks again, and that drain writes the item's next wait (the pass itself writes nothing for it).
          // One that was already marked and is still due was not looked at (its drain did not reach it): pushed back a little so it cannot hold a slot.
          if (recheckIds.has(row.id)) { persistWrites++; s.postpone.run(now + POSTPONE_MS, row.id); continue; }
          recheckIds.add(row.id);
        } else { persistWrites++; s.release.run(row.id); }
        woke.add(row.source_thread_id);
      }
      // Items waiting on a busy teammate whose teammate can take them now: per target bot, a bounded page of its waiting threads (rotating, so a page that
      // cannot start does not hide the ones behind it).
      for (let bot = (s.nextBusyBot.get("") as { to_bot_id: string } | undefined)?.to_bot_id; bot !== undefined; bot = (s.nextBusyBot.get(bot) as { to_bot_id: string } | undefined)?.to_bot_id) {
        const after = busyCursor.get(bot) ?? "";
        const page = s.busyOfBot.all(bot, after) as unknown as Array<{ id: string; source_thread_id: string }>;
        if (page.length < BUSY_START_BATCH) busyCursor.delete(bot); else busyCursor.set(bot, page[page.length - 1]!.source_thread_id);
        for (const row of page) {
          lookedAt++;
          if (woke.has(row.source_thread_id) || drainingThreads.has(row.source_thread_id)) continue;
          let ready = false;
          try { ready = canStart(bot, row.source_thread_id, row.id); } catch { ready = false; }
          if (!ready) continue;
          persistWrites++;
          s.release.run(row.id);
          woke.add(row.source_thread_id);
        }
      }
    }, { op: "delegation-sweep", busyMs: SWEEP_BUSY_MS });
  } catch (error) {
    if (isDatabaseBusy(error)) return [];
    throw error;
  }
  return [...woke];
}
/** Where each target bot's rotating look at its waiting threads stands. */
const busyCursor = new Map<string, string>();

/** Is any queued handoff actually in progress? A parked one is not: it only
 * waits for a busy teammate, it is on disk, and nothing can dispatch it
 * while a backup holds admission. Counting it as running work refused every
 * backup, with nothing for the person to finish or stop (0.1.60 L4-1). A
 * fresh item still counts: its source turn is settling and it runs next. */
export function hasActiveDelegationWork(): boolean {
  const s = stmts();
  for (const threadId of drainingThreads) if ((s.countThread.get(threadId) as { n: number }).n > 0) return true;
  return Boolean(database().prepare("SELECT 1 AS x FROM pending_delegations WHERE phase='fresh' LIMIT 1").get());
}

/** The person's Stop on a waiting line: drop that one parked handoff, with
 * a receipt the delegating bot can read and a line where the wait was
 * shown. False when it is not waiting any more (it ran, gave up, or is
 * being dispatched right now). */
export function stopWaitingDelegation(bus: CommsBus, id: string): boolean {
  {
    const found = queuedItem(id);
    if (!found) return false;
    const { threadId, item } = found;
    // A parked unknown-target handoff can always be stopped, even while its thread drains another item.
    if (!item.unknownTarget && (!item.waitingOnBusy || drainingThreads.has(threadId))) return false;
    const target = bus.store.bot(item.toBotId);
    // The queue row and its request are closed together: the stop is reported only after the DELETE committed, and a failed one
    // leaves both exactly as they were (still waiting, still stoppable) and throws for the route to surface.
    try {
      persistWrites++;
      settleHandoffPair(id, { state: "cancelled", note: "the owner stopped this handoff" });
    } catch (error) {
      console.error("delegations: could not stop a waiting handoff", error);
      throw new Error(DELEGATION_STOP_FAILED);
    }
    recheckIds.delete(id);
    clearWaitLine(bus, threadId, item);
    const name = target?.name ?? item.toBotId;
    recordDelegationReceipt({
      id,
      sourceThreadId: threadId,
      toBotId: item.toBotId,
      toBotName: name,
      status: "cancelled",
      result: status("receipt_owner_stopped"),
    });
    appendDelegationRow(bus, threadId, item.fromBotId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${name} stopped by you`, ok: false },
    });
    return true;
  }
}

/** Drop a queued handoff that has not started, whatever it waits on (lane
 * E1: its room request was cancelled, or the owner stopped the project).
 * False once it is draining or gone. */
export function dropQueuedDelegation(bus: CommsBus, id: string, reason: Outbound): boolean {
  const found = queuedItem(id);
  if (!found) return false;
  const { threadId, item } = found;
  if (drainingThreads.has(threadId)) return false;
  const name = bus.store.bot(item.toBotId)?.name ?? item.toBotId;
  // Not dropped, not reported: the row stays and the next drain settles it against its (cancelled) request.
  if (!acknowledgeDelegation(threadId, id, bus)) return false;
  recordDelegationReceipt({ id, sourceThreadId: threadId, toBotId: item.toBotId, toBotName: name, status: "cancelled", result: reason });
  appendDelegationRow(bus, threadId, item.fromBotId, { role: "bot", kind: "activity", tool: { name: `Delegation to @${name} was cancelled`, ok: false } });
  return true;
}

/** Take the Stop control off an item's waiting line. Never throws: the line
 * is only a view of the queue, and the thread may be gone. */
export function clearWaitLine(bus: CommsBus | undefined, threadId: string, item: PendingDelegationItem): void {
  const messageId = item.waitMessageId;
  if (!messageId) return;
  delete item.waitMessageId;
  if (!bus) return;
  try { bus.store.patchMessage(threadId, messageId, { delegationWait: undefined }); } catch { /* the thread is gone */ }
}

/** Park an item on a busy target and show the waiting line with Stop. */
export function parkWaiting(bus: CommsBus, sourceThreadId: string, item: PendingDelegationItem, targetName: string, why: "busy" | "failed" = "busy"): void {
  item.waitingSince = Date.now();
  clearWaitLine(bus, sourceThreadId, item);
  const line = appendDelegationRow(bus, sourceThreadId, item.fromBotId, {
    role: "bot",
    kind: "activity",
    tool: { name: why === "busy" ? `Delegation to @${targetName} waiting: they're busy (retry ${item.attempts}/${MAX_BUSY_ATTEMPTS} when they finish)`
      : `Delegation to @${targetName} waiting: it did not start (retry ${item.attempts}/${MAX_BUSY_ATTEMPTS}). It tries again on its own, or you can stop it.` },
    delegationWait: { id: item.id },
  });
  item.waitMessageId = line.id;
  saveItem(item);
}

/** Park an item that cannot be decided yet because the registry does not list its TARGET or its SENDER and no recorded deletion says it is gone:
 * inactive, stoppable, and retried with a growing wait (the persisted `unknownRetryAt`; the flag keeps its name for compatibility). The one waiting
 * line is reused across retries. */
function parkUnresolved(bus: CommsBus, sourceThreadId: string, item: PendingDelegationItem, kind: "sender" | "target"): void {
  const attempts = item.unknownAttempts ?? 0;
  item.unknownTarget = true;
  item.unknownAttempts = attempts + 1;
  item.unknownRetryAt = Date.now() + unknownTargetBackoffMs(attempts);
  delete item.unknownRecheck;
  if (!item.waitMessageId) {
    try {
      const line = appendDelegationRow(bus, sourceThreadId, item.fromBotId, {
        role: "bot",
        kind: "activity",
        tool: { name: kind === "sender"
          ? "Delegation waiting: the teammate who handed this off is not available yet. It tries again on its own, or you can stop it."
          : "Delegation waiting: that teammate is not available yet. It tries again on its own, or you can stop it." },
        delegationWait: { id: item.id },
      });
      item.waitMessageId = line.id;
    } catch { /* the thread is gone; the item still waits and can be retried */ }
  }
  saveItem(item);
}
/** Parks an unresolved item once per wait: other drains of this thread inside the wait do not look again or add lines; the timer retries it when the wait is over. */
export function parkUnresolvedIfDue(bus: CommsBus, sourceThreadId: string, item: PendingDelegationItem, kind: "sender" | "target"): void {
  if (!(item.unknownTarget && !item.unknownRecheck && Date.now() < (item.unknownRetryAt ?? 0))) parkUnresolved(bus, sourceThreadId, item, kind);
}

/** A recorded owner deletion (a bot, a room or a thread) is exactly what settles a parked item that names it: the matching items become due now, so
 * the next release looks again instead of waiting out the backoff. Returns the source threads to drain. */
export function wakeParkedDelegationsFor(key: string): string[] {
  const bot = key.startsWith("bot:") ? key.slice(4) : undefined;
  if (bot === undefined && key.startsWith("group:")) return [];
  const threads = new Set<string>();
  try {
    transaction((db) => {
      const sql = bot !== undefined
        ? "UPDATE pending_delegations SET retry_at=0 WHERE phase='parked' AND retry_at>0 AND (to_bot_id=? OR from_bot_id=?) RETURNING source_thread_id"
        : "UPDATE pending_delegations SET retry_at=0 WHERE phase='parked' AND retry_at>0 AND source_thread_id=? RETURNING source_thread_id";
      const rows = (bot !== undefined ? db.prepare(sql).all(bot, bot) : db.prepare(sql).all(key)) as Array<{ source_thread_id: string }>;
      persistWrites += rows.length;
      for (const row of rows) threads.add(row.source_thread_id);
    }, { op: "delegation-wake" });
  } catch (error) { console.error("delegations: could not wake handoffs for a recorded deletion", error); }
  return [...threads];
}
onOwnerDeletion(key => { wakeParkedDelegationsFor(key); });

/** Validates one queued handoff, from a stored row or from a legacy delegations.json entry. Anything that does not validate is null:
 * a malformed present marker must never become an unmarked turn. */
export function parsePendingItem(value: unknown): PendingDelegationItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<PendingDelegationItem>;
  if (
    typeof item.toBotId !== "string" ||
    typeof item.message !== "string" ||
    !Number.isFinite(item.depth)
  ) return null;
  // A malformed present marker must never become an unmarked turn.
  if (Object.hasOwn(item, "eventId") && !validEventId(item.eventId)) return null;
  if (Object.hasOwn(item, "executionAudience") && !validExecutionAudience(item.executionAudience)) return null;
  if (item.routineAuthority !== undefined && (!item.routineAuthority ||
    !ROUTINE_PERMISSION_MODES.includes(item.routineAuthority.permissionMode) ||
    !["manual", "schedule"].includes(item.routineAuthority.triggerSource))) return null;
  if (item.coordination !== undefined && !coordinationTraceSchema.safeParse(item.coordination).success) return null;
  const loaded: PendingDelegationItem = {
    id: typeof item.id === "string" && item.id ? item.id : newId(),
    toBotId: item.toBotId,
    message: item.message,
    ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    depth: Math.max(0, Math.trunc(item.depth!)),
    attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.trunc(item.attempts!)) : 0,
    ...(typeof item.fromBotId === "string" && item.fromBotId ? { fromBotId: item.fromBotId } : {}),
    ...(item.eventId !== undefined ? { eventId: item.eventId } : {}),
    ...(item.executionAudience ? { executionAudience: item.executionAudience } : {}),
    ...(item.coordination ? { coordination: coordinationTraceSchema.parse(item.coordination) } : {}),
  };
  if (typeof item.senderTurnId === "string" && item.senderTurnId) loaded.senderTurnId = item.senderTurnId;
  else if (item.senderTurnId === null) loaded.senderTurnId = null;
  if (typeof item.sourceMessageId === "string" && item.sourceMessageId) loaded.sourceMessageId = item.sourceMessageId;
  if (item.approvalAlreadyGranted === true) loaded.approvalAlreadyGranted = true;
  if (item.fullAccessWaived === true) loaded.fullAccessWaived = true;
  // fails closed: anything but an explicit false-by-absence keeps the mark
  if (Object.hasOwn(item, "notOwnerAudience")) loaded.notOwnerAudience = item.notOwnerAudience !== false;
  if (Object.hasOwn(item, "unattended")) loaded.unattended = item.unattended !== false;
  if (item.routineAuthority) loaded.routineAuthority = { ...item.routineAuthority };
  if (item.waitingOnBusy === true) {
    loaded.waitingOnBusy = true;
    // A queue written before this field existed restarts its clock.
    loaded.waitingSince = Number.isFinite(item.waitingSince) ? item.waitingSince! : Date.now();
  }
  if (typeof item.waitMessageId === "string" && item.waitMessageId) loaded.waitMessageId = item.waitMessageId;
  if (item.unknownTarget === true) {
    loaded.unknownTarget = true;
    loaded.unknownRetryAt = Number.isFinite(item.unknownRetryAt) ? item.unknownRetryAt! : Date.now() + UNKNOWN_TARGET_BACKOFF_MIN_MS;
  }
  if (Number.isFinite(item.unknownAttempts) && item.unknownAttempts! > 0) loaded.unknownAttempts = Math.trunc(item.unknownAttempts!);
  if (item.heldReason === "busy" || item.heldReason === "didNotStart") loaded.heldReason = item.heldReason;
  return loaded;
}

/** Where a validated legacy entry goes: the row the importer inserts (pending-delegations-schema.ts). */
registerLegacyDelegationParser((threadId, value) => {
  const item = parsePendingItem(value);
  if (!item) return null;
  const { phase, retryAt } = placement(item);
  return { id: item.id, sourceThreadId: threadId, toBotId: item.toBotId, fromBotId: item.fromBotId ?? null, phase, retryAt, item: itemJson(item) };
});

/** Boot: brings in a queue a 1.0.1 build left in delegations.json (once), forgets the "look again" marks of the last process, and loads the receipts. */
export function _loadPending(): void {
  try {
    const db = database();
    importLegacyDelegations(db);
    recheckIds.clear();
  } catch (error) {
    console.error("delegations: could not read the queue", error);
  }
  receipts = [];
  try {
    const rawReceipts = JSON.parse(readFileSync(RECEIPTS_FILE, "utf8"));
    if (Array.isArray(rawReceipts)) {
      const now = Date.now();
      const loaded: DelegationReceipt[] = [];
      for (const value of rawReceipts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        // SAFETY: the Partial view only names candidate fields; every one is
        // narrowed below before a receipt is constructed from the narrowed
        // locals, so nothing unvalidated survives into `receipts`.
        const candidate = value as Partial<DelegationReceipt>;
        const { id, sourceThreadId, toBotId, toBotName, status, result, finishedAt, copyOf } = candidate;
        if (typeof id !== "string" || !id) continue;
        if (typeof sourceThreadId !== "string" || typeof toBotId !== "string") continue;
        if (typeof toBotName !== "string" || typeof status !== "string") continue;
        // an old receipt is dropped, unless it still owes its source conversation a line: that one is delivered at this start, then ages out
        if (!Number.isFinite(finishedAt) || (now - finishedAt! > RECEIPT_MAX_AGE_MS && !validOwedReply(candidate.reply) && !validHold(candidate.held))) continue;
        const receipt: DelegationReceipt = { id, sourceThreadId, toBotId, toBotName, status, finishedAt: finishedAt! };
        if (typeof result === "string") receipt.result = result;
        // the line's key and plain values come back with it, so a failure keeps its reason after a restart; one that no longer reads back as a line is dropped
        const kept = candidate.resultStatus;
        if (kept && typeof kept === "object" && typeof kept.key === "string") {
          const data = kept.data && typeof kept.data === "object" && !Array.isArray(kept.data)
            ? Object.fromEntries(Object.entries(kept.data).filter((entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number")) : undefined;
          if (storedStatusShapeOk(kept.key, data)) receipt.resultStatus = { key: kept.key, ...(data ? { data } : {}) };
        }
        if (copyOf && typeof copyOf === "object" && typeof copyOf.threadId === "string" && Array.isArray(copyOf.messageIds) && copyOf.messageIds.every((m) => typeof m === "string")) {
          receipt.copyOf = { threadId: copyOf.threadId, messageIds: copyOf.messageIds.slice(0, 65) };
        }
        if (typeof candidate.requestId === "string" && candidate.requestId) receipt.requestId = candidate.requestId;
        if (candidate.notOwnerAudience === true) receipt.notOwnerAudience = true;
        if (candidate.lineage === true) receipt.lineage = true;
        if (validOwedReply(candidate.reply)) receipt.reply = candidate.reply;
        const held = validHold(candidate.held);
        if (held) receipt.held = held;
        loaded.push(receipt);
      }
      receipts = pruneReceipts(loaded, now);
    }
  } catch {
    /* no receipts yet */
  }
}

/** One page of the source threads with a handoff that runs or waits on a teammate (a parked one is left to the due query), in thread order, after `after`.
 * What the boot drain and the capacity drain iterate; never the whole set at once. */
export function pendingThreads(after = "", limit = DRAIN_PAGE): string[] {
  const db = database();
  const page = db.prepare("SELECT DISTINCT source_thread_id FROM pending_delegations WHERE phase=? AND source_thread_id>? ORDER BY source_thread_id LIMIT ?");
  const merged = new Set<string>();
  for (const phase of ["fresh", "busy"]) for (const row of page.all(phase, after, limit) as Array<{ source_thread_id: string }>) merged.add(row.source_thread_id);
  return [...merged].sort().slice(0, limit);
}

/** Read-only metadata for the local Team Map. Task prompts stay private;
 * the UI only needs to know who handed work to whom and the optional label.
 * Bounded: the first SNAPSHOT_LIMIT handoffs in queue order. */
export const SNAPSHOT_LIMIT = 500;
export function pendingDelegationSnapshot(options: { activeOnly?: boolean } = {}): Array<{
  sourceThreadId: string;
  toBotId: string;
  reason?: string;
}> {
  const db = database();
  const draining = [...drainingThreads];
  const where = options.activeOnly ? `WHERE phase='fresh'${draining.length ? ` OR source_thread_id IN (${draining.map(() => "?").join(",")})` : ""}` : "";
  const rows = db.prepare(`SELECT source_thread_id, to_bot_id, json_extract(item,'$.reason') AS reason FROM pending_delegations ${where} ORDER BY rowid LIMIT ${SNAPSHOT_LIMIT}`)
    .all(...(options.activeOnly ? draining : [])) as Array<{ source_thread_id: string; to_bot_id: string; reason: unknown }>;
  return rows.map((row) => ({
    sourceThreadId: row.source_thread_id,
    toBotId: row.to_bot_id,
    ...(typeof row.reason === "string" && row.reason ? { reason: row.reason } : {}),
  }));
}

/** How many handoffs one turn may queue. Small on purpose: this is the only
 * thing standing between a confused bot and a fan-out of real turns. */
const MAX_QUEUED_PER_THREAD = MAX_HANDOFFS_PER_TURN;

/** Validate and enqueue a delegation. Pushes a "Delegated to @B: reason"
 * chip to the source thread so the user can see what was queued. */
export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
  sourceThreadId = defaultThreadId(from),
): QueuedDelegation {
  if (item.eventId !== undefined && !validEventId(item.eventId)) throw new Error("Invalid delegation event identity");
  if (item.toBotId === from.id) return { result: "self" };
  if (item.depth >= maxDepth) return { result: "too_deep" };
  const target = bus.store.bot(item.toBotId);
  if (!target) return { result: "no_target" };
  // Work for a conversation the owner deleted is never accepted (a turn that outlived its deletion could still queue one).
  if (ownerDeletedThread(database(), sourceThreadId)) return { result: "source_deleted" };
  // Async handoff removes the backpressure that ask_bot got for free by
  // making the caller wait. Without a cap, one turn can queue unboundedly
  // and fan out into as many real turns on the next settle.
  if (queuedCount(sourceThreadId) >= MAX_QUEUED_PER_THREAD) return { result: "too_many" };
  const id = newId();
  const executionAudience = issueWorkAudience(from.id, item.toBotId, sourceThreadId, item.executionAudience ?? issueExecutionAudience(from.id, sourceThreadId, id), id, item.notOwnerAudience !== true);
  if (executionAudience && !validExecutionAudience(executionAudience)) throw new Error("Invalid execution audience");
  const senderTurnId = bus.turnOf?.(sourceThreadId) ?? null;
  const queued: PendingDelegationItem = { ...item, ...(executionAudience ? { executionAudience } : {}), id, attempts: 0, fromBotId: from.id };
  queued.senderTurnId = senderTurnId;
  // The room request that tracks this handoff and the queue row are accepted together or not at all.
  let inserting = false;
  try {
    transaction(() => {
      const origin: DelegationOrigin = bus.prepareDelegation?.(from.id, target.id, sourceThreadId, item.message, id) ?? "owner";
      // Shared work already names the conversation it runs in when it is queued; the row stores that destination from the start (the other origins
      // resolve theirs once, at their first admission, and store it then: server/handoff-dispatch.ts).
      const destination = origin === "shared" ? handoffRequest(database(), id)?.targetThreadId ?? null : null;
      // the source row, in this transaction: its lineage keeps the sending turn before that turn ends or is evicted (rule 6)
      queued.sourceMessageId = bus.store.appendMessage(sourceThreadId, messagedRow(from, target, senderTurnId ?? undefined)).id;
      inserting = true;
      persistWrites++;
      stmts().insert.run(id, sourceThreadId, queued.toBotId, from.id, "fresh", null, itemJson(queued), origin, delegationTurnKey(id), destination);
    }, { op: "delegation-queue" });
  } catch (error) {
    if (inserting) throw new Error("DELEGATION_PERSISTENCE_FAILED: the handoff was not accepted");
    throw error;
  }
  const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
  appendDelegationRow(bus, sourceThreadId, from.id, {
    role: "bot",
    kind: "activity",
    tool: { name: label },
    // A room is several bots in one thread: name who delegated.
    ...(bus.store.groupByThread(sourceThreadId) ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
  });
  return { result: "ok", id };
}

/** Drain queued delegations for a source thread (called on its turn.completed): the queue walk and nothing else. Every item goes to dispatchHandoff
 * (server/handoff-dispatch.ts), the ONE place a hand-off is admitted, waited on, started or settled, so this walk, the shared drain, the idle release, the
 * boot settling and Send again cannot disagree about a rule. A failure of one item does not stop the rest, and an item that cannot be dispatched stays queued.
 * The thread's own hand-offs are walked page by page. Its SHARED hand-offs are not walked: the shared round (shared-work.ts drainSharedWork) owns them and is
 * woken by their own events. A drain looks at ONE page of them (DRAIN_PAGE, from where the last drain of this thread stopped, wrapping round), so one that the
 * round cannot reach (its request ended while it waited) is still settled, and the work of a turn's end never follows the shared backlog. */
export function drainDelegations(bus: CommsBus, approvalBus: ApprovalBus, threadId: string): void {
  if (drainingThreads.has(threadId)) {
    queuedRedrains.add(threadId);
    return;
  }
  // The queue is read one page (DRAIN_PAGE) at a time, in queue order, and the event loop gets its turn between pages: a conversation that holds a very long queue
  // (an import does not enforce the per-turn cap) is drained a page per pass, never all at once.
  let page = queuedPage(threadId, 0);
  const ownFirst = page.first;
  let sharedDone = false;
  const sharedSlice = (): { rows: Array<{ id: string }>; first: number; last: number; full: boolean } => {
    const slice = queuedPage(threadId, sharedCursor.get(threadId) ?? 0, stmts().sharedOfThread);
    if (slice.full) sharedCursor.set(threadId, slice.last); else sharedCursor.delete(threadId);
    sharedDone = true;
    return { ...slice, full: false };
  };
  if (!page.rows.length && !page.full) {
    page = sharedSlice();
    if (!page.rows.length) return;
  }
  drainingThreads.add(threadId);
  const seen = new Set<string>();
  // Item after item; a dispatch that needs to wait (the owner's approval) is waited for, one that settles at once is not, so a drain of hand-offs that all
  // settle at once has finished when this function returns. The page may be stale by the time an item's turn comes (a discard receipted it during an
  // earlier item's approval): the dispatch reads the row itself.
  const failed = (id: string, error: unknown): void => { console.error(`delegations: handoff ${id} could not be dispatched; it stays queued`, error); };
  const walk = (from: number): Promise<void> | undefined => {
    for (let index = from; index < page.rows.length; index++) {
      const id = page.rows[index]!.id;
      seen.add(id);
      drainVisits++;
      let outcome: ReturnType<typeof dispatchHandoff>;
      try { outcome = dispatchHandoff(id, { bus, approvalBus }, { ordered: true }); } catch (error) { failed(id, error); continue; }
      if (outcome instanceof Promise) return outcome.then(() => undefined, (error) => { failed(id, error); }).then(() => walk(index + 1));
    }
    // a full page: more may follow, after the event loop has had its turn
    if (!page.full) {
      // the own hand-offs are done: then the one page of shared ones, once
      if (sharedDone) return undefined;
      page = sharedSlice();
      return page.rows.length ? walk(0) : undefined;
    }
    const after = page.last;
    return yieldToLoop().then(() => { page = queuedPage(threadId, after); return walk(0); });
  };
  const settled = (): void => {
    drainingThreads.delete(threadId);
    // A later turn may have queued and settled while this thread was
    // waiting for approval. Only items OUTSIDE what this drain walked warrant a
    // fresh drain - re-draining a just-requeued item would burn its bounded
    // busy retries in milliseconds instead of once per target settle.
    const redrainRequested = queuedRedrains.delete(threadId);
    const hasNewItems = redrainRequested ? false : queuedBeyond(threadId, ownFirst, seen);
    if (redrainRequested || hasNewItems) drainDelegations(bus, approvalBus, threadId);
  };
  const pending = walk(0);
  if (pending) void pending.finally(settled); else settled();
}
/** Where the next drain of a source conversation reads its one page of shared hand-offs (the row position the last page ended at; none: from the start). */
const sharedCursor = new Map<string, number>();
let drainVisits = 0;
/** How many hand-offs the source drains have dispatched since the last reset (a diagnostic for the bounded-work tests). */
export function _sourceDrainVisits(): number { return drainVisits; }
export function _resetSourceDrainVisits(): void { drainVisits = 0; sharedCursor.clear(); }
/** One page of a thread's queued hand-offs after queue position `after` (0 for the first): their ids in queue order, the first and the last position. Unreadable rows are settled as ever. */
function queuedPage(threadId: string, after: number, statement: StatementSync = stmts().byThreadPage): { rows: Array<{ id: string }>; first: number; last: number; full: boolean } {
  const rows: Array<{ id: string }> = [];
  let first = after, last = after, read = 0;
  for (const row of statement.all(threadId, after, DRAIN_PAGE) as unknown as Array<StoredRow & { pos: number }>) {
    if (rows.length === 0) first = row.pos;
    last = row.pos;
    read++;
    if (readable(row)) rows.push({ id: row.id });
  }
  return { rows, first, last, full: read >= DRAIN_PAGE };
}
/** Whether the thread holds a queued hand-off this drain did not walk: one at a queue position from the start of the last page on (new items are queued after the
 * ones that were there; the tail is all a drain that walked every earlier page has left unseen), up to one page. */
function queuedBeyond(threadId: string, fromPosition: number, seen: ReadonlySet<string>): boolean {
  for (const row of stmts().byThreadTail.all(threadId, Math.max(0, fromPosition - 1), DRAIN_PAGE + 1) as unknown as Array<{ id: string }>) if (!seen.has(row.id)) return true;
  return false;
}

/** The owner's recorded deletion of the source conversation, the sender or the target settles a handoff before it starts: the row goes and the
 * sender reads a "cancelled" receipt. No chip is written (the conversation it would land in is gone, or the bot that would read it). */
export function deletionOf(threadId: string, fromBotId: string | undefined | null, toBotId: string): boolean {
  const db = database();
  return ownerDeletedThread(db, threadId) || (fromBotId ? botDeleted(db, fromBotId) : false) || botDeleted(db, toBotId);
}
export const DELETED_NOTE = "the conversation was deleted";
/** Settles a deleted-owner hand-off: the receipt first, then the row. If the row cannot be removed it stays, with no receipt. */
export function cancelForDeletion(bus: CommsBus, threadId: string, item: PendingDelegationItem, fromBotId: string | undefined | null, toBotId: string): boolean {
  if (!deletionOf(threadId, fromBotId, toBotId)) return false;
  if (!acknowledgeDelegation(threadId, item.id, bus)) return false;
  if (!findDelegationReceipt(item.id)) {
    recordDelegationReceipt({ id: item.id, sourceThreadId: threadId, toBotId, toBotName: bus.store.bot(toBotId)?.name ?? toBotId, status: "cancelled", result: status("receipt_deleted") });
  }
  return true;
}

/** Remove one terminal handoff only after approval/dispatch has settled. */
export function acknowledgeDelegation(threadId: string, itemId: string, bus?: CommsBus): boolean {
  const leaving = queuedItem(itemId);
  if (!leaving) return true;
  if (!removeItem(itemId)) return false;
  clearWaitLine(bus, threadId, leaving.item);
  return true;
}

/** What a dispatch throws when the handoff is not startable now (already started, gone, its room request ended, or the conversation is not the stored one). Nothing was written. */
export const DELEGATION_NOT_STARTABLE = "DELEGATION_NOT_STARTABLE";
/** What a dispatch throws when the owner's recorded deletion covers the source conversation, the sender or the target. Nothing was written. */
export const DELEGATION_DELETED = "DELEGATION_DELETED";
export const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
export function countPersistWrite(): void { persistWrites++; }

/** An earlier development build kept a stand-in room record for an owner-conversation hand-off. One that is past `queued` means the hand-off ran
 * (or began): until the clean-up removes it the row must not start. */
export function unmigratedOwnerRecordRan(db: DatabaseSync, id: string): boolean {
  const record = db.prepare("SELECT state FROM room_requests WHERE id=? AND group_id='owner-handoff'").get(id) as { state: string } | undefined;
  return record !== undefined && record.state !== "queued";
}

/** One queue row with every column the dispatch reads, in any phase (null when there is no such hand-off). */
export interface HandoffRow {
  id: string; source_thread_id: string; to_bot_id: string; from_bot_id: string | null; origin: DelegationOrigin; phase: Phase | "started";
  started_at: number | null; target_thread_id: string | null; turn_key: string | null; accepted_turn_id: string | null; start_attempts: number | null; submitted_at: number | null;
  retry_at: number | null; item: string;
  /** when the engine's reply to the hand-off's prompt was stored (server/handoff-evidence.ts), or null */
  evidence_at: number | null;
}
const HANDOFF_COLUMNS = "id, source_thread_id, to_bot_id, from_bot_id, origin, phase, started_at, target_thread_id, turn_key, accepted_turn_id, start_attempts, submitted_at, retry_at, item, evidence_at";
export function handoffRow(id: string): HandoffRow | undefined {
  return database().prepare(`SELECT ${HANDOFF_COLUMNS} FROM pending_delegations WHERE id=?`).get(id) as unknown as HandoffRow | undefined;
}
/** The hand-off rows queued behind a shared request: `queued` (still to be started), `started` (started, held or finished), or none. */
export function handoffPhaseOf(id: string): "queued" | "started" | null {
  const row = database().prepare("SELECT phase FROM pending_delegations WHERE id=?").get(id) as { phase: string } | undefined;
  return row ? (row.phase === "started" ? "started" : "queued") : null;
}
/** The item a queued (not started) row holds. An unreadable row is removed with an error receipt, as ever (unless `settleUnreadable` is false: a question only). */
export function handoffItem(row: HandoffRow, settleUnreadable = true): PendingDelegationItem | null {
  if (row.phase === "started") return null;
  return settleUnreadable ? readable(row as StoredRow) : itemOf(row as StoredRow);
}
/** The stored item of a queued (not started) hand-off. An unreadable row is removed with an error receipt, as ever. */
export function queuedHandoff(id: string, settleUnreadable = true): { threadId: string; item: PendingDelegationItem } | null {
  if (settleUnreadable) return queuedItem(id);
  const row = stmts().byId.get(id) as StoredRow | undefined;
  const item = row ? itemOf(row) : null;
  return row && item ? { threadId: row.source_thread_id, item } : null;
}
/** A hand-off that failed to start before the provider and is ready to run again waits on its own retry: parked busy and due now, so the timed release or the
 * target's idle release picks it up (no attempt is spent here: the start attempts bound it). */
export function parkForRetry(id: string): void {
  database().prepare("UPDATE pending_delegations SET phase='busy', retry_at=? WHERE id=? AND phase IN ('fresh','busy')").run(Date.now(), id);
  persistWrites++;
}
/** The conversation a hand-off will run in, stored once (`target_thread_id`). `from` is what the caller read: a write that finds another value changes nothing. */
export function storeHandoffDestination(id: string, threadId: string, from: string | null): boolean {
  const changed = database().prepare("UPDATE pending_delegations SET target_thread_id=? WHERE id=? AND phase<>'started' AND target_thread_id IS ?").run(threadId, id, from);
  persistWrites++;
  return Number(changed.changes) === 1;
}
/** The newest state of an item after the dispatch changed it (a wait line, an attempt counted). */
export function saveHandoffItem(item: PendingDelegationItem): void { saveItem(item); }

/** The target thread and prompt key a started handoff recorded, for tests and the Team Map. Null when the handoff is not started. */
export function startedDelegation(id: string): { targetThreadId: string; turnKey: string; acceptedTurnId: string | null; startAttempts: number; submittedAt: number | null } | null {
  const row = database().prepare("SELECT target_thread_id, turn_key, accepted_turn_id, start_attempts, submitted_at FROM pending_delegations WHERE id=? AND phase='started'").get(id) as
    { target_thread_id: string; turn_key: string | null; accepted_turn_id: string | null; start_attempts: number | null; submitted_at: number | null } | undefined;
  return row ? { targetThreadId: row.target_thread_id, turnKey: row.turn_key ?? delegationTurnKey(id), acceptedTurnId: row.accepted_turn_id, startAttempts: row.start_attempts ?? 0, submittedAt: row.submitted_at } : null;
}

export const RESTART_RECEIPT = "interrupted by a restart";
/** What the owner reads when a restart cut a hand-off off after it was handed to the provider and nothing shows it ran. */
export const uncertainHandoffText = (name: string): string => `Murage restarted while handing this to @${name}. It may have started. Check @${name}'s conversation, or send it again.`;
/** What the owner reads when the teammate stayed busy through every retry, so the hand-off was never sent. */
export const busyHandoffText = (name: string): string => `@${name} stayed busy, so this wasn't sent. Send again or dismiss it.`;
/** What the owner reads when a hand-off's start was cut short before the provider, again and again, so it was never sent. */
export const didNotStartText = (name: string): string => `This didn't start for @${name}. Send again or dismiss it.`;
/** The owner's line for a hand-off that was never sent, by the category it was held for. */
export const heldReasonText = (reason: HeldReason, name: string): string => reason === "busy" ? busyHandoffText(name) : didNotStartText(name);
/** What the owner reads when Send again finds the first hand-off was picked up after all. It is not sent a second time. */
export const alreadyPickedUpText = (name: string): string => `@${name} already picked this up. Check @${name}'s conversation for the reply. It was not sent again.`;

export interface HeldDelegation { id: string; sourceThreadId: string; toBotId: string; fromBotId: string | null; toBotName: string; text: string; reason?: HeldReason }
/** A start cut short before the provider, twice, is not tried a third time by itself: the hand-off is held for the owner (Send again or Dismiss), never deleted. */
const MAX_START_ATTEMPTS = 2;

/** What became of one started hand-off. */
export type SettledStart = "gone" | "waiting" | "receipted" | "interrupted" | "redispatched" | "fresh" | "held" | "alreadyHeld" | "unsettled";

/** The ONE per-row settling of a hand-off whose start did not finish: boot reconcile calls it for every started row, and the dispatch calls it when a start
 * fails while running. It decides by the ROW's state, never by an error's text:
 *  - never started (queued): nothing to settle, it waits ("waiting"), and a shared request that was dispatched goes back to queued with the refusal recorded;
 *  - its receipt exists: the turn ended, only the row's deletion was cut short: the row goes ("receipted");
 *  - the provider accepted the turn: it ran, maybe to the end: an "interrupted" receipt, the row goes, and it is NEVER run again ("interrupted");
 *  - it was handed to the provider and the target conversation shows output that follows this hand-off's prompt: treated as accepted ("interrupted");
 *  - it was handed to the provider and nothing shows it ran: it does NOT run again. The row is kept, held, and the owner decides ("held");
 *  - it was never handed to the provider: safe to run once more, reusing its prompt when the thread holds it; its room request or shared request goes
 *    back to queued so the dispatch that follows finds both records agreeing. A third cut-short start is not run by itself: it is held for the owner with the
 *    reason "didNotStart" ("held"). Work known not to have executed is never deleted. */
export function settleAfterFailure(id: string, botName?: (botId: string) => string | undefined): SettledStart {
  const db = database();
  const row = handoffRow(id);
  if (!row) return "gone";
  if (row.phase !== "started") {
    if (row.origin === "room" || row.origin === "shared") requeueRequest(db, id, "start_failed");
    return "waiting";
  }
  if (row.started_at === null) return "alreadyHeld";
  const name = botName?.(row.to_bot_id) ?? row.to_bot_id;
  const receipt = (result: Outbound, outcome: DelegationReceipt["status"] = "failed", reply?: OwedReply): void => { recordDelegationReceipt({ id: row.id, sourceThreadId: row.source_thread_id, toBotId: row.to_bot_id, toBotName: name, status: outcome, result, ...(reply ? { reply } : {}) }); };
  const turnKey = row.turn_key ?? delegationTurnKey(row.id);
  // a receipt whose settling did not commit leaves the row: "unsettled" (the receipt is kept and the next pass settles it), never counted as progress
  { const receipted = findDelegationReceipt(row.id); if (receipted) return settleReceipted(receipted) ? "receipted" : "unsettled"; }
  // the receipt carries the line the source conversation is owed, as a finished hand-off's does (handoff-boundary.ts finalizeDelegationWatch): the settle
  // writes it under the hand-off's stable id (replayOwedReply), so the owner reads "interrupted by a restart" where the reply would have been, and the
  // asker is woken on it; a receipt with only a status wrote nothing and woke nobody (1.0.3 lee-phantom d: a restart mid-delegation left the lead blank)
  const interrupted = (): SettledStart => {
    const restart = status("receipt_restart");
    receipt(restart, "failed", owedReplyOf({ ok: false, reply: "", targetName: name, failureName: outboundWords(restart), stopped: false }));
    return handoffRow(row.id) ? "unsettled" : "interrupted";
  };
  if (row.accepted_turn_id) return interrupted();
  if (row.submitted_at) {
    if (row.evidence_at !== null) return interrupted();
    // held first (one write); the owner's receipt and line follow in the notice pass, which a crash in between repeats at the next start
    return Number(db.prepare("UPDATE pending_delegations SET started_at=NULL, retry_at=NULL WHERE id=? AND phase='started' AND started_at IS NOT NULL").run(row.id).changes) === 1 ? (persistWrites++, "held") : "alreadyHeld";
  }
  const prompt = row.target_thread_id ? storedMessage(row.target_thread_id, turnKey) !== undefined : false;
  if (prompt && (row.start_attempts ?? 0) >= MAX_START_ATTEMPTS) {
    // known not to have executed (it was never handed to the provider): held for the owner, not deleted. The notice pass tells the owner.
    return holdUnexecuted(row.id, row.item, "didNotStart") ? "held" : "alreadyHeld";
  }
  const reset = db.prepare("UPDATE pending_delegations SET phase='fresh', started_at=NULL, retry_at=NULL, start_attempts=? WHERE id=? AND phase='started'").run(prompt ? row.start_attempts ?? 1 : null, row.id);
  if (Number(reset.changes) !== 1) return "alreadyHeld";
  persistWrites++;
  // both records agree again: the hand-off is waiting, so is its request (a room request the first start dispatched, shared work that was waiting on the owner)
  if (row.origin === "room" || row.origin === "shared") requeueRequest(db, row.id);
  return prompt ? "redispatched" : "fresh";
}

export interface SettleOptions {
  botName?: (botId: string) => string | undefined;
  /** settleStartedDelegations: closes the dispatch gate at once, then writes nothing until this resolves (the server's first health answer) */
  ready?: Promise<void>;
  /** the owner is told about a held hand-off: the line in the conversation it was made in (repeatable) */
  notice?: (held: HeldDelegation) => void;
  /** the store, so a held line's control is cleared in the same commit as its row (expiry, orphans) */
  store?: Pick<Store, "patchMessage">;
}
export interface SettleTotals { receipted: number; interrupted: number; redispatched: number; fresh: number; held: number }
const noTotals = (): SettleTotals => ({ receipted: 0, interrupted: 0, redispatched: 0, fresh: 0, held: 0 });
/** Rows one settling pass looks at before the event loop gets its turn. */
export const SETTLE_PAGE = DRAIN_PAGE;
const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** Where the boot settling has got to: the (started_at, rowid) of the last started row it looked at. */
type StartedCursor = { at: number; pos: number };
/** One page of started hand-offs after the cursor, each settled once. The cursor to go on from, or null when there are no more. A row whose settling fails is
 * passed over (it stays started, and the next start looks at it again): it never keeps the rows after it from being settled. */
function settleStartedPage(cursor: StartedCursor, totals: SettleTotals, options: SettleOptions): StartedCursor | null {
  const page = database().prepare(PENDING_SQL.startedAfter).all(cursor.at, cursor.pos) as unknown as Array<{ id: string; pos: number; started_at: number }>;
  if (!page.length) return null;
  for (const row of page) {
    try {
      const outcome = settleAfterFailure(row.id, options.botName);
      if (outcome === "receipted") totals.receipted++;
      else if (outcome === "interrupted") totals.interrupted++;
      else if (outcome === "redispatched") totals.redispatched++;
      else if (outcome === "fresh") totals.fresh++;
      else if (outcome === "held") totals.held++;
      else if (outcome === "alreadyHeld") { /* already counted by whoever held it */ }
    } catch (error) {
      if (isDatabaseBusy(error)) throw error; // a held lock: the page runs again (settlePage), the row is still started
      console.error("delegations: could not settle a started handoff at boot", error);
    }
  }
  const last = page[page.length - 1]!;
  return page.length < DRAIN_PAGE ? null : { at: Number(last.started_at), pos: Number(last.pos) };
}
const STARTED_FROM: StartedCursor = { at: -1, pos: 0 };

/** Boot, BEFORE any drain and before the room requests are reconciled: settles every handoff whose turn had started, by the row alone (settleAfterFailure).
 * The started rows are read through `pd_started` (normally none), ONE PAGE PER EVENT-LOOP PASS, then the held notices, then the orphan lines, each the same
 * way; the dispatch gate stays closed until the last page is done, so settling still comes before any drain. */
export async function settleStartedDelegations(options: SettleOptions = {}): Promise<SettleTotals> {
  const totals = noTotals();
  if (ownerRecordMigrationPending()) return totals;
  const release = holdForReconcile();
  try {
    await yieldToLoop();                      // the gate is closed across at least one pass of the event loop, even when there is nothing to settle
    // the server's first start: the gate is closed now, the writes wait for the first health answer (an empty listen tick, STALLS-FINAL-DESIGN 3.4)
    if (options.ready) await options.ready;
    // bounded: the cursor only moves forward over the started rows (pd_started), so each is looked at once per start, whatever its settling does
    // each page is retried, with the gate still closed, when it meets a held write lock (the server runs this under a background source, whose
    // writes give up after the background budget instead of holding the serving thread for the owner's 1 s)
    for (let cursor: StartedCursor | null = STARTED_FROM; cursor !== null;) { const from: StartedCursor = cursor; cursor = await settlePage(() => settleStartedPage(from, totals, options)); if (cursor !== null) await yieldToLoop(); }
    for (let after: string | null = ""; after !== null;) { const from: string = after; after = await settlePage(() => noticeHeldPage(from, options)); if (after !== null) await yieldToLoop(); }
    for (let top = await settlePage(sharedRequestsTop), after: number | null = 0; after !== null;) { const from: number = after; after = await settlePage(() => requeueUnstartedSharedRange(from, top)); if (after !== null) await yieldToLoop(); }
    for (let after: string | null = ""; after !== null;) { const from: string = after; after = await settlePage(() => sweepOrphanHeldPage(from, options)); if (after !== null) await yieldToLoop(); }
    await settlePage(deliverOwedReplies);
  } finally { release(); }
  return totals;
}
/** How many times one settling page meets a held lock before the settling gives up for this start. */
const SETTLE_BUSY_ATTEMPTS = 20;
/** One page of the boot settling; a held write lock (DatabaseBusyError, SQLITE_BUSY) waits for the writer gate and a growing pause, then the page
 * runs again (each page is idempotent: it reads its rows again). */
async function settlePage<T>(page: () => T): Promise<T> {
  for (let attempt = 1, pause = 100; ; attempt++, pause = Math.min(pause * 2, 2_000)) {
    try { return page(); }
    catch (error) {
      if (!isDatabaseBusy(error) || attempt >= SETTLE_BUSY_ATTEMPTS) throw error;
      await awaitWriterGate();
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, pause); timer.unref?.(); });
    }
  }
}
/** The same settling, every page at once. For tests and one-off tools; the server settles through settleStartedDelegations. */
export function reconcileStartedDelegations(options: SettleOptions = {}): SettleTotals {
  const totals = noTotals();
  if (ownerRecordMigrationPending()) return totals;
  for (let cursor: StartedCursor | null = STARTED_FROM; cursor !== null;) cursor = settleStartedPage(cursor, totals, options);
  for (let after: string | null = ""; after !== null;) after = noticeHeldPage(after, options);
  for (let top = sharedRequestsTop(), after: number | null = 0; after !== null;) after = requeueUnstartedSharedRange(after, top);
  for (let after: string | null = ""; after !== null;) after = sweepOrphanHeldPage(after, options);
  deliverOwedReplies();
  return totals;
}
/** Boot, after the started rows are settled: a receipt that still owes its source conversation a line but has no row left (an earlier build removed the row
 * without the line, or the process died between the final commit and the receipt file's rewrite) delivers it now, under the line's stable id, so a line
 * already there is not written twice. Its request ends with it if it had not. One that cannot be written stays owed for the next start. Returns how many. */
export function deliverOwedReplies(): number {
  let delivered = 0;
  for (const receipt of receipts.filter(owes)) {
    if (handoffRow(receipt.id)) continue;   // a row still there is settled by the started-row pass (settleAfterFailure), never here
    if (settleReceipted(receipt)) delivered++;
  }
  return delivered;
}
/** Shared work the first process dispatched but never started (it was waiting on the owner's approval, or had not reached its turn): its request is
 * running and its hand-off row was never stamped. Both go back to waiting, the request to queued, so it dispatches again. */
export const SHARED_REQUEUE_ROWS = 500;
const sharedRequestsTop = (): number => Number((database().prepare("SELECT COALESCE(MAX(rowid), 0) AS top FROM room_requests").get() as { top: number }).top);
/** One range of at most SHARED_REQUEUE_ROWS request rows after `after` (up to `top`, the highest row when the pass began): the cost of a pass follows the range and never
 * the number of requests that match. The cursor to go on from, or null when the last range is done. */
function requeueUnstartedSharedRange(after: number, top: number): number | null {
  if (after >= top) return null;
  const upper = Math.min(top, after + SHARED_REQUEUE_ROWS);
  database().prepare("UPDATE room_requests SET state='queued', dispatched_at=NULL, waiting_since=NULL WHERE rowid>? AND rowid<=? AND state IN ('running','waiting_owner') AND EXISTS (SELECT 1 FROM pending_delegations p WHERE p.id=room_requests.id AND p.origin='shared' AND p.phase<>'started')").run(after, upper);
  persistWrites++;
  return upper >= top ? null : upper;
}

/** The line a held hand-off's notice is written under (a stable id: written once, however many times the notice is repeated). */
export const heldLineId = (id: string): string => `held-${id}`.slice(0, 160);
/** The line the owner reads for a held hand-off, in the conversation it was made in, with Send again and Dismiss. Written once under a stable id (repeating the notice adds
 * nothing), and registered in the queue (`held_notice_lines`) in the SAME transaction as the line: both exist or neither does. */
export function appendHeldLine(store: Pick<Store, "botByThread" | "groupByThread" | "bot" | "appendMessage">, held: HeldDelegation): void {
  if (!store.botByThread(held.sourceThreadId) && !store.groupByThread(held.sourceThreadId)) return;
  const sender = held.fromBotId && store.groupByThread(held.sourceThreadId) ? store.bot(held.fromBotId) : undefined;
  store.appendMessage(held.sourceThreadId, murageLine({ role: "bot", kind: "activity", tool: { name: held.text, ok: false }, delegationHeld: { id: held.id },
    ...(sender ? { from: { botId: sender.id, name: sender.name, color: sender.color } } : {}) }), heldLineId(held.id), () => registerHeldLine(held));
}
/** Registers the owner-facing line of a held hand-off in the queue (`held_notice_lines`). Called as the line is written, by the line's own `within`, so the line and
 * its registration commit together or not at all. Idempotent. */
export function registerHeldLine(held: { id: string; sourceThreadId: string }): void {
  database().prepare("INSERT OR IGNORE INTO held_notice_lines(message_id, delegation_id, source_thread_id) VALUES(?,?,?)").run(heldLineId(held.id), held.id, held.sourceThreadId);
}
/** Releases a held hand-off: the row change, the control's removal from its line and the line's registration commit in ONE transaction (Store.patchMessage `within`),
 * so a crash leaves all or none; the in-memory patch and the broadcast follow the commit. A line that is already gone changes nothing else. Without a store the
 * control cannot be cleared here, so the registration stays: the orphan sweep clears the line later. */
export function releaseHeld<T>(store: Pick<Store, "patchMessage"> | undefined, held: { id: string; sourceThreadId: string }, change: () => T): T {
  if (!store) return transaction(() => change(), { op: "delegation-held-release" });
  let result!: T;
  store.patchMessage(held.sourceThreadId, heldLineId(held.id), { delegationHeld: undefined }, () => {
    result = change();
    database().prepare("DELETE FROM held_notice_lines WHERE message_id=?").run(heldLineId(held.id));
  });
  return result;
}
const removeHeldRow = (id: string): boolean => { deliverOwedBeforeRemoval(id); const changed = stmts().removeHeld.run(id); persistWrites++; return Number(changed.changes) === 1; };

/** The owner is told about every held hand-off: a receipt (the delegating bot reads it too) and a line in the conversation it was made in. Idempotent: the
 * receipt is replaced by id and the line has a stable id, so repeating it after a crash, or at every start while the row is held, adds nothing. A row held for
 * more than HELD_KEPT_MS is let go (its control cleared in the same commit). Found by the pd_held index, ONE page of 100 per call: the cursor to go on from,
 * or null when the last page is done. */
const HELD_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
function noticeHeldPage(after: string, options: SettleOptions): string | null {
  const now = Date.now();
  const page = stmts().heldPage.all(after) as unknown as Array<{ id: string; source_thread_id: string; to_bot_id: string; from_bot_id: string | null; submitted_at: number | null; item: string }>;
  if (!page.length) return null;
  for (const row of page) {
    try {
      if (row.submitted_at !== null && now - row.submitted_at > HELD_KEPT_MS) { releaseHeld(options.store, { id: row.id, sourceThreadId: row.source_thread_id }, () => removeHeldRow(row.id)); continue; }
      noticeHeldOne(row, options);
    } catch (error) { console.error("delegations: could not tell the owner about a held handoff", error); }
  }
  return page.length < 100 ? null : page[page.length - 1]!.id;
}
/** The receipt and the line for one held hand-off (repeatable). */
export function noticeHeldOne(row: { id: string; source_thread_id: string; to_bot_id: string; from_bot_id: string | null; item: string }, options: SettleOptions): void {
  const name = options.botName?.(row.to_bot_id) ?? row.to_bot_id;
  let reason: HeldReason | undefined;
  try { const held = (JSON.parse(row.item) as { heldReason?: unknown }).heldReason; if (held === "busy" || held === "didNotStart") reason = held; } catch { /* an unreadable payload reads as the restart notice */ }
  const text = reason ? heldReasonText(reason, name) : uncertainHandoffText(name);
  const heldStatus = status(reason === "busy" ? "receipt_held_busy" : reason ? "receipt_held_didnotstart" : "receipt_uncertain", { name: name as BotName });
  if (!findDelegationReceipt(row.id)) recordDelegationReceipt({ id: row.id, sourceThreadId: row.source_thread_id, toBotId: row.to_bot_id, toBotName: name, status: reason === "busy" ? "busy_gave_up" : "failed", result: heldStatus });
  options.notice?.({ id: row.id, sourceThreadId: row.source_thread_id, toBotId: row.to_bot_id, fromBotId: row.from_bot_id, toBotName: name, text, ...(reason ? { reason } : {}) });
}
/** Tells the owner about the one hand-off that was just held (the dispatch calls it when a start failed or a teammate stayed busy). */
export function announceHeld(id: string, options: SettleOptions): void {
  const row = database().prepare("SELECT id, source_thread_id, to_bot_id, from_bot_id, item FROM pending_delegations WHERE id=? AND phase='started' AND started_at IS NULL").get(id) as { id: string; source_thread_id: string; to_bot_id: string; from_bot_id: string | null; item: string } | undefined;
  if (row) noticeHeldOne(row, options);
}

// ── held lines whose row is gone ─────────────────────────────────────────────────────
/** One page (at most SWEEP_PAGE) of the registered held lines after `after`: a line whose hand-off is no longer held has its control cleared, and its registration goes
 * with it in the same commit. Only the registered lines are walked, so the cost follows the number of held hand-offs and never the size of any conversation. A line
 * that could not be cleared keeps its registration and is looked at again by the next pass. The cursor to go on from, or null when the last page is done. */
const SWEEP_PAGE = 100;
function sweepOrphanHeldPage(after: string, options: SettleOptions): string | null {
  const page = database().prepare("SELECT message_id, delegation_id, source_thread_id FROM held_notice_lines WHERE message_id>? ORDER BY message_id LIMIT ?").all(after, SWEEP_PAGE) as unknown as Array<{ message_id: string; delegation_id: string; source_thread_id: string }>;
  if (!page.length) return null;
  for (const line of page) {
    try {
      const row = handoffRow(line.delegation_id);
      if (row && row.phase === "started" && row.started_at === null) continue;       // still held: the control is right
      releaseHeld(options.store, { id: line.delegation_id, sourceThreadId: line.source_thread_id }, () => false);
    } catch (error) { console.error("delegations: could not clear a held line whose handoff is gone", error); }
  }
  return page.length < SWEEP_PAGE ? null : page[page.length - 1]!.message_id;
}

/** The owner's Send again on a held hand-off: it is queued as a NEW hand-off (new id, same payload), and the held one is removed in the same commit (with its
 * control). First it asks whether the original ran after all: an accepted turn, output that follows its prompt, or a run still going on the stored conversation.
 * If so nothing is sent again ("already_ran"), the held line is released and an interrupted receipt is written.
 * Returns the queue result with the new id; "not_held" when there is nothing to send again (already sent, dismissed or never held). */
export function resendHeldDelegation(bus: CommsBus, id: string): { result: QueueResult | "not_held" | "sender_gone" | "already_ran"; id?: string; toBotName?: string } {
  const db = database();
  const row = db.prepare("SELECT id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, target_thread_id, turn_key, accepted_turn_id, evidence_at FROM pending_delegations WHERE id=? AND phase='started' AND started_at IS NULL").get(id) as unknown as (StoredRow & { target_thread_id: string | null; turn_key: string | null; accepted_turn_id: string | null; evidence_at: number | null }) | undefined;
  if (!row) return { result: "not_held" };
  const parsed = itemOf({ ...row, phase: "fresh", retry_at: null } as StoredRow);
  if (!parsed) { removeHeldRow(id); return { result: "not_held" }; }
  const held = { id, sourceThreadId: row.source_thread_id };
  const name = bus.store.bot(row.to_bot_id)?.name ?? row.to_bot_id;
  // a hand-off held for being busy or for not starting was never handed to the provider: there is nothing it could have done. Any other held one asks first.
  if (parsed.heldReason === undefined && (row.accepted_turn_id || row.evidence_at !== null || (row.target_thread_id !== null && bus.handoffRunning?.(row.target_thread_id, id) === true))) {
    releaseHeld(bus.store, held, () => removeHeldRow(id));
    recordDelegationReceipt({ id, sourceThreadId: row.source_thread_id, toBotId: row.to_bot_id, toBotName: name, status: "failed", result: status("receipt_restart") });
    return { result: "already_ran", toBotName: name };
  }
  const from = (row.from_bot_id ? bus.store.bot(row.from_bot_id) : null) ?? bus.store.botByThread(row.source_thread_id);
  if (!from) return { result: "sender_gone" };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, attempts: _a, fromBotId: _f, waitingOnBusy: _w, waitingSince: _s, waitMessageId: _m, unknownTarget: _u, unknownRetryAt: _r, unknownAttempts: _n, unknownRecheck: _c, origin: _o, heldReason: _h, ...payload } = parsed;
  return transaction(() => {
    const queued = queueDelegation(bus, from, payload, payload.depth + 1, row.source_thread_id);
    if (queued.result === "ok") releaseHeld(bus.store, held, () => removeHeldRow(id));
    return queued;
  }, { op: "delegation-send-again" });
}

/** The owner's Dismiss on a held hand-off: the row goes with its control, in one commit; nothing runs. */
export function dismissHeldDelegation(id: string, store?: Pick<Store, "patchMessage">): boolean {
  const row = database().prepare("SELECT source_thread_id FROM pending_delegations WHERE id=? AND phase='started' AND started_at IS NULL").get(id) as { source_thread_id: string } | undefined;
  if (!row) return false;
  return releaseHeld(store, { id, sourceThreadId: row.source_thread_id }, () => removeHeldRow(id));
}

/** A started hand-off that is known NOT to have executed (its start was cut short before the provider took it) becomes held for the owner, with the reason kept.
 * Never deleted: the owner chooses Send again or Dismiss. */
function holdUnexecuted(id: string, rawItem: string, reason: HeldReason): boolean {
  let payload: Record<string, unknown> = {};
  try { const parsed = JSON.parse(rawItem); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>; } catch { /* an unreadable payload is held with just its reason */ }
  delete payload.waitingOnBusy;
  payload.heldReason = reason;
  const changed = database().prepare("UPDATE pending_delegations SET started_at=NULL, retry_at=NULL, submitted_at=COALESCE(submitted_at, ?), item=? WHERE id=? AND phase='started' AND started_at IS NOT NULL").run(Date.now(), JSON.stringify(payload), id);
  persistWrites++;
  return Number(changed.changes) === 1;
}

/** A hand-off that was never sent becomes held: the owner reads that it was not sent (the teammate stayed busy through every retry, or it did not start), and chooses
 * Send again or Dismiss. Never silent, and the reason keeps the category it happened in. */
export function holdBusyGaveUp(id: string, reason: HeldReason = "busy"): boolean {
  const queued = queuedItem(id);
  if (!queued) return false;
  const item: PendingDelegationItem = { ...queued.item, heldReason: reason };
  delete item.waitingOnBusy;
  const changed = database().prepare("UPDATE pending_delegations SET phase='started', started_at=NULL, retry_at=NULL, submitted_at=COALESCE(submitted_at, ?), item=? WHERE id=? AND phase<>'started'").run(Date.now(), itemJson(item), id);
  persistWrites++;
  recheckIds.delete(id);
  return Number(changed.changes) === 1;
}

/** The late acceptance of a hand-off that was already held (the provider took it after the failure that held it): it ran after all. The line is released with
 * the row, in one commit, and the receipt says it was interrupted. */
export function settleLateAcceptance(bus: CommsBus | undefined, id: string): void {
  const row = database().prepare("SELECT source_thread_id, to_bot_id FROM pending_delegations WHERE id=? AND phase='started' AND started_at IS NULL").get(id) as { source_thread_id: string; to_bot_id: string } | undefined;
  if (!row) return;
  releaseHeld(bus?.store, { id, sourceThreadId: row.source_thread_id }, () => removeHeldRow(id));
  recordDelegationReceipt({ id, sourceThreadId: row.source_thread_id, toBotId: row.to_bot_id, toBotName: bus?.store.bot(row.to_bot_id)?.name ?? row.to_bot_id, status: "failed", result: status("receipt_restart") });
}

/** Drop queued handoffs without running them, telling the user they were
 * dropped. Used when the queueing turn failed or was interrupted.
 *
 * `fromBotId` scopes the discard to one sender, and on a room thread that is
 * the only correct behaviour: a room queue holds items from every bot that
 * has spoken there, so a thread-wide discard means Nia hitting Stop silently
 * cancels the handoff Ember queued minutes ago, with a receipt blaming "the
 * delegating turn did not finish" about a turn that finished fine. A bot's
 * own thread has exactly one sender, so passing its id there is a no-op that
 * keeps the two call sites honest about which turn they are cancelling.
 * Omitting it keeps the old thread-wide behaviour for callers that mean it. */
export function discardDelegations(bus: CommsBus, threadId: string, fromBotId?: string): void {
  const all = queuedItems(threadId);
  if (!all.length) return;
  const owns = (item: PendingDelegationItem) => {
    // An item that has already outlived a turn - retried, or parked waiting
    // for a busy target - cannot belong to the turn that just failed, so no
    // interruption may drop it. This is what protects a room: Ember queues a
    // handoff, Rex is busy, it parks; Nia speaks in the same room and hits
    // Stop, and Ember's handoff is not collateral.
    if (item.attempts > 0 || item.waitingOnBusy || item.unknownTarget || (item.unknownAttempts ?? 0) > 0) return false;
    // An item queued before `fromBotId` existed names nobody; on a
    // single-sender thread it is still this sender's, so it is dropped.
    return !fromBotId || !item.fromBotId || item.fromBotId === fromBotId;
  };
  const list = all.filter(owns);
  if (!list.length) return;
  // A failed delete drops nothing and reports nothing: the rows are still runnable, so no "dropped" receipt or chip may claim otherwise.
  try { transaction(() => { for (const item of list) { persistWrites++; settleHandoffPair(item.id, { state: "cancelled", note: "the delegating turn did not finish" }); } }, { op: "delegation-discard" }); }
  catch (error) { console.error("delegations: could not drop the handoffs of an unfinished turn", error); return; }
  for (const item of list) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId: threadId,
      toBotId: item.toBotId,
      toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
      status: "dropped",
      result: status("receipt_turn_unfinished"),
    });
  }
  // The chip lands in the source conversation, which is a bot's own thread
  // OR a room it spoke in - botByThread alone silenced the room case.
  if (!bus.store.botByThread(threadId) && !bus.store.groupByThread(threadId)) return;
  appendDelegationRow(bus, threadId, fromBotId ?? list[0]?.fromBotId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped: the turn did not finish`, ok: false },
  });
}

/** The source conversation still belongs to the sender: its own task thread,
 * or a room it is still a member of. Mirrors index.ts's `connectorThread`;
 * without the group arm a room-sourced handoff can never clear this check. */
export function sourceStillOwned(bus: CommsBus, botId: string, threadId: string): boolean {
  if (bus.store.taskByThread(botId, threadId)) return true;
  const group = bus.store.groupByThread(threadId);
  return Boolean(group?.memberIds.includes(botId));
}

/** The roster is an execution boundary, not just sidebar styling. A queued
 * handoff may wait through a turn, a busy target, or human approval, so the
 * permission granted when it was queued must be checked again at the final
 * dispatch edge. The chip text still says "sections" because that is what
 * separates two ordinary bots; the only extra edges canReach adds are
 * workspace-chief ⇄ section lead. Pure: the receipt and chip of a refusal are written by whoever acts on it. */
export function unreachableVerdict(
  bus: CommsBus,
  sender: BotRecord,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
): { result: Outbound; chip: string } | null {
  // the same reach the handoff was queued under (message-allow.ts)
  // project reach only for a handoff the owner's audience queued
  const row = handoffRequest(database(), item.id);   // none for a handoff the owner's conversation queued: it is checked as a peer message (an earlier build's stand-in record is not a request)
  const targetThread = row ? row.targetThreadId ?? audienceTask(bus.store, target, threadHumanPrincipal(sourceThreadId), item.executionAudience ?? null)?.threadId : undefined;
  const allowed = row && targetThread
    ? authorizeWork({ edge: "dispatch", requestId: row.id, targetBotId: target.id, targetThreadId: targetThread, tag: item.executionAudience ?? null, kind: "delegation" })
    : authorizeWork({ edge: "peer", requesterBotId: sender.id, requesterThreadId: sourceThreadId, targetBotId: target.id, verb: "delegate", tag: item.executionAudience ?? null, ownerAudience: !item.notOwnerAudience, unattended: item.unattended === true });
  if (allowed.ok || allowed.retry === "queue") return null;
  return { result: status("receipt_other_section", { from: sender.name as BotName, to: target.name as BotName }), chip: `Delegation to @${target.name} canceled: bots now belong to different sections` };
}
/** Receipts and tells the sender that a hand-off was dropped because the roster no longer lets it reach. */
export function dropForRoster(bus: CommsBus, target: BotRecord, sourceThreadId: string, item: PendingDelegationItem, verdict: { result: Outbound; chip: string }): void {
  recordDelegationReceipt({ id: item.id, sourceThreadId, toBotId: target.id, toBotName: target.name, status: "dropped", result: verdict.result });
  appendDelegationRow(bus, sourceThreadId, item.fromBotId, { role: "bot", kind: "activity", tool: { name: verdict.chip, ok: false } });
}
function dropIfUnreachable(bus: CommsBus, sender: BotRecord, target: BotRecord, sourceThreadId: string, item: PendingDelegationItem): boolean {
  const verdict = unreachableVerdict(bus, sender, target, sourceThreadId, item);
  if (!verdict) return false;
  dropForRoster(bus, target, sourceThreadId, item, verdict);
  return true;
}

/** Re-check every queued handoff against the roster as it is now.
 *
 * The dispatch edge already re-checks (dropIfUnreachable above), but only
 * when the source turn settles or a busy target frees up, which can be long
 * after the owner moved a bot out of a team. Called right after an owner's
 * team change so a handoff the change made unreachable is dropped at once,
 * with the same receipt and chip as the dispatch-time drop. Items whose
 * sender or target no longer exist are left for the drain, which already
 * reports those. Returns how many were dropped. */
export const UNREACHABLE_PAGE = 500;
let unreachableSweep: Promise<number> | undefined;
let unreachableAgain = false;
export function dropUnreachableDelegations(bus: CommsBus): Promise<number> {
  // a change that arrives while a sweep runs asks for one more pass after it, so the roster it saw is never stale
  if (unreachableSweep) { unreachableAgain = true; return unreachableSweep; }
  unreachableSweep = (async () => {
    let dropped = 0;
    try {
      do {
        unreachableAgain = false;
        const db = database();
        const page = db.prepare(`SELECT rowid AS rid, ${COLUMNS} FROM pending_delegations WHERE rowid>? ORDER BY rowid LIMIT ${UNREACHABLE_PAGE}`);
        for (let cursor = 0;;) {
          const rows = page.all(cursor) as unknown as Array<StoredRow & { rid: number }>;
          if (!rows.length) break;
          cursor = rows[rows.length - 1]!.rid;
          for (const row of rows) {
            if (drainingThreads.has(row.source_thread_id)) continue;
            const item = readable(row);
            if (!item) continue;
            const sender = (item.fromBotId ? bus.store.bot(item.fromBotId) : null) ?? bus.store.botByThread(row.source_thread_id);
            const target = bus.store.bot(item.toBotId);
            if (!sender || !target) continue;
            if (!dropIfUnreachable(bus, sender, target, row.source_thread_id, item)) continue;
            if (!removeItem(item.id)) continue;
            clearWaitLine(bus, row.source_thread_id, item);
            dropped += 1;
          }
          // the event loop is free between pages
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } while (unreachableAgain);
    } finally { unreachableSweep = undefined; }
    return dropped;
  })();
  return unreachableSweep;
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return queuedCount(threadId);
}

/** Test helper: an empty queue and no in-memory state (a clean slate between tests). */
export function _resetPending(): void {
  try { const db = database(); endAllLivePairedRequests(db, "reset"); db.prepare("DELETE FROM pending_delegations").run(); db.prepare("DELETE FROM pending_delegations_import").run(); } catch { /* no database yet: nothing queued */ }
  _simulateRestart();
}
/** Test helper: forget what only a running process knows (draining threads, redrain requests, receipts) while the queued rows stay, as a restart does. */
export function _simulateRestart(): void {
  drainingThreads.clear();
  sharedCursor.clear();
  stranded.clear();
  queuedRedrains.clear();
  busyCursor.clear();
  idleCursor.clear();
  unreachableSweep = undefined; unreachableAgain = false;
  recheckIds.clear();
  _forgetInFlight();
  receipts = [];
}

// ── live status for a running delegated turn ──────────────────────────
// check_delegation used to say only queued/running/finished. A chief that
// coordinates specialists needs to see whether a long-running peer is
// actually progressing, so the harness summarizes what the peer's thread
// has done since the delegated turn started.

export function formatDelegationElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1_000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Recent, bounded activity from the peer's thread since the delegated
 * turn started - newest last. Empty means the peer has produced nothing
 * visible since dispatch, which reads as "maybe stuck" to the caller. */
/** One row of a delegated turn's conversation after the result gate: the words of each field it would render, released together (server/result-egress.ts
 * `releaseMessage`), or no row at all. */
export interface ReleasedActivityRow { at: number; kind: "text" | "activity"; text?: ReleasedText; tool?: ReleasedText; failure?: { kind: "retrying" | "error"; code: FailureCode } }

export function summarizeDelegatedActivity(
  rows: readonly ReleasedActivityRow[],
  startedAtMs: number,
  limit = 5,
  /** false: tool lines only, no excerpt of what the peer wrote */
  withText = true,
): MurageStatus[] {
  const lines: MurageStatus[] = [];
  for (const row of rows) {
    if (row.at < startedAtMs) continue;
    if (row.failure) lines.push(status(row.failure.kind === "retrying" ? "activity_retrying" : "activity_error", { code: row.failure.code }));
    else if (row.kind === "activity" && row.tool) lines.push(status("activity_name", { name: row.tool }));
    else if (withText && row.kind === "text" && row.text) lines.push(status("activity_text", { text: row.text }));
  }
  return lines.slice(-limit);
}
