// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where a worker bot's answer crosses to another bot: the ask, delegate and check/wait routes, the delegated-turn finalizer, shared-result delivery,
// a project card's result delivery, and the replay of a hand-off an event run already made. Everything here reaches the rest of the server through the
// ports its caller passes in (server/index.ts builds them; see server/boundary-ports.ts), never by importing the store, the comms bus or anything that turns a
// string into a Murage line. The import allowlist test (server/bot-egress.allowlist.test.ts) holds it to that.

import { resolveReceiptBinding } from "./card-result-source.ts";
import { authorizeStatus, peerApprovalStatus, resolveTaskSealed, saveCardSummary, type BoundaryComms, type BoundaryStore } from "./boundary-ports.ts";
import { newId } from "./contracts.ts";
import { MAX_HANDOFFS_PER_TURN, coordinationRefusalText, type CoordinationBudget, type CoordinationTrace } from "./coordination-budget.ts";
import { resolveCoordinationTarget } from "./coordination-target.ts";
import { database } from "./database.ts";
import { findDelegationReceipt, formatDelegationElapsed, handoffRow, recordDelegationReceipt, summarizeDelegatedActivity, type QueueResult, type ReleasedActivityRow } from "./delegations.ts";
import { decodeHandoffReceipt, type EventActionHandle, type EventActionSpec } from "./event-limit.ts";
import { defaultThreadId, issueWorkAudience, requestSourceThread, sharedWithTeam } from "./execution-audience.ts";
import { cardRoomIds } from "./fold-steps.ts";
import { formatHandoff } from "./handoff-outcome.ts";
import { storedAnswerText, type StoredAnswerDeps } from "./handoff-replay.ts";
import { threadHumanPrincipal } from "./human-principals.ts";
import { type InternalCapabilities, type InternalCapabilityKind } from "./internal-capabilities.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import { roomCardName } from "./project-prompt.ts";
import { projectCardById, projectSettingsFor } from "./project-records.ts";
import { projectMainThread } from "./project-routines.ts";
import { releaseAskReply, releaseMessage, releaseStoredResult, type ReleasedResult } from "./result-egress.ts";
import { WorkerText, type ReleasedText } from "./released-text.ts";
import { type MurageStatus, botName, type BotName, botNameOf, noteOf, status, statusFromNote, type FailureCode, type Outbound } from "./murage-status.ts";
import { type RowSink, botBody, botReply, sendBot, writeActivityRow, writeBotRow, type BotBodyInput, type BotReply } from "./bot-egress.ts";
import { handoffRequest, isTerminalRoomRequestState, requestReplyTarget, roomRequest, roomRequestByKey, type RoomRequest } from "./room-requests.ts";
import { type RoutinePeerSource } from "./routine-permissions.ts";
import { drainSharedWork } from "./shared-work.ts";
import { type BotRecord, type GroupRecord, type Message, type MessageMurage } from "./store.ts";
import { SHARED_RESULT_DELIVERED, taskResolvable as taskCanBeAnswered, taskStatusCode, type TaskResolutionDeps } from "./task-resolution.ts";
import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

import { type ExecutionAudience } from "./work-admission.ts";
import { type HumanPrincipal } from "./human-principals.ts";
import { type ProjectCard } from "./project-records.ts";

export type EventReply = { status: number; body: unknown };

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
  startCode?: FailureCode;
  /** The target's reply rows, for the copy mirrored into the pair room. */
  copyOf?: Message["copyOf"];
};

