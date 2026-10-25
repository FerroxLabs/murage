// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE one place a queued hand-off is admitted, waited on, started or settled.
//
// Every way a hand-off can begin ends here: the drain that follows the sender's turn (delegations.ts drainDelegations), the shared drain for a hand-off that
// is shared work (shared-work.ts drainSharedWork), the boot redispatch, the idle and timed release of a hand-off that waited, and Send again. They call
// `dispatchHandoff(id)` and keep no admission, destination or failure rule of their own, so a rule fixed here holds for all of them. That is a property of
// the code, not a convention: the hand-off's prompt is written, and its row stamped started, by a ticket that only this module can make, and the transcript
// store refuses a hand-off's prompt id unless the same transaction moved the hand-off's row to started (handoff-stamp.ts). `handoff-dispatch.structure.test.ts` reads the sources
// and fails if any other code starts a hand-off.
//
//   gate     one gate, closed while the owner-record migration is pending OR the boot settling is still paging: nothing is admitted, the row is untouched.
//   admit    one synchronous decision from the row's own state: start | wait | cancel | settled | gaveUp.
//   dispatch admit, the origin's pre-steps (the peer approval, or the shared request's dispatch and owner approval), admit AGAIN after every wait, then the
//            start on the STORED destination with the ticket.
//   failure  decided by the row's state, never by an error's text (delegations.ts settleAfterFailure): a start that never began waits, it is not ended.
import { database, transaction } from "./database.ts";
import { startFailureCodeFrom, type StartFailureCode } from "./failure-code.ts";
import { MurageStatus, cancelledEnding, status, type Outbound } from "./murage-status.ts";
import { DRAFT_ONLY_HANDOFF_REFUSAL } from "./draft-only.ts";
const isDeletedEnding = (result: Outbound): boolean => MurageStatus.is(result) && result.key === "receipt_deleted";
import { recordRefusedStart } from "./refused-start.ts";
import { claimMinter, isLiveTicket } from "./handoff-capability.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus, type QueuedSource } from "./comms-visibility.ts";
import { peerApprovalFailure, requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import { botDeleted, ownerDeletedThread } from "./owner-deletions.ts";
import { delegationAdmissionHeld, delegationTurnKey } from "./pending-delegations-schema.ts";
import { askerEnded, CANCELLED_WITH_ASKER, enterOwnerWait, isTerminalRoomRequestState, leaveOwnerWait, handoffRequest, markRequestDispatched, type RoomRequest } from "./room-requests.ts";
import { admitShared, cancelDeletedSharedRequest, drainSharedWork, isSharedWorkRow, settleShared, sharedClock, sharedDrainOpen, sharedRequestDeleted, sharedRequestIsNext, sharedResolution, type SharedVerdict } from "./shared-work.ts";
import type { AdmissionClaim, ExecutionAudience } from "./work-admission.ts";
import type { RoutinePeerSource } from "./routine-permissions.ts";
import type { CoordinationTrace } from "./coordination-budget.ts";
import type { BotRecord, Message } from "./store.ts";
import {
  DELEGATION_DELETED, DELEGATION_NOT_STARTABLE, DELETED_NOTE, MAX_BUSY_ATTEMPTS, acknowledgeDelegation, announceHeld, appendDelegationRow, cancelForDeletion, clearWaitLine,
  appendHandoffClosingLine, requestEndedForHandoff, coded, keepRealOutcome, countPersistWrite, DELEGATION_REQUEST_ENDED, deletionOf, dropForRoster, findDelegationReceipt, settleReceipted, handoffRow, holdBusyGaveUp, handoffItem, parkForRetry, parkUnresolvedIfDue, parkWaiting, queuedHandoff, recordDelegationReceipt,
  saveHandoffItem, settleAfterFailure, settleLateAcceptance, sourceStillOwned, storeHandoffDestination, unmigratedOwnerRecordRan, unreachableVerdict,
  type DelegationOrigin, type DelegationReceipt, type HandoffRow, type HeldDelegation, type HeldReason, type PendingDelegationItem, type SettleOptions,
} from "./delegations.ts";

// ── what the host (the server) lends the dispatch ────────────────────────────────────

/** What a started hand-off's turn records: the owner of its request side, and the room request it dispatched (if any). */
export interface StartStamp { origin: DelegationOrigin; groupId?: string; returnThreadId?: string | null }

/** The run a hand-off's turn carries. It is handed to `startTurn` by `dispatchHandoff` and by nothing else; `startTurn` only calls its methods. */
export interface HandoffRun {
  readonly id: string;
  /** the id of the prompt message in the target conversation */
  readonly turnKey: string;
  /** The held re-dispatch: the prompt is already in the conversation, so only the row is stamped. */
  start(threadId: string, options?: { held?: boolean }): StartStamp;
  /** The function to pass `appendMessage` as its `within`: the prompt and the row's start commit together. */
  within(threadId: string, onStamped: (stamp: StartStamp) => void): (message: Message) => void;
  /** committed immediately BEFORE the provider is handed the turn */
  submitted(): void;
  /** the provider took the turn */
  accepted(turnId: string): void;
}

/** The options a hand-off's turn is started with. The dispatch builds them; the host's startTurn accepts them. */
export interface HandoffTurnOptions {
  threadId: string;
  commsDepth: number;
  delegationRun: HandoffRun;
  onDispatchError: (message: string, error?: unknown) => void;
  [option: string]: unknown;
}

/** The live watch of a delegated turn (index.ts delegationWatch): who is told when the target's turn ends. */
export interface HandoffWatch {
  channelId?: string; toBotId: string; toBotName?: string; taskId: string; sourceThreadId: string; startedAtMs: number; requestId?: string; notOwnerAudience?: boolean;
}

/** What a shared hand-off's turn needs from the host: the completion bookkeeping of its request, built just before the turn starts. */
export interface SharedRun {
  /** passed to startTurn as `sharedWorkRun` */
  sharedWorkRun: unknown;
  /** ends the request (failed, with the note) through the guarded completion */
  finish(event: undefined, ended: { ending: MurageStatus; diagnostic?: string }): void;
  /** the turn did not start: stop watching and give the arbiter's claim back, the request is not ended */
  abandon(): void;
}

export interface HandoffHost {
  /** THE startTurn. Only this module hands it a hand-off's run. */
  startTurn(botId: string, text: string, options: HandoffTurnOptions): Promise<unknown>;
  /** Where a hand-off with no stored destination runs (resolved once, then stored). May throw: not now. */
  destinationFor(plan: { toBotId: string; sourceThreadId: string; fromBotId?: string; executionAudience?: ExecutionAudience }): string | undefined;
  /** The coordination slot a hand-off holds while its turn runs. Throws when there is none. */
  reserveSlot(threadId: string): () => void;
  watch: { begin(threadId: string, info: HandoffWatch): void; end(threadId: string): void };
  /** the routine authority and unattended state a peer's turn inherits from the sender */
  peerOptions(target: BotRecord | undefined, sourceThreadId: string, fromBotId: string, queued?: RoutinePeerSource): Record<string, unknown>;
  isUnattended(threadId: string): boolean;
  /** the owner's line for a held hand-off (Send again / Dismiss) */
  noticeHeld(held: HeldDelegation): void;
  /** A queued hand-off whose start failed before the engine was handed the turn: the "could not start" chip in the conversation it was made in (the delegating
   * bot reads it there), and the line in the pair channel. Called on every such failure, whatever the origin or path (the queue, the FIFO head, the ready set):
   * the server writes the chip under a stable id per hand-off, so a retry that fails again adds nothing. */
  couldNotStart?(info: CouldNotStart): void;
  /** the shared origin (shared work that a hand-off stands for) */
  shared?: {
    begin(request: RoomRequest, claim: AdmissionClaim | undefined): SharedRun;
    needsApproval(request: RoomRequest): boolean;
    requestApproval(request: RoomRequest): Promise<"allow" | "deny" | "expired" | "cancelled">;
    /** `queued`: the hand-off's source row, written when it was queued (comms-visibility.ts mirrorExchange) */
    mirror(request: RoomRequest, queued?: QueuedSource): void;
    /** the turn options of a shared request: its chain, audience, routine ceiling */
    turnOptions(request: RoomRequest): Record<string, unknown>;
    text(request: RoomRequest): string;
  };
}

/** `why` is the start's own error text (it stays with the owner); `code` is the reason the could-not-start line names. */
export interface CouldNotStart { id: string; sourceThreadId: string; fromBotId: string | undefined; toBotId: string; why: string; code: StartFailureCode; shared: boolean; executionAudience?: ExecutionAudience }

export interface HandoffEnv { bus: CommsBus; approvalBus: ApprovalBus }
let host: HandoffHost | undefined;
let defaults: HandoffEnv | undefined;
/** Attaches the server (or a test's fake): its startTurn and the few things only it knows. */
export function configureHandoffDispatch(next: HandoffHost | undefined, env?: HandoffEnv): void { host = next; defaults = env ?? defaults; }
/** Attaches the shared origin (the server's side of a hand-off that is shared work). */
export function configureSharedHandoffs(shared: HandoffHost["shared"]): void { sharedHost = shared; }
let sharedHost: HandoffHost["shared"];
export function _resetHandoffDispatch(): void { host = undefined; defaults = undefined; sharedHost = undefined; inFlight.clear(); }
const hostOrThrow = (): HandoffHost => { if (!host) throw new Error("HANDOFF_DISPATCH_NOT_CONFIGURED"); return host; };

// ── the runtime proof that only this module starts a hand-off ────────────────────────

/** Checked by the server's startTurn at its first line (and by the plain shared starter), whoever called, so a start that skirts the dispatch is refused here at run
 * time and the static analysis (handoff-dispatch.structure.test.ts) is only a lint:
 *  - a hand-off's run must be a ticket this module made and has not cleared (a lookalike, a copy or a cleared ticket is refused);
 *  - a ticket whose hand-off already started may only run again with its own stored prompt as the turn's message (the memory re-dispatch of the same turn), by
 *    VALUE: how the option is spelled or in what order it is spread changes nothing;
 *  - a shared request that has a hand-off row is the hand-off's: it is never started as a plain shared request, whatever its key is spelled like. */
export function assertHandoffStartable(opts: { delegationRun?: HandoffRun; threadId?: string; userMessage?: Pick<Message, "id">; sharedWorkRun?: { request: Pick<RoomRequest, "id"> } } | undefined): void {
  const refuse = (why: string) => coded(DELEGATION_NOT_STARTABLE, why);
  const run = opts?.delegationRun;
  if (run !== undefined) {
    if (!isLiveTicket(run)) throw refuse("this handoff was not dispatched, or its dispatch ended");
    // the CURRENT row decides: a finished or removed hand-off has none, and the conversation it runs in is the one the row stores, nothing else
    const row = handoffRow(run.id);
    if (!row) throw refuse("this handoff is gone or finished");
    if (row.target_thread_id === null || row.target_thread_id !== (run as { destination?: string }).destination || opts?.threadId !== row.target_thread_id) throw refuse("this handoff is stored for another conversation");
    if (row.phase === "started" && opts?.userMessage?.id !== run.turnKey) throw refuse("this handoff already started");
    return;
  }
  if (opts?.sharedWorkRun && handoffRow(opts.sharedWorkRun.request.id)) throw refuse("this request is a handoff's: it starts through the handoff dispatch");
}

// ── the gate ────────────────────────────────────────────────────────────────────────

/** True while nothing may be admitted: the clean-up of the old stand-in records has not succeeded, or the boot settling of the started rows is still paging
 * (a stand-in that is still running, or a row not yet settled, means a hand-off may already have run). */
export function gateClosed(): boolean { return delegationAdmissionHeld(); }

// ── the ticket: the only thing that can start a hand-off ─────────────────────────────

/** The dispatcher claims the minter once, here, at load: no other module can obtain one (handoff-capability.ts). */
const minter = claimMinter();
const dispatchToken = minter.dispatchToken();
export { isLiveTicket };
class DispatchTicket implements HandoffRun {
  readonly id: string;
  readonly destination: string;
  readonly turnKey: string;
  constructor(id: string, destination: string) { this.id = id; this.destination = destination; this.turnKey = delegationTurnKey(id); minter.admit(this); }
  start(threadId: string, options: { held?: boolean } = {}): StartStamp { return startDelegation(this, threadId, options); }
  within(threadId: string, onStamped: (stamp: StartStamp) => void): (message: Message) => void {
    return (_message: Message) => { onStamped(startDelegation(this, threadId)); };
  }
  submitted(): void { markDelegationSubmitted(this); }
  accepted(turnId: string): void { markDelegationAccepted(this, turnId); }
}
/** A ticket cleared on a dispatch error can no longer start anything; recording that the provider took (or was handed) the turn still works. */
const revoke = (ticket: DispatchTicket): void => { minter.revoke(ticket); };

/** The start of a hand-off's turn, written in the SAME transaction as the turn's prompt message (the ticket's `within` is the append's): either both commit or
 * neither does, so there is no state in which a start is recorded without its prompt (the old window that re-ran or dropped work) and no second start can add a
 * second prompt: the key is the primary key.
 *  - a ticket this module made and has not cleared, for the conversation the row stores as its destination, and nothing else;
 *  - the row must not be started yet (exactly one row changes), and the owner's recorded deletions are checked again in this transaction;
 *  - a room request of the same id is marked running here too, so the two records can never disagree; shared work is already running (its request is
 *    dispatched before its approval wait) and is only checked here;
 *  - nothing starts while the gate is closed, or while an earlier build's record still says the hand-off ran.
 * `held` is the single re-dispatch after a restart: the prompt is already in the thread and the row was reset by settleAfterFailure, which counted the earlier attempt. */
function startDelegation(ticket: DispatchTicket, targetThreadId: string, options: { held?: boolean; now?: number } = {}): StartStamp {
  if (!isLiveTicket(ticket)) throw coded(DELEGATION_NOT_STARTABLE, "this handoff was not dispatched, or its dispatch ended");
  const id = ticket.id;
  const db = database();
  if (gateClosed()) throw coded(DELEGATION_NOT_STARTABLE, "hand-offs wait until the start-up clean-up has finished");
  const row = db.prepare("SELECT source_thread_id, to_bot_id, from_bot_id, origin, phase, start_attempts, target_thread_id FROM pending_delegations WHERE id=?").get(id) as
    { source_thread_id: string; to_bot_id: string; from_bot_id: string | null; origin: DelegationOrigin; phase: string; start_attempts: number | null; target_thread_id: string | null } | undefined;
  if (!row || row.phase === "started") throw coded(DELEGATION_NOT_STARTABLE, "this handoff already started or is gone");
  if (row.target_thread_id !== targetThreadId || ticket.destination !== targetThreadId) throw coded(DELEGATION_NOT_STARTABLE, "this handoff is stored for another conversation");
  if (unmigratedOwnerRecordRan(db, id)) throw coded(DELEGATION_NOT_STARTABLE, "an earlier build's record says this handoff already ran");
  if (options.held && !(row.start_attempts && row.start_attempts > 0)) throw coded(DELEGATION_NOT_STARTABLE, "this handoff has no earlier start to resume");
  if (deletionOf(row.source_thread_id, row.from_bot_id, row.to_bot_id)) throw coded(DELEGATION_DELETED, DELETED_NOTE);
  const now = options.now ?? Date.now();
  const changed = db.prepare("UPDATE pending_delegations SET phase='started', started_at=?, target_thread_id=?, retry_at=NULL, start_attempts=COALESCE(start_attempts,0)+1 WHERE id=? AND phase<>'started'").run(now, targetThreadId, id);
  if (Number(changed.changes) !== 1) throw coded(DELEGATION_NOT_STARTABLE, "this handoff already started");
  countPersistWrite();
  let groupId: string | undefined, returnThreadId: string | null | undefined;
  if (row.origin === "room") {
    const request = handoffRequest(db, id);
    if (!request || isTerminalRoomRequestState(request.state)) throw coded(DELEGATION_NOT_STARTABLE, "the room request of this handoff ended");
    if (!markRequestDispatched(db, id, { now, targetThreadId }, dispatchToken) && handoffRequest(db, id)?.state !== "running") throw coded(DELEGATION_NOT_STARTABLE, "the room request of this handoff is not waiting");
    groupId = request.groupId; returnThreadId = request.returnThreadId;
  } else if (row.origin === "shared") {
    const request = handoffRequest(db, id);
    if (!request || (request.state !== "running" && request.state !== "waiting_owner")) throw coded(DELEGATION_NOT_STARTABLE, "the shared request of this handoff is not running");
  }
  return { origin: row.origin, ...(groupId !== undefined ? { groupId, returnThreadId } : {}) };
}

/** Written and committed immediately BEFORE the provider is handed the turn. From here a restart cannot know whether the provider took it, so it never runs
 * again by itself. Throws when it cannot be recorded: the turn is then not submitted. */
function markDelegationSubmitted(ticket: DispatchTicket): void {
  transaction(() => {
    assertRequestStillAsking(ticket.id, "submitted");
    const changed = database().prepare("UPDATE pending_delegations SET submitted_at=COALESCE(submitted_at, ?) WHERE id=? AND phase='started'").run(Date.now(), ticket.id);
    countPersistWrite();
    if (Number(changed.changes) !== 1) throw coded(DELEGATION_NOT_STARTABLE, "this handoff is not started, so it is not submitted");
  }, { op: "handoff-submitted" });
}

/** CANCEL-TREE-104 R2: the hand-over (submitted, accepted) is refused, and nothing written, unless the hand-off's request is still the one asking: a room
 * request must be `running`, a shared one `running` or `waiting_owner`; a request that ended, or is gone, refuses with DELEGATION_REQUEST_ENDED (the host's
 * quiet cancelled path), any other state with DELEGATION_NOT_STARTABLE. A direct hand-off (no request) is decided by its row alone. Inside the caller's transaction. */
function assertRequestStillAsking(id: string, step: "submitted" | "accepted"): void {
  const row = handoffRow(id);
  if (!row || (row.origin !== "room" && row.origin !== "shared")) return;
  const request = handoffRequest(database(), id);
  if (!request || isTerminalRoomRequestState(request.state)) throw coded(DELEGATION_REQUEST_ENDED, `the request that asked ended before the handoff was ${step}`);
  const asking = row.origin === "room" ? request.state === "running" : request.state === "running" || request.state === "waiting_owner";
  if (!asking) throw coded(DELEGATION_NOT_STARTABLE, `the request of this handoff is not running, so it is not ${step}`);
}

/** The provider took the turn: from here a restart never runs it again (it reports it interrupted). The write is tried three times and a failure is thrown to the
 * caller, never swallowed. If the hand-off had already been held for the owner (the failure that held it came first and the provider took it after all), the
 * held line is released with its row and the receipt says it was interrupted: it ran. */
function markDelegationAccepted(ticket: DispatchTicket, turnId: string): void {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const db = database();
      const row = transaction(() => {
        assertRequestStillAsking(ticket.id, "accepted");
        const changed = db.prepare("UPDATE pending_delegations SET accepted_turn_id=?, submitted_at=COALESCE(submitted_at, ?) WHERE id=? AND phase='started'").run(turnId, Date.now(), ticket.id);
        countPersistWrite();
        if (Number(changed.changes) !== 1) throw coded(DELEGATION_NOT_STARTABLE, "this handoff is not started, so it is not accepted");
        return db.prepare("SELECT started_at FROM pending_delegations WHERE id=? AND phase='started'").get(ticket.id) as { started_at: number | null } | undefined;
      }, { op: "handoff-accepted" });
      if (row && row.started_at === null) settleLateAcceptance((defaults ?? undefined)?.bus, ticket.id);
      return;
    } catch (error) { failure = error; const code = (error as { code?: string })?.code; if (code === DELEGATION_REQUEST_ENDED || code === DELEGATION_NOT_STARTABLE) throw error; }
  }
  console.error("delegations: could not record that a handoff's turn was accepted", failure);
  throw failure;
}

