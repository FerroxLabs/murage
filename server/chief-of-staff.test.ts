import { describe, expect, it } from "vitest";

import { chiefOfStaffSystemPrompt, individualAssistantSystemPrompt } from "./chief-of-staff.ts";

describe("chiefOfStaffSystemPrompt roster caps", () => {
  it("clips oversized persona fields instead of interpolating them whole", () => {
    const prompt = chiefOfStaffSystemPrompt(
      "chief",
      [
        { id: "chief", name: "Atlas" },
        {
          id: "big",
          name: "N".repeat(500),
          title: "T".repeat(500),
          description: "D".repeat(10_000),
        },
      ],
      true,
    );
    // an imported 10KB description must not ride into the Chief's system
    // prompt — the roster line stays bounded
    const rosterLine = prompt.split("\n").find((line) => line.startsWith("- N"))!;
    expect(rosterLine.length).toBeLessThan(500);
    expect(rosterLine).toContain("…");
  });

  it("caps the roster length and says how many were left out", () => {
    const team = Array.from({ length: 60 }, (_, i) => ({ id: `bot${i}`, name: `Bot ${i}` }));
    const prompt = chiefOfStaffSystemPrompt("chief", [{ id: "chief", name: "Atlas" }, ...team], true);
    expect(prompt).toContain("Bot 39");
    expect(prompt).not.toContain("Bot 40 —");
    expect(prompt).toContain("…and 20 more");
  });
});

describe("chiefOfStaffSystemPrompt", () => {
  const bots = [
    { id: "chief", name: "Atlas", title: "Operations", section: "Work" },
    { id: "writer", name: "Quill", title: "Writer", description: "Drafts concise copy", section: "Work" },
    { id: "coder", name: "Patch", title: "Engineer", busy: true, section: "Work" },
    { id: "hidden", name: "Secret", hidden: true, section: "Work" },
    { id: "personal", name: "Scout", title: "Travel planner", section: "Personal" },
  ];

  it("describes visible teammates, roles, and availability", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, true);

    expect(prompt).toContain("Chief of Staff for the Work section");
    expect(prompt).toContain("Quill — Writer: Drafts concise copy (available)");
    expect(prompt).toContain("Patch — Engineer (working right now)");
    expect(prompt).not.toContain("Secret");
    expect(prompt).not.toContain("Scout");
    expect(prompt).not.toContain("Atlas —");
    expect(prompt).toContain("use delegate_bot");
    expect(prompt).toContain("keeps you available to the user");
    expect(prompt).toContain("delivers the teammate's completed result back into this conversation automatically");
    expect(prompt).toContain("Do not call wait_delegation");
    expect(prompt).toContain("Use ask_bot only for a brief consultation");
    expect(prompt).toContain("Never use ask_bot for an assigned task");
    expect(prompt).toContain("use create_bot");
  });

  it("does not promise delegation when the engine cannot mount agent tools", () => {
    const prompt = chiefOfStaffSystemPrompt("chief", bots, false);

    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("delegate_bot");
  });

  it("includes trusted Murage status only when the Chief caller supplies it", () => {
    const status = "TRUSTED MURAGE STATUS\nfreshness=fresh; runtime_state=degraded";

    const chiefPrompt = chiefOfStaffSystemPrompt("chief", bots, true, status);
    const ordinaryPrompt = chiefOfStaffSystemPrompt("writer", bots, true);

    expect(chiefPrompt).toContain(status);
    expect(ordinaryPrompt).not.toContain("TRUSTED MURAGE STATUS");
  });
});

