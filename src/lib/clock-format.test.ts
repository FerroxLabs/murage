// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { CLOCK_OPTIONS, clockFormatter, formatClock, formatClockText } from "./clock-format";

const at = Date.UTC(2026, 9, 30, 7, 5, 42);

describe("one clock format (R1-25)", () => {
  it("follows the language: 12 hours in US English, 24 in German, never seconds", () => {
    expect(formatClock(at, { locale: "en-US", timeZone: "UTC" }).replace(/\s/g, " ")).toBe("7:05 AM");
    expect(formatClock(at, { locale: "de-DE", timeZone: "UTC" })).toMatch(/^0?7:05$/);
    expect(formatClock(at, { locale: "en-US", timeZone: "UTC" })).not.toMatch(/42/);
  });

  it("with no locale, matches what the system language gives for the same shape", () => {
    expect(formatClock(at, { timeZone: "UTC" })).toBe(new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(at));
  });

  it("never forces a 12 or 24 hour cycle and never pads the hour itself", () => {
    expect(CLOCK_OPTIONS).toEqual({ hour: "numeric", minute: "2-digit" });
    expect(clockFormatter({ locale: "en-US", timeZone: "UTC" }).resolvedOptions().hourCycle).toBe("h12");
    expect(clockFormatter({ locale: "de-DE", timeZone: "UTC" }).resolvedOptions().hourCycle).toBe("h23");
  });

  it("reuses one formatter per language and time zone", () => {
    expect(clockFormatter({ locale: "en-US", timeZone: "UTC" })).toBe(clockFormatter({ locale: "en-US", timeZone: "UTC" }));
    expect(clockFormatter({ locale: "en-US", timeZone: "UTC" })).not.toBe(clockFormatter({ locale: "en-US", timeZone: "Asia/Tokyo" }));
  });

  it("writes a schedule's HH:MM the same way, and leaves anything else alone", () => {
    expect(formatClockText("08:00", { locale: "en-US" }).replace(/\s/g, " ")).toBe("8:00 AM");
    expect(formatClockText("6:30", { locale: "en-US" }).replace(/\s/g, " ")).toBe("6:30 AM");
    expect(formatClockText("19:45", { locale: "de-DE" })).toBe("19:45");
    for (const text of ["24:00", "7:5", "noon", "", "08:00:00"]) expect(formatClockText(text, { locale: "en-US" })).toBe(text);
  });
});