// ── admit ────────────────────────────────────────────────────────────────────────────

export type WaitReason = "gate" | "busy" | "capacity" | "refused" | "order" | "unresolved-sender" | "unresolved-target" | "unreadable";

export interface StartContext {
  id: string;
  row: HandoffRow;
  item: PendingDelegationItem;
  sender: BotRecord;
  target: BotRecord;
  /** the conversation the hand-off runs in: the stored one */
  destination: string;
  /** the shared request this hand-off stands for (shared origin) */
  request: RoomRequest | null;
  shared: boolean;
  claim?: AdmissionClaim;
}

export type Verdict =
  | { kind: "start"; ctx: StartContext }
  | { kind: "wait"; reason: WaitReason; ctx?: Pick<StartContext, "row" | "item" | "target" | "shared"> }
  | { kind: "cancel"; receipt: { status: DelegationReceipt["status"]; result: Outbound }; chip?: string; quiet?: boolean; roster?: { target: BotRecord; item: PendingDelegationItem; verdict: { result: Outbound; chip: string } }; request?: RoomRequest | null; sharedVerdict?: SharedVerdict }
  | { kind: "settled"; why: "gone" | "started" | "ended" }
  | { kind: "gaveUp"; ctx: Pick<StartContext, "row" | "item" | "target"> };