describe("chiefOfStaffSystemPrompt — the workspace tier", () => {
  const workspace = [
    { id: "ember", name: "Ember", title: "Chief of Staff", chiefOfStaff: true, chiefScope: "workspace" as const },
    { id: "rex", name: "Rex", title: "Head of Sales", description: "Owns pipeline", section: "Sales", chiefOfStaff: true },
    { id: "sdr", name: "Dash", title: "SDR", section: "Sales" },
    { id: "sdr2", name: "Wick", title: "SDR", section: "Sales", busy: true },
    { id: "nia", name: "Nia", title: "Editorial lead", section: "Content", chiefOfStaff: true },
    { id: "opsGrunt", name: "Cog", title: "Operator", section: "Ops" },
    { id: "ghost", name: "Secret", section: "Sales", hidden: true },
    { id: "direct", name: "Scribe", title: "Note taker" },
  ];

  it("names the team leaders, counts their specialists, and never names a specialist", () => {
    const prompt = chiefOfStaffSystemPrompt("ember", workspace, true);

    expect(prompt).toContain("Chief of Staff for this workspace");
    expect(prompt).toContain("Sales — @Rex — Head of Sales: Owns pipeline (available); 2 specialists");
    expect(prompt).toContain("Content — @Nia — Editorial lead (available); 0 specialists");
    // "that's not her department": the grunts are counted, never named
    expect(prompt).not.toContain("Dash");
    expect(prompt).not.toContain("Wick");
    expect(prompt).not.toContain("Secret");
    expect(prompt).toContain("Do not assign work to a leader's specialists yourself");
  });

  it("says a team has no leader rather than working around it", () => {
    const prompt = chiefOfStaffSystemPrompt("ember", workspace, true);
    expect(prompt).toContain("Ops — no leader yet (1 bot). Say so rather than working around it.");
  });

  it("lists bots in the chief's own section as direct reports", () => {
    const prompt = chiefOfStaffSystemPrompt("ember", workspace, true);
    expect(prompt).toContain("Also reporting to you directly:");
    expect(prompt).toContain("- @Scribe — Note taker (available)");
  });

  it("keeps the section-lead prompt verbatim for a bot without the tier", () => {
    const prompt = chiefOfStaffSystemPrompt("rex", workspace, true);
    expect(prompt).toContain("Chief of Staff for the Sales section");
    expect(prompt).toContain("Dash — SDR (available)");
    expect(prompt).toContain("Wick — SDR (working right now)");
    expect(prompt).not.toContain("Chief of Staff for this workspace");
    expect(prompt).not.toContain("Secret");
  });

  it("tells a section lead who the workspace chief is, since canReach opens that edge", () => {
    expect(chiefOfStaffSystemPrompt("rex", workspace, true))
      .toContain("@Ember is the workspace Chief of Staff and is on your roster");
    // an ordinary bot is not given that edge, because it does not have it
    expect(chiefOfStaffSystemPrompt("opsGrunt", workspace, true))
      .not.toContain("workspace Chief of Staff and is on your roster");
  });

  it("clips a hostile section label and emits the team size as a number", () => {
    const prompt = chiefOfStaffSystemPrompt("ember", [
      workspace[0]!,
      { id: "lead", name: "Lead", section: "S".repeat(400), chiefOfStaff: true },
    ], true);
    const line = prompt.split("\n").find((row) => row.startsWith("- S"))!;
    expect(line.length).toBeLessThan(300);
    expect(line).toContain("…");
  });

  it("still refuses to promise delegation on an engine without the tools", () => {
    const prompt = chiefOfStaffSystemPrompt("ember", workspace, false);
    expect(prompt).toContain("cannot contact teammates");
    expect(prompt).not.toContain("delegate_bot");
  });
});

// ── the Chief's OTHER branch: individual assistants ───────────────────
// A bot alone in its own group with no leader above it, reporting straight
// to the workspace Chief. The roster has to say that it is NOT a team
// leader, because "chiefOfStaff with a section" and "individual" render one
// line apart and the Chief acts on the difference.

