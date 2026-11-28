// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let store: Store;
beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
});
afterEach(() => { store.stopSeqStamps(); closeDatabase(); });

it("deleting the open chat chooses the visible neighbor supplied by its list", () => {
  const bot = store.createBot({}, { seedMessages: false });
  const open = { threadId: bot.threadId };
  const next = store.createTask(bot.id, "Review next", false)!;
  const hiddenByFilter = store.createTask(bot.id, "Outside the filter", false)!.threadId;
  store.setResumeCursor(bot.id, "fixture", "saved-cursor", next.threadId);
  store.deleteTask(bot.id, open.threadId, next.threadId);
  expect(bot.threadId).toBe(next.threadId);
  expect(bot.threadId).not.toBe(hiddenByFilter);
  expect(bot.resumeCursors.fixture).toBe("saved-cursor");
  expect(store.taskByThread(bot.id, open.threadId)).toBeUndefined();
  expect(new Store(() => ({ instanceId: "fixture", model: "fixture" })).bot(bot.id)?.threadId).toBe(next.threadId);
});

it("a list neighbor never moves the open chat when a different chat is deleted", () => {
  const bot = store.createBot({}, { seedMessages: false });
  const open = bot.threadId;
  const other = store.createTask(bot.id, "Other", false)!;
  const next = store.createTask(bot.id, "Next", false)!;
  store.deleteTask(bot.id, other.threadId, next.threadId);
  expect(bot.threadId).toBe(open);
});

it.each(["missing", "deleted", "other-bot"])("ignores a %s neighbor and keeps a valid fallback", (kind) => {
  const bot = store.createBot({}, { seedMessages: false });
  const fallback = bot.threadId;
  const open = store.createTask(bot.id, "Open")!;
  const foreign = store.createBot({}, { seedMessages: false });
  const preferred = kind === "deleted" ? open.threadId : kind === "other-bot" ? foreign.threadId : "missing-thread";
  store.deleteTask(bot.id, open.threadId, preferred);
  expect(bot.threadId).toBe(fallback);
  expect(foreign.threadId).not.toBe(fallback);
});

it("deleting the last chat still leaves a fresh chat", () => {
  const bot = store.createBot({}, { seedMessages: false });
  const deleted = bot.threadId;
  store.deleteTask(bot.id, deleted, deleted);
  expect(bot.tasks).toHaveLength(1);
  expect(bot.threadId).not.toBe(deleted);
  expect(store.taskByThread(bot.id, bot.threadId)).toBeDefined();
});
