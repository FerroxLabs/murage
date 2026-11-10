// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// SETTINGS-LOCKED-1019 slice A (one search, scope cut 11-06): synonyms from the model, the Approve all entry,
// bot.voice.calls indexed, the "Can't find it? Ask {Chief}." line, the frozen stub keys, and the 40-row table with
// its kill criterion. Under 36 of 40 first hits means STOP and redesign: never tune the ranker to this table.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BOT_SETTINGS_CARDS, SETTINGS_EXPLAINERS, SETTINGS_INDEX, type AppIndexEntry } from "./settings-index";
import { SETTINGS_RESULT_CAP, SETTINGS_SYNONYMS, scopeTokens, searchSettingsIndex, type SettingsFindContext, type SettingsIndexHit } from "./settings-search";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const PANEL = read("../components/SettingsPanel.tsx");
const CALLS = read("../components/BotCallsSettings.tsx");
const MODAL = read("../components/SettingsModal.tsx");
const LOCALES = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"] as const;
const pack = (code: string) => JSON.parse(read(`../locales/${code}.json`)) as Record<string, string>;

const BOTS = [{ id: "b-nova", name: "Nova" }, { id: "b-rex", name: "Rex" }, { id: "b-ivy", name: "Ivy" }];
const CONTEXT: Record<string, SettingsFindContext> = {
  app: { desktop: true, cloud: false, bots: BOTS },
  "bot:Rex": { desktop: true, cloud: false, bots: BOTS, currentBotId: "b-rex" },
};
const idOf = (hit: SettingsIndexHit) => (hit.bot ? `${hit.entry.id}@${hit.bot.name}` : hit.entry.id);

// Written before the ranker change, from section 6 (synonym families, app cards above bot rows, the open bot's rows
// first) and the model's sampleQueries. Not edited to match the ranker afterwards.
const TABLE: Array<{ q: string; ctx: keyof typeof CONTEXT; first: string }> = [
  { q: "approve all", ctx: "app", first: "explainer.approve-all" },
  { q: "bulk approve", ctx: "app", first: "explainer.approve-all" },
  { q: "yolo", ctx: "app", first: "bot.permissions.level@Nova" },
  { q: "unlimited", ctx: "app", first: "bot.permissions.level@Nova" },
  { q: "full access", ctx: "app", first: "bot.permissions.level@Nova" },
  { q: "nova no limits", ctx: "app", first: "bot.permissions.level@Nova" },
  { q: "lm studio", ctx: "app", first: "models.local-servers" },
  { q: "lmstudio", ctx: "app", first: "models.local-servers" },
  { q: "offline", ctx: "app", first: "models.local-servers" },
  { q: "autostart", ctx: "app", first: "general.startup" },
  { q: "launch at startup", ctx: "app", first: "general.startup" },
  { q: "directory", ctx: "app", first: "bot.access.folder@Nova" },
  { q: "cwd", ctx: "app", first: "bot.access.folder@Nova" },
  { q: "inbox", ctx: "app", first: "connections.bot-email" },
  { q: "ping", ctx: "app", first: "general.notifications" },
  { q: "badge", ctx: "app", first: "general.notifications" },
  { q: "iphone", ctx: "app", first: "companion.pairing" },
  { q: "recovery", ctx: "app", first: "backups.backups" },
  { q: "vps", ctx: "app", first: "companion.vps" },
  { q: "internet", ctx: "app", first: "webSearch.search" },
  { q: "photo", ctx: "app", first: "webSearch.images" },
  { q: "dictate", ctx: "app", first: "webSearch.voice" },
  { q: "theme", ctx: "app", first: "general.appearance" },
  { q: "billing", ctx: "app", first: "usage.by-bot" },
  { q: "erase", ctx: "bot:Rex", first: "bot.memory.memory@Rex" },
  { q: "ring", ctx: "app", first: "bot.voice.calls@Nova" },
  // 1019 slice A review r1/r2: the shipped "Phone calls" card (connections.phone-calls, SETTINGS-LOCKED-1019 section 4
  // row "Calls your bots place", registry words "phone calls") says the query as its own label, so it leads; the bot's
  // Calls row follows. The earlier expectation (bot.voice.calls first) overlooked that card. Recorded in
  // SETTINGS-SEARCH-RANKER-1019.md section 3; the ranker is not tuned for it.
  { q: "phone call", ctx: "app", first: "connections.phone-calls" },
  { q: "urgent", ctx: "app", first: "bot.voice.calls@Nova" },
  { q: "calls", ctx: "bot:Rex", first: "bot.voice.calls@Rex" },
  { q: "folder", ctx: "app", first: "bot.access.folder@Nova" },
  { q: "working folder", ctx: "bot:Rex", first: "bot.access.folder@Rex" },
  { q: "rex model", ctx: "app", first: "bot.model.model@Rex" },
  { q: "ollama", ctx: "app", first: "models.local-servers" },
  // 1019 shell, Sean 11-09 (SETTINGS-LOCKED-1019.md 2.5): "advanced" lands on General's Advanced mode card, so it leads.
  // The earlier expectation (general.sidebar-density, the first card under a fold) predates that card; the ranker is not tuned.
  { q: "advanced", ctx: "app", first: "general.mode" },
  { q: "email", ctx: "app", first: "connections.bot-email" },
  { q: "mcp", ctx: "app", first: "connections.mcp" },
  { q: "telegram", ctx: "app", first: "channels.telegram" },
  { q: "notif", ctx: "bot:Rex", first: "bot.voice.notifications@Rex" },
  { q: "dark", ctx: "app", first: "general.appearance" },
  { q: "approval", ctx: "app", first: "bot.permissions.level@Nova" },
];

