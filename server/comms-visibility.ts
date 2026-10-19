import { teamLabel } from "./team-identities.ts";
import { MurageStatus, outboundCopy, outboundWords, status, statusRecordOf, type Outbound } from "./murage-status.ts";
import { ReleasedText } from "./released-text.ts";
import type { ExecutionAudience } from "./work-admission.ts";
import { audienceTask, defaultThreadId, issueExecutionAudience, issueWorkAudience, threadPartition } from "./execution-audience.ts";
import { threadHumanPrincipal, assertHumanPrincipal, bindHumanThread } from "./human-principals.ts";
// Bot⇄bot comms visibility: channel creation, message mirroring, and
// per-thread chips. Extracted from /api/internal/ask-bot so delegations
// (delegate_bot) and any future peer flow reuse the same UX without a copy.

import { sectionKey, type BotRecord, type GroupRecord, type Message, type MessageMurage, type Store } from "./store.ts";
import { murageLine } from "./murage-line.ts";

/** What a peer-exchange helper needs from the outside world:
 * the store (for persisted messages + groups) and the SSE broadcasters
 * so chat clients see the change without waiting for a refresh. */
export interface CommsBus {
  store: Store;
  /** The provider turn running in a conversation now (internal-capabilities.ts providerTurnOf), from the server's own turn state, never a request.
   * The room copy of a bot's outgoing message names it, so revoking that turn's inputs withholds the copy. */
  turnOf?: (threadId: string) => string | undefined;
  /** The durable ask:delegation record of a handoff when a room turn made it (a room request, or shared work), made in the transaction that queues
   * it. Returns who owns the request side: `room`, `shared`, or `owner` (an owner-conversation handoff has no record: its queue row is all there is). */
  prepareDelegation?(fromBotId: string, toBotId: string, sourceThreadId: string, message: string, requestId: string): "owner" | "room" | "shared" | void;
  /** Admission capacity, independent of how many handoffs are queued. */
  canDispatch?: () => boolean;
  /** Could a handoff from `sourceThreadId` start on this bot RIGHT NOW?
   *
   * The question delegation admission has to ask is the one the dispatch
   * itself asks: is the ONE thread the handoff would run on free, is no room
   * turn holding the bot, and is it under the three-thread limit. A bot is
   * `busy` the moment any one of its threads is working, and a bot busy on a
   * routine in a detached task thread can still take a handoff in the thread
   * the handoff actually uses.
   *
   * Optional so an embedder that has no thread bookkeeping (and every test
   * that fakes this bus) keeps the older, stricter bot-wide behaviour.
   * `destinationThreadId` is the conversation the hand-off is stored for: the question is asked of THAT one, never of one resolved again. */
  canStartHandoff?: (botId: string, sourceThreadId: string, destinationThreadId?: string) => boolean;
  /** Is a turn of this hand-off still running on the conversation it was started in? Send again asks before it sends the same work a second time. */
  handoffRunning?: (threadId: string, handoffId: string) => boolean;
  /** SSE broadcast (kind: "message" envelope). */
  broadcast: (payload: Record<string, unknown>) => void;
  /** SSE broadcast (kind: "group" envelope) for a single group. */
}

/** Find or create the bot⇄bot channel for the pair. The channel keeps
 * the pair's full exchange, lives in the sidebar like any room, and the
 * user can open it to chip in. */
export function getOrCreateChannel(store: Store, from: BotRecord, target: BotRecord, sourceThreadId=defaultThreadId(from), audience?: ExecutionAudience | null): GroupRecord {
  const tag = audience === undefined ? issueWorkAudience(from.id, target.id, sourceThreadId, issueExecutionAudience(from.id, sourceThreadId, sourceThreadId), sourceThreadId, true) : audience;
  // A partitioned bot asking from a room(G) turn (NULL tag) files the exchange under room(G), never home (L2).
  const source = !tag && from.partitionedAt !== undefined ? threadPartition(from, sourceThreadId) : undefined;
  const dmAudience: GroupRecord["dmAudience"] = tag?.kind === "team" ? { kind: "team", teamId: tag.team } : tag?.kind === "project" ? { kind: "project", groupId: tag.projectId } : source?.kind === "room" ? { kind: "room", groupId: source.groupId } : undefined;
  const principal=threadHumanPrincipal(sourceThreadId);assertHumanPrincipal(principal);
  const existing = store.groups.find(group=>JSON.stringify(group.dmAudience)===JSON.stringify(dmAudience)&&group.dm&&group.memberIds.length===2&&group.memberIds.includes(from.id)&&group.memberIds.includes(target.id)&&JSON.stringify(threadHumanPrincipal(group.threadId))===JSON.stringify(principal));
  if (existing) {
    if (!existing.dmAudience && sectionKey(existing.section) !== sectionKey(from.section)) {
      return store.patchGroup(existing.id, { section: from.section }) ?? existing;
    }
    return existing;
  }
  const group=store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true, dmAudience?.kind === "team" ? teamLabel(dmAudience.teamId) ?? from.section : dmAudience?.kind === "project" || dmAudience?.kind === "room" ? store.group(dmAudience.groupId)?.section : from.section, undefined, dmAudience);
  bindHumanThread(group.threadId,principal);
  return group;
}

