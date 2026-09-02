import { afterEach, describe, expect, it, vi } from "vitest";

import {
  botTurnCount,
  getSkillCount,
  intakeMode,
  intakeOwnsTheQuestion,
  invalidateSkillCount,
  loadSkillCount,
  looksUnconfigured,
  needsSetup,
  resetSkillCounts,
  setSkillCount,
  setupOverwriteReasons,
  setupWouldOverwrite,
  subscribeSkillCounts,
  type BotSetupEvidence,
  type SkillCount,
} from "./bot-skill-count";

afterEach(() => resetSkillCounts());

/** What "New Bot" hands you: a name from the pool and nothing else. */
const BLANK: BotSetupEvidence = {};

/** Sable. A real agent in the live workspace: hand-given a title and a
 *  description, talked to, and carrying no skills the library route can see.
 *  Before H1 the card asked this agent what it was for and offered to rename
 *  it — while it was mid-conversation. */
const SABLE: BotSetupEvidence = {
  title: "Chief of Staff",
  description: "Runs Sean's week.",
  tasks: [{ usage: { turns: 12 } }],
};

describe("what the count means", () => {
  it("only a READ zero, on an agent that still looks blank, earns the question", () => {
    expect(needsSetup(0, BLANK)).toBe(true);
    // not read yet, and unreadable, are both "change nothing"
    expect(needsSetup(null, BLANK)).toBe(false);
    expect(needsSetup(-1, BLANK)).toBe(false);
    expect(needsSetup(3, BLANK)).toBe(false);
  });

  it("never asks an agent a person has already configured", () => {
    // The headline complaint: the card fired on already-configured bots and
    // offered to rename them.
    expect(needsSetup(0, SABLE)).toBe(false);
    expect(needsSetup(0, { title: "Chief of Staff" })).toBe(false);
    expect(needsSetup(0, { description: "Runs the week." })).toBe(false);
    // Whitespace is not a title.
    expect(needsSetup(0, { title: "   ", description: "\n" })).toBe(true);
  });

  it("counts a real conversation as configuration, at three turns", () => {
    const turns = (n: number): BotSetupEvidence => ({ tasks: [{ usage: { turns: n } }] });
    expect(needsSetup(0, turns(0))).toBe(true);
    expect(needsSetup(0, turns(2))).toBe(true);
    expect(needsSetup(0, turns(3))).toBe(false);
    // Across every context the agent has, not just the open one.
    expect(botTurnCount({ tasks: [{ usage: { turns: 2 } }, { usage: { turns: 1 } }, {}] })).toBe(3);
    expect(botTurnCount({})).toBe(0);
    // A record from a build before usage existed says nothing, not zero-crash.
    expect(botTurnCount({ tasks: [{}, { usage: undefined }] })).toBe(0);
  });

  it("THE COMPOSER SHOWS NOTHING AT ALL FOR A CONFIGURED AGENT — not even a chip", () => {
    // Sean, looking at Sable: "it makes no sense to hold it there when a
    // conversation as extensive as I have had with Sable has progressed and
    // she's all skilled up". A quieter chip in the same place is the same
    // noise in the same place, so there is no chip.
    expect(intakeMode(0, SABLE)).toBe("none");
    expect(intakeMode(0, BLANK)).toBe("question");
    expect(intakeMode(2, SABLE)).toBe("none");
    expect(intakeMode(null, BLANK)).toBe("none");
    expect(intakeMode(-1, BLANK)).toBe("none");
    // A configured agent with NO skills is the case that used to keep the
    // chip. It gets nothing in the composer either — the profile is the door.
    expect(intakeMode(0, { title: "Chief of Staff" })).toBe("none");
  });

  it("the profile path is always open, and warns before it touches anything", () => {
    // This is what makes removing the composer entry safe. Setup is never
    // gone; it is somewhere a person goes on purpose.
    expect(setupWouldOverwrite(0, BLANK)).toBe(false);
    expect(setupWouldOverwrite(0, SABLE)).toBe(true);
    expect(setupWouldOverwrite(4, BLANK)).toBe(true);
    // Not read, and unreadable, both warn: unknown is not permission.
    expect(setupWouldOverwrite(null, BLANK)).toBe(true);
    expect(setupWouldOverwrite(-1, BLANK)).toBe(true);
  });

  it("the warning names what it would touch, never a vague 'are you sure?'", () => {
    expect(setupOverwriteReasons(3, SABLE)).toEqual([
      "3 skills it already has",
      "its title",
      "its description",
      "a conversation 12 turns long",
    ]);
    expect(setupOverwriteReasons(1, {})).toEqual(["1 skill it already has"]);
    expect(setupOverwriteReasons(0, BLANK)).toEqual([]);
    // An unreadable count contributes nothing rather than "-1 skills".
    expect(setupOverwriteReasons(-1, { title: "x" })).toEqual(["its title"]);
  });

  it("tells a blank agent from a used one", () => {
    expect(looksUnconfigured(BLANK)).toBe(true);
    expect(looksUnconfigured(SABLE)).toBe(false);
  });

  it("the intake owns the setup question once the answer is known either way", () => {
    // With no skills it asks the question better than the seeded quiz; with
    // skills there is no question left. Only an unreadable count defers.
    expect(intakeOwnsTheQuestion(0)).toBe(true);
    expect(intakeOwnsTheQuestion(4)).toBe(true);
    expect(intakeOwnsTheQuestion(null)).toBe(false);
    expect(intakeOwnsTheQuestion(-1)).toBe(false);
  });

  it("moves in lock-step: the quiz is never suppressed with nothing to replace it", () => {
    // The failure this pins is a screen with NO way to configure the agent on
    // it: the seeded quiz hidden because "the intake owns the question", and
    // the intake rendering nothing because the agent looks configured.
    const counts: SkillCount[] = [null, -1, 0, 1, 7];
    for (const count of counts) {
      for (const bot of [BLANK, SABLE, { title: "x" }, { tasks: [{ usage: { turns: 9 } }] }]) {
        if (!intakeOwnsTheQuestion(count)) continue;
        if (intakeMode(count, bot) !== "none") continue;
        // Both hold only when the agent already has skills, or when it is
        // configured well enough that the profile — not the composer — is the
        // right place to ask. Either way `setupWouldOverwrite` is true, which
        // is exactly the state the profile action is always visible for.
        expect(setupWouldOverwrite(count, bot), `count=${count}`).toBe(true);
      }
    }
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
    expect(needsSetup(getSkillCount("bot-1"), BLANK)).toBe(false);
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
    expect(needsSetup(getSkillCount("bot-1"), BLANK)).toBe(true);
    expect(needsSetup(getSkillCount("bot-2"), BLANK)).toBe(false);
  });

  it("does not grow without bound across a long session", async () => {
    for (let index = 0; index < 260; index++) setSkillCount(`bot-${index}`, 1);
    expect(getSkillCount("bot-0")).toBeNull();
    expect(getSkillCount("bot-259")).toBe(1);
  });
});