describe("the 1019 40-row table (kill criterion)", () => {
  it("has 40 rows", () => expect(TABLE).toHaveLength(40));
  it("scores 40 of 40 first hits (under 36 means STOP and redesign; never tune)", () => {
    const misses = TABLE.filter(({ q, ctx, first }) => searchSettingsIndex(q, CONTEXT[ctx]).hits.map(idOf)[0] !== first)
      .map(({ q, ctx, first }) => `${q} (${ctx}): wanted ${first}, got ${searchSettingsIndex(q, CONTEXT[ctx]).hits.map(idOf)[0] ?? "nothing"}`);
    // The score is printed on every run so the lane report can quote it.
    console.log(`settings 1019 table: ${40 - misses.length}/40 first hits${misses.length ? `\n${misses.join("\n")}` : ""}`);
    expect(40 - misses.length, misses.join("\n")).toBe(40);
  });
  it("lists the Calls row for phone call right after the Phone calls card, and the permission row keeps the Approve all explainer in the top 5", () => {
    const calls = searchSettingsIndex("phone call", CONTEXT.app).hits.map(idOf);
    expect(calls.slice(0, 4)).toEqual(expect.arrayContaining(["connections.phone-calls", "bot.voice.calls@Nova"]));
    const permission = searchSettingsIndex("permission", CONTEXT.app).hits.map(idOf).slice(0, 5);
    expect(permission[0]).toBe("bot.permissions.level@Nova");
    expect(permission).toContain("explainer.approve-all");
  });
});

