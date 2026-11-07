// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What each bot used in a local calendar month (Settings, Usage: "This month by bot").
// Kept on the bot record in bots.json, beside the per-task totals it grew from, so a turn
// pays for one small upsert and nothing scans history. Months before this existed have no
// bucket; `since` says when the month's own counting began.

export interface UsageMonth {
  replies: number;
  input: number;
  output: number;
  /** The part of `input` served from the provider's cache; absent until an engine reports it. */
  cachedInput?: number;
  /** When this month's counting began (first write), epoch ms. */
  since: number;
}

/** Local calendar month of `at`, "YYYY-MM" (the clock of the learning ledger). */
export function usageMonthKey(at: number = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Buckets kept per bot: a year of history is far more than any page reads. */
export const USAGE_MONTHS_KEPT = 13;

const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);

type UsageTurn = { input?: number; output?: number; cachedInput?: number };

/** A bucket with one more settled turn in it. */
function addTurn(prev: UsageMonth | undefined, turn: UsageTurn, at: number): UsageMonth {
  const input = whole(turn.input);
  const cached = typeof turn.cachedInput === "number" || typeof prev?.cachedInput === "number"
    ? Math.min(whole(prev?.cachedInput), whole(prev?.input)) + Math.min(whole(turn.cachedInput), input)
    : undefined;
  return {
    replies: whole(prev?.replies) + 1,
    input: whole(prev?.input) + input,
    output: whole(prev?.output) + whole(turn.output),
    ...(cached === undefined ? {} : { cachedInput: cached }),
    since: typeof prev?.since === "number" ? prev.since : at,
  };
}

function keepRecentMonths(months: Record<string, unknown>): void {
  const keys = Object.keys(months).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - USAGE_MONTHS_KEPT))) delete months[old];
}

/** One settled turn added to the month's bucket, in place. Bounded: the oldest buckets fall off. */
export function bumpUsageMonth(
  months: Record<string, UsageMonth>,
  turn: UsageTurn,
  at: number = Date.now(),
): void {
  const key = usageMonthKey(at);
  months[key] = addTurn(months[key], turn, at);
  keepRecentMonths(months);
}

/** One routine's share of a bot's month (Settings, Usage: "This month by routine", upstream #1864). `name` is the
 * routine's name when it last ran, so a renamed or deleted routine still reads as it did. */
export interface RoutineUsageMonth extends UsageMonth { name: string }

/** Routines kept apart per bot and month; any further routine's turns are added to ROUTINE_USAGE_MORE. */
export const ROUTINE_USAGE_KEPT = 50;
/** The bucket for routines past ROUTINE_USAGE_KEPT ("Other routines"). Never a real routine id (those are uuids). */
export const ROUTINE_USAGE_MORE = "~more";

/** One settled routine turn added to that routine's bucket for the month, in place. Bounded twice: by month like
 * bumpUsageMonth, and by ROUTINE_USAGE_KEPT routines in a month. The bot's own month bucket still counts the turn. */
export function bumpRoutineUsageMonth(
  months: Record<string, Record<string, RoutineUsageMonth>>,
  routine: { id: string; name: string },
  turn: UsageTurn,
  at: number = Date.now(),
): void {
  const key = usageMonthKey(at);
  const month = (months[key] ??= {});
  const id = Object.hasOwn(month, routine.id) || Object.keys(month).filter((k) => k !== ROUTINE_USAGE_MORE).length < ROUTINE_USAGE_KEPT
    ? routine.id
    : ROUTINE_USAGE_MORE;
  const prev = Object.hasOwn(month, id) ? month[id] : undefined;
  month[id] = { ...addTurn(prev, turn, at), name: id === ROUTINE_USAGE_MORE ? "" : routine.name.slice(0, 200) };
  keepRecentMonths(months);
}

/** Fresh tokens (input without the cached re-read, plus output) of a bucket, the figure the table shows. */
export function usageMonthTokens(m: Pick<UsageMonth, "input" | "output" | "cachedInput">): number {
  const cached = typeof m.cachedInput === "number" ? Math.min(Math.max(0, m.cachedInput), m.input) : 0;
  return Math.max(0, m.input - cached) + m.output;
}
