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
import { queueDelegation, type DelegationItem, type DelegationReceipt, type QueuedDelegation } from "./delegations.ts";
import { audienceTask } from "./execution-audience.ts";
import { hostLine, refusalStatus } from "./host-words.ts";
import { WorkerText } from "./released-text.ts";
import { outboundWords, statusFromNote, statusFromStored, type MurageStatus, type Outbound } from "./murage-status.ts";
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
  /** The ids in a conversation. */
  messageIds(threadId: string): Set<string>;
  /** Has the turn that answered this request already written its closing row here? */
  hasTerminalFor(threadId: string, requestId: string): boolean;
  /** A conversation's rows, with their words sealed. */
  rowsFor(threadId: string): WorkerMessage[];
  /** Murage's own "On record:" lines that answer a message (counts of what was corrected), as statuses. */
  corrections(threadId: string, replyToId: string | undefined): Array<{ id: string; line: MurageStatus }>;
}

export function boundaryStore(store: Store): BoundaryStore {
  return {
    bot: id => store.bot(id) ?? undefined,
    botByThread: threadId => store.botByThread(threadId) ?? undefined,
    get bots() { return store.bots; },
    group: id => store.group(id) ?? undefined,
    markGroupUnread: groupId => { store.patchGroup(groupId, { unread: true }); },
    linkMessage: (threadId, messageId, link) => { store.patchMessage(threadId, messageId, { ...(link.to ? { to: link.to } : {}), ...(link.replyToId ? { replyToId: link.replyToId } : {}) }); },
    messageIds: threadId => new Set(store.messagesFor(threadId).map(message => message.id)),
    hasTerminalFor: (threadId, requestId) => store.messagesFor(threadId).some(message => message.requestId === requestId && message.turnTerminal),
    rowsFor: threadId => store.messagesFor(threadId).map(sealMessage),
    corrections: (threadId, replyToId) => store.messagesFor(threadId)
      .filter(message => message.actorKind === "murage" && message.replyToId === replyToId && message.tool?.name.startsWith("On record:"))
      .map(message => ({ id: message.id, line: hostLine(message.tool!.name) })),
  };
}

export type SharedEnqueueInput = Parameters<typeof enqueueSharedWork>[1];
export type SharedEnqueueResult =
  | { ok: true; request: RoomRequest }
  | { ok: false; code: string; refusal: MurageStatus };

export interface BoundaryComms {
  channel(from: BotRecord, target: BotRecord, sourceThreadId: string, audience: ExecutionAudience | null | undefined): GroupRecord;
  exchange(from: BotRecord, target: BotRecord, message: string, channel: GroupRecord | undefined, sourceThreadId: string, audience: ExecutionAudience | null | undefined): void;
  reply(target: BotRecord, reply: Outbound, channel: GroupRecord | undefined, copyOf?: Message["copyOf"], inboundKind?: "action" | "question"): string | undefined;
  murageLine(channel: GroupRecord | undefined, text: Outbound, murage: MessageMurage, lineage?: { requestId?: string; replyToId?: string }): void;
  activity(from: BotRecord, channel: GroupRecord | undefined, name: Outbound, ok: boolean): void;
  queueDelegation(from: BotRecord, item: DelegationItem, maxDepth: number, sourceThreadId: string): QueuedDelegation;
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
export function saveCardSummary(db: { prepare(sql: string): { run(...args: unknown[]): unknown } }, groupId: string, botId: string, summary: Outbound, sources: string[]): void {
  db.prepare(`INSERT INTO project_member_state(group_id,bot_id,last_card_summary,last_card_summary_sources,stale,updated_at)
      VALUES(?,?,?,?,0,?) ON CONFLICT(group_id,bot_id) DO UPDATE SET last_card_summary=excluded.last_card_summary,
      last_card_summary_sources=excluded.last_card_summary_sources,stale=0,updated_at=excluded.updated_at`)
    .run(groupId, botId, outboundWords(summary).slice(0, 2000), JSON.stringify(sources), Date.now());
}
