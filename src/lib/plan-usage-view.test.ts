import { describe, expect, it } from "vitest";
import {
  planClock, planEmptyLine, planNow, planOmittedLine, planResetWhen, planRowName, planRowStatus, planWindowLines,
  type PlanUsageRow,
} from "./plan-usage-view";

const NOW = Date.UTC(2026, 10, 5, 6, 26, 0); // 13:26 in Asia/Bangkok
const win = { label: "ignored-engine-name", usedPercent: 72, resetsAt: NOW + (2 * 60 + 14) * 60_000, windowSeconds: 18_000, limitReached: false };
const row = (over: Partial<PlanUsageRow> = {}): PlanUsageRow => ({
  id: "a0", engine: "Codex", bot: "Ada", status: "current", checkedAt: NOW - 8 * 60_000, freshUntil: NOW + 120_000, windows: [win], refreshing: false, ...over,
});

describe("DG8 slice 3 plan usage lines", () => {
  it("names the account and the window from its length, never the engine's limit name", () => {
    expect(planRowName(row())).toBe("Codex · Ada");
    expect(planRowName(row({ bot: null }))).toBe("Codex · you");
    const lines = planWindowLines(row(), win, NOW, false, "Asia/Bangkok");
    expect(lines.label).toBe("5-hour window");
    expect(lines.used).toBe("72% used");
    expect(lines.reset).toBe("Resets in 2 h 14 min, Today, 15:40 (Asia/Bangkok, UTC+07:00).");
    expect(lines.resetUtc).toBe("2026-11-05T08:40:00.000Z");
    expect(planWindowLines(row(), { ...win, windowSeconds: 604_800 }, NOW, false, "UTC").label).toBe("7-day window");
  });

  it("stale, unknown reset, reset reached and limit reached", () => {
    expect(planWindowLines(row({ status: "deferred" }), win, NOW, false).used).toContain("Last reported: 72% used");
    expect(planWindowLines(row({ status: "stale" }), win, NOW, false, "UTC").used).toBe("Last reported: 72% used, checked 8 minutes ago.");
    expect(planWindowLines(row(), { ...win, resetsAt: null }, NOW, false).reset).toBe("Reset time not available.");
    const past = { ...win, resetsAt: NOW - 1 };
    expect(planWindowLines(row(), past, NOW, false).reset).toBe("Reported reset time reached. Waiting for the next usage report.");
    expect(planWindowLines(row({ refreshing: true }), past, NOW, false).reset).toBe("Reported reset time reached, checking usage.");
    expect(planWindowLines(row(), { ...win, limitReached: true }, NOW, false).limitReached).toBe("This account reached its limit.");
    expect(planWindowLines(row(), { ...win, resetsAt: NOW + 30_000 }, NOW, false, "UTC").reset).toMatch(/^Resets in less than a minute, /);
    expect(planWindowLines(row(), { ...win, usedPercent: null }, NOW, false).percent).toBeNull();
  });

  it("keeps refreshing apart from the reading, and empty, Cloud and omitted lines", () => {
    expect(planRowStatus(row(), NOW)).toBe("Checked 8 minutes ago.");
    expect(planRowStatus(row({ refreshing: true }), NOW)).toBe("Checked 8 minutes ago. Checking usage.");
    expect(planRowStatus(row({ windows: [], refreshing: true }), NOW)).toBe("Checking usage.");
    expect(planRowStatus(row({ windows: [] }), NOW)).toBe("Plan usage not available for this account yet.");
    expect(planEmptyLine({ cloud: false })).toBe("Plan usage not available yet. Usage appears when Codex reports it.");
    expect(planEmptyLine({ cloud: true })).toBe("Plan usage is not reported on Cloud yet.");
    expect(planOmittedLine(3)).toBe("3 more accounts not shown.");
    expect(planOmittedLine(0)).toBeNull();
  });

  it("counts down from the server clock on a monotonic timer and says about when clocks disagree", () => {
    const clock = planClock({ serverNow: NOW }, NOW + 10 * 60_000, 1_000);
    expect(clock.uncertain).toBe(true);
    expect(planNow(clock, 61_000)).toBe(NOW + 60_000);
    expect(planNow(clock, 0)).toBe(NOW);
    expect(planResetWhen(NOW + 86_400_000, NOW, true, "UTC")).toBe("about tomorrow, 06:26 (UTC, UTC+00:00)");
    expect(planClock({ serverNow: NOW }, NOW + 5_000, 0).uncertain).toBe(false);
  });

  it("no line promises a pause, a hold or spare capacity", () => {
    const all = [
      planWindowLines(row(), win, NOW, false, "UTC"), planWindowLines(row({ status: "stale" }), { ...win, resetsAt: NOW - 1, limitReached: true }, NOW, false),
    ].flatMap((l) => [l.used, l.reset, l.limitReached ?? ""]).concat(planEmptyLine({ cloud: true }), planEmptyLine({ cloud: false }));
    for (const line of all) expect(line).not.toMatch(/pause|hold|safe|free|capacity|—/i);
  });
});

describe("reset calendar dates across DST", () => {
  it("uses tomorrow's calendar date late on spring-forward eve", () => {
    const now = Date.parse("2026-03-07T23:30:00-05:00");
    expect(planResetWhen(Date.parse("2026-03-08T23:30:00-04:00"), now, false, "America/New_York")).toContain("tomorrow");
    expect(planResetWhen(Date.parse("2026-03-09T00:30:00-04:00"), now, false, "America/New_York")).not.toContain("tomorrow");
  });
  it("uses tomorrow's calendar date early on fall-back day", () => {
    const now = Date.parse("2026-11-01T00:30:00-04:00");
    expect(planResetWhen(Date.parse("2026-11-02T00:30:00-05:00"), now, false, "America/New_York")).toContain("tomorrow");
    expect(planResetWhen(Date.parse("2026-11-01T23:30:00-05:00"), now, false, "America/New_York")).toContain("Today");
  });
});
