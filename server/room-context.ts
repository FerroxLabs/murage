// The room serializer's selection: which of a room thread's messages go
// into a member's prompt verbatim. One place, so the prompt and the memory
// recall exclusion (MEMJSON2 follow-up) cannot drift: every message the
// context already carries is kept out of that member's recall, otherwise the
// person's ask and the other members' just-captured replies from the same
// round come back as remembered "source" lines a second time.
import type { Message } from "./store.ts";

/** How many of the room's most recent text messages a member turn sees. */
export const GROUP_CONTEXT_MESSAGES = 30;

/**
 * How the pinned message is introduced in the prompt.
 *
 * Pinning a message is the person saying "this is the thing, keep it in
 * mind". Until now it was the one message that reliably never reached the
 * prompt: the window is the newest thirty, and a pin earns its keep precisely
 * by being older than that. It is labelled rather than silently prepended,
 * because an old line dropped at the top of a transcript with no explanation
 * reads as the start of the conversation.
 */
export const ROOM_CONTEXT_PINNED_LABEL = "Pinned by the owner";

/** The messages `serializeRoomContext` renders: text messages only, the
 * newest `limit`, in order, with the pinned message in front of them when it
 * would otherwise have fallen out of the window.
 *
 * Never duplicated: a pin that is still inside the window stays exactly where
 * it is, in its own place in the conversation. */
export function roomContextMessages<T extends Pick<Message, "id" | "kind" | "text">>(
  messages: readonly T[],
  limit = GROUP_CONTEXT_MESSAGES,
  pinnedMessageId?: string,
): T[] {
  const window = messages.filter((m) => m.kind === "text" && m.text).slice(-limit);
  if (!pinnedMessageId || window.some((m) => m.id === pinnedMessageId)) return window;
  const pinned = messages.find((m) => m.id === pinnedMessageId && m.kind === "text" && m.text);
  return pinned ? [pinned, ...window] : window;
}

/** Ids of every message the room context carries — the recall exclusion for
 * a member dispatch on that thread. It has to be given the same pin the
 * prompt was built with, or the pinned line comes back a second time as a
 * remembered "source". */
export function roomContextMessageIds(
  messages: readonly Pick<Message, "id" | "kind" | "text">[],
  limit = GROUP_CONTEXT_MESSAGES,
  pinnedMessageId?: string,
): string[] {
  return roomContextMessages(messages, limit, pinnedMessageId).map((m) => m.id);
}

/** What a member reads in place of a room reply it may no longer be shown
 * (server/room-transcript.ts). The line keeps who said it and when, so a
 * withheld reply never reads as a teammate who stayed silent. */
export const ROOM_REPLY_WITHHELD = "Reply withheld: it used something you deleted or changed";

export function withheldRoomLine(message: Pick<Message, "from" | "at">): string {
  const at = new Date(message.at).toISOString().slice(0, 16).replace("T", " ");
  return `[${ROOM_REPLY_WITHHELD}] (${message.from?.name ?? "Bot"}, ${at} UTC)`;
}

/** The room as a member turn may read it: each withheld reply stays in its
 * place as its withheld line, with nothing of the original left to quote. */
export function withholdRoomReplies(messages: readonly Message[], withheld: ReadonlySet<string>): Message[] {
  if (!withheld.size) return [...messages];
  return messages.map((message) => withheld.has(message.id)
    ? { ...message, text: withheldRoomLine(message), replyToId: undefined, routineRunPrompt: undefined, attachments: undefined, artifactIds: undefined }
    : message);
}
