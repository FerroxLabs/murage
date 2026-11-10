// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 I0 (SETTINGS-LANES.md), moved on by the 1.0.19 shell (settings-shell-1019.test.ts holds the 14-page order and
// words): every older section id keeps landing, and an alias keeps its anchor.
import { describe, expect, it } from "vitest";
import { BROWSE_BOTS_ROUTE, SECTION_ALIASES, SECTION_PAGES, SETTINGS_PAGE_GROUPS, isSettingsPage, resolveSettingsSection, settingsPageGroup } from "./settings-pages";
import { SETTINGS_SECTIONS } from "./settings-sections";
import { ANNOUNCEMENT_ACTION_SECTIONS } from "./announcements";

describe("the Settings pages", () => {
  it("are fourteen pages, each heading's pages together, Each bot's rows being bots", () => {
    expect(SECTION_PAGES).toHaveLength(14);
    const groups = SECTION_PAGES.map((page) => page.group);
    expect(groups.filter((group, index) => group !== groups[index - 1])).toEqual(SETTINGS_PAGE_GROUPS.filter((group) => group !== "bots"));
    expect(settingsPageGroup("webSearch")).toBe("ai");
  });

  // 1.0.3 attachment-cap added "storage" (the Composer's "manage storage" link): an alias onto the Backups page's Storage card, so every id
  // still lands on one of the pages. 1.0.19: Calls and Computer & browser became pages, and Browse bots is a route.
  it("alias resolve: every one of the 22 ids lands on a page, aliases with their anchor", () => {
    expect(SETTINGS_SECTIONS).toHaveLength(22);
    const pages = new Set(SECTION_PAGES.map((page) => page.id));
    for (const { id } of SETTINGS_SECTIONS) {
      if (id === BROWSE_BOTS_ROUTE) continue;
      const target = resolveSettingsSection(id);
      expect(pages.has(target.section), id).toBe(true);
      if (isSettingsPage(id)) expect(target).toEqual({ section: id, anchor: null });
      else expect(target).toEqual(SECTION_ALIASES[id as keyof typeof SECTION_ALIASES]);
    }
    expect(Object.keys(SECTION_ALIASES).sort()).toEqual(["aboutMe", "engines", "experimental", "houseRules", "images", "storage", "voice"]);
    expect(new Set(Object.values(SECTION_ALIASES).map((alias) => alias.anchor)).size).toBe(7);
    expect(SECTION_ALIASES.storage).toEqual({ section: "backups", anchor: "storage-heading" });
  });

  it("keeps routing anchors verbatim and lands every announcement target", () => {
    expect(SECTION_ALIASES.images).toEqual({ section: "webSearch", anchor: "image-settings-heading" });
    expect(SECTION_ALIASES.aboutMe.anchor).toBe("about-me-heading");
    expect(SECTION_ALIASES.houseRules.anchor).toBe("house-rules-heading");
    for (const section of Object.values(ANNOUNCEMENT_ACTION_SECTIONS)) expect(isSettingsPage(resolveSettingsSection(section).section)).toBe(true);
  });

  it("lands anything unknown on General, and never resolves inherited names", () => {
    for (const id of [undefined, null, 7, "", "nope", "toString", "__proto__", "constructor"]) expect(resolveSettingsSection(id)).toEqual({ section: "general", anchor: null });
  });

  it("keeps a page desktop-only exactly when its section was, so the surface contract holds", () => {
    const old = new Map(SETTINGS_SECTIONS.map((entry) => [entry.id, Boolean(entry.desktopOnly)]));
    for (const page of SECTION_PAGES) expect(Boolean(page.desktopOnly), page.id).toBe(old.get(page.id));
  });
});