/** The source row of a queued hand-off's message (see mirrorExchange): the sender's "Messaged" row written when it was queued, or none for a queue
 * item from before it was kept. */
export type QueuedSource = { sourceMessageId: string | undefined };

/** The sender's "Messaged @target" row: its own activity, the engine row of the turn that sent the message (LINEAGE-DESIGN-S6 rule 6), so the
 * line's lineage keeps that turn. `turnId` is the provider turn that sent it, none when no turn ran. */
export function messagedRow(from: BotRecord, target: BotRecord, turnId: string | undefined, comm?: Message["comm"]): Omit<Message, "id" | "at"> {
  return {
    role: "bot",
    kind: "activity",
    tool: { name: `Messaged @${target.name}` },
    from: { botId: from.id, name: from.name, color: from.color },
    ...(turnId ? { turnId } : {}),
    ...(comm ? { comm } : {}),
  };
}

/** Mirror `from`'s outgoing message into the channel, drop chips into
 * both 1:1 threads linking to the channel, and bump the channel's unread
 * count. The chips are what make bot-to-bot turns observable — those
 * turns cost the user tokens, and a hidden exchange is exactly the kind
 * of mistake peer coordination is supposed to avoid. Returns the source row's id (the sender's "Messaged" row a hand-off's prompt names by
 * `handoffOf`, LINEAGE-DESIGN-S6 rule 7), none for a legacy queue item. */