export interface AdmitOptions {
  /** only ask: no claim is taken, nothing is stored (the idle and timed releases ask this of each waiting hand-off) */
  probe?: boolean;
  /** the capacity this dispatch already holds, when it asks again after a wait */
  claim?: AdmissionClaim;
  /** asked again after an await: the source conversation must still belong to the sender */
  afterWait?: boolean;
  /** asked by an owner's drain: shared work starts from here only when it is the next request in the shared fair order (otherwise the shared drain, which walks that order, starts it) */
  ordered?: boolean;
}

/** The ONE decision about a hand-off, from the row's own state and the registry, synchronous, in this order:
 *  1. the gate;                          2. the row is missing or already started: settled;
 *  3. the owner's recorded deletions (source conversation, sender, target): cancelled;
 *  4. the sender and the target resolve (an unresolved one waits, parked);
 *  5. the origin's gate: an ended room request cancels; shared work goes through its own arbiter (deadline, team boundary, capacity, admission); the rest
 *     are checked against the roster they were queued under;
 *  6. the destination: the stored one, resolved once and stored when there is none;
 *  7. busy / capacity on THAT stored destination: wait, and past MAX_BUSY_ATTEMPTS: gaveUp (the owner decides, never silent). */
export function admit(id: string, env: HandoffEnv, options: AdmitOptions = {}): Verdict {
  const taken: { claim?: AdmissionClaim } = {};
  const verdict = decide(id, env, options, taken);
  // capacity the arbiter handed out in this call is given back unless the hand-off is going to start on it
  if (verdict.kind !== "start") taken.claim?.release();
  return verdict;
}
function decide(id: string, env: HandoffEnv, options: AdmitOptions, taken: { claim?: AdmissionClaim }): Verdict {
  if (gateClosed()) return { kind: "wait", reason: "gate" };
  const row = handoffRow(id);
  if (!row) return { kind: "settled", why: "gone" };
  if (row.phase === "started") {
    // a finished hand-off whose settling failed (its row is still here with its receipt) is settled again by the next pass that looks at it
    const receipted = options.probe ? null : findDelegationReceipt(id);
    if (receipted) settleReceipted(receipted);
    return { kind: "settled", why: "started" };
  }
  const item = handoffItem(row, !options.probe);
  if (!item) return options.probe ? { kind: "wait", reason: "unreadable" } : { kind: "settled", why: "gone" };
  const db = database();
  const bus = env.bus;
  const source = row.source_thread_id;
  // an earlier build's stand-in record that is past `queued` says this hand-off already ran; until the clean-up removes it, it is receipted as interrupted, never run
  if (unmigratedOwnerRecordRan(db, id)) return { kind: "cancel", receipt: { status: "failed", result: status("receipt_restart") }, quiet: true };
  // the owner's deletion of the source conversation or the sender settles the hand-off, whoever the sender is or whether it resolves
  if (ownerDeletedThread(db, source) || (row.from_bot_id !== null && botDeleted(db, row.from_bot_id))) return { kind: "cancel", receipt: { status: "cancelled", result: status("receipt_deleted") }, quiet: true };
  const sender = (item.fromBotId ? bus.store.bot(item.fromBotId) : null) ?? bus.store.botByThread(source);
  if (!sender) return { kind: "wait", reason: "unresolved-sender", ctx: { row, item, target: undefined as unknown as BotRecord, shared: false } };
  const target = bus.store.bot(item.toBotId);
  if (!target) {
    // "no such bot" settles only with the recorded deletion of that bot; a registry that is not loaded yet lacks it too
    if (!botDeleted(db, item.toBotId)) return { kind: "wait", reason: "unresolved-target", ctx: { row, item, target: undefined as unknown as BotRecord, shared: false } };
    return { kind: "cancel", receipt: { status: "error", result: status("no_such_bot") }, chip: `error: delegation to ${item.toBotId} did not finish: no such bot` };
  }
  if (deletionOf(source, row.from_bot_id, row.to_bot_id)) return { kind: "cancel", receipt: { status: "cancelled", result: status("receipt_deleted") }, quiet: true };
  // A draft-only sender (server/draft-only.ts) never starts a bot that can send: refused before any approval or launch, at every level.
  if (sender.draftOnly && !target.draftOnly) return { kind: "cancel", receipt: { status: "denied", result: status("receipt_draft_only") }, chip: `Delegation to @${target.name}: ${DRAFT_ONLY_HANDOFF_REFUSAL}` };
  // the request side: an item enqueued as shared work is decided by that request, a room request that ended cancels the hand-off
  // (a development build's stand-in record is not a request: the clean-up removes it, and until then it only says whether the hand-off ran, asked above)
  const request = handoffRequest(db, id);
  const shared = request !== null && isSharedWorkRow(request);
  let claim = options.claim;
  if (shared) {
    // a shared request the owner's cancel ended is receipted and closed like a plain one (CANCEL-TREE-104 R3/R6); any other ending is on record from the shared run's own finish
    if (request!.state === "cancelled") return { kind: "cancel", receipt: { status: "cancelled", result: cancelledEnding(request!.outcomeNote) }, request };
    if (isTerminalRoomRequestState(request!.state)) return { kind: "settled", why: "ended" };
    // F3 start guard (CANCEL-TREE-104 D4) for shared work too: a queued shared ask whose asker ended never starts and takes no capacity; the cancelled
    // receipt ends its request (the receipt listener). The shared drain never starts a hand-off's request, so this is the one start check it gets.
    if (request!.state === "queued" && askerEnded(db, request!)) return { kind: "cancel", receipt: { status: "cancelled", result: cancelledEnding(CANCELLED_WITH_ASKER) }, request };
    // unresolved (the target's bot or task is not in the registry yet, and no tombstone): parked, kept. A tombstone is settled by the shared admission below.
    if (sharedResolution(request!, bus.store) === "unresolved") return { kind: "wait", reason: "unresolved-target", ctx: { row, item, target, shared: true } };
    if (!sharedDrainOpen()) return { kind: "wait", reason: "gate" };
    // an owner's drain does not take a slot ahead of an older request the shared fair order puts first: it leaves this one to the shared drain, which walks that order
    if (options.ordered && !options.probe && !options.claim && !sharedRequestIsNext(request!)) return { kind: "wait", reason: "order", ctx: { row, item, target, shared: true } };
    const verdict = admitShared(request!, { ...(options.probe ? { probe: true } : {}), ...(options.claim ? { reserved: true } : {}) });
    if (verdict.kind === "skip") return { kind: "wait", reason: "refused" };
    if (verdict.kind === "wait") { if (verdict.record && !options.probe) settleShared(request!, verdict); return { kind: "wait", reason: verdict.reason === "gate" ? "gate" : "refused" }; }
    if (verdict.kind !== "start") return { kind: "cancel", receipt: { status: "cancelled", result: status("receipt_cancelled") }, request, sharedVerdict: verdict, quiet: true };
    claim = verdict.claim ?? claim;
    taken.claim = verdict.claim;
  } else if (row.origin === "shared" && request === null) {
    // shared work whose request is gone is settled, never started as a plain handoff (that would skip the team boundary the request carries)
    return { kind: "cancel", receipt: { status: "failed", result: status("receipt_request_gone") } };
  } else {
    if (request && isTerminalRoomRequestState(request.state)) return { kind: "cancel", receipt: { status: "cancelled", result: cancelledEnding(request.outcomeNote) }, request };
    // F3 start guard (CANCEL-TREE-104 D4): a queued ask whose asker ended never starts; the cancelled receipt ends its request (the receipt listener)
    if (request && request.state === "queued" && askerEnded(db, request)) return { kind: "cancel", receipt: { status: "cancelled", result: cancelledEnding(CANCELLED_WITH_ASKER) }, request };
    const roster = unreachableVerdict(bus, sender, target, source, item);
    if (roster) return { kind: "cancel", receipt: { status: "dropped", result: roster.result }, roster: { target, item, verdict: roster } };
  }
  if (options.afterWait && !shared && !sourceStillOwned(bus, sender.id, source)) {
    // this used to settle with no receipt at all: a handoff approved by the owner then vanished, and check_delegation answered "unknown task id" forever
    return { kind: "cancel", receipt: { status: "dropped", result: status("receipt_source_gone") } };
  }
  const destination = destinationOf(row, item, request, shared, target, sender, source, options.probe === true);
  if (destination === "gone") return { kind: "cancel", receipt: { status: "cancelled", result: status("receipt_deleted") }, quiet: true };
  if (destination === "unresolved") return { kind: "wait", reason: "unresolved-target", ctx: { row, item, target, shared } };
  // busy and capacity are asked of the destination the hand-off will use: never a conversation it will not run in
  const busy = bus.canStartHandoff ? !bus.canStartHandoff(target.id, source, destination) : (!shared && Boolean(target.busy));
  if (busy) {
    if (shared || item.waitingOnBusy) return { kind: "wait", reason: "busy", ctx: { row, item, target, shared } };
    if (item.attempts + 1 >= MAX_BUSY_ATTEMPTS) return { kind: "gaveUp", ctx: { row, item, target } };
    return { kind: "wait", reason: "busy", ctx: { row, item, target, shared } };
  }
  // Capacity waits are not failed attempts against a busy teammate. The server redrains pending queues when an active handoff releases its slot.
  if (!shared && bus.canDispatch && !bus.canDispatch()) return { kind: "wait", reason: "capacity" };
  return { kind: "start", ctx: { id, row, item, sender, target, destination, request, shared, ...(claim ? { claim } : {}) } };
}

