import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FIRST_RUN_CREW_PROFILE, crewReading, enableFirstRunReview, installFirstRunCrew } from "./first-run-crew";

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

/**
 * THE DEFECT: "SWITCH THE MONDAY REVIEW ON" WAS A NO-OP THAT REPORTED SUCCESS.
 *
 * The handler was `onSwitchOn={() => setReviewTaken(true)}` and there was no
 * request anywhere behind it. The routine installs `enabled: false`, so the
 * person pressed a switch, read "On. It runs on Monday." and had a paused
 * routine. Everything below drives the real calls the button now makes.
 */
const REVIEW = "Weekly business review (suggested)";

function routines(rows: readonly { id: string; name: string; enabled: boolean }[], patched?: (body: any) => unknown) {
  const calls: { path: string; method: string; body: any }[] = [];
  const request = async (path: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init?.method ?? "GET", body });
    if (path === "/api/routines" && !init?.method) return { routines: rows };
    const answer = patched?.(body);
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    return { routine: { ...rows.find((row) => `/api/routines/${row.id}` === path)!, ...body } };
  };
  return { calls, request };
}

describe("switching the Monday review on", () => {
  it("really enables the installed routine and confirms the answer", async () => {
    const { calls, request } = routines([
      { id: "other", name: "Something else", enabled: false },
      { id: "review-1", name: REVIEW, enabled: false },
    ]);
    await expect(enableFirstRunReview(request, REVIEW)).resolves.toBeUndefined();
    expect(calls.map((call) => `${call.method} ${call.path}`))
      .toEqual(["GET /api/routines", "PATCH /api/routines/review-1"]);
    expect(calls[1].body).toEqual({ enabled: true });
  });

  it("refuses to report success when the switch did not take", async () => {
    // A 404 from the desktop gate, or an id the store does not hold, both
    // come back without an enabled routine. Saying "On" there is the bug.
    const { request } = routines([{ id: "review-1", name: REVIEW, enabled: false }], () => ({ routine: { enabled: false } }));
    await expect(enableFirstRunReview(request, REVIEW)).rejects.toThrow(/did not switch on/i);
  });

  it("does not swallow a refusal from the route", async () => {
    const { request } = routines([{ id: "review-1", name: REVIEW, enabled: false }], () => Object.assign(new Error("no such route"), { status: 404 }));
    await expect(enableFirstRunReview(request, REVIEW)).rejects.toThrow(/no such route/);
  });

  it("says so rather than switching nothing on when the review is not here", async () => {
    const { calls, request } = routines([{ id: "other", name: "Something else", enabled: false }]);
    await expect(enableFirstRunReview(request, REVIEW)).rejects.toThrow(/nothing to switch on/i);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("leaves an already running review alone", async () => {
    const { calls, request } = routines([{ id: "review-1", name: REVIEW, enabled: true }]);
    await expect(enableFirstRunReview(request, REVIEW)).resolves.toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("switches on the row that was just written when two carry the name", async () => {
    const { calls, request } = routines([
      { id: "review-old", name: REVIEW, enabled: false },
      { id: "review-new", name: REVIEW, enabled: false },
    ]);
    await enableFirstRunReview(request, REVIEW);
    expect(calls[1].path).toBe("/api/routines/review-new");
  });

  // THE WIRING ITSELF. The handler lives inside a component and this suite
  // has no DOM to click it with, so the one thing a test can still hold is
  // that the button is not wired straight back to the flag that draws "On".
  it("is what the button is wired to, and the flag is not set by the click alone", () => {
    const card = readFileSync(fileURLToPath(new URL("../components/FirstRunJobsCard.tsx", import.meta.url)), "utf8");
    expect(card, "the switch went back to setting a flag with nothing behind it")
      .not.toContain("onSwitchOn={() => setReviewTaken(true)}");
    expect(card).toContain("onSwitchOn={() => void switchOnReview()}");
    expect(card).toContain("await enableFirstRunReview(api, name)");
  });
});
