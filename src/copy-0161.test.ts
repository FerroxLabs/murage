// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 0.1.61 What's new copy, held by its exact product strings as Sean
// approved it (whats-new-art-0161/preview.html): the hero, the highlights
// card's six tiles and the more card's twelve lines. A rewording anywhere
// fails here first, and none of it may break the house copy rules.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const dialog = source("./components/WhatsNewDialog.tsx");

const HERO = [
  "NEW IN MURAGE",
  ">Your team, in step.<",
  "Every bot in a room sees what its teammates said, on every engine. Images get saved looks and reference packs, and long work runs until it is done.",
  ">Open Teams<",
  ">Next<",
];

const HIGHLIGHTS = [
  "AND THERE'S MORE",
  ">Made for bigger work<",
  ">Click any card to try it<",
  ">Got it<",
];

// title, body, dot colour, in the approved order
const TILES: Array<[string, string, string]> = [
  ["Rooms that work as one", "Every bot in a room sees what its teammates said, and bots on Fuigo can ask and hand off to teammates again.", "--wn-accent"],
  ["Saved prompt blocks", "Save a character or a brand look as a named block, and every change keeps its own version.", "--wn-dot-gold"],
  ["Reference packs", "Keep up to 16 reference images as a named pack and use them again whenever you need them.", "--wn-dot-violet"],
  ["Any shape, any size", "Portrait, landscape or exact pixels, several at once, PNG, JPEG or WebP, a seed or a clear background, where the model allows.", "--wn-dot-blue"],
  ["Gemini for chat and images", "Add your Google Gemini key once and bots can chat on Gemini and make images with it.", "--wn-dot-mint"],
  ["Work runs to the end", "No fixed clocks: a working turn or a long command stops only when it goes quiet or you press Stop.", "--wn-ink"],
];

const MORE = [
  "AND A LOT MORE",
  ">Plus a long list of small wins<",
  "Your recovery key stays out of cloud-synced folders",
  "A one-time Move for a recovery key that already syncs",
  "Translations load when you pick them, so Murage opens faster",
  "The first 10 images in a message go through, with a note for the rest",
  "Withheld replies stay withheld, in memory and handoffs too",
  "Each teammate gets its turn right after its own reply",
  "Room replies stop only after 20 quiet minutes",
  "Long image renders are followed to the end",
  "See each image model's limits and when it last worked",
  "Every saved image-capable key shows in Image generation",
  "Slow models on MiniMax, xAI and OpenAI-compatible engines get time to answer",
  "Tool names match the engine each bot runs on",
  ">Let's go<",
  ">Read the full release notes<",
];

describe("0.1.61 What's new copy", () => {
  it("carries the approved hero, highlights and more card, word for word", () => {
    for (const line of [...HERO, ...HIGHLIGHTS, ...MORE]) expect(dialog, line).toContain(line);
  });

  it("carries the six tiles in the approved order, each with its dot colour", () => {
    let from = 0;
    for (const [title, body, dot] of TILES) {
      const at = dialog.indexOf(`title: "${title}"`, from);
      expect(at, title).toBeGreaterThan(from);
      const line = dialog.slice(dialog.lastIndexOf("\n", at), dialog.indexOf("\n", at));
      expect(line, title).toContain(`dot: "bg-[var(${dot})]"`);
      expect(line, title).toContain(`body: "${body}"`);
      from = at;
    }
  });

  it("drops the 0.1.60 copy", () => {
    for (const old of ["Your work, kept.", "Open Backups", "Built to be relied on", "Snooze conversations"]) expect(dialog).not.toContain(old);
  });

  it("follows the house copy rules", () => {
    const copy = [...HERO, ...HIGHLIGHTS, ...MORE, ...TILES.flatMap(([title, body]) => [title, body])].join(" ");
    expect(copy).not.toMatch(/[—–]/);
    expect(copy).not.toMatch(/\bsaf(e|ely|ety)\b/i);
    expect(copy).not.toMatch(/composio|price|pricing|cheap|\$\d/i);
  });
});
