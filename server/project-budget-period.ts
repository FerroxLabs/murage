// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
/** Calendar boundaries in the owner's IANA zone, including offset changes. */
export function budgetPeriodStart(period: "day" | "week" | "month", tz: string, now: number): number {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (at: number) => Object.fromEntries(format.formatToParts(at).filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  const date = parts(now);
  let wall = Date.UTC(date.year!, date.month! - 1, period === "month" ? 1 : date.day!);
  if (period === "week") wall -= ((new Date(wall).getUTCDay() + 6) % 7) * 86400000;
  // Find the first instant on the target local date. Solving for 00:00 by
  // offset iteration oscillates when midnight is skipped and can select the
  // second midnight when clocks repeat it.
  const localDate = (at: number) => {
    const p = parts(at);
    return Date.UTC(p.year!, p.month! - 1, p.day!);
  };
  let low = wall - 36 * 3600000;
  let high = wall + 36 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (localDate(mid) < wall) low = mid;
    else high = mid;
  }
  return high;
}