/** Where the hand-off runs: the stored conversation. Once the prompt exists in it the destination never changes (a deleted one cancels); with no prompt yet a
 * stored conversation that is gone is resolved again. With nothing stored, it is resolved once and stored. */
function destinationOf(row: HandoffRow, item: PendingDelegationItem, request: RoomRequest | null, shared: boolean, target: BotRecord, sender: BotRecord, source: string, probe: boolean): string | "gone" | "unresolved" {
  const owned = (threadId: string): boolean => target.threadId === threadId || Boolean(target.tasks?.some((task) => task.threadId === threadId));
  let stored = row.target_thread_id;
  if (shared) {
    const named = request!.targetThreadId;
    if (!named) return "unresolved";
    if (stored !== named) { if (!probe) storeHandoffDestination(row.id, named, stored); stored = named; }
    return named;
  }
  if (stored) {
    const turnKey = row.turn_key ?? delegationTurnKey(row.id);
    const prompted = promptExists(stored, turnKey);
    if (owned(stored)) return stored;
    if (prompted) return "gone";
  }
  let resolved: string | undefined;
  try {
    resolved = hostOrThrow().destinationFor({ toBotId: target.id, sourceThreadId: source, fromBotId: sender.id, ...(item.executionAudience ? { executionAudience: item.executionAudience } : {}) });
  } catch { return "unresolved"; }
  const destination = resolved ?? target.threadId;
  if (destination !== stored && !probe) storeHandoffDestination(row.id, destination, stored);
  return destination;
}
function promptExists(threadId: string, turnKey: string): boolean {
  return database().prepare("SELECT 1 AS x FROM messages WHERE thread_id=? AND id=?").get(threadId, turnKey) !== undefined;
}

