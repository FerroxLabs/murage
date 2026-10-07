import { teamLabel } from "./team-identities.ts";
import type { ExecutionAudience } from "./work-admission.ts";
import { audienceTask, defaultThreadId, issueExecutionAudience, issueWorkAudience, threadPartition } from "./execution-audience.ts";
import { threadHumanPrincipal, assertHumanPrincipal, bindHumanThread } from "./human-principals.ts";
// Bot⇄bot comms visibility: channel creation, message mirroring, and
// per-thread chips. Extracted from /api/internal/ask-bot so delegations
// (delegate_bot) and any future peer flow reuse the same UX without a copy.

import { sectionKey, type BotRecord, type GroupRecord, type Message, type MessageMurage, type Store } from "./store.ts";

/** What a peer-exchange helper needs from the outside world:
 * the store (for persisted messages + groups) and the SSE broadcasters
 * so chat clients see the change without waiting for a refresh. */
export interface CommsBus {
  store: Store;
  /** Durable request admission precedes the delegation JSON save. */
  prepareDelegation?(fromBotId: string, toBotId: string, sourceThreadId: string, message: string, requestId: string): void;
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
   * that fakes this bus) keeps the older, stricter bot-wide behaviour. */
  canStartHandoff?: (botId: string, sourceThreadId: string) => boolean;
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

/** Mirror `from`'s outgoing message into the channel, drop chips into
 * both 1:1 threads linking to the channel, and bump the channel's unread
 * count. The chips are what make bot-to-bot turns observable — those
 * turns cost the user tokens, and a hidden exchange is exactly the kind
 * of mistake peer coordination is supposed to avoid. */
export function mirrorExchange(
  bus: CommsBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  channel: GroupRecord | undefined,
  sourceThreadId = defaultThreadId(from),
  audience?: ExecutionAudience | null,
  inboundKind: "action" | "question" = "question",
): void {
  const note = (threadId: string, m: Omit<Message, "id" | "at">) => {
    bus.store.appendMessage(threadId, m);
    return message;
  };
  if (channel) {
    note(channel.threadId, {
      role: "bot",
      kind: "text",
      text: message,
      inboundKind,
      from: { botId: from.id, name: from.name, color: from.color },
    });
  }
  note(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Messaged @${target.name}` },
    // A room is several bots in one thread: name who sent it.
    ...(bus.store.groupByThread(sourceThreadId) ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
    comm: channel
      ? { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color }
      : undefined,
  });
  const targetTask=audienceTask(bus.store,target.id,threadHumanPrincipal(sourceThreadId), audience === undefined ? issueWorkAudience(from.id, target.id, sourceThreadId, issueExecutionAudience(from.id, sourceThreadId, sourceThreadId), sourceThreadId, true) : audience);
  if(!targetTask)throw new Error("HUMAN_TASK_UNAVAILABLE");
  note(targetTask.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Message from @${from.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: from.id, withName: from.name, withColor: from.color }
      : undefined,
  });
  if (channel) {
    bus.store.patchGroup(channel.id, { unread: true });
  }
}

/** Mirror `target`'s reply into the channel so the channel stays the
 * single authoritative record of the exchange. The 1:1 threads already
 * carry their own chips from `mirrorExchange`. `copyOf` names the original
 * reply, so the copy is withheld from bots whenever the original is. */
export function mirrorReply(
  bus: CommsBus,
  target: BotRecord,
  reply: string,
  channel: GroupRecord | undefined,
  copyOf?: Message["copyOf"],
  inboundKind: "action" | "question" = "question",
): void {
  if (!channel || !reply.trim()) return;
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "text",
    text: reply,
    inboundKind,
    from: { botId: target.id, name: target.name, color: target.color },
    ...(copyOf?.messageIds.length ? { copyOf } : {}),
  });
  bus.store.patchGroup(channel.id, { unread: true });
}

/** A line from Murage itself in the channel: no sender, so it never reads
 * as a bot's own words, and never folded away with tool calls (0.1.61 lane
 * T, O3). For what went wrong around a bot, not what the bot said. */
export function mirrorNotice(bus: CommsBus, channel: GroupRecord | undefined, name: string): void {
  mirrorMurageLine(bus, channel, name, { kind: "failure" });
}

/** A Murage line in envelope v2 (SPEC-P 10): no `from` (mirrorReply always
 * names the target, so it cannot write one), `actorKind: "murage"`, what the
 * row offers in `murage`, and the request it belongs to. */
export function mirrorMurageLine(
  bus: CommsBus,
  channel: GroupRecord | undefined,
  text: string,
  murage: MessageMurage,
  lineage: { requestId?: string; replyToId?: string } = {},
): void {
  if (!channel) return;
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: text, ok: murage.kind !== "failure" && murage.kind !== "cap" },
    actorKind: "murage",
    murage,
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
  name: string,
  ok: boolean,
): void {
  if (!channel) return;
  bus.store.appendMessage(channel.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name, ok },
    from: { botId: from.id, name: from.name, color: from.color },
  });
  bus.store.patchGroup(channel.id, { unread: true });
}
