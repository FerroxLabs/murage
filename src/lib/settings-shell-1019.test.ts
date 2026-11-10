// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.19 slice B, the shell: 13 sidebar pages plus the Messaging tab under six
// headings, Simple and Advanced, bots under You, the one Copy link, the page mount contract. Pure rules and source
// facts; the rendered parts are in components/settings/settings-shell.dom.test.ts and e2e/settings-shell.human.spec.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import en from "@/locales/en.json";
import lazyEn from "@/locales/en-settings/settings.json";
import { BROWSE_BOTS_ROUTE, SECTION_ALIASES, SECTION_PAGES, SETTINGS_PAGE_GROUPS, isSimpleTarget, resolveSettingsSection, settingsPageGroup, simplePages } from "./settings-pages";
import { SETTINGS_SECTIONS, normalizeSettingsSection, sectionsForSurface } from "./settings-sections";
import { SETTINGS_FOLD_SEEN_KEY, SETTINGS_MODE_KEY, noteAdvancedFoldOpened, resetSettingsModeForTest, setSettingsMode, settingsMode, subscribeSettingsMode } from "./settings-mode";
import { pageCardProblems, visibleCards, type SettingsPageCard } from "./settings-page-contract";
import { SIDEBAR_BOT_ROWS, browsableBots, sidebarBots } from "./settings-shell-bots";
import { settingsPageLink } from "./settings-link";
import { parseSettingsAddress } from "./settings-address";
import { SETTINGS_CARDS } from "./settings-card-registry";
import { settingsCardProblems } from "./settings-cards";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const words = { ...en, ...lazyEn } as Record<string, string>;

describe("the 13 sidebar pages and Messaging tab", () => {
  it("keeps the page order with Messaging inside Apps, Each bot having rows and no page", () => {
    expect(SETTINGS_PAGE_GROUPS).toEqual(["you", "bots", "allBots", "ai", "reach", "app"]);
    expect(SECTION_PAGES.map((page) => `${page.group}:${page.id}`)).toEqual([
      "you:general", "you:calls",
      "allBots:botDefaults", "allBots:skills", "allBots:memory",
      "ai:models", "ai:webSearch",
      "reach:connections", "reach:computer", "reach:companion",
      "app:backups", "app:usage", "app:about",
    ]);
    expect(SECTION_PAGES).toHaveLength(13);
    expect(SECTION_PAGES.some((page) => page.group === "bots")).toBe(false);
    expect(settingsPageGroup("computer")).toBe("reach");
  });

  it("name their headings and pages in plain words", () => {
    const label = (key: string) => words[key];
    expect(SETTINGS_PAGE_GROUPS.map((group) => label(`settings.group.${group}`))).toEqual(["You", "Each bot", "All bots", "Models and tools", "Connections", "App"]);
    expect(SECTION_PAGES.map((page) => label(`settings.page.${page.id}`))).toEqual([
      "General", "Calls", "How every bot behaves", "Skills", "Memory", "Models & engines", "Search, images and dictation",
      "Connected apps", "Computer & browser", "Phone and other devices", "Backups", "Usage", "About & help",
    ]);
    for (const group of SETTINGS_PAGE_GROUPS) expect(label(`settings.groupNote.${group}`), group).toBeTruthy();
    for (const page of SECTION_PAGES) expect(label(`settings.pageNote.${page.id}`), page.id).toBeTruthy();
    expect(label("settings.page.browseBots")).toBe("Browse bots");
  });

  it("keep every older id landing: pages are pages, the rest are aliases, Browse bots is a route", () => {
    const pages = new Set(SECTION_PAGES.map((page) => page.id));
    for (const { id } of SETTINGS_SECTIONS) {
      if (id === BROWSE_BOTS_ROUTE) continue;
      expect(pages.has(resolveSettingsSection(id).section), id).toBe(true);
    }
    expect(Object.keys(SECTION_ALIASES).sort()).toEqual(["aboutMe", "channels", "engines", "experimental", "houseRules", "images", "storage", "voice"]);
    expect(resolveSettingsSection("computer")).toEqual({ section: "computer", anchor: null });
    expect(resolveSettingsSection("calls")).toEqual({ section: "calls", anchor: null });
    expect(resolveSettingsSection("images")).toEqual({ section: "webSearch", anchor: "image-settings-heading" });
    expect(normalizeSettingsSection(BROWSE_BOTS_ROUTE)).toBe(BROWSE_BOTS_ROUTE);
    expect(SETTINGS_SECTIONS.map((entry) => entry.id)).toContain(BROWSE_BOTS_ROUTE);
  });

  it("shows the Simple pages, including Browser access and phone pairing in their canonical homes", () => {
    expect(simplePages()).toEqual(["general", "models", "connections", "computer", "companion", "backups", "usage", "about"]);
    expect(isSimpleTarget("computer")).toBe(true);
    expect(isSimpleTarget("companion")).toBe(true);
    expect(isSimpleTarget("general")).toBe(true);
    expect(isSimpleTarget("memory")).toBe(false);
    expect(isSimpleTarget("houseRules")).toBe(false); // an alias lands on botDefaults
    expect(isSimpleTarget("aboutMe")).toBe(true); // an alias lands on General
    expect(isSimpleTarget(BROWSE_BOTS_ROUTE)).toBe(true);
  });

  it("admits Apps on a phone while Browse bots, calls and computer stay desktop-only", () => {
    const phone = sectionsForSurface(SECTION_PAGES, false).map((page) => page.id);
    expect(phone).toEqual(["general", "connections", "usage", "about"]);
    expect(SETTINGS_SECTIONS.find((entry) => entry.id === BROWSE_BOTS_ROUTE)?.desktopOnly).toBe(true);
  });
});