/** What the boundary asks of the rest of the server, supplied by server/index.ts. */
export interface BoundaryPorts {
  ASK_BOT_TIMEOUT_MS: number;
  MAX_COMMS_DEPTH: 2;
  approvalBus: ApprovalBus;
  askBotAndWait: (targetBotId: string, message: string, depth: number, _fromBotId?: string, eventId?: string, coordination?: CoordinationTrace, sourceThreadId?: string, notOwnerAudience?: boolean) => Promise<AskBotOutcome>;
  beginRoomAsk: (fromBotId: string, toBotId: string, fromThreadId: string, message: string, admissionKey: string, state: "queued" | "running", onDuplicate?: (existing: RoomRequest) => void, eventId?: string) => string | undefined;
  comms: BoundaryComms;
  connectorThread: (botId: string, threadId: string) => { bot: BotRecord; group: undefined; } | { bot: BotRecord; group: GroupRecord; } | null;
  coordinationBudget: CoordinationBudget;
  coordinationHasCapacity: () => boolean;
  delegationSource: (threadId: string | undefined) => { kind: "bot"; bot: BotRecord; } | { kind: "group"; group: GroupRecord; } | null;
  delegationWatch: Map<string, { channelId?: string; toBotId: string; toBotName?: string; taskId?: string; sourceThreadId?: string; startedAtMs?: number; requestId?: string; notOwnerAudience?: boolean; }>;
  finalizingDelegations: Set<string>;
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
  settleRoomAsk: (requestId: string | undefined, outcome: { state: "done" | "failed" | "cancelled" | "expired"; resultMessageId?: string; note?: string; }) => void;
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

export type FinalizeDelegationWatchPorts = Pick<BoundaryPorts, "comms" | "delegationSource" | "delegationWatch" | "finalizingDelegations" | "markTaskContextExternallyUpdated" | "settleRoomAsk" | "store" | "rows">;
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
  const { comms, delegationSource, delegationWatch, finalizingDelegations, markTaskContextExternallyUpdated, settleRoomAsk, store , rows } = bx;
  const watched = delegationWatch.get(threadId);
  if (!watched) return false;
  delegationWatch.delete(threadId);
  // The receipt is written before any mirror short-circuits: the delegating
  // bot's check/wait_delegation must see a terminal state even when the
  // channel or target is gone.
  if (watched.taskId) finalizingDelegations.add(watched.taskId);
  const askRequestId = watched.requestId ?? (watched.taskId ? handoffRequest(database(), watched.taskId)?.id : undefined);
  // the work-authorization delivery edge (pm-sends) is checked first; the result-egress gate below then judges the text itself
  const deliverAllowed = askRequestId && watched.sourceThreadId
    ? authorizeStatus({ edge: "deliver", requestId: askRequestId, fromBotId: watched.toBotId, destinationThreadId: watched.sourceThreadId })
    : undefined;
  const deliverRefused = deliverAllowed !== undefined && !deliverAllowed.ok;
  // The reply leaves through the one result gate before the receipt, the copy into the source thread and the channel mirror: the delivery check for
  // its request (an owner's own hand-off with no request is read only when both sides are positively the owner's unshared conversations), then
  // the message-level rules. The three below take their text only from this answer; with no answer to ask for, there is no text to show.
  const gate = !deliverRefused && watched.sourceThreadId && (askRequestId || (succeeded && recorded.present))
    ? releaseStoredResult({ origin: { threadId, messageIds: recordedCopyOf?.messageIds ?? [] }, ...(askRequestId ? { requestId: askRequestId } : {}) },
      watched.toBotId, watched.sourceThreadId, { fromBotId: store.botByThread(watched.sourceThreadId)?.id ?? "" }, watched.notOwnerAudience === true, recorded.text)
    : undefined;
  const ok = deliverRefused || gate?.kind === "refused" ? false : succeeded;
  const reply: Outbound | undefined = deliverRefused ? undefined : gate?.kind === "text" ? gate.text : gate && gate.kind !== "refused" && succeeded && recorded.present ? (gate.kind === "withheld" ? gate.line : status("withheld")) : undefined;
  const failureName: Outbound = deliverRefused ? (deliverAllowed as { line: MurageStatus }).line : gate?.kind === "refused" ? gate.line : failure;
  const copyOf = gate?.kind === "text" ? gate.copyOf : undefined;
  const target = store.bot(watched.toBotId);
  const targetName = botNameOf(target?.name ?? watched.toBotName, watched.toBotId);
  const source = delegationSource(watched.sourceThreadId);
  try {
  if (watched.taskId && watched.sourceThreadId) {
    recordDelegationReceipt({
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
    });
  }
  if (source && watched.sourceThreadId) {
    let appended: Message;
    if (ok && reply) {
      appended = writeBotRow(rows, watched.sourceThreadId, {
        inboundKind: "action",
        // the result carries its request from the moment it is written, so a
        // restart before the request completes can still find it (SPEC-P 6.3)
        ...(askRequestId ? { requestId: askRequestId, actorKind: "bot" as const } : {}),
        ...(target ? { from: { botId: target.id, name: target.name, color: target.color } } : {}),
      }, status("replied_to_task", { name: targetName, reply }));
    } else {
      appended = writeActivityRow(rows, watched.sourceThreadId, askRequestId ? { requestId: askRequestId, actorKind: "murage" as const } : {}, ok ? status("delegation_completed_no_text", { name: targetName })
        : stopped ? status("delegation_stopped_early", { name: targetName })
        : status("delegation_failed_with", { name: targetName, why: failureName }), ok);
    }
    // A room turn resumes no provider session — sendTurn on the room path
    // passes no cursor and rebuilds its prompt from the transcript every
    // time — so the external-context marker has no consumer there. Unread
    // is the whole job, and it is what the room path itself sets.
    if (source.kind === "bot") markTaskContextExternallyUpdated(source.bot, watched.sourceThreadId, appended.id);
    else store.markGroupUnread(source.group.id);
    // A handoff a room turn made: its result wakes the asker (lane E1).
    if (askRequestId) {
      const ask = roomRequest(database(), askRequestId);
      // the result answers what the asker was answering, in this thread (SPEC-P 10)
      const inThread = store.messageIds(watched.sourceThreadId);
      const replyToId = ask && !appended.replyToId ? requestReplyTarget(database(), ask, (id) => inThread.has(id)) : undefined;
      if (ask?.fromBotId || replyToId) store.linkMessage(watched.sourceThreadId, appended.id, { ...(ask?.fromBotId ? { to: [ask.fromBotId] } : {}), ...(replyToId ? { replyToId } : {}) });
      settleRoomAsk(askRequestId, ok ? { state: "done", resultMessageId: appended.id } : { state: "failed", resultMessageId: appended.id, note: noteOf(stopped ? status("turn_stopped_early") : failureName) });
    }
  } else if (askRequestId) {
    settleRoomAsk(askRequestId, ok ? { state: "done" } : { state: "failed", note: noteOf(stopped ? status("turn_stopped_early") : failureName) });
  }
  } finally { if (watched.taskId) finalizingDelegations.delete(watched.taskId); }
  const channel = watched.channelId ? store.group(watched.channelId) : undefined;
  if (!target || !channel) return true;
  if (ok && reply) comms.reply(target, reply, channel, copyOf, "action");
  else if (ok) comms.activity(target, channel, status("delegated_turn_completed"), true);
  else comms.activity(target, channel, failureName, false);
  return true;
}