// ── dispatch ─────────────────────────────────────────────────────────────────────────

export type DispatchResult = "started" | "waiting" | "settled";
/** Hand-offs being dispatched right now: a second caller for the same hand-off (the owner drain and the shared drain can both reach one) finds it taken. */
const inFlight = new Set<string>();
/** A restart forgets what only a running process knows (tests simulate one). */
export function _forgetInFlight(): void { inFlight.clear(); }

/** Dispatches one queued hand-off: admit, the origin's pre-steps, admit again after every wait, then the start. Returns:
 *  - "started"  its turn was started (its row is stamped), nothing more to do here;
 *  - "waiting"  it stays queued (busy, capacity, the gate, an unresolved teammate): retried when the reason ends;
 *  - "settled"  this attempt is over and the queued row is gone (cancelled, denied, settled by its request, or held for the owner). */
export function dispatchHandoff(id: string, env?: HandoffEnv, options: { ordered?: boolean } = {}): DispatchResult | Promise<DispatchResult> {
  const use = env ?? defaults;
  if (!use) throw new Error("HANDOFF_DISPATCH_NOT_CONFIGURED");
  defaults = defaults ?? use;
  if (inFlight.has(id)) return "waiting";
  inFlight.add(id);
  let outcome: DispatchResult | Promise<DispatchResult>;
  try { outcome = dispatchOne(id, use, options); } catch (error) { inFlight.delete(id); throw error; }
  // a dispatch that settles at once (a wait, a cancellation) returns at once; one that waits for the owner returns a promise
  if (outcome instanceof Promise) return outcome.finally(() => { inFlight.delete(id); });
  inFlight.delete(id);
  return outcome;
}

function dispatchOne(id: string, env: HandoffEnv, options: { ordered?: boolean } = {}): DispatchResult | Promise<DispatchResult> {
  const first = admit(id, env, options.ordered ? { ordered: true } : {});
  if (first.kind !== "start") return apply(id, env, first);
  return dispatchStart(first.ctx, env);
}

function dispatchStart(first: StartContext, env: HandoffEnv): DispatchResult | Promise<DispatchResult> {
  // the item stops being a "waiting" one the moment it can run
  if (!first.shared && first.item.waitingOnBusy) { delete first.item.waitingOnBusy; saveHandoffItem(first.item); }
  if (first.shared) return dispatchShared(first, env);
  // Only a hand-off that needs the owner's answer waits: one that does not is started in this very call.
  if (!needsPeerApproval(first, env)) return launch(first, env);
  return (async () => {
    if (await peerApproval(first, env) !== "allow") return "settled" as const;
    // The approval could have been sitting for up to 15 minutes. Everything decided above is a stale snapshot now: ask again, from the row, or an allow can start
    // a second turn on a bot that is mid-turn, run a handoff the owner was told was cancelled, or mirror a chip for an exchange that never happens.
    const again = admit(first.id, env, { afterWait: true });
    if (again.kind !== "start") return apply(first.id, env, again);
    return await launch(again.ctx, env);
  })();
}

