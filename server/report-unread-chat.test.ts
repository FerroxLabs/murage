// A REPORT MARKS THE CHAT IT LANDED IN UNREAD (upstream b34ac3ba6).
//
// A routine's report card, and a delegated reply written into a waiting
// conversation, marked the BOT unread with patchBot. Store.patchBot copies
// `unread` onto a task only when the bot has exactly one, so for a bot with
// several conversations the badge lit on the bot, the conversation the
// report was written into stayed unmarked, and the next change to any task
// recomputed the bot's mark from its tasks and wiped it. Both call sites now
// mark the conversation itself with patchTask.
//
// The Store half runs for real here. server/index.ts boots a listening
// server on import, so its two call sites are read from source, each by its
// own function body only.
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});

const fresh = () => new Store(() => ({ instanceId: "engine-one", model: "one", effort: "medium", connectionId: "account-one" }));

/** A bot with two conversations; the report goes to the first, the person is looking at the second. */
const twoChats = () => {
  const store = fresh();
  const bot = store.createBot();
  const reported = bot.threadId;
  const other = store.createTask(bot.id, "second")!.threadId;
  return { store, bot, reported, other };
};

const unreadOf = (store: Store, botId: string, threadId: string) => store.taskByThread(botId, threadId)?.unread === true;

describe("which chat a report marks unread", () => {
  it("was the bot, not the chat, when the bot has more than one (the defect)", () => {
    const { store, bot, reported, other } = twoChats();
    store.patchBot(bot.id, { unread: true });
    expect(unreadOf(store, bot.id, reported)).toBe(false);
    expect(unreadOf(store, bot.id, other)).toBe(false);
    // and the next change to any chat recomputes the bot's mark from its chats
    store.patchTask(bot.id, other, { unread: false });
    expect(store.bot(bot.id)?.unread).toBe(false);
  });

  it("is the chat the report landed in, and the bot's own mark follows it", () => {
    const { store, bot, reported, other } = twoChats();
    store.patchTask(bot.id, reported, { unread: true });
    expect(unreadOf(store, bot.id, reported)).toBe(true);
    expect(unreadOf(store, bot.id, other)).toBe(false);
    expect(store.bot(bot.id)?.unread).toBe(true);
    // reading the other chat does not clear it
    store.patchTask(bot.id, other, { unread: false });
    expect(store.bot(bot.id)?.unread).toBe(true);
    expect(fresh().taskByThread(bot.id, reported)?.unread).toBe(true);
  });

  it("still works for a bot with one chat", () => {
    const store = fresh();
    const bot = store.createBot();
    store.patchTask(bot.id, bot.threadId, { unread: true });
    expect(unreadOf(store, bot.id, bot.threadId)).toBe(true);
    expect(store.bot(bot.id)?.unread).toBe(true);
  });
});

describe("the two places a report is written", () => {
  const index = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  /** One top-level function's text, from its declaration to the next one. */
  const body = (name: string) => {
    const start = index.indexOf(`\nfunction ${name}(`);
    expect(start, name).toBeGreaterThan(0);
    const end = index.slice(start + 1).search(/\n(?:async )?function |\nconst |\nlet /);
    return index.slice(start, end < 0 ? undefined : start + 1 + end);
  };

  it("a routine's report card marks its own conversation", () => {
    const sync = body("syncRoutineRunToSource");
    expect(sync).toContain("store.patchTask(source.bot.id, sourceThreadId, { unread: true })");
    expect(sync).not.toMatch(/patchBot\([^)]*unread/);
  });

  it("a reply written into a waiting conversation marks that conversation", () => {
    const mark = body("markTaskContextExternallyUpdated");
    expect(mark).toContain("store.patchTask(bot.id, threadId, { unread: true })");
    expect(mark).not.toMatch(/patchBot\([^)]*unread/);
  });
});