describe("Advanced mode", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    resetSettingsModeForTest();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
  });
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; resetSettingsModeForTest(); });

  it("starts Simple on a new install", () => {
    expect(settingsMode()).toBe("simple");
  });

  it("starts Advanced for an upgrader who had opened an old fold, and keeps the choice made after", () => {
    noteAdvancedFoldOpened();
    expect(store.get(SETTINGS_FOLD_SEEN_KEY)).toBe("1");
    expect(settingsMode()).toBe("simple"); // opening a fold never flips the mode now showing
    resetSettingsModeForTest(); // the next start reads the note
    expect(settingsMode()).toBe("advanced");
    setSettingsMode("simple");
    expect(settingsMode()).toBe("simple");
    resetSettingsModeForTest();
    expect(settingsMode()).toBe("simple"); // read back from the store, not the fold note
    expect(store.get(SETTINGS_MODE_KEY)).toBe("simple");
  });

  it("tells a listener once per change, and nothing when the mode is already that", () => {
    let calls = 0;
    const stop = subscribeSettingsMode(() => { calls += 1; });
    setSettingsMode("advanced");
    setSettingsMode("advanced");
    expect(calls).toBe(1);
    setSettingsMode("simple");
    expect(calls).toBe(2);
    stop();
    setSettingsMode("advanced");
    expect(calls).toBe(2);
  });

  it("lasts for the session when storage is refused", () => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    resetSettingsModeForTest();
    expect(settingsMode()).toBe("simple");
    setSettingsMode("advanced");
    expect(settingsMode()).toBe("advanced");
  });
});

