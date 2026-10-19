import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextOwnerDailyOccurrence, readOwnerTimeZone, writeOwnerTimeZone } from "./timezone.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const allDays = [0, 1, 2, 3, 4, 5, 6];
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("cloud owner time zone", () => {
  it("schedules 09:00 Bangkok at 02:00 UTC while the VM uses UTC", () => {
    expect(nextOwnerDailyOccurrence("09:00", allDays, Date.parse("2026-09-30T00:00:00Z"), "Asia/Bangkok")).toBe(Date.parse("2026-09-30T02:00:00Z"));
  });
  it("skips a missing spring hour and fires a repeated fall hour only once", () => {
    expect(nextOwnerDailyOccurrence("02:30", allDays, Date.parse("2026-03-08T05:00:00Z"), "America/New_York")).toBe(Date.parse("2026-03-09T06:30:00Z"));
    expect(nextOwnerDailyOccurrence("01:30", allDays, Date.parse("2026-11-01T04:00:00Z"), "America/New_York")).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(nextOwnerDailyOccurrence("01:30", allDays, Date.parse("2026-11-01T05:31:00Z"), "America/New_York")).toBe(Date.parse("2026-11-02T06:30:00Z"));
  });
  it("keeps routine wall time when the owner travels and only changes on explicit owner intent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-cloud-tz-"));
    try {
      writeOwnerTimeZone(dir, "Asia/Bangkok");
      vi.stubEnv("MURAGE_DATA_DIR", dir); vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); vi.stubEnv("TZ", "America/Los_Angeles");
      const { nextOccurrence } = await import("../routines.ts");
      expect(readOwnerTimeZone(dir)).toBe("Asia/Bangkok");
      expect(nextOccurrence({ type: "daily", time: "09:00", weekdays: allDays }, Date.parse("2026-09-30T00:00:00Z"))).toBe(Date.parse("2026-09-30T02:00:00Z"));
      writeOwnerTimeZone(dir, "America/Los_Angeles");
      expect(nextOccurrence({ type: "daily", time: "09:00", weekdays: allDays }, Date.parse("2026-09-30T00:00:00Z"))).toBe(Date.parse("2026-09-30T16:00:00Z"));
    } finally { removeTempDirSync(dir); }
  });
});