/** Whether the sender's own setting has the owner approve this contact (a standing Full access or an earlier answer waives it). */
function needsPeerApproval(ctx: StartContext, env: HandoffEnv): boolean {
  const { sender, item, row } = ctx;
  const fullAccessWaived = item.fullAccessWaived === true && env.approvalBus.fullAccessStanding?.(sender.id, row.source_thread_id, item.routineAuthority) === true;
  return Boolean(sender.approvePeerComms) && !item.approvalAlreadyGranted && !fullAccessWaived;
}

/** The peer-approval wait of an owner or room hand-off: the sender's own setting decides whether the owner is asked. */
async function peerApproval(ctx: StartContext, env: HandoffEnv): Promise<"allow" | "settled"> {
  const { sender, target, item, row } = ctx;
  const verdict = await requestPeerApproval(env.approvalBus, sender, target, item.message, "delegate_bot", row.source_thread_id, undefined, item.routineAuthority);
  if (verdict === "allow") return "allow";
  // Only the user's own no is "denied"; an expired or cancelled card says so (upstream #1526).
  const denied = verdict === "deny";
  const failure = peerApprovalFailure(verdict);
  recordDelegationReceipt({ id: item.id, sourceThreadId: row.source_thread_id, toBotId: target.id, toBotName: target.name, status: denied ? "denied" : verdict, result: status(denied ? "receipt_denied" : verdict === "expired" ? "receipt_expired" : "receipt_not_approved") });
  appendDelegationRow(env.bus, row.source_thread_id, sender.id, { role: "bot", kind: "activity", tool: { name: denied ? `Delegation to @${target.name} denied by user` : `Delegation to @${target.name}: ${failure.error}`, ok: false } });
  removeQueued(env, row.source_thread_id, item.id);
  return "settled";
}

/** Applies every verdict that is not "start", and nothing else: the receipt and line a cancellation owes, the park of an unresolved teammate, the counted
 * busy wait and its line, the give-up the owner decides. The queued row of a settled hand-off is removed here, whoever called. */
function apply(id: string, env: HandoffEnv, verdict: Exclude<Verdict, { kind: "start" }>): DispatchResult {
  const bus = env.bus;
  switch (verdict.kind) {
    case "settled": return verdict.why === "started" ? "settled" : cleanup(id, env, verdict.why);
    case "wait": return applyWait(env, verdict);
    case "gaveUp": return applyGaveUp(id, env, verdict.ctx);
    case "cancel": {
      const row = handoffRow(id);
      const item = row ? handoffItem(row, false) : null;
      const source = row?.source_thread_id ?? "";
      const toBotId = row?.to_bot_id ?? "";
      if (verdict.sharedVerdict && verdict.request) { settleShared(verdict.request, verdict.sharedVerdict); return cleanup(id, env, "ended"); }
      // the owner's deletion also ends the shared request this hand-off stands for (cancelled, with the deletion wording), never left queued behind a removed row
      if (isDeletedEnding(verdict.receipt.result)) {
        const standing = handoffRequest(database(), id);
        if (standing && isSharedWorkRow(standing) && !isTerminalRoomRequestState(standing.state)) cancelDeletedSharedRequest(standing);
      }
      const targetName = bus.store.bot(toBotId)?.name ?? toBotId;
      if (isDeletedEnding(verdict.receipt.result) && item) {
        // a recorded deletion: the row goes, then the "cancelled" receipt in the deletion's words (if the row cannot be removed it stays, with no receipt)
        if (!cancelForDeletion(bus, source, item, row?.from_bot_id, toBotId)) { removeQueued(env, source, id); if (!findDelegationReceipt(id)) recordDelegationReceipt({ id, sourceThreadId: source, toBotId, toBotName: targetName, status: "cancelled", result: status("receipt_deleted") }); }
        return "settled";
      }
      if (verdict.roster) { dropForRoster(bus, verdict.roster.target, source, verdict.roster.item, verdict.roster.verdict); removeQueued(env, source, id); return "settled"; }
      // a room request that ended while the handoff waited is receipted as cancelled unless its real outcome is already on record
      if (verdict.request && verdict.receipt.status === "cancelled") {
        // the hand-off's real outcome (its answer) is already on record: it is kept, no closing line, only the row goes
        const real = keepRealOutcome(id);
        if (real === "unsaved") return "waiting";
        if (real === "kept") { removeQueued(env, source, id); return "settled"; }
        // CANCEL-TREE-104 R6 site 1: the closing line, the receipt on disk, then the queue row; a step that fails keeps the row for the next drain
        if (!appendHandoffClosingLine(bus, { id, sourceThreadId: source, fromBotId: item?.fromBotId ?? row?.from_bot_id ?? undefined, targetName, requestId: verdict.request.id })) return "waiting";
        // on disk, or nothing is removed (a receipt only in memory never authorizes the removal); recording it again replaces an equal one
        if (!recordDelegationReceipt({ id, sourceThreadId: source, toBotId, toBotName: targetName, status: "cancelled", result: verdict.receipt.result })) return "waiting";
        removeQueued(env, source, id);
        return "settled";
      }
      recordDelegationReceipt({ id, sourceThreadId: source, toBotId, toBotName: verdict.receipt.status === "error" ? toBotId : targetName, status: verdict.receipt.status, result: verdict.receipt.result });
      if (verdict.chip && source) appendDelegationRow(bus, source, item?.fromBotId ?? row?.from_bot_id ?? undefined, { role: "bot", kind: "activity", tool: { name: verdict.chip, ok: false } });
      removeQueued(env, source, id);
      return "settled";
    }
  }
}

/** The queued row of an ended hand-off goes (with its waiting line). A row that cannot be removed stays: the next drain settles it again. */
function removeQueued(env: HandoffEnv, sourceThreadId: string, id: string): void { acknowledgeDelegation(sourceThreadId, id, env.bus); }
function cleanup(id: string, env: HandoffEnv, _why: string): DispatchResult {
  const row = handoffRow(id);
  if (row && row.phase !== "started") removeQueued(env, row.source_thread_id, id);
  return "settled";
}

/** Bots whose shared drain a deferred hand-off has asked for and that has not run yet (the request is coalesced). */
const sharedDrainAsked = new Set<string>();
function applyWait(env: HandoffEnv, verdict: Extract<Verdict, { kind: "wait" }>): DispatchResult {
  const ctx = verdict.ctx;
  switch (verdict.reason) {
    case "unresolved-sender": {
      if (ctx) parkUnresolvedIfDue(env.bus, ctx.row.source_thread_id, ctx.item, "sender");
      return "waiting";
    }
    case "unresolved-target": {
      if (ctx) parkUnresolvedIfDue(env.bus, ctx.row.source_thread_id, ctx.item, "target");
      return "waiting";
    }
    case "busy": {
      if (!ctx || ctx.shared || !ctx.target) return "waiting";
      return spendBusyRetry(env, ctx.row, ctx.item, ctx.target);
    }
    case "order": {
      // left to the shared drain (it starts this request in its turn of the fair order); asked for after the owner's drain has finished its pass
      // one shared drain per bot however many of its hand-offs a pass defers (a page of them asks once, not once each)
      const botId = ctx?.row.to_bot_id;
      if (botId && !sharedDrainAsked.has(botId)) {
        sharedDrainAsked.add(botId);
        queueMicrotask(() => { sharedDrainAsked.delete(botId); try { drainSharedWork(botId); } catch (error) { console.error("[shared] the shared drain failed", error); } });
      }
      return "waiting";
    }
    default: return "waiting";
  }
}