describe("the page contract", () => {
  const card = (id: string, simple: boolean): SettingsPageCard => ({ id, anchor: `${id}-heading`, simple, render: () => null });
  it("shows Simple the cards marked simple, counts what it left out, and Advanced shows all", () => {
    const cards = [card("a", true), card("b", false), card("c", true), card("d", false)];
    expect(visibleCards(cards, "simple")).toMatchObject({ hidden: 2, shown: [{ id: "a" }, { id: "c" }] });
    expect(visibleCards(cards, "advanced")).toMatchObject({ hidden: 0 });
    expect(visibleCards(cards, "advanced").shown).toHaveLength(4);
  });

  it("checks a page's card list against the registry: id, page, anchor, nothing missing, Simple only on a Simple page", () => {
    const registry = SETTINGS_CARDS.filter((entry) => entry.section === "usage");
    const ok = registry.map((entry, index) => ({ id: entry.id, anchor: entry.anchor, simple: index === 0, render: () => null }));
    expect(pageCardProblems("usage", ok, SETTINGS_CARDS)).toEqual([]);
    expect(pageCardProblems("usage", ok.slice(1), SETTINGS_CARDS).join("|")).toMatch(/usage\.by-bot is registered on usage and the page does not list it/);
    expect(pageCardProblems("usage", ok.map((each) => ({ ...each, simple: false })), SETTINGS_CARDS).join("|")).toMatch(/Simple page and lists no Simple card/);
    expect(pageCardProblems("memory", [{ ...ok[0], simple: true }], SETTINGS_CARDS).join("|")).toMatch(/not a Simple page/);
    expect(pageCardProblems("usage", [{ ...ok[0], anchor: "wrong" }, ...ok.slice(1)], SETTINGS_CARDS).join("|")).toMatch(/renders anchor wrong/);
  });

  it("keeps the registry consistent after the cards moved: ids kept, computer cards on their own page, the mode card first", () => {
    expect(settingsCardProblems(SETTINGS_CARDS)).toEqual([]);
    const on = (page: string) => SETTINGS_CARDS.filter((entry) => entry.section === page).map((entry) => entry.id);
    expect(on("computer")).toEqual(["companion.browser", "companion.script-access", "companion.vps", "companion.computer"]);
    expect(on("companion")).toEqual(["companion.pairing"]);
    expect(on("calls")).toEqual(["calls.calls"]);
    expect(on("general")[0]).toBe("general.mode");
    expect(SETTINGS_CARDS.find((entry) => entry.id === "general.mode")).toMatchObject({ anchor: "advanced-mode-heading", surface: "any" });
    for (const page of SECTION_PAGES) expect(on(page.id).length, page.id).toBeGreaterThan(0);
  });

  it("lists page loaders one per line, alphabetical, none yet, so builders never touch the same line", () => {
    const source = read("../components/settings/page-registry.tsx");
    expect(source).toContain("export const SETTINGS_PAGE_LOADERS");
    expect(source).toContain("export function SettingsPageMount");
    expect(source).toContain("export const hasPageFile");
  });
});

describe("Each bot", () => {
  const bot = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, ...extra });
  const chief = (id: string, name: string) => bot(id, name, { chiefOfStaff: true, chiefScope: "workspace" as const });

  it("lists up to five bots, the Chief first and then by name", () => {
    const bots = [bot("e", "Ember"), bot("p", "Pepper"), chief("n", "Nova"), bot("sa", "Sable"), bot("sl", "Sloane")];
    const { rows, total, browse } = sidebarBots(bots);
    expect(rows.map((each) => each.name)).toEqual(["Nova", "Ember", "Pepper", "Sable", "Sloane"]);
    expect([total, browse]).toEqual([5, false]);
    expect(SIDEBAR_BOT_ROWS).toBe(5);
  });

  it("shows Browse bots (N) past five, with the open bot always among the five", () => {
    const bots = [chief("n", "Nova"), bot("a", "Ada"), bot("b", "Bea"), bot("c", "Cleo"), bot("d", "Dina"), bot("z", "Zed"), bot("y", "Yan")];
    expect(sidebarBots(bots)).toMatchObject({ total: 7, browse: true });
    expect(sidebarBots(bots).rows.map((each) => each.name)).toEqual(["Nova", "Ada", "Bea", "Cleo", "Dina"]);
    const open = sidebarBots(bots, "z").rows;
    expect(open).toHaveLength(5);
    expect(open.map((each) => each.id)).toContain("z");
    expect(open[0].name).toBe("Nova");
  });

  it("leaves archived bots out, except the one the window is showing", () => {
    const bots = [chief("n", "Nova"), bot("o", "Old", { hidden: true }), bot("a", "Ada")];
    expect(browsableBots(bots).map((each) => each.id)).toEqual(["n", "a"]);
    expect(browsableBots(bots, "o").map((each) => each.id)).toEqual(["n", "a", "o"]);
    expect(sidebarBots([], null)).toEqual({ rows: [], total: 0, browse: false });
  });
});

