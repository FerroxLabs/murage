// The names a dictation clean-up may be told, scoped to who is asking.
//
// The desktop sees the whole workspace. A paired phone sees only what its
// sidebar shows, decided by the same filter the companion uses for its bot
// list (`visibleToCompanion`, server/sse-visibility.ts). A caller that is
// neither gets the fixed product names and nothing about the workspace, so a
// hidden bot or room name can never be echoed back through a dictation.
import type { InboxDoor, InboxRosterStore } from "../inbox-access.ts";
import { visibleToCompanion } from "../sse-visibility.ts";
import { cleanupNames } from "./dictation-cleanup.ts";

export function namesForDoor(door: InboxDoor, store: InboxRosterStore): string[] {
  if (door === "unproven") return cleanupNames({});
  const shown = (threadId: string) => door === "desktop" || visibleToCompanion(store, { scope: "thread", threadId });
  return cleanupNames({
    bots: store.bots.filter((bot) => shown(bot.threadId)).map((bot) => bot.name),
    rooms: store.groups.filter((group) => shown(group.threadId)).map((group) => group.name),
  });
}

/** The bot or room being written to, by name, only when this door may see it. */
export function targetForDoor(door: InboxDoor, store: InboxRosterStore, ids: { botId?: string; groupId?: string }): string | undefined {
  if (door === "unproven") return undefined;
  const bot = ids.botId ? store.bots.find((row) => row.id === ids.botId) : undefined;
  if (bot) return door === "desktop" || visibleToCompanion(store, { scope: "bot", botId: bot.id }) ? bot.name : undefined;
  const group = ids.groupId ? (store.groups as ReadonlyArray<{ id?: string; name: string; threadId: string }>).find((row) => row.id === ids.groupId) : undefined;
  if (group) return door === "desktop" || visibleToCompanion(store, { scope: "thread", threadId: group.threadId }) ? group.name : undefined;
  return undefined;
}
