import { describe, expect, it } from "vitest";

import { plainClock, plainTimeZone, plainWeekdays } from "./plain-time-zone.ts";

// 1.0.18 U6 E32 (upstream 698cef40c)
describe("time zones in plain words", () => {
  it.each([
    ["Asia/Calcutta", "India time"],
    ["Asia/Kolkata", "India time"],
    ["America/Los_Angeles", "Pacific time"],
    ["America/New_York", "Eastern time"],
    ["America/Phoenix", "Arizona time"],
    ["Europe/London", "UK time"],
    ["Asia/Dubai", "UAE time"],
    ["UTC", "UTC"],
    ["Etc/UTC", "UTC"],
    ["Etc/GMT", "UTC"],
  ])("says %s as %s", (zone, said) => {
    expect(plainTimeZone(zone)).toBe(said);
  });

  it("never answers with an IANA id, an abbreviation or an offset", () => {
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      const said = plainTimeZone(zone);
      if (said === "UTC") continue;
      expect(said, zone).not.toContain("/");
      expect(said, zone).not.toMatch(/^(?:[A-Z]{1,5}|GMT[+-].*)$/);
    }
  });

  it("falls back to the place name for an unknown zone and never throws on a bad one", () => {
    expect(plainTimeZone("Nowhere/Some_Place")).toBe("Some Place time");
    expect(() => plainTimeZone("")).not.toThrow();
    expect(() => plainTimeZone(undefined as unknown as string)).not.toThrow();
    expect(() => plainTimeZone("Asia/Kolkata", "not a locale!!")).not.toThrow();
  });

  it("names days and clocks the way people do", () => {
    expect(plainWeekdays([1, 2, 3, 4, 5])).toBe("weekdays");
    expect(plainWeekdays([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(plainWeekdays([3, 1])).toBe("Monday, Wednesday");
    expect(plainClock("09:00")).toBe("9:00");
    expect(plainClock("17:30")).toBe("17:30");
  });
});
