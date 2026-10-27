// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where a worker bot's answer crosses to another bot: the ask, delegate and check/wait routes, the delegated-turn finalizer, shared-result delivery,
// a project card's result delivery, and the replay of a hand-off an event run already made. Everything here reaches the rest of the server through the
// ports its caller passes in (server/index.ts builds them; see server/boundary-ports.ts), never by importing the store, the comms bus or anything that turns a
// string into a Murage line. The import allowlist test (server/bot-egress.allowlist.test.ts) holds it to that.

import { resolveReceiptBinding } from "./card-result-source.ts";
import { handoffReplyId, type OwedReply } from "./handoff-reply.ts";
import { type DelegatedReplyChecks } from "./delegated-reply-check.ts";
import { authorizeStatus, peerApprovalStatus, resolveTaskSealed, type BoundaryComms, type BoundaryStore } from "./boundary-ports.ts";
import { newId } from "./contracts.ts";
import { MAX_HANDOFFS_PER_TURN, coordinationRefusalText, type CoordinationBudget, type CoordinationTrace } from "./coordination-budget.ts";
import { resolveCoordinationTarget } from "./coordination-target.ts";
import { finishHandoff, formatDelegationElapsed, handoffRow, recordAskTicket, recordDelegationReceipt, releaseOwedReply, repeatedHandoffReply, summarizeDelegatedActivity, type QueueResult, type ReleasedActivityRow } from "./delegations.ts";
import { decodeHandoffReceipt, noAnswerReceipt, type EventActionHandle, type EventActionSpec } from "./event-limit.ts";
import { defaultThreadId, issueWorkAudience, requestSourceThread, sharedWithTeam } from "./execution-audience.ts";
import { cardRoomIds } from "./fold-steps.ts";
import { formatHandoff } from "./handoff-outcome.ts";
import { storedAnswerText, type StoredAnswerDeps } from "./handoff-replay.ts";
import { threadHumanPrincipal } from "./human-principals.ts";
import { type InternalCapabilities, type InternalCapabilityKind } from "./internal-capabilities.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import type { ContinuationResultLine } from "./project-prompt.ts";
import { projectMainThread } from "./project-routines.ts";
import { releaseAskReply, releaseMessage, releaseStoredResult, type ReleasedResult } from "./result-egress.ts";
import { WorkerText, type ReleasedText } from "./released-text.ts";
import { MurageStatus, botName, type BotName, status, type FailureCode, type StartWhy, type Outbound } from "./murage-status.ts";
import { type RowSink, botBody, botReply, sendBot, writeActivityRow, writeBotRow, type BotBodyInput, type BotReply } from "./bot-egress.ts";
import { isTerminalRoomRequestState, type completeRequest, type ContinuationResult, type RoomRequest } from "./room-requests.ts";
import { type RoutinePeerSource } from "./routine-permissions.ts";
import { drainSharedWork } from "./shared-work.ts";
import { type BotRecord, type GroupRecord, type Message, type MessageMurage } from "./store.ts";
import { taskResolvable as taskCanBeAnswered, taskStatusCode, type TaskResolutionDeps } from "./task-resolution.ts";
import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { type ExecutionAudience } from "./work-admission.ts";
import { type HumanPrincipal } from "./human-principals.ts";
import { type ProjectCard } from "./project-records.ts";

export type EventReply = { status: number; body: unknown };

/** A hand-off made in a direct chat has no request to wake its asker through (rooms do, lane E1). The server keeps who asked
 * (server/asker-wake.ts), wakes the asker once the result is in its conversation, and owes no wake for a receipt the asker read
 * itself (lane 0163-delegate-wake). Optional: a harness without it wakes nobody, as before. */
/** What the asker was when it handed work off: everything its wake must not widen (server/asker-wake.ts AskerWakeIntent, less routineRun). */
export interface AskerWakeAsker {
  botId: string;
  threadId: string;
  depth: number;
  coordination?: CoordinationTrace;
  notOwnerAudience: boolean;
  unattended: boolean;
  eventId?: string;
  /** the routine ceiling the asking turn ran under, taken when it asked (never read live at wake time) */
  routineAuthority?: RoutinePeerSource;
}
export interface AskerWakePort {
  /** False when the intent did not reach disk: the hand-off is then not acknowledged (NOHOLD-DELEGATION.md, the asker's one wake). */
  register: (taskId: string, asker: AskerWakeAsker) => boolean | void;
  consume: (taskId: string) => void;
  /** False while the wake it owes is not on disk yet: the caller keeps its own recovery state (an owed reply, an owed delivery) until it is. */
  returned: (taskId: string, threadId: string, result: { toBotId: string; toBotName: string; ok: boolean; messageId: string }) => boolean | void;
}

export type AskBotOutcome = {
  /** "stopped": the target's turn was stopped before it finished (STOP1). */
  status: "reply" | "failed" | "stopped" | "timeout" | "error";
  /** What the target wrote: sealed, readable only through the result gate. */
  text: WorkerText;
  /** Whether it wrote anything (the words themselves are not readable here). */
  hasText: boolean;
  /** Why a turn that completed not-ok ended, as a code. The provider's own detail stays with the owner. */
  stopCode?: FailureCode;
  /** "error": why the target's turn could not start, as a code. */
  startCode?: StartWhy;
  /** The target's reply rows, for the copy mirrored into the pair room. */
  copyOf?: Message["copyOf"];
  /** "timeout": the ticket the wait's timer made for the turn still running (F3 02-4): its row and watch exist before this outcome does. */
  ticket?: string;
};

/** Makes the ticket of an ask whose wait ran out while the peer's turn still runs (F3 02-4): writes its started row and its watch, and returns its task id, or
 * undefined when this turn gets no ticket (the peer's conversation already settles another hand-off). Throws when the row could not be written. Built by the
 * route (it holds the channel, the ask's request and the audience) and called by askBotAndWait in its timer tick, with the peer's thread and turn id. */
export type AskTicketFactory = (peer: { threadId: string; turnId?: string }) => string | undefined;

/** What the ask's wait does when its timer fires, decided in that same tick against the turn's real state (F3 02-4): a turn that completed (its reply is
 * settling, or already returned) gets no ticket and its reply is returned; a turn still running gets its ticket written FIRST, then the timeout carries it;
 * a ticket that could not be written is no ticket, and the ask ends as an error (nothing is acknowledged that is not on disk). */
export function askTimeoutVerdict(turn: { done: boolean; settling: boolean }, makeTicket: (() => string | undefined) | undefined): { kind: "settling" } | { kind: "timeout"; ticket?: string } | { kind: "error" } {
  if (turn.done || turn.settling) return { kind: "settling" };
  if (!makeTicket) return { kind: "timeout" };
  try {
    const ticket = makeTicket();
    return ticket ? { kind: "timeout", ticket } : { kind: "timeout" };
  } catch (error) {
    console.error("ask: the ticket of an ask past its wait could not be written; the ask ends without one", error);
    return { kind: "error" };
  }
}

/** What the boundary asks of the rest of the server, supplied by server/index.ts. */
export interface BoundaryPorts {
  ASK_BOT_TIMEOUT_MS: number;
  MAX_COMMS_DEPTH: 2;
  approvalBus: ApprovalBus;
  askerWake?: AskerWakePort;
  askBotAndWait: (targetBotId: string, message: string, depth: number, _fromBotId?: string, eventId?: string, coordination?: CoordinationTrace, sourceThreadId?: string, notOwnerAudience?: boolean, handoffOf?: { threadId: string; messageId: string }, onTimeout?: AskTicketFactory) => Promise<AskBotOutcome>;
  beginRoomAsk: (fromBotId: string, toBotId: string, fromThreadId: string, message: string, admissionKey: string, state: "queued" | "running", onDuplicate?: (existing: RoomRequest) => void, eventId?: string) => string | undefined;
  comms: BoundaryComms;
  connectorThread: (botId: string, threadId: string) => { bot: BotRecord; group: undefined; } | { bot: BotRecord; group: GroupRecord; } | null;
  coordinationBudget: CoordinationBudget;
  coordinationHasCapacity: () => boolean;
  delegationSource: (threadId: string | undefined) => { kind: "bot"; bot: BotRecord; } | { kind: "group"; group: GroupRecord; } | null;
  delegationWatch: Map<string, { channelId?: string; toBotId: string; toBotName?: string; taskId?: string; sourceThreadId?: string; startedAtMs?: number; requestId?: string; notOwnerAudience?: boolean; }>;
  finalizingDelegations: Set<string>;
  /** A delegated reply the gate is still checking is waited for through this scheduler (1.0.5, DELEGATED-REPLY-WITHHELD.md); without one
   * (older callers, their tests) the checking verdict is final at once as in 1.0.3. */
  replyChecks?: DelegatedReplyChecks;
  /** Asks the memory side to hurry the checks the worker's thread waits on (lineage warming past owner-first, a bounded marker drain). */
  hurryReplyCheck?: (threadId: string) => void;
  /** Whether the owner's deletion of this conversation is recorded (owner-deletions.ts ownerDeletedThread). A hand-off whose asking conversation
   * the owner deleted delivers nothing into it, whenever the deletion landed (DELEGATED-REPLY-WITHHELD.md F15). Without one, no tombstone is read. */
  sourceDeleted?: (threadId: string) => boolean;
  /** The id of the request a hand-off's row belongs to (room-requests.ts handoffRequest), read by the server: the boundary holds no database handle. */
  handoffRequestId: (taskId: string) => string | undefined;
  fullAccessSkipsPeerCard: (botId: string, threadId: string) => boolean;
  internalCapabilities: InternalCapabilities;
  isUnattended: (threadId?: string | null) => boolean;
  markTaskContextExternallyUpdated: (bot: BotRecord, threadId: string, messageId: string) => void;
  ownerSurfacesByThread: Map<string, boolean>;
  resultEgressDeps: StoredAnswerDeps;
  roomAskDuplicate: (fromBotId: string, toBotId: string, fromThreadId: string, message: string) => RoomRequest | null;
  roomAskKey: (fromThreadId: string, turnGeneration: string, toBotId: string, message: string) => string;
  roomAskParent: (fromBotId: string, fromThreadId: string) => RoomRequest | null;
  roomAskRefused: (fromBotId: string, toBotId: string, fromThreadId: string) => MurageStatus | null;
  roomMurageLine: (threadId: string, text: Outbound, murage: MessageMurage, lineage?: { requestId?: string; replyToId?: string; to?: string[]; workItemId?: string; }, stableId?: string) => Message | null;
  roomRequestStillOwnerAudience: (request: RoomRequest) => boolean;
  routinePeerSource: (threadId: string | undefined, botId?: string) => RoutinePeerSource | undefined;
  /** `note` is only the delivered marker; how a request ended is `ending`, Murage's own line, kept in its own field. */
  /** The request's terminal write alone, inside the caller's transaction (the caller runs afterRoomCompletion once that transaction commits). */
  completeRoomAsk: (requestId: string, outcome: { state: "done" | "failed"; resultMessageId?: string; ending?: MurageStatus; diagnostic?: string }) => ReturnType<typeof completeRequest> | undefined;
  /** The line the source conversation is owed by a finished hand-off, as plain words kept on the receipt until the final commit lands (server/handoff-reply.ts). */
owedReply: (input: { ok: boolean; reply: Outbound | undefined; targetName: string; failureName: Outbound; stopped: boolean }) => OwedReply;
afterRoomCompletion: (result: { request: RoomRequest; wakes: RoomRequest[] }) => void;
  settleRoomAsk: (requestId: string | undefined, outcome: { state: "done" | "failed" | "cancelled" | "expired"; resultMessageId?: string; note?: "delivered"; ending?: MurageStatus; }) => void;
  sharedApprovedRequests: Set<string>;
  sourceExecutionAudience: (fromBotId: string | undefined, threadId: string, boundOnly?: boolean) => ExecutionAudience | null;
  /** Reads (a stored row comes back sealed) and the one non-text write. Rows are written through `rows`. */
  store: BoundaryStore;
  rows: RowSink;
  syncAskRequests: Map<string, string>;
  taskResolutionDeps: TaskResolutionDeps;
  waitSharedRequest: (id: string) => Promise<RoomRequest | null>;
}

