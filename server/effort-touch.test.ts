// ACP-EFFORT-PER-MODEL-1023 (ET): the durable touch record on a real Store and a temp folder.
import { mkdirSync } from "node:fs";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { readBotRecords } from "./bot-turn-state.ts";

type Handle = typeof import("./effort-touch.ts")["effortTouchHandle"];
let realHandle: Handle;
// dynamic, so that a base without the module fails an assertion rather than at import
beforeAll(async () => { const mod = await import("./effort-touch.ts").catch(() => undefined); realHandle = mod?.effortTouchHandle as Handle; });
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const open = () => new Store(() => ({ instanceId: "copilot", model: "fixture" }));
const fixture = () => {
  const store = open();
  const bot = store.createBot();
  const task = () => store.taskByThread(bot.id, bot.threadId)!;
  // RED on a base without the record: the API is asserted before it is used
  expect(realHandle, "server/effort-touch.ts exports effortTouchHandle").toBeTypeOf("function");
  expect(store.setEffortTouch, "Store.setEffortTouch exists").toBeTypeOf("function");
  expect(store.effortTouchOf, "Store.effortTouchOf exists").toBeTypeOf("function");
  const handle = () => realHandle(store, bot.id, "copilot", bot.threadId);
  const cursor = (id: string | undefined) => store.setResumeCursor(bot.id, "copilot", id, bot.threadId);
  return { store, bot, task, handle, cursor };
};

it("S1/S2 a state is saved per session, at most two keys, and a missing key reads undefined", () => {
  const { handle, cursor, task } = fixture();
  cursor("A");
  expect(handle().get("A")).toBe("pending");
  expect(handle().get("B")).toBeUndefined();
  expect(handle().set("A", "set")).toBe(true);
  expect(handle().set("B", "clean")).toBe(true);
  expect(handle().set("C", "clean")).toBe(true);
  expect(Object.keys(task().effortTouch!.copilot!.sessions).sort()).toEqual(["A", "C"]);
});

it("S3 a cursor with no key reads pending, the same id keeps its key, a clear deletes the entry", () => {
  const { handle, cursor, task } = fixture();
  cursor("A"); handle().set("A", "set");
  cursor("A");
  expect(handle().get("A")).toBe("set");
  cursor("B");
  expect(task().effortTouch).toEqual({ copilot: { v: 1, sessions: { B: "pending" } } });
  cursor(undefined);
  expect(task().effortTouch?.copilot).toBeUndefined();
});

it("X5 a late session.started for an older id: the cursor moves back and the record keeps only that id, pending", () => {
  const { handle, cursor, task } = fixture();
  cursor("S_old"); handle().set("S_old", "set");
  handle().set("R", "clean"); cursor("R");
  expect(task().effortTouch).toEqual({ copilot: { v: 1, sessions: { R: "clean" } } });
  cursor("S_old");
  expect(task().resumeCursors.copilot).toBe("S_old");
  expect(task().effortTouch).toEqual({ copilot: { v: 1, sessions: { S_old: "pending" } } });
});

it("S6 the record is on disk before any orderly shutdown, and a new Store on the same folder reads it", () => {
  const { bot, handle, cursor } = fixture();
  cursor("R"); handle().set("R", "clean");
  // durable files only: no coalesced writer, no Store shutdown
  expect(readBotRecords(DATA_DIR).find(item => item.id === bot.id)!.tasks![0]!.effortTouch).toEqual({ copilot: { v: 1, sessions: { R: "clean" } } });
  closeDatabase();
  const reopened = open();
  expect(realHandle(reopened, bot.id, "copilot", bot.threadId).get("R")).toBe("clean");
});

it("X7 a routine reuse that clears the cursor deletes the record, so the next run opens new", () => {
  const { handle, cursor } = fixture();
  cursor("R"); handle().set("R", "set");
  cursor(undefined);
  expect(handle().get("R")).toBeUndefined();
});

it("X8 a second task's record is its own: keyed by task, never by bot", () => {
  const { store, bot, cursor } = fixture();
  const first = bot.threadId;
  const handle = () => realHandle(store, bot.id, "copilot", first);
  cursor("R"); handle().set("R", "clean");
  const second = store.createTask(bot.id, "webhook", false)!;
  const other = realHandle(store, bot.id, "copilot", second.threadId);
  expect(other.get("R")).toBeUndefined();
  expect(other.set("W", "clean")).toBe(true);
  expect(handle().get("W")).toBeUndefined();
  expect(handle().get("R")).toBe("clean");
});

it("S5 a direct reset that clears the cursors also clears the record", () => {
  const { handle, cursor, store, bot, task } = fixture();
  cursor("R"); handle().set("R", "set");
  store.patchTask(bot.id, bot.threadId, { resumeCursors: {} });
  expect(task().effortTouch).toBeUndefined();
});
