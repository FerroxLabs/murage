// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ROUTINE-DELIVER-1010: a routine's result lands in the chat it was made in (server/routine-delivery.ts), exactly once.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { initializeArtifacts, publicationUnsettled, runPublishedArtifactIds } from "./artifacts.ts";
import { deliverRoutineRun, routineNextStep, routineResultId, ROUTINE_RESULT_FILES_MAX, type DeliveryBot, type RoutineDeliveryDeps } from "./routine-delivery.ts";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

const START = new Date(2026, 9, 29, 8, 0, 0).getTime();

function managerOptions(file?: string) {
  let now = START, task = 0;
  const started: string[] = [];
  const changed: RoutineRun[] = [];
  const dir = file ? undefined : mkdtempSync(join(tmpdir(), "murage-routine-deliver-"));
  if (dir) dirs.push(dir);
  const options: RoutineManagerOptions = {
    file: file ?? join(dir!, "routines.json"),
    now: () => now,
    botState: () => "ready",
    createTask: () => ({ threadId: `run-thread-${++task}` }),
    startTurn: async (_botId, threadId) => { started.push(threadId); },
    onRunChanged: (run) => changed.push(run),
  };
  return { options, started, changed, setNow: (value: number) => { now = value; }, nowValue: () => now };
}

/** A store with a bot, its chats, and counters for every read it is asked to do. `owner` lists the owner's own unshared chats. */
function fakeChats(input: { chats: string[]; active: string; owner?: string[] }) {
  const threads = new Map<string, Message[]>(input.chats.map((id) => [id, []]));
  const ownerChats = new Set(input.owner ?? input.chats);
  const bot: DeliveryBot = { id: "bot-a", name: "Painter", color: "#123" };
  let active = input.active;
  const calls = { messageById: 0, append: 0, patch: 0, unread: 0, runFiles: [] as Array<{ from: number; to: number; limit: number }>, recorded: [] as string[] };
  let files: string[] = [];
  let at = 0;
  const lostAccess = new Set<string>();
  const manager: { current?: RoutineManager } = {};
  const deps: RoutineDeliveryDeps = {
    owner: (_run, threadId) => (threads.has(threadId) && !lostAccess.has(threadId) ? { bot } : null),
    // the index.ts rule: the owner's own unshared home chat, never the routine's own conversation
    mainChat: (run) => {
      const pick = [active, ...threads.keys()].find((id) => id !== run.threadId && threads.has(id) && ownerChats.has(id));
      return pick ? { bot, threadId: pick } : null;
    },
    isMainChat: (run, threadId) => (threadId !== run.threadId && threads.has(threadId) && ownerChats.has(threadId) ? { bot } : null),
    threadExists: (threadId) => threads.has(threadId),
    messageById: (threadId, id) => { calls.messageById++; return threads.get(threadId)?.find((message) => message.id === id); },
    appendMessage: (threadId, message, stableId) => {
      const rows = threads.get(threadId)!;
      const held = rows.find((row) => row.id === stableId);
      if (held) return held;
      calls.append++;
      const full = { ...message, id: stableId, at: ++at } as Message;
      rows.push(full);
      return full;
    },
    patchMessage: (threadId, id, patch) => {
      calls.patch++;
      const rows = threads.get(threadId)!;
      const index = rows.findIndex((row) => row.id === id);
      rows[index] = { ...rows[index]!, ...patch };
    },
    markUnread: () => { calls.unread++; },
    runFiles: (query) => { calls.runFiles.push({ from: query.from, to: query.to, limit: query.limit }); return files.slice(0, query.limit); },
    recordDelivery: (runId, threadId) => { calls.recorded.push(threadId); manager.current?.recordRunDelivery(runId, threadId); },
  };
  return {
    threads, bot, calls, deps, manager,
    setFiles: (ids: string[]) => { files = ids; },
    setActive: (id: string) => { active = id; },
    loseAccess: (id: string) => { lostAccess.add(id); },
    deleteChat: (id: string) => { threads.delete(id); },
    cards: () => [...threads.entries()].flatMap(([threadId, rows]) => rows.filter((row) => row.kind === "routine.run").map((row) => ({ threadId, row }))),
  };
}

