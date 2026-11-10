// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which bots the Settings sidebar lists under "Each bot" (SETTINGS-LOCKED-1019.md 2.1): up to five rows, the Chief
// first, then by name; the open bot is always one of the five; past five a "Browse bots (N)" row opens the list page.
// Archived (hidden) bots are never listed, except the one the window is showing. Pure, so the order is a test.
import { botRole, type RoleBot } from "./bot-role";

export const SIDEBAR_BOT_ROWS = 5;

interface ShellBot extends RoleBot { id: string; name: string; hidden?: boolean }

const byChiefThenName = <T extends ShellBot>(a: T, b: T): number => {
  const chief = Number(botRole(b) === "chief") - Number(botRole(a) === "chief");
  return chief || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
};

/** Every bot Browse bots can open: not archived, plus the open one. Chief first, then by name. */
export function browsableBots<T extends ShellBot>(bots: readonly T[], openId?: string | null): T[] {
  return bots.filter((bot) => !bot.hidden || bot.id === openId).sort(byChiefThenName);
}

/** The rows under Each bot, and how many bots there are in all (the Browse bots count). */
export function sidebarBots<T extends ShellBot>(bots: readonly T[], openId?: string | null): { rows: T[]; total: number; browse: boolean } {
  const all = browsableBots(bots, openId);
  if (all.length <= SIDEBAR_BOT_ROWS) return { rows: all, total: all.length, browse: false };
  const rows = all.slice(0, SIDEBAR_BOT_ROWS);
  const open = openId ? all.find((bot) => bot.id === openId) : undefined;
  if (open && !rows.includes(open)) rows[SIDEBAR_BOT_ROWS - 1] = open;
  return { rows, total: all.length, browse: true };
}
