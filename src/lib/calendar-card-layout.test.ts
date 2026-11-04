import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { calendarCardLayout } from "./calendar-card-layout";

const HOUR = 64;

describe("a calendar card fits its height (upstream f0a2f45ae)", () => {
  it("gives a 30-minute routine one line, an hour two, and a quarter hour the title alone", () => {
    expect(calendarCardLayout((30 / 60) * HOUR)).toBe("compact");
    expect(calendarCardLayout(HOUR)).toBe("roomy");
    expect(calendarCardLayout(16)).toBe("tiny");
  });

  it("is what the calendar card draws from, with every detail on hover", () => {
    const page = readFileSync(fileURLToPath(new URL("../components/RoutineCalendarPage.tsx", import.meta.url)), "utf8");
    expect(page).toContain("const fit = calendarCardLayout(height);");
    expect(page).toContain('title={[name, niceTime(item.at), detail].filter(Boolean).join(" · ")}');
    expect(page).not.toContain("previewDuration >= 30 &&");
    expect(page).toMatch(/const HOUR_HEIGHT = 64;/);
  });
});
