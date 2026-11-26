// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 SV0-team (IA v10 section 6): deleting a team admits only the
// exact members and app-choice revisions the owner reviewed.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { botAccessPolicy } from "./bot-access-role.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { ensureScope } from "./memory/policy.ts";
import { writeSectionContext } from "./section-context.ts";
import { Store } from "./store.ts";
import { deleteTeam, describeTeam, teamRevision, type TeamDeps } from "./team-sections.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});

const deps: TeamDeps = {
  memoryTicket: ownerMemoryTicket(),
  leadershipError: () => null,
  groupWorking: () => false,
  channelArchived: () => {},
  reachabilityChanged: () => {},
};
const grant = { toolkit: "mail", accountId: "acct_one", tools: ["MAIL_FETCH"] };

function fixture(section = "Ops") {
  const store = new Store(() => ({ instanceId: "fixture", model: "model" }));
  const lead = store.createBot({ name: "Ava", section });
  store.setChiefOfStaff(lead.id, undefined, "section");
  const saved = store.createBot({ name: "Ben", section });
  const plain = store.createBot({ name: "Cal", section });
  const channel = store.createGroup(section, [lead.id, saved.id], false, section);
  store.patchBot(saved.id, { connectedAppAccess: { ...botAccessPolicy(store.bot(saved.id)!), mode: "restricted", allowWrites: false, grants: [grant], revision: 1 } });
  return { store, section, lead, saved, plain, channel };
}
const reviewOf = (store: Store, section: string) => {
  const team = describeTeam(store, section);
  return { section, revision: team.revision, accessRevisions: Object.fromEntries(team.members.map((member) => [member.id, member.accessRevision])) };
};
/** Everything a refused delete must leave alone. */
function state(f: ReturnType<typeof fixture>) {
  const row = database().prepare("SELECT * FROM team_identities ORDER BY team_id").all();
  const scopes = database().prepare("SELECT owner_key FROM memory_scopes WHERE kind='team' ORDER BY owner_key").all();
  return JSON.stringify({
    bots: f.store.bots.map((bot) => [bot.id, bot.section, bot.hidden, bot.chiefOfStaff, bot.connectedAppAccess]),
    groups: f.store.groups.map((group) => [group.id, group.section, group.hidden]),
    revision: teamRevision(f.store), row, scopes,
  });
}

describe("describeTeam review snapshot", () => {
  it("lists each member's saved choices and effective revision, archived and empty ones included", () => {
    const f = fixture();
    f.store.patchBot(f.plain.id, { hidden: true });
    const members = Object.fromEntries(describeTeam(f.store, f.section).members.map((member) => [member.id, member]));
    expect(members[f.saved.id]).toMatchObject({ accessRevision: 1, choices: { saved: true, mode: "restricted", apps: ["mail"] } });
    expect(members[f.plain.id]).toMatchObject({ archived: true, accessRevision: 0, choices: { saved: false, apps: [] } });
    expect(members[f.lead.id]?.accessRevision).toBe(0);
  });
  it("shows a saved policy with no grants as saved, at its higher revision", () => {
    const f = fixture();
    f.store.patchBot(f.plain.id, { connectedAppAccess: { ...botAccessPolicy(f.store.bot(f.plain.id)!), mode: "restricted", allowWrites: false, grants: [], revision: 3 } });
    expect(describeTeam(f.store, f.section).members.find((member) => member.id === f.plain.id)).toMatchObject({ accessRevision: 3, choices: { saved: true, apps: [] } });
  });
});

describe("deleteTeam admission", () => {
  it("(t1) keep after a member's choices changed: 409, nothing moves", () => {
    const f = fixture();
    const review = reviewOf(f.store, f.section);
    f.store.patchBot(f.saved.id, { connectedAppAccess: { ...botAccessPolicy(f.store.bot(f.saved.id)!), grants: [], revision: 2 } });
    const before = state(f);
    expect(() => deleteTeam(f.store, { ...review, bots: "keep" }, deps)).toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining("Ben") }));
    expect(state(f)).toBe(before);
  });
  it("(t2) archive after a no-policy member gains its first choice: 409, nothing moves", () => {
    const f = fixture();
    const review = reviewOf(f.store, f.section);
    f.store.patchBot(f.plain.id, { connectedAppAccess: { ...botAccessPolicy(f.store.bot(f.plain.id)!), mode: "restricted", allowWrites: false, grants: [grant], revision: 1 } });
    const before = state(f);
    expect(() => deleteTeam(f.store, { ...review, bots: "archive" }, deps)).toThrow(expect.objectContaining({ status: 409, message: expect.stringContaining("Cal") }));
    expect(state(f)).toBe(before);
    expect(f.store.bot(f.plain.id)?.hidden).toBeFalsy();
  });
  it("refuses a missing member, an extra member and a missing map", () => {
    const f = fixture();
    const review = reviewOf(f.store, f.section);
    const { [f.plain.id]: _dropped, ...fewer } = review.accessRevisions;
    const before = state(f);
    expect(() => deleteTeam(f.store, { ...review, accessRevisions: fewer, bots: "keep" }, deps)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => deleteTeam(f.store, { ...review, accessRevisions: { ...review.accessRevisions, ghost: 0 }, bots: "keep" }, deps)).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => deleteTeam(f.store, { section: f.section, revision: review.revision, bots: "keep" }, deps)).toThrow(expect.objectContaining({ status: 400 }));
    expect(state(f)).toBe(before);
  });
  it("(t3) a legacy label over 60 characters with a seeded team memory scope: stale review is 409 before anything moves, current review succeeds", () => {
    for (const bots of ["keep", "archive"] as const) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      const f = fixture("L".repeat(61));
      ensureScope("team", f.section); writeSectionContext(f.section, "Brief");
      const review = reviewOf(f.store, f.section);
      f.store.patchBot(f.plain.id, { connectedAppAccess: { ...botAccessPolicy(f.store.bot(f.plain.id)!), mode: "restricted", grants: [grant], revision: 1 } });
      const before = state(f);
      expect(() => deleteTeam(f.store, { ...review, bots }, deps)).toThrow(expect.objectContaining({ status: 409 }));
      expect(state(f)).toBe(before);
      expect(deleteTeam(f.store, { ...reviewOf(f.store, f.section), bots }, deps)).toMatchObject({ bots: 3 });
    }
  });
  it("(t4) current revisions clear the listed choices for both actions; kept bots are ungrouped, no-policy keeps the default", () => {
    for (const bots of ["keep", "archive"] as const) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      const f = fixture();
      deleteTeam(f.store, { ...reviewOf(f.store, f.section), bots }, deps);
      const saved = botAccessPolicy(f.store.bot(f.saved.id)!);
      expect(saved).toMatchObject({ mode: "restricted", grants: [] });
      expect(botAccessPolicy(f.store.bot(f.plain.id)!)).toMatchObject({ mode: "unrestricted", revision: 0 });
      for (const bot of [f.lead, f.saved, f.plain]) expect(f.store.bot(bot.id)?.section).toBeUndefined();
      expect(Boolean(f.store.bot(f.saved.id)?.hidden)).toBe(bots === "archive");
    }
  });
});
