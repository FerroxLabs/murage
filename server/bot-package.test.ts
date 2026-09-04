import { describe, expect, it } from "vitest";

import { packageAgentAsMember, parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";

const validPackage: any = {
  format: "murage.package",
  version: 1,
  package: {
    id: "research-desk",
    release: "1.0.0",
    name: "Research Desk",
    tagline: "Turn a question into a sourced brief.",
    summary: "A small research team.",
    category: "Research",
    author: { name: "Murage" },
    license: "MIT",
    outcomes: ["Produce a sourced brief."],
    setupMinutes: 3,
    requirements: { apps: [], capabilities: [] },
    agents: [
      {
        key: "lead",
        name: "Ada",
        title: "Research Lead",
        description: "Own the brief.",
        appearance: { color: "purple" },
        playbooks: ["source-check"],
        autoApprove: true,
      },
    ],
    chiefOfStaff: "lead",
    rooms: [
      {
        key: "desk",
        name: "Research Desk",
        members: ["lead"],
        bulletin: "Cite sources.",
        defaultResponder: { kind: "agent", agent: "lead" },
      },
    ],
    playbooks: [
      {
        key: "source-check",
        name: "Source Check",
        summary: "Verify sources.",
        triggers: ["research brief"],
        instructions: "Separate facts from inference.",
      },
    ],
  },
};

describe("bot packages", () => {
  it("parses the complete portable structure and strips authority fields", () => {
    const parsed = parseBotPackage(validPackage);
    expect(parsed.package.rooms![0]?.defaultResponder).toEqual({ kind: "agent", agent: "lead" });
    expect(parsed.package.agents[0]).not.toHaveProperty("autoApprove");
    expect(packageAgentAsMember(parsed.package.agents[0]!)).toEqual({
      key: "lead",
      name: "Ada",
      title: "Research Lead",
      description: "Own the brief.",
      appearance: { color: "purple" },
    });
  });

  it("round-trips one Chief-of-Staff-readable Markdown playbook", () => {
    const markdown = renderBotPackageMarkdown(parseBotPackage(validPackage));
    expect(markdown).toContain("## Activation");
    expect(markdown).toContain("Give this file to your Chief of Staff");
    expect(markdown).not.toContain("autoApprove");
    expect(parseBotPackage(markdown).package).toMatchObject({
      id: "research-desk",
      chiefOfStaff: "lead",
      agents: [{ key: "lead", name: "Ada" }],
    });
  });

  it("carries the library skill ids an agent uses, through parse and Markdown", () => {
    const withSkills = {
      ...validPackage,
      package: {
        ...validPackage.package,
        agents: [{ ...validPackage.package.agents[0], skills: ["chart-analysis", "morning-prep"] }],
      },
    };
    const parsed = parseBotPackage(withSkills);
    expect(parsed.package.agents[0]!.skills).toEqual(["chart-analysis", "morning-prep"]);
    // Library ids resolve at install time against the installed library, not
    // against the package's own playbooks, so they are deliberately not
    // cross-referenced here the way agent.playbooks is.
    expect(() => parseBotPackage({
      ...validPackage,
      package: { ...validPackage.package, agents: [{ ...validPackage.package.agents[0], skills: ["not-installed-yet"] }] },
    })).not.toThrow();
    expect(parseBotPackage(renderBotPackageMarkdown(parsed)).package.agents[0]!.skills)
      .toEqual(["chart-analysis", "morning-prep"]);
    // an agent without the field stays valid — this is additive
    expect(parseBotPackage(validPackage).package.agents[0]!.skills).toBeUndefined();
  });

  it("holds skill ids to the key shape and the 200 cap", () => {
    const withSkills = (skills: string[]) => ({
      ...validPackage,
      package: { ...validPackage.package, agents: [{ ...validPackage.package.agents[0], skills }] },
    });
    for (const bad of ["Chart-Analysis", "chart analysis", "-lead", "chart/analysis", ""]) {
      expect(() => parseBotPackage(withSkills([bad])), `skill ${JSON.stringify(bad)}`).toThrow();
    }
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `skill-${index}`);
    expect(parseBotPackage(withSkills(ids(200))).package.agents[0]!.skills).toHaveLength(200);
    expect(() => parseBotPackage(withSkills(ids(201)))).toThrow();
  });

  it("accepts five-minute routine windows and rejects shorter ones", () => {
    const routine = {
      key: "morning-brief",
      name: "Morning brief",
      agent: "lead",
      prompt: "Summarize the overnight queue.",
      runOn: "ember",
      schedule: { type: "daily", time: "09:00", weekdays: [1] },
      durationMinutes: 5,
      enabledAfterInstall: false,
    };
    const document = {
      ...validPackage,
      package: { ...validPackage.package, routines: [routine] },
    };

    expect(parseBotPackage(document).package.routines?.[0]?.durationMinutes).toBe(5);
    expect(() => parseBotPackage({
      ...document,
      package: {
        ...document.package,
        routines: [{ ...routine, durationMinutes: 4 }],
      },
    })).toThrow(/expected number to be >=5/);
  });

  it("rejects dangling agent, room, playbook, chief, and routine references", () => {
    expect(() => parseBotPackage({
      ...validPackage,
      package: { ...validPackage.package, chiefOfStaff: "missing" },
    })).toThrow("Unknown Chief of Staff");
    expect(() => parseBotPackage({
      ...validPackage,
      package: {
        ...validPackage.package,
        agents: [{ ...validPackage.package.agents[0], playbooks: ["missing"] }],
      },
    })).toThrow("unknown playbook");
  });
});
