// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the hand-off boundary (server/handoff-boundary.ts) is allowed to hold of the server. The boundary gets these narrow ports and never the
// store, the comms bus or a string-to-status wrapper:
//   BoundaryStore  reads the records it needs; a stored row comes back sealed (`WorkerMessage`: its words are `WorkerText`), and the only
//                  non-text write is linking a row to what it answers. There is no way to write or change a row's words through it.
//   BoundaryComms  the pair room, the mirrors, the delegation queue and the shared queue, each taking `Outbound` words (released text or a Murage
//                  status), never a string of a worker's.
// This is the one module that turns a stored row into sealed words, and it never forwards them: the boundary hands them to the result gate.
import { getOrCreateChannel, mirrorActivity, mirrorExchange, mirrorMurageLine, mirrorReply, type CommsBus } from "./comms-visibility.ts";
import { dropQueuedDelegation, queueDelegation, type DelegationItem, type DelegationReceipt, type QueuedDelegation } from "./delegations.ts";
import { audienceTask } from "./execution-audience.ts";
import { refusalStatus } from "./host-words.ts";
import { WorkerText } from "./released-text.ts";
import { fixedStatus } from "./bot-read.ts";
import { botName, botNameOf, cardTitle, outboundWords, statusFromNote, statusFromStored, type BotName, type CardTitle, type MurageStatus, type Outbound } from "./murage-status.ts";
import { database } from "./database.ts";
import { projectCardById, projectSettingsFor, type ProjectCard } from "./project-records.ts";
import { roomCardName } from "./project-prompt.ts";
import { requestReplyTarget, roomRequest, roomRequestByKey } from "./room-requests.ts";
import { requestEnding } from "./room-request-status.ts";
import { SHARED_RESULT_DELIVERED } from "./task-resolution.ts";
import { resolveTask, type ResolvedTask, type TaskCaller, type TaskResolutionDeps } from "./task-resolution.ts";
import { clearSharedFinishing, enqueueSharedWork } from "./shared-work.ts";
import type { RoomRequest } from "./room-requests.ts";
import type { BotRecord, GroupRecord, Message, MessageMurage, Store } from "./store.ts";
import type { WorkerMessage } from "./worker-message.ts";
import type { ExecutionAudience } from "./work-admission.ts";
import type { HumanPrincipal } from "./human-principals.ts";

/** Does this row record a step that failed or is being retried? Such a row is told to a bot as the kind of failure, never as its own words. */
function failureOf(message: Message): WorkerMessage["failure"] {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return undefined;
  if (/^\s*retrying\b/i.test(tool.name)) return "retrying";
  if (tool.ok === false || /^\s*error\b/i.test(tool.name) || tool.errorDetails !== undefined || tool.errorKind !== undefined || tool.providerError !== undefined || tool.localFailure !== undefined) return "error";
  return undefined;
}

export function sealMessage(message: Message): WorkerMessage {
  const failure = failureOf(message);
  return {
    id: message.id,
    at: message.at,
    role: message.role,
    kind: message.kind,
    ...(message.requestId ? { requestId: message.requestId } : {}),
    ...(message.turnTerminal ? { turnTerminal: true } : {}),
    ...(message.actorKind ? { actorKind: message.actorKind } : {}),
    ...(message.replyToId ? { replyToId: message.replyToId } : {}),
    ...(message.text !== undefined ? { text: new WorkerText(message.text) } : {}),
    ...(message.tool ? { tool: { name: new WorkerText(message.tool.name), ...(message.tool.ok === undefined ? {} : { ok: message.tool.ok }) } } : {}),
    ...(failure ? { failure } : {}),
  };
}

