// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The four doors (UX 1.0.13, lane L2A): order, the lit door per view, the
// Needs you name and badge, 44 px targets, the icon rail, and the shell wiring
// (the rail on every view, the doors in place of Places).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RailDoors, needsDoorName } from "./RailDoors";
import { doorForView } from "./shell-nav";

const html = (props: Partial<Parameters<typeof RailDoors>[0]> = {}) =>
  renderToStaticMarkup(createElement(RailDoors, { lit: "today", needs: { count: 3, stale: false }, onOpen: vi.fn(), ...props }));
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("RailDoors", () => {
  it("shows Today, Chats, Needs you and Routines in that order, as buttons in one nav", () => {
    const markup = html();
    expect(markup).toMatch(/^<nav aria-label="Main"/);
    expect([...markup.matchAll(/data-door="([a-z-]+)"/g)].map((match) => match[1])).toEqual(["today", "chats", "needs-you", "routines"]);
    expect(markup.match(/<button type="button"/g)).toHaveLength(4);
    expect(markup).toContain(">Today<");
    expect(markup).toContain(">Chats<");
    expect(markup).toContain(">Routines<");
  });

  it("lights exactly one door per view, and none for the team map", () => {
    expect(doorForView("today")).toBe("today");
    expect(doorForView("chat")).toBe("chats");
    expect(doorForView("all-chats")).toBe("chats");
    expect(doorForView("needs-you")).toBe("needs-you");
    expect(doorForView("routines")).toBe("routines");
    expect(doorForView("team-map")).toBeNull();
    expect(doorForView("health")).toBeNull();
    const markup = html({ lit: "routines" });
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/data-door="routines" aria-current="page"/);
  });

  it("speaks the Needs you count in the button's name, and hides the badge from readers", () => {
    const markup = html();
    expect(markup).toContain('aria-label="Needs you, 3 waiting"');
    expect(markup).toMatch(/<span aria-hidden="true" data-needs-you-count[^>]*>3<\/span>/);
    expect(needsDoorName(0, false)).toBe("Needs you, nothing waiting");
    expect(needsDoorName(undefined, false)).toBe("Needs you, not known yet");
    expect(needsDoorName(2, true)).toBe("Needs you, 2 waiting, may be out of date");
    expect(html({ needs: { count: 0, stale: false } })).toMatch(/<span aria-hidden="true" data-needs-you-count="true" class="sr-only">0<\/span>/);
  });

  it("gives every door a 44 px target and a plain tooltip from the mockup", () => {
    const markup = html();
    expect(markup.match(/min-h-11/g)).toHaveLength(4);
    for (const tip of ["What happened and what needs you", "Every chat, project and channel", "Everything waiting on your answer", "What your bots do on a schedule"]) {
      expect(markup).toContain(`title="${tip}"`);
    }
  });

  it("names each door on the icon rail, where the label is not shown, and flags a routine problem", () => {
    const markup = html({ iconsOnly: true, routinesAttention: true });
    expect(markup).toContain('aria-label="Today"');
    expect(markup).toContain('aria-label="Chats"');
    expect(markup).toContain('aria-label="Routines, a routine needs a look"');
    expect(markup).toContain("data-routines-attention");
    expect(markup).not.toContain(">Today<");
  });
});

describe("the shell wiring", () => {
  const app = read("../../App.tsx");
  const sidebar = read("../Sidebar.tsx");
  it("keeps the rail on every view, Routines included", () => {
    expect(app).not.toContain("calendarFocus");
    expect(app).toMatch(/<Sidebar\s+needs=\{needs\}\s+health=\{health\}/);
    expect(app).toContain("useBotListDrawer(true)");
  });
  it("renders Today, Needs you and Health in the main slot, the offline band, Undo and the phone tabs", () => {
    expect(app).toContain('state.activeView === "today" && !todayLandingOnHold ? (');
    expect(app).toContain("<TodayView ");
    expect(app).toContain("<NeedsYouPage ");
    expect(app).toContain("<HealthPage ");
    expect(app).toContain("<OfflineBand ");
    expect(app).toContain("<UndoToastHost />");
    expect(app).toContain("<PhoneTabs ");
  });
  it("puts the doors in the rail in place of Places, the Needs you row and the All chats button", () => {
    expect(sidebar).toContain("<RailDoors");
    expect(sidebar).not.toContain("SidebarPlaces");
    expect(sidebar).not.toContain("<SidebarNeedsYou");
    expect(sidebar).not.toContain('data-testid="all-chats-entry"');
    // one way into Needs you: the door, never a menu entry or a second dialog
    expect(sidebar).not.toContain('key: "pending-approvals"');
    expect(sidebar).not.toContain('key: "inbox"');
    expect(sidebar).not.toContain("<InboxDialog");
    expect(html().match(/data-sidebar-needs-you/g)).toHaveLength(1);
  });
  it("offers Health in the You menu with its dot, and Files, Connected apps and Team map there too", () => {
    expect(sidebar).toContain('key: "health"');
    expect(sidebar).toContain("<StatusDot level={health.level}");
    expect(sidebar).toContain('key: "files"');
    expect(sidebar).toContain('key: "apps"');
    expect(sidebar).toContain('key: "map"');
  });
});