/** A wait on a busy teammate counts once per busy period: the item is parked (with its waiting line and Stop) and the target's idle transition, or the timed
 * release, runs it again. Past MAX_BUSY_ATTEMPTS it is held for the owner instead (gaveUp). */
function spendBusyRetry(env: HandoffEnv, row: HandoffRow, item: PendingDelegationItem, target: BotRecord, why: "busy" | "failed" = "busy"): DispatchResult {
  if (item.waitingOnBusy) return "waiting";
  item.attempts += 1;
  item.waitingOnBusy = true;
  parkWaiting(env.bus, row.source_thread_id, item, target.name, why);
  return "waiting";
}

/** The hand-off was never sent and has used every retry (the teammate stayed busy, or its start was cut short before the provider each time): it is held, never
 * dropped. The owner reads that it was not sent, for the reason it really was, and chooses Send again or Dismiss. */
function applyGaveUp(id: string, env: HandoffEnv, ctx: Pick<StartContext, "row" | "item" | "target">, reason: HeldReason = "busy"): DispatchResult {
  const { row, item } = ctx;
  item.attempts += 1;
  item.waitingOnBusy = true;
  clearWaitLine(env.bus, row.source_thread_id, item);
  saveHandoffItem(item);
  if (!holdBusyGaveUp(id, reason)) return "waiting";
  announceHeld(id, settleOptions(env));
  return "settled";
}

/** How a held hand-off is announced: the receipt, and the line the server writes under the conversation it was made in. */
export function settleOptions(env: HandoffEnv): SettleOptions {
  return { botName: (botId) => env.bus.store.bot(botId)?.name, notice: (held) => { hostOrThrow().noticeHeld(held); }, store: env.bus.store,
    // CLOUD-COMPUTER-BOOT-105 H1: a handed or held hand-off whose request ended gets the R6 closing line
    closingLine: (line) => appendHandoffClosingLine(env.bus, line) };
}

// ── shared origin ───────────────────────────────────────────────────────────────────

/** A shared hand-off: its request is dispatched (queued to running, the owner's deletions decided in the same transaction) BEFORE the owner's approval wait,
 * the approval is waited for, the hand-off is admitted again, and only then does the turn start. Nothing here is terminal for a wait. */
async function dispatchShared(ctx: StartContext, env: HandoffEnv): Promise<DispatchResult> {
  const h = hostOrThrow();
  const request = ctx.request!;
  const claim = ctx.claim;
  const db = database();
  const dispatched = transaction(() => sharedRequestDeleted(request) ? "deleted" as const : markRequestDispatched(db, request.id, { now: sharedClock(), targetThreadId: request.targetThreadId! }, dispatchToken) ? "ok" as const : "lost" as const, { op: "shared-dispatch" });
  if (dispatched === "deleted") { claim?.release(); cancelDeletedSharedRequest(request); return cleanup(ctx.id, env, "ended"); }
  if (dispatched === "lost") { claim?.release(); return "waiting"; }
  const shared = sharedHost ?? h.shared;
  if (!shared) { claim?.release(); throw new Error("HANDOFF_DISPATCH_NOT_CONFIGURED: shared"); }
  const running = shared.begin(request, claim);
  let current = ctx;
  try {
    if (shared.needsApproval(request)) {
      enterOwnerWait(db, request.id, Date.now());
      let verdict: "allow" | "deny" | "expired" | "cancelled";
      try { verdict = await shared.requestApproval(request); } finally { leaveOwnerWait(db, request.id, Date.now()); }
      if (verdict !== "allow") { running.finish(undefined, { ending: status("shared_not_approved"), diagnostic: "The shared request was not approved." }); return cleanup(ctx.id, env, "ended"); }
    }
    // asked again after the wait, holding the capacity already taken
    const again = admit(ctx.id, env, { ...(claim ? { claim } : {}), afterWait: true });
    if (again.kind !== "start") {
      running.abandon();
      // the request goes back to waiting; a cancellation or a deletion ends it
      if (again.kind === "wait" || again.kind === "gaveUp") requeue(request.id, again.kind === "wait" ? again.reason : "busy");
      return apply(ctx.id, env, again);
    }
    current = again.ctx;
    return await launch(current, env, running, shared);
  } catch (error) {
    running.abandon();
    requeue(request.id, "start_failed");
    throw error;
  }
}
function requeue(requestId: string, refusal: string): void {
  database().prepare("UPDATE room_requests SET state='queued', dispatched_at=NULL, waiting_since=NULL, refusal=? WHERE id=? AND state IN ('running','waiting_owner')").run(refusal, requestId);
}

// ── the start ────────────────────────────────────────────────────────────────────────

