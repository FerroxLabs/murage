// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BotTurnState, readBotRecords } from "./bot-turn-state.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { atomicWriteCount, flushCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { RosterPostCommitError, Store, type BotRecord, type StoreChange } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = () => ({ instanceId: "fixture", model: "model" });
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => { flushCoalesced(); vi.restoreAllMocks(); });
function world(count: number) {
  const store = new Store(selection), bot = store.createBot({ name: "Fixture" }, { seedMessages: false });
  for (let i = 1; i < count; i++) store.createTask(bot.id, `Task ${i}`);
  return { store, bot, tasks: bot.tasks!, held: bot.tasks!.slice() };
}
const disk = (id: string): BotRecord => readBotRecords(DATA_DIR).find(bot => bot.id === id)!;

it.each([0, 1, 3])("unrelated metadata retains the task array and every held task (%i tasks)", count => {
  const { store, bot } = world(Math.max(1, count));
  if (count === 0) store.patchBot(bot.id, { tasks: [] });
  const tasks = bot.tasks!, held = tasks.slice();
  expect(store.patchBot(bot.id, { description: "Changed" })).toBe(bot);
  expect(bot.tasks).toBe(tasks);
  held.forEach((task, i) => expect(bot.tasks![i]).toBe(task));
  expect(new Store(selection).bot(bot.id)!.description).toBe("Changed");
});

it("a multi-task unread patch preserves task values, references and the task index", () => {
  const { store, bot, tasks, held } = world(3);
  const values = structuredClone(tasks);
  for (const task of held) expect(store.taskByThread(bot.id, task.threadId)).toBe(task);
  store.patchBot(bot.id, { unread: true });
  expect(bot.tasks).toBe(tasks);
  expect(bot.tasks).toEqual(values);
  for (const task of held) expect(store.taskByThread(bot.id, task.threadId)).toBe(task);
  expect(disk(bot.id).unread).toBe(true);
});

it("a sole task still mirrors unread and cursor clearing into its held object", () => {
  const { store, bot, held } = world(1), task = held[0]!;
  store.patchBot(bot.id, { unread: true, resumeCursors: { fixture: "session" } });
  expect(store.taskByThread(bot.id, task.threadId)).toBe(task);
  expect(task).toMatchObject({ unread: true, resumeCursors: { fixture: "session" } });
  store.patchBot(bot.id, { resumeCursors: {} });
  expect(task.resumeCursors).toEqual({});
  expect(task.resumePolicies).toBeUndefined();
  expect(task.replayPending).toBeUndefined();
  expect(disk(bot.id).tasks![0]!.resumeCursors).toEqual({});
});

it("preserving sole-task settings neither changes nor republishes the task", () => {
  const { store, bot, tasks, held } = world(1), before = structuredClone(held[0]);
  store.patchBot(bot.id, { autoApprove: true, alwaysAllow: ["Read"] }, { preserveTaskSettings: true });
  expect(bot.tasks).toBe(tasks);
  expect(held[0]).toEqual(before);
  expect(bot.autoApprove).toBe(true);
});

it("staged bot metadata retains its already restricted tasks and new tasks remain restricted", () => {
  const store = new Store(selection);
  const bot = store.createBot({ name: "Fixture" }, { seedMessages: false, staged: {
    rev: 1, at: 1, generation: "fixture", reason: "outside", byThreadId: "fixture-thread", byBotId: "fixture-bot",
    intended: { autoApprove: true, fullAccess: true, noLimits: true, lead: true }, heldWork: [],
  } });
  const unsafe = { ...bot.tasks![0]!, autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["Read"] };
  store.patchBot(bot.id, { tasks: [unsafe, { ...unsafe, threadId: "fixture-other" }] });
  const tasks = bot.tasks!;
  expect(tasks.every(task => !task.autoApprove && !task.fullAccess && !task.noLimits && !task.alwaysAllow?.length)).toBe(true);
  store.patchBot(bot.id, { description: "Changed" });
  expect(bot.tasks).toBe(tasks);
  expect(bot.autoApprove).toBe(false);
  expect(tasks.every(task => !task.autoApprove && !task.fullAccess && !task.noLimits && !task.alwaysAllow?.length)).toBe(true);
});

it("explicit task changes still update held references, delete absent keys and remove tasks", () => {
  const { store, bot, held } = world(3), task = held[0]!;
  store.patchBot(bot.id, { tasks: [{ ...task, title: "Picked", pinned: true }, held[2]!] });
  expect(bot.tasks).toEqual([task, held[2]]);
  expect(task.title).toBe("Picked");
  expect(task.pinned).toBe(true);
  const { pinned: _drop, ...withoutPin } = task;
  store.patchBot(bot.id, { tasks: [withoutPin, held[2]!] });
  expect(store.taskByThread(bot.id, task.threadId)).toBe(task);
  expect(task.pinned).toBeUndefined();
  expect(store.taskByThread(bot.id, held[1]!.threadId)).toBeUndefined();
});

