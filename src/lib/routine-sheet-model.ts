// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L5B: what the routine sheet and the All routines list show, from state
// the app already holds (state.routines, state.routineRuns, bots, groups).
// Pure: the components render it, the phone list (L7) reuses the day buckets.
// Nothing here sends a request; the sheet calls the existing routes.

import { t } from "@/lib/i18n";
import { addDays, startOfDay } from "@/lib/routine-calendar";
import type { Routine, RoutineRun, RoutineRunStatus, RoutineSchedule } from "@/lib/routines";
import { levelName } from "@/lib/fold-words";
import { permissionModeOf, routineEffectiveMode, type PermissionMode } from "@/lib/permission-mode";
import { nextOccurrence } from "@/lib/schedule-words";
import { routineHealthNotes } from "@/lib/routine-health";

export interface SheetBot { id: string; name: string; hidden?: boolean; autoApprove?: boolean; fullAccess?: boolean; noLimits?: boolean }
export interface SheetGroup { id: string; name: string }

/** Past this many routines the list groups by bot, shows a filter box and puts "Failed this week" first. */
export const ROUTINE_LIST_GROUP_AT = 10;
export const LAST_RUNS = 5;
const WEEK = 7 * 24 * 60 * 60_000;
const OPEN_STATUSES: readonly RoutineRunStatus[] = ["queued", "running", "waiting", "needs-you"];
const PROBLEM_STATUSES: readonly RoutineRunStatus[] = ["failed", "missed"];

