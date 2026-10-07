// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.62 grouped Settings (NAV-OVERHAUL.md 3.2, 3.4, 4): six groups over
// nineteen short pages, every old id and every published announcement target
// still landing somewhere, and the search words following the cards they
// name.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  normalizeSettingsSection,
  sectionsForSurface,
  settingsSectionLabel,
  settingsSectionRedirect,
  type AppSettingsSection,
} from "./settings-sections";
import { settingsSearchResults } from "./settings-search";
import { initialState, reducer } from "@/state/store";
import { en } from "@/locales";

/** Every id a 0.1.61 build could send: deep links, stored state, notices. */
const OLD_IDS: AppSettingsSection[] = ["models", "general", "backups", "experimental", "connections", "engines", "channels", "companion", "computer", "skills", "houseRules", "aboutMe", "memory", "usage"];
const NEW_IDS: AppSettingsSection[] = ["botDefaults", "images", "webSearch", "voice", "about"];

/** The 0.1.61 search words, section by section (SettingsModal.tsx at ac3ea1c9). */
const OLD_KEYWORDS = [
  "profile", "name", "email", "skin", "theme", "appearance", "analytics", "updates", "tools", "tool calls", "notifications", "sound", "sounds", "mute", "chime", "quiet hours", "privacy", "previews", "startup", "background", "tray", "login", "sign in", "version", "app version", "about", "setup", "first run", "get set up", "walkthrough", "announcements", "news", "notices",
  "backup", "restore", "recovery", "schedule", "s3", "off-site", "remote", "restic", "age", "key", "recovery key", "age key", "encryption key",
  "early", "preview", "teach", "skill", "browser", "profiles",
  "models", "providers", "keys", "catalog", "flux", "pricing", "openai", "anthropic",
  "claude", "grok", "cli", "flux router", "router", "opencode",
  "api", "box", "vps", "paste", "env", "search", "tavily", "exa", "transcription",
  "telegram", "botfather", "pair", "slack", "discord", "whatsapp", "messaging", "channels",
  "companion", "phone", "mobile", "vm", "virtual", "desktop",
  "skills", "import", "scan", "library", "instructions",
  "house rules", "constitution", "soul", "rules", "principles", "guidance", "values", "tone", "every bot",
  "about me", "who i am", "my name", "myself", "time zone", "preferences",
  "memory", "learning", "learned", "remember", "forget", "facts", "notes", "what it knows", "history", "review",
  "tokens", "cost", "billing",
];

describe("the grouped sections", () => {
  it("are nineteen pages under six groups, in the approved order", () => {
    expect(SETTINGS_GROUPS).toEqual(["you", "bots", "models", "tools", "channels", "app"]);
    expect(SETTINGS_SECTIONS.map((entry) => `${entry.group}:${entry.id}`)).toEqual([
      "you:general", "you:aboutMe",
      "bots:botDefaults", "bots:houseRules", "bots:skills", "bots:memory",
      "models:models", "models:engines",
      "tools:images", "tools:webSearch", "tools:voice", "tools:connections", "tools:computer",
      "channels:channels", "channels:companion",
      "app:backups", "app:usage", "app:about", "app:experimental",
    ]);
    // a group's sections sit together, so a heading is drawn once
    const groups = SETTINGS_SECTIONS.map((entry) => entry.group);
    expect(groups.filter((group, index) => group !== groups[index - 1])).toEqual([...SETTINGS_GROUPS]);
  });

  it("keeps every old id and adds five, with plain English labels", () => {
    const ids = SETTINGS_SECTIONS.map((entry) => entry.id);
    for (const id of [...OLD_IDS, ...NEW_IDS]) expect(ids, id).toContain(id);
    expect(ids).toHaveLength(OLD_IDS.length + NEW_IDS.length);
    expect(settingsSectionLabel("connections")).toBe("Connected apps");
    expect(settingsSectionLabel("computer")).toBe("Computer & browser");
    expect(settingsSectionLabel("about")).toBe("Help & updates");
    for (const id of ids) expect(en[`settings.section.${id}` as keyof typeof en], id).toBeTruthy();
  });
});

describe("settings search across the groups", () => {
  it("finds each moved card on its new page", () => {
    const expected: Array<[string, AppSettingsSection]> = [
      ["image", "images"], ["images", "images"], ["picture", "images"], ["reference packs", "images"], ["prompt blocks", "images"],
      ["tavily", "webSearch"], ["web search", "webSearch"],
      ["assemblyai", "voice"], ["transcription", "voice"], ["voice notes", "voice"],
      ["vps", "computer"], ["browser profile", "computer"], ["box", "computer"],
      ["effort", "botDefaults"], ["tool calls", "botDefaults"], ["channel turns", "botDefaults"], ["starter profiles", "botDefaults"],
      ["paste", "models"], ["mcp", "connections"],
      ["diagnostics", "about"], ["keyboard", "about"], ["what's new", "about"],
      ["sidebar", "general"], ["language", "general"],
    ];
    for (const [query, section] of expected) expect(settingsSearchResults(query), query).toContain(section);
  });

  it("finds a group by its name", () => {
    const tools = settingsSearchResults("tools");
    for (const id of ["images", "webSearch", "voice", "connections", "computer"] as const) expect(tools).toContain(id);
    expect(settingsSearchResults("messaging & phone")).toEqual(["channels", "companion"]);
  });

  it("leaves no 0.1.61 search word stranded", () => {
    for (const word of OLD_KEYWORDS) expect(settingsSearchResults(word).length, word).toBeGreaterThan(0);
  });
});

