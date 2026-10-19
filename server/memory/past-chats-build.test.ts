// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 lane 2, item 2.1 (M1, M2): memory flips on once for an install that never configured it and no 1.0.3 start has seen; the
// past-chats build reads every conversation in slices through the capture path, resumes, and never queues a message twice.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { closeDatabase, database } from "../database.ts";
import { Store } from "../store.ts";
import { flipMemoryOnForUpgrade, lastRunVersion, listPastChatThreads, memoryUpgradeFlipDue, pastChatsCounters, runPastChatsBuildNow, stepPastChatsBuild } from "./past-chats-build.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { BACKFILL_THREADS_TABLE } from "./schema.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
import { isMurageVoice } from "../murage-voice.ts";
const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

describe("memory on for an upgraded install", () => {
  it("flips once: off, never configured, never seen by 1.0.3; the marker stops a second flip; a configured owner is never flipped", async () => {
    const db = database();
    db.exec("UPDATE memory_meta SET mode='off',policy_revision=0");
    expect(memoryUpgradeFlipDue(db)).toBe(true);
    expect(flipMemoryOnForUpgrade("1.0.3")).toBe(true);
    expect(db.prepare("SELECT mode,policy_revision AS rev FROM memory_meta").get()).toEqual({ mode: "active", rev: 1 });
    expect(lastRunVersion(db)).toBe("1.0.3");
    // the owner turns it off again: the next start leaves it
    db.exec("UPDATE memory_meta SET mode='off',policy_revision=0");
    expect(memoryUpgradeFlipDue(db)).toBe(false);
    expect(flipMemoryOnForUpgrade("1.0.4")).toBe(false);
    expect(db.prepare("SELECT mode FROM memory_meta").get()!.mode).toBe("off");
    expect(lastRunVersion(db)).toBe("1.0.4");
    // an owner who configured memory (the revision moved) and left it off
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const fresh = database();
    const roster = { bots: [{ id: "a", threadId: "ta" }], groups: [] };
    reconcileMemoryRoster(roster);
    fresh.exec("UPDATE memory_meta SET mode='off'");
    await memoryOwnerRoute("/api/memory/action", { action: "configure", mode: "off" }, ownerMemoryTicket(), roster);
    expect(memoryUpgradeFlipDue(fresh)).toBe(false);
    expect(flipMemoryOnForUpgrade("1.0.3")).toBe(false);
  });
});

