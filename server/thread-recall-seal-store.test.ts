// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread recall, design S1 (r11 23b): the seal is a task-level number, bumped
// and saved with the immediate roster save before any recall answer leaves.
// It survives a restart, never decreases, is per thread (a new conversation is
// unsealed) and a failed save throws so the caller can answer 409.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store, threadSealed } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const fresh = () => new Store(() => ({ instanceId: "engine-one", model: "one", effort: "medium", connectionId: "account-one" }));
const onDisk = (botId: string, threadId: string) =>
  (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as any[]).find((bot) => bot.id === botId).tasks.find((task: any) => task.threadId === threadId);

it("a thread never recalled carries no seal, and the seal is written to disk before sealThread returns", () => {
  const store = fresh(), bot = store.createBot(), thread = bot.threadId;
  expect(store.taskByThread(bot.id, thread)?.sealGeneration).toBeUndefined();
  expect(threadSealed(store.taskByThread(bot.id, thread))).toBe(false);
  expect(onDisk(bot.id, thread).sealGeneration).toBeUndefined();
  expect(store.sealThread(bot.id, thread)).toBe(1);
  expect(onDisk(bot.id, thread).sealGeneration).toBe(1);
  expect(threadSealed(store.taskByThread(bot.id, thread))).toBe(true);
  expect(store.sealThread(bot.id, thread)).toBe(2);
  expect(onDisk(bot.id, thread).sealGeneration).toBe(2);
});

it("the seal survives a restart, keeps the pre-seal cursor in place, and a new conversation is unsealed", () => {
  const store = fresh(), bot = store.createBot(), thread = bot.threadId;
  store.setResumeCursor(bot.id, "engine-one", "pre-seal-session", thread);
  store.sealThread(bot.id, thread);
  const second = store.createTask(bot.id, "second")!;
  const restored = fresh();
  expect(restored.taskByThread(bot.id, thread)?.sealGeneration).toBe(1);
  expect(restored.taskByThread(bot.id, thread)?.resumeCursors).toEqual({ "engine-one": "pre-seal-session" });
  expect(threadSealed(restored.taskByThread(bot.id, second.threadId))).toBe(false);
});

it("a patch from the API cannot clear or lower the seal", () => {
  const store = fresh(), bot = store.createBot(), thread = bot.threadId;
  store.sealThread(bot.id, thread);
  store.patchTask(bot.id, thread, { title: "renamed", unread: true });
  expect(store.taskByThread(bot.id, thread)?.sealGeneration).toBe(1);
});

it("a failed save throws, and the in-memory seal still holds", () => {
  const store = fresh(), bot = store.createBot(), thread = bot.threadId;
  // bots.json becomes a directory: the atomic rename onto it fails.
  rmSync(join(DATA_DIR, "bots.json"), { force: true });
  mkdirSync(join(DATA_DIR, "bots.json", "blocker"), { recursive: true });
  expect(() => store.sealThread(bot.id, thread)).toThrow();
  expect(threadSealed(store.taskByThread(bot.id, thread))).toBe(true);
});

it("sealing a thread that is not this bot's task throws and writes nothing", () => {
  const store = fresh(), bot = store.createBot();
  expect(() => store.sealThread(bot.id, "not-a-thread")).toThrow();
  expect(threadSealed(store.taskByThread(bot.id, bot.threadId))).toBe(false);
});