/** The index.ts wiring, minus the wait for publication: non-final transitions upsert, the settle writes once and marks. */
function wire(manager: RoutineManager, chats: ReturnType<typeof fakeChats>) {
  chats.manager.current = manager;
  return (run: RoutineRun) => {
    if (!run.delivery || run.delivery.state !== "pending") return;
    const settled = !["queued", "running", "waiting", "needs-you"].includes(run.status);
    if (!settled) { deliverRoutineRun(run, chats.deps, false); return; }
    const latest = manager.runById(run.id)!;
    deliverRoutineRun(latest, chats.deps, true);
    manager.markRunDelivered(run.id);
  };
}

function withSource(file: string, routineId: string, sourceThreadId: string) {
  const disk = JSON.parse(readFileSync(file, "utf8"));
  disk.routines = disk.routines.map((routine: { id: string }) => (routine.id === routineId ? { ...routine, sourceThreadId } : routine));
  writeFileSync(file, JSON.stringify(disk));
}

function createRoutine(manager: RoutineManager, extra: { deliverTo?: "chat" | "list" } = {}) {
  return manager.create({ name: "Morning picture", prompt: "Paint the sunrise", botId: "bot-a", enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] }, ...extra });
}

async function completeRun(manager: RoutineManager, h: ReturnType<typeof managerOptions>, routineId: string, ok = true) {
  const queued = manager.runNow(routineId)!;
  await manager.tick();
  const threadId = h.started.at(-1)!;
  h.setNow(h.nowValue() + 60_000);
  manager.handleRuntimeEvent({ eventId: `${threadId}-done`, provider: "fake", threadId, createdAt: new Date().toISOString(), type: "turn.completed", ok, ...(ok ? {} : { stopReason: "crashed" }) });
  return manager.runById(queued.id)!;
}

