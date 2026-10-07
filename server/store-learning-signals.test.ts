// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B1: the owner's own messages and a rewind reach the weak and edit signals
// through the Store, once, for the owner only, and only while the bot learns.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); database().exec("UPDATE memory_meta SET mode='active'"); });
const actions = () => (database().prepare("SELECT target_action FROM memory_feedback ORDER BY target_action").all() as { target_action: string }[]).map(row => row.target_action);
const draft = "Hi Dana, hope you are well. We would love to schedule a quick call this week to go over the proposal and next steps for your team.";

function setup() {
  const store = new Store(() => ({ instanceId: "fixture", model: "model" }));
  const bot = store.createBot({ name: "Dax" });
  return { store, bot };
}

it("a re-ask and an edited copy of the bot's draft are noticed from the owner's messages", () => {
  const { store, bot } = setup();
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "please send the Acme proposal to Dana today" });
  store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: draft });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "can you send the Acme proposal to Dana today please" });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Hi Dana, hope you are well. Can we talk this week about the proposal and next steps for your team?" });
  expect(actions()).toEqual(["edit:pasted-draft", "reask"]);
});
it("nothing is kept when the bot's learning is off, or for a routine's message", () => {
  const { store, bot } = setup();
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "please send the Acme proposal to Dana today", automation: { kind: "schedule" } });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "please send the Acme proposal to Dana today", automation: { kind: "schedule" } });
  expect(actions()).toEqual([]);
  (store.bot(bot.id) as any).learning = { enabled: false, askFirst: false, prospectLearning: false, revision: 1 };
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "please send the Acme proposal to Dana today" });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "can you send the Acme proposal to Dana today please" });
  expect(actions()).toEqual([]);
});
it("a rewind is a weak signal, once", () => {
  const { store, bot } = setup();
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello there" });
  store.patchTask(bot.id, bot.threadId, { rewound: true });
  store.patchTask(bot.id, bot.threadId, { rewound: true });
  expect(actions()).toEqual(["rewind"]);
});
