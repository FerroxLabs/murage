import type { Store } from "../store.ts";
import type { StoredSpeechTarget } from "./reply-coordinator.ts";
import { SpeechRefusal } from "./reply-state.ts";
export type ReplyTargetStore = Pick<Store, "messageById" | "groupByThread" | "bot" | "botByThread">;
/** Stored membership and speaking eligibility are separate from the caller's thread authority. */
export function storedReplyTarget(store: ReplyTargetStore, threadId: string, messageId: string, owner: boolean, busy: (botId: string, threadId: string) => boolean): StoredSpeechTarget {
  if (!owner) throw new SpeechRefusal(404, "reply_unavailable");
  const message = store.messageById(threadId, messageId), room = store.groupByThread(threadId);
  const bot = room ? store.bot(message?.from?.botId ?? "") : store.botByThread(threadId);
  if (!message || !bot || bot.hidden || room?.hidden || room && !room.memberIds.includes(bot.id) || message.role !== "bot" || message.kind !== "text" || message.widget || message.actorKind === "murage" || typeof message.text !== "string") throw new SpeechRefusal(404, "reply_unavailable");
  // Old settled history predates provider turn ids. A current partial turn never uses this exception.
  if (!(message.turnTerminal || !message.turnId && !bot.busy && !room?.busyBotId && !busy(bot.id, threadId))) throw new SpeechRefusal(404, "reply_unavailable");
  return { threadId, messageId, botId: bot.id, eligible: true, source: message.text, voice: bot.voice, voiceProvider: bot.voiceProvider, prefix: room ? bot.name : undefined };
}
