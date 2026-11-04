// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Needs you door's rules, pure, so a test can hold them without a screen
// (designs/UX-OVERHAUL-BUILD-PLAN.md L2B; UX-FIRSTRUN-SCALE-1012.md 2.3).
//
//   Keys     Enter (or Space) opens the row in focus, Esc closes the open card
//            and keeps the place, J and K (or the arrows) move without
//            deciding, S snoozes. Digits belong to the open card itself
//            (QuestionCard picks 1 to 9), so they are never taken here.
//   Sweep    after an answer, the next row opens.
//   Snooze   "Remind me at 17:00"; from 16:00 on, "Remind me tomorrow at 9:00".
//   Scale    past 20 rows the list groups by bot, groups in order of their
//            oldest card.

export const NEEDS_GROUP_AFTER = 20;

export type NeedsKeyAction =
  | { type: "open"; id: string }
  | { type: "close" }
  | { type: "focus"; id: string }
  | { type: "snooze"; id: string }
  | null;

export interface NeedsKeyInput {
  key: string;
  /** typing in a field, or a modifier held: never a door key */
  typing: boolean;
  /** the inner card already used this key */
  handled: boolean;
  /** focus is inside the open card (not on its row's Open button) */
  inCard: boolean;
}

/** What a key on the list means. `ids` is the list in screen order; `focused`
 *  is the row the keyboard is on; `open` is the row whose card is open. */
export function needsKeyAction(input: NeedsKeyInput, ids: readonly string[], focused: string | null, open: string | null): NeedsKeyAction {
  if (input.handled || ids.length === 0) return null;
  const key = input.key;
  // Esc closes the open card even from a field inside it, and keeps the place.
  if (key === "Escape") return open ? { type: "close" } : null;
  if (input.typing) return null;
  // Inside an open card, Enter, the digits and the letters belong to the card.
  if (input.inCard) return null;
  const at = focused ? ids.indexOf(focused) : -1;
  if (key === "Enter" || key === " ") return at >= 0 ? { type: "open", id: ids[at]! } : null;
  if (key === "j" || key === "J" || key === "ArrowDown") return { type: "focus", id: ids[Math.min(ids.length - 1, at + 1)]! };
  if (key === "k" || key === "K" || key === "ArrowUp") return { type: "focus", id: ids[Math.max(0, at - 1)]! };
  if (key === "s" || key === "S") return at >= 0 ? { type: "snooze", id: ids[at]! } : null;
  return null;
}

/** The row that opens after `answered` is settled: the one below it, else the
 *  one above, else none (the list is clear). */
export function nextAfterAnswer(ids: readonly string[], answered: string): string | null {
  const at = ids.indexOf(answered);
  if (at < 0) return ids[0] ?? null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

export interface SnoozeTarget {
  until: number;
  /** "tomorrow" from 16:00 local time on */
  tomorrow: boolean;
  /** "17:00" or "9:00", the clock time the button names */
  time: string;
}

/** When a snooze from the door comes back. Local time, as the owner reads it. */
export function snoozeTarget(now: number): SnoozeTarget {
  const at = new Date(now);
  if (at.getHours() < 16) {
    const until = new Date(at.getFullYear(), at.getMonth(), at.getDate(), 17, 0, 0, 0).getTime();
    return { until, tomorrow: false, time: "17:00" };
  }
  const until = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, 9, 0, 0, 0).getTime();
  return { until, tomorrow: true, time: "9:00" };
}

/** "07:12" today; "Nov 2, 07:12" before today. 24-hour, as the mockup reads. */
export function waitingSinceTime(at: number, now: number): string {
  const when = new Date(at), today = new Date(now);
  const clock = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const sameDay = when.getFullYear() === today.getFullYear() && when.getMonth() === today.getMonth() && when.getDate() === today.getDate();
  if (sameDay) return clock;
  return `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock}`;
}

/** Oldest first, so nothing waits twice (spec 2.3). Ties keep their order. */
export function oldestFirst<T extends { at: number }>(rows: readonly T[]): T[] {
  return rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.at - b.row.at || a.index - b.index).map(({ row }) => row);
}

/** A held Enter, Space or 1 to 9: its repeats never answer a card (the key that opened a row, or picked the last answer, must not also answer the next). */
export function isHeldActivation(event: { key: string; repeat: boolean }): boolean {
  return event.repeat && (event.key === "Enter" || event.key === " " || event.key === "s" || event.key === "S" || /^[1-9]$/.test(event.key));
}

/** A snoozed row whose time has come. */
export function cameBack(row: { snoozedUntil?: number | null }, now: number): boolean {
  return row.snoozedUntil != null && row.snoozedUntil <= now;
}

/** The door's order: rows that came back from a snooze on top (in the order they came back), then the rest oldest first. */
export function doorOrder<T extends { at: number; snoozedUntil?: number | null }>(rows: readonly T[], now: number): T[] {
  const back = rows.filter(row => cameBack(row, now));
  const rest = rows.filter(row => !cameBack(row, now));
  const backOrdered = back.map((row, index) => ({ row, index })).sort((a, b) => (a.row.snoozedUntil as number) - (b.row.snoozedUntil as number) || a.row.at - b.row.at || a.index - b.index).map(({ row }) => row);
  return [...backOrdered, ...oldestFirst(rest)];
}

export interface BotChip { bot: string; count: number }

/** "All 30 · Max 11 · Nova 8": one chip per bot, most waiting first, then by name. */
export function botChips<T>(rows: readonly T[], botOf: (row: T) => string): BotChip[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const bot = botOf(row);
    if (bot) counts.set(bot, (counts.get(bot) ?? 0) + 1);
  }
  return [...counts].map(([bot, count]) => ({ bot, count })).sort((a, b) => b.count - a.count || a.bot.localeCompare(b.bot));
}

export interface NeedsGroup<T> { bot: string; rows: T[] }

/** Past NEEDS_GROUP_AFTER rows, one group per bot in order of its oldest card;
 *  up to it, one group with no name (no headers drawn). Rows arrive oldest first. */
export function groupNeeds<T>(rows: readonly T[], botOf: (row: T) => string): NeedsGroup<T>[] {
  if (rows.length <= NEEDS_GROUP_AFTER) return [{ bot: "", rows: [...rows] }];
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const bot = botOf(row);
    const list = groups.get(bot);
    if (list) list.push(row); else groups.set(bot, [row]);
  }
  return [...groups].map(([bot, list]) => ({ bot, rows: list }));
}

/** One timer per snoozed row, while the app is open: at `until` the row is
 *  back and `fire` runs once (one notification). Undo cancels it. After a
 *  restart there is no timer; the row is simply back in the list. */
export function createSnoozeReturns(timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}) {
  const pending = new Map<string, unknown>();
  // setTimeout fires at once past 2^31-1 ms; a snooze is at most a day or so away.
  const MAX = 2_147_000_000;
  return {
    schedule(id: string, until: number, now: number, fire: () => void) {
      this.cancel(id);
      const wait = Math.min(MAX, Math.max(0, until - now));
      pending.set(id, timers.set(() => { pending.delete(id); fire(); }, wait));
    },
    cancel(id: string) {
      const handle = pending.get(id);
      if (handle !== undefined) { timers.clear(handle); pending.delete(id); }
    },
    has: (id: string) => pending.has(id),
  };
}
