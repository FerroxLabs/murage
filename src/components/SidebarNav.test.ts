// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.62: the Tools pull-up is gone. Its four places are a labelled strip
// under "Needs you" (SidebarPlaces), and the rest sits in the You menu in the
// footer (SidebarYouMenu). NAV-OVERHAUL.md 3.1.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { NAV_MOVED_SEEN_KEY, SidebarMovedNote, SidebarPlaces, shouldShowMovedNote, sidebarPlaceName, type SidebarPlaceItem } from "./SidebarPlaces";
import { SidebarYouMenu, type YouMenuItem } from "./SidebarYouMenu";
import { SidebarYouMenuPanel } from "./SidebarYouMenuPanel";

const sidebar = readFileSync(fileURLToPath(new URL("./Sidebar.tsx", import.meta.url)), "utf8");

const place = (over: Partial<SidebarPlaceItem> = {}): SidebarPlaceItem => ({
  key: "routines",
  label: "Routines",
  name: "Routines",
  icon: null,
  onSelect: vi.fn(),
  ...over,
});
const four = (): SidebarPlaceItem[] => [
  place(),
  place({ key: "files", label: "Files", name: "Files" }),
  place({ key: "apps", label: "Apps", name: "Connected apps" }),
  place({ key: "map", label: "Map", name: "Team map" }),
];

describe("the place strip", () => {
  it("shows all four places at once, each labelled, in one row", () => {
    const html = renderToStaticMarkup(createElement(SidebarPlaces, { places: four() }));
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Places"');
    expect(html).toContain("repeat(4, minmax(0, 1fr))");
    for (const [key, label, name] of [["routines", "Routines", "Routines"], ["files", "Files", "Files"], ["apps", "Apps", "Connected apps"], ["map", "Map", "Team map"]]) {
      expect(html).toContain(`data-sidebar-place="${key}"`);
      expect(html).toContain(`aria-label="${name}"`);
      expect(html).toContain(`>${label}</span>`);
      // the full name contains what the button shows, so voice control finds it
      expect(name.toLowerCase()).toContain(label.toLowerCase());
    }
    // one Tab stop for the strip; arrows move within it
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(3);
  });

  it("keeps the routine's attention dot on the Routines place and says it out loud", () => {
    const html = renderToStaticMarkup(createElement(SidebarPlaces, { places: [place({ attention: true, active: true })] }));
    expect(html).toContain("data-sidebar-place-attention");
    expect(html).toContain('aria-label="Routines, needs attention"');
    expect(html).toContain('aria-current="page"');
    expect(sidebarPlaceName({ name: "Routines" })).toBe("Routines");
  });

  it("stacks as icon buttons with tooltips on the rail", () => {
    const html = renderToStaticMarkup(createElement(SidebarPlaces, { places: four(), rail: true }));
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('title="Connected apps"');
    expect(sidebar).toContain('tip: t("nav.tip.apps")');
    expect(html).not.toContain(">Apps</span>");
  });

  it("is wired to the real destinations, the routine dot included", () => {
    expect(sidebar).toContain('attention: state.routineRuns.some(isUnseenRoutineProblem)');
    expect(sidebar).toContain('dispatch({ type: "togglePlugins", open: true })');
    expect(sidebar).toContain('dispatch({ type: "showTeamMap" })');
    expect(sidebar).toContain('dispatch({ type: "showRoutines" })');
    expect(sidebar).toContain("<SidebarPlaces rail={density === \"icons\"} places={places} />");
  });
});

describe("the You menu", () => {
  const items: YouMenuItem[] = [
    { key: "about-me", label: "About me", icon: null, onSelect: vi.fn() },
    { key: "whats-new", label: "What's new", icon: null, onSelect: vi.fn() },
    { key: "keyboard-shortcuts", label: "Keyboard shortcuts", icon: null, onSelect: vi.fn() },
    { key: "settings", label: "Settings", icon: null, hint: "⌘,", onSelect: vi.fn() },
  ];

  it("is your name, a real menu button, closed on first paint", () => {
    const html = renderToStaticMarkup(createElement(SidebarYouMenu, { items, name: "Sean", initials: "S" }));
    expect(html).toContain("data-sidebar-you-trigger");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Sean</span>");
    expect(html).not.toContain('role="menu"');
  });

  it("names itself on the rail, where the name is not shown", () => {
    const html = renderToStaticMarkup(createElement(SidebarYouMenu, { items, name: "Sean", initials: "S", rail: true }));
    expect(html).toContain('aria-label="Sean"');
    expect(html).not.toContain(">Sean</span>");
  });

  it("lists its items in order, opening upward, with the Settings shortcut shown", () => {
    const html = renderToStaticMarkup(createElement(SidebarYouMenuPanel, { items }));
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Your menu"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(4);
    const order = ["About me", "What&#x27;s new", "Keyboard shortcuts", "Settings"].map((label) => html.indexOf(label));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain("bottom-full");
    expect(html).toContain("⌘,");
  });

  it("offers What's new, the shortcuts and Settings from the sidebar", () => {
    expect(sidebar).toContain('key: "whats-new", label: t("settings.about.whatsNewTitle")');
    expect(sidebar).toContain("onSelect: whatsNew.reopen");
    expect(sidebar).toContain('key: "keyboard-shortcuts", label: t("settings.about.shortcutsTitle")');
    expect(sidebar).toContain("returnFocusRef={youTriggerRef}");
    // one gear, still called App settings; your name no longer opens Settings a second way
    expect(sidebar.match(/aria-label=\{t\("nav.appSettings"\)\}/g)).toHaveLength(1);
    expect(sidebar).not.toContain("SidebarMoreMenu");
  });
});

