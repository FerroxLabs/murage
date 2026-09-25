// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  formatSnoozedUntil, pickedTimeValue, pickedTimeToEpoch, questionBadgeLabel, questionsIn, quietBot, quietGroup,
  sidebarBotAttention, sidebarGroupAttention, snoozePresets, threadIsQuiet, zonedTime,
} from "./thread-snooze";

const NY = "America/New_York", TOKYO = "Asia/Tokyo";
// Thursday 2026-09-24 15:30 in New York (EDT, UTC-4).
const THURSDAY = Date.UTC(2026, 8, 24, 19, 30);

describe("snooze presets", () => {
  it("offers an hour, tomorrow morning, next week and a picked time, in the owner's zone", () => {
    const presets = snoozePresets(THURSDAY, { timeZone: NY, locale: "en-US" });
    expect(presets.map(preset => preset.label)).toEqual(["1 hour", "Tomorrow morning", "Next week"]);
    expect(presets[0]!.until).toBe(THURSDAY + 60 * 60 * 1000);
    expect(presets[1]!.until).toBe(Date.UTC(2026, 8, 25, 13, 0)); // Fri 9:00 EDT
    expect(presets[2]!.until).toBe(Date.UTC(2026, 8, 28, 13, 0)); // Mon 9:00 EDT
    expect(presets[1]!.detail).toBe("Fri 9:00 AM");
    expect(presets[2]!.detail).toBe("Mon 9:00 AM");
  });

  it("uses the zone's own calendar, so late evening in Tokyo is already tomorrow there", () => {
    const presets = snoozePresets(THURSDAY, { timeZone: TOKYO, locale: "en-US" });
    // Friday 04:30 in Tokyo: tomorrow morning is Saturday 9:00 JST.
    expect(presets[1]!.until).toBe(Date.UTC(2026, 8, 26, 0, 0));
  });

  it("next week on a Monday means the Monday after, and crosses a clock change cleanly", () => {
    const monday = Date.UTC(2026, 10, 2, 14, 0); // Mon 2 Nov 2026 09:00 EST
    expect(snoozePresets(monday, { timeZone: NY })[2]!.until).toBe(Date.UTC(2026, 10, 9, 14, 0));
    const beforeChange = Date.UTC(2026, 9, 31, 14, 0); // Sat 31 Oct, EDT
    expect(snoozePresets(beforeChange, { timeZone: NY })[1]!.until).toBe(Date.UTC(2026, 10, 1, 14, 0)); // Sun 9:00 EST
  });

  it("turns a wall clock time in a zone into the moment", () => {
    expect(zonedTime(2026, 9, 24, 9, 0, NY)).toBe(Date.UTC(2026, 8, 24, 13, 0));
    expect(zonedTime(2026, 9, 31, 9, 0, NY)).toBe(Date.UTC(2026, 9, 1, 13, 0));
  });

  it("reads and writes the picked time field in the owner's zone", () => {
    expect(pickedTimeValue(Date.UTC(2026, 8, 25, 13, 0), NY)).toBe("2026-09-25T09:00");
    expect(pickedTimeToEpoch("2026-09-25T09:00", NY)).toBe(Date.UTC(2026, 8, 25, 13, 0));
    for (const bad of ["", "tomorrow", "2026-13-01T09:00"]) expect(pickedTimeToEpoch(bad, NY)).toBeNull();
  });
});

describe("the snoozed marker", () => {
  const clock = { timeZone: NY, locale: "en-US" };
  it("says when, in plain words", () => {
    expect(formatSnoozedUntil(THURSDAY + 60 * 60 * 1000, THURSDAY, clock)).toBe("Snoozed until 4:30 PM");
    expect(formatSnoozedUntil(Date.UTC(2026, 8, 25, 13, 0), THURSDAY, clock)).toBe("Snoozed until tomorrow, 9:00 AM");
    expect(formatSnoozedUntil(Date.UTC(2026, 8, 28, 13, 0), THURSDAY, clock)).toBe("Snoozed until Mon 9:00 AM");
    expect(formatSnoozedUntil(Date.UTC(2026, 9, 14, 13, 0), THURSDAY, clock)).toBe("Snoozed until Oct 14, 9:00 AM");
  });
});

