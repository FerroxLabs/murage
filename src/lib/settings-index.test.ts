// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SETTINGS-UX-1011 S2: the one index. Every anchor registered, every entry rendered, the mandatory first hits.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BOT_SETTINGS_SECTIONS } from "@/components/bot-settings-sections";
import { SETTINGS_CARDS } from "./settings-card-registry";
import { APP_SETTINGS_ENTRIES, BOT_SETTINGS_CARDS, SETTINGS_INDEX, settingsIndexProblems } from "./settings-index";
import { searchSettingsIndex, type SettingsFindContext } from "./settings-search";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const PANEL = read("../components/SettingsPanel.tsx");
const MODAL = read("../components/SettingsModal.tsx");
const BOTS = [{ id: "b-nova", name: "Nova" }, { id: "b-rex", name: "Rex" }, { id: "b-ivy", name: "Ivy" }];
const APP: SettingsFindContext = { desktop: true, cloud: false, bots: BOTS };
const firstId = (query: string, context: SettingsFindContext = APP) => {
  const hit = searchSettingsIndex(query, context).hits[0];
  return hit && (hit.bot ? `${hit.entry.id}@${hit.bot.name}` : hit.entry.id);
};

describe("the settings index", () => {
  it("passes its invariants", () => {
    expect(settingsIndexProblems()).toEqual([]);
    expect(SETTINGS_INDEX.length).toBe(SETTINGS_CARDS.length + BOT_SETTINGS_CARDS.length);
    expect(APP_SETTINGS_ENTRIES.map((entry) => entry.id)).toEqual(SETTINGS_CARDS.map((card) => card.id));
  });

  it("holds roughly 35 bot entries and at least one for every bot section", () => {
    expect(BOT_SETTINGS_CARDS.length).toBeGreaterThanOrEqual(30);
    for (const section of BOT_SETTINGS_SECTIONS) expect(BOT_SETTINGS_CARDS.some((entry) => entry.section === section.id), section.id).toBe(true);
  });

  it("renders every bot entry on its own row in the bot window", () => {
    for (const entry of BOT_SETTINGS_CARDS) {
      expect(PANEL, entry.id).toContain(`id="${entry.anchor}" data-setting="${entry.id}"`);
    }
  });

  it("registers every data-setting row and every Settings anchor", () => {
    const ids = new Set(SETTINGS_INDEX.map((entry) => entry.id));
    for (const source of [PANEL, MODAL]) {
      for (const [, id] of source.matchAll(/data-setting="([^"]+)"/g)) expect(ids.has(id), `${id} is rendered but not in the index`).toBe(true);
    }
    const anchors = new Set(SETTINGS_CARDS.map((card) => card.anchor));
    for (const [, anchor] of MODAL.matchAll(/<Anchor id="([^"]+)"/g)) expect(anchors.has(anchor), `${anchor} is rendered but not registered`).toBe(true);
  });

  it("keeps the words people type even where the label says something plainer", () => {
    const words = (id: string) => SETTINGS_INDEX.find((entry) => entry.id === id)!.words;
    expect(words("connections.mcp")).toContain("mcp");
    expect(words("connections.apps")).toContain("api");
    expect(words("models.providers")).toContain("api key");
    expect(words("memory.limit")).toContain("tokens");
    expect(words("bot.access.apps")).toContain("mcp");
  });

  it("lists a gated entry with its gate, never leaves it out", () => {
    const email = SETTINGS_INDEX.find((entry) => entry.id === "connections.bot-email")!;
    expect(email.gate?.feature).toBe("flux-email");
    expect(email.gate?.reason()).toMatch(/Flux Router/);
    expect(BOT_SETTINGS_CARDS.find((entry) => entry.id === "bot.email.email")!.gate?.feature).toBe("flux-email");
  });
});

describe("the mandatory first hits (S2 gate)", () => {
  it.each([
    ["working folder", "bot.access.folder@Nova"],
    ["approval", "bot.permissions.level@Nova"],
    ["email", "connections.bot-email"],
    ["ollama", "models.local-servers"],
    ["mcp", "connections.mcp"],
  ])("%s", (query, expected) => {
    expect(firstId(query)).toBe(expected);
  });

  it("lists bot rows for every bot, the open bot's first", () => {
    const rex: SettingsFindContext = { ...APP, currentBotId: "b-rex" };
    expect(firstId("working folder", rex)).toBe("bot.access.folder@Rex");
    const ids = searchSettingsIndex("working folder", APP).hits.map((hit) => hit.bot?.name);
    expect(ids).toEqual(expect.arrayContaining(["Nova", "Rex", "Ivy"]));
  });

  it("gives a bot row its path", () => {
    const hit = searchSettingsIndex("working folder", APP).hits[0];
    expect(hit.path).toEqual(["Nova", "Access", "Working folder"]);
    const folded = searchSettingsIndex("command line", APP).hits.find((entry) => entry.entry.id === "models.command-lines")!;
    expect(folded.path[1]).toBe("Advanced");
  });

  it("leaves desktop-only rows off a phone", () => {
    const phone: SettingsFindContext = { desktop: false, cloud: false, bots: BOTS };
    const all = (query: string) => { const result = searchSettingsIndex(query, phone); return [...result.hits, ...result.more]; };
    for (const query of ["computer", "ollama", "mcp", "learning", "teams"]) {
      for (const hit of all(query)) expect(hit.entry.surface, `${query} ${hit.entry.id}`).toBe("any");
    }
    expect(firstId("working folder", phone)).toBe("bot.access.folder@Nova");
  });
});