/** What one internal request brings with it. */
export interface RouteLocals {
  card: ProjectCard;
  delegationMatch: RegExpMatchArray;
  eventAction: <R>(spec: Omit<EventActionSpec<R>, "routines" | "bus" | "eventId" | "stillActive">, step: (handle: EventActionHandle) => Promise<R>) => Promise<R>;
  group: GroupRecord;
  internalClaim: Readonly<{ botId: string; threadId: string; generation: string; depth: number; kind: InternalCapabilityKind; skillAuthoring: boolean; expiresAt: number; humanPrincipal?: HumanPrincipal; notOwnerAudience?: true; }>;
  internalEventId: string | undefined;
  internalOwner: { botId: string; generation: string; depth: number; skillAuthoring: boolean; eventId?: string; notOwnerAudience?: boolean; ownerAudience?: boolean; memorySkillSource?: string; coordination?: CoordinationTrace; tokens: Partial<Record<InternalCapabilityKind, string>>; };
  readInternalBody: () => Promise<any>;
  requireActiveInternal: () => void;
  res: ServerResponse<IncomingMessage> & { req: IncomingMessage; };
  url: URL;
}

export type FinalizeDelegationWatchPorts = Pick<BoundaryPorts, "askerWake" | "comms" | "delegationSource" | "delegationWatch" | "finalizingDelegations" | "handoffRequestId" | "markTaskContextExternallyUpdated" | "completeRoomAsk" | "afterRoomCompletion" | "owedReply" | "store" | "rows" | "replyChecks" | "hurryReplyCheck" | "sourceDeleted">;
/** One entry of `delegationWatch`: the hand-off a worker thread's running turn belongs to. */
export type DelegationWatchEntry = BoundaryPorts["delegationWatch"] extends Map<string, infer T> ? T : never;
/** One owed check's state, ONE object shared by every re-run of it (DELEGATED-REPLY-WITHHELD.md state note r3): when the gate first answered
 * checking, whether the hand-off had a started row then, and whether a run has committed the hand-off's end (a later run then delivers nothing). */
interface ReplyCheckState { since: number; hadRow: boolean; committed: boolean }
/** What a delegated turn left: its words (sealed), whether there were any, and the one link to the reply rows. */
export interface RecordedReply { text: WorkerText; present: boolean }
export const NO_REPLY: RecordedReply = { text: new WorkerText(""), present: false };

export function runFinalizeDelegationWatch(
  bx: FinalizeDelegationWatchPorts,
  threadId: string,
  succeeded: boolean,
  recorded: RecordedReply = NO_REPLY,
  /** Murage's own account of why the turn did not finish; never a provider's text. */
  failure: MurageStatus = status("delegated_turn_failed_plain"),
  stopped = false,
  recordedCopyOf?: Message["copyOf"],
): boolean {
  const watched = bx.delegationWatch.get(threadId);
  if (!watched) return false;
  bx.delegationWatch.delete(threadId);
  return finalizeWatched(bx, threadId, watched, succeeded, recorded, failure, stopped, recordedCopyOf);
}

/** The finalize of one watched hand-off, with its watch entry in hand (the map no longer holds it: a new turn in the worker's thread can
 * neither clobber nor settle this one). `check.since`: when the gate first answered checking for this reply; the re-run a DelegatedReplyChecks
 * scheduler owes comes back here with it (DELEGATED-REPLY-WITHHELD.md section 2). */
function finalizeWatched(
  bx: FinalizeDelegationWatchPorts,
  threadId: string,
  watched: DelegationWatchEntry,
  succeeded: boolean,
  recorded: RecordedReply,
  failure: MurageStatus,
  stopped: boolean,
  recordedCopyOf: Message["copyOf"] | undefined,
  check?: ReplyCheckState,
): boolean {
  const { askerWake, comms, delegationSource, finalizingDelegations, handoffRequestId, markTaskContextExternallyUpdated, completeRoomAsk, afterRoomCompletion, owedReply, store , rows, replyChecks, hurryReplyCheck } = bx;
  const checkKey = watched.taskId ?? watched.requestId ?? threadId;
  // F15 (r3): the owner deleted the asking conversation (the tombstone is written in the deletion's own commit). Read on EVERY run, the first
  // included, never latched: a deletion that landed while the worker's turn ran leaves no started row to miss and no request to end, and the
  // bot stays, so only the tombstone tells. Nothing is written, mirrored or woken into a deleted conversation, and no check stays owed.
  if (watched.sourceThreadId !== undefined && bx.sourceDeleted?.(watched.sourceThreadId) === true) {
    replyChecks?.cancel(checkKey);
    if (watched.taskId) askerWake?.consume(watched.taskId);
    console.log(`[delegation] reply to ${checkKey}: the asking conversation was deleted, nothing to deliver`);
    return true;
  }
  // F17 (r3): a re-run after this check already committed the hand-off's end (a follow-up threw after the commit) delivers nothing twice.
  if (check?.committed) { replyChecks?.cancel(checkKey); return true; }
  // A re-run of a waiting check (design F13): the hand-off may have been settled another way while it waited. Its started row gone (the owner
  // deleted the asker's conversation: delegations.ts forgetDelegationsForThreads; a cancel; a settle by another pass), its request already
  // ended, or its source conversation gone: nothing is written, mirrored or woken from here, and the check is forgotten.
  if (check) {
    const rowGone = check.hadRow && watched.taskId !== undefined && handoffRow(watched.taskId) === undefined;
    const requestId = watched.requestId ?? (watched.taskId ? handoffRequestId(watched.taskId) : undefined);
    const request = requestId ? store.roomRequest(requestId) : undefined;
    const requestEnded = request !== undefined && request !== null && isTerminalRoomRequestState(request.state);
    const sourceGone = watched.sourceThreadId !== undefined && delegationSource(watched.sourceThreadId) === null;
    if (rowGone || requestEnded || sourceGone) {
      replyChecks?.cancel(checkKey);
      console.log(`[delegation] reply to ${checkKey} was being checked, but the hand-off ended another way (${rowGone ? "row gone" : requestEnded ? "request ended" : "source gone"}): nothing more to deliver`);
      return true;
    }
  }
  // A stopped hand-off restarts nobody, whichever path settles it (the commit below, or the receipt's later recovery).
  if (stopped && watched.taskId) askerWake?.consume(watched.taskId);
  const askRequestId = watched.requestId ?? (watched.taskId ? handoffRequestId(watched.taskId) : undefined);
  // the work-authorization delivery edge is checked first; the result-egress gate below then judges the text itself
  const deliverAllowed = askRequestId && watched.sourceThreadId
    ? authorizeStatus({ edge: "deliver", requestId: askRequestId, fromBotId: watched.toBotId, destinationThreadId: watched.sourceThreadId })
    : undefined;
  const deliverRefused = deliverAllowed !== undefined && !deliverAllowed.ok;
  // The reply leaves through the one result gate before the receipt, the copy into the source thread and the channel mirror: the delivery check for
  // its request (an owner's own hand-off with no request is read only when both sides are positively the owner's unshared conversations), then
  // the message-level rules. The three below take their text only from this answer; with no answer to ask for, there is no text to show.
  const gate = !deliverRefused && watched.sourceThreadId && (askRequestId || (succeeded && recorded.present))
    // SL-E E1: the peer turn this watch settles was started with this same not-owner audience (handoff-dispatch.ts sets chainNotOwner and begins
    // the watch from one `notOwnerAudience`), so its reply is judged as that audience's own, exactly as the sync ask route does
    ? releaseStoredResult({ origin: { threadId, messageIds: recordedCopyOf?.messageIds ?? [] }, ...(askRequestId ? { requestId: askRequestId } : {}),
      ...(watched.notOwnerAudience === true ? { peerTurnNotOwner: true as const } : {}) },
      watched.toBotId, watched.sourceThreadId, { fromBotId: store.botByThread(watched.sourceThreadId)?.id ?? "" }, watched.notOwnerAudience === true, recorded.text)
    : undefined;
  const ok = deliverRefused || gate?.kind === "refused" ? false : succeeded;
  const target = store.bot(watched.toBotId);
  const targetName = store.nameOf(watched.toBotId);
  const source = delegationSource(watched.sourceThreadId);
  // NO HOLD (lanes/release103/NOHOLD-DELEGATION.md): a reply the gate is still checking is never held for a delegation. The asking bot's final
  // answer for this request is the no-answer line, written, completed and woken exactly as any other result; the worker's words stay in the
  // worker's own conversation (the owner reads them there) and reach no row, receipt, owed reply or wake from here.
  // SL-E E3 (one rule, design section 8): for a not-owner source conversation a withheld or checking answer takes ONE neutral path. `reply` is
  // left empty, so the row is "completed without a text reply", the receipt's owed line and its replay carry that same line, and the channel
  // mirror is `delegated_turn_completed`: no withheld, checking or no-answer words reach the person, here or downstream. Owners keep today's words.
  // WAIT FIRST (1.0.5, DELEGATED-REPLY-WITHHELD.md section 2): a reply the gate cannot judge yet (a pending revoke window, a thread whose
  // lineage is not warm yet) is not the asker's answer. The hand-off stays running (its row stays started, so check/wait_delegation reads
  // "running"), the memory side is asked to hurry this thread, and this finalize is run again with the same arguments until the gate answers
  // text or withheld, or the bound passes. Nothing is written or woken until then. A stopped turn finalizes at once (it restarts nobody).
  const checking = gate?.kind === "checking" && succeeded && recorded.present && !deliverRefused && !stopped;
  if (checking && replyChecks && !(check && replyChecks.expired(check.since))) {
    // whether the hand-off has a started row now: a re-run finding it gone knows the hand-off ended another way (F13)
    const state: ReplyCheckState = check ?? { since: 0, hadRow: watched.taskId !== undefined && handoffRow(watched.taskId) !== undefined, committed: false };
    state.since = replyChecks.defer(checkKey, threadId, () => { finalizeWatched(bx, threadId, watched, succeeded, recorded, failure, stopped, recordedCopyOf, state); }, check?.since);
    try { hurryReplyCheck?.(threadId); } catch (error) { console.warn(`[delegation] could not hurry the check for ${checkKey}: ${error instanceof Error ? error.message : String(error)}`); }
    return true;
  }
  // past the bound (only a scheduler brings a finalize here with an expired check): the asker's final line names the worker and where the words are
  const timedOut = checking && replyChecks !== undefined;
  if (timedOut) console.log(`[delegation] reply to ${watched.taskId ?? askRequestId ?? threadId} still being checked after ${Math.round(replyChecks!.bound / 1000)} s: the asker gets the no-answer line`);
  // The receipt is written before any mirror short-circuits: the delegating
  // bot's check/wait_delegation must see a terminal state even when the
  // channel or target is gone.
  if (watched.taskId) finalizingDelegations.add(watched.taskId);
  const notOwnerSource = watched.notOwnerAudience === true;
  // (r3, design section 12: a deleted original, `gone`, joins the neutral path too, so no "withheld" words reach the person either)
  const neutral = notOwnerSource && gate !== undefined && gate.kind !== "text" && gate.kind !== "refused";
  const noAnswer = !notOwnerSource && gate?.kind === "checking" && succeeded && recorded.present && !deliverRefused;
  const reply: Outbound | undefined = deliverRefused || neutral ? undefined : gate?.kind === "text" ? gate.text
    : noAnswer ? (timedOut ? status("no_answer_check_timed_out", { name: targetName }) : status("no_answer_checking"))
    : gate && gate.kind !== "refused" && succeeded && recorded.present ? (gate.kind === "withheld" ? gate.line : status("withheld")) : undefined;
  const failureName: Outbound = deliverAllowed && !deliverAllowed.ok ? deliverAllowed.line : gate?.kind === "refused" ? gate.line : failure;
  const copyOf = gate?.kind === "text" ? gate.copyOf : undefined;
  // The receipt, the removal of the hand-off's row, the result in the source conversation and the request's terminal state are ONE transaction: a failure in any
  // of them (a busy database, a completion hook) leaves every record as it was, with the receipt kept on disk, and the next dispatch or the boot sweep settles the
  // row and the request together through the receipt (delegations.ts settleReceipted). The follow-ups (wakes, unread marks) run after the commit.
  let completion: ReturnType<typeof completeRoomAsk> | undefined;
  let afterCommitted: (() => void) | undefined;
  // the line the source conversation is owed: kept on the receipt until the final commit lands, so a crash in between still delivers it (handoff-reply.ts)
  const owed = source && watched.sourceThreadId ? owedReply({ ok, reply, targetName, failureName, stopped }) : undefined;
  // a direct hand-off's owed reply stays on its receipt until its asker's wake is on disk (NOHOLD-DELEGATION.md, the asker's one wake)
  const wakeOwed = Boolean(askerWake && owed && source?.kind === "bot" && !askRequestId && watched.taskId && !stopped);
  try {
  finishHandoff(watched.taskId && watched.sourceThreadId ? {
      id: watched.taskId,
      sourceThreadId: watched.sourceThreadId,
      toBotId: watched.toBotId,
      toBotName: store.bot(watched.toBotId)?.name ?? watched.toBotId,
      status: ok ? "done" : "failed",
      result: ok ? (reply ?? status("request_finished")) : failureName,
      ...(ok && copyOf ? { copyOf } : {}),
      lineage: true,
      ...(askRequestId ? { requestId: askRequestId } : {}),
      ...(watched.notOwnerAudience ? { notOwnerAudience: true as const } : {}),
      ...(owed ? { reply: owed } : {}),
    } : undefined, () => {
  if (source && watched.sourceThreadId) {
    let appended: Message;
    if (ok && reply) {
      appended = writeBotRow(rows, watched.sourceThreadId, {
        inboundKind: "action",
        // the result carries its request from the moment it is written, so a
        // restart before the request completes can still find it (SPEC-P 6.3)
        ...(askRequestId ? { requestId: askRequestId, actorKind: "bot" as const } : {}),
        // the producing bot, named even when it was removed since: the copy is its row (LINEAGE-DESIGN-S6 rule 5)
        from: target ? { botId: target.id, name: target.name, color: target.color } : { botId: watched.toBotId, name: String(targetName), color: "" },
        // the no-answer line is the row's own kept status, so the asking bot reads it in its conversation (a wrapped line is the owner's only)
      }, noAnswer ? reply : status("replied_to_task", { name: targetName, reply }), undefined, watched.taskId ? handoffReplyId(watched.taskId) : undefined);
    } else {
      // under the hand-off's stable line id: the settle that recovers a receipt whose commit never landed writes this same line, never a second one
      appended = writeActivityRow(rows, watched.sourceThreadId, askRequestId ? { requestId: askRequestId, actorKind: "murage" as const } : {}, ok ? status("delegation_completed_no_text", { name: targetName })
        : stopped ? status("delegation_stopped_early", { name: targetName })
        : status("delegation_failed_with", { name: targetName, why: failureName }), ok, watched.taskId ? handoffReplyId(watched.taskId) : undefined);
    }
    // A room turn resumes no provider session - sendTurn on the room path
    // passes no cursor and rebuilds its prompt from the transcript every
    // time - so the external-context marker has no consumer there. Unread
    // is the whole job, and it is what the room path itself sets.
    const appendedId = appended.id;
    afterCommitted = () => {
      if (source.kind === "bot") markTaskContextExternallyUpdated(source.bot, watched.sourceThreadId!, appendedId); else store.markGroupUnread(source.group.id);
      // A direct chat has no request tree to wake its asker through (rooms do, below): the asker of a hand-off is woken once its
      // turn is idle, after the result is recorded as owed to it (lane 0163-delegate-wake). A stopped hand-off restarts nobody.
      if (source.kind === "bot" && !askRequestId && watched.taskId && !stopped) {
        const kept = askerWake?.returned(watched.taskId, watched.sourceThreadId!, { toBotId: watched.toBotId, toBotName: targetName, ok, messageId: appendedId });
        if (wakeOwed && kept !== false) releaseOwedReply(watched.taskId);
      }
    };
    // A handoff a room turn made: its result wakes the asker (lane E1).
    if (askRequestId) {
      const ask = store.roomRequest(askRequestId);
      // the result answers what the asker was answering, in this thread (SPEC-P 10)
      const replyToId = ask && !appended.replyToId ? store.replyTarget(ask, (id) => store.hasMessage(watched.sourceThreadId!, id)) : undefined;
      if (ask?.fromBotId || replyToId) store.linkMessage(watched.sourceThreadId, appended.id, { ...(ask?.fromBotId ? { to: [ask.fromBotId] } : {}), ...(replyToId ? { replyToId } : {}) });
      completion = completeRoomAsk(askRequestId, ok ? { state: "done", resultMessageId: appended.id } : { state: "failed", resultMessageId: appended.id, ending: stopped ? status("turn_stopped_early") : endingOf(failureName) });
    }
  } else if (askRequestId) {
    completion = completeRoomAsk(askRequestId, ok ? { state: "done" } : { state: "failed", ending: stopped ? status("turn_stopped_early") : endingOf(failureName) });
  }
  }, { keepOwed: wakeOwed });
  } finally { if (watched.taskId) finalizingDelegations.delete(watched.taskId); }
  // the hand-off's end is committed: a retry of this check after a follow-up below throws must not deliver it again (F17)
  if (check) check.committed = true;
  try { afterCommitted?.(); } catch (error) { console.error("delegations: could not mark the source conversation updated", error); }
  if (completion) afterRoomCompletion(completion);
  const channel = watched.channelId ? store.group(watched.channelId) : undefined;
  if (!target || !channel) return true;
  // the channel copy is unchanged: a reply still being checked is mirrored as the checking line, with no link to its originals
  // (past the wait the mirror is the same line the asker read: the bare checking line would read like silence in the room)
  if (noAnswer && gate?.kind === "checking") comms.reply(target, timedOut && reply ? reply : gate.line, channel, undefined, "action");
  else if (ok && reply) comms.reply(target, reply, channel, copyOf, "action");
  else if (ok) comms.activity(target, channel, status("delegated_turn_completed"), true);
  else comms.activity(target, channel, failureName, false);
  return true;
}