/** Starts the hand-off's turn on its stored destination with the ticket, and handles a start that does not complete (by the row's state). */
async function launch(ctx: StartContext, env: HandoffEnv, running?: SharedRun, sharedOps?: NonNullable<HandoffHost["shared"]>): Promise<DispatchResult> {
  const h = hostOrThrow();
  const { id, item, sender, target, destination, request, row } = ctx;
  const bus = env.bus;
  const source = row.source_thread_id;
  const ticket = new DispatchTicket(id, destination);
  let release: () => void = () => {};
  let text: string;
  let options: Record<string, unknown>;
  let watching = false;
  let handled: DispatchResult | undefined;
  let failedOnce = false;
  const failure = (error: unknown): DispatchResult => {
    if (failedOnce) return handled ?? "waiting";
    failedOnce = true;
    revoke(ticket);
    release();
    if (watching) h.watch.end(destination);
    const message = error instanceof Error ? error.message : String(error);
    handled = afterStartFailure(ctx, env, message, startFailureCodeFrom(error), running);
    return handled;
  };
  try {
    if (ctx.shared) {
      text = sharedOps!.text(request!);
      options = sharedOps!.turnOptions(request!);
      // F3 (02-3): a shared hand-off's worker carries its trace like the non-shared one: derived from the request tree (turnOptions), else the
      // trace its asker advanced and the row carries (a parentless hand-off from a direct conversation)
      if (options.coordination === undefined && item.coordination !== undefined) {
        const carried = item.coordination as CoordinationTrace;
        options = { ...options, coordination: carried, commsDepth: carried.path.length - 1 };
      }
      sharedOps!.mirror(request!, { sourceMessageId: item.sourceMessageId });
    } else {
      release = h.reserveSlot(destination);
      const channel = getOrCreateChannel(bus.store, sender, target, source, item.executionAudience);
      mirrorExchange(bus, sender, target, item.message, channel, source, item.executionAudience, "question", { sourceMessageId: item.sourceMessageId });
      // The waiting line (with its Stop) goes as the turn starts: once the row is started it is no longer in the queue, so the end of the drain cannot find it.
      clearWaitLine(bus, source, item);
      const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
      text = `[Delegated by @${sender.name}, another bot in this Murage workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
      options = {
        automation: { kind: "delegation" },
        chainRootThreadId: source,
        handoffSourceThreadId: source,
        // the prompt rests on the one row that handed it over (rule 7); a legacy item without it keeps the asking conversation's prefix
        ...(item.sourceMessageId ? { handoffOf: { threadId: source, messageId: item.sourceMessageId } } : {}),
        ...(item.notOwnerAudience === true ? { chainNotOwner: true } : {}),
        eventId: item.eventId,
        coordination: item.coordination as CoordinationTrace | undefined,
        // The delegating bot is the one whose unattended state matters, and a room thread has no owner to look it up from.
        ...h.peerOptions(target, source, sender.id, item.routineAuthority),
        unattended: item.unattended === true || h.isUnattended(source),
      };
      h.watch.begin(destination, {
        toBotId: target.id, toBotName: target.name, taskId: id, sourceThreadId: source, startedAtMs: Date.now(),
        ...(request ? { requestId: request.id } : {}),
        ...(item.notOwnerAudience === true ? { notOwnerAudience: true } : {}),
        ...(channelIdOf(channel) ? { channelId: channelIdOf(channel) } : {}),
      });
      watching = true;
    }
  } catch (error) {
    return failure(error);
  }
  // THE start: nothing else passes a hand-off's run to a turn
  try {
    await h.startTurn(target.id, text, {
      ...options,
      threadId: destination,
      commsDepth: ctx.shared ? (typeof options.commsDepth === "number" ? options.commsDepth : 1) : item.depth + 1,
      delegationRun: ticket,
      ...(running ? { sharedWorkRun: running.sharedWorkRun } : {}),
      onDispatchError: (message: string, error?: unknown) => { failure(error ?? new Error(message)); },
    });
  } catch (error) {
    // A refusal before the turn began (an unsupported setting, a closed gate) leaves no error of its own in the worker's conversation: the owner reads
    // the full explanation there; the delegating bot is told only the kind of failure.
    try { recordRefusedStart(bus.store, destination, error instanceof Error ? error.message : String(error)); } catch { /* the explanation is a courtesy; the failure is handled below */ }
    return failure(error);
  }
  // The turn was started when the prompt and the row's start committed together; nothing else is "started".
  const after = handoffRow(id);
  if (!after || after.phase !== "started") return failure(new Error("the turn did not start"));
  return failedOnce ? (handled ?? "waiting") : "started";
}
const channelIdOf = (channel: { id?: string } | undefined): string | undefined => channel?.id;

/** A start that did not complete. What happens next is decided by the ROW (settleAfterFailure), never by the error:
 *  - never started: the hand-off waits (asked again from the row; a still-startable one spends a busy retry, past the limit it is held for the owner);
 *  - started, not submitted: reset to run once more with its stored prompt (a third cut-short start is held for the owner as "didn't start", never deleted);
 *  - submitted, no evidence: held, the owner decides; accepted, or the engine's reply to the prompt was stored (recorded as it was written): interrupted. */
function afterStartFailure(ctx: StartContext, env: HandoffEnv, message: string, code: StartFailureCode, running?: SharedRun): DispatchResult {
  const { id } = ctx;
  // decided from the row BEFORE settling: the engine was never handed the turn (not accepted, not submitted, nothing shows it ran)
  const before = handoffRow(id);
  const neverHanded = before !== undefined && !before.accepted_turn_id && !before.submitted_at && before.evidence_at === null;
  // CANCEL-TREE-104 R3: the asker ended while the turn was being set up and nothing was handed over: no could-not-start chip (nothing could have
  // started), and once the row is reset it is admitted at once, so decide() settles it as cancelled (receipt, closing line) instead of a retry
  const askerEnded = neverHanded && (() => { const request = handoffRequest(database(), id); return request !== null && isTerminalRoomRequestState(request.state); })();
  // CLOUD-COMPUTER-BOOT-105 H1: a start that failed after the hand-over (the box took the POST, accepted() was refused) under a request that ended is
  // settled as cancelled by the row's settle (closing line, cancelled receipt), never held for the owner
  const endedAfterHandOver = !neverHanded && before !== undefined && (() => { const request = handoffRequest(database(), id); return request !== null && requestEndedForHandoff(request); })();
  const settled = settleAfterFailure(id, settleOptions(env));
  if (endedAfterHandOver && settled === "receipted") { running?.abandon(); return "settled"; }
  if (askerEnded && (settled === "fresh" || settled === "redispatched" || settled === "waiting")) {
    running?.abandon();
    const again = admit(id, env, { probe: true });
    if (again.kind !== "start") return apply(id, env, again);
    again.ctx.claim?.release();
    parkForRetry(id);
    return "waiting";
  }
  if (neverHanded && (settled === "waiting" || settled === "fresh" || settled === "redispatched" || settled === "held" || settled === "alreadyHeld")) {
    try {
      hostOrThrow().couldNotStart?.({ id, sourceThreadId: ctx.row.source_thread_id, fromBotId: ctx.item.fromBotId ?? ctx.row.from_bot_id ?? undefined, toBotId: ctx.target.id, why: message, code, shared: ctx.shared,
        ...(ctx.item.executionAudience ? { executionAudience: ctx.item.executionAudience } : {}) });
    } catch (error) { console.error("delegations: could not write the could-not-start chip", error); }
  }
  switch (settled) {
    case "waiting": {
      running?.abandon();
      const again = admit(id, env, { probe: true });
      if (again.kind === "start") return spendBusyRetryFor(env, id);
      return again.kind === "wait" ? apply(id, env, again) : settleOnly(id, env);
    }
    case "fresh":
    case "redispatched":
      running?.abandon();
      parkForRetry(id);
      return "waiting";
    case "held":
    case "alreadyHeld":
      running?.finish(undefined, { ending: status("delegated_turn_could_not_start", { why: code }), diagnostic: message.slice(0, 200) });
      announceHeld(id, settleOptions(env));
      return "settled";
    case "gone":
    case "receipted":
    case "interrupted":
      running?.finish(undefined, { ending: status("delegated_turn_could_not_start", { why: code }), diagnostic: message.slice(0, 200) });
      return "settled";
    case "unsettled":
      // the receipt is recorded but its settling did not commit: the row and the request stay as they are and the next pass settles both through the receipt
      running?.abandon();
      return "settled";
  }
}
/** The state of a hand-off after a failed start, decided again from the row. */
function settleOnly(id: string, env: HandoffEnv): DispatchResult {
  const again = admit(id, env);
  if (again.kind !== "start") return apply(id, env, again);
  again.ctx.claim?.release();            // (it can start after all, but not from inside a failure: it waits and is asked again)
  return spendBusyRetryFor(env, id);
}
function spendBusyRetryFor(env: HandoffEnv, id: string): DispatchResult {
  const row = handoffRow(id);
  const found = queuedHandoff(id);
  const target = found ? env.bus.store.bot(found.item.toBotId) : undefined;
  if (!row || !found || !target) return "waiting";
  if (found.item.waitingOnBusy) return "waiting";
  if (found.item.attempts + 1 >= MAX_BUSY_ATTEMPTS) return applyGaveUp(id, env, { row, item: found.item, target }, "didNotStart");
  return spendBusyRetry(env, row, found.item, target, "failed");
}

