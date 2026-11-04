import { describe, expect, it } from "vitest";
import { leadTeamGate, leadTeamTarget } from "./team-founding.ts";

const lead = { id: "dir", section: "Demo Machine" };
const bots = [
  { id: "dir", name: "Demo Director", section: "Demo Machine", chiefOfStaff: true },
  { id: "s1", name: "Sales Lead", section: "Sales", chiefOfStaff: true },
  { id: "c1", name: "Client Lead", section: "Client A", createdByBotId: "dir", chiefOfStaff: true },
  { id: "c2", name: "Estimator", section: "Client A", createdByBotId: "dir" },
  { id: "m1", name: "Writer", section: "Mixed", createdByBotId: "dir" },
  { id: "m2", name: "Owner Bot", section: "Mixed", hidden: true },
  { id: "h1", name: "Hidden Lead", section: "Client H", createdByBotId: "dir", chiefOfStaff: true, hidden: true },
];
// `name` is no longer read: it is passed so these cases also show the 255c69640 rule (a same-name lead went on) is gone.
const decide = (requested: string, wantsLead = false, groups: Array<{ section?: string }> = [], name?: string) =>
  leadTeamTarget({ bots, groups, lead, requested, wantsLead, ...(name ? { name } : {}) });

describe("where a team lead's create_bot may file a bot", () => {
  it("its own team, as before, and never a second lead there", () => {
    expect(decide("")).toEqual({ ok: true, section: "Demo Machine", ownTeam: true });
    expect(decide("demo machine")).toEqual({ ok: true, section: "Demo Machine", ownTeam: true });
    expect(decide("", true)).toMatchObject({ ok: false, status: 403 });
  });

  it("a new team, with its lead", () => {
    expect(decide("Berwald Roofing", true)).toEqual({ ok: true, section: "Berwald Roofing", ownTeam: false });
  });

  it("a team it started keeps the team's own label, and refuses a second lead", () => {
    expect(decide("client a")).toEqual({ ok: true, section: "Client A", ownTeam: false });
    expect(decide("Client A", true)).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a team it did not start, one bot it did not make (archived too), a channel, or a sidebar heading", () => {
    for (const refused of [decide("Sales"), decide("SALES", true), decide("Mixed"), decide("Ops", false, [{ section: "ops" }]), decide("General"), decide("x".repeat(61))]) {
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toMatch(/stop and tell the owner/);
    }
  });

  it("any lead already there refuses a second one: hidden, same name, or a case variant", () => {
    expect(decide("Client H", true, [], "Another Lead")).toMatchObject({ ok: false, status: 409 });
    expect(decide("Client H", true, [], "Hidden Lead")).toMatchObject({ ok: false, status: 409 });
    expect(decide("client a", true, [], "client lead")).toMatchObject({ ok: false, status: 409 });
    expect(decide("Client A", true, [], "Other")).toMatchObject({ ok: false, status: 409 });
  });

  it("team names compare with spaces trimmed, case ignored and Unicode NFC", () => {
    const cafe = [{ id: "k1", name: "Barista", section: "Caf\u00e9 Team", createdByBotId: "dir", chiefOfStaff: true }];
    for (const spelling of ["CAF\u00c9 team ", "Cafe\u0301 Team"]) {
      expect(leadTeamTarget({ bots: cafe, groups: [], lead, requested: spelling, wantsLead: false })).toEqual({ ok: true, section: "Caf\u00e9 Team", ownTeam: false });
      expect(leadTeamTarget({ bots: cafe, groups: [], lead, requested: spelling, wantsLead: true })).toMatchObject({ ok: false, status: 409 });
    }
  });
});