describe("chiefOfStaffSystemPrompt — individual assistants", () => {
  const workspace = [
    { id: "ember", name: "Ember", title: "Chief of Staff", chiefOfStaff: true, chiefScope: "workspace" as const },
    { id: "rex", name: "Rex", title: "Head of Sales", section: "Sales", chiefOfStaff: true },
    { id: "sdr", name: "Dash", title: "SDR", section: "Sales" },
    { id: "bruce", name: "Bruce", title: "Trading assistant", description: "Runs the book", section: "Smart Trader", individual: true },
  ];

  it("gives individual assistants their own group, never the team-leader line", () => {
    const prompt = chiefOfStaffSystemPrompt("ember", workspace, true);

    expect(prompt).toContain("Individual assistants (they lead no team and report to you directly):");
    expect(prompt).toContain("- @Bruce — Trading assistant: Runs the book (available)");
    // the one thing that must not happen: Bruce rendered as a team
    expect(prompt).not.toContain("Smart Trader — @Bruce");
    expect(prompt).not.toContain("Smart Trader — no leader yet");
    expect(prompt).toContain("An individual assistant is not a team leader");
  });

  it("keeps the group an individual sits in out of the team list entirely", () => {
    const prompt = chiefOfStaffSystemPrompt("ember", workspace, true);
    const teams = prompt.slice(prompt.indexOf("Team leaders:"), prompt.indexOf("Individual assistants"));
    expect(teams).toContain("Sales — @Rex");
    expect(teams).not.toContain("Smart Trader");
  });

  it("does not treat a team leader or a plain member as individual", () => {
    const prompt = chiefOfStaffSystemPrompt("ember", [
      workspace[0]!,
      workspace[1]!,
      workspace[2]!,
    ], true);
    expect(prompt).not.toContain("Individual assistants");
  });

  it("refuses the individual branch to a bot that also leads — the chart wins", () => {
    // Both flags on one record can only come from a hand-edited file; the
    // store de-dupes it at load. The prompt must not depend on that.
    const prompt = chiefOfStaffSystemPrompt("ember", [
      workspace[0]!,
      { id: "both", name: "Janus", title: "Lead", section: "Ops", chiefOfStaff: true, individual: true },
    ], true);
    expect(prompt).toContain("Ops — @Janus — Lead (available); 0 specialists");
    expect(prompt).not.toContain("Individual assistants");
  });

  it("does not name a hidden individual assistant", () => {
    const prompt = chiefOfStaffSystemPrompt("ember", [
      workspace[0]!,
      { id: "ghost", name: "Spectre", section: "Solo", individual: true, hidden: true },
    ], true);
    expect(prompt).not.toContain("Spectre");
    expect(prompt).not.toContain("Individual assistants");
  });
});

describe("individualAssistantSystemPrompt", () => {
  const bruce = { id: "bruce", name: "Bruce", title: "Trading assistant", section: "Smart Trader", individual: true };
  const ember = { id: "ember", name: "Ember", title: "Chief of Staff", chiefOfStaff: true, chiefScope: "workspace" as const };

  it("names the Chief as the one bot it reports to", () => {
    const prompt = individualAssistantSystemPrompt("bruce", [bruce, ember], true);
    expect(prompt).toContain("You are an individual assistant");
    expect(prompt).toContain("@Ember is the workspace Chief of Staff and you report to them directly");
    expect(prompt).toContain("Use list_bots");
    expect(prompt).not.toContain("the other bots in your section");
  });

  it("says plainly that nobody is reachable when no Chief has been elected", () => {
    const prompt = individualAssistantSystemPrompt("bruce", [bruce, { id: "rex", name: "Rex", section: "Sales", chiefOfStaff: true }], true);
    expect(prompt).toContain("no Chief of Staff");
    expect(prompt).toContain("Say so rather than inventing a teammate");
    expect(prompt).not.toContain("Rex");
  });

  it("never contradicts canReach when the individual shares a group", () => {
    const prompt = individualAssistantSystemPrompt(
      "bruce",
      [bruce, ember, { id: "quant", name: "Quant", title: "Analyst", section: "Smart Trader" }],
      true,
    );
    expect(prompt).toContain("Bots filed alongside you");
    expect(prompt).toContain("- Quant — Analyst (available)");
    expect(prompt).not.toContain("no other bot you can reach");
  });

  it("promises no tools the engine cannot mount", () => {
    const prompt = individualAssistantSystemPrompt("bruce", [bruce, ember], false);
    expect(prompt).not.toContain("delegate_bot");
    expect(prompt).not.toContain("list_bots");
  });
});
