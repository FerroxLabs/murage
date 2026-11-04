// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L4C hints once: the coach-mark rules (UX-OVERHAUL-BUILD-PLAN L4C).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HINT_DELAY_MS, HINT_MIN_WIDTH, hintAllowed, hintKey, hintSeen, markHintSeen, resetHints } from "./hints-seen";
import { COACH_MARKS, pageCovered } from "@/components/ui/CoachMarks";
import { en } from "@/locales";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}
const blocked = {
  length: 0,
  key: () => { throw new Error("blocked"); },
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("blocked"); },
  removeItem: () => { throw new Error("blocked"); },
};
const ok = { width: 1280, firstRun: false, showing: false, covered: false };

describe("hints once", () => {
  it("shows a hint one time on this device", () => {
    const storage = memoryStorage();
    expect(hintAllowed("chat", "level-chip", ok, storage)).toBe(true);
    expect(markHintSeen("chat", "level-chip", storage)).toBe(true);
    expect(storage.map.get("help.seen.chat.level-chip")).toBe("1");
    expect(hintAllowed("chat", "level-chip", ok, storage)).toBe(false);
  });

  it("never under 400 px, never two at once, never in first run or under a window", () => {
    const storage = memoryStorage();
    expect(hintAllowed("chat", "level-chip", { ...ok, width: HINT_MIN_WIDTH - 1 }, storage)).toBe(false);
    expect(hintAllowed("chat", "level-chip", { ...ok, width: HINT_MIN_WIDTH }, storage)).toBe(true);
    expect(hintAllowed("chat", "level-chip", { ...ok, showing: true }, storage)).toBe(false);
    expect(hintAllowed("chat", "level-chip", { ...ok, firstRun: true }, storage)).toBe(false);
    expect(hintAllowed("chat", "level-chip", { ...ok, covered: true }, storage)).toBe(false);
    expect(hintAllowed("chat", "level-chip", { ...ok, width: Number.NaN }, storage)).toBe(false);
  });

  it("never at launch", () => {
    expect(HINT_DELAY_MS).toBeGreaterThanOrEqual(2000);
  });

  it("blocked storage never throws and never shows a hint that could repeat", () => {
    expect(hintSeen("chat", "level-chip", blocked)).toBe(true);
    expect(hintAllowed("chat", "level-chip", ok, blocked)).toBe(false);
    expect(markHintSeen("chat", "level-chip", blocked)).toBe(false);
    expect(() => resetHints(blocked)).not.toThrow();
    expect(hintSeen("chat", "level-chip", null)).toBe(true);
  });

  it("Show hints again forgets every hint and nothing else", () => {
    const storage = memoryStorage({ [hintKey("chat", "level-chip")]: "1", [hintKey("settings", "search")]: "1", "murage.help.width": "400" });
    resetHints(storage);
    expect([...storage.map.keys()]).toEqual(["murage.help.width"]);
  });

  it("each coach mark has words, at most two per screen, and points at a control that exists", () => {
    const perScreen = new Map<string, number>();
    for (const mark of COACH_MARKS) {
      perScreen.set(mark.screen, (perScreen.get(mark.screen) ?? 0) + 1);
      expect(Object.hasOwn(en, mark.text)).toBe(true);
    }
    expect(Math.max(...perScreen.values())).toBeLessThanOrEqual(2);
    const composer = readFileSync(fileURLToPath(new URL("../components/Composer.tsx", import.meta.url)), "utf8");
    expect(composer).toContain('data-coach="level-chip"');
  });

  it("waits while help, a menu or a window is open", () => {
    expect(pageCovered({ querySelector: (() => null) as unknown as Document["querySelector"] })).toBe(false);
    expect(pageCovered({ querySelector: (() => ({})) as unknown as Document["querySelector"] })).toBe(true);
  });
});