export type StoredAnswerForReplayPorts = Pick<BoundaryPorts, "resultEgressDeps">;
export function storedAnswerForReplay(bx: StoredAnswerForReplayPorts, answer: { threadId: string; messageId: string; requestId?: string }, who: { fromBotId: string; toBotId: string; fromThreadId: string }, notOwnerAudience: boolean): Outbound | undefined {
  const { resultEgressDeps } = bx;
  return storedAnswerText(resultEgressDeps, answer, who, notOwnerAudience);
}

/** How a shared request ended, when no answer text goes with it: a request that did not finish never reads as finished (it says how it ended, and a
 * failed one with no recorded ending reads as plainly not finished); a finished one whose answer is gone says that. */
export function sharedEndingLine(released: ReleasedResult, request: { state: RoomRequest["state"]; outcomeNote?: string | null; resultMessageId?: string | null }): MurageStatus {
  if (request.state !== "done") return statusFromNote(request.outcomeNote, "request_failed");
  return released.kind === "gone" && request.resultMessageId ? status("result_unavailable") : status("request_finished");
}

export type DeliverSharedResultPorts = Pick<BoundaryPorts, "comms" | "store" | "rows">;
export function runDeliverSharedResult(bx: DeliverSharedResultPorts, request: RoomRequest): void {
  const { comms, store , rows } = bx;
  const target = request.toBotId && store.bot(request.toBotId), destination = requestSourceThread(request.id);
  if (!target || !destination) return;
  // The result leaves through the one gate, asked again on every attempt and before the copy, the mirror and the receipt: delivery
  // authorization, then everything that can withhold the message (a forgotten source, a withheld copy origin, partition ancestry). The
  // copy, the mirror and the receipt below all take their text from this one answer.
  const released = releaseStoredResult({ requestId: request.id, ...(request.targetThreadId && request.resultMessageId ? { origin: { threadId: request.targetThreadId, messageIds: [request.resultMessageId] } } : {}) },
    target.id, destination, { fromBotId: request.fromBotId ?? "" }, request.notOwnerAudience === true);
  if (released.kind === "refused") return;
  const result = released.kind === "text" && released.copyOf ? released.text : undefined;
  const ending: Outbound = result ?? sharedEndingLine(released, request);
  // The request id is a durable delivery receipt; a terminal replay cannot copy twice.
  if (!store.hasTerminalFor(destination, request.id)) {
    const extra = { requestId: request.id, inboundKind: request.verb === "ask" ? "question" as const : "action" as const, turnTerminal: true as const, from: { botId: target.id, name: target.name, color: target.color } };
    if (result) writeBotRow(rows, destination, extra, result);
    else writeActivityRow(rows, destination, extra, ending, request.state === "done");
    if (result) comms.reply(target, result, store.group(request.groupId), result.copyOf, request.verb === "ask" ? "question" : "action");
  }
  // Delivered state lives on the row (the room_requests DDL is frozen, so the terminal row's unused
  // arbiter-refusal field carries it): the boot replays only rows still owed (N1).
  database().prepare("UPDATE room_requests SET refusal=? WHERE id=? AND state IN ('done','failed')").run(SHARED_RESULT_DELIVERED, request.id);
  recordDelegationReceipt({ id: request.id, sourceThreadId: destination, toBotId: target.id, toBotName: target.name,
    status: request.state === "done" ? "done" : "failed", result: result ?? (released.kind === "withheld" ? released.line : ending), lineage: true, requestId: request.id,
    ...(result?.copyOf ? { copyOf: { threadId: result.copyOf.threadId, messageIds: [...result.copyOf.messageIds] } } : {}) });
  comms.clearFinishing(target.id, { requestId: request.id });
}