it("a pre-commit failure changes neither tasks nor metadata and announces nothing", () => {
  const { store, bot, tasks } = world(3), before = structuredClone(bot), changes: StoreChange[] = [];
  store.onChange(change => changes.push(change));
  const revision = store.revision;
  vi.spyOn(store as unknown as { rosterJson: () => never }, "rosterJson").mockImplementationOnce(() => { throw new Error("write refused"); });
  expect(() => store.patchBot(bot.id, { unread: true, description: "Changed" })).toThrow("write refused");
  expect(bot.tasks).toBe(tasks);
  expect(bot).toEqual(before);
  expect(store.revision).toBe(revision);
  expect(changes).toEqual([]);
  expect(disk(bot.id).unread).toBe(before.unread);
});

it("a post-commit metadata failure publishes the durable metadata without replacing tasks", () => {
  const { store, bot, tasks, held } = world(3), changes: StoreChange[] = [];
  store.onChange(change => changes.push(change));
  vi.spyOn(store as unknown as { afterRosterSave: () => never }, "afterRosterSave").mockImplementationOnce(() => { throw new Error("after commit"); });
  expect(() => store.patchBot(bot.id, { unread: true, description: "Changed" })).toThrow(RosterPostCommitError);
  expect(bot.tasks).toBe(tasks);
  held.forEach((task, i) => expect(bot.tasks![i]).toBe(task));
  expect(bot.unread).toBe(true);
  expect(disk(bot.id).unread).toBe(true);
  expect(changes).toEqual([{ type: "bot", botId: bot.id }]);
});


it("a badge is durable without rewriting the task-history checkpoint", () => {
  const { store, bot, tasks } = world(3), path = join(DATA_DIR, "bots.json");
  const before = readFileSync(path, "utf8"), revision = store.taskRevision(bot.id), changes: StoreChange[] = [];
  store.onChange(change => changes.push(change));
  store.patchBot(bot.id, { unread: true });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(bot.tasks).toBe(tasks);
  expect(store.taskRevision(bot.id)).toBe(revision);
  expect(changes).toEqual([{ type: "bot", botId: bot.id }]);
  expect(disk(bot.id).unread).toBe(true);
  // Boot has always derived bot unread from its task badges; a room badge
  // alone does not mark every historical direct task unread.
  expect(new Store(selection).bot(bot.id)!.unread).toBe(tasks.some(task => task.unread));
  if (process.platform !== "win32") expect(statSync(join(DATA_DIR, "bot-turn-state.json")).mode & 0o777).toBe(0o600);
});

it("a failed badge write publishes nothing, including through a subsequent successful write", () => {
  const { store, bot, tasks } = world(3), other = store.createBot({ name: "Other fixture" }, { seedMessages: false });
  store.createTask(other.id, "Other task");
  const before = structuredClone(bot), revision = store.revision, changes: StoreChange[] = [];
  store.onChange(change => changes.push(change));
  vi.spyOn(BotTurnState.prototype, "flush").mockImplementationOnce(() => { throw new Error("badge refused"); });
  expect(() => store.patchBot(bot.id, { unread: true })).toThrow("badge refused");
  expect(bot).toEqual(before);
  expect(bot.tasks).toBe(tasks);
  expect(store.revision).toBe(revision);
  expect(changes).toEqual([]);
  // Two tasks make the other badge use the same delta file too.
  store.patchBot(other.id, { unread: true });
  expect(disk(bot.id).unread).toBe(before.unread);
});

it("a newer checkpoint fences off an old badge delta, even after a field returns to its former value", () => {
  const { store, bot } = world(3), deltaFile = join(DATA_DIR, "bot-turn-state.json");
  store.patchBot(bot.id, { unread: true });
  const stale = readFileSync(deltaFile, "utf8");
  store.patchBot(bot.id, { unread: false, description: "Changed" });
  store.patchBot(bot.id, { description: "" });
  writeFileSync(deltaFile, stale);
  expect(disk(bot.id).unread).toBe(false);
  expect(new Store(selection).bot(bot.id)!.unread).toBe(false);
});

