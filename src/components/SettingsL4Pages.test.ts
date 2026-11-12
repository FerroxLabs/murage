// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 L4: the six regrouped pages keep every card, with the rare ones under one Advanced each.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cardsForSurface } from "@/lib/settings-cards";
import { ANCHORS_OWED, SETTINGS_CARDS } from "@/lib/settings-card-registry";
import { SECTION_ALIASES, SECTION_PAGES } from "@/lib/settings-pages";

const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
const modal = read("SettingsModal.tsx");
// A page with a file of its own names its cards' anchors as data (settings/pages/*Page.tsx), not as an id on an element.
const PAGE_ANCHORS = new Set(readdirSync(fileURLToPath(new URL("./settings/pages", import.meta.url))).flatMap((file) => [...read(`settings/pages/${file}`).matchAll(/(?:card\("[\w-]+", |anchor: )"([\w-]+)"/g)].map((match) => match[1])));

// Every file a page draws its cards from.
const PAGE_FILES: Record<string, string[]> = {
  general: ["SettingsModal.tsx", "AboutMeSettings.tsx", "NotificationSettings.tsx", "StartupSettings.tsx", "ScriptAccessSettings.tsx"],
  calls: ["CallsSettings.tsx"],
  botDefaults: ["BotsSettings.tsx", "HouseRulesSettings.tsx", "StarterProfiles.tsx", "RoomTurnTimeoutSettings.tsx", "RoomRoutingSettings.tsx", "ProjectAutonomySetting.tsx"],
  models: ["ModelsSettings.tsx", "EnginesSettings.tsx", "ClaudeAccountsSettings.tsx", "LocalModelsSettings.tsx"],
  webSearch: ["ToolsSettings.tsx", "SearchSettings.tsx", "ImageSettings.tsx", "TranscriptionSettings.tsx"],
  computer: ["settings/pages/ComputerPage.tsx", "SettingsModal.tsx", "LocalComputerSection.tsx", "ScriptAccessSettings.tsx"],
  companion: ["settings/pages/CompanionPage.tsx", "CompanionSection.tsx"],
  channelsAlias: ["settings/pages/ChannelsPage.tsx", "TelegramSettings.tsx"],
  backups: ["settings/pages/BackupsPage.tsx", "BackupSettings.tsx", "StorageSettings.tsx"],
  usage: ["settings/pages/UsagePage.tsx", "UsageSection.tsx"],
  about: ["settings/pages/AboutPage.tsx", "settings/pages/about-rows.tsx", "SettingsModal.tsx", "AnnouncementsSettings.tsx"],
};

describe("the regrouped pages", () => {
  it("renders every card of every merged page, and owes no anchor", () => {
    expect(ANCHORS_OWED).toEqual({});
    for (const [page, files] of Object.entries(PAGE_FILES)) {
      const source = files.map(read).join("\n");
      for (const card of SETTINGS_CARDS.filter((entry) => entry.section === page)) {
        expect(source.includes(`id="${card.anchor}"`) || source.includes(`id: "${card.anchor}"`) || source.includes(`anchor: "${card.anchor}"`) || PAGE_ANCHORS.has(card.anchor), `${page}: ${card.anchor}`).toBe(true);
      }
    }
  });

  it("gives each page one Advanced, and each Advanced card a home inside it", () => {
    // Every registered page uses the shared Simple/Advanced card renderer once.
    const registry = read("settings/page-registry.tsx");
    for (const page of SECTION_PAGES) {
      const file = registry.match(new RegExp(String.raw`${page.id}: \(\) => import\("\./pages/(\w+)"\)`))?.[1];
      expect(file, page.id).toBeTruthy();
      const source = read(`settings/pages/${file}.tsx`);
      expect(source.match(/<PageCards /g)?.length, page.id).toBe(1);
      expect(source, page.id).toContain("mode={mode}");
    }
    // Models, Memory and Search put their Advanced parts on their cards, from the components that hold them.
    for (const name of ["ModelsSettings.tsx", "EnginesSettings.tsx", "SearchSettings.tsx", "ImageSettings.tsx"]) {
      expect(read(name), name).toContain('part="');
    }
  });

  it("keeps the old folds out of the owned components", () => {
    for (const name of ["ModelsSettings.tsx", "ClaudeAccountsSettings.tsx", "EnginesSettings.tsx", "LocalComputerSection.tsx", "ImageLibrary.tsx", "SettingsModal.tsx"]) {
      expect(read(name), name).not.toContain("<details");
    }
    expect(modal).not.toContain('<details id="paste-any-keys"');
    expect(read("settings/pages/ModelsPage.tsx")).toContain('"paste-any-keys"');
  });

  it("withholds the desktop cards from a phone and keeps General and About on every surface", () => {
    for (const id of ["general.about-me", "general.startup", "general.sidebar-density", "skills.recorder", "companion.browser", "about.news"]) {
      expect(SETTINGS_CARDS.find((card) => card.id === id)!.surface, id).toBe("desktop");
    }
    const visible = new Set(cardsForSurface(SETTINGS_CARDS, false).map((card) => card.id));
    for (const id of ["general.profile", "general.appearance", "about.version", "about.diagnostics"]) expect(visible.has(id), id).toBe(true);
    for (const id of ["general.about-me", "skills.recorder", "companion.browser"]) expect(visible.has(id), id).toBe(false);
    for (const page of ["general", "about"]) expect(SECTION_PAGES.find((entry) => entry.id === page)!.desktopOnly, page).toBeFalsy();
    expect(read("settings/pages/AboutPage.tsx")).toMatch(/desktop === true\s*\? <><NewsSignupSettings \/><Anchor id="announcements-heading"><AnnouncementsSettings/);
    expect(read("settings/pages/SkillsPage.tsx")).toContain('<WorkspaceFeatureRow feature="skillRecorder" />');
    expect(read("settings/pages/ComputerPage.tsx")).toContain("<WorkspaceFeatureRow feature=\"browser\" />");
    expect(modal).not.toContain("ExperimentalFeaturesRow");
    expect(modal).not.toContain('id="experimental-settings"');
  });

  it("renders the anchor every alias lands on", () => {
    const all = [...new Set(Object.values(PAGE_FILES).flat())].map(read).join("\n");
    for (const [alias, target] of Object.entries(SECTION_ALIASES)) {
      expect(all.includes(`id="${target.anchor}"`) || all.includes(`id: "${target.anchor}"`) || all.includes(`anchor: "${target.anchor}"`) || PAGE_ANCHORS.has(target.anchor), alias).toBe(true);
    }
  });

  it("keeps the Images tabs the openers click", () => {
    const tools = read("ToolsSettings.tsx");
    expect(tools).toContain("id={`images-tab-${id}`}");
    expect(tools).toContain('"setup"');
    expect(tools).toContain('"library"');
  });

  it("keeps the About items 1.0.3 already built", () => {
    const about = read("settings/pages/AboutPage.tsx") + read("settings/pages/about-rows.tsx");
    for (const id of ["AboutVersionCard", "WhatsNewRow", "SetupAgainRow", "ShortcutsRow", "SourceCodeRow", "DiagnosticsRow"]) expect(about, id).toContain(`<${id} />`);
    // 1.0.19: the update row keeps its anchor inside the single Version and updates card.
    expect(about).toContain('<Anchor id="updates-heading"><UpdatesCard /></Anchor>');
    expect(about).toContain("<UpdateActionButton state={s} />");
    expect(about).toContain("versionCopy");
  });

  it("opens the Advanced parts by anchor from What's new", () => {
    const host = read("WhatsNewHost.tsx");
    expect(host).toContain('anchor: "room-routing-label"');
    expect(host).toContain('anchor: "room-turn-timeout"');
  });
});
