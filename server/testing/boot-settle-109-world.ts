// SPDX-License-Identifier: AGPL-3.0-or-later
// The fixture world of the child of server/boot-settle-109.crash.test.ts (boot-settle-109-child.ts): a bot, its task and (for a room) a room, built through
// the real Store on a real data directory. The child builds it and dies at a named point; a later child reads it back by these same lookups.
import type { RoutineCardDeps, RoutineCardSource } from "../routine-run-card.ts";
import type { Store } from "../store.ts";

export type CardKind = "group" | "task";
export function buildCardWorld(store: Store, kind: CardKind): void {
  const bot = store.createBot({ name: "Painter" });
  store.createTask(bot.id, "Chat");
  if (kind === "group") store.createGroup("Room", [bot.id]);
}
export function cardWorld(store: Store, kind: CardKind) {
  const bot = store.bots[0]!;
  const group = kind === "group" ? store.groups.find(g => !g.dm) : undefined;
  const threadId = group ? group.threadId! : bot.tasks!.find(t => t.threadId !== bot.threadId)?.threadId ?? bot.tasks![bot.tasks!.length - 1]!.threadId;
  const source: RoutineCardSource = { threadId, bot: { id: bot.id, name: bot.name, color: bot.color }, ...(group ? { group: { id: group.id } } : {}) };
  const unread = () => group ? store.group(group.id)?.unread === true : store.taskByThread(bot.id, threadId)?.unread === true;
  const cards = () => { const found: string[] = []; store.scanSince(threadId, 0, m => { if (m.kind === "routine.run") found.push(m.id); return false; }); return found; };
  return { bot, group, threadId, source, unread, cards };
}
export function cardDeps(store: Store, notified: string[], over: Partial<RoutineCardDeps> = {}): RoutineCardDeps {
  return {
    newestSince: (threadId, at, test) => { let found; store.scanSince(threadId, at, m => (test(m) ? ((found = m), true) : false)); return found; },
    patchMessage: (t, id, patch) => store.patchMessage(t, id, patch),
    appendMessage: (t, message) => store.appendMessage(t, message),
    patchGroup: (id, patch) => store.patchGroup(id, patch),
    patchTask: (b, t, patch) => store.patchTask(b, t, patch),
    notifyChanged: (_s, summary) => { notified.push(summary); },
    ...over,
  };
}