export interface BoundaryStore {
  bot(id: string): BotRecord | undefined;
  botByThread(threadId: string): BotRecord | undefined;
  readonly bots: BotRecord[];
  group(id: string): GroupRecord | undefined;
  /** The one write: the group shows as unread. */
  markGroupUnread(groupId: string): void;
  /** The other: a row says who it is for and what it answers. Never its words. */
  linkMessage(threadId: string, messageId: string, link: { to?: string[]; replyToId?: string }): void;
  /** Is this id a row of the conversation? One keyed read, never the conversation. */
  hasMessage(threadId: string, messageId: string): boolean;
  /** Has the turn that answered this request already written its closing row here? Looked for among the rows written since the request was
   * made (a keyed range), never the conversation. */
  hasTerminalFor(threadId: string, request: Pick<RoomRequest, "id" | "createdAt">): boolean;
  /** The request's closing row in `threadId`, when it is there: its id (the shared delivery wakes its asker at it, again after a crash) and whether
   * it is the no-answer line (that answer is final: a delivery asked again keeps it, NOHOLD-DELEGATION.md). */
  terminalFor(threadId: string, request: Pick<RoomRequest, "id" | "createdAt">): { id: string; noAnswer: boolean } | undefined;
  /** A conversation's rows written at or after `sinceMs`, newest first, each sealed only when it is reached. Rows are kept in time order, so the
   * walk stops at the first older row: what it touches follows the work since then, never the conversation's length. */
  rowsSince(threadId: string, sinceMs: number): Iterable<WorkerMessage>;
  /** A bot's name from its record (its id when the record is gone). Only a bot id goes in, never a name. */
  nameOf(botId: string): BotName;
  /** The request records the routes read (never their text fields' words: the gate reads those). */
  roomRequest(id: string): RoomRequest | null;
  roomRequestByKey(key: string): RoomRequest | null;
  /** The message a request's result answers in a conversation (SPEC-P 10). */
  replyTarget(request: RoomRequest, inThread: (id: string) => boolean): string | undefined;
  /** How a request ended, as Murage's own line, or undefined when none was kept. */
  requestEnding(request: RoomRequest): MurageStatus | undefined;
  /** A shared request's result reached its asker (the boot replays only rows still owed). */
  markSharedDelivered(requestId: string): void;
  /** A project card as stored now, its title as a card title, and the project's lead's name. */
  projectCard(id: string): ProjectCard | null;
  cardTitle(card: ProjectCard): CardTitle;
  leadName(groupId: string): BotName;
  /** The released words of a card's result, kept for the member's next prompt. */
  saveCardSummary(groupId: string, botId: string, summary: Outbound, sources: string[]): void;
  /** Murage's own "On record:" lines that answer a message, sealed: they quote what was corrected, so they leave only through the result gate. */
  /** The criteria corrections of a line, as their statuses (LINEAGE-DESIGN-S6 rules 16 and 21): read through the door's fixed copy, never
   * the row's stored words; a legacy correction with no stored status is none. */
  corrections(threadId: string, replyToId: string | undefined): Array<{ id: string; status: MurageStatus }>;
}

/** Newest first, back to `sinceMs`, sealing each row only when the walk reaches it. The rows are read by the store's range read from that moment
 * (Store.scanSince), never the conversation. */
function* rowsSince(store: Store, threadId: string, sinceMs: number): Iterable<WorkerMessage> {
  const newestFirst: Message[] = [];
  store.scanSince(threadId, sinceMs, message => { newestFirst.push(message); return false; });
  for (const message of newestFirst) yield sealMessage(message);
}