export type DeliverCardResultPorts = Pick<BoundaryPorts, "roomMurageLine" | "roomRequestStillOwnerAudience" | "store" | "rows">;
export type CardResultDelivery = { request: RoomRequest; bot: NonNullable<ReturnType<BoundaryPorts["store"]["bot"]>>; group: NonNullable<ReturnType<BoundaryPorts["store"]["group"]>>; card: NonNullable<ReturnType<typeof projectCardById>>; threadId: string; resultId: string | undefined; reviewNonce?: string; reviewRun: RoomRequest | null };
export function runDeliverCardResult(bx: DeliverCardResultPorts, c: CardResultDelivery): void {
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
    return;
  }
  if (released.kind === "refused" || request.notOwnerAudience || !roomRequestStillOwnerAudience(request)) return;
  const result = released.kind === "text" ? released.text : undefined;
  const resultId0 = released.kind === "text" ? released.copyOf?.messageIds[0] ?? resultId! : undefined;
  const db = database();
  // the room copy answers what the card's lineage answers in the room (SPEC-P 10)
  const roomIds = store.messageIds(projectMainThread(group));
  const replyToId = requestReplyTarget(db, request, (id) => roomIds.has(id));
  const mirrored = result ? writeBotRow(rows, projectMainThread(group), { from: { botId: bot.id, name: bot.name, color: bot.color }, requestId: request.id, ...(replyToId ? { replyToId } : {}), turnTerminal: true },
    result, reviewNonce, cardRoomIds(request.id).copy) : null;
  // the corrections and the member's summary follow the result only
  // where its sources belong to this desk's partition (round 13)
  if (mirrored && result) for (const correction of store.corrections(threadId, resultId0)) {
    roomMurageLine(projectMainThread(group), correction.line, { kind: "status" }, { replyToId: mirrored.id, requestId: request.id, workItemId: card.id }, cardRoomIds(request.id).correction(correction.id));
  }
  if (result && !reviewRun) saveCardSummary(db, group.id, bot.id, result, [resultId0 as string]);
  // the card as it is now: a message forgotten while it ran made it stale
  const current = projectCardById(db, card.id) ?? card;
  const named = current.stale ? roomCardName(current) : `'${current.title}'`;
  roomMurageLine(projectMainThread(group), status("card_result_line", { desk: botNameOf(bot.name, bot.id), lead: botNameOf(store.bot(projectSettingsFor(db, group.id)?.leadBotId ?? "")?.name, "the lead"), card: botNameOf(named, "") }), { kind: "result", desk: { botId: bot.id, threadId } }, { requestId: request.id, workItemId: card.id }, cardRoomIds(request.id).line);
}

