// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Conversation snooze and the question badge, as pure rules. The why is in
// shared/thread-snooze.ts: a snooze quiets news until a time, and anything
// owed to the owner (an approval or a question) outranks it every time.
import { THREAD_SNOOZE_MAX_MS } from "../../shared/thread-snooze";

export interface SnoozeClock { timeZone?: string; locale?: string }

const HOUR = 60 * 60 * 1000;
/** Mornings start at nine, in the owner's own zone. */
const MORNING_HOUR = 9;

interface ZoneParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function zoneParts(at: number, timeZone?: string): ZoneParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(at);
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? "0";
  return { year: Number(part("year")), month: Number(part("month")), day: Number(part("day")), hour: Number(part("hour")) % 24,
    minute: Number(part("minute")), second: Number(part("second")), weekday: WEEKDAYS.indexOf(part("weekday")) };
}

/** The moment a wall clock in `timeZone` reads this date and time. Days past
 *  the end of a month roll over, so "the 31st of September" is 1 October. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone?: string): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  // Two corrections settle every offset, including the day a clock changes.
  for (let step = 0; step < 2; step += 1) {
    const seen = zoneParts(guess, timeZone);
    guess += wanted - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  }
  return guess;
}

function dayAtMorning(now: number, daysAhead: number, timeZone?: string): number {
  const today = zoneParts(now, timeZone);
  return zonedTime(today.year, today.month, today.day + daysAhead, MORNING_HOUR, 0, timeZone);
}

function shortWhen(at: number, clock: SnoozeClock): string {
  return new Intl.DateTimeFormat(clock.locale, { timeZone: clock.timeZone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
}

export interface SnoozePreset { id: "hour" | "tomorrow" | "next-week"; label: string; detail: string; until: number }

/** 1 hour, tomorrow morning, next week (Monday morning; a week on if today
 *  is Monday). "Pick a time" is the field under these. */
