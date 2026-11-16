// Who may start a call with which bot (voice-host and call-note).
//
// Calls were desktop-only because the voice-host snapshot includes the
// Inbox. C1 made the Inbox safe to show a proven phone, scoped to the
// threads its sidebar shows, so the same scoping now decides calls. A
// hidden bot answers "not-found", never "forbidden": the phone must not be
// able to tell a hidden bot from a missing one.
import type { InboxDoor, InboxRosterStore } from "../inbox-access.ts";
import { visibleToCompanion } from "../sse-visibility.ts";

export type CallAccess = "allowed" | "forbidden" | "not-found";

export function callAccess(store: InboxRosterStore, door: InboxDoor, botId: string): CallAccess {
  if (door === "unproven") return "forbidden";
  if (store.bot(botId)?.staged) return "not-found";
  if (door === "desktop") return "allowed";
  return visibleToCompanion(store, { scope: "bot", botId }) ? "allowed" : "not-found";
}

/** Session and subscription admission share the real target/thread binding. */
export function callTargetAccess(store: InboxRosterStore, door: InboxDoor, targetId: string, threadId: string, roomDesktop = door === "desktop"): CallAccess {
  if (door === "unproven") return "forbidden";
  const room = store.group(targetId);
  if (room) {
    if (!roomDesktop || door !== "desktop" || room.hidden || !store.groups.some(group => "id" in group && group.id === targetId && group.threadId === threadId)) return "not-found";
    return "allowed";
  }
  if (store.groupByThread(threadId) || !store.bots.some(bot => bot.id === targetId && (bot.threadId === threadId || bot.tasks?.some(task => task.threadId === threadId)))) return "not-found";
  return callAccess(store, door, targetId);
}

/** Recheck the admitted call's current audience before every source/model/audio continuation. */
export function callSourceVisible(store: InboxRosterStore, session: { targetId: string; threadId: string; desktop?: boolean }, botId: string): boolean {
  const door = session.desktop ? "desktop" : "companion";
  if (callTargetAccess(store, door, session.targetId, session.threadId, session.desktop === true) !== "allowed") return false;
  const group = store.group(session.targetId);
  if (!group) return session.targetId === botId;
  return "memberIds" in group && Array.isArray(group.memberIds) && group.memberIds.includes(botId) && Boolean(store.bot(botId) && !store.bot(botId)?.hidden && !store.bot(botId)?.staged);
}