export function boundaryStore(store: Store): BoundaryStore {
  return {
    bot: id => store.bot(id) ?? undefined,
    botByThread: threadId => store.botByThread(threadId) ?? undefined,
    get bots() { return store.bots; },
    group: id => store.group(id) ?? undefined,
    markGroupUnread: groupId => { store.patchGroup(groupId, { unread: true }); },
    linkMessage: (threadId, messageId, link) => { store.patchMessage(threadId, messageId, { ...(link.to ? { to: link.to } : {}), ...(link.replyToId ? { replyToId: link.replyToId } : {}) }); },
    hasMessage: (threadId, messageId) => store.messageById(threadId, messageId) !== undefined,
    // a row of a request is written after the request was made: looked for among the rows since then (a minute of slack for clocks)
    hasTerminalFor: (threadId, request) => store.scanSince(threadId, Math.max(0, request.createdAt - 60_000), message => message.requestId === request.id && Boolean(message.turnTerminal)),
    terminalFor: (threadId, request) => {
      let found: { id: string; noAnswer: boolean } | undefined;
      store.scanSince(threadId, Math.max(0, request.createdAt - 60_000), message => {
        if (message.requestId !== request.id || !message.turnTerminal) return false;
        found = { id: message.id, noAnswer: (message.murage?.status as { key?: string } | undefined)?.key === "no_answer_checking" };
        return true;
      });
      return found;
    },
    rowsSince: (threadId, sinceMs) => rowsSince(store, threadId, sinceMs),
    // a bot whose record is gone is named by a fixed word, never by the string that was asked about
    nameOf: botId => { const bot = store.bot(botId); return bot ? botName(bot) : botNameOf({ name: "a bot no longer on the roster" }, ""); },
    roomRequest: id => roomRequest(database(), id),
    roomRequestByKey: key => roomRequestByKey(database(), key),
    replyTarget: (request, inThread) => requestReplyTarget(database(), request, inThread),
    requestEnding: request => requestEnding(database(), request),
    markSharedDelivered: requestId => { database().prepare("UPDATE room_requests SET refusal=? WHERE id=? AND state IN ('done','failed')").run(SHARED_RESULT_DELIVERED, requestId); },
    projectCard: id => projectCardById(database(), id),
    cardTitle: card => card.stale ? cardTitle(card, () => roomCardName(card)) : cardTitle(card),
    leadName: groupId => { const lead = projectSettingsFor(database(), groupId)?.leadBotId; return lead && store.bot(lead) ? botNameOf(store.bot(lead), lead) : botNameOf({ name: "the lead" }, ""); },
    saveCardSummary: (groupId, botId, summary, sources) => saveCardSummary(database(), groupId, botId, summary, sources),
    // a correction is written after the line it corrects: looked for among the rows since that line
    corrections: (threadId, replyToId) => {
      const corrected = replyToId === undefined ? undefined : store.messageById(threadId, replyToId);
      if (!corrected) return [];
      const found: Array<{ id: string; status: MurageStatus }> = [];
      store.scanSince(threadId, corrected.at, message => {
        const line = message.replyToId === replyToId ? fixedStatus(message) : undefined;
        if (line?.key === "criteria_claim_corrected") found.push({ id: message.id, status: line });
        return false;
      });
      return found.reverse();
    },
  };
}

export type SharedEnqueueInput = Parameters<typeof enqueueSharedWork>[1];
export type SharedEnqueueResult =
  | { ok: true; request: RoomRequest }
  | { ok: false; code: string; refusal: MurageStatus };

export interface BoundaryComms {
  channel(from: BotRecord, target: BotRecord, sourceThreadId: string, audience: ExecutionAudience | null | undefined): GroupRecord;
  exchange(from: BotRecord, target: BotRecord, message: string, channel: GroupRecord | undefined, sourceThreadId: string, audience: ExecutionAudience | null | undefined): string | undefined;
  reply(target: BotRecord, reply: Outbound, channel: GroupRecord | undefined, copyOf?: Message["copyOf"], inboundKind?: "action" | "question"): string | undefined;
  murageLine(channel: GroupRecord | undefined, text: Outbound, murage: MessageMurage, lineage?: { requestId?: string; replyToId?: string }): void;
  activity(from: BotRecord, channel: GroupRecord | undefined, name: Outbound, ok: boolean): void;
  queueDelegation(from: BotRecord, item: DelegationItem, maxDepth: number, sourceThreadId: string): QueuedDelegation;
  /** Drops a direct hand-off just queued whose asker wake could not be kept on disk (NOHOLD-DELEGATION.md); false once it is draining or gone. */
  dropQueuedDelegation(id: string, reason: Outbound): boolean;
  enqueueShared(input: SharedEnqueueInput): SharedEnqueueResult;
  clearFinishing(botId: string, identity: { requestId?: string; generation?: string }): void;
  audienceTask(botId: string, principal: HumanPrincipal, tag: ExecutionAudience | null): { threadId: string } | null;
}