/** What check/wait_delegation hands back for a receipt's released result: the words, the withheld line, the no-answer line for a check still
 * running (never "deleted or changed", REPLY-WITHHELD-CONTRACT C6; never held, NOHOLD-DELEGATION.md), how a status-only receipt ended, or a refusal. */
export function receiptResultShown(released: ReleasedResult, receipt: { copyOf?: { threadId: string; messageIds: string[] }; ended?: Outbound }): { result: Outbound; reason?: string } {
  if (released.kind === "text") return { result: released.text };
  if (released.kind === "gone") return { result: receipt.copyOf ? status("result_unavailable") : status("nothing") };
  if (released.kind === "withheld") return { result: released.line };
  if (released.kind === "checking") return { result: status("no_answer_checking") };
  if (released.kind === "status") return { result: receipt.ended ?? status("request_finished") };
  return { result: released.line, reason: released.code };
}

export type StoredAnswerForReplayPorts = Pick<BoundaryPorts, "resultEgressDeps">;
export function storedAnswerForReplay(bx: StoredAnswerForReplayPorts, answer: { threadId: string; messageId: string; requestId?: string }, who: { fromBotId: string; toBotId: string; fromThreadId: string }, notOwnerAudience: boolean): Outbound | undefined {
  const { resultEgressDeps } = bx;
  return storedAnswerText(resultEgressDeps, answer, who, notOwnerAudience);
}

/** A line kept as a request's ending is a Murage status from the table; a refusal's own words (a released quote, a composed line) are not kept. */
function endingOf(line: Outbound): MurageStatus { return MurageStatus.is(line) ? line : status("request_failed"); }

/** How a shared request ended, when no answer text goes with it: a request that did not finish never reads as finished (it says how it ended, as
 * the line kept in its own field, and a failed one with none kept reads as plainly not finished); a finished one whose answer is gone says that. */
export function sharedEndingLine(released: ReleasedResult, request: { state: RoomRequest["state"]; resultMessageId?: string | null }, ending: MurageStatus | undefined): MurageStatus {
  if (request.state !== "done") return ending ?? status("request_failed");
  return released.kind === "gone" && request.resultMessageId ? status("result_unavailable") : status("request_finished");
}

export type ContinuationPorts = Pick<BoundaryPorts, "store">;
/** What a woken bot is told of one result that came back, read when the wake's prompt is written, never when the result was queued. The wake
 * carries no words of the answer: an answer is read now, through the one result gate (delivery authorization for its request, then every rule
 * that can withhold the message), so one withheld or deleted since the worker finished is never shown. How a result that did not finish ended
 * is Murage's own line, kept in its own field; the engine's words never reach the bot. Null: the result is not this bot's to be told about. */
export function continuationOutcome(bx: ContinuationPorts, wake: RoomRequest, threadId: string, result: ContinuationResult): Pick<ContinuationResultLine, "answer" | "ending"> | null {
  const { store } = bx;
  const source = store.roomRequest(result.requestId);
  if (!source?.toBotId) return null;
  const finished = result.state === "done" || (source.verb === "review" && (source.outcomeNote === "pass" || source.outcomeNote === "changes"));
  if (!finished) { const ending = store.requestEnding(source); return ending ? { ending } : {}; }
  // the answer is read from the thread its own request ran in (a room ask answers in the room, a card run in its desk thread)
  if (!result.messageId || requestSourceThread(source.id) !== threadId) return {};
  const ask = (thread: string) => releaseStoredResult({ requestId: source.id, origin: { threadId: thread, messageIds: [result.messageId!] } },
    source.toBotId!, threadId, { fromBotId: source.fromBotId ?? wake.toBotId ?? "" }, wake.notOwnerAudience === true);
  let released = ask(source.targetThreadId ?? threadId);
  if (released.kind === "gone" && source.targetThreadId && source.targetThreadId !== threadId) released = ask(threadId);
  if (released.kind === "refused") return null;
  // a result still being checked wakes the asker with the no-answer line, never with "deleted or changed" (R10) and never its words (NOHOLD-DELEGATION.md)
  return { answer: released.kind === "text" ? released.text : released.kind === "withheld" ? released.line : released.kind === "checking" ? status("no_answer_checking") : status("result_unavailable") };
}

export type SharedDeliveryPorts = {
  terminalWritten(threadId: string, request: RoomRequest): boolean;
  receipt(requestId: string): boolean;
  wakes: { intends(taskId: string): boolean; durable(threadId: string): boolean };
};
/** Whether a finished shared request's delivery is complete on disk, as the owed-delivery pass asks before it settles the debt (room_request_owed).
 * The closing row in the requester's conversation is only the first of three writes: the receipt and, for a parentless request, the asker's wake
 * come after it, and the request is marked delivered last. A restart between them leaves the row written and the rest owed, so the row alone
 * never settles the debt; the pass calls the delivery again (it writes nothing twice) until the receipt and the wake are on disk. */