function timeWords(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function dayName(day: number): string {
  // 2024-01-07 was a Sunday; day 0..6 lands on Sunday..Saturday.
  return new Date(2024, 0, 7 + day).toLocaleDateString([], { weekday: "long" });
}

/** "Today at 8:00 AM", "Tomorrow at ...", "Friday at ...", or a date past a week. */
export function occurrenceWords(at: number, now: number): string {
  const time = timeWords(at);
  const today = startOfDay(now);
  const day = startOfDay(at);
  if (day === today) return t("ux.l5b.when.today", { time });
  if (day === startOfDay(addDays(today, 1))) return t("ux.l5b.when.tomorrow", { time });
  // A weekday alone only for the coming week; a past run (or a later one) also gets its date.
  const within = day > today && day < startOfDay(addDays(today, 7));
  const label = within
    ? new Date(at).toLocaleDateString([], { weekday: "long" })
    : new Date(at).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  return t("ux.l5b.when.day", { day: label, time });
}

/** The When line in the routine's own words. */
export function scheduleWords(schedule: RoutineSchedule, now: number): string {
  if (schedule.type === "once") return occurrenceWords(schedule.at, now);
  if (schedule.type === "limit_reset") return t("ux.l5b.when.limitReset");
  if (schedule.type === "app_event") return t("ux.l5b.when.appEvent");
  if (schedule.type === "interval") {
    const m = schedule.everyMinutes;
    if (m === 60) return t("ux.l5b.when.everyHour");
    if (m % 60 === 0) return t("ux.l5b.when.everyHours", { count: m / 60 });
    return t("ux.l5b.when.everyMinutes", { count: m });
  }
  const [h, min] = schedule.time.split(":").map(Number);
  const time = timeWords(new Date(2024, 0, 7, h, min).getTime());
  const days = [...schedule.weekdays].sort();
  const key = days.join(",");
  if (days.length === 7) return t("ux.l5b.when.everyDay", { time });
  if (key === "1,2,3,4,5") return t("ux.l5b.when.weekdays", { time });
  if (key === "0,6") return t("ux.l5b.when.weekends", { time });
  return t("ux.l5b.when.days", { days: joinDays(days.map(dayName)), time });
}

function joinDays(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function runStatusWords(status: RoutineRunStatus): string {
  switch (status) {
    case "completed": return t("ux.l5b.run.completed");
    case "failed": return t("ux.l5b.run.failed");
    case "missed": return t("ux.l5b.run.missed");
    case "cancelled": return t("ux.l5b.run.cancelled");
    case "running": return t("ux.l5b.run.running");
    case "queued": return t("ux.l5b.run.queued");
    case "waiting":
    case "needs-you": return t("ux.l5b.run.waiting");
  }
}

export interface RoutineSheetModel {
  id: string;
  name: string;
  who: SheetBot | null;
  whenText: string;
  nextAt: number | null;
  paused: boolean;
  level: { mode: PermissionMode | null; own: boolean; text: string };
  reportsTo: string;
  /** Newest first, at most five. */
  lastRuns: RoutineRun[];
  needsLook: boolean;
  /** A run of this routine is under way: Run now waits. */
  busy: boolean;
  /** What the bot is told to do, as saved (empty when there is none). Read
   * from the routine the app already holds: a phone or browser only holds the
   * routines of bots it may see, so the sheet shows nothing new to anyone. */
  instructions: string;
  /** The names of the files that go with each run. */
  attachments: Array<{ id: string; name: string }>;
  /** "No time limit" or "Stops if still running after 30 min". */
  runLimitText: string;
  /** Failure streak and skipped runs, in words (routine-health). */
  healthNotes: Array<{ tone: "danger" | "muted"; text: string }>;
  /** A repeating routine that hands each run the last report. */
  carriesLastReport: boolean;
}

/** "30 min", "2 hr", "1 hr 30 min". */
export function durationWords(minutes: number): string {
  if (minutes < 60) return t("ux.l5b.limit.minutes", { count: minutes });
  if (minutes % 60 === 0) return t("ux.l5b.limit.hours", { count: minutes / 60 });
  return t("ux.l5b.limit.hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function runLimitWords(timeoutMinutes: number | undefined | null): string {
  return timeoutMinutes == null ? t("ux.l5b.limit.none") : t("ux.l5b.limit.after", { time: durationWords(timeoutMinutes) });
}

function runsOf(routineId: string, runs: readonly RoutineRun[]): RoutineRun[] {
  return runs.filter((run) => run.routineId === routineId).sort((a, b) => (b.startedAt ?? b.scheduledFor) - (a.startedAt ?? a.scheduledFor));
}

/** Its last settled run did not finish, or the server counts a failure streak, or a run waits on the owner. */
export function routineNeedsLook(routine: Routine, runs: readonly RoutineRun[]): boolean {
  if ((routine.failureStreak ?? 0) > 0) return true;
  const own = runsOf(routine.id, runs);
  if (own.some((run) => run.status === "waiting" || run.status === "needs-you")) return true;
  const settled = own.find((run) => !OPEN_STATUSES.includes(run.status));
  return Boolean(settled && PROBLEM_STATUSES.includes(settled.status));
}

export function routineSheetModel(
  routine: Routine,
  runs: readonly RoutineRun[],
  bots: readonly SheetBot[],
  groups: readonly SheetGroup[],
  now: number,
): RoutineSheetModel {
  const bot = bots.find((candidate) => candidate.id === routine.botId) ?? null;
  const botName = bot?.name ?? "";
  const nextAt = routine.enabled ? routine.nextRunAt ?? nextOccurrence(routine.schedule, now) : null;
  const mode = bot ? permissionModeOf({ autoApprove: Boolean(bot.autoApprove), fullAccess: Boolean(bot.fullAccess), noLimits: bot.noLimits }) : null;
  const own = routine.permissionMode !== undefined;
  const effective = bot && own
    ? routineEffectiveMode(routine, { autoApprove: Boolean(bot.autoApprove), fullAccess: Boolean(bot.fullAccess), noLimits: bot.noLimits })
    : routine.permissionMode ?? mode;
  const levelText = effective === null
    ? ""
    : own
      ? t("ux.l5b.level.own", { level: levelName(effective) })
      : t("ux.l5b.level.follows", { bot: botName, level: levelName(effective) });
  const group = routine.target === "room-goal" ? groups.find((candidate) => candidate.id === routine.groupId) : undefined;
  const reportsTo = routine.deliverTo === "list"
    ? t("ux.l5b.reports.list")
    : group
      ? t("ux.l5b.reports.channel", { channel: group.name })
      : t("ux.l5b.reports.chat", { bot: botName });
  const own5 = runsOf(routine.id, runs);
  return {
    id: routine.id,
    name: routine.name,
    who: bot,
    whenText: scheduleWords(routine.schedule, now),
    nextAt,
    paused: !routine.enabled,
    level: { mode: effective, own, text: levelText },
    reportsTo,
    lastRuns: own5.slice(0, LAST_RUNS),
    needsLook: routineNeedsLook(routine, runs),
    busy: own5.some((run) => OPEN_STATUSES.includes(run.status)),
    instructions: (routine.prompt ?? "").trim(),
    attachments: (routine.attachments ?? []).map((attachment) => ({ id: attachment.id, name: attachment.name })),
    runLimitText: runLimitWords(routine.timeoutMinutes),
    healthNotes: routineHealthNotes(routine),
    carriesLastReport: routine.carryLastReport === true && routine.schedule.type !== "once",
  };
}

/** A failed or missed run in the last seven days. */
export function failedThisWeek(routine: Routine, runs: readonly RoutineRun[], now: number): boolean {
  return runs.some((run) => run.routineId === routine.id && PROBLEM_STATUSES.includes(run.status) && (run.finishedAt ?? run.scheduledFor) >= now - WEEK);
}

export interface RoutineListSection {
  /** "failed", or a bot id, or "all" when the list is short. */
  key: string;
  title: string;
  routines: Routine[];
}

export interface RoutineListModel {
  /** Past ten routines: a filter box, grouped by bot, "Failed this week" first. */
  large: boolean;
  total: number;
  sections: RoutineListSection[];
}

function byName(a: Routine, b: Routine): number {
  return a.name.localeCompare(b.name);
}

export function routineListModel(
  routines: readonly Routine[],
  runs: readonly RoutineRun[],
  bots: readonly SheetBot[],
  options: { filter?: string; now: number },
): RoutineListModel {
  const total = routines.length;
  const large = total > ROUTINE_LIST_GROUP_AT;
  const needle = (large ? options.filter ?? "" : "").trim().toLowerCase();
  const botName = (id: string) => bots.find((bot) => bot.id === id)?.name ?? "";
  const shown = routines.filter((routine) => !needle || routine.name.toLowerCase().includes(needle) || botName(routine.botId).toLowerCase().includes(needle));
  if (!large) return { large, total, sections: shown.length ? [{ key: "all", title: "", routines: [...shown].sort(byName) }] : [] };
  const failed = shown.filter((routine) => failedThisWeek(routine, runs, options.now)).sort(byName);
  const failedIds = new Set(failed.map((routine) => routine.id));
  const byBot = new Map<string, Routine[]>();
  for (const routine of shown) {
    if (failedIds.has(routine.id)) continue;
    byBot.set(routine.botId, [...(byBot.get(routine.botId) ?? []), routine]);
  }
  const botSections = [...byBot.entries()]
    .map(([botId, list]) => ({ key: botId, title: botName(botId), routines: list.sort(byName) }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return {
    large,
    total,
    sections: [...(failed.length ? [{ key: "failed", title: t("ux.l5b.list.failedWeek"), routines: failed }] : []), ...botSections],
  };
}

export interface RoutineDayBuckets {
  today: Array<{ routine: Routine; at: number }>;
  tomorrow: Array<{ routine: Routine; at: number }>;
  later: Array<{ routine: Routine; at: number }>;
}

/** The phone list (L7): Today, Tomorrow, Later this week, by each routine's next run. Paused routines and ones no clock starts are left out. */
export function routineDayBuckets(routines: readonly Routine[], now: number): RoutineDayBuckets {
  const buckets: RoutineDayBuckets = { today: [], tomorrow: [], later: [] };
  const tomorrow = startOfDay(addDays(now, 1));
  const dayAfter = startOfDay(addDays(now, 2));
  const weekEnd = startOfDay(addDays(now, 7));
  for (const routine of routines) {
    if (!routine.enabled) continue;
    const at = routine.nextRunAt ?? nextOccurrence(routine.schedule, now);
    if (at === null || at < now || at >= weekEnd) continue;
    const entry = { routine, at };
    if (at < tomorrow) buckets.today.push(entry);
    else if (at < dayAfter) buckets.tomorrow.push(entry);
    else buckets.later.push(entry);
  }
  for (const list of [buckets.today, buckets.tomorrow, buckets.later]) list.sort((a, b) => a.at - b.at);
  return buckets;
}
