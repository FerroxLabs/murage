// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bots listed by the sidebar's "New chat" panel. Idea from OpenMaus (Apache-2.0, SidebarNewChatPanel.tsx);
// ordering is ours: the Chief of Staff first, then the bots talked to most recently, then the rest by name.
import { botRole, type RoleBot } from "./bot-role";
import { rankByName } from "./palette-rank";

export interface NewChatBot extends RoleBot {
  id: string;
  name: string;
  hidden?: boolean;
  sidebarLine?: { at?: number } | null;
}

/** Every bot a new chat can start with (archived ones are not offered), ordered and filtered by `query`. */
export function newChatBots<T extends NewChatBot>(bots: readonly T[], query: string): T[] {
  const live = bots.filter((bot) => !bot.hidden);
  const ordered = [...live].sort((a, b) => {
    const chiefA = botRole(a) === "chief" ? 0 : 1;
    const chiefB = botRole(b) === "chief" ? 0 : 1;
    if (chiefA !== chiefB) return chiefA - chiefB;
    const recent = (b.sidebarLine?.at ?? 0) - (a.sidebarLine?.at ?? 0);
    if (recent !== 0) return recent;
    return a.name.localeCompare(b.name);
  });
  return rankByName(ordered, query);
}

/** True when the bot's current conversation holds nothing yet, so picking the bot reuses it instead of stacking an empty one. */
export function hasEmptyConversation(bot: { sidebarLine?: unknown; messages?: readonly unknown[] }): boolean {
  return !bot.sidebarLine && (bot.messages?.length ?? 0) === 0;
}
