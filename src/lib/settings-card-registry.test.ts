// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.3 L1: the card registry and the cards' search.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { en } from "@/locales";
import { cardForAnchor, cardsForSurface, settingsCardProblems } from "./settings-cards";
import { ANCHORS_OWED, MERGED_CARD_ANCHORS, SETTINGS_CARDS, cardLabel, resolveSettingsCard } from "./settings-card-registry";
import { isAdvancedOnlyCard } from "./settings-simple-cards";
import { SECTION_ALIASES, SECTION_PAGES, resolveSettingsSection } from "./settings-pages";
import { searchSettingsCards } from "./settings-search";
import { SETTINGS_SECTIONS } from "./settings-sections";

const COMPONENTS = fileURLToPath(new URL("../components", import.meta.url));
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx$/.test(entry) && !/\.test\./.test(entry)) out.push(readFileSync(full, "utf8"));
  }
  return out;
}
const SOURCE = sources(COMPONENTS).join("\n");
// A page with a file of its own names its cards' anchors as data (settings/pages/*Page.tsx), and the page slot renders the id.
const PAGES_DIR = join(COMPONENTS, "settings/pages");
const PAGE_ANCHORS = new Set(readdirSync(PAGES_DIR).flatMap((file) => [...readFileSync(join(PAGES_DIR, file), "utf8").matchAll(/(?:card\("[\w-]+", |anchor: )"([\w-]+)"/g)].map((match) => match[1])));

describe("the card registry", () => {
  it.each([
    ["about.updates", "updates-heading", "about.version", false],
    ["about.previous-version", "previous-version-heading", "about.version", false],
    ["about.announcements", "announcements-heading", "about.news", true],
  ] as const)("resolves %s and its old anchor to the retained row and owning card", (id, anchor, owner, advanced) => {
    for (const target of [id, anchor]) {
      const card = resolveSettingsCard(target)!;
      expect(card).toMatchObject({ id: owner, section: "about", anchor });
      expect(isAdvancedOnlyCard(card.section, card.id)).toBe(advanced);
    }
    expect(SETTINGS_CARDS.some((card) => card.id === id)).toBe(false);
  });

  it("keeps Messaging card ids and search anchors on Apps", () => {
    const cards = SETTINGS_CARDS.filter((card) => card.id.startsWith("channels."));
    expect(cards).toHaveLength(8);
    for (const card of cards) {
      expect(card.section).toBe("connections");
      expect(resolveSettingsCard(card.id)).toEqual(card);
    }
    expect(searchSettingsCards("telegram", true)[0].card).toMatchObject({ id: "channels.telegram", section: "connections", anchor: "telegram-settings-title" });
  });

  it("passes the I0 invariants and gives every page at least one card", () => {
    expect(settingsCardProblems(SETTINGS_CARDS)).toEqual([]);
    for (const page of SECTION_PAGES) expect(SETTINGS_CARDS.some((card) => card.section === page.id), page.id).toBe(true);
  });

  it("names every card in plain English, with no em dash and no safe words", () => {
    for (const card of SETTINGS_CARDS) {
      const label = cardLabel(card);
      expect(label, card.id).not.toBe(`settings.l1.card.${card.id}`);
      expect(label).not.toMatch(/—|\bsaf(?:e|ely|ety)\b|\bunsafe\b/i);
    }
  });

  it("holds a card for every alias, on the page the alias lands on", () => {
    for (const [alias, target] of Object.entries(SECTION_ALIASES)) {
      const card = cardForAnchor(SETTINGS_CARDS, target.anchor);
      expect(card, alias).toBeDefined();
      expect(card!.section, alias).toBe(target.section);
    }
    expect(cardForAnchor(SETTINGS_CARDS, SECTION_ALIASES.experimental.anchor)).toMatchObject({ section: "skills", advanced: false });
    expect(SETTINGS_CARDS.some((card) => card.id === "about.experimental")).toBe(false);
  });

  it("renders every anchor, or owes it to the lane that owns the page", () => {
    for (const card of SETTINGS_CARDS) {
      const rendered = SOURCE.includes(`id="${card.anchor}"`) || SOURCE.includes(`id: "${card.anchor}"`) || SOURCE.includes(`anchor: "${card.anchor}"`) || PAGE_ANCHORS.has(card.anchor);
      if (ANCHORS_OWED[card.anchor]) expect(rendered, `${card.anchor} is rendered now: drop it from ANCHORS_OWED`).toBe(false);
      else expect(rendered, `${card.anchor} (${card.id}) is not rendered anywhere`).toBe(true);
    }
    for (const anchor of Object.keys(ANCHORS_OWED)) expect(cardForAnchor(SETTINGS_CARDS, anchor), anchor).toBeDefined();
  });

  it("marks exactly one control per card for the landing (designs/UX-L3A2-LANDING-1017.md)", () => {
    // A mark is the literal attribute or the explicit primitive prop: ="<anchor>", or {<one-item guard> ? "<anchor>" :
    // undefined | "<other anchor>"}. A primitive forwards with data-setting-control={settingControl}. Nothing else.
    const counts = new Map<string, number>();
    for (const [, literal, expression] of SOURCE.matchAll(/(?:data-setting-control|settingControl)=(?:"([^"]*)"|\{([^{}]*)\})/g)) {
      if (expression?.trim() === "settingControl") continue;
      const named = literal !== undefined ? [literal] : [...expression!.slice(expression!.lastIndexOf("?") + 1).matchAll(/"([^"]*)"/g)].map((match) => match[1]);
      expect(named.length, `a mark spelled without a plain anchor id: ${expression}`).toBeGreaterThan(0);
      if (expression !== undefined) expect(expression, "a guarded mark is a ternary on one item").toMatch(/^\s*(?:"[\w-]+"|[^?]+\?\s*"[\w-]+"\s*:\s*(?:undefined|"[\w-]+"))\s*$/);
      for (const anchor of named) counts.set(anchor, (counts.get(anchor) ?? 0) + 1);
    }
    const anchors = new Set([...SETTINGS_CARDS.map((card) => card.anchor), ...Object.keys(MERGED_CARD_ANCHORS)]);
    for (const anchor of counts.keys()) expect(anchors.has(anchor), `${anchor} is marked but is not a registered card`).toBe(true);
    for (const card of SETTINGS_CARDS) {
      if (ANCHORS_OWED[card.anchor]) continue;
      expect(counts.get(card.anchor) ?? 0, `${card.anchor} (${card.id}) must mark its own control once with data-setting-control="${card.anchor}"`).toBe(1);
    }
  });

  it("keeps a desktop card off a phone or browser door, and off an unanswered surface", () => {
    for (const desktop of [false, undefined]) {
      const visible = cardsForSurface(SETTINGS_CARDS, desktop);
      expect(visible.every((card) => card.surface === "any")).toBe(true);
      const pages = new Set(SECTION_PAGES.filter((entry) => !entry.desktopOnly).map((entry) => entry.id));
      expect(visible.every((card) => pages.has(card.section)), String(desktop)).toBe(true);
    }
  });
});

describe("search lists cards and rows", () => {
  it("sends record-browser searches to Open memory while keeping existing memory destinations", () => {
    const browser = cardForAnchor(SETTINGS_CARDS, "memory-browser-heading");
    expect(browser).toMatchObject({ id: "memory.browser", section: "memory", advanced: false });
    expect(cardLabel(browser!)).toBe(en["memorySettings.openMemory"]);
    for (const query of ["search records", "find a memory", "forget", "delete", "review", "waiting", "inspect", "filters", "important", "recent", "facts", "notes", "what it knows", "history", "smart search", "erase", "wipe", "remove", "conflicts", "paging"]) {
      const ids = searchSettingsCards(query, true).map(hit => hit.card.id);
      expect(ids, query).toContain("memory.browser");
      expect(ids, query).not.toContain("memory.overview");
    }
    expect(cardForAnchor(SETTINGS_CARDS, "memory-heading")?.id).toBe("memory.overview");
    expect(cardForAnchor(SETTINGS_CARDS, "memory-people-heading")?.id).toBe("memory.people");
    expect(cardForAnchor(SETTINGS_CARDS, "memory-import-heading")?.id).toBe("memory.import");
  });
  it("finds the browser and recorder in their regular Settings homes", () => {
    expect(searchSettingsCards("built-in browser", true)).toEqual(expect.arrayContaining([
      expect.objectContaining({ card: expect.objectContaining({ id: "companion.browser", anchor: "browser-settings-heading" }), page: "Computer & browser", advanced: false }),
    ]));
    expect(searchSettingsCards("teach a skill", true)).toEqual(expect.arrayContaining([
      expect.objectContaining({ card: expect.objectContaining({ id: "skills.recorder", anchor: "skill-recorder-heading" }), page: "Skills", advanced: false }),
    ]));
  });
  it("finds Show tool calls under Bots first for 'tool'", () => {
    const hits = searchSettingsCards("tool", true);
    expect(hits[0]).toMatchObject({ label: "Show tool calls in the conversation", page: "How every bot behaves" });
    // The Search card used to match "tool" through its page name, Tools. The page is now "Search, images and dictation" (1.0.19),
    // so "tool" lists exactly the tool calls card and the Connected apps card, and no longer the Search card.
    expect(hits.map((hit) => hit.card.id)).toEqual(["botDefaults.tool-calls", "connections.mcp"]);
  });
  it("keeps the Search card discoverable on its renamed page", () => {
    expect(searchSettingsCards("search", true)[0]).toMatchObject({ page: "Search, images and dictation", card: expect.objectContaining({ id: "webSearch.search" }) });
    expect(searchSettingsCards("dictation", true).map((hit) => hit.card.id)).toEqual(expect.arrayContaining(["webSearch.search"]));
  });

  it("never lists a desktop card's row on a phone, a browser door, or before the surface answers", () => {
    for (const desktop of [false, undefined]) {
      for (const query of ["tool", "key", "backup", "memory", "voice", "telegram"]) {
        const ids = searchSettingsCards(query, desktop).map((hit) => hit.card.id);
        for (const id of ids) expect(SETTINGS_CARDS.find((card) => card.id === id)!.surface, `${query} ${id}`).toBe("any");
      }
    }
    expect(searchSettingsCards("analytics", false).map((hit) => hit.card.id)).toEqual(["general.analytics"]);
  });

  it("marks what lives under Advanced, so the row can say so and the opener can open it", () => {
    const hit = searchSettingsCards("mcp", true).find((entry) => entry.card.id === "connections.mcp");
    expect(hit).toMatchObject({ advanced: true, page: "Connected apps" });
  });

  it("lands every card's own name on that card, and every old id on a page that has cards", () => {
    for (const card of cardsForSurface(SETTINGS_CARDS, true)) expect(searchSettingsCards(cardLabel(card), true).map((hit) => hit.card.id), card.id).toContain(card.id);
    for (const section of SETTINGS_SECTIONS) {
      const target = resolveSettingsSection(section.id);
      expect(SETTINGS_CARDS.some((card) => card.section === target.section), section.id).toBe(true);
    }
  });

  it("finds nothing for an empty query", () => {
    expect(searchSettingsCards("  ", true)).toEqual([]);
  });

  it("has labels for the sidebar", () => {
    for (const page of SECTION_PAGES) expect(en[`settings.page.${page.id}` as keyof typeof en], page.id).toBeTruthy();
  });
});