export function snoozePresets(now: number, clock: SnoozeClock = {}): SnoozePreset[] {
  const today = zoneParts(now, clock.timeZone);
  const toMonday = ((8 - today.weekday) % 7) || 7;
  const hour = now + HOUR, tomorrow = dayAtMorning(now, 1, clock.timeZone), nextWeek = dayAtMorning(now, toMonday, clock.timeZone);
  return [
    { id: "hour", label: "1 hour", detail: new Intl.DateTimeFormat(clock.locale, { timeZone: clock.timeZone, hour: "numeric", minute: "2-digit" }).format(hour), until: hour },
    { id: "tomorrow", label: "Tomorrow morning", detail: shortWhen(tomorrow, clock), until: tomorrow },
    { id: "next-week", label: "Next week", detail: shortWhen(nextWeek, clock), until: nextWeek },
  ];
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A `datetime-local` value for this moment in the owner's zone. */
export function pickedTimeValue(at: number, timeZone?: string): string {
  const p = zoneParts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** The moment a `datetime-local` value names, read in the owner's zone. */
export function pickedTimeToEpoch(value: string, timeZone?: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return zonedTime(year, month, day, hour, minute, timeZone);
}

/** The furthest a picked time may be. Matches the server's limit. */
export const SNOOZE_MAX_MS = THREAD_SNOOZE_MAX_MS;

/** "Snoozed until 4:30 PM", "... tomorrow, 9:00 AM", "... Mon 9:00 AM",
 *  "... Oct 14, 9:00 AM". Calendar days are the owner's. */
export function formatSnoozedUntil(until: number, now: number, clock: SnoozeClock = {}): string {
  const time = new Intl.DateTimeFormat(clock.locale, { timeZone: clock.timeZone, hour: "numeric", minute: "2-digit" }).format(until);
  const a = zoneParts(now, clock.timeZone), b = zoneParts(until, clock.timeZone);
  const days = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / (24 * HOUR));
  if (days <= 0) return `Snoozed until ${time}`;
  if (days === 1) return `Snoozed until tomorrow, ${time}`;
  if (days < 7) return `Snoozed until ${shortWhen(until, clock)}`;
  const date = new Intl.DateTimeFormat(clock.locale, { timeZone: clock.timeZone, month: "short", day: "numeric" }).format(until);
  return `Snoozed until ${date}, ${time}`;
}

export interface QuietContext {
  snoozes: ReadonlyMap<string, number>;
  questions: Readonly<Record<string, number>>;
  now: number;
  /** The conversation is waiting on the owner (an approval card is open). */
  waiting?: boolean;
}

/** Is this conversation's news held back right now? Never while something
 *  is owed in it: the server wakes it too, and this is the same rule applied
 *  before the next read arrives. */
export function threadIsQuiet(threadId: string, context: QuietContext): boolean {
  const until = context.snoozes.get(threadId);
  if (until === undefined || until <= context.now) return false;
  return !context.waiting && !(context.questions[threadId] > 0);
}

type QuietTask = { threadId: string; unread?: boolean };

/** The bot as its row should weigh it: a quiet conversation's unread is
 *  held back, and nothing else changes (waiting and working stay). Returns
 *  the same object when nothing is quiet, so memoised rows keep their identity. */
export function quietBot<B extends { threadId: string; unread?: boolean; tasks?: QuietTask[] }>(bot: B, isQuiet: (threadId: string) => boolean): B {
  if (!bot.tasks) return bot.unread && isQuiet(bot.threadId) ? { ...bot, unread: false } : bot;
  if (!bot.tasks.some(task => task.unread && isQuiet(task.threadId))) return bot;
  const tasks = bot.tasks.map(task => task.unread && isQuiet(task.threadId) ? { ...task, unread: false } : task);
  return { ...bot, tasks, unread: tasks.some(task => task.unread) };
}

/** A channel keeps one unread mark; it is held back while the conversation
 *  the channel has open is snoozed. */
export function quietGroup<G extends { threadId: string; unread?: boolean }>(group: G, isQuiet: (threadId: string) => boolean): G {
  return group.unread && isQuiet(group.threadId) ? { ...group, unread: false } : group;
}

/** Questions waiting across a row's conversations, each counted once. */
export function questionsIn(threadIds: readonly string[], questions: Readonly<Record<string, number>>): number {
  return [...new Set(threadIds)].reduce((sum, threadId) => sum + (questions[threadId] ?? 0), 0);
}

export function questionBadgeLabel(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 question for you" : `${count} questions for you`;
}

type AttentionSource = { snoozes: ReadonlyMap<string, number>; questions: Readonly<Record<string, number>> };
type RowTask = QuietTask & { activity?: string };

/** Everything a bot's sidebar row needs from snoozes and questions: the bot
 *  weighed without its quiet conversations, the questions waiting across all
 *  of its conversations, and when its open conversation wakes, if snoozed. */
export function sidebarBotAttention<B extends { threadId: string; unread?: boolean; activity?: string; tasks?: RowTask[] }>(
  bot: B, attention: AttentionSource, now: number,
): { bot: B; questions: number; snoozedUntil?: number } {
  const waiting = (threadId: string) => {
    const task = bot.tasks?.find(entry => entry.threadId === threadId);
    return (task ? task.activity : bot.activity) === "waiting-on-you";
  };
  const isQuiet = (threadId: string) => threadIsQuiet(threadId, { ...attention, now, waiting: waiting(threadId) });
  const questions = questionsIn([bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)], attention.questions);
  return { bot: quietBot(bot, isQuiet), questions, ...(isQuiet(bot.threadId) ? { snoozedUntil: attention.snoozes.get(bot.threadId) } : {}) };
}

/** The same for a channel. */
export function sidebarGroupAttention<G extends { threadId: string; unread?: boolean; tasks?: Array<{ threadId: string }> }>(
  group: G, attention: AttentionSource, now: number,
): { group: G; questions: number; snoozedUntil?: number } {
  const isQuiet = (threadId: string) => threadIsQuiet(threadId, { ...attention, now });
  const questions = questionsIn([group.threadId, ...(group.tasks ?? []).map(task => task.threadId)], attention.questions);
  return { group: quietGroup(group, isQuiet), questions, ...(isQuiet(group.threadId) ? { snoozedUntil: attention.snoozes.get(group.threadId) } : {}) };
}
