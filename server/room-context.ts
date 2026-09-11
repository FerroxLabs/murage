// The room serializer's selection: which of a room thread's messages go
// into a member's prompt verbatim. One place, so the prompt and the memory
// recall exclusion (MEMJSON2 follow-up) cannot drift: every message the
// context already carries is kept out of that member's recall, otherwise the
// person's ask and the other members' just-captured replies from the same
// round come back as remembered "source" lines a second time.
import type { Message } from "./store.ts";

/** How many of the room's most recent text messages a member turn sees. */
export const GROUP_CONTEXT_MESSAGES = 30;

/** The messages `serializeRoomContext` renders: text messages only, the
 * newest `limit`, in order. */
export function roomContextMessages<T extends Pick<Message, "id" | "kind" | "text">>(messages: readonly T[], limit = GROUP_CONTEXT_MESSAGES): T[] {
  return messages.filter((m) => m.kind === "text" && m.text).slice(-limit);
}

/** Ids of every message the room context carries — the recall exclusion for
 * a member dispatch on that thread. */
export function roomContextMessageIds(messages: readonly Pick<Message, "id" | "kind" | "text">[], limit = GROUP_CONTEXT_MESSAGES): string[] {
  return roomContextMessages(messages, limit).map((m) => m.id);
}