// The team can change while the owner's card is open: the gate decides again right before the bot is written.
describe("the team decision is made again after the owner's card", () => {
  type Bot = { id: string; name: string; section?: string; hidden?: boolean; chiefOfStaff?: boolean; createdByBotId?: string };
  const world = () => {
    const state = { bots: [{ id: "dir", name: "Demo Director", section: "Demo Machine", chiefOfStaff: true }] as Bot[], groups: [] as Array<{ section?: string }>, refused: undefined as string | undefined };
    const gate = (requested: string, wantsLead = false, name = "Berwald Lead") => leadTeamGate({
      read: () => ({ bots: state.bots, groups: state.groups }),
      lead: () => state.bots.find((bot) => bot.id === "dir"),
      requested, wantsLead, ...{ name }, // not read any more; see `decide` above
      markRefused: (team) => { state.refused = team; },
      refusedTeam: () => state.refused,
    });
    return { state, gate };
  };

  it("refuses when a bot, a channel or a lead the lead did not make lands in the new team while the card is open", () => {
    for (const change of [
      (s: ReturnType<typeof world>["state"]) => s.bots.push({ id: "own", name: "Owner Bot", section: "Berwald Roofing" }),
      (s: ReturnType<typeof world>["state"]) => s.groups.push({ section: "berwald roofing" }),
      (s: ReturnType<typeof world>["state"]) => s.bots.push({ id: "other", name: "Other Lead", section: "Berwald Roofing", chiefOfStaff: true, hidden: true }),
    ]) {
      const { state, gate } = world();
      const call = gate("Berwald Roofing", true);
      expect(call.decide()).toBeUndefined();
      expect(call.section()).toBe("Berwald Roofing");
      change(state); // the card is open
      const late = call.decide();
      expect(late?.error).toMatch(/stop and tell the owner/);
      expect(state.refused).toBe("Berwald Roofing");
    }
  });

  it("an own-team call that overlapped a refused call is refused at the late check", () => {
    const { state, gate } = world();
    state.bots.push({ id: "s1", name: "Sales Lead", section: "Sales", chiefOfStaff: true });
    const own = gate("", false, "Intruder");
    expect(own.decide()).toBeUndefined(); // passed before the other call was refused
    expect(gate("Sales", false, "Intruder").decide()?.status).toBe(403);
    expect(own.decide()).toMatchObject({ status: 409, error: expect.stringMatching(/refused the team Sales earlier in this turn/) });
  });

  it("two overlapping lead creates for one new team in different case elect one lead, filed under one label", () => {
    const { state, gate } = world();
    const first = gate("Berwald Roofing", true, "Berwald Lead");
    const second = gate("berwald roofing", true, "berwald lead");
    expect(first.decide()).toBeUndefined();
    expect(second.decide()).toBeUndefined(); // both arrive before either is written
    expect(first.decide()).toBeUndefined();
    state.bots.push({ id: "bl", name: "Berwald Lead", section: first.section(), createdByBotId: "dir", chiefOfStaff: true });
    expect(second.decide()).toMatchObject({ status: 409, error: expect.stringMatching(/already has a lead/) });
    const helper = gate("BERWALD ROOFING ");
    expect(helper.decide()).toBeUndefined();
    expect(helper.section()).toBe("Berwald Roofing");
  });

  it("refuses when the lead stood down or was removed while the card was open", () => {
    for (const change of [(s: ReturnType<typeof world>["state"]) => { s.bots[0]!.chiefOfStaff = false; }, (s: ReturnType<typeof world>["state"]) => { s.bots.shift(); }]) {
      const { state, gate } = world();
      const call = gate("Berwald Roofing", true);
      expect(call.decide()).toBeUndefined();
      change(state);
      expect(call.decide()).toMatchObject({ status: 403, error: expect.stringMatching(/no longer a team lead/) });
    }
  });

  it("refuses when the lead was moved to another team while the card was open", () => {
    const { state, gate } = world();
    const own = gate("", false, "Helper");
    expect(own.decide()).toBeUndefined();
    state.bots[0]!.section = "Elsewhere";
    expect(own.decide()?.status).toBe(409);
  });
});
