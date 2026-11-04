// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Needs you door's rules (UX L2B): keys, the sweep, snooze times, oldest
// first, bot chips, grouping past 20, and one return per snoozed row.
import { describe, expect, it, vi } from "vitest";
import { NEEDS_GROUP_AFTER, botChips, cameBack, doorOrder, isHeldActivation, createSnoozeReturns, groupNeeds, needsKeyAction, nextAfterAnswer, oldestFirst, snoozeTarget, waitingSinceTime } from "./needs-keys";

const key = (k: string, more: Partial<{ typing: boolean; handled: boolean; inCard: boolean }> = {}) => ({ key: k, typing: false, handled: false, inCard: false, ...more });
const ids = ["a", "b", "c"];

describe("needs keys", () => {
  it("Enter opens the row in focus, Esc closes the open card, J and K move, S snoozes", () => {
    expect(needsKeyAction(key("Enter"), ids, "b", null)).toEqual({ type: "open", id: "b" });
    expect(needsKeyAction(key("Escape"), ids, "b", "b")).toEqual({ type: "close" });
    expect(needsKeyAction(key("Escape"), ids, "b", null)).toBeNull();
    expect(needsKeyAction(key("j"), ids, "a", null)).toEqual({ type: "focus", id: "b" });
    expect(needsKeyAction(key("ArrowDown"), ids, "c", null)).toEqual({ type: "focus", id: "c" });
    expect(needsKeyAction(key("k"), ids, "b", null)).toEqual({ type: "focus", id: "a" });
    expect(needsKeyAction(key("s"), ids, "c", null)).toEqual({ type: "snooze", id: "c" });
  });
  it("leaves digits, Enter and letters to the open card, and never acts while typing or on a used key", () => {
    for (const k of ["1", "9", "Enter", "s", "j"]) expect(needsKeyAction(key(k, { inCard: true }), ids, "b", "b"), k).toBeNull();
    expect(needsKeyAction(key("1"), ids, "b", null)).toBeNull();
    expect(needsKeyAction(key("s", { typing: true }), ids, "b", null)).toBeNull();
    expect(needsKeyAction(key("Enter", { handled: true }), ids, "b", null)).toBeNull();
    // Esc still closes from a field inside the open card.
    expect(needsKeyAction(key("Escape", { typing: true, inCard: true }), ids, "b", "b")).toEqual({ type: "close" });
  });
  it("opens the next row after an answer, then the one above, then none", () => {
    expect(nextAfterAnswer(ids, "a")).toBe("b");
    expect(nextAfterAnswer(ids, "c")).toBe("b");
    expect(nextAfterAnswer(["a"], "a")).toBeNull();
  });
});

describe("a held key", () => {
  it("drops repeated Enter, Space and digits, and lets the first press and other keys through", () => {
    expect(isHeldActivation({ key: "1", repeat: true })).toBe(true);
    expect(isHeldActivation({ key: "9", repeat: true })).toBe(true);
    expect(isHeldActivation({ key: "1", repeat: false })).toBe(false);
    expect(isHeldActivation({ key: "0", repeat: true })).toBe(false);
    expect(isHeldActivation({ key: "s", repeat: true })).toBe(true);
    expect(isHeldActivation({ key: "s", repeat: false })).toBe(false);
    expect(isHeldActivation({ key: "Enter", repeat: true })).toBe(true);
    expect(isHeldActivation({ key: " ", repeat: true })).toBe(true);
    expect(isHeldActivation({ key: "Enter", repeat: false })).toBe(false);
    expect(isHeldActivation({ key: "j", repeat: true })).toBe(false);
  });
});

describe("snooze times", () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 3, h, m).getTime();
  it("before 16:00 it is today at 17:00", () => {
    const target = snoozeTarget(at(9, 30));
    expect(target).toMatchObject({ tomorrow: false, time: "17:00" });
    expect(target.until).toBe(at(17));
    expect(snoozeTarget(at(15, 59)).tomorrow).toBe(false);
  });
  it("from 16:00 on it is tomorrow at 9:00", () => {
    for (const now of [at(16), at(23, 59)]) {
      const target = snoozeTarget(now);
      expect(target).toMatchObject({ tomorrow: true, time: "9:00" });
      expect(target.until).toBe(new Date(2026, 10, 4, 9).getTime());
    }
  });
  it("fires one return per row, and Undo cancels it", () => {
    vi.useFakeTimers();
    try {
      const returns = createSnoozeReturns();
      const fire = vi.fn();
      returns.schedule("x", 1_000, 0, fire);
      returns.schedule("x", 2_000, 0, fire);
      vi.advanceTimersByTime(1_500);
      expect(fire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(600);
      expect(fire).toHaveBeenCalledTimes(1);
      const other = vi.fn();
      returns.schedule("y", 1_000, 0, other);
      returns.cancel("y");
      vi.advanceTimersByTime(5_000);
      expect(other).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("the list", () => {
  it("reads waiting since as a 24-hour time today, with the date before today", () => {
    const now = new Date(2026, 10, 3, 12).getTime();
    expect(waitingSinceTime(new Date(2026, 10, 3, 7, 12).getTime(), now)).toBe("07:12");
    expect(waitingSinceTime(new Date(2026, 10, 2, 7, 12).getTime(), now)).toMatch(/, 07:12$/);
  });
  it("puts the oldest first", () => {
    expect(oldestFirst([{ at: 3 }, { at: 1 }, { at: 2 }]).map(row => row.at)).toEqual([1, 2, 3]);
  });
  it("puts rows that came back from a snooze on top, in the order they came back, then the rest oldest first", () => {
    const rows = [{ at: 1, snoozedUntil: null }, { at: 5, snoozedUntil: 90 }, { at: 2, snoozedUntil: 200 }, { at: 3, snoozedUntil: 50 }, { at: 0 }];
    expect(doorOrder(rows, 100).map(row => row.at)).toEqual([3, 5, 0, 1, 2]);
    expect(cameBack({ snoozedUntil: 100 }, 100)).toBe(true);
    expect(cameBack({ snoozedUntil: 101 }, 100)).toBe(false);
    expect(cameBack({ snoozedUntil: null }, 100)).toBe(false);
  });
  it("makes a chip per bot, most waiting first", () => {
    const rows = ["Max", "Nova", "Max", "Ivy", "Max", "Nova"].map(bot => ({ bot }));
    expect(botChips(rows, row => row.bot)).toEqual([{ bot: "Max", count: 3 }, { bot: "Nova", count: 2 }, { bot: "Ivy", count: 1 }]);
  });
  it("groups by bot only past 20 rows, in order of each bot's oldest card", () => {
    const few = Array.from({ length: NEEDS_GROUP_AFTER }, (_, i) => ({ bot: i % 2 ? "Max" : "Nova" }));
    expect(groupNeeds(few, row => row.bot)).toHaveLength(1);
    const many = [{ bot: "Juno" }, ...Array.from({ length: NEEDS_GROUP_AFTER }, (_, i) => ({ bot: i % 2 ? "Max" : "Nova" }))];
    expect(groupNeeds(many, row => row.bot).map(group => [group.bot, group.rows.length])).toEqual([["Juno", 1], ["Nova", 10], ["Max", 10]]);
  });
});