export function mirrorExchange(
  bus: CommsBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  channel: GroupRecord | undefined,
  sourceThreadId = defaultThreadId(from),
  audience?: ExecutionAudience | null,
  inboundKind: "action" | "question" = "question",
  /** A queued hand-off: its source row was written when it was queued (delegations.ts queueDelegation), so the turn running in the source thread
   * now is not its author. Omitted (an immediate send): the source row is written now, naming the turn running now. */
  queued?: QueuedSource,
): string | undefined {
  const comm = channel ? { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color } : undefined;
  let sourceId: string | undefined;
  if (!queued) sourceId = bus.store.appendMessage(sourceThreadId, messagedRow(from, target, bus.turnOf?.(sourceThreadId), comm)).id;
  else if (queued.sourceMessageId) {
    sourceId = queued.sourceMessageId;
    // the row was written before the room existed: it now links to it
    if (comm) bus.store.patchMessage(sourceThreadId, sourceId, { comm });
  } else {
    // a queue item from before the source row was kept: Murage's chip about the exchange, as it was written then
    bus.store.appendMessage(sourceThreadId, murageLine({ role: "bot", kind: "activity", tool: { name: `Messaged @${target.name}` },
      ...(bus.store.groupByThread(sourceThreadId) ? { from: { botId: from.id, name: from.name, color: from.color } } : {}), ...(comm ? { comm } : {}) }));
  }
  if (channel) {
    // the room copy is the sender's bot row naming its source row (rules 5 and 6); with no source row to name, Murage's withheld line
    if (sourceId) bus.store.appendMessage(channel.threadId, { role: "bot", kind: "text", text: message, inboundKind, from: { botId: from.id, name: from.name, color: from.color }, copyOf: { threadId: sourceThreadId, messageIds: [sourceId] } });
    else mirrorMurageLine(bus, channel, status("withheld"), { kind: "failure" });
  }
  const targetTask=audienceTask(bus.store,target.id,threadHumanPrincipal(sourceThreadId), audience === undefined ? issueWorkAudience(from.id, target.id, sourceThreadId, issueExecutionAudience(from.id, sourceThreadId, sourceThreadId), sourceThreadId, true) : audience);
  if(!targetTask)throw new Error("HUMAN_TASK_UNAVAILABLE");
  // Murage's chip in the target's conversation about the exchange, never a turn's engine output (murage-line.ts)
  bus.store.appendMessage(targetTask.threadId, murageLine({
    role: "bot",
    kind: "activity",
    tool: { name: `Message from @${from.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: from.id, withName: from.name, withColor: from.color }
      : undefined,
  }));
  if (channel) {
    bus.store.patchGroup(channel.id, { unread: true });
  }
  return sourceId;
}

/** Mirror `target`'s reply into the channel so the channel stays the
 * single authoritative record of the exchange. The 1:1 threads already
 * carry their own chips from `mirrorExchange`. `copyOf` names the original
 * reply, so the copy is withheld from bots whenever the original is. */
export function mirrorReply(
  bus: CommsBus,
  target: BotRecord,
  reply: Outbound,
  channel: GroupRecord | undefined,
  copyOf?: Message["copyOf"],
  inboundKind: "action" | "question" = "question",
): string | undefined {
  const words = outboundWords(reply);
  if (!channel || !words.trim()) return undefined;
  // A copy of a worker's words is written only with the link to its original; without one the channel gets Murage's withheld line instead.
  const quotesWorker = ReleasedText.is(reply) || (MurageStatus.is(reply) && reply.quotes.length > 0);
  // the copyOf it uses, the caller's or the one the reply carries, is the one stored (LINEAGE-DESIGN-S6 rule 8)
  const effective = copyOf?.messageIds.length ? copyOf : outboundCopy(reply);
  if (quotesWorker && !effective?.messageIds.length) {
    mirrorMurageLine(bus, channel, status("withheld"), { kind: "failure" });
    return undefined;
  }
  // a copy is the target's own bot row, resting on its original through copyOf (rule 5); a status line that quotes no worker is Murage's
  const row: Omit<Message, "id" | "at"> = {
    role: "bot",
    kind: "text",
    text: words,
    inboundKind,
    from: { botId: target.id, name: target.name, color: target.color },
    ...(effective?.messageIds.length ? { copyOf: { threadId: effective.threadId, messageIds: [...effective.messageIds] } } : {}),
  };
  const written = bus.store.appendMessage(channel.threadId, row.copyOf ? row : murageLine(row));
  bus.store.patchGroup(channel.id, { unread: true });
  return written.id;
}

/** A line from Murage itself in the channel: no sender, so it never reads
 * as a bot's own words, and never folded away with tool calls (0.1.61 lane
 * T, O3). For what went wrong around a bot, not what the bot said. */
export function mirrorNotice(bus: CommsBus, channel: GroupRecord | undefined, name: Outbound): void {
  mirrorMurageLine(bus, channel, name, { kind: "failure" });
}

/** A Murage line in envelope v2 (SPEC-P 10): no `from` (mirrorReply always
 * names the target, so it cannot write one), `actorKind: "murage"`, what the
 * row offers in `murage`, and the request it belongs to. */
export function mirrorMurageLine(
  bus: CommsBus,
  channel: GroupRecord | undefined,
  text: Outbound,
  murage: MessageMurage,
  lineage: { requestId?: string; replyToId?: string } = {},
): void {
  if (!channel) return;
  const kept = statusRecordOf(text);
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: outboundWords(text), ok: murage.kind !== "failure" && murage.kind !== "cap" },
    actorKind: "murage",
    murage: kept ? { ...murage, status: kept } : murage,
    ...(lineage.requestId ? { requestId: lineage.requestId } : {}),
    ...(lineage.replyToId ? { replyToId: lineage.replyToId } : {}),
  });
  bus.store.patchGroup(channel.id, { unread: true });
}

/** Mirror a terminal activity note into the channel — for async handoffs
 * whose terminal state is not a reply (turn failed, was stopped, or never
 * started). Prior art (A2A, MCP Tasks) is unanimous that every terminal
 * state of an async handoff should be visible where the human is looking,
 * and the channel is that place. */
export function mirrorActivity(
  bus: CommsBus,
  from: BotRecord,
  channel: GroupRecord | undefined,
  name: Outbound,
  ok: boolean,
): void {
  if (!channel) return;
  const kept = statusRecordOf(name);
  bus.store.appendMessage(channel.threadId, murageLine({
    role: "bot",
    kind: "activity",
    tool: { name: outboundWords(name), ok },
    from: { botId: from.id, name: from.name, color: from.color },
    ...(kept ? { murage: { kind: ok ? "status" as const : "failure" as const, status: kept } } : {}),
  }));
  bus.store.patchGroup(channel.id, { unread: true });
}