describe("the past-chats build", () => {
  function seeded() {
    // the conversations are written with memory off: nothing is captured live, so every source below comes from the build
    database().exec("UPDATE memory_meta SET mode='off'");
    const seed = new Store(selection);
    const a = seed.createBot(), b = seed.createBot();
    for (let i = 0; i < 450; i++) seed.appendMessage(a.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `a line ${i}` });
    for (let i = 0; i < 30; i++) seed.appendMessage(b.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `b line ${i}` });
    // (a new bot's thread starts with the greeting rows the store writes: every message of the thread counts but Murage's own lines, which
    // capture never takes: LINEAGE S6 rule 22)
    const total = (threadId: string) => new Store(selection).messagesFor(threadId).filter(message => !isMurageVoice(message)).length;
    return { a, b, totalA: total(a.threadId), totalB: total(b.threadId), roster: { bots: [{ id: a.id, threadId: a.threadId }, { id: b.id, threadId: b.threadId }], groups: [] } };
  }
  const sources = (threadId: string) => Number(database().prepare("SELECT count(*) AS n FROM memory_sources WHERE thread_id=?").get(threadId)!.n);

  it("lists every conversation once, queues every message through the capture path in slices, resumes, and never twice", () => {
    const { a, b, totalA, totalB, roster } = seeded();
    const db = database();
    reconcileMemoryRoster(roster);
    db.exec("UPDATE memory_meta SET mode='active'");
    const store = new Store(selection);
    expect(listPastChatThreads(roster)).toBe(2);
    expect(listPastChatThreads(roster)).toBe(0);
    // a few slices, then a "restart": a new reader resumes after the last committed message
    let steps = 0;
    for (; steps < 3; steps++) expect(stepPastChatsBuild(db, store, { budgetMs: 1 }).done).toBe(false);
    const partial = sources(a.threadId) + sources(b.threadId);
    expect(partial).toBeGreaterThan(0);
    const again = new Store(selection);
    runPastChatsBuildNow(db, again, roster);
    expect(sources(a.threadId)).toBe(totalA);
    expect(sources(b.threadId)).toBe(totalB);
    expect(pastChatsCounters(db)).toEqual({ threads: 2, threadsDone: 2, messagesQueued: totalA + totalB, running: false });
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_jobs").get()!.n)).toBeGreaterThanOrEqual(totalA + totalB);
    // again: nothing is queued twice
    db.prepare(`UPDATE ${BACKFILL_THREADS_TABLE} SET done=0,last_message_id=NULL`).run();
    expect(runPastChatsBuildNow(db, new Store(selection), roster)).toBe(0);
    expect(sources(a.threadId)).toBe(totalA);
  });

  it("a branch switch between slices: the stale reader captures nothing from the abandoned branch, and the new branch is read", () => {
    database().exec("UPDATE memory_meta SET mode='off'");
    const seed = new Store(selection);
    const bot = seed.createBot();
    const lineA: string[] = [];
    for (let i = 0; i < 450; i++) lineA.push(seed.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `a line ${i}` }).id);
    // a second version forked at line 100, then the view goes back to the first branch
    const fork = seed.appendMessage(bot.threadId, { role: "user", kind: "text", text: "another version", parentId: lineA[100] });
    expect(seed.setActiveLeaf(bot.threadId, lineA[449]!)).toBe(lineA[449]);
    const roster = { bots: [{ id: bot.id, threadId: bot.threadId }], groups: [] };
    const db = database();
    reconcileMemoryRoster(roster);
    db.exec("UPDATE memory_meta SET mode='active'");
    const store = new Store(selection);
    listPastChatThreads(roster);
    // one slice reads the oldest page of the first branch (200 rows: the greeting rows and lines below 100), then the owner switches
    let step = stepPastChatsBuild(db, store, { budgetMs: Number.POSITIVE_INFINITY });
    while (step.queued === 0 && !step.done) step = stepPastChatsBuild(db, store, { budgetMs: Number.POSITIVE_INFINITY });
    const abandoned = new Set(lineA.slice(101));
    expect(abandoned.size).toBe(349);
    const state = (id: string) => db.prepare("SELECT state FROM memory_sources WHERE id=?").get(`message:${bot.threadId}:${id}`)?.state;
    expect(lineA.slice(101).filter(id => state(id) !== undefined)).toEqual([]);
    expect(store.setActiveLeaf(bot.threadId, fork.id)).toBe(fork.id);
    while (!stepPastChatsBuild(db, store, { budgetMs: Number.POSITIVE_INFINITY }).done) { /* to the end */ }
    // nothing of the abandoned branch was captured as active; the new branch is complete
    const activeAbandoned = db.prepare("SELECT message_id AS id FROM memory_sources WHERE thread_id=? AND state='active'").all(bot.threadId).map(row => String(row.id)).filter(id => abandoned.has(id));
    expect(activeAbandoned).toEqual([]);
    expect(state(fork.id)).toBe("active");
    for (const id of lineA.slice(0, 101)) expect(state(id)).toBe("active");
  });

  it("messages appended to the same branch between slices keep the reader (no restart)", () => {
    const { a, totalA, roster } = seeded();
    const db = database();
    reconcileMemoryRoster({ bots: [roster.bots[0]!], groups: [] });
    listPastChatThreads({ bots: [roster.bots[0]!], groups: [] });
    db.exec("UPDATE memory_meta SET mode='active'");
    const store = new Store(selection);
    let step = stepPastChatsBuild(db, store, { budgetMs: Number.POSITIVE_INFINITY });
    while (step.queued === 0 && !step.done) step = stepPastChatsBuild(db, store, { budgetMs: Number.POSITIVE_INFINITY });
    const first = step.queued;
    // a live message (captured live, memory is on) extends the head: the open reader is still on the branch
    store.appendMessage(a.threadId, { role: "user", kind: "text", text: "a new line" });
    const next = stepPastChatsBuild(db, store, { budgetMs: Number.POSITIVE_INFINITY });
    expect(next.queued).toBeGreaterThan(0);
    while (!stepPastChatsBuild(db, store, { budgetMs: Number.POSITIVE_INFINITY }).done) { /* to the end */ }
    expect(first).toBeGreaterThan(0);
    // every message of the conversation is captured (the new line by the live path, if it took it, else by nobody yet: never twice)
    expect(sources(a.threadId)).toBeGreaterThanOrEqual(totalA);
    expect(sources(a.threadId)).toBeLessThanOrEqual(totalA + 1);
  });

  it("an excluded conversation and a memory that is off queue nothing", async () => {
    const { a, b, totalA, roster } = seeded();
    const db = database();
    reconcileMemoryRoster(roster);
    // memory off: the build queues nothing
    runPastChatsBuildNow(db, new Store(selection), roster);
    expect(sources(a.threadId) + sources(b.threadId)).toBe(0);
    db.exec("UPDATE memory_meta SET mode='active'");
    await memoryOwnerRoute("/api/memory/action", { action: "configure", excludedThreadIds: [b.threadId] }, ownerMemoryTicket(), roster);
    db.prepare(`UPDATE ${BACKFILL_THREADS_TABLE} SET done=0,last_message_id=NULL`).run();
    runPastChatsBuildNow(db, new Store(selection), roster);
    expect(sources(a.threadId)).toBe(totalA);
    expect(sources(b.threadId)).toBe(0);
  });
});