export function sharedDeliveryOnDisk(bx: SharedDeliveryPorts, request: RoomRequest, destination: string): boolean {
  if (!bx.terminalWritten(destination, request) || !bx.receipt(request.id)) return false;
  return request.parentId ? true : !bx.wakes.intends(request.id) && bx.wakes.durable(destination);
}

export type DeliverSharedResultPorts = Pick<BoundaryPorts, "comms" | "store" | "rows"> & {
  /** A parentless request's asker (a direct chat) is woken at the delivered row (index.ts marks it an external update first, then askerWake.returned).
   * False while that wake is not on disk: the request is not marked delivered, so the owed-delivery pass calls again (deduped). */
  returned?: (request: RoomRequest, messageId: string) => boolean;
};

export type SharedResultReturnedPorts = Pick<BoundaryPorts, "delegationSource" | "markTaskContextExternallyUpdated" | "store"> & {
  askerWake: AskerWakePort;
  /** The asker wakes as kept (server/asker-wake.ts AskerWakes): whether a request owes a wake, and whether a thread's wakes are on disk. */
  wakes: { intends(taskId: string): boolean; durable(threadId: string): boolean };
};
/** A parentless shared request asked from a direct chat wakes its asker at the delivered row, once (NOHOLD-DELEGATION.md, the asker's one wake): the
 * row becomes an external update of the asker's conversation first (what a wake may point at), then the wake is delivered (AskerWakes dedupes it).
 * True once nothing it owes is left off disk; a request that registered no wake (a room's, one answered in its own turn) owes nothing here. */
export function sharedResultReturned(bx: SharedResultReturnedPorts, request: RoomRequest, messageId: string): boolean {
  const { askerWake, delegationSource, markTaskContextExternallyUpdated, store, wakes } = bx;
  const destination = requestSourceThread(request.id);
  const source = destination ? delegationSource(destination) : null;
  if (!destination || source?.kind !== "bot") return true;
  if (!wakes.intends(request.id)) return wakes.durable(destination);
  markTaskContextExternallyUpdated(source.bot, destination, messageId);
  const worker = request.toBotId ? store.bot(request.toBotId) : undefined;
  return askerWake.returned(request.id, destination, { toBotId: request.toBotId ?? "", toBotName: worker?.name ?? "", ok: request.state === "done", messageId }) !== false;
}
export function runDeliverSharedResult(bx: DeliverSharedResultPorts, request: RoomRequest): void {
  const { comms, store , rows, returned } = bx;
  const target = request.toBotId && store.bot(request.toBotId), destination = requestSourceThread(request.id);
  if (!target || !destination) return;
  // The result leaves through the one gate, asked again on every attempt and before the copy, the mirror and the receipt: delivery
  // authorization, then everything that can withhold the message (a forgotten source, a withheld copy origin, partition ancestry). The
  // copy, the mirror and the receipt below all take their text from this one answer.
  const released = releaseStoredResult({ requestId: request.id, ...(request.targetThreadId && request.resultMessageId ? { origin: { threadId: request.targetThreadId, messageIds: [request.resultMessageId] } } : {}) },
    target.id, destination, { fromBotId: request.fromBotId ?? "" }, request.notOwnerAudience === true);
  if (released.kind === "refused") return;
  const finished = request.state === "done";
  // The request id is a durable delivery receipt; a terminal replay cannot copy twice.
  const existing = store.terminalFor(destination, request);
  // NO HOLD (NOHOLD-DELEGATION.md): a finished request's answer the gate is still checking is the asker's final no-answer line, written as
  // the result row (its own kept status, so the asker reads it) and kept on the receipt; the pair room is told the checking line, never the words.
  // Final: a delivery asked again after a crash keeps the no-answer it already wrote, whatever the originals read now.
  const noAnswer = finished && (existing?.noAnswer === true || released.kind === "checking");
  const result = released.kind === "text" && released.copyOf && !noAnswer ? released.text : undefined;
  const endLine = sharedEndingLine(released, request, store.requestEnding(request));
  // A run that did not finish never reads as finished: what it wrote before it stopped goes with how it ended, marked as a partial reply.
  const answer: Outbound | undefined = result && !finished ? status("unfinished_partial", { ending: endLine, partial: result }) : result;
  const ending: Outbound = answer ?? (noAnswer ? status("no_answer_checking") : endLine);
  let delivered = existing?.id;
  if (!delivered) {
    const extra = { requestId: request.id, inboundKind: request.verb === "ask" ? "question" as const : "action" as const, turnTerminal: true as const, from: { botId: target.id, name: target.name, color: target.color } };
    if (answer) delivered = writeBotRow(rows, destination, extra, answer).id;
    else if (noAnswer) delivered = writeBotRow(rows, destination, extra, ending).id;
    else delivered = writeActivityRow(rows, destination, extra, ending, finished).id;
    if (answer && result) comms.reply(target, answer, store.group(request.groupId), result.copyOf, request.verb === "ask" ? "question" : "action");
    else if (noAnswer) comms.reply(target, status("checking"), store.group(request.groupId), undefined, request.verb === "ask" ? "question" : "action");
  }
  recordDelegationReceipt({ id: request.id, sourceThreadId: destination, toBotId: target.id, toBotName: target.name,
    // a failed run's receipt keeps how it ended as its own line (the partial reply is in the conversation, marked as one)
    status: finished ? "done" : "failed", result: !finished ? endLine : result ?? (released.kind === "withheld" ? released.line : ending), lineage: true, requestId: request.id,
    ...(finished && result?.copyOf ? { copyOf: { threadId: result.copyOf.threadId, messageIds: [...result.copyOf.messageIds] } } : {}) });
  // the asker of a parentless request (a direct chat) is woken at the delivered row; until that wake is on disk the delivery stays owed, and the
  // owed-delivery pass calls again (the row and the receipt are written once more under the same ids, the wake is deduped)
  if (!request.parentId && returned && returned(request, delivered) === false) return;
  // Delivered state lives on the row (the room_requests DDL is frozen, so the terminal row's unused
  // arbiter-refusal field carries it): the boot replays only rows still owed (N1).
  store.markSharedDelivered(request.id);
  comms.clearFinishing(target.id, { requestId: request.id });
}

export type DeliverCardResultPorts = Pick<BoundaryPorts, "roomMurageLine" | "roomRequestStillOwnerAudience" | "store" | "rows">;
export type CardResultDelivery = { request: RoomRequest; bot: NonNullable<ReturnType<BoundaryPorts["store"]["bot"]>>; group: NonNullable<ReturnType<BoundaryPorts["store"]["group"]>>; card: ProjectCard; threadId: string; resultId: string | undefined; reviewNonce?: string; reviewRun: RoomRequest | null };
/** Returns false when the result is still being checked: the delivery stays owed and is judged again on the executor's next attempt (R10). */
export function runDeliverCardResult(bx: DeliverCardResultPorts, c: CardResultDelivery): boolean {
  const { roomMurageLine, roomRequestStillOwnerAudience, store , rows } = bx;
  const { request, bot, group, card, threadId, resultId, reviewNonce, reviewRun } = c;
  // The result is read again on EVERY attempt, before any copy: a message deleted, forgotten or withdrawn since a locked
  // attempt is never put in the room, and captured text is never written. A gone source drops the delivery (nothing posted).
  // It leaves through the one result gate (delivery authorization, then everything that can withhold the message), the same as any shared result.
  const released = releaseStoredResult({ requestId: request.id, ...(resultId ? { origin: { threadId, messageIds: [resultId] } } : {}) },
    bot.id, projectMainThread(group), { fromBotId: request.fromBotId ?? "" }, request.notOwnerAudience === true);
  if (resultId && released.kind === "gone") {
    // nothing of the answer is put in the room; the card says its result is no longer there (the same line on every attempt, so it is written once)
    if (!request.notOwnerAudience && roomRequestStillOwnerAudience(request)) roomMurageLine(projectMainThread(group), status("result_unavailable"), { kind: "status" }, { requestId: request.id, workItemId: card.id }, cardRoomIds(request.id).line);
    return true;
  }
  if (released.kind === "refused" || request.notOwnerAudience || !roomRequestStillOwnerAudience(request)) return true;
  // still being checked: the room says so under the card's own line id (never "deleted or changed"); the delivery stays owed and the executor's next attempt judges it again
  if (released.kind === "checking") { roomMurageLine(projectMainThread(group), released.line, { kind: "status" }, { requestId: request.id, workItemId: card.id }, cardRoomIds(request.id).line); return false; }
  const result = released.kind === "text" ? released.text : undefined;
  const resultId0 = released.kind === "text" ? released.copyOf?.messageIds[0] ?? resultId! : undefined;
  // the room copy answers what the card's lineage answers in the room (SPEC-P 10)
  const replyToId = store.replyTarget(request, (id) => store.hasMessage(projectMainThread(group), id));
  const mirrored = result ? writeBotRow(rows, projectMainThread(group), { from: { botId: bot.id, name: bot.name, color: bot.color }, requestId: request.id, ...(replyToId ? { replyToId } : {}), turnTerminal: true },
    result, reviewNonce, cardRoomIds(request.id).copy) : null;
  // the corrections and the member's summary follow the result only
  // where its sources belong to this desk's partition (round 13)
  // A correction is Murage's status (its counts, LINEAGE-DESIGN-S6 rule 21), read through the door's fixed copy: its room copy is the same
  // status, never the desk row's stored words (rule 16).
  if (mirrored && result) for (const correction of store.corrections(threadId, resultId0)) {
    roomMurageLine(projectMainThread(group), correction.status, { kind: "status" }, { replyToId: mirrored.id, requestId: request.id, workItemId: card.id }, cardRoomIds(request.id).correction(correction.id));
  }
  if (result && !reviewRun) store.saveCardSummary(group.id, bot.id, result, [resultId0 as string]);
  // the card as it is now: a message forgotten while it ran made it stale (the adapter writes its title, or says it was left out)
  const current = store.projectCard(card.id) ?? card;
  roomMurageLine(projectMainThread(group), status("card_result_line", { desk: botName(bot), lead: store.leadName(group.id), card: store.cardTitle(current) }), { kind: "result", desk: { botId: bot.id, threadId } }, { requestId: request.id, workItemId: card.id }, cardRoomIds(request.id).line);
  return true;
}

export type ReviewedCardResultPorts = Pick<BoundaryPorts, "roomRequestStillOwnerAudience" | "store">;
export function runReviewedCardResult(bx: ReviewedCardResultPorts, card: ProjectCard, group: NonNullable<ReturnType<BoundaryPorts["store"]["group"]>>): ReleasedText | null {
  const { roomRequestStillOwnerAudience, store } = bx;
    const id = card.resultMessageId, desk = card.deskThreadId, run = card.requestId ? store.roomRequest(card.requestId) : null;
    if (!id || !desk || !run || run.notOwnerAudience || !roomRequestStillOwnerAudience(run) || !card.assigneeBotId) return null;
    // the one result gate, like every other place a card's result text is handed on
    const released = releaseStoredResult({ requestId: run.id, origin: { threadId: desk, messageIds: [id] } }, card.assigneeBotId, projectMainThread(group), { fromBotId: run.fromBotId ?? "" }, false);
    return released.kind === "text" ? released.text : null;
}

export type ReplayHandoffPorts = Pick<BoundaryPorts, "resultEgressDeps" | "taskResolutionDeps"> & Pick<RouteLocals, "internalClaim">;
export function replayHandoff(bx: ReplayHandoffPorts, receipt: string, via: "ask" | "delegate", who: { fromBotId: string; toBotId: string; fromThreadId: string; targetName: BotName }, joined: boolean): BotReply | undefined {
  const { internalClaim, taskResolutionDeps } = bx;
    const decoded = decodeHandoffReceipt(receipt);
    if (!decoded) return undefined;
    return formatHandoff(decoded, via, {
      targetName: who.targetName,
      // a ticket nothing can answer any more is not replayed: the next ask is a new, charged attempt
      resolvable: taskId => taskCanBeAnswered(taskId, taskResolutionDeps, { threadId: who.fromThreadId, botId: who.fromBotId }),
      answerText: answer => storedAnswerForReplay(bx, answer, who, internalClaim.notOwnerAudience === true),
    }, joined);
}

