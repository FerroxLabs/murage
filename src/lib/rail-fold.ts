// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The rail at scale (UX L6B, UX-FIRSTRUN-SCALE-1012.md section 2.1). A bot
// section shows at most eight rows; the rest sit behind one fold row that
// still says what the hidden bots are doing ("12 more · 2 working · 3 need
// you"), so folding never hides work or a question.
//
// Rules that keep a bot in view even past eight: it is waiting on the owner
// or has a question card (needs you never hides behind the fold), or it is
// the open chat. Rows are weighed the way the sidebar draws them, so a
// snoozed conversation adds nothing to the fold line. Everything
// else keeps the owner's order. A search shows every match, folded or not.

import { sidebarSectionAttention, type SidebarAttentionBot, type SidebarSectionAttention } from "@/lib/sidebar-attention";

export const RAIL_VISIBLE_BOTS = 8;

export interface RailFold<T> {
  visible: T[];
  hidden: T[];
  /** what the hidden rows are doing; zeros when nothing is hidden */
  attention: SidebarSectionAttention;
}

const NOTHING: SidebarSectionAttention = { unread: 0, waiting: 0, working: 0 };

/** A bot as its row shows it: snoozed conversations taken out, and the
 *  question cards waiting across all of its conversations. */
export interface RailWeighed {
  bot: SidebarAttentionBot;
  questions: number;
}

export function railFold<T extends SidebarAttentionBot>(
  bots: readonly T[],
  options: { open: boolean; keep?: (bot: T) => boolean; weigh?: (bot: T) => RailWeighed; limit?: number; rank?: (bot: T) => number },
): RailFold<T> {
  const limit = options.limit ?? RAIL_VISIBLE_BOTS;
  if (options.open || bots.length <= limit) return { visible: [...bots], hidden: [], attention: NOTHING };
  const weighed = new Map<T, RailWeighed>(bots.map((bot) => [bot, options.weigh ? options.weigh(bot) : { bot, questions: 0 }]));
  const needsYou = (bot: T) => {
    const row = weighed.get(bot)!;
    return row.bot.activity === "waiting-on-you" || row.questions > 0;
  };
  const shown = new Set<T>();
  for (const bot of bots) {
    if (needsYou(bot) || options.keep?.(bot)) shown.add(bot);
  }
  // Free slots go to the most recently active bots when ranked (unpinned
  // sections); the rows still draw in the owner's order. Each bot is ranked
  // once, so the sort compares numbers and never rescans a bot's chats.
  const rank = options.rank;
  const order = rank
    ? bots.map((bot) => ({ bot, at: rank(bot) })).sort((a, b) => b.at - a.at).map((entry) => entry.bot)
    : bots;
  for (const bot of order) {
    if (shown.size >= limit) break;
    shown.add(bot);
  }
  const visible = bots.filter((bot) => shown.has(bot));
  const hidden = bots.filter((bot) => !shown.has(bot));
  return { visible, hidden, attention: hidden.length ? sidebarSectionAttention(hidden.map((bot) => weighed.get(bot)!.bot), []) : NOTHING };
}

/** When a bot last did anything: its newest chat's last activity. */
export function railRecency(bot: { tasks?: readonly { lastActivityAt?: number; createdAt?: number }[] }): number {
  let last = 0;
  for (const task of bot.tasks ?? []) last = Math.max(last, task.lastActivityAt ?? task.createdAt ?? 0);
  return last;
}

/** Visible rows left for the Bots section once the pins took theirs: eight in all (spec 2.1 items 3 and 4). */
export const railBotsLimit = (pinned: number) => Math.max(0, RAIL_VISIBLE_BOTS - pinned);

const OPEN_KEY = "murage-rail-fold-open";

/** Which sections the owner opened, remembered on this device only. */
export function loadOpenRailFolds(): string[] {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveOpenRailFolds(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify(ids));
  } catch {
    // storage can be blocked; the fold simply starts closed next time
  }
}

/** Esc in the rail's search box: a typed search clears first; with the box
 *  empty, the most recently opened fold closes (Show less, by key). Null when
 *  Esc has nothing to do here. */
export function railSearchEscape(query: string, openFolds: readonly string[]): { query: string; folds: string[] } | null {
  if (query) return { query: "", folds: [...openFolds] };
  if (!openFolds.length) return null;
  return { query, folds: openFolds.slice(0, -1) };
}