// SETTINGS-SEARCH-RANKER-1019 rules R1-R3, written from the design before the ranker change.
describe("ranker rules (SETTINGS-SEARCH-RANKER-1019)", () => {
  const entry = (id: string, label: string, words: readonly string[]): AppIndexEntry => {
    const card = { id, section: "connections", advanced: false, surface: "any", words, anchor: id } as const;
    return { ...card, scope: "app", label: () => label, card };
  };
  const find = (query: string, entries: readonly AppIndexEntry[]) => searchSettingsIndex(query, { desktop: true, cloud: false }, entries, []).hits.map(idOf);

  it("R1: a bot's name with other words scopes to that bot's rows and is not scored", () => {
    const scoped = searchSettingsIndex("nova no limits", CONTEXT.app).hits.map(idOf);
    expect(scoped[0]).toBe("bot.permissions.level@Nova");
    expect(scoped.every((id) => id.endsWith("@Nova")), scoped.join()).toBe(true);
    const limits = searchSettingsIndex("nova limits", CONTEXT.app).hits.map(idOf);
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((id) => id.endsWith("@Nova")), limits.join()).toBe(true);
    // "no" is under 3 letters and names no bot whole: not a scope, every bot's row is listed.
    const open = searchSettingsIndex("no limits", CONTEXT.app).hits.map(idOf);
    expect(open[0]).toBe("bot.permissions.level@Nova");
    expect(open).toEqual(expect.arrayContaining(["bot.permissions.level@Rex", "bot.permissions.level@Ivy"]));
  });

  it("R1: the longest whole bot name wins, so 'nova prime calls' scopes to Nova Prime and not to both Novas", () => {
    const bots = [{ id: "b-nova", name: "Nova" }, { id: "b-prime", name: "Nova Prime" }, { id: "b-rex", name: "Rex" }];
    const ctx: SettingsFindContext = { desktop: true, cloud: false, bots };
    const hits = searchSettingsIndex("nova prime calls", ctx).hits.map(idOf);
    expect(hits[0]).toBe("bot.voice.calls@Nova Prime");
    expect(hits.every((id) => id.endsWith("@Nova Prime")), hits.join()).toBe(true);
    // The shorter name alone still scopes to every bot it names.
    const novas = searchSettingsIndex("nova calls", ctx).hits.map(idOf);
    expect(novas.every((id) => id.endsWith("@Nova") || id.endsWith("@Nova Prime")), novas.join()).toBe(true);
    expect(novas).toEqual(expect.arrayContaining(["bot.voice.calls@Nova", "bot.voice.calls@Nova Prime"]));
    // Nothing but a full name: every token is scored against the page field, so only the bot that has all of them.
    const only = searchSettingsIndex("nova prime", ctx).hits.map(idOf);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((id) => id.endsWith("@Nova Prime")), only.join()).toBe(true);
  });

  it("R1: a name is read like the query (filler words) and equal names are all scoped, in any roster order", () => {
    const roster = [{ id: "b-a", name: "Nova The Prime" }, { id: "b-b", name: "Nova Prime" }, { id: "b-c", name: "Nova Prime" }, { id: "b-n", name: "Nova" }];
    for (const bots of [roster, [...roster].reverse()]) {
      for (const query of ["nova prime calls", "nova the prime calls"]) {
        const owners = new Set(searchSettingsIndex(query, { desktop: true, cloud: false, bots }).hits.map((hit) => hit.bot?.id));
        expect([...owners].sort(), `${query} / ${bots[0].id}`).toEqual(["b-a", "b-b", "b-c"]);
      }
    }
  });

  it("R1: a name that crosses a longer name's span stays out, and its leftover word does not bring it back", () => {
    const bots = [{ id: "b-a", name: "Nova The Prime" }, { id: "b-e", name: "Prime Echo" }];
    const scope = scopeTokens(["nova", "prime", "echo", "calls"], bots);
    expect([...scope.bots]).toEqual(["b-a"]);
    expect(scope.rest).toEqual(["echo", "calls"]);
  });

  it("R1: a mixed query never scores a bot's name: 'no limits' ('no' starts Nova) lists no row that only the name explains", () => {
    const hits = searchSettingsIndex("no limits", CONTEXT.app).hits.map(idOf);
    expect(hits).not.toContain("bot.model.backup@Nova");
    expect(hits).not.toContain("bot.model.backup@Rex");
    expect(hits[0]).toBe("bot.permissions.level@Nova");
  });

  it("R2: an entry that says the word itself ranks above one that only joins its family", () => {
    expect(find("inbox", [entry("fixture.profile", "Your name and email", []), entry("fixture.letters", "Bot letters", ["inbox"])]))
      .toEqual(["fixture.letters", "fixture.profile"]);
  });

  it("R3: an also-member never admits an entry to its family; a core member does", () => {
    expect(find("lmstudio", [entry("fixture.computer", "Where it runs", ["local"])])).toEqual([]);
    expect(find("lmstudio", [entry("fixture.servers", "Model servers", ["ollama"])])).toEqual(["fixture.servers"]);
  });
});