export type AskBotRouteContext = Pick<BoundaryPorts, "ASK_BOT_TIMEOUT_MS" | "MAX_COMMS_DEPTH" | "approvalBus" | "askerWake" | "askBotAndWait" | "beginRoomAsk" | "comms" | "connectorThread" | "coordinationBudget" | "coordinationHasCapacity" | "delegationWatch" | "fullAccessSkipsPeerCard" | "internalCapabilities" | "isUnattended" | "ownerSurfacesByThread" | "resultEgressDeps" | "roomAskDuplicate" | "roomAskKey" | "roomAskParent" | "roomAskRefused" | "routinePeerSource" | "settleRoomAsk" | "sharedApprovedRequests" | "sourceExecutionAudience" | "store" | "syncAskRequests" | "taskResolutionDeps" | "waitSharedRequest" | "rows"> & Pick<RouteLocals, "eventAction" | "internalClaim" | "internalEventId" | "internalOwner" | "readInternalBody" | "requireActiveInternal" | "res">;
/** A draft-only sender (server/draft-only.ts) names a bot that can send: refused before reach, approval or any card, whatever
 *  the target's scope, so the answer never depends on who the sender may otherwise reach. */
function draftOnlyRefusesTarget<T extends Parameters<typeof resolveCoordinationTarget>[0] & { draftOnly?: true }>(roster: T[], sender: T, selector: string): boolean {
  if (sender.draftOnly !== true) return false;
  let target: { draftOnly?: true } | undefined;
  try { target = resolveCoordinationTarget(sender, roster, selector, () => true); } catch { target = undefined; }
  return target !== undefined && target !== sender && target.draftOnly !== true;
}

