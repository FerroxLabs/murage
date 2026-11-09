// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DG8 slice 3: Settings > Usage > Plan usage, as plain lines. It only repeats what the engine
// reported (percent used, reset time, when it was checked). No line promises a pause, a hold or
// spare capacity, and time alone never clears anything (GAP-PLAN-LIMITS-109 section 9).
import { localeCode, t } from "@/lib/i18n";
import type { PlanStatus } from "../../shared/plan-usage.ts";

// The wire shape of GET /api/plan-usage (server/plan-usage-report.ts), only the fields this page reads.
export interface PlanUsageWindowView { label: string; usedPercent: number | null; resetsAt: number | null; windowSeconds: number | null; limitReached: boolean }
export interface PlanUsageRow { id: string; engine: string; bot: string | null; status: PlanStatus; checkedAt: number | null; freshUntil: number | null; windows: PlanUsageWindowView[]; refreshing: boolean }
export interface PlanUsageReport { accounts: PlanUsageRow[]; serverNow: number; omitted: number; nextCursor: number | null; cloud: boolean }

/** Server and device clocks further apart than this make every reset time "about". */
export const PLAN_CLOCK_SKEW_MS = 120_000;

/**
 * The server clock anchored conservatively to request start, moved forward by a monotonic timer so a device clock change
 * never makes a countdown jump. `uncertain` when the device clock disagreed with the server's at receipt. Request time is charged against freshness, including response latency.
 */
export interface PlanClock { serverNow: number; fetchedMono: number; uncertain: boolean }

export function planClock(report: Pick<PlanUsageReport, "serverNow">, deviceNow: number, mono: number): PlanClock {
  return { serverNow: report.serverNow, fetchedMono: mono, uncertain: Math.abs(deviceNow - report.serverNow) > PLAN_CLOCK_SKEW_MS };
}

export const planNow = (clock: PlanClock, mono: number): number => clock.serverNow + Math.max(0, mono - clock.fetchedMono);

/** "Codex · Ada: 72% used" names the account; the owner's own reads "you". */
export function planRowName(row: Pick<PlanUsageRow, "engine" | "bot">): string {
  return t("settings.l6.usage.plan.rowName", { engine: row.engine, bot: row.bot ?? t("settings.l6.usage.plan.you") });
}

/** The window's label from its length, never the engine's own limit name. */
export function planWindowLabel(w: Pick<PlanUsageWindowView, "windowSeconds">): string {
  const s = w.windowSeconds;
  if (s && s % 86_400 === 0) return t("settings.l6.usage.plan.windowDays", { count: s / 86_400 });
  if (s && s % 3_600 === 0) return t("settings.l6.usage.plan.windowHours", { count: s / 3_600 });
  return t("settings.l6.usage.plan.windowPlan");
}

