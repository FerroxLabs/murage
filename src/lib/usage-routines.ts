// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings, Usage: "This month by routine" (upstream #1864, usage grouped by routine).
// Read only from the Usage page (a lazy chunk): the first paint never carries it.
import { ROUTINE_USAGE_MORE, usageMonthKey, usageMonthTokens, type RoutineUsageMonth, type UsageMonth } from "../../shared/usage-month";

/** One routine's line. `name` is null for the bucket of routines past the per-month cap ("Other routines"). */
export interface RoutineUsageRow { id: string; name: string | null; replies: number; tokens: number; input: number; output: number; cachedInput?: number }

export interface RoutineUsage {
  /** Routines that ran this month, busiest first; the "Other routines" bucket, if any, last. */
  rows: RoutineUsageRow[];
  /** Everything else the same bots used this month: "Not from a routine". */
  rest: { replies: number; tokens: number };
}

type Bucket = Pick<UsageMonth, "replies" | "input" | "output" | "cachedInput">;
const cachedOf = (b: Bucket) => (typeof b.cachedInput === "number" ? Math.min(Math.max(0, b.cachedInput), b.input) : undefined);

/** This month's routine lines for `bots`, summed by routine id across bots (a room goal can have several speakers).
 * Null when no routine ran this month, so the page leaves the card out. */
export function monthRoutineUsage<B extends { usageMonths?: Record<string, UsageMonth>; usageRoutineMonths?: Record<string, Record<string, RoutineUsageMonth>> }>(
  bots: readonly B[],
  at: number = Date.now(),
): RoutineUsage | null {
  const key = usageMonthKey(at);
  const byId = new Map<string, RoutineUsageRow>();
  let all = { replies: 0, tokens: 0 };
  for (const bot of bots) {
    const month = bot.usageMonths?.[key];
    if (month && month.replies > 0) all = { replies: all.replies + month.replies, tokens: all.tokens + usageMonthTokens(month) };
    const routines = bot.usageRoutineMonths?.[key];
    if (!routines) continue;
    for (const [id, bucket] of Object.entries(routines)) {
      if (!bucket || !(bucket.replies > 0)) continue;
      const prev = byId.get(id);
      const prevCached = prev?.cachedInput;
      const cached = cachedOf(bucket);
      const merged: RoutineUsageRow = {
        id,
        name: id === ROUTINE_USAGE_MORE ? null : (bucket.name || prev?.name || ""),
        replies: (prev?.replies ?? 0) + bucket.replies,
        tokens: (prev?.tokens ?? 0) + usageMonthTokens(bucket),
        input: (prev?.input ?? 0) + bucket.input,
        output: (prev?.output ?? 0) + bucket.output,
        ...(prevCached === undefined && cached === undefined ? {} : { cachedInput: (prevCached ?? 0) + (cached ?? 0) }),
      };
      byId.set(id, merged);
    }
  }
  if (byId.size === 0) return null;
  const rows = [...byId.values()].sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.tokens - a.tokens || b.replies - a.replies);
  const inRoutines = rows.reduce((sum, r) => ({ replies: sum.replies + r.replies, tokens: sum.tokens + r.tokens }), { replies: 0, tokens: 0 });
  return { rows, rest: { replies: Math.max(0, all.replies - inRoutines.replies), tokens: Math.max(0, all.tokens - inRoutines.tokens) } };
}
