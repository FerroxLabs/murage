// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// G9 proof, the 15-task click test (designs/MURAGE-UX-BAR.md section 5: 3 clicks or 1 search). This file proves the
// "1 search" arm: every common task's control is the first result of one plain-words search. It claims nothing about
// click counts (a click model built from the index alone could not exceed 3, so it proved nothing; fix review H1).
// Each row is the task as the bar words it, the plain words a person types for it (naming the bot where the control is
// a bot's own), and the one control that must open. Written before the run; a miss is
// fixed in the index (the card's own vocabulary), never by loosening a row. Opus review r1: rows that accepted a second
// target which is not a true home (companion.browser for "my Chrome", Transcription for "voice") now name one target.
import { describe, expect, it } from "vitest";

import { searchSettingsIndex, type SettingsFindContext, type SettingsIndexHit } from "./settings-search";

const BOTS = [{ id: "b-nova", name: "Nova" }, { id: "b-rex", name: "Rex" }, { id: "b-ivy", name: "Ivy" }];
const APP: SettingsFindContext = { desktop: true, cloud: false, bots: BOTS };
const idOf = (hit: SettingsIndexHit) => (hit.bot ? `${hit.entry.id}@${hit.bot.name}` : hit.entry.id);

/** `opens`: the control the first result must be (two only where both are true homes: an OpenAI key goes in either). */
const TASKS: Array<{ task: string; q: string; opens: readonly string[] }> = [
  { task: "add an OpenAI key", q: "add openai key", opens: ["models.paste-keys", "models.providers"] },
  { task: "change a bot's engine", q: "rex engine", opens: ["bot.model.model@Rex"] },
  { task: "stop a bot asking permission", q: "stop asking me", opens: ["bot.permissions.level@Nova"] },
  { task: "connect Gmail", q: "connect gmail", opens: ["connections.apps"] },
  { task: "turn off notifications at night", q: "notifications at night", opens: ["general.notifications"] },
  { task: "pair a phone", q: "pair a phone", opens: ["companion.pairing"] },
  { task: "edit house rules", q: "edit house rules", opens: ["botDefaults.house-rules"] },
  { task: "set up the morning brief", q: "morning brief", opens: ["bot.routines.routines@Nova"] },
  { task: "add an MCP server", q: "add mcp server", opens: ["connections.mcp"] },
  { task: "let a bot use my Chrome", q: "use my chrome", opens: ["bot.access.browser@Nova"] },
  { task: "change voice", q: "change voice", opens: ["bot.voice.voice@Nova"] },
  { task: "back up", q: "back up", opens: ["backups.backups"] },
  { task: "see what I've spent", q: "what have I spent", opens: ["usage.by-bot"] },
  { task: "move from Grok Bot", q: "move from grok bot", opens: ["general.bring-your-ai"] },
  { task: "make a bot read a folder", q: "rex read a folder", opens: ["bot.access.folder@Rex"] },
];

describe("G9 15-task click test (MURAGE-UX-BAR section 5)", () => {
  it("lists the bar's 15 tasks, once each", () => {
    expect(TASKS).toHaveLength(15);
    expect(new Set(TASKS.map((row) => row.task)).size).toBe(15);
  });

  it("finds each task's control as the first result of one plain-words search (15 of 15)", () => {
    const misses = TASKS.flatMap(({ task, q, opens }) => {
      const first = searchSettingsIndex(q, APP).hits.map(idOf)[0];
      return first !== undefined && opens.includes(first) ? [] : [`${task} ("${q}"): wanted ${opens.join(" or ")}, got ${first ?? "nothing"}`];
    });
    // Printed on every run so the G9 click table in the review package can quote it.
    console.log(`G9 click table: ${15 - misses.length}/15 by one search${misses.length ? `\n${misses.join("\n")}` : ""}`);
    expect(misses, misses.join("\n")).toEqual([]);
  });
});

describe("G9 search keeps every card's own phrase (Opus review r1)", () => {
  // The bar's own example searches (section 3: "stop asking me", "night mode", "Gmail").
  it.each([
    ["stop asking me", "bot.permissions.level@Nova"],
    ["night mode", "general.appearance"],
    ["dark mode", "general.appearance"],
    ["gmail", "connections.apps"],
  ])("the bar's example %s opens %s", (q, first) => expect(searchSettingsIndex(q, APP).hits.map(idOf)[0]).toBe(first));

  // A query its words already find is ranked as typed: task words are dropped only when nothing matched.
  it.each([
    ["make a call", "connections.phone-calls"],
    ["messages from", "bot.permissions.can-talk@Nova"],
    ["add a skill", "bot.skills.skills@Nova"],
    ["use a browser tab", "companion.browser"],
  ])("%s still opens %s", (q, first) => expect(searchSettingsIndex(q, APP).hits.map(idOf)[0]).toBe(first));
});
