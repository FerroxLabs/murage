// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S8: every index entry round-trips through its address and lands where a search "Open" lands.
import { describe, expect, it } from "vitest";
import { parseSettingsAddress, settingsAddressFor } from "./settings-address";
import { settingsAddressActions } from "./open-settings-address";
import { SETTINGS_INDEX } from "./settings-index";
import { SECTION_ALIASES, SECTION_PAGES } from "./settings-pages";
import { searchSettingsIndex } from "./settings-search";

const context = { botIds: ["nova", "chief"], selectedBotId: "chief" };

describe("Settings addresses", () => {
  it.each([
    ["updates", "updates-heading", false],
    ["previous-version", "previous-version-heading", false],
    ["announcements", "announcements-heading", true],
  ] as const)("opens the merged About %s row from saved ids, old anchors and search", (name, anchor, advanced) => {
    const expected = [{ type: "toggleAppSettings", open: true, section: "about", anchor }];
    for (const path of [`app/about/${name}`, `app/about/${anchor}`, `about.${name}`, anchor]) {
      const address = parseSettingsAddress(`murage://settings/${path}`)!;
      expect(settingsAddressActions(address, context)).toEqual(expected);
      // Aliases resolve even if an older or narrower index omitted these rows.
      expect(settingsAddressActions(address, context, [])).toEqual(expected);
    }
    const result = searchSettingsIndex(name.replaceAll("-", " "), { desktop: true, cloud: false, bots: [] });
    const hit = [...result.hits, ...result.more].find((hit) => hit.entry.id === `about.${name}`)!;
    expect(hit.entry).toMatchObject({ scope: "app", section: "about", anchor, advanced, card: { anchor } });
  });

  it("every app entry opens its page on its card", () => {
    for (const entry of SETTINGS_INDEX) {
      if (entry.scope !== "app") continue;
      const address = parseSettingsAddress(settingsAddressFor(entry));
      // A card that moved page keeps its id, so its address names the id's own prefix, not the page it renders on.
      const idSection = entry.id.slice(0, entry.id.indexOf("."));
      expect(address, entry.id).toEqual({ scope: "app", section: idSection, name: entry.id.slice(idSection.length + 1) });
      expect(settingsAddressActions(address!, context), entry.id).toEqual([{ type: "toggleAppSettings", open: true, section: entry.section, anchor: entry.anchor }]);
    }
  });

  it("every bot entry opens the bot in view on its section and row", () => {
    for (const entry of SETTINGS_INDEX) {
      if (entry.scope !== "bot") continue;
      const address = parseSettingsAddress(settingsAddressFor(entry));
      expect(address?.scope, entry.id).toBe("bot");
      expect(settingsAddressActions(address!, context), entry.id).toEqual([{ type: "toggleSettings", open: true, botId: context.selectedBotId, intent: { section: entry.section, anchor: entry.anchor } }]);
    }
  });

  it("a named bot is selected first, and only a bot that is here", () => {
    const folder = SETTINGS_INDEX.find((entry) => entry.id === "bot.access.folder")!;
    const href = settingsAddressFor(folder, "nova");
    expect(href).toBe("murage://settings/bot/nova/access/folder");
    expect(settingsAddressActions(parseSettingsAddress(href)!, context)).toEqual([
      { type: "select", id: "nova" },
      { type: "toggleSettings", open: true, botId: "nova", intent: { section: "access", anchor: "bot-setting-folder" } },
    ]);
    expect(settingsAddressActions(parseSettingsAddress("murage://settings/bot/ghost/access/folder")!, context)).toBeNull();
    expect(settingsAddressActions(parseSettingsAddress("murage://settings/bot/access/folder")!, { botIds: ["nova"], selectedBotId: null })).toBeNull();
    expect(settingsAddressActions(parseSettingsAddress("murage://settings/bot/nowhere/row")!, context)).toBeNull();
  });

  it("pages and every old section id keep working", () => {
    for (const id of [...SECTION_PAGES.map((page) => page.id), ...Object.keys(SECTION_ALIASES)]) {
      expect(parseSettingsAddress(`murage://settings/${id}`), id).toEqual({ scope: "app", section: id, name: null });
      expect(settingsAddressActions(parseSettingsAddress(`murage://settings/app/${id}`)!, context), id).toEqual([{ type: "toggleAppSettings", open: true, section: id }]);
    }
  });

  it("anything else is not an address", () => {
    for (const href of [undefined, "", "https://murage.ai/settings", "murage://settings/", "murage://door?h=x", "murage://settings/app/a/b/c",
      "murage://settings/app/%E0%A4%A", "murage://settings/app/../x", "murage://settings/bot/a b/c/d", `murage://settings/app/${"x".repeat(300)}`]) {
      expect(parseSettingsAddress(href), String(href)).toBeNull();
    }
    expect(parseSettingsAddress("MURAGE://settings/app/general/profile?from=chat#x")).toEqual({ scope: "app", section: "general", name: "profile" });
  });
});