export type ReviewedCardResultPorts = Pick<BoundaryPorts, "roomRequestStillOwnerAudience">;
export function runReviewedCardResult(bx: ReviewedCardResultPorts, card: NonNullable<ReturnType<typeof projectCardById>>, group: NonNullable<ReturnType<BoundaryPorts["store"]["group"]>>): ReleasedText | null {
  const { roomRequestStillOwnerAudience } = bx;
    const id = card.resultMessageId, desk = card.deskThreadId, run = card.requestId ? roomRequest(database(), card.requestId) : null;
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

export type AskBotRouteContext = Pick<BoundaryPorts, "ASK_BOT_TIMEOUT_MS" | "MAX_COMMS_DEPTH" | "approvalBus" | "askBotAndWait" | "beginRoomAsk" | "comms" | "connectorThread" | "coordinationBudget" | "coordinationHasCapacity" | "delegationWatch" | "fullAccessSkipsPeerCard" | "internalCapabilities" | "isUnattended" | "ownerSurfacesByThread" | "resultEgressDeps" | "roomAskDuplicate" | "roomAskKey" | "roomAskParent" | "roomAskRefused" | "routinePeerSource" | "settleRoomAsk" | "sharedApprovedRequests" | "sourceExecutionAudience" | "store" | "syncAskRequests" | "taskResolutionDeps" | "waitSharedRequest" | "rows"> & Pick<RouteLocals, "eventAction" | "internalClaim" | "internalEventId" | "internalOwner" | "readInternalBody" | "requireActiveInternal" | "res">;
export async function askBotRoute(bx: AskBotRouteContext): Promise<void> {
  const { ASK_BOT_TIMEOUT_MS, MAX_COMMS_DEPTH, approvalBus, askBotAndWait, beginRoomAsk, comms, connectorThread, coordinationBudget, coordinationHasCapacity, delegationWatch, eventAction, fullAccessSkipsPeerCard, internalCapabilities, internalClaim, internalEventId, internalOwner, isUnattended, ownerSurfacesByThread, readInternalBody, requireActiveInternal, res, roomAskDuplicate, roomAskKey, roomAskParent, roomAskRefused, routinePeerSource, settleRoomAsk, sharedApprovedRequests, sourceExecutionAudience, store, syncAskRequests, waitSharedRequest , rows } = bx;
  const body = await readInternalBody();
  const fromBotId = String(body.fromBotId ?? "");
  const senderForResolution = store.bot(fromBotId);
  if (!senderForResolution) return sendBot(res, 403, botBody({ error: status("unknown_sender") }));
  const refusals = new Map<string, string>();
  const toBotId = resolveCoordinationTarget(senderForResolution, store.bots, String(body.toBotId ?? ""), (peer) => { const allowed = authorizeStatus({ edge: "peer", requesterBotId: senderForResolution.id, requesterThreadId: String(body.fromThreadId ?? defaultThreadId(senderForResolution)), targetBotId: peer.id, verb: "ask", tag: sourceExecutionAudience(senderForResolution.id, String(body.fromThreadId ?? defaultThreadId(senderForResolution))), ownerAudience: internalClaim.notOwnerAudience !== true, parentRequestId: roomAskParent(senderForResolution.id, String(body.fromThreadId ?? defaultThreadId(senderForResolution)))?.id }); if (!allowed.ok) refusals.set(peer.id, allowed.lineText); return allowed.ok || allowed.code === "shared_paused"; }, (peer) => refusals.get(peer.id)).id;
  const message = String(body.message ?? "").trim();
  const depth = Number(body.depth ?? 0) || 0;
  if (!toBotId || !message) return sendBot(res, 400, botBody({ error: status("fields_required") }));
  if (toBotId === fromBotId) return sendBot(res, 400, botBody({ error: status("cannot_message_self") }));
  if (depth >= MAX_COMMS_DEPTH) return sendBot(res, 200, botBody({ error: status("depth_exhausted") }));
  const target = store.bot(toBotId);
  if (!target) return sendBot(res, 404, botBody({ error: status("no_such_bot") }));
  // An unknown sender used to fall through: no mirroring AND no
  // approval, while still running the peer turn. That made an
  // unresolvable id the cheapest way past the gate, so it is now a
  // hard refusal — every peer turn has an accountable sender.
  const from = store.bot(fromBotId);
  if (!from) return sendBot(res, 403, botBody({ error: status("unknown_sender") }));
  const fromThreadId = String(body.fromThreadId ?? defaultThreadId(from));
  const peerAllowed = authorizeStatus({ edge: "peer", requesterBotId: from.id, requesterThreadId: fromThreadId, targetBotId: target.id, verb: "ask", tag: sourceExecutionAudience(from.id, fromThreadId), ownerAudience: internalClaim.notOwnerAudience !== true, parentRequestId: roomAskParent(from.id, fromThreadId)?.id });
  if (!peerAllowed.ok) return sendBot(res, peerAllowed.retry === "queue" ? 409 : 403, botBody({ error: peerAllowed.line, code: peerAllowed.code, retry: peerAllowed.retry }));
  // connectorThread, not taskByThread: a room thread belongs to a
  // GROUP, so a bot's own task list can never match it and every peer
  // call made from a room was refused — in the one conversation where
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
  // A busy peer used to be a flat bounce ("try again later") — a
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
    record(`delegation:${queued.id}`);
    const sharedRequestId = beginRoomAsk(fromBotId, toBotId, fromThreadId, message, `ask:delegation:${queued.id}`, "queued", undefined, internalEventId);
    if (sharedRequestId && (approvalAlreadyGranted || peerCardWaived)) sharedApprovedRequests.add(sharedRequestId);
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
    const queued = comms.enqueueShared({ fromBotId, sourceThreadId: fromThreadId, toBotId, message,
      admissionKey: roomAskKey(fromThreadId, internalClaim.generation, toBotId, message), ownerAudience: internalClaim.notOwnerAudience !== true,
      now: Date.now(), parentRequestId: roomAskParent(fromBotId, fromThreadId)?.id, tag: sourceExecutionAudience(fromBotId, fromThreadId), routineAuthority: routinePeerSource(fromThreadId, fromBotId), unattended: isUnattended(fromThreadId), ...(internalEventId ? { eventId: internalEventId } : {}) });
    // Refused before anything was queued: nothing ran, so nothing is charged.
    if (!queued.ok) { unrun(); return botReply(409, { error: queued.refusal, code: queued.code }); }
    sharedApprovedRequests.add(queued.request.id); handoffSlot.commit(); drainSharedWork(toBotId);
    if (roomRequest(database(), queued.request.id)?.state === "queued") { record(`delegation:${queued.request.id}`); return botReply(200, { busy: true, taskId: queued.request.id, toBotName: botName(currentTarget), note: status("in_line", { name: botName(currentTarget) }) }); }
    const settled = await waitSharedRequest(queued.request.id);
    requireActiveInternal();
    if (!settled) { record(`timeout:${queued.request.id}`); return botReply(200, { timeout: true, taskId: queued.request.id, toBotName: botName(currentTarget) }); }
    // The answer is handed back only through the one result gate: authorization for this request and every rule that can withhold the
    // message are asked again now, so a result since forgotten, withdrawn or no longer shareable comes back as the withheld line.
    const released = releaseStoredResult({ requestId: settled.id, ...(settled.targetThreadId && settled.resultMessageId ? { origin: { threadId: settled.targetThreadId, messageIds: [settled.resultMessageId] } } : {}) },
      toBotId, fromThreadId, { fromBotId }, internalClaim.notOwnerAudience === true);
    if (released.kind === "refused") return botReply(403, { error: released.line, code: released.code });
    const replyText: Outbound = released.kind === "text" ? released.text : released.kind === "withheld" ? released.line : sharedEndingLine(released, settled);
    if (settled.targetThreadId && settled.resultMessageId) record(`answer:${settled.targetThreadId}:${settled.resultMessageId}:${settled.id}`);
    return botReply(200, { botName: botName(currentTarget), text: replyText });
  }
  const channel = comms.channel(currentFrom, currentTarget, fromThreadId, sourceExecutionAudience(fromBotId,fromThreadId));
  comms.exchange(currentFrom, currentTarget, message, channel, fromThreadId, sourceExecutionAudience(fromBotId,fromThreadId));
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
  // Refused before the peer's turn started (no allowance, or no room for another running hand-off): nothing ran, so nothing is charged.
  try { waiting = askBotAndWait(toBotId, prefixed, depth, fromBotId, internalEventId, nextCoordination(),fromThreadId,internalClaim.notOwnerAudience === true); }
  catch (error) { if (coordinationRefusalText(error) !== undefined) unrun(); throw error; }
  if (store.bot(toBotId)?.busy) handoffSlot.commit();
  const outcome = await waiting;
  requireActiveInternal();
  if (askRequestId) {
    const allowed = authorizeStatus({ edge: "deliver", requestId: askRequestId, fromBotId: toBotId, destinationThreadId: fromThreadId });
    if (!allowed.ok) return botReply(403, { error: allowed.line, code: allowed.code });
  }
  // the ask's reply, checked against what is stored now (the request it answers, or the hand-off this conversation started)
  const releaseReply = (text: WorkerText) => releaseAskReply({ ...(outcome.copyOf ? { origin: outcome.copyOf } : {}), ...(askRequestId ? { requestId: askRequestId } : {}) },
    toBotId, fromThreadId, { fromBotId }, internalClaim.notOwnerAudience === true, text);
  const peerThreadId=comms.audienceTask(toBotId, threadHumanPrincipal(fromThreadId), sourceExecutionAudience(fromBotId, fromThreadId))!.threadId;
  if (outcome.status === "timeout" && !delegationWatch.has(peerThreadId)) {
    // The peer's turn is still running — only the wait ended. Convert
    // the ask into a delegation claim ticket: the watch mirrors the
    // terminal state into the channel AND the asker's thread when the
    // turn settles, and check/wait_delegation read the same receipt.
    // Losing the reply was the old behavior, and it read as "the bots
    // don't respond to each other".
    const taskId = newId();
    delegationWatch.set(peerThreadId, {
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
    // No partial answer to hand back — mirror the failure where the
    // exchange lives, with the provider's reason instead of silence.
    comms.activity(currentTarget, channel, status("turn_failed_note", { code: outcome.stopCode ?? "other" }), false);
    record("ended:failed");
    return botReply(200, { botName: botName(currentTarget), text: status("turn_failed", { code: outcome.stopCode ?? "other" }) });
  }
  if (outcome.status === "error") {
    // The target never ran: this is Murage's to say, never the
    // target's own words (O3). The asking bot still gets the reason.
    record("ended:error");
    comms.murageLine(channel, status("peer_could_not_start", { name: botName(currentTarget), why: outcome.startCode ?? "other" }), { kind: "failure" }, askRequestId ? { requestId: askRequestId } : {});
    return botReply(200, { botName: botName(currentTarget), text: status("could_not_start", { why: outcome.startCode ?? "other" }) });
  }
  // the answer, the copy mirrored into the pair room and the reply the asking bot reads all come from one release of the stored reply
  const answer = releaseReply(outcome.text);
  if (!answer.ok) return botReply(403, { error: answer.line, code: answer.code });
  // a turn that wrote nothing has no words to release; Murage's own placeholder stands in once the gate has allowed the delivery
  const shown: Outbound = answer.withheld || outcome.hasText ? answer.text : status(outcome.status === "timeout" ? "wait_timed_out" : "no_reply");
  const written = comms.reply(currentTarget, shown, channel, answer.withheld ? undefined : answer.copyOf);
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

/** How many of a running delegation's latest steps a bot is told. */
const RECENT_ACTIVITY_SHOWN = 5;

export type CheckDelegationRouteContext = Pick<BoundaryPorts, "connectorThread" | "resultEgressDeps" | "store" | "taskResolutionDeps"> & Pick<RouteLocals, "delegationMatch" | "internalClaim" | "requireActiveInternal" | "res" | "url">;
export async function checkDelegationRoute(bx: CheckDelegationRouteContext): Promise<void> {
  const { connectorThread, delegationMatch, internalClaim, requireActiveInternal, res, store, taskResolutionDeps, url } = bx;
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
      // The receipt is bound to its request (an older one is found by the delegation's admission key). The text goes back only through the one
      // result gate: the delivery authorization is asked again now (sharing removed since delivery returns the status and the reason, no text),
      // and a result whose original is withheld, forgotten or no longer shareable, or that a turn made as the owner's audience and a turn that
      // is not asks for, comes back as the withheld line. A receipt written before results carried their origin cannot be checked, so its text is withheld.
      const binding = resolveReceiptBinding(receipt, { byId: (id) => roomRequest(database(), id), byKey: (key) => roomRequestByKey(database(), key) });
      const released = releaseStoredResult({
        ...(receipt.copyOf ? { origin: receipt.copyOf } : {}),
        ...(binding.kind === "bound" ? { requestId: binding.requestId } : {}),
        ...(binding.kind === "mismatch" ? { binding: "mismatch" as const } : {}),
        recordedNotOwner: receipt.notOwnerAudience === true,
        ...(receipt.status === "done" && receipt.lineage !== true ? { lineageUnknown: true } : {}),
        ...(receipt.status !== "done" ? { statusOnly: true } : {}),
      }, receipt.toBotId, receipt.sourceThreadId, { fromBotId }, internalClaim.notOwnerAudience === true, receipt.result);
      const shown: Pick<BotBodyInput, "result" | "reason"> = released.kind === "text" ? { result: released.text } : released.kind === "gone" ? { result: receipt.copyOf ? status("result_unavailable") : status("nothing") }
        : released.kind === "withheld" ? { result: released.line } : released.kind === "status" ? { result: receipt.ended } : { result: released.line, reason: released.code };
      return sendBot(res, 200, botBody({ status: receipt.status, toBotName: botNameOf(receipt.toBotName, receipt.toBotId), ...shown }));
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
          // newest first, and only until the five a bot is shown are released: the work follows what is shown, not how long the turn has run
          const sealed = store.rowsFor(threadId);
          for (let at = sealed.length - 1; at >= 0 && rows.length < RECENT_ACTIVITY_SHOWN; at -= 1) {
            const message = sealed[at];
            if (message.at < startedAtMs || (message.kind !== "text" && message.kind !== "activity") || (message.kind === "text" && !withText)) continue;
            const row = releaseMessage(message, field => releaseStoredResult({ origin: { threadId, messageIds: [message.id] }, ...(watch.requestId ? { requestId: watch.requestId } : {}) },
              watch.toBotId, fromThreadId, { fromBotId }, internalClaim.notOwnerAudience === true, field.text));
            if (row) rows.unshift({ at: message.at, kind: message.kind, ...row });
          }
        }
        return sendBot(res, 200, botBody({
          status: "running",
          toBotName: botNameOf(store.bot(toBotId)?.name, toBotId),
          elapsedMs,
          elapsed: formatDelegationElapsed(elapsedMs),
          // no excerpt of what an owner-audience turn wrote reaches a turn that is not the owner's
          recentActivity: summarizeDelegatedActivity(rows, startedAtMs, RECENT_ACTIVITY_SHOWN, withText),
        }));
      }
      return sendBot(res, 200, botBody({
        status: "queued",
        toBotName: botNameOf(store.bot(toBotId)?.name, toBotId),
      }));
    }
    await new Promise((wake) => setTimeout(wake, 500));
  }
}

