import { describe, expect, it } from "vitest";

import { businessResult, type FirstRunCrewReading } from "../src/lib/first-run-flow.ts";
import { starterProfileContents } from "./starter-profiles.ts";

/**
 * THE CREW SCREEN AGAINST THE REAL PACKAGE.
 *
 * "Help me run my business" installs `starter-solo-business`, and the screen
 * that follows tells the person what they just got. The approved simulation
 * said three bots and two routines; the package holds two agents and one
 * routine. A screen that described a crew the person does not have is the
 * worst possible thing to be wrong about at that exact moment, because it is
 * the first thing in the whole first run they can go and check.
 *
 * So this test reads the SHIPPED FILE, through the same loader the installer
 * uses, and drives the real result function with what it finds. Nothing is
 * hand written except the two role descriptions, and those are keyed by the
 * package's own agent keys, so a renamed or removed bot takes its
 * description with it rather than leaving an orphaned sentence on screen.
 *
 * It reads a file and calls two functions. It starts nothing, and it is not
 * the app.
 */
function readSoloBusiness(): FirstRunCrewReading {
  const pkg = starterProfileContents("starter-solo-business").manifest.definition.package;
  const routine = (pkg.routines ?? [])[0];
  return {
    agents: pkg.agents.map((agent) => ({ key: agent.key, name: agent.name })),
    routine: routine
      ? {
          name: routine.name,
          time: routine.schedule.type === "daily" ? routine.schedule.time : "",
          weekdays: routine.schedule.type === "daily" ? routine.schedule.weekdays ?? [] : [],
          durationMinutes: routine.durationMinutes ?? 0,
          enabledAfterInstall: Boolean(routine.enabledAfterInstall),
        }
      : null,
  };
}

describe("what the business job actually installs", () => {
  const crew = readSoloBusiness();

  it("is two bots and one routine, not three and two", () => {
    expect(crew.agents).toHaveLength(2);
    expect(crew.routine).not.toBeNull();
  });

  it("names them the way the screen names them", () => {
    const result = businessResult(crew);
    expect(result.botsEyebrow).toBe("Two bots");
    expect(result.bots.map((bot) => bot.name)).toEqual(["Business Planner", "Draft Partner"]);
    // Every bot the person gets has a line saying what it is for. A bot with
    // no role renders as a bare name, which is a logo rather than an offer.
    for (const bot of result.bots) {
      expect(bot.role, `${bot.name} has no role written for it`).toBeTruthy();
    }
  });

  it("describes the review from the package's own schedule", () => {
    const result = businessResult(crew);
    expect(result.reviewLine).toBe(
      "Weekly business review (suggested), Mondays at 9:00 am, 15 minutes. "
      + "It arrives switched off so nothing starts behind your back.",
    );
  });

  it("offers to switch it on because it really does install paused", () => {
    expect(crew.routine!.enabledAfterInstall).toBe(false);
    expect(businessResult(crew).offer!.label).toBe("Switch the Monday review on");
  });

  it("says Monday because the package says Monday", () => {
    expect(crew.routine!.weekdays).toEqual([1]);
    expect(crew.routine!.time).toBe("09:00");
  });

  it("claims no third bot, no Friday wrap and no second brief anywhere", () => {
    const result = businessResult(crew);
    const everything = [
      result.header, result.lead, result.botsEyebrow, result.reviewEyebrow ?? "",
      result.reviewLine ?? "", result.offer?.label ?? "", result.offer?.why ?? "",
      ...result.bots.flatMap((bot) => [bot.name, bot.role ?? ""]),
    ].join(" ");
    expect(everything).not.toMatch(/three bots|two routines|friday|7:30|morning brief/i);
  });
});
