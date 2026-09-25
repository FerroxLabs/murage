// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TeamView } from "@/lib/team-manage";
import type { Bot } from "@/state/store";
import { TeamSettingsDialogBody, type TeamSettingsDialogBodyProps } from "./TeamSettingsDialog";

const bot = (id: string, name: string, extra: Partial<Bot> = {}) =>
  ({ id, name, color: "green", modelSelection: { instanceId: "x", model: "m" }, messages: [], ...extra }) as unknown as Bot;

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
  hasInstructions: false,
};

const props = (overrides: Partial<TeamSettingsDialogBodyProps> = {}): TeamSettingsDialogBodyProps => ({
  team,
  candidates: [bot("ava", "Ava", { section: "Operations", chiefOfStaff: true }), bot("ben", "Ben", { section: "Operations" }), bot("cal", "Cal")],
  existing: ["Operations", "Sales"],
  canLead: () => true,
  name: "Operations",
  picked: new Set(["ava", "ben"]),
  lead: "ava",
  confirmingDelete: false,
  deleteChoice: "keep",
  busy: false,
  status: null,
  onName: () => {},
  onSaveName: () => {},
  onToggle: () => {},
  onLead: () => {},
  onSaveMembers: () => {},
  onAskDelete: () => {},
  onDeleteChoice: () => {},
  onConfirmDelete: () => {},
  onCancelDelete: () => {},
  onClose: () => {},
  ...overrides,
});

describe("TeamSettingsDialogBody", () => {
  it("offers the name, the members with their lead, and delete, as labelled controls", () => {
    const html = renderToStaticMarkup(createElement(TeamSettingsDialogBody, props()));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Team name"');
    expect(html).toContain('aria-label="Ava"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Cal"');
    expect(html).toContain('aria-label="Team lead"');
    expect(html).toContain(">No lead<");
    expect(html).toContain("1 archived bot stays on this team");
    expect(html).toContain("Its channel Operations is renamed too.");
    expect(html).toContain(">Delete team<");
    expect(html).not.toContain('role="radiogroup"');
    // Every button a finger can reach is at least 44px tall.
    for (const button of html.match(/<button[^>]*>/g) ?? []) expect(button).toMatch(/min-h-11|size-11/);
  });

  it("asks before deleting, inline, with the choice of what happens to the bots", () => {
    const html = renderToStaticMarkup(createElement(TeamSettingsDialogBody, props({ confirmingDelete: true, deleteChoice: "archive" })));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Keep them as bots without a team");
    expect(html).toContain("Archive them");
    expect(html).toContain("2 bots are archived.");
    expect(html).toContain("Every conversation is kept.");
    expect(html).toContain(">Delete Operations<");
    expect(html).toContain(">Cancel<");
    expect(html).not.toMatch(/—|\bsafe\b/i);
  });

  it("does not offer a lead whose engine cannot lead, and says why", () => {
    const html = renderToStaticMarkup(createElement(TeamSettingsDialogBody, props({ canLead: (candidate) => candidate.id !== "ben" })));
    expect(html).toContain("Ben (can&#x27;t lead yet)");
    expect(html).toMatch(/<option value="ben" disabled="">/);
  });
});
