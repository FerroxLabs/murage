// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  renameSidebarLayout,
  teamCandidateDetail,
  teamDeleteSummary,
  teamMembersChange,
  teamChangePatches,
  teamRenameProblem,
  type TeamView,
} from "./team-manage";

const team: TeamView = {
  name: "Operations",
  revision: "r".repeat(64),
  leadId: "ava",
  members: [
    { id: "ava", name: "Ava", lead: true, chief: false, archived: false },
    { id: "ben", name: "Ben", lead: false, chief: false, archived: false },
    { id: "old", name: "Old", lead: false, chief: false, archived: true },
  ],
  channels: [{ id: "ch", name: "Operations", archived: false }],
  hasInstructions: true,
};

describe("teamRenameProblem", () => {
  it("says what is wrong in plain words, and nothing when the name is fine", () => {
    expect(teamRenameProblem("", "Operations", [])).toBe("Give the team a name.");
    expect(teamRenameProblem("Operations", "Operations", [])).toBe("That is already its name.");
    expect(teamRenameProblem("pinned", "Operations", [])).toMatch(/already a heading/);
    expect(teamRenameProblem("sales", "Operations", ["Operations", "Sales"])).toBe(
      "There is already a team called Sales. Choose another name.",
    );
    expect(teamRenameProblem("x".repeat(61), "Operations", [])).toMatch(/up to 60/);
    expect(teamRenameProblem("OPERATIONS", "Operations", ["Operations"])).toBeNull();
    expect(teamRenameProblem("Ops", "Operations", ["Operations", "Sales"])).toBeNull();
  });
});

describe("teamMembersChange", () => {
  it("sends only what changed, and nothing when nothing did", () => {
    expect(teamMembersChange(team, new Set(["ava", "ben"]), "ava")).toBeNull();
    expect(teamMembersChange(team, new Set(["ava", "cal"]), "ava")).toEqual({ add: ["cal"], remove: ["ben"] });
    expect(teamMembersChange(team, new Set(["ava", "ben"]), "ben")).toEqual({ leadId: "ben" });
    expect(teamMembersChange(team, new Set(["ava", "ben"]), "")).toEqual({ leadId: null });
  });

  it("never removes archived members the list does not show", () => {
    expect(teamMembersChange(team, new Set(["ava"]), "ava")).toEqual({ remove: ["ben"] });
  });

  it("a lead who is no longer ticked is no lead", () => {
    expect(teamMembersChange(team, new Set(["ben"]), "ava")).toEqual({ remove: ["ava"], leadId: null });
  });
});

describe("teamCandidateDetail", () => {
  it("says where a bot is now and what ticking it does", () => {
    expect(teamCandidateDetail({ section: "Sales", chiefOfStaff: true }, "Operations", true)).toBe(
      "Leads Sales. Moves here and stops leading Sales.",
    );
    expect(teamCandidateDetail({ section: "Sales" }, "Operations", false)).toBe("In Sales now");
    expect(teamCandidateDetail({ section: "Sales" }, "Operations", true)).toBe("In Sales now. Moves to this team.");
    expect(teamCandidateDetail({}, "Operations", false)).toBeUndefined();
    expect(teamCandidateDetail({ section: "Operations" }, "Operations", false)).toBe("Leaves this team when you save");
    expect(teamCandidateDetail({ section: "Operations" }, "Operations", true)).toBeUndefined();
  });
});

describe("teamDeleteSummary", () => {
  it("says what happens to everything, and that nothing is lost", () => {
    expect(teamDeleteSummary(team, "keep")).toEqual([
      "2 bots stay, as bots without a team. Ava stops leading.",
      "1 channel stays, without a team.",
      "Every conversation is kept.",
      "The team instructions are removed.",
    ]);
    expect(teamDeleteSummary({ ...team, members: [team.members[1]], channels: [], leadId: null, hasInstructions: false }, "archive")).toEqual([
      "1 bot is archived. You can restore it from Archived bots.",
      "Every conversation is kept.",
    ]);
  });
});

describe("renameSidebarLayout", () => {
  it("keeps a renamed team where it was and as open or closed as it was", () => {
    expect(renameSidebarLayout(["builtin:pinned", "section:Operations", "builtin:bots"], ["section:Operations"], "Operations", "Ops")).toEqual({
      order: ["builtin:pinned", "section:Ops", "builtin:bots"],
      collapsed: ["section:Ops"],
    });
    expect(renameSidebarLayout(["builtin:bots"], [], "Operations", "Ops")).toEqual({ order: ["builtin:bots"], collapsed: [] });
  });
});

describe("teamChangePatches", () => {
  it("turns a cleared team, role or archive mark into undefined so the screen clears it", () => {
    const patches = teamChangePatches({
      bots: [{ id: "ben", section: null, chiefOfStaff: false, chiefScope: null, individual: null, hidden: true }],
      groups: [{ id: "ch", name: "Ops", section: null, hidden: null }],
    });
    expect(patches.bots[0]).toEqual({ id: "ben", patch: { section: undefined, chiefOfStaff: false, chiefScope: undefined, individual: undefined, hidden: true } });
    expect("section" in patches.bots[0].patch).toBe(true);
    expect(patches.groups[0]).toEqual({ id: "ch", patch: { name: "Ops", section: undefined, hidden: undefined } });
    expect("section" in patches.groups[0].patch).toBe(true);
  });
});