describe("routine results reach the chat they were made in", () => {
  it("posts one card with the reply and the run's files in the source chat, updated in place across the run", async () => {
    const h = managerOptions();
    let manager = new RoutineManager(h.options);
    const routine = createRoutine(manager);
    withSource(h.options.file!, routine.id, "main-chat");
    const chats = fakeChats({ chats: ["main-chat", "other-chat"], active: "other-chat" });
    manager = new RoutineManager({ ...h.options, onRunChanged: (run) => deliver(run) });
    const deliver = wire(manager, chats);
    chats.setFiles(["file-1", "file-2"]);
    const run = await completeRun(manager, h, routine.id);
    expect(run.status).toBe("completed");
    const cards = chats.cards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ threadId: "main-chat", row: { id: routineResultId(run.id), artifactIds: ["file-1", "file-2"], routineRun: { runId: run.id, status: "completed", executionThreadId: run.threadId } } });
    expect(chats.threads.get("other-chat")).toHaveLength(0);
    // the chat is recorded on the run before its first card
    expect(chats.calls.recorded).toEqual(["main-chat"]);
    expect(run.delivery).toEqual({ state: "sent", threadId: "main-chat" });
  });

  it("falls back to the bot's main chat when the routine has no chat or its chat was deleted, and records that chat first", async () => {
    for (const setup of ["none", "deleted"] as const) {
      const h = managerOptions();
      let manager = new RoutineManager(h.options);
      const routine = createRoutine(manager);
      const chats = fakeChats({ chats: ["made-here", "main-chat"], active: "main-chat" });
      if (setup === "deleted") { withSource(h.options.file!, routine.id, "made-here"); chats.deleteChat("made-here"); }
      manager = new RoutineManager({ ...h.options, onRunChanged: (run) => deliver(run) });
      const deliver = wire(manager, chats);
      const run = await completeRun(manager, h, routine.id);
      const cards = chats.cards();
      expect(cards.map((card) => card.threadId)).toEqual(["main-chat"]);
      expect(run.delivery).toEqual({ state: "sent", threadId: "main-chat" });
      expect(chats.calls.recorded).toEqual(["main-chat"]);
    }
  });

  it("keeps the card where it is when its chat still exists but no longer passes the check, and never posts to a chat that is not the owner's own", async () => {
    const h = managerOptions();
    let manager = new RoutineManager(h.options);
    const routine = createRoutine(manager);
    withSource(h.options.file!, routine.id, "room-chat");
    const chats = fakeChats({ chats: ["room-chat", "main-chat"], active: "main-chat", owner: ["main-chat"] });
    manager = new RoutineManager({ ...h.options, onRunChanged: (run) => deliver(run) });
    let lose = false;
    const deliver = (run: RoutineRun) => { if (lose) chats.loseAccess("room-chat"); inner(run); };
    const inner = wire(manager, chats);
    const queued = manager.runNow(routine.id)!;
    expect(chats.cards().map((card) => card.threadId)).toEqual(["room-chat"]);
    await manager.tick();
    lose = true;
    const threadId = h.started.at(-1)!;
    manager.handleRuntimeEvent({ eventId: `${threadId}-done`, provider: "fake", threadId, createdAt: new Date().toISOString(), type: "turn.completed", ok: true });
    expect(manager.runById(queued.id)!.status).toBe("completed");
    // one card, still in the room chat: no second card in the main chat
    expect(chats.cards().map((card) => card.threadId)).toEqual(["room-chat"]);
    // a bot with no chat of the owner's own gets nothing rather than a post into a shared or channel chat
    const h2 = managerOptions();
    const lonely = fakeChats({ chats: ["channel-chat"], active: "channel-chat", owner: [] });
    const m2 = new RoutineManager({ ...h2.options, onRunChanged: (run) => d2(run) });
    const d2 = wire(m2, lonely);
    await completeRun(m2, h2, createRoutine(m2).id);
    expect(lonely.cards()).toHaveLength(0);
  });

  it("gives way to the main chat only when the recorded chat was deleted, and never reaches into the next run's files", async () => {
    const h = managerOptions();
    let manager = new RoutineManager(h.options);
    const routine = createRoutine(manager);
    withSource(h.options.file!, routine.id, "made-here");
    const chats = fakeChats({ chats: ["made-here", "main-chat"], active: "main-chat" });
    manager = new RoutineManager({ ...h.options, onRunChanged: () => {} });
    chats.manager.current = manager;
    const run = await completeRun(manager, h, routine.id);
    deliverRoutineRun(run, chats.deps, false);
    chats.deleteChat("made-here");
    const latest = manager.runById(run.id)!;
    expect(latest.delivery?.threadId).toBe("made-here");
    expect(deliverRoutineRun(latest, chats.deps, true, latest.finishedAt! + 1_000)).toBe("main-chat");
    expect(chats.calls.runFiles.at(-1)).toMatchObject({ to: latest.finishedAt! + 1_000 });
    expect(manager.runById(run.id)!.delivery?.threadId).toBe("main-chat");
  });

  it("never treats the routine's own conversation as the main chat", async () => {
    const h = managerOptions();
    const chats = fakeChats({ chats: ["run-thread-1", "older-chat"], active: "run-thread-1" });
    const manager = new RoutineManager({ ...h.options, onRunChanged: (run) => deliver(run) });
    const deliver = wire(manager, chats);
    const routine = createRoutine(manager);
    await completeRun(manager, h, routine.id);
    expect(chats.cards().map((card) => card.threadId)).toEqual(["older-chat"]);
  });

  it("a failed run posts one line with its next step, never silence", async () => {
    const h = managerOptions();
    const chats = fakeChats({ chats: ["main-chat"], active: "main-chat" });
    const manager = new RoutineManager({ ...h.options, onRunChanged: (run) => deliver(run) });
    const deliver = wire(manager, chats);
    const routine = createRoutine(manager);
    chats.setFiles(["should-not-show"]);
    const run = await completeRun(manager, h, routine.id, false);
    expect(run.status).toBe("failed");
    const [card] = chats.cards();
    expect(chats.cards()).toHaveLength(1);
    expect(card!.row.routineRun).toMatchObject({ status: "failed", nextStep: "Open the run to see what happened, or run it again from Routines." });
    expect(card!.row.routineRun!.nextStep).not.toMatch(/—/);
    expect(card!.row.artifactIds).toBeUndefined();
    expect(card!.row.text).toContain("failed");
  });

  it("Routines list only posts nothing; switching back to chat applies to the next run", async () => {
    const h = managerOptions();
    const chats = fakeChats({ chats: ["main-chat"], active: "main-chat" });
    const manager = new RoutineManager({ ...h.options, onRunChanged: (run) => deliver(run) });
    const deliver = wire(manager, chats);
    const routine = createRoutine(manager, { deliverTo: "list" });
    expect(manager.listRoutines()[0]).toMatchObject({ deliverTo: "list" });
    const first = await completeRun(manager, h, routine.id);
    expect(first.delivery).toEqual({ state: "off" });
    expect(chats.cards()).toHaveLength(0);
    manager.update(routine.id, { deliverTo: "chat" });
    expect(manager.listRoutines()[0]).not.toHaveProperty("deliverTo");
    h.setNow(h.nowValue() + 60_000);
    await completeRun(manager, h, routine.id);
    expect(chats.cards()).toHaveLength(1);
    expect(() => manager.update(routine.id, { deliverTo: "somewhere" as never })).toThrow("Choose where this routine sends its results");
  });

  it("is exactly once across a restart: a settled run left pending is written at start-up, a written one is only patched", async () => {
    const h = managerOptions();
    const chats = fakeChats({ chats: ["main-chat"], active: "main-chat" });
    // the process stops after the run settles and before its result is written (no delivery wired)
    let manager = new RoutineManager(h.options);
    const routine = createRoutine(manager);
    const run = await completeRun(manager, h, routine.id);
    expect(run.delivery).toEqual({ state: "pending" });
    // start-up 1: the pending run is written, then the process stops again before it is marked
    manager = new RoutineManager({ ...h.options, onRunChanged: () => {} });
    chats.manager.current = manager;
    expect(manager.pendingDeliveries().map((item) => item.id)).toEqual([run.id]);
    deliverRoutineRun(manager.pendingDeliveries()[0]!, chats.deps, true);
    expect(chats.cards()).toHaveLength(1);
    // start-up 2: still pending, so it is delivered again: the same row is patched, never a second one
    manager = new RoutineManager({ ...h.options, onRunChanged: () => {} });
    chats.manager.current = manager;
    const again = manager.pendingDeliveries();
    expect(again.map((item) => item.id)).toEqual([run.id]);
    expect(again[0]!.delivery).toEqual({ state: "pending", threadId: "main-chat" });
    deliverRoutineRun(again[0]!, chats.deps, true);
    manager.markRunDelivered(run.id);
    expect(chats.cards()).toHaveLength(1);
    expect(chats.calls.append).toBe(1);
    expect(chats.calls.patch).toBe(1);
    // start-up 3: nothing is owed
    manager = new RoutineManager({ ...h.options, onRunChanged: () => {} });
    expect(manager.pendingDeliveries()).toEqual([]);
    expect(manager.runById(run.id)!.delivery).toEqual({ state: "sent", threadId: "main-chat" });
  });

  it("leaves runs from before 1.0.10 and room runs on their own path", async () => {
    const h = managerOptions();
    const manager = new RoutineManager({ ...h.options, goalState: () => "busy" });
    const room = manager.create({ name: "Room goal", prompt: "Plan", botId: "bot-a", target: "room-goal", groupId: "group-1", enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] } });
    expect(manager.runNow(room.id)!.delivery).toBeUndefined();
    const routine = createRoutine(manager);
    const run = await completeRun(manager, h, routine.id);
    const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
    expect(disk.routines[0]).not.toHaveProperty("deliverTo");
    const legacy = { ...run, delivery: undefined };
    const chats = fakeChats({ chats: ["main-chat"], active: "main-chat" });
    expect(deliverRoutineRun(legacy, chats.deps, true)).toBeNull();
    expect(deliverRoutineRun({ ...run, target: "room-goal", sourceThreadId: undefined }, chats.deps, true)).toBeNull();
    expect(chats.cards()).toHaveLength(0);
  });

  it("costs O(1) per run: one card lookup and one bounded files query, whatever the history", async () => {
    const h = managerOptions();
    const chats = fakeChats({ chats: ["main-chat"], active: "main-chat" });
    // a long-used chat: its history is never read
    const rows = chats.threads.get("main-chat")!;
    for (let index = 0; index < 5_000; index++) rows.push({ id: `old-${index}`, at: index, role: "bot", kind: "text", text: "old" } as Message);
    const manager = new RoutineManager({ ...h.options, onRunChanged: (run) => deliver(run) });
    const deliver = wire(manager, chats);
    const routine = createRoutine(manager);
    chats.setFiles(Array.from({ length: 40 }, (_, index) => `file-${index}`));
    const run = await completeRun(manager, h, routine.id);
    const card = chats.cards()[0]!.row;
    expect(card.artifactIds).toHaveLength(ROUTINE_RESULT_FILES_MAX);
    expect(card.routineRun!.moreFiles).toBe(true);
    expect(chats.calls.runFiles).toEqual([{ from: run.startedAt, to: run.finishedAt! + 5 * 60_000, limit: ROUTINE_RESULT_FILES_MAX + 1 }]);
    // queued, running, completed: one indexed lookup per write, no scan
    expect(chats.calls.messageById).toBeLessThanOrEqual(3);
  });
});