describe("what a snooze quiets", () => {
  const snoozes = new Map([["quiet", THURSDAY + 1000], ["asking", THURSDAY + 1000], ["expired", THURSDAY - 1]]);
  const questions = { asking: 1 };

  it("is quiet only while the time is ahead and nothing is owed in it", () => {
    expect(threadIsQuiet("quiet", { snoozes, questions, now: THURSDAY })).toBe(true);
    expect(threadIsQuiet("expired", { snoozes, questions, now: THURSDAY })).toBe(false);
    expect(threadIsQuiet("asking", { snoozes, questions, now: THURSDAY }), "a question wakes it").toBe(false);
    expect(threadIsQuiet("quiet", { snoozes, questions, now: THURSDAY, waiting: true }), "an approval wakes it").toBe(false);
    expect(threadIsQuiet("other", { snoozes, questions, now: THURSDAY })).toBe(false);
  });

  it("drops a snoozed conversation's unread from its bot, and keeps everything else", () => {
    const bot = { threadId: "quiet", unread: true, activity: "idle" as const, tasks: [
      { threadId: "quiet", unread: true }, { threadId: "loud", unread: false, activity: "waiting-on-you" as const }] };
    const isQuiet = (threadId: string) => threadId === "quiet";
    expect(quietBot(bot, isQuiet)).toMatchObject({ unread: false, tasks: [{ unread: false }, { activity: "waiting-on-you" }] });
    const both = { ...bot, tasks: [{ threadId: "quiet", unread: true }, { threadId: "loud", unread: true }] };
    expect(quietBot(both, isQuiet).unread, "another conversation still counts").toBe(true);
    const untouched = quietBot(both, () => false);
    expect(untouched).toBe(both);
    expect(quietBot({ threadId: "quiet", unread: true }, isQuiet).unread, "a bot with no task list").toBe(false);
  });

  it("quiets a channel whose open conversation is snoozed", () => {
    const group = { threadId: "quiet", unread: true };
    expect(quietGroup(group, threadId => threadId === "quiet").unread).toBe(false);
    expect(quietGroup(group, () => false)).toBe(group);
  });
});

describe("the question badge", () => {
  it("adds up a row's conversations and says it plainly", () => {
    expect(questionsIn(["a", "b", "c", "a"], { a: 2, c: 1, z: 9 })).toBe(3);
    expect(questionsIn([], {})).toBe(0);
    expect(questionBadgeLabel(1)).toBe("1 question for you");
    expect(questionBadgeLabel(3)).toBe("3 questions for you");
    expect(questionBadgeLabel(0)).toBe("");
  });
});

describe("a sidebar row", () => {
  const attention = { snoozes: new Map([["open", THURSDAY + 1000], ["room", THURSDAY + 1000]]), questions: { other: 2, "room-2": 1 } };

  it("weighs a bot without its snoozed conversation, counts its questions and names the snooze", () => {
    const bot = { threadId: "open", unread: true, activity: "idle" as const,
      tasks: [{ threadId: "open", unread: true }, { threadId: "other", unread: false }] };
    const row = sidebarBotAttention(bot, attention, THURSDAY);
    expect(row.bot.unread).toBe(false);
    expect(row.questions).toBe(2);
    expect(row.snoozedUntil).toBe(THURSDAY + 1000);
    // Waiting on the owner in the open conversation: nothing is held back.
    const waiting = sidebarBotAttention({ ...bot, activity: "waiting-on-you" as const,
      tasks: [{ threadId: "open", unread: true, activity: "waiting-on-you" as const }] }, attention, THURSDAY);
    expect(waiting.bot.unread).toBe(true);
    expect(waiting.snoozedUntil).toBeUndefined();
  });

  it("does the same for a channel across all its conversations", () => {
    const group = { threadId: "room", unread: true, tasks: [{ threadId: "room" }, { threadId: "room-2" }] };
    const row = sidebarGroupAttention(group, attention, THURSDAY);
    expect(row).toMatchObject({ questions: 1, snoozedUntil: THURSDAY + 1000 });
    expect(row.group.unread).toBe(false);
    const woke = sidebarGroupAttention(group, attention, THURSDAY + 1000);
    expect(woke.group.unread).toBe(true);
    expect(woke.snoozedUntil).toBeUndefined();
  });
});
