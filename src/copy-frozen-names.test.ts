// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The video-safety rule (designs/UX-OVERHAUL-BUILD-PLAN.md section 6, from
// 1.0.12, blocking). The masterclass videos and slides are recorded against
// the session-1 build, so these names are frozen until Sean says otherwise:
//   levels  Ask, Auto, Full access, No limits
//   doors   Today, Chats, Routines, Needs you
//   bots    the Chief's name the owner set, every bot name in the library and
//           in first run (the mockup's Nova, Max, Ivy, Juno included)
// No lane, copy pass or plain-language fix renames, re-cases or adds words
// inside them ("Needs you" never becomes "Needs your attention"; "Full
// access" never becomes "Full"). A change needs Sean's written yes and a note
// to MurageSite; then change this file in the same commit.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSION_MODES } from "./components/PermissionModeMenu";
import { FROZEN_NAMES } from "./lib/glossary";

const LOCALES = fileURLToPath(new URL("./locales/", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function englishPack(): Record<string, string> {
  const pack = JSON.parse(readFileSync(join(LOCALES, "en.json"), "utf8")) as Record<string, string>;
  const fragments = join(LOCALES, "en-ux");
  for (const file of readdirSync(fragments).filter((name) => name.endsWith(".json")))
    Object.assign(pack, JSON.parse(readFileSync(join(fragments, file), "utf8")) as Record<string, string>);
  return pack;
}

/** Catalogue keys that ARE a frozen name, exactly. A lane that adds a door or
 * level key (for example L2A's Today and Chats doors) adds its row here. */
const FROZEN_KEYS: Record<string, string> = {
  "slik.levelAsk": "Ask",
  "slik.levelAuto": "Auto",
  "slik.levelFull": "Full access",
  "slik.levelNoLimits": "No limits",
  "browserExt.mode.full.name": "Full access",
  "browserExt.decision.fullPermissive": "Full access",
  "nav.routines": "Routines",
  "nav.needsYou": "Needs you",
  "memoryNeeds.title": "Needs you",
  "memoryNeeds.headingPrefix": "Needs you · {name} · ",
};

/** Names a short label may not grow: every door and the two multi-word levels.
 * "Ask" and "Auto" are left out on purpose: they are ordinary words that start
 * many real labels ("Ask before each image", "Auto inside work roots"); their
 * catalogue keys are pinned in FROZEN_KEYS and the composer chips are checked below. */
const EXTENDABLE = ["Full access", "No limits", "Needs you", "Today", "Chats", "Routines"];
/** A next word that starts a sentence about the name rather than a longer name ("Routines are running late", "Today at 9:00"). */
const CONTINUES = /^(?:is|are|was|were|will|can|could|may|might|need|needs|run|runs|ran|stay|stays|keep|keeps|at|on|in|for|from|with|and|or|to|by|of|now|still|so|then|this|that)$/i;
const isLabel = (value: string) => value.trim().split(/\s+/).length <= 5 && !/[.?!:]$/.test(value.trim());
/** The frozen name a short label adds words to ("Chats overview", "Full access unlocked"), if any. */
function extendedName(value: string): string | undefined {
  const text = value.trim();
  if (!isLabel(text)) return undefined;
  return EXTENDABLE.find((name) => {
    if (!text.startsWith(`${name} `)) return false;
    const next = text.slice(name.length + 1).split(/\s+/)[0] ?? "";
    return /^[A-Za-z]/.test(next) && !CONTINUES.test(next);
  });
}

/** The whole bot name pool (server/names.ts), in order. Renaming, dropping or re-casing one is a video change. */
const NAME_POOL = [
  "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi",
  "Biscuit", "Pepper", "Clover", "Willow", "Comet", "Orbit", "Echo",
  "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto",
  "Ivy", "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl",
  "Quill", "Rocket", "Sunny", "Tango", "Vega", "Waffle", "Ziggy", "Noodle",
  "Pickle", "Churro", "Panko", "Dumpling", "Pesto", "Olive", "Cocoa", "Taffy",
  "Bramble", "Fig", "Juniper", "Moss", "Pebble", "Rio", "Skye", "Tuli",
  "Ursa", "Yuki", "Zuko", "Momo", "Kiwi", "Plum", "Sprout", "Turnip",
];

/** Ways a frozen name gets bent. Any catalogue value containing one is held. */
const BENT = [/\bNeeds your attention\b/, /\bNeeds You\b/, /\bFull Access\b/, /\bNo Limits\b/, /\bAuto Mode\b/, /\bFull access mode\b/i, /\bNo-limits\b/i];

/** Reviewed exceptions, "key: why". Keep it tiny. */
const ALLOW: Record<string, string> = {
  "notificationSettings.attentionLabel": "names a kind of notification (the attention alert), not the Needs you door",
  "learningScreen.when.today": "the ordinary word in a 'when' column, not the Today door",
};

describe("frozen names (video-safety rule)", () => {
  const pack = englishPack();

  it("the catalogue keeps every frozen label exactly", () => {
    for (const [key, value] of Object.entries(FROZEN_KEYS)) expect(pack[key], key).toBe(value);
  });

  it("a renamed pinned label fails, whatever it is renamed to (self-check)", () => {
    const renamed: Record<string, string> = { ...pack, "browserExt.decision.fullPermissive": "Unrestricted", "memoryNeeds.headingPrefix": "Action required · {name} · " };
    const broken = Object.entries(FROZEN_KEYS).filter(([key, value]) => renamed[key] !== value).map(([key]) => key);
    expect(broken).toEqual(["browserExt.decision.fullPermissive", "memoryNeeds.headingPrefix"]);
  });

  it("the composer level chips are the four frozen level names, in order", () => {
    expect(PERMISSION_MODES.map((mode) => mode.chip)).toEqual(["Ask", "Auto", "Full access", "No limits"]);
    expect(PERMISSION_MODES.filter((mode) => mode.mode === "full" || mode.mode === "unlimited").map((mode) => mode.label)).toEqual(["Full access", "No limits"]);
  });

  it("no catalogue string re-cases a frozen name or bends it", () => {
    const names = [...FROZEN_NAMES.levels, ...FROZEN_NAMES.doors];
    const found = Object.entries(pack).filter(([key]) => !Object.hasOwn(ALLOW, key)).flatMap(([key, value]) => [
      ...names.filter((name) => value.trim().toLowerCase() === name.toLowerCase() && value.trim() !== name).map((name) => `${key}: "${value}" re-cases "${name}"`),
      ...BENT.filter((pattern) => pattern.test(value)).map((pattern) => `${key}: "${value}" bends a frozen name (${pattern})`),
      ...(extendedName(value) ? [`${key}: "${value}" adds words to "${extendedName(value)}"`] : []),
    ]);
    expect(found).toEqual([]);
  });

  it("every allowlisted key still exists, so the list cannot rot", () => {
    for (const key of Object.keys(ALLOW)) expect(Object.hasOwn(pack, key), key).toBe(true);
  });

  it("the bot name pool is unchanged, keeps the mockup's names, and Ember stays the first bot", async () => {
    const source = readFileSync(join(ROOT, "server/names.ts"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const pool = /const NAMES = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
    expect([...pool.matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual(NAME_POOL);
    for (const name of FROZEN_NAMES.bots.filter((bot) => bot !== "Ember")) expect(NAME_POOL, name).toContain(name);
    const { DEFAULT_BOT_NAME } = await import("../server/names");
    expect(DEFAULT_BOT_NAME).toBe("Ember");
  });

  it("the glossary names the frozen words and never gives one a replacement", async () => {
    const { GLOSSARY } = await import("./lib/glossary");
    const frozen = new Set([...FROZEN_NAMES.levels, ...FROZEN_NAMES.doors, ...FROZEN_NAMES.bots].map((name) => name.toLowerCase()));
    expect(GLOSSARY.filter((entry) => frozen.has(entry.term.toLowerCase()))).toEqual([]);
  });

  it("holds a bent name (self-check)", () => {
    expect(BENT.some((pattern) => pattern.test("Open Needs your attention"))).toBe(true);
    expect(BENT.some((pattern) => pattern.test("Switch to Full Access"))).toBe(true);
    expect(BENT.some((pattern) => pattern.test("Needs you"))).toBe(false);
    for (const [label, name] of [["Full access unlocked", "Full access"], ["No limits mode", "No limits"], ["Needs you list", "Needs you"],
      ["Chats overview", "Chats"], ["Routines dashboard", "Routines"], ["Today page", "Today"]] as const)
      expect(extendedName(label), label).toBe(name);
    for (const label of ["Needs you · {name} · ", "Ask before each image", "Auto inside work roots", "Routines are running late",
      "Today at {time}", "Chats", "Today", "Your routines are paused."])
      expect(extendedName(label), label).toBeUndefined();
  });
});
