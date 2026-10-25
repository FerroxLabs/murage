// SPDX-License-Identifier: AGPL-3.0-or-later
// T11 exercises the real partition resolver and live team identities in an isolated test store.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { venueBlock, VENUE_UNAVAILABLE_LINE } from "./venue-awareness.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Ember", section: "Ops" });
  const a = teamIdFor("Team A"), b = teamIdFor("Team B");
  bot.partitionedAt = 1;
  bot.sharedWith = { mode: "list", teams: [{ id: a, name: "Team A" }, { id: b, name: "Team B" }] };
  store.createGroup("A venue", [bot.id], false, "Team A");
  store.createGroup("B venue", [bot.id], false, "Team B");
  store.createGroup("Home venue", [bot.id], false, "Ops");
  const task = store.createSharedWorkTask(bot.id, a)!;
  const build = (currentThreadId: string) => venueBlock(database(), { botId: bot.id, currentThreadId, bots: store.bots, groups: store.groups, toolMounted: false });
  return { bot, task, a, build };
}

it("T11: team A's thread lists team A's venues only, under its current team label", () => {
  const { bot, task, a, build } = fixture();
  const text = build(task.threadId);
  expect(text).toContain(`"A venue"`);
  expect(text).not.toContain("B venue");
  expect(text).not.toContain("Home venue");
  expect(text).toContain("Your team: Team A");
  // the home thread: home venues and the bot's own section
  const home = build(bot.threadId);
  expect(home).toContain(`"Home venue"`);
  expect(home).not.toMatch(/A venue|B venue/);
  expect(home).toContain("Your team: Ops");
  database().prepare("UPDATE team_identities SET label='Renamed A' WHERE team_id=?").run(a);
  expect(build(task.threadId)).toContain("Your team: Renamed A");
});

it("T11: a quarantined or unknown thread gets the unavailable line", () => {
  const { task, build } = fixture();
  expect(build(task.threadId)).toContain('"A venue"');
  task.sharedWork!.quarantined = true;
  expect(build(task.threadId)).toBe(VENUE_UNAVAILABLE_LINE);
  expect(build("unknown-thread")).toBe(VENUE_UNAVAILABLE_LINE);
});
