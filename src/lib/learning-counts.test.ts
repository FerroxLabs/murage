// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "This month: learned N, remembers M", the Overview sentence and the count on
// the settings list (B5m). Counts only: nothing here nags or invents.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import { badgeLabel, badgeText, countsPath, fetchLearningCounts, monthLine, overviewSentence, readSeen, writeSeen } from "./learning-counts";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("the counts request", () => {
  it("asks the bot's own route, with the time the owner last looked", () => {
    expect(countsPath("bot 1")).toBe("/api/bots/bot%201/learning/counts");
    expect(countsPath("ember", 1700000000000.9)).toBe("/api/bots/ember/learning/counts?since=1700000000000");
  });
  it("reads numbers only: anything else is zero", async () => {
    const request = vi.fn(async () => ({ counts: { month: "2026-10", lessons: 3, memories: "5", wins: -2, undone: null }, unseen: 2 }));
    expect(await fetchLearningCounts(request, "ember", 5)).toEqual({ counts: { month: "2026-10", lessons: 3, memories: 0, wins: 0, undone: 0 }, unseen: 2 });
    expect(request).toHaveBeenCalledWith("/api/bots/ember/learning/counts?since=5");
    expect(await fetchLearningCounts(async () => ({}), "ember")).toEqual({ counts: { month: "", lessons: 0, memories: 0, wins: 0, undone: 0 }, unseen: 0 });
  });
});

describe("the words", () => {
  it("the month line names learned and remembers", () => {
    expect(monthLine({ lessons: 14, memories: 9 })).toBe("This month: learned 14, remembers 9");
  });
  it("the Overview sentence is the short form, and says nothing for a bot that learned nothing", () => {
    expect(overviewSentence({ lessons: 0, memories: 0 })).toBeNull();
    expect(overviewSentence({ lessons: 1, memories: 0 })).toBe("Learned 1 thing this month");
    expect(overviewSentence({ lessons: 14, memories: 9 })).toBe("Learned 23 things this month");
  });
  it("the badge is a number or nothing, capped at 99+", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeLabel(0)).toBeNull();
    expect(badgeText(3)).toBe("3");
    expect(badgeText(250)).toBe("99+");
    expect(badgeLabel(3)).toBe("3 new");
  });
});

describe("when the owner last looked", () => {
  const store = new Map<string, string>();
  const fake = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  afterEach(() => { store.clear(); vi.unstubAllGlobals(); });
  it("the first read is the baseline, so a bot's past is never a badge", () => {
    vi.stubGlobal("localStorage", fake);
    expect(readSeen("ember", 1000)).toBe(1000);
    expect(readSeen("ember", 9000)).toBe(1000);
    writeSeen("ember", 5000);
    expect(readSeen("ember", 9000)).toBe(5000);
    expect(readSeen("dax", 7000)).toBe(7000);
  });
  it("blocked storage is not an error", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readSeen("ember", 1234)).toBe(1234);
    expect(() => writeSeen("ember", 1)).not.toThrow();
  });
});

describe("the settings list", () => {
  it("shows the count on one row, and opening that section clears it", () => {
    const dialog = read("../components/BotSettingsDialog.tsx");
    expect(dialog).toContain("useLearningBadge(bot.id, section === LEARNING_BADGE_SECTION)");
    expect(dialog).toContain("item.id === LEARNING_BADGE_SECTION && badgeText(newLearning)");
    expect(read("./learning-counts.ts")).toMatch(/if \(looking\) \{ writeSeen\(botId\); return; \}/);
  });
  it("keeps to the copy rules: no em dash, no safety talk, no price talk, no vendor name", () => {
    expect(read("./learning-counts.ts")).not.toMatch(/—|\b(safe|safely|safety|unsafe)\b|composio|\bfree\b|always-on/i);
  });
});
