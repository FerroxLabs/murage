// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Your day (Today slice 1.0.18): what still runs between now and the viewer's midnight. Run it in any timezone;
// the DST case holds everywhere and bites in America/New_York (TZ_RUN), where 1 Nov 2026 has 25 hours.
import { describe, expect, it } from "vitest";
import type { Routine, RoutineSchedule } from "@/lib/routines";
import { DAY_ROW_CAP, dayTimeline, localMidnight } from "./today-day";

const HOUR = 3_600_000;
const at = (h: number, m = 0) => new Date(2026, 10, 4, h, m).getTime();
const routine = (id: string, schedule: RoutineSchedule, nextRunAt: number | null, over: Partial<Routine> = {}): Routine => ({
  id, name: `R ${id}`, prompt: "", target: "bot", botId: "nova", runOn: "ember", enabled: true, schedule, durationMinutes: 5, nextRunAt, createdAt: 0, updatedAt: 0, ...over,
});
const daily: RoutineSchedule = { type: "daily", time: "17:00", weekdays: [] };
const every = (everyMinutes: number): RoutineSchedule => ({ type: "interval", everyMinutes, anchorAt: 0 });

describe("Your day", () => {
  const now = at(9, 30);

  it("gives a daily routine one row, at the server's nextRunAt", () => {
    const day = dayTimeline([routine("d", daily, at(17))], now);
    expect(day.rows).toEqual([{ id: `d@${at(17)}`, routineId: "d", botId: "nova", name: "R d", at: at(17) }]);
    expect(day.more).toBe(0);
    expect(day.midnight).toBe(new Date(2026, 10, 5).getTime());
  });

  it("steps an interval from nextRunAt until midnight, never past it", () => {
    const day = dayTimeline([routine("i", every(180), at(15))], now, 20);
    expect(day.rows.map((row) => row.at)).toEqual([at(15), at(18), at(21)]);
  });

  it("collapses an interval under 60 minutes to one row that says how often", () => {
    const day = dayTimeline([routine("i", every(15), at(9, 45)), routine("h", every(60), at(22))], now, 20);
    expect(day.rows.map((row) => [row.routineId, row.everyMinutes])).toEqual([["i", 15], ["h", undefined], ["h", undefined]]);
    expect(day.rows.map((row) => row.at)).toEqual([at(9, 45), at(22), at(23)]);
  });

  it("gives once and limit_reset one row each, and app_event and disabled routines none", () => {
    const day = dayTimeline([
      routine("o", { type: "once", at: at(12) }, at(12)),
      routine("l", { type: "limit_reset", engineKey: "claude" }, at(14)),
      routine("e", { type: "app_event", triggerId: "t1" }, at(13)),
      routine("x", daily, at(11), { enabled: false }),
    ], now);
    expect(day.rows.map((row) => row.routineId)).toEqual(["o", "l"]);
  });

  it("keeps nothing past local midnight, nothing already past and no null time, but names tomorrow's next run", () => {
    const day = dayTimeline([
      routine("late", daily, at(23, 59)),
      routine("tomorrow", daily, new Date(2026, 10, 5, 0, 0).getTime()),
      routine("past", daily, at(9)),
      routine("none", daily, null),
      routine("nan", daily, Number.NaN),
    ], now);
    expect(day.rows.map((row) => row.routineId)).toEqual(["late"]);
    expect(day.next).toMatchObject({ routineId: "late" });
    const empty = dayTimeline([routine("tomorrow", daily, new Date(2026, 10, 5, 8).getTime()), routine("past", daily, at(9))], now);
    expect(empty.rows).toEqual([]);
    expect(empty.next).toEqual({ routineId: "tomorrow", name: "R tomorrow", at: new Date(2026, 10, 5, 8).getTime() });
    expect(empty.hasRoutines).toBe(true);
    expect(dayTimeline([], now)).toMatchObject({ rows: [], more: 0, next: null, hasRoutines: false });
  });

  it("finds the real midnight on a DST day: every hourly step of the 23 or 25 hour day, and none after", () => {
    // 1 Nov 2026: clocks go back in New York (25 hours); 8 Mar 2026: forward (23 hours). Elsewhere these are 24.
    for (const [y, m, d] of [[2026, 10, 1], [2026, 2, 8]] as const) {
      const start = new Date(y, m, d, 0, 30).getTime();
      const realMidnight = new Date(y, m, d + 1).getTime();
      expect(localMidnight(start)).toBe(realMidnight);
      const hours = Math.ceil((realMidnight - start) / HOUR);
      const day = dayTimeline([routine("h", every(60), start)], start, 100);
      expect(day.rows).toHaveLength(hours);
      expect(day.rows.at(-1)!.at).toBeLessThan(realMidnight);
      expect(day.rows.at(-1)!.at + HOUR).toBeGreaterThanOrEqual(realMidnight);
      expect(day.midnight).toBe(realMidnight);
    }
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === "America/New_York") {
      expect(localMidnight(new Date(2026, 10, 1, 12).getTime()) - new Date(2026, 10, 1).getTime()).toBe(25 * HOUR);
      expect(dayTimeline([routine("h", every(60), new Date(2026, 10, 1, 0, 30).getTime())], new Date(2026, 10, 1, 0, 30).getTime(), 100).rows).toHaveLength(25);
    }
  });

  it("shows at most six rows, a collapsed row counting once, then how many more", () => {
    const day = dayTimeline([routine("i", every(10), at(9, 40)), routine("h", every(60), at(10))], now);
    expect(DAY_ROW_CAP).toBe(6);
    expect(day.rows).toHaveLength(6);
    expect(day.rows[0]).toMatchObject({ routineId: "i", everyMinutes: 10 });
    // 1 collapsed + 14 hourly (10:00 .. 23:00) = 15 rows, 6 shown.
    expect(day.more).toBe(9);
  });
});
