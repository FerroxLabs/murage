// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 L1: the shell. Twelve pages in five groups, the anchor the store carries, and no <details> outside Advanced.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { en } from "@/locales";
import { SECTION_PAGES, SETTINGS_PAGE_GROUPS } from "@/lib/settings-pages";
import { initialState, reducer } from "@/state/store";
import type { AppSettingsSection } from "@/lib/settings-sections";
import { markParts } from "./SettingsSearchResults";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const modal = read("./SettingsModal.tsx");

describe("the sidebar", () => {
  it("draws the twelve pages under five headings, with the mockup's labels", () => {
    expect(SECTION_PAGES).toHaveLength(12);
    expect(SETTINGS_PAGE_GROUPS.map((group) => en[`settings.group.${group}` as keyof typeof en])).toEqual(["You", "Bots", "AI", "Reach", "App"]);
    expect(SECTION_PAGES.map((page) => en[`settings.page.${page.id}` as keyof typeof en])).toEqual([
      "General", "Bots", "Skills", "Memory", "Models & engines", "Tools", "Connected apps", "Messaging apps", "Devices", "Backups", "Usage", "About & updates",
    ]);
    for (const group of SETTINGS_PAGE_GROUPS) expect(en[`settings.groupNote.${group}` as keyof typeof en], group).toBeTruthy();
    expect(modal).toContain("SECTION_PAGES.map((entry) => ({ ...entry, icon: PAGE_ICONS[entry.id] }))");
    expect(modal).toContain("settingsPageLabel(id)");
  });
});

describe("the anchor in the store", () => {
  it("is set from the alias, an explicit anchor wins, a page has none, and closing forgets it", () => {
    expect(reducer(initialState, { type: "toggleAppSettings", open: true, section: "voice" })).toMatchObject({ appSettingsSection: "voice", appSettingsAnchor: "voice-settings-heading" });
    expect(reducer(initialState, { type: "toggleAppSettings", open: true, section: "experimental" }).appSettingsAnchor).toBe("skill-recorder-heading");
    expect(reducer(initialState, { type: "toggleAppSettings", open: true, section: "models" }).appSettingsAnchor).toBeNull();
    const result = reducer(initialState, { type: "toggleAppSettings", open: true, section: "botDefaults", anchor: "tool-calls-heading" });
    expect(result).toMatchObject({ appSettingsSection: "botDefaults", appSettingsAnchor: "tool-calls-heading" });
    expect(reducer(result, { type: "appSettingsAnchorDone" }).appSettingsAnchor).toBeNull();
    expect(reducer(result, { type: "toggleAppSettings", open: false }).appSettingsAnchor).toBeNull();
    expect(reducer(initialState, { type: "toggleAppSettings", open: true, section: "nonsense" as AppSettingsSection }).appSettingsAnchor).toBeNull();
  });

  it("resolves every one of the 19 ids to a page", () => {
    for (const id of ["general", "aboutMe", "botDefaults", "houseRules", "skills", "memory", "models", "engines", "images", "webSearch", "voice", "connections", "computer", "channels", "companion", "backups", "usage", "about", "experimental"] as const) {
      const state = reducer(initialState, { type: "toggleAppSettings", open: true, section: id });
      expect(state.appSettingsSection, id).toBe(id);
    }
  });
});

describe("the search box", () => {
  it("shows results in place of the page, clears for an opener, and keeps the sidebar whole", () => {
    expect(modal).toContain("<SettingsSearchResults");
    expect(modal).toContain("setQuery(\"\")");
    expect(modal).toContain("appSettingsAnchorDone");
    expect(modal).not.toContain("settingsSectionMatches");
  });

  it("marks the match in a result", () => {
    expect(markParts("Show tool calls in the conversation", "tool")).toEqual(["Show ", "tool", " calls in the conversation"]);
    expect(markParts("Web search", "zzz")).toEqual(["Web search", "", ""]);
  });
});

/** Files that once held a <details> inside a settings page; none may hold one now (L7 closes the list). */
const DETAILS_PENDING: Record<string, string> = {};
const FORMER_DETAILS_FILES = ["MemorySection.tsx", "MemorySettings.tsx", "LearningSettings.tsx", "MemoryLearningControls.tsx", "MemoryEvolutionControls.tsx", "MemoryNeedsYou.tsx", "MemoryReview.tsx", "ProcedureEvaluationAdmissions.tsx", "BackupSettings.tsx", "BackupRemoteSettings.tsx"];
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("no <details> outside Advanced", () => {
  it("leaves none in the files L1 owns", () => {
    for (const file of ["SettingsPrimitives.tsx", "SlackSettings.tsx", "DiscordSettings.tsx", "TelegramSettings.tsx", "WhatsAppSettings.tsx", "skills/SkillsSettings.tsx", "SettingsSearchResults.tsx"]) {
      expect(stripComments(read(`./${file}`)), file).not.toContain("<details");
    }
  });

  it("holds the pending map at zero: every settings file is clear, the modal holds no fold", () => {
    expect(Object.keys(DETAILS_PENDING)).toEqual([]);
    for (const file of FORMER_DETAILS_FILES) expect(stripComments(read(`./${file}`)), file).not.toContain("<details");
    expect(stripComments(modal)).not.toContain("<details");
    for (const file of ["ModelsSettings.tsx", "EnginesSettings.tsx", "ClaudeAccountsSettings.tsx", "LocalModelsSettings.tsx", "LocalComputerSection.tsx", "ImageLibrary.tsx"]) {
      expect(stripComments(read(`./${file}`)), file).not.toContain("<details");
    }
  });

  it("moves the messaging apps' extras and Skills' scan rules into the page's Advanced", () => {
    expect(read("./SlackSettings.tsx")).toContain("<InAdvanced>");
    expect(read("./DiscordSettings.tsx")).toContain("<InAdvanced>");
    expect(read("./WhatsAppSettings.tsx").match(/<InAdvanced>/g)?.length).toBe(2);
    expect(read("./skills/SkillsSettings.tsx")).toContain("<InAdvanced><SkillScanRules />");
    expect(modal).toMatch(/<AdvancedSection \{\.\.\.advancedFor\("channels"\)\}/);
    expect(modal).toMatch(/<AdvancedSection \{\.\.\.advancedFor\("skills"\)\}/);
    expect(modal).toContain('section="connections"');
  });
});
