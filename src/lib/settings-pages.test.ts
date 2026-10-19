// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 I0 (SETTINGS-LANES.md): 12 pages in 5 groups; all 19 ids keep landing.
import { describe, expect, it } from "vitest";
import { SECTION_ALIASES, SECTION_PAGES, SETTINGS_PAGE_GROUPS, isSettingsPage, resolveSettingsSection, settingsPageGroup } from "./settings-pages";
import { SETTINGS_SECTIONS } from "./settings-sections";
import { ANNOUNCEMENT_ACTION_SECTIONS } from "./announcements";

describe("the 1.0.3 pages", () => {
  it("are twelve pages under five groups, in the mockup's order, each group together", () => {
    expect(SETTINGS_PAGE_GROUPS).toEqual(["you", "bots", "ai", "reach", "app"]);
    expect(SECTION_PAGES.map((page) => `${page.group}:${page.id}`)).toEqual([
      "you:general", "bots:botDefaults", "bots:skills", "bots:memory", "ai:models", "ai:webSearch",
      "reach:connections", "reach:channels", "reach:companion", "app:backups", "app:usage", "app:about",
    ]);
    const groups = SECTION_PAGES.map((page) => page.group);
    expect(groups.filter((group, index) => group !== groups[index - 1])).toEqual([...SETTINGS_PAGE_GROUPS]);
    expect(settingsPageGroup("webSearch")).toBe("ai");
  });

  // 1.0.3 attachment-cap added "storage" (the Composer's "manage storage" link): an alias onto the Backups page's Storage card, so every id
  // still lands on one of the twelve pages (placement awaits the Fable/Sean look recorded in INT-103.md, merge 14)
  it("alias resolve: every one of the 20 ids lands on a page, aliases with their anchor", () => {
    expect(SETTINGS_SECTIONS).toHaveLength(20);
    const pages = new Set(SECTION_PAGES.map((page) => page.id));
    for (const { id } of SETTINGS_SECTIONS) {
      const target = resolveSettingsSection(id);
      expect(pages.has(target.section), id).toBe(true);
      if (isSettingsPage(id)) expect(target).toEqual({ section: id, anchor: null });
      else expect(target).toEqual(SECTION_ALIASES[id as keyof typeof SECTION_ALIASES]);
    }
    expect(Object.keys(SECTION_ALIASES).sort()).toEqual(["aboutMe", "computer", "engines", "experimental", "houseRules", "images", "storage", "voice"]);
    expect(new Set(Object.values(SECTION_ALIASES).map((alias) => alias.anchor)).size).toBe(8);
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