describe("reaching Settings and the dialogs Settings opens", () => {
  it("opens Settings on Mod+comma, as the gear's tooltip says", () => {
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    expect(app).toMatch(/e\.key === "," && !e\.shiftKey && !e\.altKey\) \{[\s\S]{0,120}dispatch\(\{ type: "toggleAppSettings", open: true \}\)/);
    expect(sidebar).toContain('title={t("nav.tip.settings", { keys: modShortcut(",") })}');
  });

  it("portals What's new and the shortcuts, so a shut phone drawer (inert) cannot swallow them", () => {
    expect(sidebar).toContain("{whatsNew.open && createPortal(<WhatsNewHost");
    expect(sidebar).toContain("{shortcutsOpen && createPortal(<LazyBoundary onRetry={ShortcutsDialog.retry}");
    // and the list itself is not in the first paint
    expect(sidebar).not.toMatch(/import \{ KeyboardShortcutsDialog \}/);
  });
});

describe("the one-time Tools moved note (NAV-OVERHAUL.md 5)", () => {
  const storage = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null });
  it("shows only to someone who used the Tools pull-up, until dismissed", () => {
    expect(shouldShowMovedNote(storage({}))).toBe(false);
    expect(shouldShowMovedNote(storage({ "murage-email-gate": "skipped" }))).toBe(true);
    expect(shouldShowMovedNote(storage({ "murage-email-gate": "skipped", [NAV_MOVED_SEEN_KEY]: "1" }))).toBe(false);
    expect(shouldShowMovedNote(null)).toBe(false);
  });
  it("says where the places went and can be dismissed by name", () => {
    const html = renderToStaticMarkup(createElement(SidebarMovedNote, { onDismiss: vi.fn() }));
    expect(html).toContain("Tools moved");
    expect(html).toContain("Routines, Files, Apps and Map are here now.");
    expect(html).toContain('aria-label="Dismiss the note about Tools"');
  });
});

describe("the sidebar search hands a word to the palette", () => {
  it("offers Search Settings for the word typed, on touch too", () => {
    expect(sidebar).toContain('openCommandPalette(query.trim());');
    expect(sidebar).toContain('t("nav.searchSettings", { query: query.trim() })');
    const palette = readFileSync(fileURLToPath(new URL("./CommandPalette.tsx", import.meta.url)), "utf8");
    expect(palette).toContain("setQuery(handedQuery.current);");
  });
});

describe("Expand sticks across launches", () => {
  it("turns the narrow-window fold off (saved) when the person opens out a rail the window chose", () => {
    expect(sidebar).toMatch(/if \(density === "icons" && densityPrefs\.density !== "icons"\) \{\s*chooseAutoRail\(false\);/);
  });
});

describe("the grandma test: plain words on every icon", () => {
  it("explains each place in a tooltip and to a screen reader", () => {
    const html = renderToStaticMarkup(createElement(SidebarPlaces, { places: [place({ tip: "Routines: things your bots do on a schedule" })], rail: true }));
    expect(html).toContain('title="Routines: things your bots do on a schedule"');
    expect(html).toContain('aria-description="Routines: things your bots do on a schedule"');
    for (const key of ["routines", "files", "apps", "map"]) expect(sidebar).toContain(`tip: t("nav.tip.${key}")`);
  });
  it("gives the header's icon buttons a plain tooltip, and every Settings page and group a one-line note", async () => {
    expect(sidebar).toContain('title={density === "icons" ? t("nav.tip.expand") : t("nav.tip.collapse")}');
    expect(sidebar).toContain('title={t("nav.tip.new")}');
    const { en } = await import("@/locales");
    const { SETTINGS_SECTIONS, SETTINGS_GROUPS } = await import("@/lib/settings-sections");
    for (const entry of SETTINGS_SECTIONS) expect(en[`settings.pageNote.${entry.id}` as keyof typeof en], entry.id).toBeTruthy();
    for (const group of SETTINGS_GROUPS) expect(en[`settings.groupNote.${group}` as keyof typeof en], group).toBeTruthy();
    for (const [key, value] of Object.entries(en)) if (/^(nav\.tip|settings\.(pageNote|groupNote))\./.test(key)) expect(value, key).not.toMatch(/—|\bsafe|\bunsafe|composio|\$\d/i);
  });
});