describe("which sections a surface sees", () => {
  it("gives a paired phone General, Usage and Help & updates, and nothing with a key on it", () => {
    expect(sectionsForSurface(SETTINGS_SECTIONS, false).map((entry) => entry.id)).toEqual(["general", "usage", "about"]);
    expect(sectionsForSurface(SETTINGS_SECTIONS, undefined).map((entry) => entry.id)).toEqual(["general", "usage", "about"]);
    expect(sectionsForSurface(SETTINGS_SECTIONS, true)).toHaveLength(SETTINGS_SECTIONS.length);
  });

  it("waits on a new desktop-only page while the surface is unconfirmed (0.1.61 flux-entrypoints)", () => {
    const unknown = sectionsForSurface(SETTINGS_SECTIONS, undefined);
    for (const id of ["images", "webSearch", "voice", "botDefaults"] as const) {
      expect(settingsSectionRedirect(SETTINGS_SECTIONS, id, undefined, unknown), id).toBeNull();
      expect(settingsSectionRedirect(SETTINGS_SECTIONS, id, false, sectionsForSurface(SETTINGS_SECTIONS, false)), id).toBe("general");
      expect(settingsSectionRedirect(SETTINGS_SECTIONS, id, false, sectionsForSurface(SETTINGS_SECTIONS, false), false), id).toBeNull();
    }
    expect(settingsSectionRedirect(SETTINGS_SECTIONS, "about", false, sectionsForSurface(SETTINGS_SECTIONS, false))).toBeNull();
  });
});

describe("the one door for a section id", () => {
  it("passes every known id through and lands anything else on General", () => {
    for (const id of [...OLD_IDS, ...NEW_IDS]) expect(normalizeSettingsSection(id)).toBe(id);
    for (const stale of ["tools", "Tools & Connections", "", undefined, null, 7, "settings-connections"]) expect(normalizeSettingsSection(stale)).toBe("general");
  });

  it("is the reducer's: a stale or unknown id cannot open Settings on nothing", () => {
    const opened = reducer(initialState, { type: "toggleAppSettings", open: true, section: "nonsense" as AppSettingsSection });
    expect(opened).toMatchObject({ appSettingsOpen: true, appSettingsSection: "general" });
    expect(reducer(initialState, { type: "toggleAppSettings", open: true, section: "images" }).appSettingsSection).toBe("images");
    // no section keeps the last one
    const kept = reducer({ ...initialState, appSettingsSection: "voice" }, { type: "toggleAppSettings", open: true });
    expect(kept.appSettingsSection).toBe("voice");
  });

  it("opens the Connected apps panel on the half Settings asked for", () => {
    expect(reducer(initialState, { type: "togglePlugins", open: true, surface: "mcp" })).toMatchObject({ pluginsOpen: true, pluginsSurface: "mcp" });
    expect(reducer(initialState, { type: "togglePlugins", open: true })).toMatchObject({ pluginsOpen: true, pluginsSurface: "apps" });
  });
});

describe("links into moved content (NAV-OVERHAUL.md 3.4)", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  it("sends each caller to the page that now holds what it wants", () => {
    expect(read("../components/SkillRecorderPage.tsx")).toContain('dispatch({ type: "toggleAppSettings", open: true, section: "voice" })');
    const computer = read("../components/ComputerPanel.tsx");
    expect(computer).toMatch(/const openVmSettings = \(\) => \{\s*dispatch\(\{ type: "toggleAppSettings", open: true, section: "computer" \}\);/);
    expect(computer).toMatch(/const openConnectionSettings = \(\) => \{\s*dispatch\(\{ type: "toggleAppSettings", open: true, section: "computer" \}\);/);
    const plugins = read("../components/PluginsPanel.tsx");
    expect(plugins).not.toContain("addOwnKey");
    expect(plugins).toContain('section: action === "enable-flux" ? "models" : "connections"');
    expect(plugins).not.toMatch(/\{ type: "toggleAppSettings", open: true \}\)/);
    expect(read("../components/Announcements.tsx")).toContain('dispatch({ type: "toggleAppSettings", open: true, section: "about" });');
  });

  it("keeps the fields other screens focus inside Settings", () => {
    const modal = read("../components/SettingsModal.tsx");
    // connected apps have no key row any more: they run through Flux Router
    expect(modal).not.toContain('<ApiKeyRow section="composio" />');
    // What's new tiles focus these (WhatsNewHost.tsx)
    expect(read("../components/ImageSettings.tsx")).toContain('id="image-settings-heading"');
    expect(read("../components/RoomTurnTimeoutSettings.tsx")).toContain('id="room-turn-timeout"');
  });
});
