// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// B45 (upstream 943540cc1, #1864): Settings, Usage groups this month by routine.
// Routine turns show by routine; every other turn is one "Not from a routine" line.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { monthRoutineUsage } from "./usage-routines";
import { ROUTINE_USAGE_MORE, bumpRoutineUsageMonth, usageMonthKey, type RoutineUsageMonth } from "../../shared/usage-month";
import { en } from "@/locales";

const at = new Date(2026, 10, 6, 12).getTime();
const key = usageMonthKey(at);
const since = at;

describe("Usage: this month by routine", () => {
  it("sums a routine across bots, puts the rest under Not from a routine, busiest first", () => {
    const bots = [
      {
        usageMonths: { [key]: { replies: 10, input: 10_000, output: 1_000, since } },
        usageRoutineMonths: { [key]: { "r-a": { name: "Daily brief", replies: 4, input: 4_000, output: 400, since } } },
      },
      {
        usageMonths: { [key]: { replies: 5, input: 9_000, output: 900, since } },
        usageRoutineMonths: { [key]: {
          "r-a": { name: "Daily brief", replies: 1, input: 1_000, output: 100, since },
          "r-b": { name: "Inbox sweep", replies: 2, input: 6_000, output: 600, since },
        } },
      },
    ];
    const usage = monthRoutineUsage(bots, at)!;
    expect(usage.rows.map((r) => [r.id, r.name, r.replies, r.tokens])).toEqual([
      ["r-b", "Inbox sweep", 2, 6_600],
      ["r-a", "Daily brief", 5, 5_500],
    ]);
    expect(usage.rest).toEqual({ replies: 8, tokens: 20_900 - 12_100 });
  });

  it("counts new tokens the way the bot table does: a cached re-read is left out", () => {
    const bots = [{
      usageMonths: { [key]: { replies: 1, input: 1_000, cachedInput: 900, output: 10, since } },
      usageRoutineMonths: { [key]: { r: { name: "R", replies: 1, input: 1_000, cachedInput: 900, output: 10, since } } },
    }];
    const usage = monthRoutineUsage(bots, at)!;
    expect(usage.rows[0]).toMatchObject({ tokens: 110, cachedInput: 900 });
    expect(usage.rest).toEqual({ replies: 0, tokens: 0 });
  });

  it("is null when no routine ran this month (the card is left out), and ignores other months", () => {
    expect(monthRoutineUsage([{ usageMonths: { [key]: { replies: 3, input: 3, output: 3, since } } }], at)).toBeNull();
    expect(monthRoutineUsage([{ usageRoutineMonths: { "2025-01": { r: { name: "Old", replies: 9, input: 9, output: 9, since } } } }], at)).toBeNull();
  });

  it("puts routines past the cap last as Other routines, and a renamed routine reads by its latest name", () => {
    const months: Record<string, Record<string, RoutineUsageMonth>> = {};
    bumpRoutineUsageMonth(months, { id: "r-1", name: "Old name" }, { input: 5, output: 5 }, at);
    bumpRoutineUsageMonth(months, { id: "r-1", name: "New name" }, { input: 5, output: 5 }, at);
    months[key][ROUTINE_USAGE_MORE] = { name: "", replies: 7, input: 99_999, output: 1, since };
    const usage = monthRoutineUsage([{ usageRoutineMonths: months }], at)!;
    expect(usage.rows.map((r) => [r.id, r.name, r.replies])).toEqual([["r-1", "New name", 2], [ROUTINE_USAGE_MORE, null, 7]]);
  });

  it("wires the card into the Usage page and the routine into both banking calls, with plain copy", () => {
    const page = readFileSync(new URL("../components/UsageSection.tsx", import.meta.url), "utf8");
    expect(page).toContain("monthRoutineUsage(shown)");
    expect(page).toContain('t("settings.l6.usage.byRoutine")');
    expect(page).toContain('t("settings.l6.usage.notRoutine")');
    expect(page).toContain('t("settings.l6.usage.otherRoutines")');
    const server = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
    expect(server).toContain("RoutineManager.usageRoutine(routineRun));");
    expect(server).toContain("RoutineManager.usageRoutine(roomRoutine));");
    const routinesSrc = readFileSync(new URL("../../server/routines.ts", import.meta.url), "utf8");
    expect(routinesSrc).toContain(`run.triggerSource !== "channel"`);
    expect(server).toContain("routines?.roomGoalRunForThread(event.threadId)");
    expect(en["settings.l6.usage.byRoutine"]).toBe("This month by routine");
    expect(en["settings.l6.usage.notRoutine"]).toBe("Not from a routine");
    for (const k of ["settings.l6.usage.byRoutine", "settings.l6.usage.colRoutine", "settings.l6.usage.notRoutine", "settings.l6.usage.otherRoutines"] as const) {
      expect(en[k]).not.toMatch(/—/);
    }
  });
});