it("room usage for two bots coalesces without reading task history or losing either bucket", () => {
  const { store, bot, tasks } = world(3), other = store.createBot({ name: "Other fixture" }, { seedMessages: false });
  const file = join(DATA_DIR, "bots.json"), before = atomicWriteCount(file), revision = store.taskRevision(bot.id);
  bot.tasks = new Proxy(tasks, { get(target, key, receiver) {
    if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) throw new Error("room usage read task history");
    return Reflect.get(target, key, receiver);
  } });
  store.addRoomTurnUsage(bot.id, { input: 4, output: 2 }, "fixture-first");
  store.addRoomTurnUsage(other.id, { input: 7, output: 3 }, "fixture-other");
  // A badge arriving before the timer also commits the pending month state.
  store.patchBot(bot.id, { unread: true });
  flushCoalesced();
  expect(atomicWriteCount(file)).toBe(before);
  expect(store.taskRevision(bot.id)).toBe(revision);
  expect(disk(bot.id).usageMonths).toBeDefined();
  expect(disk(other.id).usageMonths).toBeDefined();
  expect(Object.values(disk(bot.id).usageMonths!)[0]).toMatchObject({ replies: 1, input: 4, output: 2 });
  expect(Object.values(disk(other.id).usageMonths!)[0]).toMatchObject({ replies: 1, input: 7, output: 3 });
  bot.tasks = tasks;
  const again = new Store(selection);
  expect(again.bot(bot.id)!.usageMonths).toEqual(bot.usageMonths);
  expect(again.bot(other.id)!.usageMonths).toEqual(other.usageMonths);
});

it("a structural checkpoint cancels queued deltas and a later delete cannot revive a bot", () => {
  const { store, bot } = world(3);
  store.addRoomTurnUsage(bot.id, { input: 5 }, "fixture-turn");
  store.patchBot(bot.id, { description: "Changed" });
  expect(() => flushCoalesced()).not.toThrow();
  expect(Object.values(disk(bot.id).usageMonths!)[0]).toMatchObject({ replies: 1, input: 5 });
  store.addRoomTurnUsage(bot.id, { input: 1 }, "fixture-turn-again");
  store.deleteBot(bot.id);
  expect(() => flushCoalesced()).not.toThrow();
  expect(new Store(selection).bot(bot.id)).toBeNull();
});

it("a damaged turn-state file refuses boot without replacing the checkpoint", () => {
  world(3);
  const file = join(DATA_DIR, "bots.json"), before = readFileSync(file, "utf8");
  writeFileSync(join(DATA_DIR, "bot-turn-state.json"), "{broken");
  expect(() => new Store(selection)).toThrow(expect.objectContaining({ name: "PersistedStateRecoveryError", reason: "invalid-json" }));
  expect(readFileSync(file, "utf8")).toBe(before);
});

it("turn-state deltas cannot supply tasks or permissions", () => {
  const { bot } = world(3), base = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"))[0].turnStateBase;
  writeFileSync(join(DATA_DIR, "bot-turn-state.json"), JSON.stringify({ version: 1, bots: { [bot.id]: { base, state: { unread: true, autoApprove: true, tasks: [] } } } }));
  expect(() => new Store(selection)).toThrow(expect.objectContaining({ name: "PersistedStateRecoveryError", reason: "invalid-shape" }));
});

it("activity priority and busy-task exclusion stay current across simultaneous tasks and task removal", () => {
  const { store, bot, held } = world(3);
  store.setTaskActivity(bot.id, held[0]!.threadId, "working");
  store.setTaskActivity(bot.id, held[1]!.threadId, "waiting-on-you");
  expect(bot.activity).toBe("waiting-on-you");
  expect(store.hasBusyTask(bot.id, held[0]!.threadId)).toBe(true);
  store.setTaskActivity(bot.id, held[1]!.threadId, "idle");
  expect(bot.activity).toBe("working");
  expect(store.hasBusyTask(bot.id, held[0]!.threadId)).toBe(false);
  store.setActivity(bot.id, "no-signal");
  expect(bot.activity).toBe("no-signal");
  store.patchBot(bot.id, { tasks: held.slice(1) });
  store.setActivity(bot.id, "idle");
  expect(bot.activity).toBe("idle");
  expect(store.hasBusyTask(bot.id)).toBe(false);
});

it("bot-only activity leaves task revisions alone, while task edits invalidate only their bot", () => {
  const { store, bot, held } = world(3), other = store.createBot({ name: "Other fixture" }, { seedMessages: false });
  const revision = store.taskRevision(bot.id), otherRevision = store.taskRevision(other.id);
  store.setActivity(bot.id, "working");
  store.setActivity(bot.id, "idle");
  expect(store.taskRevision(bot.id)).toBe(revision);
  store.setTaskActivity(bot.id, held[1]!.threadId, "working");
  expect(store.taskRevision(bot.id)).toBeGreaterThan(revision);
  expect(store.taskRevision(other.id)).toBe(otherRevision);
});
