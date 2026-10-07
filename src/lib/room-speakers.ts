// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who is speaking in a room, and what each bot turn answers. Several bots
// share one transcript, so every turn carries its speaker's name, and a turn
// that answers something other than the row right above it says what.
//
// Bot messages do not store what they answer yet (only an owner's Reply sets
// `replyToId`), so the answer is read back from the transcript with the same
// rules the server uses to start a turn: an owner message starts a round, a
// member's @mention (or @everyone) summons a teammate one hop, and a
// delegation result comes back to the room as "@X replied to the delegated
// task". A stored `replyToId` always wins.
import type { Message } from "@/state/store";
import { mentionedPeers, mentionsEveryone } from "../../shared/mention-boundary";

const DELEGATION_RESULT = " replied to the delegated task:";

/** Does `m` open a new bot turn after `prev`, the row drawn above it? Every
 * turn names its speaker: a second reply from the same bot is a new turn,
 * and so is a tool row after that bot's reply. Tool rows and the reply of
 * one turn share the name the turn opened with. */
export function startsBotTurn(prev: Message | undefined, m: Message): boolean {
  if (m.role !== "bot" || !m.from) return false;
  if (!prev || prev.role !== "bot" || prev.from?.botId !== m.from.botId) return true;
  if (prev.turnId && m.turnId) return prev.turnId !== m.turnId;
  // Without turn ids, two replies in a row are two turns. A tool row next to
  // a reply is the same turn: an engine often says what it will do, then
  // does it, and room turns run one at a time, so a new turn of the same bot
  // follows something that summoned it.
  return prev.kind === "text" && m.kind === "text";
}

/** "you" for the owner, the bot's name otherwise. */
export function replyingToName(target: Message): string {
  return target.role === "user" ? "you" : (target.from?.name ?? "a teammate");
}

function isDelegationResult(m: Message): boolean {
  return m.kind === "text" && Boolean(m.from) && (m.text ?? "").startsWith(`@${m.from!.name}${DELEGATION_RESULT}`);
}

function isDelegationChipFor(m: Message, name: string): boolean {
  const label = m.kind === "activity" ? m.tool?.name : undefined;
  if (!label) return false;
  const exact = `Delegated to @${name}`;
  return label === exact || label.startsWith(`${exact}: `);
}

/** How far back a row looks for what it answers. Bounds the work on a long
 * held transcript; a turn's trigger is almost always a few rows up. */
const LOOKBACK = 400;
/** The server follows a member's @mention one hop (MAX_GROUP_HOPS). */
const MENTION_HOPS = 1;

type Roster = readonly { name: string }[];

function summons(candidate: Message, name: string, roster: Roster): boolean {
  const text = candidate.text ?? "";
  if (mentionsEveryone(text)) return true;
  // Against the whole roster, as the server matches: "@Dax Research" is the
  // longer name, not Dax.
  const wanted = name.toLowerCase();
  return mentionedPeers(text, roster).some((peer) => peer.name.toLowerCase() === wanted);
}

/** The bot text a delegation result answers: the delegating bot's words in
 * the turn that queued it. The chip carries no sender on older rooms, so the
 * delegator is the chip's sender when known, else the first other bot that
 * spoke after the chip. Never the chip itself: with tool calls off it is not
 * drawn, and a link to it could not land. */
function delegationTarget(messages: readonly Message[], index: number): Message | undefined {
  const target = messages[index].from!;
  let chip = -1;
  for (let j = index - 1; j >= Math.max(0, index - LOOKBACK); j--) {
    if (isDelegationChipFor(messages[j], target.name)) { chip = j; break; }
  }
  if (chip < 0) return undefined;
  const delegator = messages[chip].from?.botId;
  const byDelegator = (c: Message) =>
    c.role === "bot" && c.kind === "text" && Boolean(c.from) && c.from!.botId !== target.botId
    && (!delegator || c.from!.botId === delegator) && !isDelegationResult(c);
  // Only the delegating turn: an owner line, or another bot speaking, ends it.
  for (let j = chip + 1; j < index; j++) {
    const c = messages[j];
    if (c.role === "user") break;
    if (byDelegator(c)) return c;
    if (delegator && c.kind === "text" && c.from && c.from.botId !== delegator) break;
  }
  if (delegator) {
    for (let j = chip - 1; j >= Math.max(0, chip - LOOKBACK); j--) {
      const c = messages[j];
      if (c.role === "user") break;
      if (byDelegator(c)) return c;
      if (c.from && c.from.botId !== delegator) break;
    }
  }
  return undefined;
}

/** For every bot row with a sender, the message its turn answers. Read over
 * the full transcript so a target outside the mounted window still resolves.
 * Owner rows are left out: an owner's Reply already draws its own quote.
 * `roster` is every name a mention can resolve to; it defaults to the
 * senders seen in the transcript. */
export function roomReplyTargets(messages: readonly Message[], roster?: Roster): Map<string, Message> {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const names: Roster = roster ?? [...new Map(messages.flatMap((m) => (m.from ? [[m.from.name, { name: m.from.name }] as const] : []))).values()];
  const targets = new Map<string, Message>();
  // Mention hops per bot row: 0 when the turn answers the owner, one more
  // than the summoning row when a teammate's @mention started it.
  const hops = new Map<string, number>();
  const answer = (m: Message, target: Message) => {
    targets.set(m.id, target);
    hops.set(m.id, target.role === "bot" ? (hops.get(target.id) ?? 0) + 1 : 0);
  };
  messages.forEach((m, index) => {
    if (m.role !== "bot" || !m.from) return;
    if (m.replyToId) {
      // Stored is authoritative even when its target is outside the held
      // page: a guess here would name the wrong message.
      const stored = byId.get(m.replyToId);
      if (stored) answer(m, stored);
      return;
    }
    if (isDelegationResult(m)) {
      const target = delegationTarget(messages, index);
      if (target) answer(m, target);
      return;
    }
    for (let j = index - 1; j >= Math.max(0, index - LOOKBACK); j--) {
      const c = messages[j];
      if (c.role === "user") {
        if (c.queued || c.steered) continue;
        answer(m, c);
        return;
      }
      if (!c.from) continue;
      if (c.from.botId === m.from.botId) {
        // Earlier row of this same turn: share its answer. A finished reply
        // from an earlier turn with nothing new since answers nothing.
        if (!startsBotTurn(c, m)) {
          const shared = targets.get(c.id);
          if (shared) answer(m, shared);
        }
        return;
      }
      if (
        c.kind === "text" && !isDelegationResult(c)
        && (hops.get(c.id) ?? 0) < MENTION_HOPS
        && summons(c, m.from.name, names)
      ) {
        answer(m, c);
        return;
      }
    }
  });
  return targets;
}
