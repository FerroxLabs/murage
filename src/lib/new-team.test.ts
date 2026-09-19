import { describe, expect, it, vi } from "vitest";

import {
  createTeam,
  defaultTeamLead,
  existingTeamNames,
  newTeamProblem,
  teamCandidates,
  type NewTeamBot,
} from "./new-team";

const bot = (id: string, extra: Partial<NewTeamBot> = {}): NewTeamBot => ({ id, name: id[0].toUpperCase() + id.slice(1), ...extra });
const kessler = bot("kessler", { section: "Operations", chiefOfStaff: true });
const rex = bot("rex", { section: "Operations" });
const moss = bot("moss");
const dax = bot("dax", { section: "Sales", chiefOfStaff: true });
const sable = bot("sable", { chiefOfStaff: true, chiefScope: "workspace" });
const bots = [kessler, rex, moss, dax, sable];

describe("what a new team cannot be", () => {
  const existing = ["Operations", "Sales"];
  it("needs a name", () => {
    expect(newTeamProblem({ name: "", botIds: ["moss"] }, bots, existing)).toBe("Give the team a name.");
    expect(newTeamProblem({ name: "   ", botIds: ["moss"] }, bots, existing)).toBe("Give the team a name.");
  });
  it("does not copy a sidebar heading or an existing team, whatever the case", () => {
    expect(newTeamProblem({ name: "bots", botIds: ["moss"] }, bots, existing)).toBe('"Bots" is already a heading in the sidebar. Choose another name.');
    expect(newTeamProblem({ name: " operations ", botIds: ["moss"] }, bots, existing)).toBe(
      "There is already a team called Operations. To add bots to it, use Move to team… on each bot.",
    );
  });
  it("needs a bot, because a team only shows while a bot is in it", () => {
    expect(newTeamProblem({ name: "Research", botIds: [] }, bots, existing)).toBe(
      "Choose at least one bot. A team shows in the sidebar while it has a bot in it.",
    );
  });
  it("cannot take two leads", () => {
    expect(newTeamProblem({ name: "Research", botIds: ["kessler", "dax"] }, bots, existing)).toBe(
      "Kessler and Dax each lead a team, and a team can have only one lead. Untick all but one of them.",
    );
  });
  it("accepts a new name with bots", () => {
    expect(newTeamProblem({ name: "Research", botIds: ["moss", "kessler"] }, bots, existing)).toBeNull();
  });
});

it("lists the sidebar's team names once each, leaving out hidden bots", () => {
  expect(existingTeamNames(
    [{ section: "Operations" }, { section: " Operations " }, { section: "Ghosts", hidden: true }, {}],
    [{ section: "Clients" }, {}],
  )).toEqual(["Operations", "Clients"]);
});

it("offers every visible bot except the Chief of Staff", () => {
  expect(teamCandidates([...bots, bot("ghost", { hidden: true })]).map((b) => b.id)).toEqual(["kessler", "rex", "moss", "dax"]);
});

it("keeps a chosen bot's lead role as the default lead", () => {
  expect(defaultTeamLead(["rex", "kessler"], bots)).toBe("kessler");
  expect(defaultTeamLead(["rex", "moss"], bots)).toBe("");
});

describe("creating a team", () => {
  const deps = () => ({
    request: vi.fn(async (_path: string, init: { method: string; body: string }) => {
      const body = JSON.parse(init.body) as { name: string; botIds: string[] };
      return { section: body.name, bots: body.botIds.map((id) => ({ ...bots.find((b) => b.id === id)!, section: body.name })) };
    }),
    applyBots: vi.fn(),
    setRole: vi.fn(),
    saveInstructions: vi.fn(async () => ({})),
  });

  it("files the bots through the team route, then sets the lead, then saves the instructions", async () => {
    const d = deps();
    const result = await createTeam({ name: " Research ", botIds: ["moss", "rex"], leadId: "moss", instructions: "Cite sources." }, bots, d);
    expect(d.request).toHaveBeenCalledWith("/api/sidebar-sections", { method: "POST", body: JSON.stringify({ name: "Research", botIds: ["moss", "rex"] }) });
    expect(d.applyBots.mock.calls[0][0].map((b: NewTeamBot) => [b.id, b.section])).toEqual([["moss", "Research"], ["rex", "Research"]]);
    expect(d.setRole.mock.calls).toEqual([["moss", "leader"]]);
    expect(d.saveInstructions).toHaveBeenCalledWith("Research", "Cite sources.");
    expect(result).toEqual({ ok: true, section: "Research", text: "Research created with 2 bots" });
  });

  it("leaves a lead that already leads alone, and skips empty instructions", async () => {
    const d = deps();
    await createTeam({ name: "Research", botIds: ["kessler", "moss"], leadId: "kessler", instructions: "  " }, bots, d);
    expect(d.setRole).not.toHaveBeenCalled();
    expect(d.saveInstructions).not.toHaveBeenCalled();
  });

  it("\"No lead\" stops a moved lead from leading", async () => {
    const d = deps();
    await createTeam({ name: "Research", botIds: ["kessler", "moss"], leadId: "", instructions: "" }, bots, d);
    expect(d.setRole.mock.calls).toEqual([["kessler", "member"]]);
  });

  it("tries nothing else when filing fails", async () => {
    const d = deps();
    d.request.mockRejectedValueOnce(new Error("A team can have only one lead."));
    const result = await createTeam({ name: "Research", botIds: ["moss"], leadId: "moss", instructions: "x" }, bots, d);
    expect(result).toEqual({ ok: false, error: "A team can have only one lead." });
    expect(d.applyBots).not.toHaveBeenCalled();
    expect(d.setRole).not.toHaveBeenCalled();
    expect(d.saveInstructions).not.toHaveBeenCalled();
  });

  it("says what applied when only the instructions fail", async () => {
    const d = deps();
    d.saveInstructions.mockRejectedValueOnce(new Error("section context is capped at 24KB"));
    const result = await createTeam({ name: "Research", botIds: ["moss"], leadId: "", instructions: "long" }, bots, d);
    expect(result).toEqual({
      ok: true,
      section: "Research",
      text: "Research created with 1 bot",
      error: "Research created with 1 bot, but its instructions were not saved (section context is capped at 24KB). Open them from the team's heading to try again.",
    });
  });
});
