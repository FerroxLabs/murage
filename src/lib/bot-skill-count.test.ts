import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getSkillCount,
  intakeOwnsTheQuestion,
  invalidateSkillCount,
  loadSkillCount,
  needsSetup,
  resetSkillCounts,
  setSkillCount,
  subscribeSkillCounts,
} from "./bot-skill-count";

afterEach(() => resetSkillCounts());

describe("what the count means", () => {
  it("only a READ zero means the agent was never configured", () => {
    expect(needsSetup(0)).toBe(true);
    // not read yet, and unreadable, are both "change nothing"
    expect(needsSetup(null)).toBe(false);
    expect(needsSetup(-1)).toBe(false);
    expect(needsSetup(3)).toBe(false);
  });

  it("the intake owns the setup question once the answer is known either way", () => {
    // With no skills it asks the question better than the seeded quiz; with
    // skills there is no question left. Only an unreadable count defers.
    expect(intakeOwnsTheQuestion(0)).toBe(true);
    expect(intakeOwnsTheQuestion(4)).toBe(true);
    expect(intakeOwnsTheQuestion(null)).toBe(false);
    expect(intakeOwnsTheQuestion(-1)).toBe(false);
  });
});

describe("reading a bot's skills", () => {
  it("reads once and shares the answer with every caller", async () => {
    const request = vi.fn(async () => ({ skills: [{ name: "a" }, { name: "b" }] }));
    await Promise.all([loadSkillCount("bot-1", request), loadSkillCount("bot-1", request)]);
    // Two components ask; one request goes out. Without this the intake card
    // and the transcript would double every read.
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/bots/bot-1/skills");
    expect(getSkillCount("bot-1")).toBe(2);
  });

  it("records an unreachable route as unknown, never as unconfigured", async () => {
    await loadSkillCount("bot-1", async () => {
      throw new Error("offline");
    });
    expect(getSkillCount("bot-1")).toBe(-1);
    expect(needsSetup(getSkillCount("bot-1"))).toBe(false);
  });

  it("treats a malformed answer as zero rather than crashing the chat", async () => {
    await loadSkillCount("bot-1", async () => ({}) as any);
    expect(getSkillCount("bot-1")).toBe(0);
  });

  it("notifies subscribers when a count lands or is invalidated", async () => {
    const seen: Array<number | null> = [];
    const stop = subscribeSkillCounts(() => seen.push(getSkillCount("bot-1")));
    setSkillCount("bot-1", 3);
    invalidateSkillCount("bot-1");
    stop();
    setSkillCount("bot-1", 9);
    expect(seen).toEqual([3, null]);
  });

  it("asks again after an install invalidates the cache", async () => {
    const request = vi.fn(async () => ({ skills: [{ name: "a" }] }));
    await loadSkillCount("bot-1", request);
    invalidateSkillCount("bot-1");
    expect(getSkillCount("bot-1")).toBeNull();
    await loadSkillCount("bot-1", request);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps counts per bot, so switching agents cannot show the wrong one", async () => {
    await loadSkillCount("bot-1", async () => ({ skills: [] }));
    await loadSkillCount("bot-2", async () => ({ skills: [{ name: "a" }] }));
    expect(needsSetup(getSkillCount("bot-1"))).toBe(true);
    expect(needsSetup(getSkillCount("bot-2"))).toBe(false);
  });

  it("does not grow without bound across a long session", async () => {
    for (let index = 0; index < 260; index++) setSkillCount(`bot-${index}`, 1);
    expect(getSkillCount("bot-0")).toBeNull();
    expect(getSkillCount("bot-259")).toBe(1);
  });
});