export async function askBotRoute(bx: AskBotRouteContext): Promise<void> {
  const { ASK_BOT_TIMEOUT_MS, MAX_COMMS_DEPTH, approvalBus, askerWake, askBotAndWait, beginRoomAsk, comms, connectorThread, coordinationBudget, coordinationHasCapacity, delegationWatch, eventAction, fullAccessSkipsPeerCard, internalCapabilities, internalClaim, internalEventId, internalOwner, isUnattended, ownerSurfacesByThread, readInternalBody, requireActiveInternal, res, roomAskDuplicate, roomAskKey, roomAskParent, roomAskRefused, routinePeerSource, settleRoomAsk, sharedApprovedRequests, sourceExecutionAudience, store, syncAskRequests, waitSharedRequest , rows } = bx;
  const body = await readInternalBody();
  const fromBotId = String(body.fromBotId ?? "");
  const senderForResolution = store.bot(fromBotId);
  if (!senderForResolution) return sendBot(res, 403, botBody({ error: status("unknown_sender") }));
  if (draftOnlyRefusesTarget(store.bots, senderForResolution, String(body.toBotId ?? ""))) return sendBot(res, 403, botBody({ error: status("draft_only_handoff"), code: "draft_only_handoff" }));
  const refusals = new Map<string, string>();
  const toBotId = resolveCoordinationTarget(senderForResolution, store.bots, String(body.toBotId ?? ""), (peer) => { const allowed = authorizeStatus({ edge: "peer", requesterBotId: senderForResolution.id, requesterThreadId: String(body.fromThreadId ?? defaultThreadId(senderForResolution)), targetBotId: peer.id, verb: "ask", tag: sourceExecutionAudience(senderForResolution.id, String(body.fromThreadId ?? defaultThreadId(senderForResolution))), ownerAudience: internalClaim.notOwnerAudience !== true, parentRequestId: roomAskParent(senderForResolution.id, String(body.fromThreadId ?? defaultThreadId(senderForResolution)))?.id }); if (!allowed.ok) refusals.set(peer.id, allowed.lineText); return allowed.ok || allowed.code === "shared_paused"; }, (peer) => refusals.get(peer.id)).id;
  const message = String(body.message ?? "").trim();
  const depth = Number(body.depth ?? 0) || 0;
  if (!toBotId || !message) return sendBot(res, 400, botBody({ error: status("fields_required") }));
  if (toBotId === fromBotId) return sendBot(res, 400, botBody({ error: status("cannot_message_self") }));
  if (depth >= MAX_COMMS_DEPTH) return sendBot(res, 200, botBody({ error: status("depth_exhausted") }));
  const target = store.bot(toBotId);
  if (!target) return sendBot(res, 404, botBody({ error: status("no_such_bot") }));
  // A draft-only sender (server/draft-only.ts) never reaches a bot that can send, at any level and before any approval.
  if (store.bot(fromBotId)?.draftOnly && !target.draftOnly) return sendBot(res, 403, botBody({ error: status("draft_only_handoff"), code: "draft_only_handoff" }));
  // An unknown sender used to fall through: no mirroring AND no
  // approval, while still running the peer turn. That made an
  // unresolvable id the cheapest way past the gate, so it is now a
  // hard refusal - every peer turn has an accountable sender.
  const from = store.bot(fromBotId);
  if (!from) return sendBot(res, 403, botBody({ error: status("unknown_sender") }));
  const fromThreadId = String(body.fromThreadId ?? defaultThreadId(from));
  const peerAllowed = authorizeStatus({ edge: "peer", requesterBotId: from.id, requesterThreadId: fromThreadId, targetBotId: target.id, verb: "ask", tag: sourceExecutionAudience(from.id, fromThreadId), ownerAudience: internalClaim.notOwnerAudience !== true, parentRequestId: roomAskParent(from.id, fromThreadId)?.id });
  if (!peerAllowed.ok) return sendBot(res, peerAllowed.retry === "queue" ? 409 : 403, botBody({ error: peerAllowed.line, code: peerAllowed.code, retry: peerAllowed.retry }));
  // connectorThread, not taskByThread: a room thread belongs to a
  // GROUP, so a bot's own task list can never match it and every peer
  // call made from a room was refused - in the one conversation where
  // the agents tools are actually mounted at depth 0.
  if (!connectorThread(from.id, fromThreadId)) {
    return sendBot(res, 403, botBody({ error: status("source_not_sender") }));
  }
  // A room turn's ask is a request (lane E1): refused when it would close
  // a wait cycle or when the owner's message has used its team steps.
  const roomAskRefusal = roomAskRefused(fromBotId, toBotId, fromThreadId);
  if (roomAskRefusal) return sendBot(res, 200, botBody({ error: roomAskRefusal }));
  const repeated = roomAskDuplicate(fromBotId, toBotId, fromThreadId, message);
  if (repeated) {
    const taskId = handoffRow(repeated.id) ? repeated.id : undefined;
    return sendBot(res, 200, botBody(isTerminalRoomRequestState(repeated.state)
      ? { botName: botName(target), text: status("already_asked_done", { name: botName(target) }) }
      : { busy: true, ...(taskId ? { taskId } : {}), toBotName: botName(target), note: status("already_asked_note") }));
  }
  // A busy peer used to be a flat bounce ("try again later") - a
  // dead-end mid-turn that models rarely retry, so the exchange just
  // evaporated. Demote the synchronous ask into a durable handoff
  // instead: the message waits in the delegation ledger (bounded busy
  // retries, receipts, restart-safe) and the asker gets a task id it
  // can check next turn. If the ledger refuses (cap/depth), fall back
  // to the plain busy bounce rather than dropping the refusal reason.
  const peerCardWaived = from.approvePeerComms === true && fullAccessSkipsPeerCard(from.id, fromThreadId);
  let currentFrom = from;
  let currentTarget = target;
  // Everything an event run does for this ask goes through its one action ledger: asking the same thing again anywhere in
  // the run gets the first answer back, with no second charge, no second card and no second dispatch.
  const asked = await eventAction<BotReply>({
    kind: "handoff", identity: ["handoff", fromBotId, toBotId, message], from, fromThreadId, targetName: target.name, orphan: "next",
    fullAccess: () => fullAccessSkipsPeerCard(from.id, fromThreadId),
    // The card may have been open for minutes. Re-read both records so deleted bots cannot recreate transcripts through stale objects.
    revalidate: () => {
      const freshFrom = store.bot(fromBotId);
      const freshTarget = store.bot(toBotId);
      if (!freshFrom || !freshTarget) return botReply(404, { error: status("no_such_bot") });
      if (!authorizeStatus({ edge: "peer", requesterBotId: freshFrom.id, requesterThreadId: fromThreadId, targetBotId: freshTarget.id, verb: "ask", tag: sourceExecutionAudience(freshFrom.id, fromThreadId), ownerAudience: internalClaim.notOwnerAudience !== true, parentRequestId: roomAskParent(freshFrom.id, fromThreadId)?.id }).ok) {
        return botReply(200, { error: status("no_longer_on_roster") });
      }
      if (!connectorThread(freshFrom.id, fromThreadId)) return botReply(404, { error: status("source_gone") });
      currentFrom = freshFrom;
      currentTarget = freshTarget;
      return undefined;
    },
    replay: (receipt, joined) => replayHandoff(bx, receipt, "ask", { fromBotId, toBotId, fromThreadId, targetName: botName(target) }, joined),
  }, async ({ charge, record, unrun }) => {
  const handoffSlot = internalCapabilities.reserve(internalClaim, "handoff", MAX_HANDOFFS_PER_TURN);
  if (!handoffSlot) return botReply(429, { error: status("handoff_limit", { max: MAX_HANDOFFS_PER_TURN }) });
  try {
  const eventAdmissionId = randomUUID();
  let childCoordination: CoordinationTrace | undefined;
  const nextCoordination = () => childCoordination ??= (() => {
    try { return coordinationBudget.advance(internalOwner.coordination, fromBotId, toBotId); }
    catch (error) { if (coordinationRefusalText(error) !== undefined) unrun(); throw error; }
  })();
  const queueBusyFallback = async (approvalAlreadyGranted = false) => {
    requireActiveInternal();
    // one handoff per ask: a repeat (or a concurrent twin that waited on
    // the same approval) returns the first one's receipt (SPEC-P 5.2)
    const twin = roomAskDuplicate(fromBotId, toBotId, fromThreadId, message);
    if (twin) return botReply(200, isTerminalRoomRequestState(twin.state)
      ? { botName: botName(target), text: status("already_asked_done", { name: botName(target) }) }
      : { busy: true, taskId: twin.id, toBotName: botName(target) });
    await charge();
    const queued = comms.queueDelegation(
      from,
      { toBotId, message, reason: "asked while busy", depth, approvalAlreadyGranted, ...(peerCardWaived ? { fullAccessWaived: true } : {}), ...(ownerSurfacesByThread.get(internalClaim.threadId) === false ? { notOwnerAudience: true } : {}), ...(isUnattended(fromThreadId) ? { unattended: true } : {}), routineAuthority: routinePeerSource(fromThreadId, fromBotId), executionAudience: sourceExecutionAudience(fromBotId, fromThreadId, true) ?? undefined, eventId: internalEventId, coordination: nextCoordination() },
      MAX_COMMS_DEPTH,
      fromThreadId,
    );
    if (queued.result !== "ok" || !queued.id) { unrun(); return botReply(200, { busy: true }); }
    const sharedRequestId = beginRoomAsk(fromBotId, toBotId, fromThreadId, message, `ask:delegation:${queued.id}`, "queued", undefined, internalEventId);
    if (sharedRequestId && (approvalAlreadyGranted || peerCardWaived)) sharedApprovedRequests.add(sharedRequestId);
    // its result wakes the asker through its request tree, or directly when no tree carries it (lane 0163-delegate-wake, NOHOLD-DELEGATION.md)
    if (!admitAskerWake(bx, queued.id, sharedRequestId, fromThreadId, () => askerWakeIntent(bx, fromBotId, fromThreadId, depth))) {
      unrun();
      return botReply(200, { error: status("could_not_start", { why: "other" }) });
    }
    record(`delegation:${queued.id}`);
    handoffSlot.commit();
    return botReply(200, { busy: true, taskId: queued.id, toBotName: botName(target) });
  };
  if (target.busy || !coordinationHasCapacity()) return await queueBusyFallback();

  // the exchange is mirrored into a bot⇄bot channel: it shows up in
  // the sidebar like any room, keeps the pair's full history, and the
  // user can open it and chip in. Both 1:1 threads get a clickable
  // chip that opens the channel, so bot-to-bot turns are never
  // invisible (they cost the user tokens).
  //
  // per-bot approval gate: a chief-of-staff bot without this on is
  // free to coordinate; one with it on must wait for a human card
  // (15-min timeout → expired) before its peer turn starts. The channel
  // and the chips are created only AFTER the verdict, so a denied
  // contact leaves no trace of an exchange that never happened.
  if (from.approvePeerComms && !peerCardWaived) {
    const verdict = await requestPeerApproval(
      approvalBus,
      from,
      target,
      message,
      "ask_bot",
      fromThreadId,
    );
    requireActiveInternal();
    if (verdict !== "allow") { const failure = peerApprovalStatus(verdict); return botReply(200, { error: failure.error, approvalOutcome: failure.approvalOutcome, approvalSource: failure.approvalSource }); }
    // The target may have become busy while the card was open.
    if (!store.bot(fromBotId) || !store.bot(toBotId)) return botReply(404, { error: status("no_such_bot") });
    if (store.bot(toBotId)!.busy) return await queueBusyFallback(true);
  }
  requireActiveInternal();
  // Charged here, once: after the peer's card, before anything is mirrored or dispatched. Re-reads both bots.
  await charge();
  const sharedTag = issueWorkAudience(fromBotId, toBotId, fromThreadId, sourceExecutionAudience(fromBotId, fromThreadId), eventAdmissionId, internalClaim.notOwnerAudience !== true);
  if (sharedTag?.kind === "team" && sharedWithTeam(currentTarget, sharedTag.team)) {
    // F3 (02-3): the allowance is consumed before the worker's row exists, so the worker's derived trace is on disk ("consumed before dispatch")
    nextCoordination();
    const queued = comms.enqueueShared({ fromBotId, sourceThreadId: fromThreadId, toBotId, message,
      admissionKey: roomAskKey(fromThreadId, internalClaim.generation, toBotId, message), ownerAudience: internalClaim.notOwnerAudience !== true,
      now: Date.now(), parentRequestId: roomAskParent(fromBotId, fromThreadId)?.id, tag: sourceExecutionAudience(fromBotId, fromThreadId), routineAuthority: routinePeerSource(fromThreadId, fromBotId), unattended: isUnattended(fromThreadId), ...(internalEventId ? { eventId: internalEventId } : {}) });
    // Refused before anything was queued: nothing ran, so nothing is charged.
    if (!queued.ok) { unrun(); return botReply(409, { error: queued.refusal, code: queued.code }); }
    // a shared hand-off from a direct chat (no parent request) has no request tree to wake its asker through: when the asker does not get the answer
    // in its own turn (in line, or past its wait), the delivery wakes it directly (NOHOLD-DELEGATION.md, the asker's one wake). Only then is a wake
    // registered, so an answer read in the asker's own turn never owes one. One in line whose wake could not be written is cancelled before it runs.
    const wakesDirect = !queued.request.parentId && askerWake !== undefined && store.botByThread(fromThreadId) !== undefined;
    sharedApprovedRequests.add(queued.request.id); handoffSlot.commit(); drainSharedWork(toBotId);
    if (store.roomRequest(queued.request.id)?.state === "queued") {
      if (wakesDirect && askerWake!.register(queued.request.id, askerWakeIntent(bx, fromBotId, fromThreadId, depth)) === false) {
        askerWake!.consume(queued.request.id);
        settleRoomAsk(queued.request.id, { state: "cancelled" });
        unrun();
        return botReply(200, { error: status("could_not_start", { why: "other" }) });
      }
      record(`delegation:${queued.request.id}`); return botReply(200, { busy: true, taskId: queued.request.id, toBotName: botName(currentTarget), note: status("in_line", { name: botName(currentTarget) }) });
    }
    const settled = await waitSharedRequest(queued.request.id);
    requireActiveInternal();
    if (!settled) { if (wakesDirect) askerWake!.register(queued.request.id, askerWakeIntent(bx, fromBotId, fromThreadId, depth)); record(`timeout:${queued.request.id}`); return botReply(200, { timeout: true, taskId: queued.request.id, toBotName: botName(currentTarget) }); }
    // The answer is handed back only through the one result gate: authorization for this request and every rule that can withhold the
    // message are asked again now, so a result since forgotten, withdrawn or no longer shareable comes back as the withheld line.
    const released = releaseStoredResult({ requestId: settled.id, ...(settled.targetThreadId && settled.resultMessageId ? { origin: { threadId: settled.targetThreadId, messageIds: [settled.resultMessageId] } } : {}) },
      toBotId, fromThreadId, { fromBotId }, internalClaim.notOwnerAudience === true);
    if (released.kind === "refused") return botReply(403, { error: released.line, code: released.code });
    const replyText: Outbound = released.kind === "text" ? released.text : released.kind === "withheld" ? released.line : released.kind === "checking" ? status("no_answer_checking") : sharedEndingLine(released, settled, store.requestEnding(settled));
    // a no-answer or withheld result is final for this request: a repeat in the same event replays the line, never the originals read again
    if (released.kind === "checking" || released.kind === "withheld") record(noAnswerReceipt(released.kind));
    else if (settled.targetThreadId && settled.resultMessageId) record(`answer:${settled.targetThreadId}:${settled.resultMessageId}:${settled.id}`);
    return botReply(200, { botName: botName(currentTarget), text: replyText });
  }
  const channel = comms.channel(currentFrom, currentTarget, fromThreadId, sourceExecutionAudience(fromBotId,fromThreadId));
  const sourceRowId = comms.exchange(currentFrom, currentTarget, message, channel, fromThreadId, sourceExecutionAudience(fromBotId,fromThreadId));
  const prefixed = `[Message from @${currentFrom.name}, another bot in this Murage workspace. Reply to them.]\n\n${message}`;
  // keyed on this turn, target and words: a concurrent identical call (one
  // that waited on the same approval) is the same ask (SPEC-P 5.2)
  let duplicateAsk: RoomRequest | undefined;
  const askRequestId = beginRoomAsk(fromBotId, toBotId, fromThreadId, message, roomAskKey(fromThreadId, internalClaim.generation, toBotId, message), "running", (existing) => { duplicateAsk = existing; });
  if (duplicateAsk) return botReply(200, { botName: botName(currentTarget), text: status("already_asked_running", { name: botName(currentTarget) }) });
  let askHandedOver = false;
  // the peer's own turn runs in this thread: its approval waits are not team work
  const syncPeerThread = askRequestId ? comms.audienceTask(toBotId, threadHumanPrincipal(fromThreadId), sourceExecutionAudience(fromBotId, fromThreadId))?.threadId : undefined;
  if (syncPeerThread && askRequestId) syncAskRequests.set(syncPeerThread, askRequestId);
  try {
  let waiting: ReturnType<typeof askBotAndWait>;
  // The peer's turn still running when the wait ends: the ask becomes a delegation claim ticket, in the wait's own timer tick (F3 02-4), so a reply that
  // landed first is returned instead and no ticket is ever made for a turn that already ended. The ticket is an ordinary started hand-off row (the ask's request
  // id, or a fresh one), committed before the timeout is acknowledged, so a restart settles it ("interrupted", or held) and its task id still answers. The watch
  // mirrors the terminal state into the channel AND the asker's thread when the turn settles, and check/wait_delegation read the same receipt. Losing the
  // reply was the old behavior, and it read as "the bots don't respond to each other".
  const makeTicket: AskTicketFactory = (peer) => {
    if (delegationWatch.has(peer.threadId)) return undefined;
    const taskId = askRequestId ?? newId();
    recordAskTicket({ id: taskId, origin: askRequestId ? "room" : "owner", sourceThreadId: fromThreadId, fromBotId, toBotId, targetThreadId: peer.threadId,
      ...(peer.turnId ? { acceptedTurnId: peer.turnId } : {}), message, depth, notOwnerAudience: internalClaim.notOwnerAudience === true, ...(internalEventId ? { eventId: internalEventId } : {}) });
    delegationWatch.set(peer.threadId, {
      channelId: channel.id,
      toBotId,
      toBotName: botName(currentTarget),
      taskId,
      sourceThreadId: fromThreadId,
      // the peer's turn began when the ask was dispatched, not now
      startedAtMs: Date.now() - ASK_BOT_TIMEOUT_MS,
      ...(internalClaim.notOwnerAudience === true ? { notOwnerAudience: true } : {}),
      ...(askRequestId ? { requestId: askRequestId } : {}),
    });
    askHandedOver = true;
    if (!askRequestId) askerWake?.register(taskId, askerWakeIntent(bx, fromBotId, fromThreadId, depth));
    return taskId;
  };
  // Refused before the peer's turn started (no allowance, or no room for another running hand-off): nothing ran, so nothing is charged.
  try { waiting = askBotAndWait(toBotId, prefixed, depth, fromBotId, internalEventId, nextCoordination(),fromThreadId,internalClaim.notOwnerAudience === true, sourceRowId ? { threadId: fromThreadId, messageId: sourceRowId } : undefined, makeTicket); }
  catch (error) { if (coordinationRefusalText(error) !== undefined) unrun(); throw error; }
  if (store.bot(toBotId)?.busy) handoffSlot.commit();
  const outcome = await waiting;
  requireActiveInternal();
  if (askRequestId) {
    const allowed = authorizeStatus({ edge: "deliver", requestId: askRequestId, fromBotId: toBotId, destinationThreadId: fromThreadId });
    if (!allowed.ok) return botReply(403, { error: allowed.line, code: allowed.code });
  }
  // the ask's reply, checked against what is stored now (the request it answers, or the hand-off this conversation started)
  // askBotAndWait started the peer's turn with this turn's not-owner audience, so the reply is judged as that audience's own (result-egress step 1)
  const releaseReply = (text: WorkerText) => releaseAskReply({ ...(outcome.copyOf ? { origin: outcome.copyOf } : {}), ...(askRequestId ? { requestId: askRequestId } : {}), ...(internalClaim.notOwnerAudience === true ? { peerTurnNotOwner: true as const } : {}) },
    toBotId, fromThreadId, { fromBotId }, internalClaim.notOwnerAudience === true, text);
  if (outcome.status === "timeout" && outcome.ticket) {
    // the peer's turn is still running and the wait's timer made its ticket (row, watch and asker wake): the asker is told the task id, nothing more is made here
    const taskId = outcome.ticket;
    writeActivityRow(rows, fromThreadId, {}, status("still_working", { name: botName(currentTarget) }));
    record(`timeout:${taskId}`);
    return botReply(200, { timeout: true, taskId, toBotName: botName(currentTarget), waitedMs: ASK_BOT_TIMEOUT_MS });
  }
  if (outcome.status === "stopped") {
    // A stopped turn is not a reply (STOP1): say so where the exchange
    // lives, and hand back any partial text marked as unfinished.
    comms.activity(currentTarget, channel, status("turn_stopped_early"), false);
    record("ended:stopped");
    // a partial reply is still the worker's stored words: it leaves only through the same gate as a finished one
    const partialReply = outcome.hasText ? releaseReply(outcome.text) : undefined;
    if (partialReply && !partialReply.ok) return botReply(403, { error: partialReply.line, code: partialReply.code });
    return botReply(200, { botName: botName(currentTarget), text: partialReply
      ? status("stopped_partial", { partial: partialReply.text })
      : status("stopped_no_partial") });
  }
  if (outcome.status === "failed" && !outcome.hasText) {
    // No partial answer to hand back - mirror the failure where the
    // exchange lives, with the provider's reason instead of silence.
    comms.activity(currentTarget, channel, status("turn_failed_note", { code: outcome.stopCode ?? "other" }), false);
    record("ended:failed");
    return botReply(200, { botName: botName(currentTarget), text: status("turn_failed", { code: outcome.stopCode ?? "other" }) });
  }
  if (outcome.status === "error") {
    // The target never ran: this is Murage's to say, never the
    // target's own words (O3). The asking bot still gets the reason.
    record("ended:error");
    comms.murageLine(channel, status("peer_could_not_start", { name: botName(currentTarget), why: outcome.startCode ?? "setup" }), { kind: "failure" }, askRequestId ? { requestId: askRequestId } : {});
    return botReply(200, { botName: botName(currentTarget), text: status("could_not_start", { why: outcome.startCode ?? "setup" }) });
  }
  // the answer, the copy mirrored into the pair room and the reply the asking bot reads all come from one release of the stored reply
  const answer = releaseReply(outcome.text);
  if (!answer.ok) return botReply(403, { error: answer.line, code: answer.code });
  // a turn that wrote nothing has no words to release; Murage's own placeholder stands in once the gate has allowed the delivery
  const shown: Outbound = answer.withheld || outcome.hasText ? answer.text : status(outcome.status === "timeout" ? "wait_timed_out" : "no_reply");
  // a withheld or still-checking answer is mirrored as its line, with no link to the originals (REPLY-WITHHELD-CONTRACT R9)
  const written = comms.reply(currentTarget, shown, channel, answer.withheld ? undefined : answer.copyOf);
  // the asking bot's answer: a reply still being checked is the final no-answer line for this request (NOHOLD-DELEGATION.md), and a repeat in
  // the same event replays that line (or the withheld one), never the originals read again
  if (answer.withheld) { record(noAnswerReceipt(answer.checking ? "checking" : "withheld")); return botReply(200, { botName: botName(currentTarget), text: answer.checking ? status("no_answer_checking") : shown }); }
  if (written) record(`answer:${channel.threadId}:${written}${askRequestId ? `:${askRequestId}` : ""}`);
  return botReply(200, { botName: botName(currentTarget), text: shown });
  } finally {
    if (syncPeerThread && syncAskRequests.get(syncPeerThread) === askRequestId) syncAskRequests.delete(syncPeerThread);
    // answered inside the asker's own turn: it owes no wake (lane E1)
    if (!askHandedOver) settleRoomAsk(askRequestId, { state: "done", note: "delivered" });
  }
  } finally { handoffSlot.release(); }
  });
  return sendBot(res, asked.status, asked.body);
}

