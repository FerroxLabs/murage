import { describe, expect, it } from "vitest";
import { quietHoursEndsAt } from "./notification-preferences.ts";

const prefs = (start: string, end: string, timeZone = "UTC", enabled = true) => ({ quietHours: { enabled, start, end, timeZone } });

describe("quietHoursEndsAt", () => {
  it("is null when off, unset or not covering now", () => {
    expect(quietHoursEndsAt(prefs("22:00", "07:00", "UTC", false), new Date("2026-11-09T23:00:00Z"))).toBeNull();
    expect(quietHoursEndsAt({}, new Date())).toBeNull();
    expect(quietHoursEndsAt(prefs("22:00", "07:00"), new Date("2026-11-09T12:00:00Z"))).toBeNull();
  });
  it("finds the end of a window that crosses midnight, before and after midnight", () => {
    expect(quietHoursEndsAt(prefs("22:00", "07:00"), new Date("2026-11-09T23:30:00Z"))).toBe(Date.parse("2026-11-10T07:00:00Z"));
    expect(quietHoursEndsAt(prefs("22:00", "07:00"), new Date("2026-11-10T03:15:40Z"))).toBe(Date.parse("2026-11-10T07:00:00Z"));
  });
  it("finds the end of a same-day window and honours the time zone", () => {
    expect(quietHoursEndsAt(prefs("13:00", "14:00"), new Date("2026-11-09T13:59:59Z"))).toBe(Date.parse("2026-11-09T14:00:00Z"));
    expect(quietHoursEndsAt(prefs("22:00", "07:00", "Asia/Bangkok"), new Date("2026-11-09T16:00:00Z"))).toBe(Date.parse("2026-11-10T00:00:00Z"));
  });
  it("finds the first inactive minute of a window that is almost all day (the active stretch can end before the half-way probe)", () => {
    expect(quietHoursEndsAt(prefs("22:00", "20:00"), new Date("2026-11-09T19:30:00Z"))).toBe(Date.parse("2026-11-09T20:00:00Z"));
    expect(quietHoursEndsAt(prefs("22:00", "20:00"), new Date("2026-11-09T19:59:00Z"))).toBe(Date.parse("2026-11-09T20:00:00Z"));
    expect(quietHoursEndsAt(prefs("22:00", "21:50"), new Date("2026-11-09T21:40:00Z"))).toBe(Date.parse("2026-11-09T21:50:00Z"));
  });
  it("never loops or runs past its horizon, whatever the window", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    for (const [start, end] of [["00:00", "23:59"], ["12:00", "11:59"]] as const) {
      const result = quietHoursEndsAt(prefs(start, end), new Date(now));
      if (result !== null) { expect(result).toBeGreaterThan(now); expect(result - now).toBeLessThanOrEqual(25 * 3_600_000); }
    }
  });
  it("is DST aware: the end is a real instant in the zone", () => {
    // New York falls back on 2026-11-01: 22:00 to 07:00 local spans 9 hours of clock time and 10 real hours.
    expect(quietHoursEndsAt(prefs("22:00", "07:00", "America/New_York"), new Date("2026-11-01T03:00:00Z"))).toBe(Date.parse("2026-11-01T12:00:00Z"));
  });
  it("handles a nearly all-day window", () => {
    expect(quietHoursEndsAt(prefs("00:01", "00:00"), new Date("2026-11-09T12:00:00Z"))).toBe(Date.parse("2026-11-10T00:00:00Z"));
  });
});