export function boundaryComms(bus: CommsBus): BoundaryComms {
  const store = bus.store;
  return {
    channel: (from, target, sourceThreadId, audience) => getOrCreateChannel(store, from, target, sourceThreadId, audience),
    exchange: (from, target, message, channel, sourceThreadId, audience) => mirrorExchange(bus, from, target, message, channel, sourceThreadId, audience),
    reply: (target, reply, channel, copyOf, inboundKind) => mirrorReply(bus, target, reply, channel, copyOf, inboundKind),
    murageLine: (channel, text, murage, lineage) => mirrorMurageLine(bus, channel, text, murage, lineage),
    activity: (from, channel, name, ok) => mirrorActivity(bus, from, channel, name, ok),
    queueDelegation: (from, item, maxDepth, sourceThreadId) => queueDelegation(bus, from, item, maxDepth, sourceThreadId),
    dropQueuedDelegation: (id, reason) => dropQueuedDelegation(bus, id, reason),
    enqueueShared: input => {
      const queued = enqueueSharedWork(store, input);
      if (queued.ok) return { ok: true, request: queued.request };
      return { ok: false, code: queued.code, refusal: refusalStatus({ code: queued.code, ...("line" in queued && typeof queued.line === "string" ? { line: queued.line } : {}) }) };
    },
    clearFinishing: (botId, identity) => clearSharedFinishing(store, botId, identity),
    audienceTask: (botId, principal, tag) => audienceTask(store, botId, principal, tag),
  };
}

// The refusal and approval lines the boundary reads are already statuses: it asks for them here instead of wrapping strings itself.
export { authorizeStatus, peerApprovalStatus } from "./host-words.ts";

/** A delegation receipt as the boundary reads it: its words sealed, and the way it ended already decoded to one of Murage's own lines. */
export type SealedReceipt = Omit<DelegationReceipt, "result" | "resultStatus"> & { result?: WorkerText; ended: MurageStatus };
export type SealedTask = Exclude<ResolvedTask, { kind: "receipt" }> | { kind: "receipt"; receipt: SealedReceipt };

/** `resolveTask`, with a finished receipt's text sealed. A receipt of how a request ended is read as one of Murage's lines: a newer one kept the
 * line's key, an older one kept free text that is never repeated to a bot. */
export function resolveTaskSealed(taskId: string, caller: TaskCaller | undefined, deps: TaskResolutionDeps): SealedTask | null {
  const resolved = resolveTask(taskId, caller, deps);
  if (!resolved || resolved.kind !== "receipt") return resolved as Exclude<ResolvedTask, { kind: "receipt" }> | null;
  const { result, resultStatus, ...rest } = resolved.receipt;
  return { kind: "receipt", receipt: { ...rest, ...(result === undefined ? {} : { result: new WorkerText(result) }), ended: statusFromStored(resultStatus?.key, resultStatus?.data) ?? statusFromNote(result, "request_failed") } };
}

/** The card summary a project member keeps for its next prompt: the released words of the card's result, saved with their sources. */
function saveCardSummary(db: { prepare(sql: string): { run(...args: unknown[]): unknown } }, groupId: string, botId: string, summary: Outbound, sources: string[]): void {
  db.prepare(`INSERT INTO project_member_state(group_id,bot_id,last_card_summary,last_card_summary_sources,stale,updated_at)
      VALUES(?,?,?,?,0,?) ON CONFLICT(group_id,bot_id) DO UPDATE SET last_card_summary=excluded.last_card_summary,
      last_card_summary_sources=excluded.last_card_summary_sources,stale=0,updated_at=excluded.updated_at`)
    .run(groupId, botId, outboundWords(summary).slice(0, 2000), JSON.stringify(sources), Date.now());
}