/** Keeps the asker's one wake on disk before a queued hand-off is acknowledged (NOHOLD-DELEGATION.md, the asker's one wake). A hand-off with no
 * request (the owner's direct chat) and a shared one from a direct chat (a request with no parent: no request tree wakes its asker) register it; a
 * room's request wakes its asker through the tree. False when the wake could not be written: the hand-off is dropped before it runs (its shared
 * request cancelled) and the caller gives the charge back and tells the bot it could not start. */
export function admitAskerWake(bx: Pick<BoundaryPorts, "askerWake" | "comms" | "settleRoomAsk" | "store">, queuedId: string, requestId: string | undefined, fromThreadId: string, intent: () => AskerWakeAsker): boolean {
  const { askerWake, comms, settleRoomAsk, store } = bx;
  const sharedDirect = requestId !== undefined && !store.roomRequest(requestId)?.parentId && store.botByThread(fromThreadId) !== undefined;
  if (!askerWake || (requestId !== undefined && !sharedDirect)) return true;
  const wakeId = requestId ?? queuedId;
  if (askerWake.register(wakeId, intent()) !== false) return true;
  const dropped = comms.dropQueuedDelegation(queuedId, status("could_not_start", { why: "other" }));
  if (!sharedDirect && !dropped) return true; // already running: its result still wakes through the finalizer's own path
  askerWake.consume(wakeId);
  if (sharedDirect) settleRoomAsk(requestId, { state: "cancelled" });
  return false;
}

/** What the asker was when it handed work off, so its wake widens nothing (server/asker-wake.ts): its audience, its
 * unattended mark and its routine ceiling, all taken now, while the asking turn is the one running. */
export function askerWakeIntent(bx: Pick<BoundaryPorts, "isUnattended" | "ownerSurfacesByThread" | "routinePeerSource"> & Pick<RouteLocals, "internalClaim" | "internalEventId" | "internalOwner">, botId: string, threadId: string, depth: number): AskerWakeAsker {
  const routineAuthority = bx.routinePeerSource(threadId, botId);
  return {
    botId, threadId, depth,
    ...(routineAuthority ? { routineAuthority: { ...routineAuthority } } : {}),
    ...(bx.internalOwner?.coordination ? { coordination: bx.internalOwner.coordination } : {}),
    notOwnerAudience: bx.internalClaim.notOwnerAudience === true || bx.ownerSurfacesByThread.get(threadId) === false,
    unattended: bx.isUnattended(threadId),
    ...(bx.internalEventId ? { eventId: bx.internalEventId } : {}),
  };
}

/** A finished hand-off whose final commit failed is settled later from its receipt (delegations.ts settleReceipted). Its asker is
 * woken then, as the finalizer would have, once the line is in its conversation. A hand-off the owner or the ledger ended (cancelled,
 * denied, dropped, expired) restarts nobody, and its wake is no longer owed. Only a receipt with no request reaches here (rooms wake
 * through the request tree), and only a task registered as owing a wake wakes anyone (AskerWakes.deliver). False while the wake it owes is not on disk yet (the
 * port's own answer): the caller keeps the receipt's owed line until it is. */
export function wakeAfterRecoveredReceipt(askerWake: AskerWakePort | undefined, receipt: { id: string; sourceThreadId: string; toBotId: string; toBotName: string; status: string }, deliveredId: string | undefined): boolean {
  if (!askerWake) return true;
  if (receipt.status !== "done" && receipt.status !== "failed") { askerWake.consume(receipt.id); return true; }
  if (!deliveredId) return true;
  return askerWake.returned(receipt.id, receipt.sourceThreadId, { toBotId: receipt.toBotId, toBotName: receipt.toBotName, ok: receipt.status === "done", messageId: deliveredId }) !== false;
}

/** How many of a running delegation's latest steps a bot is told. */
const RECENT_ACTIVITY_SHOWN = 5;

export type CheckDelegationRouteContext = Pick<BoundaryPorts, "askerWake" | "connectorThread" | "resultEgressDeps" | "store" | "taskResolutionDeps"> & Pick<RouteLocals, "delegationMatch" | "internalClaim" | "requireActiveInternal" | "res" | "url">;
export async function checkDelegationRoute(bx: CheckDelegationRouteContext): Promise<void> {
  const { askerWake, connectorThread, delegationMatch, internalClaim, requireActiveInternal, res, store, taskResolutionDeps, url } = bx;
  const taskId = delegationMatch[1];
  const fromBotId = String(url.searchParams.get("fromBotId") ?? "");
  const fromThreadId = String(url.searchParams.get("fromThreadId") ?? "");
  const from = store.bot(fromBotId);
  // A room is a source conversation like any other: a Chief that
  // delegated from the exec room must still be able to read the
  // receipt back with check_delegation / wait_delegation.
  if (!from || fromThreadId !== internalClaim.threadId || !connectorThread(from.id, fromThreadId)) return sendBot(res, 403, botBody({ error: status("unknown_sender") }));
  const waitMs = Math.min(Math.max(Number(url.searchParams.get("wait_ms")) || 0, 0), 240_000);
  const deadline = Date.now() + waitMs;
  // Bounded long-poll: the delegating bot parks ONE cheap HTTP request
  // here instead of burning a model inference per status check.
  for (;;) {
    requireActiveInternal();
    // One definition of what a task id stands for (task-resolution.ts): a finished receipt, a hand-off in line, a delegated turn running,
    // or a shared request still open. Another conversation's task is not this caller's to read.
    const resolved = resolveTaskSealed(taskId, { threadId: fromThreadId, botId: fromBotId }, taskResolutionDeps);
    if (taskStatusCode(resolved) === 403) return sendBot(res, 403, botBody({ error: status("task_other_conversation") }));
    if (resolved?.kind === "receipt") {
      const receipt = resolved.receipt;
      // the asker has the answer in hand: it is owed no wake for it (lane 0163-delegate-wake)
      askerWake?.consume(taskId);
      // The receipt is bound to its request (an older one is found by the delegation's admission key). The text goes back only through the one
      // result gate: the delivery authorization is asked again now (sharing removed since delivery returns the status and the reason, no text),
      // and a result whose original is withheld, forgotten or no longer shareable, or that a turn made as the owner's audience and a turn that
      // is not asks for, comes back as the withheld line. A receipt written before results carried their origin cannot be checked, so its text is withheld.
      // a receipt whose result is the checking or no-answer line and that names no originals to judge again: the no-answer line, never "deleted or
      // changed" (C6) and never words (NOHOLD-DELEGATION.md)
      if (!receipt.copyOf && (receipt.ended?.key === "checking" || receipt.ended?.key === "no_answer_checking")) return sendBot(res, 200, botBody({ status: receipt.status, toBotName: store.nameOf(receipt.toBotId), result: status("no_answer_checking") }));
      // the same for a check that ran past its wait (1.0.5): the kept line names the worker and where the words are
      if (!receipt.copyOf && receipt.ended?.key === "no_answer_check_timed_out") return sendBot(res, 200, botBody({ status: receipt.status, toBotName: store.nameOf(receipt.toBotId), result: receipt.ended }));
      const binding = resolveReceiptBinding(receipt, { byId: (id) => store.roomRequest(id), byKey: (key) => store.roomRequestByKey(key) });
      const released = releaseStoredResult({
        ...(receipt.copyOf ? { origin: receipt.copyOf } : {}),
        ...(binding.kind === "bound" ? { requestId: binding.requestId } : {}),
        ...(binding.kind === "mismatch" ? { binding: "mismatch" as const } : {}),
        recordedNotOwner: receipt.notOwnerAudience === true,
        ...(receipt.status === "done" && receipt.lineage !== true ? { lineageUnknown: true } : {}),
        ...(receipt.status !== "done" ? { statusOnly: true } : {}),
      }, receipt.toBotId, receipt.sourceThreadId, { fromBotId }, internalClaim.notOwnerAudience === true, receipt.result);
      const shown: Pick<BotBodyInput, "result" | "reason"> = receiptResultShown(released, receipt);
      return sendBot(res, 200, botBody({ status: receipt.status, toBotName: store.nameOf(receipt.toBotId), ...shown }));
    }
    if (!resolved || resolved.kind === "foreign") return sendBot(res, 404, botBody({ error: status("task_unknown") }));
    if (Date.now() >= deadline) {
      const toBotId = resolved.kind === "queued" ? resolved.pending.toBotId : resolved.kind === "running" ? resolved.watch.toBotId : resolved.request.toBotId ?? "";
      // "running" on its own tells a coordinating bot nothing it can
      // act on. Report how long the peer has been at it and what its
      // thread has produced since dispatch, so the caller can tell
      // work from a stall instead of waiting blindly. An empty list
      // is the signal, not a gap: the proxy renders it as "may be
      // stuck". The formatted elapsed rides along so the harness owns
      // that wording once, rather than the proxy re-deriving it.
      if (resolved.kind === "running" || (resolved.kind === "shared" && resolved.phase !== "queued")) {
        const startedAtMs = resolved.kind === "running" ? resolved.watch.startedAtMs ?? Date.now() : resolved.request.dispatchedAt ?? Date.now();
        const elapsedMs = Math.max(0, Date.now() - startedAtMs);
        // and never a word of a line the one result gate would not release to this caller now: every field a row would show (its text, its tool name)
        // is released together, activity rows included
        const rows: ReleasedActivityRow[] = [];
        const watchNotOwner = resolved.kind === "running" ? resolved.watch.notOwnerAudience : undefined;
        // no excerpt of what an owner-audience turn wrote reaches a turn that is not the owner's
        const withText = !(internalClaim.notOwnerAudience === true && watchNotOwner !== true);
        if (resolved.kind === "running") {
          const threadId = resolved.threadId, watch = resolved.watch;
          // newest first, back to the moment the turn was dispatched and no further, and only until the five a bot is shown are released: the
          // work follows what the turn has written and what is shown, never how long the worker's conversation is
          for (const message of store.rowsSince(threadId, startedAtMs)) {
            if (rows.length >= RECENT_ACTIVITY_SHOWN) break;
            if ((message.kind !== "text" && message.kind !== "activity") || (message.kind === "text" && !withText)) continue;
            const row = releaseMessage(message, field => releaseStoredResult({ origin: { threadId, messageIds: [message.id] }, ...(watch.requestId ? { requestId: watch.requestId } : {}) },
              watch.toBotId, fromThreadId, { fromBotId }, internalClaim.notOwnerAudience === true, field.text));
            if (row) rows.unshift({ at: message.at, kind: message.kind, ...row });
          }
        }
        return sendBot(res, 200, botBody({
          status: "running",
          toBotName: store.nameOf(toBotId),
          elapsedMs,
          elapsed: formatDelegationElapsed(elapsedMs),
          // no excerpt of what an owner-audience turn wrote reaches a turn that is not the owner's
          recentActivity: summarizeDelegatedActivity(rows, startedAtMs, RECENT_ACTIVITY_SHOWN, withText),
        }));
      }
      return sendBot(res, 200, botBody({
        status: "queued",
        toBotName: store.nameOf(toBotId),
      }));
    }
    await new Promise((wake) => setTimeout(wake, 500));
  }
}

