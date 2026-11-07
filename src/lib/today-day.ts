// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Your day (Today slice 1.0.18, designs/TODAY-SLICE-1104.md section 2): what is still to run between now and
// midnight. Pure: the view hands in the routines the store holds and the viewer's clock.
//
// Exported:
//   dayTimeline(routines, now, cap = DAY_ROW_CAP): DayTimeline
//   localMidnight(now): number
//   DAY_ROW_CAP = 6, DAY_COLLAPSE_UNDER_MIN = 60
//
// Rules:
//  - One clock for the whole page, the viewer's (as today-model.ts uses). Midnight is
//    `new Date(now).setHours(24, 0, 0, 0)`, which is right on 23 and 25 hour days.
//  - Run times are the server's absolute `nextRunAt` (the owner's timezone is applied server side), kept only when
//    finite and in [now, midnight). A past or null `nextRunAt` gives no row. Disabled routines give none.
//  - `interval` steps by `everyMinutes * 60000` from `nextRunAt` until midnight; under 60 minutes it collapses to
//    one row ("Every {n} min until midnight"). `daily`, `once` and `limit_reset` give one row; `app_event` none.
//  - At most `cap` rows (a collapsed row counts once), then `more` ("and {n} more today").
//  - `next` is the earliest finite `nextRunAt >= now` over enabled routines, today or later (the empty line:
//    "Nothing else is scheduled today. Next: {name}, {when}.").
import type { Routine } from "@/lib/routines";

export const DAY_ROW_CAP = 6;
/** Intervals shorter than this collapse to one row. */
export const DAY_COLLAPSE_UNDER_MIN = 60;

export interface DayRow {
  /** `${routineId}@${at}` */
  id: string;
  routineId: string;
  botId: string;
  name: string;
  /** epoch ms */
  at: number;
  /** set on a collapsed interval row: "Every {n} min until midnight" */
  everyMinutes?: number;
}

export interface DayTimeline {
  /** in time order, at most `cap` */
  rows: DayRow[];
  /** rows past the cap ("and {n} more today") */
  more: number;
  /** the viewer's next local midnight, epoch ms */
  midnight: number;
  /** the earliest run at or after now, today or later; null when nothing is scheduled at all */
  next: { routineId: string; name: string; at: number } | null;
  /** any routine exists (enabled or not): false gives "No routines yet" */
  hasRoutines: boolean;
}

type DaySource = Pick<Routine, "id" | "botId" | "name" | "enabled" | "schedule" | "nextRunAt">;

/** The viewer's next local midnight after `now`. */
export function localMidnight(now: number): number {
  return new Date(now).setHours(24, 0, 0, 0);
}

export function dayTimeline(routines: readonly DaySource[], now: number, cap: number = DAY_ROW_CAP): DayTimeline {
  const midnight = localMidnight(now);
  const all: DayRow[] = [];
  let next: DayTimeline["next"] = null;
  for (const routine of routines) {
    if (!routine.enabled || routine.schedule.type === "app_event") continue;
    const first = routine.nextRunAt;
    if (typeof first !== "number" || !Number.isFinite(first) || first < now) continue;
    if (!next || first < next.at) next = { routineId: routine.id, name: routine.name, at: first };
    if (first >= midnight) continue;
    const row = (at: number, everyMinutes?: number): DayRow => ({
      id: `${routine.id}@${at}`, routineId: routine.id, botId: routine.botId, name: routine.name, at, ...(everyMinutes !== undefined ? { everyMinutes } : {}),
    });
    const schedule = routine.schedule;
    if (schedule.type === "interval" && Number.isFinite(schedule.everyMinutes) && schedule.everyMinutes > 0) {
      if (schedule.everyMinutes < DAY_COLLAPSE_UNDER_MIN) { all.push(row(first, schedule.everyMinutes)); continue; }
      const step = schedule.everyMinutes * 60_000;
      for (let at = first; at < midnight; at += step) all.push(row(at));
      continue;
    }
    all.push(row(first));
  }
  all.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name) || a.routineId.localeCompare(b.routineId));
  const limit = Math.max(0, Math.floor(cap));
  return { rows: all.slice(0, limit), more: Math.max(0, all.length - limit), midnight, next, hasRoutines: routines.length > 0 };
}
