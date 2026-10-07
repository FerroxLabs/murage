// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot settings > Teams (SPEC-X 13.1), each state rendered without a store.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SharingView } from "@/lib/shared-teams";
import { TeamsSectionBody, type TeamsSectionBodyProps } from "./BotTeamsSection";

const view = (overrides: Partial<SharingView> = {}): SharingView => ({
  home: { id: "design", name: "Design" },
  sharedWith: { mode: "none", teams: [] },
  partitioned: false,
  enabled: true,
  shareable: true,
  teams: [
    { id: "design", name: "Design", covered: false, selectable: false, reason: "home" },
    { id: "sales", name: "Sales", covered: false, selectable: true },
    { id: "support", name: "Support", covered: false, selectable: true },
  ],
  load: [],
  loadLine: "",
  skills: [],
  limits: { runningPerTeam: 1, runningTotal: 2, queuedPerTeam: 20, expiresHours: 24 },
  ...overrides,
});
const props = (overrides: Partial<TeamsSectionBodyProps> = {}): TeamsSectionBodyProps => ({
  name: "Iris", view: view(), mode: "none", picked: new Set(), notes: { text: "", saved: "" }, copyTeam: "sales",
  busy: false, status: null, losing: [],
  onMode: () => {}, onToggleTeam: () => {}, onSave: () => {}, onCancelChange: () => {}, onSkill: () => {},
  onNotes: () => {}, onSaveNotes: () => {}, onCopyTeam: () => {}, onMakeCopy: () => {},
  ...overrides,
});
const render = (overrides: Partial<TeamsSectionBodyProps> = {}) => renderToStaticMarkup(createElement(TeamsSectionBody, props(overrides)));

describe("the Teams section", () => {
  it("off: names the home team, offers the three choices, the copy button and no honest limit yet", () => {
    const html = render();
    expect(html).toContain("Iris&#x27;s home team is Design.");
    expect(html).toContain("A bot that works for other teams keeps its home team. To work for another team full time, make a copy.");
    expect(html).toContain('role="radiogroup"');
    for (const label of ["No other team", "These teams", "All teams"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("Leads of these teams can ask Iris for work.");
    expect(html).toContain("1 job per team at a time, 2 in all. Up to 20 requests wait per team, for up to a day.");
    expect(html).toContain(">Make a copy for this team<");
    expect(html).not.toContain("can still reach things");
    // the home team is never offered as a copy target or a checkbox
    expect(html).not.toContain('<option value="design"');
  });

  it("a list of teams: one checkbox per other team, never the home team, and Save once it changed", () => {
    const html = render({ mode: "list", picked: new Set(["sales"]) });
    expect(html).toMatch(/type="checkbox"[^>]*checked=""\/>Sales</);
    expect(html).toMatch(/type="checkbox" class="[^"]*"\/>Support</);
    expect(html).not.toMatch(/checkbox[^>]*\/>Design</);
    expect(html).toContain(">Save<");
  });

  it("all teams: names every covered team and says later teams are covered too", () => {
    const html = render({ mode: "all", view: view({ sharedWith: { mode: "all", teams: [] }, partitioned: true }) });
    expect(html).toContain("Covers Sales and Support, and any team you add later.");
    expect(html).toContain("Iris&#x27;s shell, browser and connected apps can still reach things from Iris&#x27;s other work. For separate clients, use a copy of this bot.");
    expect(html).not.toContain(">Save<");
  });

  it("removing a team with a running job asks Let it finish or Stop it now", () => {
    const html = render({ mode: "none", view: view({ sharedWith: { mode: "all", teams: [] } }), losing: ["Sales"] });
    expect(html).toContain("Iris is working for Sales now.");
    expect(html).toContain(">Let it finish<");
    expect(html).toContain(">Stop it now<");
  });

  it("shows the load line, the learned skills with Use for every team, and the owner-only notes", () => {
    const html = render({
      view: view({ load: [{ teamId: "sales", name: "Sales", running: 1, queued: 0, waitingOnYou: 0 }, { teamId: "support", name: "Support", running: 0, queued: 2, waitingOnYou: 0 }], skills: [{ name: "invoice-check", revision: "r1", byOwner: false, everyTeam: false }] }),
      notes: { text: "CANARY notes", saved: "" },
    });
    expect(html).toContain("Working for Sales · 2 waiting from Support");
    expect(html).toContain("Skills Iris learned on its own");
    expect(html).toContain('aria-label="Use for every team: invoice-check"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Notes that apply to every team");
    expect(html).toContain("Only you can change these. Iris reads them in every team&#x27;s work.");
    expect(html).toContain(">Save notes<");
  });

  it("sharing turned off: says so, and only No other team can be chosen", () => {
    const html = render({ view: view({ enabled: false }) });
    expect(html).toContain("Sharing across teams is turned off");
    expect(html).toMatch(/aria-checked="false" disabled=""[^>]*>These teams/);
  });

  it("an Individual Assistant or the Chief is never shared, and there are no choices", () => {
    const html = render({ view: view({ shareable: false }) });
    expect(html).toContain("works for you alone, so Iris is not shared with teams.");
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("Make a copy for this team");
  });

  it("no other team yet: a plain pointer to the sidebar instead of empty choices", () => {
    const html = render({ view: view({ teams: [{ id: "design", name: "Design", covered: false, selectable: false, reason: "home" }] }) });
    expect(html).toContain("There are no other teams yet.");
    expect(html).not.toContain('role="radiogroup"');
  });

  it("R4 no learned skill yet: says so with the bot's name", () => {
    expect(render()).toContain("Iris has not learned a skill yet.");
  });

  it("R4 a 409 on the notes: the draft stays in the box and the newer notes show below it", () => {
    const html = render({ notes: { text: "MY_DRAFT", saved: "THEIR_NOTES", newer: "THEIR_NOTES" }, status: { error: true, text: "These notes changed since you opened them. Your version is still in the box, and the newer notes are below it. Check both, then save again." } });
    expect(html).toMatch(/<textarea[^>]*>MY_DRAFT<\/textarea>/);
    expect(html).toContain("data-newer-notes");
    expect(html).toContain("THEIR_NOTES");
    expect(html).toContain(">Save notes<");
    expect(render({ notes: { text: "SAME", saved: "SAME" } })).not.toContain("data-newer-notes");
  });
});