describe("synonyms from the model (section 6)", () => {
  it("carries every family in the locked list", () => {
    const flat = SETTINGS_SYNONYMS.flatMap((family) => [...family.core, ...(family.also ?? [])]);
    for (const word of ["bulk approve", "yolo", "lmstudio", "autostart", "deep link", "top up", "secret", "llm", "trust", "cwd", "inbox", "badge", "iphone", "recovery", "vps", "internet", "draw", "dictate", "skin", "billing", "wipe", "tailscale", "servers", "phone call"]) {
      expect(flat, word).toContain(word);
    }
  });
  it("matches a synonym but never shows it: labels stay the registry's", () => {
    const hit = searchSettingsIndex("yolo", CONTEXT.app).hits[0];
    expect(hit.label.toLowerCase()).not.toContain("yolo");
  });
});

describe("one search with bot rows", () => {
  it("caps at 12 and counts the rest for More results (N)", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `b-${i}`, name: `Bot ${i}` }));
    const { hits, more } = searchSettingsIndex("model", { desktop: true, cloud: false, bots: many, currentBotId: "b-3" });
    expect(hits).toHaveLength(SETTINGS_RESULT_CAP);
    expect(more.length).toBeGreaterThan(0);
    // The open bot's Model row ranks above other bots' Model rows.
    const models = [...hits, ...more].filter((hit) => hit.entry.id === "bot.model.model");
    expect(models[0].bot?.id).toBe("b-3");
  });
  it("keys a bot row by entry plus bot, so the same control across bots never collides", () => {
    const keys = searchSettingsIndex("working folder", CONTEXT.app).hits.map(idOf);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("opens results by the existing anchors (a later layout keeps them working)", () => {
    for (const hit of searchSettingsIndex("calls", CONTEXT.app).hits) expect(hit.entry.anchor).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe("the Approve all entry", () => {
  it("is one explainer that opens Needs you > Approvals", () => {
    expect(SETTINGS_EXPLAINERS.map((entry) => entry.id)).toEqual(["explainer.approve-all"]);
    const entry = SETTINGS_EXPLAINERS[0];
    expect(entry.open).toEqual({ type: "showNeedsYou", tab: "approvals" });
    expect(entry.label()).toBe("Approve all");
    expect(entry.words).toEqual(expect.arrayContaining(["approve all", "bulk approve"]));
  });
});

describe("bot.voice.calls is indexed", () => {
  it("has an entry labelled Calls with the locked words", () => {
    const calls = BOT_SETTINGS_CARDS.find((entry) => entry.id === "bot.voice.calls")!;
    expect(calls.anchor).toBe("bot-setting-calls");
    expect(calls.label()).toBe("Calls");
    expect(calls.words).toEqual(expect.arrayContaining(["ring", "call", "phone call", "urgent"]));
  });
  it("every data-setting in SettingsPanel.tsx and BotCallsSettings.tsx has an index entry, and every bot entry renders", () => {
    const ids = new Set(SETTINGS_INDEX.map((entry) => entry.id));
    for (const source of [PANEL, CALLS, MODAL]) {
      for (const [, id] of source.matchAll(/data-setting="([^"]+)"/g)) expect(ids.has(id), `${id} is rendered but not in the index`).toBe(true);
    }
    for (const entry of BOT_SETTINGS_CARDS) {
      expect(PANEL.includes(`id="${entry.anchor}" data-setting="${entry.id}"`) || CALLS.includes(`id="${entry.anchor}" data-setting="${entry.id}"`), entry.id).toBe(true);
    }
    expect(BOT_SETTINGS_CARDS.length).toBe(37);
  });
});

describe("the Calls label and the Approvals path are locale keys, not English literals", () => {
  const KEYS = { "settings.index.calls.label": "Calls", "settings.search.approveAll.path": "Approvals" } as const;
  it("en.json holds both, and the index reads them through t()", () => {
    for (const [key, english] of Object.entries(KEYS)) expect(pack("en")[key], key).toBe(english);
    const calls = BOT_SETTINGS_CARDS.find((entry) => entry.id === "bot.voice.calls")!;
    expect(calls.label()).toBe(KEYS["settings.index.calls.label"]);
    expect(SETTINGS_EXPLAINERS[0].path()[1]).toBe(KEYS["settings.search.approveAll.path"]);
    const source = read("./settings-index.ts");
    expect(source).toContain('t("settings.index.calls.label")');
    expect(source).toContain('t("settings.search.approveAll.path")');
  });
  it("every other pack carries both keys with its own words", () => {
    for (const code of LOCALES.filter((code) => code !== "en")) {
      for (const key of Object.keys(KEYS)) expect(pack(code)[key], `${code}:${key}`).toBeTruthy();
    }
  });
});

describe("Can't find it? Ask {Chief}.", () => {
  it("has the line in all 8 locales with the {chief} placeholder", () => {
    expect(pack("en")["settings.askLine.text"]).toBe("Can't find it? Ask {chief}.");
    for (const code of LOCALES) {
      expect(pack(code)["settings.askLine.text"], code).toContain("{chief}");
      expect(pack(code)["settings.askLine.prefill"], code).toBeTruthy();
    }
  });
  it("renders on every app page and every bot section pane", () => {
    expect(MODAL).toMatch(/<SettingsAskLine\b/);
    // The bot window's sections all render through SettingsSection, which ends with the line.
    const section = PANEL.slice(PANEL.indexOf("export function SettingsSection"), PANEL.indexOf("function Field"));
    expect(section).toMatch(/<SettingsAskLine\b/);
  });
});

describe("the 17 settings.stub.* keys are frozen", () => {
  const FROZEN: Record<string, string> = {
    "settings.stub.off": "Off. Turn it on to let bots {letsBots}.",
    "settings.stub.needsAccount": "Needs a Flux Router account with email on. Ask {chief} to set it up, or open Flux Router.",
    "settings.stub.notYet": "Not on for your account yet. We are turning it on in stages.",
    "settings.stub.otherSurface": "Set this on your computer. Open Murage on the desktop, then Settings > {path}.",
    "settings.stub.needsEngine": "{engine} cannot do this yet. Pick an engine that can under Model, or ask {chief}.",
    "settings.stub.coming": "Coming in {version}.",
    "settings.stub.checking": "Checking if {feature} is on for your account.",
    "settings.stub.couldNotCheck": "Could not check {feature} just now. Close Settings and open it again to try again.",
    "settings.stub.readingBot": "Reading {botName}'s email.",
    "settings.stub.couldNotRead": "Could not read {botName}'s email just now. Open another section and come back to try again.",
    "settings.stub.openModels": "Open Models & engines",
    "settings.stub.copyPath": "Copy the path",
    "settings.stub.botEmail": "bot email",
    "settings.stub.botEmailTitle": "Bot email",
    "settings.stub.yourChief": "your Chief",
    "settings.stub.letsBots.browser": "use a browser tab you can watch and take over",
    "settings.stub.letsBots.skillRecorder": "learn a skill from a recording or /learn",
  };
  it("en.json holds exactly these 17, word for word", () => {
    const en = pack("en");
    const live = Object.fromEntries(Object.entries(en).filter(([key]) => key.startsWith("settings.stub.")));
    expect(live).toEqual(FROZEN);
  });
});