export type DelegateBotRouteContext = Pick<BoundaryPorts, "MAX_COMMS_DEPTH" | "askerWake" | "beginRoomAsk" | "comms" | "connectorThread" | "coordinationBudget" | "fullAccessSkipsPeerCard" | "internalCapabilities" | "isUnattended" | "ownerSurfacesByThread" | "resultEgressDeps" | "roomAskDuplicate" | "roomAskParent" | "roomAskRefused" | "routinePeerSource" | "settleRoomAsk" | "sourceExecutionAudience" | "store" | "taskResolutionDeps"> & Pick<RouteLocals, "eventAction" | "internalClaim" | "internalEventId" | "internalOwner" | "readInternalBody" | "res">;
export async function delegateBotRoute(bx: DelegateBotRouteContext): Promise<void> {
  const { MAX_COMMS_DEPTH, beginRoomAsk, comms, connectorThread, coordinationBudget, eventAction, fullAccessSkipsPeerCard, internalCapabilities, internalClaim, internalEventId, internalOwner, isUnattended, ownerSurfacesByThread, readInternalBody, res, roomAskDuplicate, roomAskParent, roomAskRefused, routinePeerSource, sourceExecutionAudience, store } = bx;
  const body = await readInternalBody();
  const fromBotId = String(body.fromBotId ?? "");
  const senderForResolution = store.bot(fromBotId);
  if (!senderForResolution) return sendBot(res, 403, botBody({ error: status("unknown_sender") }));
  if (draftOnlyRefusesTarget(store.bots, senderForResolution, String(body.toBotId ?? ""))) return sendBot(res, 403, botBody({ error: status("draft_only_handoff"), code: "draft_only_handoff" }));
  const refusals = new Map<string, string>();
  const toBotId = resolveCoordinationTarget(senderForResolution, store.bots, String(body.toBotId ?? ""), (peer) => { const allowed = authorizeStatus({ edge: "peer", requesterBotId: senderForResolution.id, requesterThreadId: String(body.fromThreadId ?? defaultThreadId(senderForResolution)), targetBotId: peer.id, verb: "ask", tag: sourceExecutionAudience(senderForResolution.id, String(body.fromThreadId ?? defaultThreadId(senderForResolution))), ownerAudience: internalClaim.notOwnerAudience !== true, parentRequestId: roomAskParent(senderForResolution.id, String(body.fromThreadId ?? defaultThreadId(senderForResolution)))?.id }); if (!allowed.ok) refusals.set(peer.id, allowed.lineText); return allowed.ok || allowed.code === "shared_paused"; }, (peer) => refusals.get(peer.id)).id;
  const message = String(body.message ?? "").trim();
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
  const depth = Number(body.depth ?? 0) || 0;
  if (!toBotId || !message) return sendBot(res, 400, botBody({ error: status("fields_required") }));
  const from = store.bot(fromBotId);
  if (!from) return sendBot(res, 404, botBody({ error: status("no_such_bot") }));
  const target = store.bot(toBotId);
  if (!target) return sendBot(res, 404, botBody({ error: status("no_such_bot") }));
  // A draft-only sender (server/draft-only.ts) never reaches a bot that can send, at any level and before any approval.
  if (store.bot(fromBotId)?.draftOnly && !target.draftOnly) return sendBot(res, 403, botBody({ error: status("draft_only_handoff"), code: "draft_only_handoff" }));
  const fromThreadId = String(body.fromThreadId ?? defaultThreadId(from));
  const peerAllowed = authorizeStatus({ edge: "peer", requesterBotId: from.id, requesterThreadId: fromThreadId, targetBotId: target.id, verb: "ask", tag: sourceExecutionAudience(from.id, fromThreadId), ownerAudience: internalClaim.notOwnerAudience !== true, parentRequestId: roomAskParent(from.id, fromThreadId)?.id });
  if (!peerAllowed.ok) return sendBot(res, peerAllowed.retry === "queue" ? 409 : 403, botBody({ error: peerAllowed.line, code: peerAllowed.code, retry: peerAllowed.retry }));
  if (!connectorThread(from.id, fromThreadId)) {
    return sendBot(res, 403, botBody({ error: status("source_not_sender") }));
  }
  const roomAskRefusal = roomAskRefused(fromBotId, toBotId, fromThreadId);
  if (roomAskRefusal) return sendBot(res, 200, botBody({ error: roomAskRefusal }));
  const repeated = roomAskDuplicate(fromBotId, toBotId, fromThreadId, message);
  if (repeated) {
    const again = repeatedHandoffReply(repeated, botName(target));
    return sendBot(res, 200, botBody({ queued: true, taskId: again.taskId, message: again.message, ...(again.done ? { done: true, status: again.status } : {}) }));
  }
  // The same hand-off, asked again anywhere in an event run (another turn, a restart, at the same time), is the same
  // action: the run's ledger answers with the first task and nothing is charged or queued twice.
  const delegated = await eventAction<BotReply>({
    kind: "handoff", identity: ["handoff", fromBotId, toBotId, message], from, fromThreadId, targetName: target.name, orphan: "next",
    fullAccess: () => fullAccessSkipsPeerCard(from.id, fromThreadId),
    revalidate: () => {
      if (!store.bot(fromBotId) || !store.bot(toBotId)) return botReply(404, { error: status("no_such_bot") });
      if (!authorizeStatus({ edge: "peer", requesterBotId: fromBotId, requesterThreadId: fromThreadId, targetBotId: toBotId, verb: "ask", tag: sourceExecutionAudience(fromBotId, fromThreadId), ownerAudience: internalClaim.notOwnerAudience !== true, parentRequestId: roomAskParent(fromBotId, fromThreadId)?.id }).ok) {
        return botReply(200, { error: status("no_longer_on_roster") });
      }
      if (!connectorThread(fromBotId, fromThreadId)) return botReply(404, { error: status("source_gone") });
      return undefined;
    },
    replay: (receipt, joined) => replayHandoff(bx, receipt, "delegate", { fromBotId, toBotId, fromThreadId, targetName: botName(target) }, joined),
  }, async ({ charge, record, unrun }) => {
  const handoffSlot = internalCapabilities.reserve(internalClaim, "handoff", MAX_HANDOFFS_PER_TURN);
  if (!handoffSlot) return botReply(429, { error: status("handoff_limit", { max: MAX_HANDOFFS_PER_TURN }) });
  try {
  await charge();
  const peerCardWaived = from.approvePeerComms === true && fullAccessSkipsPeerCard(from.id, fromThreadId);
  const queued = comms.queueDelegation(
    from,
    { toBotId, message, reason, depth, ...(peerCardWaived ? { fullAccessWaived: true } : {}), ...(ownerSurfacesByThread.get(internalClaim.threadId) === false ? { notOwnerAudience: true } : {}), ...(isUnattended(fromThreadId) ? { unattended: true } : {}), routineAuthority: routinePeerSource(fromThreadId, fromBotId), executionAudience: sourceExecutionAudience(fromBotId, fromThreadId, true) ?? undefined, eventId: internalEventId, coordination: (() => { try { return coordinationBudget.advance(internalOwner.coordination, fromBotId, toBotId); } catch (error) { if (coordinationRefusalText(error) !== undefined) unrun(); throw error; } })() },
    MAX_COMMS_DEPTH,
    fromThreadId,
  );
  if (queued.result !== "ok" || !queued.id) {
    unrun(); // nothing was queued, so nothing is charged
    // the agent reads this string - a bare enum ("too_deep") tells it
    // nothing about what to do instead
    const said: Record<Exclude<QueueResult, "ok">, MurageStatus> = {
      self: status("cannot_delegate_self"),
      too_deep: status("depth_exhausted_delegate"),
      no_target: status("no_such_bot"),
      too_many: status("too_many_delegations"),
      source_deleted: status("source_deleted"),
    };
    return botReply(200, { error: said[queued.result === "ok" ? "no_target" : queued.result] });
  }
  // its result comes back to this bot's room turn (lane E1); with no request (a direct chat) it wakes the asker directly (lane 0163-delegate-wake).
  // That wake is kept on disk before the hand-off is acknowledged: a hand-off whose intent could not be written is dropped (it has not started: a
  // direct queue drains when the asking turn ends), its charge given back, and the bot told it could not start (NOHOLD-DELEGATION.md).
  const handoffRequest = beginRoomAsk(fromBotId, toBotId, fromThreadId, message, `ask:delegation:${queued.id}`, "queued", undefined, internalEventId);
  if (!admitAskerWake(bx, queued.id, handoffRequest, fromThreadId, () => askerWakeIntent(bx, fromBotId, fromThreadId, depth))) {
    unrun();
    return botReply(200, { error: status("could_not_start", { why: "other" }) });
  }
  handoffSlot.commit();
  record(`delegation:${queued.id}`);
  const targetName = store.nameOf(toBotId);
  return botReply(200, {
    queued: true,
    taskId: queued.id,
    message: from.approvePeerComms && !peerCardWaived ? status("queued_for_review", { name: targetName }) : status("delegation_queued", { name: targetName }),
  });
  } finally { handoffSlot.release(); }
  });
  return sendBot(res, delegated.status, delegated.body);
}

