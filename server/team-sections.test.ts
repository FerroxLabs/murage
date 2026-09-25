// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner team management over a real Store in a throwaway data dir: rename,
// members and lead, and delete. The HTTP wiring and its desktop gate are in
// team-sections-api.test.ts.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { readSectionContext, writeSectionContext } from "./section-context.ts";
import { Store, canReach, sectionKey } from "./store.ts";
import {
  changeTeamMembers,
  deleteTeam,
  describeTeam,
  renameTeam,
  type TeamDeps,
} from "./team-sections.ts";

beforeEach(() => {
  closeDatabase();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

function setup() {
  const store = new Store(() => ({ instanceId: "fixture", model: "model" }));
  const chief = store.createBot({ name: "Chief" });
  store.setChiefOfStaff(chief.id, undefined, "workspace");
  const lead = store.createBot({ name: "Ava", section: "Operations" });
  store.setChiefOfStaff(lead.id, undefined, "section");
  const member = store.createBot({ name: "Ben", section: "Operations" });
  const archived = store.createBot({ name: "Old", section: "Operations" });
  store.patchBot(archived.id, { hidden: true });
  const loose = store.createBot({ name: "Cal" });
  const salesLead = store.createBot({ name: "Sid", section: "Sales" });
  store.setChiefOfStaff(salesLead.id, undefined, "section");
  const salesMember = store.createBot({ name: "Sue", section: "Sales" });
  const channel = store.createGroup("Operations", [lead.id, member.id], false, "Operations");
  const other = store.createGroup("Weekly review", [lead.id], false, "Operations");
  const deps = {
    memoryTicket: ownerMemoryTicket(),
    leadershipError: () => null,
    groupWorking: () => false,
    channelArchived: vi.fn<TeamDeps["channelArchived"]>(),
    reachabilityChanged: vi.fn<TeamDeps["reachabilityChanged"]>(),
  } satisfies TeamDeps;
  const revision = () => describeTeam(store, "Operations").revision;
  return { store, chief, lead, member, archived, loose, salesLead, salesMember, channel, other, deps, revision };
}

const teamScopes = () =>
  database().prepare("SELECT owner_key FROM memory_scopes WHERE kind='team' ORDER BY owner_key").all().map((row) => String(row.owner_key));

describe("describeTeam", () => {
  it("names the lead, every member (archived ones marked) and the team's channels", () => {
    const { store, lead, member, archived, channel, other } = setup();
    const team = describeTeam(store, " Operations ");
    expect(team.name).toBe("Operations");
    expect(team.leadId).toBe(lead.id);
    expect(team.members.map((bot) => [bot.id, bot.lead, bot.archived])).toEqual([
      [lead.id, true, false],
      [member.id, false, false],
      [archived.id, false, true],
    ]);
    expect(team.channels.map((group) => group.id).sort()).toEqual([channel.id, other.id].sort());
    expect(team.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses the ungrouped bots and a team that does not exist", () => {
    const { store } = setup();
    expect(() => describeTeam(store, "")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => describeTeam(store, "Nowhere")).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("renameTeam", () => {
  it("relabels every bot and channel, renames the matching channel, and keeps instructions and team memory", () => {
    const { store, lead, member, archived, chief, channel, other, deps, revision } = setup();
    writeSectionContext("Operations", "Ship on Fridays.");
    expect(teamScopes()).toContain("Operations");
    const before = canReach(chief, lead);

    const { team, changed } = renameTeam(store, { section: "Operations", name: "Ops Crew", revision: revision() }, deps);
    expect(changed.bots.map((bot) => bot.id).sort()).toEqual([lead.id, member.id, archived.id].sort());
    expect(changed.groups.find((group) => group.id === channel.id)).toEqual({ id: channel.id, name: "Ops Crew", section: "Ops Crew", hidden: null });

    expect(team.name).toBe("Ops Crew");
    for (const bot of [lead, member, archived]) expect(store.bot(bot.id)?.section).toBe("Ops Crew");
    expect(store.bot(lead.id)?.chiefOfStaff).toBe(true);
    expect(store.group(channel.id)).toMatchObject({ name: "Ops Crew", section: "Ops Crew" });
    // Only the channel that carried the team's own name follows it.
    expect(store.group(other.id)).toMatchObject({ name: "Weekly review", section: "Ops Crew" });
    expect(readSectionContext("Ops Crew")?.text).toBe("Ship on Fridays.");
    expect(readSectionContext("Operations")).toBeNull();
    expect(teamScopes()).toContain("Ops Crew");
    expect(teamScopes()).not.toContain("Operations");
    // A pure relabel: nobody gains or loses anyone they could reach.
    expect(canReach(store.bot(chief.id)!, store.bot(lead.id)!)).toBe(before);
    expect(canReach(store.bot(lead.id)!, store.bot(member.id)!)).toBe(true);
    expect(deps.reachabilityChanged).not.toHaveBeenCalled();
  });

  it("allows a change of case only", () => {
    const { store, lead, deps, revision } = setup();
    renameTeam(store, { section: "Operations", name: "OPERATIONS", revision: revision() }, deps);
    expect(store.bot(lead.id)?.section).toBe("OPERATIONS");
  });

  it("refuses stale, reserved, taken and malformed names, changing nothing", () => {
    const { store, lead, deps, revision } = setup();
    const stale = revision();
    store.patchBot(lead.id, { name: "Ava 2" });
    // A name change is not an organization change.
    expect(describeTeam(store, "Operations").revision).toBe(stale);
    store.setBotsSection([store.bots.find((bot) => bot.name === "Cal")!.id], "Operations");
    expect(() => renameTeam(store, { section: "Operations", name: "Ops", revision: stale }, deps)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    const fresh = revision();
    expect(() => renameTeam(store, { section: "Operations", name: "Pinned", revision: fresh }, deps)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => renameTeam(store, { section: "Operations", name: "sales", revision: fresh }, deps)).toThrow(
      /already a team called Sales/,
    );
    expect(() => renameTeam(store, { section: "Operations", name: "x".repeat(61), revision: fresh }, deps)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => renameTeam(store, { section: "Operations", name: "Bad\u0007name", revision: fresh }, deps)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(store.bot(lead.id)?.section).toBe("Operations");
  });

  it("refuses a name an archived bot still carries", () => {
    const { store, loose, deps, revision } = setup();
    store.setBotsSection([loose.id], "Archive room");
    store.patchBot(loose.id, { hidden: true });
    expect(() => renameTeam(store, { section: "Operations", name: "Archive room", revision: revision() }, deps)).toThrow(
      /archived bot or channel is still filed under Archive room/,
    );
  });
});

describe("changeTeamMembers", () => {
  it("adds and removes bots, and a removed bot keeps its history as an ungrouped bot", () => {
    const { store, loose, member, deps, revision } = setup();
    store.appendMessage(member.threadId, { role: "user", kind: "text", text: "keep me" });
    const { team, changed } = changeTeamMembers(store, { section: "Operations", revision: revision(), add: [loose.id], remove: [member.id] }, deps);
    // A removed bot's cleared team is spelled out, so a screen can clear it.
    expect(changed.bots.find((bot) => bot.id === member.id)).toMatchObject({ section: null, chiefOfStaff: false });
    expect(store.bot(loose.id)?.section).toBe("Operations");
    expect(sectionKey(store.bot(member.id)?.section)).toBe("");
    expect(store.bot(member.id)?.hidden).toBeFalsy();
    expect(store.messagesFor(member.threadId).some((message) => message.text === "keep me")).toBe(true);
    expect(team!.members.map((bot) => bot.id)).toContain(loose.id);
    expect(deps.reachabilityChanged).toHaveBeenCalledTimes(1);
  });

  it("changes the lead so there is exactly one, and can leave the team with none", () => {
    const { store, lead, member, deps, revision } = setup();
    changeTeamMembers(store, { section: "Operations", revision: revision(), leadId: member.id }, deps);
    expect(store.bot(member.id)?.chiefOfStaff).toBe(true);
    expect(store.bot(lead.id)?.chiefOfStaff).toBe(false);
    const { team } = changeTeamMembers(store, { section: "Operations", revision: revision(), leadId: null }, deps);
    expect(team!.leadId).toBeNull();
    expect(store.bots.filter((bot) => bot.chiefOfStaff && sectionKey(bot.section) === "Operations")).toEqual([]);
  });

  it("moves another team's lead in without two leads anywhere, and clears an on-its-own mark", () => {
    const { store, lead, loose, salesLead, salesMember, deps, revision } = setup();
    store.setIndividual(loose.id, true);
    changeTeamMembers(store, { section: "Operations", revision: revision(), add: [salesLead.id, loose.id] }, deps);
    expect(store.bot(salesLead.id)).toMatchObject({ section: "Operations", chiefOfStaff: false });
    expect(store.bot(lead.id)?.chiefOfStaff).toBe(true);
    expect(store.bot(loose.id)?.individual).toBeUndefined();
    expect(store.bot(salesMember.id)?.section).toBe("Sales");
    // Chosen as the lead in the same change, it leads here instead.
    changeTeamMembers(store, { section: "Operations", revision: revision(), remove: [salesLead.id] }, deps);
    store.setChiefOfStaff(salesMember.id, undefined, "section");
    const sue = store.bot(salesMember.id)!;
    changeTeamMembers(store, { section: "Operations", revision: revision(), add: [sue.id], leadId: sue.id }, deps);
    expect(store.bot(sue.id)).toMatchObject({ section: "Operations", chiefOfStaff: true });
    expect(store.bot(lead.id)?.chiefOfStaff).toBe(false);
  });

  it("removing the lead leaves the team without one and the bot stops leading", () => {
    const { store, lead, deps, revision } = setup();
    const { team } = changeTeamMembers(store, { section: "Operations", revision: revision(), remove: [lead.id] }, deps);
    expect(team!.leadId).toBeNull();
    expect(store.bot(lead.id)).toMatchObject({ chiefOfStaff: false });
    expect(sectionKey(store.bot(lead.id)?.section)).toBe("");
  });

  it("refuses the Chief of Staff, archived bots, a lead who is not on the team, and an engine that cannot lead", () => {
    const { store, chief, archived, loose, member, lead, salesMember, deps, revision } = setup();
    store.patchBot(salesMember.id, { hidden: true });
    const r = revision();
    expect(() => changeTeamMembers(store, { section: "Operations", revision: r, add: [chief.id] }, deps)).toThrow(/Chief of Staff/);
    expect(() => changeTeamMembers(store, { section: "Operations", revision: r, add: [salesMember.id] }, deps)).toThrow(
      /Sue is archived/,
    );
    expect(() => changeTeamMembers(store, { section: "Operations", revision: r, leadId: loose.id }, deps)).toThrow(/on the team/);
    expect(() => changeTeamMembers(store, { section: "Operations", revision: r, leadId: archived.id }, deps)).toThrow(/archived/i);
    const blocked = { ...deps, leadershipError: () => "This engine cannot lead a team." };
    expect(() => changeTeamMembers(store, { section: "Operations", revision: r, leadId: member.id }, blocked)).toThrow(
      "This engine cannot lead a team.",
    );
    expect(store.bot(lead.id)?.chiefOfStaff).toBe(true);
    expect(store.bot(member.id)?.chiefOfStaff).toBeFalsy();
    expect(deps.reachabilityChanged).not.toHaveBeenCalled();
  });
});

describe("deleteTeam", () => {
  it("keeps every bot and channel as ungrouped, ends the lead role and keeps all history", () => {
    const { store, lead, member, archived, channel, other, deps, revision } = setup();
    store.appendMessage(channel.threadId, { role: "user", kind: "text", text: "channel history" });
    writeSectionContext("Operations", "Brief");
    const result = deleteTeam(store, { section: "Operations", revision: revision(), bots: "keep" }, deps);
    expect(result).toMatchObject({ bots: 3, channels: 2 });
    for (const bot of [lead, member, archived]) expect(sectionKey(store.bot(bot.id)?.section)).toBe("");
    expect(store.bot(lead.id)).toMatchObject({ chiefOfStaff: false });
    expect(store.bot(lead.id)?.hidden).toBeFalsy();
    expect(store.bot(member.id)?.hidden).toBeFalsy();
    expect(store.bot(archived.id)?.hidden).toBe(true);
    expect(store.group(channel.id)?.section).toBeUndefined();
    expect(store.group(other.id)?.hidden).toBeFalsy();
    expect(store.messagesFor(channel.threadId).some((message) => message.text === "channel history")).toBe(true);
    expect(readSectionContext("Operations")).toBeNull();
    // Team memory is kept, filed away under a key no team can ever carry.
    expect(teamScopes()).not.toContain("Operations");
    expect(teamScopes().some((key) => key.endsWith(":Operations") && key.length > 60)).toBe(true);
    expect(() => describeTeam(store, "Operations")).toThrow(expect.objectContaining({ status: 404 }));
    expect(deps.reachabilityChanged).toHaveBeenCalledTimes(1);
  });

  it("archives the bots and channels when asked, never the Chief of Staff", () => {
    const { store, chief, lead, member, channel, other, deps } = setup();
    store.setBotsSection([chief.id], "Operations");
    const revision = describeTeam(store, "Operations").revision;
    deleteTeam(store, { section: "Operations", revision, bots: "archive" }, deps);
    expect(store.bot(lead.id)).toMatchObject({ hidden: true, chiefOfStaff: false });
    expect(store.bot(member.id)?.hidden).toBe(true);
    expect(store.bot(chief.id)).toMatchObject({ chiefOfStaff: true, chiefScope: "workspace" });
    expect(store.bot(chief.id)?.hidden).toBeFalsy();
    expect(sectionKey(store.bot(chief.id)?.section)).toBe("");
    expect(store.group(channel.id)?.hidden).toBe(true);
    expect(store.group(other.id)?.hidden).toBe(true);
    expect(deps.channelArchived).toHaveBeenCalledTimes(2);
  });

  it("will not archive a team while one of its bots or channels is working", () => {
    const { store, member, deps, revision } = setup();
    store.patchBot(member.id, { busy: true });
    expect(() => deleteTeam(store, { section: "Operations", revision: revision(), bots: "archive" }, deps)).toThrow(/Ben is working/);
    store.patchBot(member.id, { busy: false });
    const working = { ...deps, groupWorking: () => true };
    expect(() => deleteTeam(store, { section: "Operations", revision: revision(), bots: "archive" }, working)).toThrow(/working/);
    expect(store.bot(member.id)?.section).toBe("Operations");
  });

  it("refuses a stale revision and an unknown choice", () => {
    const { store, loose, deps, revision } = setup();
    const stale = revision();
    store.setBotsSection([loose.id], "Operations");
    expect(() => deleteTeam(store, { section: "Operations", revision: stale, bots: "keep" }, deps)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => deleteTeam(store, { section: "Operations", revision: revision(), bots: "delete" }, deps)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
