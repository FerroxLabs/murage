// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 1.0.2 What's new copy, held by its exact strings as Sean approves it
// (whats-new-art-0102/preview.html). A rewording fails here first, and none of
// it may break the house copy rules. The 0.1.61 twin is copy-0161.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialog = readFileSync(new URL("./components/WhatsNewDialog.tsx", import.meta.url), "utf8");

const LINES = [
  "Bots that remember what matters",
  "Your bots now check with you before they keep something about you. Keep it, edit it or let it go from one Needs you list.",
  "Open Memory",
  "Ask the room, the right bot answers",
  "In a group chat, Murage picks the bot best placed to reply, in about a second.",
  "Six teams, ready to hire",
  "Dev Shop, Marketing Agency, SEO Content Engine Room, Rival Watch, Follow-Up Desk and Community Lead Finder, each with a lead, a workflow and a first routine.",
  "Any model, any bot",
  "Move a bot between Claude, GPT, Grok and Gemini. It keeps working and tells you what it can do there.",
  "Your bot, right in Chrome",
  "Work beside your bot in Chrome, with its own name and colour and the same access levels you use in the app.",
  "Long chats stay quick",
  "Memory answers in about a tenth of a second, even on a long history, and takes a fraction of the disk.",
  "Up to eight desktops per bot",
  "Give a busy bot several local desktops of its own and let it work on them side by side.",
];

describe("1.0.2 What's new copy", () => {
  it("carries the hero and six tiles word for word", () => {
    for (const line of LINES) expect(dialog, line).toContain(line);
  });
  it("states speed only as the changelog's tenth of a second and adds no other number", () => {
    expect(dialog).not.toMatch(/\bmilliseconds?\b|\d+x faster/i);
  });
});
