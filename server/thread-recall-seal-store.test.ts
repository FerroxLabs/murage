// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread recall, design S1 (r11 23b): the seal is a task-level number, bumped
// and saved with the immediate roster save before any recall answer leaves.
// It survives a restart, never decreases, is per thread (a new conversation is
// unsealed) and a failed save throws so the caller can answer 409.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { resetRetainedSessionCursors } from "./installation-memory-downgrade.ts";
import { cursorStartedBelowSeal, dispatchSealStart, sessionTainted, Store, threadSealed } from "./store.ts";
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

describe("the generation a session started under (THREAD-SEAL 3.1)", () => {
  const flush = (store: Store) => (store as unknown as { saveBots(bots: unknown): void }).saveBots(store.bots);
  const sealedWith = (cursor?: string, sealStart?: number) => {
    const store = fresh(), bot = store.createBot(), thread = bot.threadId;
    if (cursor !== undefined) store.setResumeCursor(bot.id, "engine-one", cursor, thread, undefined, undefined, false, undefined, sealStart);
    store.sealThread(bot.id, thread);
    return { store, bot, thread, task: () => store.taskByThread(bot.id, thread)! };
  };
  const save = (store: Store, botId: string, thread: string, cursor: unknown, sealStart?: number) => store.setResumeCursor(botId, "engine-one", cursor, thread, undefined, undefined, false, undefined, sealStart);

  it("(m1) the predicate: unsealed never tainted; sealed with no cursor, no entry, another value or a lower start is tainted; an equal pair is not", () => {
    const store = fresh(), bot = store.createBot(), thread = bot.threadId;
    expect(sessionTainted(undefined, "engine-one")).toBe(false);
    expect(sessionTainted(store.taskByThread(bot.id, thread), "engine-one")).toBe(false);
    save(store, bot.id, thread, "unbound");
    expect(sessionTainted(store.taskByThread(bot.id, thread), "engine-one")).toBe(false);
    const { task } = sealedWith();
    expect(sessionTainted(task(), "engine-one")).toBe(true); // no cursor
    const noEntry = sealedWith();
    save(noEntry.store, noEntry.bot.id, noEntry.thread, "s1");
    expect(sessionTainted(noEntry.task(), "engine-one")).toBe(true);
    const below = sealedWith("s1", 0);
    expect(sessionTainted(below.task(), "engine-one")).toBe(true);
    const equal = sealedWith();
    save(equal.store, equal.bot.id, equal.thread, "s1", 1);
    expect(sessionTainted(equal.task(), "engine-one")).toBe(false);
    expect(sessionTainted({ sealGeneration: 1, resumeCursors: { "engine-one": "s1" }, resumeSeals: { "engine-one": { cursor: "s2", generation: 1 } } }, "engine-one")).toBe(true);
    expect(sessionTainted({ sealGeneration: 1, resumeCursors: { "engine-one": 7 }, resumeSeals: { "engine-one": { cursor: "7", generation: 1 } } }, "engine-one")).toBe(false);
    expect(sessionTainted({ sealGeneration: 1, resumeCursors: { "engine-one": "s1" }, resumeSeals: { "engine-one": { cursor: "s1", generation: undefined as unknown as number } } }, "engine-one")).toBe(true);
    expect(sessionTainted({ sealGeneration: 1, resumeCursors: { "engine-one": "s1" }, resumeSeals: { "engine-one": { cursor: "s1", generation: Number.NaN } } }, "engine-one")).toBe(true);
  });

  it("(m2) the minimum rule: a later save of the same id never raises what is stored; another id replaces it", () => {
    const store = fresh(), bot = store.createBot(), thread = bot.threadId, seals = () => store.taskByThread(bot.id, thread)?.resumeSeals?.["engine-one"];
    save(store, bot.id, thread, "A", 1);
    save(store, bot.id, thread, "A", 2);
    expect(seals()).toEqual({ cursor: "A", generation: 1 });
    save(store, bot.id, thread, "A", 0);
    expect(seals()).toEqual({ cursor: "A", generation: 0 });
    save(store, bot.id, thread, "B", 2);
    expect(seals()).toEqual({ cursor: "B", generation: 2 });
  });

  it("(m3) a save with no start: another id ends the entry, the same id leaves it, no cursor ends it; bindResumeSeal holds the same rule", () => {
    const store = fresh(), bot = store.createBot(), thread = bot.threadId, seals = () => store.taskByThread(bot.id, thread)?.resumeSeals?.["engine-one"];
    save(store, bot.id, thread, "A", 1);
    save(store, bot.id, thread, "A");
    expect(seals()).toEqual({ cursor: "A", generation: 1 });
    save(store, bot.id, thread, "B");
    expect(seals()).toBeUndefined();
    save(store, bot.id, thread, "A", 1);
    save(store, bot.id, thread, undefined);
    expect(seals()).toBeUndefined();
    save(store, bot.id, thread, "A");
    store.bindResumeSeal(bot.id, "engine-one", thread, "other", 3);
    expect(seals()).toBeUndefined();
    store.bindResumeSeal(bot.id, "engine-one", thread, "A", 2);
    expect(seals()).toEqual({ cursor: "A", generation: 2 });
    store.bindResumeSeal(bot.id, "engine-one", thread, "A", 3);
    expect(seals()).toEqual({ cursor: "A", generation: 2 });
    store.bindResumeSeal(bot.id, "engine-one", thread, "A", 1);
    expect(seals()).toEqual({ cursor: "A", generation: 1 });
  });

  it("(m4) every public mutation that empties cursors leaves a sealed task tainted", () => {
    const model = (connectionId: string) => ({ instanceId: "engine-one", model: "one", effort: "medium" as const, connectionId });
    const clean = () => { const s = sealedWith(); save(s.store, s.bot.id, s.thread, "s1", 1); expect(sessionTainted(s.task(), "engine-one")).toBe(false); return s; };
    const mutations: Array<[string, (s: ReturnType<typeof clean>) => void]> = [
      ["patchTask model change", (s) => s.store.patchTask(s.bot.id, s.thread, { modelSelection: model("account-two") })],
      ["rewind and failover and bundle patches", (s) => s.store.patchTask(s.bot.id, s.thread, { rewound: false, resumeCursors: {} })],
      ["patchBot account change", (s) => s.store.patchBot(s.bot.id, { modelSelection: model("account-two") })],
      ["switch back to the bot's engine", (s) => { s.store.patchTask(s.bot.id, s.thread, { modelSelection: model("account-one") }); save(s.store, s.bot.id, s.thread, "s1", 1); s.store.followBotModel(s.bot.id, () => false); }],
      ["Codex default effort and keep-all repair", (s) => s.store.setResumeCursor(s.bot.id, "engine-one", undefined, s.thread)],
      ["task folder change", (s) => s.store.patchTask(s.bot.id, s.thread, { resumeCursors: {}, rewound: true, cwd: null })],
      ["the turn a routine reuses", (s) => s.store.patchTask(s.bot.id, s.thread, { resumeCursors: {} })],
    ];
    for (const [name, mutate] of mutations) {
      const s = clean();
      mutate(s);
      expect(s.task().resumeCursors["engine-one"], name).toBeUndefined();
      expect(sessionTainted(s.task(), "engine-one"), name).toBe(true);
      expect(s.task().resumeSeals?.["engine-one"], name).toBeUndefined();
    }
    // a new task, and a bot from a package import, are unsealed and hold nothing; the active-task and bot-mirror paths only read the task's
    // own record. Restore preparation and the installation snapshot: their own tests carry a resumeSeals entry in the fixture.
    const s = clean(), second = s.store.createTask(s.bot.id, "second")!;
    expect(second.resumeSeals).toBeUndefined();
    s.store.switchTask(s.bot.id, s.thread);
    expect(sessionTainted(s.task(), "engine-one")).toBe(false);
  });

  it("(m4) the file-level paths: memory downgrade empties the entry with the cursors", () => {
    const s = sealedWith();
    save(s.store, s.bot.id, s.thread, "s1", 1);
    flush(s.store);
    closeDatabase();
    expect(resetRetainedSessionCursors(DATA_DIR)).toBeGreaterThan(0);
    const reloaded = fresh().taskByThread(s.bot.id, s.thread);
    expect(reloaded?.resumeSeals).toBeUndefined();
    expect(sessionTainted(reloaded, "engine-one")).toBe(true);
  });

  it("(m5) a restart in each state a crash can leave gives the stated outcome", () => {
    const states: Array<[string, (s: ReturnType<typeof sealedWith>) => void, boolean]> = [
      ["(a) entry at the seal", (s) => save(s.store, s.bot.id, s.thread, "s1", 1), false],
      ["(b) a release after the fold", (s) => { save(s.store, s.bot.id, s.thread, "s1", 1); s.store.sealThread(s.bot.id, s.thread); }, true],
      ["(c) an older pair under a newer seal", (s) => { save(s.store, s.bot.id, s.thread, "old", 0); }, true],
      ["(d) no cursor", () => undefined, true],
      ["(e) a cursor and no entry", (s) => save(s.store, s.bot.id, s.thread, "s1"), true],
    ];
    for (const [name, state, tainted] of states) {
      const s = sealedWith();
      state(s);
      expect(sessionTainted(s.task(), "engine-one"), name).toBe(tainted);
      flush(s.store);
      const restored = fresh().taskByThread(s.bot.id, s.thread);
      expect(sessionTainted(restored, "engine-one"), `${name}, restored`).toBe(tainted);
    }
  });

  it("(m6) legacy shapes: sealed with no cursor, and sealed with a pre-seal cursor, are tainted", () => {
    expect(sessionTainted({ sealGeneration: 2, resumeCursors: {} }, "engine-one")).toBe(true);
    expect(sessionTainted({ sealGeneration: 2, resumeCursors: { "engine-one": "pre-seal" } }, "engine-one")).toBe(true);
  });

  it("(m9) the write fence judges the snapshotted cursor: unsealed and no cursor pass; another value, a clean pair in the slot and a lower start refuse", () => {
    const task = (generation: number, cursor = "s1") => ({ sealGeneration: 2, resumeSeals: { "engine-one": { cursor, generation } } });
    expect(cursorStartedBelowSeal({ resumeSeals: undefined }, "engine-one", "s1")).toBe(false);
    expect(cursorStartedBelowSeal({ sealGeneration: 0 }, "engine-one", "s1")).toBe(false);
    expect(cursorStartedBelowSeal(task(1), "engine-one", undefined)).toBe(false);
    expect(cursorStartedBelowSeal({ sealGeneration: 2 }, "engine-one", "s1")).toBe(true);
    expect(cursorStartedBelowSeal(task(2, "clean-pair"), "engine-one", "s1")).toBe(true);
    expect(cursorStartedBelowSeal(task(1), "engine-one", "s1")).toBe(true);
    expect(cursorStartedBelowSeal(task(2), "engine-one", "s1")).toBe(false);
  });

  it("the start of a dispatch: fresh takes the task's seal, resumed inherits its own entry, another id's entry lends nothing", () => {
    const task = { sealGeneration: 3, resumeSeals: { "engine-one": { cursor: "s1", generation: 2 } } };
    expect(dispatchSealStart(task, "engine-one", undefined)).toBe(3);
    expect(dispatchSealStart(task, "engine-one", "s1")).toBe(2);
    expect(dispatchSealStart(task, "engine-one", "s2")).toBe(0);
    expect(dispatchSealStart(undefined, "engine-one", undefined)).toBe(0);
  });

  it("(m8) a patch from the API cannot write resumeSeals", () => {
    const store = fresh(), bot = store.createBot(), thread = bot.threadId;
    expect(Object.keys(store.taskByThread(bot.id, thread)!)).not.toContain("resumeSeals");
    store.patchTask(bot.id, thread, { title: "renamed", unread: true });
    expect(store.taskByThread(bot.id, thread)?.resumeSeals).toBeUndefined();
  });
});
