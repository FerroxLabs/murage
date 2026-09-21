import { describe, expect, it } from "vitest";

import { FIRST_RUN_CREW_PROFILE, crewReading, installFirstRunCrew } from "./first-run-crew";

/**
 * "HELP ME RUN MY BUSINESS" HAS TO ACTUALLY INSTALL SOMETHING.
 *
 * The screen that follows it says "Installed and running" and then names two
 * bots and a review. A job that drew that screen without installing anything
 * would be the worst possible thing to be wrong about, because it is the
 * first claim in the whole first run the person can go and check.
 *
 * The request function is handed in, so this drives the real order of calls
 * without a server: catalogue, then a review of an explicit selection, then
 * an import carrying that review's own hashes. The importer refuses anything
 * that was not reviewed first, so the order is the part with a rule in it.
 */
const CATALOG = {
  profiles: [
    { id: "starter-personal-home", agents: [{ key: "a", name: "A" }], routines: [] },
    {
      id: FIRST_RUN_CREW_PROFILE,
      agents: [
        { key: "business-planner", name: "Business Planner" },
        { key: "draft-partner", name: "Draft Partner" },
      ],
      routines: [{
        key: "weekly-business-review",
        name: "Weekly business review (suggested)",
        time: "09:00",
        weekdays: [1],
        durationMinutes: 15,
        enabledAfterInstall: false,
      }],
    },
  ],
};

function recorder(over: Record<string, (body: any) => unknown> = {}) {
  const calls: { action: string; body: any }[] = [];
  const request = async (path: string, init?: { method?: string; body?: string }) => {
    expect(path).toBe("/api/starter-profiles");
    const body = JSON.parse(init?.body ?? "{}");
    calls.push({ action: body.action, body });
    const answer = over[body.action];
    if (answer) {
      const value = answer(body);
      if (value instanceof Error) throw value;
      return value;
    }
    if (body.action === "catalog") return CATALOG;
    if (body.action === "preview") return { archiveSha256: "sha", reviewHash: "review", scan: { blocked: false } };
    return { bots: [], routines: [] };
  };
  return { calls, request };
}

describe("the crew the business job installs", () => {
  it("reviews the exact selection it then imports, and imports everything", async () => {
    const { calls, request } = recorder();
    await installFirstRunCrew(request);
    expect(calls.map((call) => call.action)).toEqual(["catalog", "preview", "import"]);

    const [, review, imported] = calls;
    expect(review.body.selection).toEqual(imported.body.selection);
    // Every bot and the review, because the screen that follows names all of
    // them. A partial selection describes a crew the person did not get.
    expect(imported.body.selection.agents).toEqual(["business-planner", "draft-partner"]);
    expect(imported.body.selection.routines).toEqual(["weekly-business-review"]);
    // The import carries the review's own hashes, which is what the importer
    // refuses to proceed without.
    expect(imported.body.archiveSha256).toBe("sha");
    expect(imported.body.reviewHash).toBe("review");
  });

  it("describes the crew from the package rather than from memory", async () => {
    const reading = await installFirstRunCrew(recorder().request);
    expect(reading.agents.map((agent) => agent.name)).toEqual(["Business Planner", "Draft Partner"]);
    expect(reading.routine).toMatchObject({ time: "09:00", weekdays: [1], durationMinutes: 15, enabledAfterInstall: false });
  });

  // A person who presses the job twice, or comes back to a workspace that
  // already has the crew, must see their crew rather than an error about
  // review hashes. The route answers 409 for a package already imported.
  it("treats an already-installed crew as a yes", async () => {
    const already = Object.assign(new Error("This reviewed package was already imported"), { status: 409 });
    const { request } = recorder({ import: () => already });
    const reading = await installFirstRunCrew(request);
    expect(reading.agents).toHaveLength(2);
  });

  it("does not swallow a refusal that is not that one", async () => {
    const { request } = recorder({ import: () => Object.assign(new Error("nope"), { status: 400 }) });
    await expect(installFirstRunCrew(request)).rejects.toThrow(/nope/);
  });

  it("installs nothing when the review says the contents are blocked", async () => {
    const { calls, request } = recorder({ preview: () => ({ scan: { blocked: true } }) });
    await expect(installFirstRunCrew(request)).rejects.toThrow(/content checks/i);
    expect(calls.map((call) => call.action), "a blocked package was imported anyway").not.toContain("import");
  });

  it("refuses to pretend when the profile is not on this computer", async () => {
    const { request } = recorder({ catalog: () => ({ profiles: [] }) });
    await expect(installFirstRunCrew(request)).rejects.toThrow(/not available/i);
  });

  it("says there is no review rather than inventing one", () => {
    const reading = crewReading({ id: FIRST_RUN_CREW_PROFILE, agents: [], routines: [] });
    expect(reading.routine).toBeNull();
  });
});