export type DelegateBotRouteContext = Pick<BoundaryPorts, "MAX_COMMS_DEPTH" | "beginRoomAsk" | "comms" | "connectorThread" | "coordinationBudget" | "fullAccessSkipsPeerCard" | "internalCapabilities" | "isUnattended" | "ownerSurfacesByThread" | "resultEgressDeps" | "roomAskDuplicate" | "roomAskParent" | "roomAskRefused" | "routinePeerSource" | "sourceExecutionAudience" | "store" | "taskResolutionDeps"> & Pick<RouteLocals, "eventAction" | "internalClaim" | "internalEventId" | "internalOwner" | "readInternalBody" | "res">;
export async function delegateBotRoute(bx: DelegateBotRouteContext): Promise<void> {
  const { MAX_COMMS_DEPTH, beginRoomAsk, comms, connectorThread, coordinationBudget, eventAction, fullAccessSkipsPeerCard, internalCapabilities, internalClaim, internalEventId, internalOwner, isUnattended, ownerSurfacesByThread, readInternalBody, res, roomAskDuplicate, roomAskParent, roomAskRefused, routinePeerSource, sourceExecutionAudience, store } = bx;
  const body = await readInternalBody();
  const fromBotId = String(body.fromBotId ?? "");
  const senderForResolution = store.bot(fromBotId);
  if (!senderForResolution) return sendBot(res, 403, botBody({ error: status("unknown_sender") }));
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
    // the earlier request's own outcome, whatever state it is in; never a reason to queue the work again
    if (!isTerminalRoomRequestState(repeated.state)) return sendBot(res, 200, botBody({ queued: true, taskId: repeated.id, message: status("handed_over_turn", { name: botName(target) }) }));
    const receipt = findDelegationReceipt(repeated.id);
    return sendBot(res, 200, botBody({ queued: true, taskId: repeated.id, done: true, status: receipt?.status ?? repeated.state, message: status("handed_over_turn_done", { name: botName(target) }) }));
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
    // the agent reads this string — a bare enum ("too_deep") tells it
    // nothing about what to do instead
    const said: Record<Exclude<QueueResult, "ok">, MurageStatus> = {
      self: status("cannot_delegate_self"),
      too_deep: status("depth_exhausted_delegate"),
      no_target: status("no_such_bot"),
      too_many: status("too_many_delegations"),
      source_deleted: status("source_conversation_deleted"),
    };
    return botReply(200, { error: said[queued.result === "ok" ? "no_target" : queued.result] });
  }
  handoffSlot.commit();
  record(`delegation:${queued.id}`);
  // its result comes back to this bot's room turn (lane E1)
  beginRoomAsk(fromBotId, toBotId, fromThreadId, message, `ask:delegation:${queued.id}`, "queued", undefined, internalEventId);
  const targetName = botNameOf(store.bot(toBotId)?.name, toBotId);
  return botReply(200, {
    queued: true,
    taskId: queued.id,
    message: from.approvePeerComms && !peerCardWaived ? status("queued_for_review", { name: targetName }) : status("delegation_queued", { name: targetName }),
  });
  } finally { handoffSlot.release(); }
  });
  return sendBot(res, delegated.status, delegated.body);
}

