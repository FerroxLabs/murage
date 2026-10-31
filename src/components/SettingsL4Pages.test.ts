// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 L4: the six regrouped pages keep every card, with the rare ones under one Advanced each.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cardsForSurface } from "@/lib/settings-cards";
import { ANCHORS_OWED, SETTINGS_CARDS } from "@/lib/settings-card-registry";
import { SECTION_ALIASES, SECTION_PAGES } from "@/lib/settings-pages";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
const modal = read("SettingsModal.tsx");

// Every file a page draws its cards from.
const PAGE_FILES: Record<string, string[]> = {
  general: ["SettingsModal.tsx", "AboutMeSettings.tsx", "NotificationSettings.tsx", "StartupSettings.tsx", "ScriptAccessSettings.tsx"],
  botDefaults: ["BotsSettings.tsx", "HouseRulesSettings.tsx", "StarterProfiles.tsx", "RoomTurnTimeoutSettings.tsx", "RoomRoutingSettings.tsx", "ProjectAutonomySetting.tsx"],
  models: ["AiSettings.tsx", "ModelsSettings.tsx", "EnginesSettings.tsx", "ClaudeAccountsSettings.tsx", "LocalModelsSettings.tsx"],
  webSearch: ["ToolsSettings.tsx", "SearchSettings.tsx", "ImageSettings.tsx", "TranscriptionSettings.tsx"],
  companion: ["SettingsModal.tsx", "DevicesSettings.tsx", "CompanionSection.tsx", "ScriptAccessSettings.tsx"],
  about: ["SettingsModal.tsx", "AnnouncementsSettings.tsx"],
};

describe("the regrouped pages", () => {
  it("renders every card of every merged page, and owes no anchor", () => {
    expect(ANCHORS_OWED).toEqual({});
    for (const [page, files] of Object.entries(PAGE_FILES)) {
      const source = files.map(read).join("\n");
      for (const card of SETTINGS_CARDS.filter((entry) => entry.section === page)) {
        expect(source.includes(`id="${card.anchor}"`) || source.includes(`id: "${card.anchor}"`), `${page}: ${card.anchor}`).toBe(true);
      }
    }
  });

  it("gives each page one Advanced, and each Advanced card a home inside it", () => {
    const pageSource: Record<string, string> = {
      general: modal, botDefaults: read("BotsSettings.tsx"), models: read("AiSettings.tsx"),
      webSearch: read("ToolsSettings.tsx"), companion: read("DevicesSettings.tsx"), about: modal,
    };
    for (const [page, source] of Object.entries(pageSource)) {
      const advanced = SETTINGS_CARDS.filter((card) => card.section === page && card.advanced);
      expect(advanced.length, page).toBeGreaterThan(0);
      const count = page === "general" || page === "about" ? source.split(`advancedFor("${page}")`).length - 1 : source.split(/<AdvancedSection[ \n]/).length - 1;
      expect(count, page).toBe(1);
    }
    // Models and Tools put their Advanced parts in the slot, from the cards that hold them.
    expect(read("AiSettings.tsx")).toContain("<AdvancedSlotTarget />");
    expect(read("ToolsSettings.tsx")).toContain("<AdvancedSlotTarget />");
    for (const name of ["ModelsSettings.tsx", "EnginesSettings.tsx", "SearchSettings.tsx", "ImageSettings.tsx", "TranscriptionSettings.tsx"]) {
      expect(read(name), name).toContain("<InAdvanced>");
    }
  });

  it("keeps the old folds out of the owned components", () => {
    for (const name of ["ModelsSettings.tsx", "ClaudeAccountsSettings.tsx", "EnginesSettings.tsx", "LocalComputerSection.tsx", "ImageLibrary.tsx", "SettingsModal.tsx"]) {
      expect(read(name), name).not.toContain("<details");
    }
    expect(modal).not.toContain('<details id="paste-any-keys"');
    expect(read("AiSettings.tsx")).toContain('id="paste-any-keys"');
  });

  it("withholds the desktop cards from a phone and keeps General and About on every surface", () => {
    for (const id of ["general.about-me", "general.startup", "general.sidebar-density", "skills.recorder", "companion.browser", "about.announcements"]) {
      expect(SETTINGS_CARDS.find((card) => card.id === id)!.surface, id).toBe("desktop");
    }
    const visible = new Set(cardsForSurface(SETTINGS_CARDS, false).map((card) => card.id));
    for (const id of ["general.profile", "general.appearance", "about.version", "about.updates", "about.diagnostics"]) expect(visible.has(id), id).toBe(true);
    for (const id of ["general.about-me", "skills.recorder", "companion.browser"]) expect(visible.has(id), id).toBe(false);
    for (const page of ["general", "about"]) expect(SECTION_PAGES.find((entry) => entry.id === page)!.desktopOnly, page).toBeFalsy();
    expect(modal).toMatch(/desktop === true && <Anchor id="announcements-heading">/);
    expect(modal).toMatch(/desktop === true && section === "skills" && \([\s\S]*?<WorkspaceFeatureRow feature="skillRecorder"/);
    expect(modal).toMatch(/desktop === true && section === "companion" && \([\s\S]*?<WorkspaceFeatureRow feature="browser"/);
    expect(modal).not.toContain("ExperimentalFeaturesRow");
    expect(modal).not.toContain('id="experimental-settings"');
  });

  it("renders the anchor every alias lands on", () => {
    const all = [...new Set(Object.values(PAGE_FILES).flat())].map(read).join("\n");
    for (const [alias, target] of Object.entries(SECTION_ALIASES)) {
      expect(all.includes(`id="${target.anchor}"`) || all.includes(`id: "${target.anchor}"`), alias).toBe(true);
    }
  });

  it("keeps the Images tabs the openers click", () => {
    const tools = read("ToolsSettings.tsx");
    expect(tools).toContain("id={`images-tab-${id}`}");
    expect(tools).toContain('"setup"');
    expect(tools).toContain('"library"');
  });

  it("keeps the About items 1.0.3 already built", () => {
    for (const id of ["AboutVersionCard", "UpdatesRow", "WhatsNewRow", "SetupAgainRow", "ShortcutsRow", "SourceCodeRow", "DiagnosticsRow"]) expect(modal, id).toContain(`<${id} />`);
    expect(modal).toContain("versionCopy");
  });

  it("opens the Advanced parts by anchor from What's new", () => {
    const host = read("WhatsNewHost.tsx");
    expect(host).toContain('anchor: "room-routing-label"');
    expect(host).toContain('anchor: "room-turn-timeout"');
  });
});
