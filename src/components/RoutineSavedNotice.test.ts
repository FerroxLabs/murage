// What "saved" says, and where the grid goes afterwards.
//
// Saving a 7 AM daily routine at 1 PM used to leave the grid at 1 PM with
// the new routine off screen and nothing said about it.
import { describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { window: (globalThis as { window?: unknown }).window ?? {} });
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: () => {}, initAnalytics: () => {}, track: () => {} }));
const { routineFocusAt, savedScheduleNotice } = await import("./RoutineCalendarPage");

/** Local noon on a Wednesday, so a weekday rule has somewhere to land. */
const wednesdayNoon = new Date(2026, 8, 16, 12, 0, 0).getTime();
const at = (value: number) => new Date(value);

describe("where the grid goes after a save", () => {
  it("goes to a one-off routine's own moment", () => {
    const once = { type: "once" as const, at: wednesdayNoon + 3 * 3_600_000 };
    expect(routineFocusAt(once, wednesdayNoon)).toBe(once.at);
  });

  it("goes to an interval routine's anchor", () => {
    expect(routineFocusAt({ type: "interval", everyMinutes: 15, anchorAt: wednesdayNoon }, wednesdayNoon + 9_000_000)).toBe(wednesdayNoon);
  });

  it("goes to TOMORROW's 7 AM when today's has already gone", () => {
    const daily = { type: "daily" as const, time: "07:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };
    const focus = at(routineFocusAt(daily, wednesdayNoon));
    expect(focus.getHours()).toBe(7);
    expect(focus.getDate()).toBe(at(wednesdayNoon).getDate() + 1);
  });

  it("stays on today when today's run is still ahead", () => {
    const daily = { type: "daily" as const, time: "19:30", weekdays: [0, 1, 2, 3, 4, 5, 6] };
    const focus = at(routineFocusAt(daily, wednesdayNoon));
    expect(focus.getHours()).toBe(19);
    expect(focus.getDate()).toBe(at(wednesdayNoon).getDate());
  });

  it("skips the days a weekday rule does not run", () => {
    const saturdayNoon = new Date(2026, 8, 19, 12, 0, 0).getTime();
    const weekdays = { type: "daily" as const, time: "07:00", weekdays: [1, 2, 3, 4, 5] };
    expect(at(routineFocusAt(weekdays, saturdayNoon)).getDay()).toBe(1);
  });
});

describe("what the confirmation says", () => {
  it("names the routine and reads its schedule back in words", () => {
    expect(savedScheduleNotice("Morning briefing", { type: "daily", time: "07:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }))
      .toMatch(/^Morning briefing scheduled · Every day at /);
    expect(savedScheduleNotice("Standup", { type: "daily", time: "09:15", weekdays: [1, 2, 3, 4, 5] }))
      .toMatch(/^Standup scheduled · Every weekday at /);
    expect(savedScheduleNotice("  ", { type: "interval", everyMinutes: 15, anchorAt: wednesdayNoon }))
      .toMatch(/^Routine scheduled · Every 15 min/);
  });
});