describe("the run's published files", () => {
  it("reads the outputs published in the run's own conversation in its window, through the stage index, and sees outputs still saving", () => {
    const db = new DatabaseSync(":memory:");
    initializeArtifacts(db);
    const insert = db.prepare("INSERT INTO output_publications (id,producer,bot_id,thread_id,run_id,path_token,sha256,mime,bytes,stage,artifact_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const add = (id: string, at: number, opts: { bot?: string; thread?: string; stage?: string; updated?: number; artifact?: string | null } = {}) =>
      insert.run(id, "shell-output", opts.bot ?? "bot-a", opts.thread ?? "run-thread", "turn", id, id, "image/png", 1, opts.stage ?? "registered", opts.artifact === undefined ? `art-${id}` : opts.artifact, at, opts.updated ?? at);
    add("before", 50); add("in-1", 100); add("in-2", 150, { updated: 9_000 }); add("other-thread", 120, { thread: "chat" }); add("other-bot", 120, { bot: "bot-b" });
    add("after", 500); add("saving", 160, { stage: "attached", artifact: null });
    const query = { botId: "bot-a", threadId: "run-thread", from: 100, to: 200, limit: 13 };
    // in-2's card was written after a restart (updated later): it is still this run's
    expect(runPublishedArtifactIds(db, query)).toEqual(["art-in-1", "art-in-2"]);
    expect(runPublishedArtifactIds(db, { ...query, limit: 1 })).toEqual(["art-in-1"]);
    expect(publicationUnsettled(db, { botId: "bot-a", threadId: "run-thread", since: 100 })).toBe(true);
    expect(publicationUnsettled(db, { botId: "bot-a", threadId: "run-thread", since: 200 })).toBe(false);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT artifact_id AS id FROM output_publications INDEXED BY output_publications_stage WHERE stage='registered' AND updated_at>=? AND bot_id=? AND thread_id=? AND created_at>=? AND created_at<=? AND artifact_id IS NOT NULL ORDER BY created_at ASC, id LIMIT ?").all(1, "b", "t", 1, 2, 1) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toMatch(/USING INDEX output_publications_stage \(stage=\? AND updated_at>\?\)/);
    db.close();
  });
});

describe("delivery markers are on disk before they count", () => {
  it("a failed save leaves the old marker, so the card is not written and nothing is marked sent", async () => {
    const h = managerOptions();
    const manager = new RoutineManager(h.options);
    const run = await completeRun(manager, h, createRoutine(manager).id);
    const internal = manager as unknown as { save: (options?: unknown) => void };
    const save = internal.save.bind(manager);
    internal.save = () => { throw new Error("disk full"); };
    expect(() => manager.recordRunDelivery(run.id, "main-chat")).toThrow("disk full");
    expect(manager.runById(run.id)!.delivery).toEqual({ state: "pending" });
    expect(() => manager.markRunDelivered(run.id)).toThrow("disk full");
    expect(manager.runById(run.id)!.delivery).toEqual({ state: "pending" });
    const chats = fakeChats({ chats: ["main-chat"], active: "main-chat" });
    chats.manager.current = manager;
    expect(() => deliverRoutineRun(manager.runById(run.id)!, chats.deps, true)).toThrow("disk full");
    expect(chats.cards()).toHaveLength(0);
    internal.save = save;
    expect(deliverRoutineRun(manager.runById(run.id)!, chats.deps, true)).toBe("main-chat");
  });

  it("says what to do next in plain words that are true for every schedule", () => {
    expect(routineNextStep({ status: "missed", threadId: undefined })).toBe("Murage was not running when this was due. Run it now from Routines.");
    expect(routineNextStep({ status: "failed", threadId: undefined })).toBe("Run it again from Routines, or ask your bot what went wrong.");
    expect(routineNextStep({ status: "completed", threadId: "t" })).toBeUndefined();
  });
});
