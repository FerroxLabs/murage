import { describe, expect, it } from "vitest";

import { buildTeamMapEdges, buildTeamMapOrg, buildTeamMapSections, teamMapStatus, type TeamMapSnapshot } from "./team-map";

const bots = [
  { id: "chief", name: "Atlas", section: "Work", chiefOfStaff: true, busy: true },
  { id: "maker", name: "Pixel", section: "Work" },
  { id: "home", name: "Mochi" },
  { id: "archived", name: "Old", hidden: true },
];

describe("team map projection", () => {
  it("groups visible bots by section and separates chiefs", () => {
    expect(buildTeamMapSections(bots)).toEqual([
      { key: "Work", name: "Work", chiefs: [bots[0]], members: [bots[1]] },
      { key: "", name: "General", chiefs: [], members: [bots[2]] },
    ]);
  });

  it("keeps the unsectioned team distinct from a section literally named General", () => {
    const projected = buildTeamMapSections([
      { id: "none", name: "Unsectioned" },
      { id: "named", name: "Named", section: " General " },
    ]);
    expect(projected.map(({ key, name }) => ({ key, name }))).toEqual([
      { key: "", name: "General" },
      { key: "General", name: "General" },
    ]);
  });

  it("keeps one edge per pair and gives live work priority", () => {
    const snapshot: TeamMapSnapshot = {
      collaborations: [{ groupId: "channel", botIds: ["chief", "maker"], lastAt: 10 }],
      queued: [{ sourceBotId: "chief", targetBotId: "maker", reason: "design" }],
      running: [{ sourceBotId: "chief", targetBotId: "maker", threadId: "task" }],
    };
    expect(buildTeamMapEdges(bots, snapshot)).toEqual([
      { sourceBotId: "chief", targetBotId: "maker", state: "running", groupId: undefined },
    ]);
  });

  it("filters archived endpoints and explains live states", () => {
    const snapshot: TeamMapSnapshot = {
      collaborations: [{ groupId: "old", botIds: ["chief", "archived"], lastAt: 10 }],
      queued: [],
      running: [],
    };
    expect(buildTeamMapEdges(bots, snapshot)).toEqual([]);
    expect(teamMapStatus(bots[0])).toEqual({ label: "Working", tone: "success" });
    expect(teamMapStatus({ id: "x", name: "X", activity: "waiting-on-you" })).toEqual({
      label: "Waiting for you",
      tone: "warning",
    });
  });
});

// ── the chart, not a row of sections ─────────────────────────────────
// The Chief above everything, teams with their leaders beneath it, and the
// individual assistants as their own branch off the Chief.

describe("buildTeamMapOrg", () => {
  const ember = { id: "ember", name: "Ember", chiefOfStaff: true, chiefScope: "workspace" as const };
  const rex = { id: "rex", name: "Rex", section: "Sales", chiefOfStaff: true };
  const dash = { id: "dash", name: "Dash", section: "Sales" };
  const bruce = { id: "bruce", name: "Bruce", section: "Smart Trader", individual: true };

  it("lifts the Chief out of the teams and gives individuals their own branch", () => {
    const org = buildTeamMapOrg([ember, rex, dash, bruce]);
    expect(org.chief).toBe(ember);
    expect(org.individuals).toEqual([bruce]);
    expect(org.teams).toEqual([{ key: "Sales", name: "Sales", chiefs: [rex], members: [dash] }]);
  });

  it("never renders an individual's group as a leaderless team", () => {
    const org = buildTeamMapOrg([ember, bruce]);
    expect(org.teams).toEqual([]);
    expect(org.individuals).toEqual([bruce]);
  });

  it("still shows the group when somebody else is filed beside an individual", () => {
    const quant = { id: "quant", name: "Quant", section: "Smart Trader" };
    const org = buildTeamMapOrg([ember, bruce, quant]);
    expect(org.individuals).toEqual([bruce]);
    expect(org.teams).toEqual([{ key: "Smart Trader", name: "Smart Trader", chiefs: [], members: [quant] }]);
  });

  it("hides archived bots from every branch", () => {
    const org = buildTeamMapOrg([ember, { ...bruce, hidden: true }, { ...rex, hidden: true }, dash]);
    expect(org.individuals).toEqual([]);
    expect(org.teams).toEqual([{ key: "Sales", name: "Sales", chiefs: [], members: [dash] }]);
  });

  it("falls back to a flat set of teams with no Chief elected", () => {
    const org = buildTeamMapOrg([rex, dash]);
    expect(org.chief).toBeNull();
    expect(org.teams).toEqual(buildTeamMapSections([rex, dash]));
  });

  it("keeps a bot that leads out of the individual branch", () => {
    const org = buildTeamMapOrg([ember, { ...rex, individual: true }]);
    expect(org.individuals).toEqual([]);
    expect(org.teams[0]?.chiefs.map((bot) => bot.id)).toEqual(["rex"]);
  });
});