describe("Copy link", () => {
  it("copies the page's address, or the card's own address when you arrived on one", () => {
    expect(settingsPageLink("memory")).toBe("murage://settings/app/memory");
    expect(settingsPageLink(BROWSE_BOTS_ROUTE)).toBe("murage://settings/app/browseBots");
    expect(settingsPageLink("computer", "companion.vps")).toBe("murage://settings/app/companion/vps");
    expect(settingsPageLink("general", "general.mode")).toBe("murage://settings/app/general/mode");
  });

  it("makes an address the opener reads back", () => {
    for (const link of [settingsPageLink("calls"), settingsPageLink("general", "general.mode"), settingsPageLink(BROWSE_BOTS_ROUTE)]) {
      const parsed = parseSettingsAddress(link);
      expect(parsed, link).not.toBeNull();
    }
    expect(parseSettingsAddress(settingsPageLink("computer"))).toEqual({ scope: "app", section: "computer", name: null });
  });
});

describe("the shell in the modal", () => {
  const modal = read("../components/SettingsModal.tsx");
  it("mounts the page registry, the breadcrumb, Browse bots and the mode card, and keeps a block for every page", () => {
    for (const piece of ["SettingsPageMount", "SettingsBreadcrumb", "BrowseBotsPage", "AdvancedModeCard", "useSettingsMode", "sidebarBots"]) expect(modal, piece).toContain(piece);
    // A page with a file of its own has no legacy block left (settings/page-registry.tsx lists it).
    const loaded = read("../components/settings/page-registry.tsx");
    for (const page of SECTION_PAGES) if (!new RegExp(`^  ${page.id}: \\(\\) => import`, "m").test(loaded)) expect(modal, page.id).toContain(`section === "${page.id}"`);
  });

  it("puts the mode card first on General and takes calls out of Notifications", () => {
    const general = modal.slice(modal.indexOf('{section === "general" && ('));
    expect(general.indexOf("<AdvancedModeCard />")).toBeGreaterThan(-1);
    expect(general.indexOf("<AdvancedModeCard />")).toBeLessThan(general.indexOf('id="profile-heading"'));
    expect(modal).not.toContain("<NotificationSettings /><CallsSettings />");
  });

  it("turns Advanced on for a request that lands on a page Simple does not list", () => {
    expect(modal).toContain('setSettingsMode("advanced")');
    expect(modal).toContain("isSimpleTarget(requested)");
  });

  it("notes a fold's first opening for the upgrader default", () => {
    expect(modal).toContain("noteAdvancedFoldOpened()");
  });
});

describe("the shell's words", () => {
  it("live in the lazy Settings pack, read through sw, never in en.json", () => {
    const keys = Object.keys(lazyEn);
    for (const key of ["settings.mode.title", "settings.mode.note", "settings.mode.moreHidden", "settings.mode.setInAdvanced", "settings.mode.footer", "settings.mode.footerChange", "settings.crumb.root", "settings.crumb.aria", "settings.crumb.copy", "settings.crumb.copied", "settings.crumb.copyFailed", "settings.browse.filter", "settings.browse.open", "settings.browse.openBot", "settings.browse.none", "settings.browse.noBots", "settings.browse.toggle"]) {
      expect(keys, key).toContain(key);
      expect(Object.hasOwn(en, key), key).toBe(false);
    }
  });

  it("say Advanced mode the way the lock does, with no em dash", () => {
    const w = words;
    expect(w["settings.mode.title"]).toBe("Advanced mode");
    expect(w["settings.mode.note"]).toBe("Show every setting, including the detailed ones for each bot, your apps and the AI behind your bots. Turn it off for a simpler view. Nothing is deleted either way.");
    expect(w["settings.mode.setInAdvanced"]).toBe("Set in Advanced");
    expect(w["settings.mode.footer"]).toBe("Advanced mode is on");
    expect(w["settings.crumb.copy"]).toBe("Copy link to this page");
    expect(w["settings.crumb.copyFailed"]).toBe("Could not copy. Select the address instead.");
    for (const [key, value] of Object.entries(words).filter(([key]) => /^settings\.(mode|crumb|browse)\./.test(key))) expect(value, key).not.toMatch(/[—–]/);
  });
});
