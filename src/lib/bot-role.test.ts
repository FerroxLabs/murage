import { describe, expect, it } from "vitest";

import { botRole, botRolePatch, BOT_ROLE_BADGE, type BotRole } from "./bot-role";

describe("botRole", () => {
  it("reads all three tiers plus the default", () => {
    expect(botRole({ chiefOfStaff: true, chiefScope: "workspace" })).toBe("chief");
    expect(botRole({ chiefOfStaff: true, section: "Sales" })).toBe("leader");
    expect(botRole({ individual: true, section: "Smart Trader" })).toBe("individual");
    expect(botRole({ section: "Sales" })).toBe("member");
    expect(botRole({})).toBe("member");
  });

  it("needs the role before the tier means anything", () => {
    // `chiefScope` without `chiefOfStaff` is a state the harness deletes at
    // load; the renderer must not render a Chief that the server does not have.
    expect(botRole({ chiefScope: "workspace" })).toBe("member");
  });

  it("resolves a both-roles record the way the harness does", () => {
    expect(botRole({ chiefOfStaff: true, individual: true })).toBe("leader");
    expect(botRole({ chiefOfStaff: true, chiefScope: "workspace", individual: true })).toBe("chief");
  });

  it("badges every tier but the default one", () => {
    expect(BOT_ROLE_BADGE.chief).toBe("Chief of Staff");
    expect(BOT_ROLE_BADGE.leader).toBe("Team lead");
    expect(BOT_ROLE_BADGE.individual).toBe("Individual");
    expect(BOT_ROLE_BADGE.member).toBe("");
  });
});

describe("botRolePatch", () => {
  const roles: BotRole[] = ["chief", "leader", "individual", "member"];

  it("always states all three fields, so the two roles can never travel together", () => {
    // The harness refuses `individual: true` beside a Chief role. A partial
    // patch is the only way to ask for that combination by accident.
    for (const role of roles) {
      const patch = botRolePatch(role);
      expect(Object.keys(patch).sort()).toEqual(["chiefOfStaff", "chiefTier", "individual"]);
      expect(patch.chiefOfStaff && patch.individual).toBe(false);
    }
  });

  it("maps each role to the tier the harness expects", () => {
    expect(botRolePatch("chief")).toEqual({ chiefOfStaff: true, chiefTier: "workspace", individual: false });
    expect(botRolePatch("leader")).toEqual({ chiefOfStaff: true, chiefTier: "section", individual: false });
    expect(botRolePatch("individual")).toEqual({ chiefOfStaff: false, chiefTier: null, individual: true });
    expect(botRolePatch("member")).toEqual({ chiefOfStaff: false, chiefTier: null, individual: false });
  });

  it("round-trips: the patch for a role reads back as that role", () => {
    for (const role of roles) {
      const patch = botRolePatch(role);
      expect(
        botRole({
          chiefOfStaff: patch.chiefOfStaff,
          chiefScope: patch.chiefTier === "workspace" ? "workspace" : undefined,
          individual: patch.individual,
        }),
      ).toBe(role);
    }
  });
});
