// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K K1 (138): a chat with no model of its own follows its bot's model.
// Each test names the owner's failure it prevents.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const ONE = { instanceId: "engine-one", model: "one", connectionId: "account-one" };
const TWO = { instanceId: "engine-two", model: "two", connectionId: "account-two" };
const MINE = { instanceId: "engine-three", model: "three" };
const MARKER = join(DATA_DIR, ".threads-follow-model-v1");

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const fresh = () => new Store(() => structuredClone(ONE));
const disk = () => JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
const writeBots = (rows: unknown) => writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(rows));

it("a new chat is born following its bot: changing the bot's model moves it (I change my bot's model and my chats use it)", () => {
  const store = fresh(), bot = store.createBot();
  const second = store.createTask(bot.id, "second")!;
  expect(store.taskByThread(bot.id, bot.threadId)?.modelSelection).toBeUndefined();
  expect(second.modelSelection).toBeUndefined();
  store.patchBot(bot.id, { modelSelection: structuredClone(TWO) }, { preserveTaskSettings: true });
  expect(store.projectBotForTask(bot.id, bot.threadId)?.modelSelection).toEqual(TWO);
  expect(store.projectBotForTask(bot.id, second.threadId)?.modelSelection).toEqual(TWO);
});

it("a one-chat bot's model change never overwrites the chat's own pick, and a following chat follows (the :4005 mirror)", () => {
  const store = fresh(), bot = store.createBot();
  store.patchTask(bot.id, bot.threadId, { modelSelection: structuredClone(MINE) });
  store.patchBot(bot.id, { modelSelection: structuredClone(TWO) });
  expect(store.taskByThread(bot.id, bot.threadId)?.modelSelection).toEqual(MINE);
  const other = fresh(), lone = other.createBot();
  other.patchBot(lone.id, { modelSelection: structuredClone(TWO) });
  expect(other.taskByThread(lone.id, lone.threadId)?.modelSelection).toBeUndefined();
  expect(other.projectBotForTask(lone.id, lone.threadId)?.modelSelection).toEqual(TWO);
});

it("a bot account change resets the session of every following chat and leaves a picked chat's session alone", () => {
  const store = fresh(), bot = store.createBot();
  const picked = store.createTask(bot.id, "picked")!, following = store.createTask(bot.id, "following")!;
  store.patchTask(bot.id, picked.threadId, { modelSelection: structuredClone(MINE) });
  for (const threadId of [bot.threadId, picked.threadId, following.threadId]) store.setResumeCursor(bot.id, "engine-one", `s-${threadId}`, threadId);
  store.patchBot(bot.id, { modelSelection: structuredClone(TWO) }, { preserveTaskSettings: true });
  expect(store.taskByThread(bot.id, following.threadId)?.resumeCursors).toEqual({});
  expect(store.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({});
  expect(store.taskByThread(bot.id, picked.threadId)?.resumeCursors).toEqual({ "engine-one": `s-${picked.threadId}` });
  expect(store.taskByThread(bot.id, picked.threadId)?.modelSelection).toEqual(MINE);
});

it("Switch them too: idle chats with their own model go back to the bot's; a busy one is skipped and counted", () => {
  const store = fresh(), bot = store.createBot();
  const idle = store.createTask(bot.id, "idle")!, busy = store.createTask(bot.id, "busy")!;
  store.patchTask(bot.id, idle.threadId, { modelSelection: structuredClone(MINE) });
  store.patchTask(bot.id, busy.threadId, { modelSelection: structuredClone(MINE) });
  store.setResumeCursor(bot.id, "engine-three", "idle-session", idle.threadId);
  const result = store.followBotModel(bot.id, (threadId) => threadId === busy.threadId)!;
  expect(result.switched).toEqual([idle.threadId]);
  expect(result.busy).toBe(1);
  expect(store.taskByThread(bot.id, idle.threadId)?.modelSelection).toBeUndefined();
  expect(store.taskByThread(bot.id, idle.threadId)?.resumeCursors).toEqual({});
  expect(store.taskByThread(bot.id, busy.threadId)?.modelSelection).toEqual(MINE);
  // durable
  expect(fresh().taskByThread(bot.id, idle.threadId)?.modelSelection).toBeUndefined();
});

it("the first 1.0.4 load drops only chat models that copied the bot's, once, and writes its marker", () => {
  const store = fresh(), bot = store.createBot(), first = bot.threadId;
  const copied = store.createTask(bot.id, "copied")!, picked = store.createTask(bot.id, "picked")!;
  store.patchTask(bot.id, picked.threadId, { modelSelection: structuredClone(MINE) });
  // a 1.0.3 data folder: every chat carries a copy of its bot's model (backfill and clones), and no marker
  const rows = disk();
  for (const task of rows[0].tasks) task.modelSelection ??= { ...rows[0].modelSelection };
  // key order differs from the bot's: equality is by content
  rows[0].tasks.find((task: { threadId: string }) => task.threadId === copied.threadId).modelSelection = { connectionId: "account-one", model: "one", instanceId: "engine-one" };
  writeBots(rows);
  closeDatabase();
  rmSync(MARKER, { force: true });
  const loaded = fresh();
  expect(loaded.taskByThread(bot.id, copied.threadId)?.modelSelection).toBeUndefined();
  expect(loaded.taskByThread(bot.id, first)?.modelSelection).toBeUndefined();
  expect(loaded.taskByThread(bot.id, picked.threadId)?.modelSelection).toEqual(MINE);
  expect(existsSync(MARKER)).toBe(true);
  // once: after the marker, an equal pin (a downgrade to 1.0.3 re-pinned it) stays pinned
  const again = disk();
  for (const task of again[0].tasks) task.modelSelection ??= { ...again[0].modelSelection };
  writeBots(again);
  closeDatabase();
  const reloaded = fresh();
  expect(reloaded.taskByThread(bot.id, copied.threadId)?.modelSelection).toEqual(ONE);
});
