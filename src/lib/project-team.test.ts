import { describe, expect, it } from "vitest";
import { existingTeams, projectSection } from "./project-team";

describe("project team choice", () => {
  const bots = [{ section: "Creator Studio" }, { section: "Old", hidden: true }, {}];
  const groups = [{ section: "Work" }, { section: "Creator Studio" }, {}];

  it("a project created with no team posts no section", () => {
    expect(projectSection("", existingTeams(bots, groups))).toBeUndefined();
  });

  it("the picker lists only existing teams, once each, without hidden bots' stale ones", () => {
    expect(existingTeams(bots, groups)).toEqual(["Creator Studio", "Work"]);
    expect(existingTeams([], [])).toEqual([]);
  });

  it("a project never invents a section", () => {
    const teams = existingTeams(bots, groups);
    expect(projectSection("Dreak", teams)).toBeUndefined();
    expect(projectSection("  Work", teams)).toBeUndefined();
    expect(projectSection("Work", teams)).toBe("Work");
  });
});