/** Minute granularity; under a minute is "less than a minute". */
export function planDuration(ms: number): string {
  if (ms < 60_000) return t("settings.l6.usage.plan.lessThanMinute");
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return t("settings.l6.usage.plan.m", { minutes });
  if (minutes < 24 * 60) return t("settings.l6.usage.plan.hm", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  return t("settings.l6.usage.plan.dh", { days: Math.floor(minutes / 1_440), hours: Math.floor((minutes % 1_440) / 60) });
}

/** "8 minutes ago" in the page's language. */
export function planAgo(ms: number): string {
  const rtf = new Intl.RelativeTimeFormat(localeCode(), { numeric: "auto" });
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  if (minutes < 1_440) return rtf.format(-Math.floor(minutes / 60), "hour");
  return rtf.format(-Math.floor(minutes / 1_440), "day");
}

function zoneOffset(at: number, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const offset = part.replace(/^GMT/, "");
  return `UTC${offset === "" ? "+00:00" : offset}`;
}

/** "Today, 15:40 (Asia/Bangkok, UTC+07:00)" in the device zone; "about ..." when the clocks disagree. */
export function planResetWhen(resetsAt: number, now: number, uncertain: boolean, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const locale = localeCode();
  const day = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  // Advance the calendar in UTC, then compare its date in the selected zone.
  const tomorrow = new Date(Date.UTC(part("year"), part("month") - 1, part("day") + 1));
  const tomorrowDay = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(tomorrow);
  const dayLabel = day(resetsAt) === day(now) ? t("settings.l6.usage.plan.today")
    : day(resetsAt) === tomorrowDay ? t("settings.l6.usage.plan.tomorrow")
    : new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", month: "short", day: "numeric" }).format(resetsAt);
  const clock = new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(resetsAt);
  const when = `${dayLabel}, ${clock} (${timeZone}, ${zoneOffset(resetsAt, timeZone)})`;
  return uncertain ? t("settings.l6.usage.plan.about", { time: when }) : when;
}

export interface PlanWindowLines {
  label: string;
  /** A measured percentage, else null (no bar is drawn). */
  percent: number | null;
  /** The percent line, or the "Last reported" line for a stale reading. */
  used: string;
  reset: string;
  /** The reset instant in UTC, for a tooltip; null when unknown. */
  resetUtc: string | null;
  limitReached: string | null;
}

export function planRowStale(row: PlanUsageRow, now: number): boolean {
  return row.status === "stale" || row.status === "deferred" || (row.status === "current" && (row.freshUntil == null || now >= row.freshUntil));
}

export function planWindowLines(row: PlanUsageRow, w: PlanUsageWindowView, now: number, uncertain: boolean, timeZone?: string): PlanWindowLines {
  const percent = w.usedPercent === null ? null : Math.round(w.usedPercent);
  const ago = planAgo(now - (row.checkedAt ?? now));
  const used = planRowStale(row, now)
    ? (percent === null ? t("settings.l6.usage.plan.staleNoPercent", { ago }) : t("settings.l6.usage.plan.stale", { percent, ago }))
    : (percent === null ? t("settings.l6.usage.plan.notMeasured") : t("settings.l6.usage.plan.used", { percent }));
  let reset: string;
  if (w.resetsAt === null) reset = t("settings.l6.usage.plan.resetUnknown");
  else if (w.resetsAt <= now) reset = row.refreshing ? t("settings.l6.usage.plan.resetReachedLive") : t("settings.l6.usage.plan.resetReached");
  else reset = t("settings.l6.usage.plan.resetsIn", { time: planDuration(w.resetsAt - now), when: planResetWhen(w.resetsAt, now, uncertain, timeZone) });
  return {
    label: planWindowLabel(w),
    percent,
    used,
    reset,
    resetUtc: w.resetsAt === null ? null : new Date(w.resetsAt).toISOString(),
    limitReached: w.limitReached ? t("settings.l6.usage.plan.limitReached") : null,
  };
}

/** The row's own status line: checking, checked, or not available. Separate from the windows' values. */
export function planRowStatus(row: PlanUsageRow, now: number): string {
  if (row.windows.length === 0) return row.refreshing ? t("settings.l6.usage.plan.checking") : t("settings.l6.usage.plan.notAvailableRow");
  const checked = planRowStale(row, now) ? "" : t("settings.l6.usage.plan.checked", { ago: planAgo(now - (row.checkedAt ?? now)) });
  return row.refreshing ? [checked, t("settings.l6.usage.plan.checking")].filter(Boolean).join(" ") : checked;
}

/** The card's empty line: a Cloud home says so plainly; elsewhere usage appears when Codex reports it. */
export function planEmptyLine(report: Pick<PlanUsageReport, "cloud">): string {
  return report.cloud ? t("settings.l6.usage.plan.cloud") : t("settings.l6.usage.plan.empty");
}

export function planOmittedLine(omitted: number): string | null {
  return omitted > 0 ? t("settings.l6.usage.plan.omitted", { count: omitted }) : null;
}
