// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.62: the Tools pull-up is gone; the rest sits in the You menu in the
// footer (SidebarYouMenu). NAV-OVERHAUL.md 3.1. UX 1.0.13: the place strip
// became the four doors (shell/RailDoors.tsx).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { SidebarYouMenu, type YouMenuItem } from "./SidebarYouMenu";
import { SidebarYouMenuPanel } from "./SidebarYouMenuPanel";

const sidebar = readFileSync(fileURLToPath(new URL("./Sidebar.tsx", import.meta.url)), "utf8");

// UX 1.0.13 (L2A): the place strip and its one-time "Tools moved" note gave way to the four doors
// (Today, Chats, Needs you, Routines); Files, Connected apps and Team map moved to the You menu.
// Their tests are in shell/RailDoors.test.ts.

describe("the You menu", () => {
  it("gates the recorder menu and page on the local macOS desktop as well as the switch", () => {
    expect(sidebar).toContain("skillRecorderAvailable(state.config, desktop, isCloudOrigin(), capabilities.host.platform)");
    const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    expect(app).toContain('state.activeView === "skill-recorder" && skillRecorderAvailable(state.config, desktop, isCloudOrigin(), capabilities.host.platform)');
    expect(app).toContain("const { capabilities } = useDesktopCapabilities();");
  });
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

