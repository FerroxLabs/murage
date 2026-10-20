// SPDX-License-Identifier: AGPL-3.0-or-later
// Idle roster broadcasts must not scale with thread count: every broadcast stamps each task through store.lastActivityAt
// (withLastActivity in index.ts), and a thread not held in memory used to cost one `SELECT at FROM messages WHERE thread_id=?` each time.
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDirSync } from "./testing/cleanup.ts";
let home: string;

async function reopenedStore(threads: number) {
  home = mkdtempSync(join(tmpdir(), "murage-idle-scan-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  const writer = new Store(() => ({ instanceId: "claude", model: "m" }));
  const bot = writer.createBot(undefined, { seedMessages: false });
  const ids: string[] = [];
  for (let i = 0; i < threads; i++) {
    const task = writer.createTask(bot.id)!;
    writer.appendMessage(task.threadId, { role: "user", kind: "text", text: `m${i}`, at: 1_000 + i });
    ids.push(task.threadId);
  }
  // a fresh Store holds no thread in memory, as after a restart: the idle case
  const store = new Store(() => ({ instanceId: "claude", model: "m" }));
  return { store, writer, ids };
}

/** Counts (and records the callers of) the newest-message query while `run` executes. */
async function countLastAtQueries(run: () => void): Promise<{ count: number; callers: Set<string> }> {
  const { database } = await import("./database.ts");
  const handle = database();
  const original = handle.prepare.bind(handle);
  let count = 0;
  const callers = new Set<string>();
  (handle as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (/SELECT at FROM messages WHERE thread_id\s*=\s*\?/.test(sql)) {
      count++;
      const frame = (new Error().stack ?? "").split("\n").slice(2, 5).map((l) => l.trim().replace(/\(.*[\\/]/, "(")).join(" <- ");
      callers.add(frame);
    }
    return original(sql);
  };
  try { run(); } finally { delete (handle as unknown as { prepare?: unknown }).prepare; }
  return { count, callers };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  removeTempDirSync(home);
});

describe("idle roster broadcasts", () => {
  const broadcast = (store: { lastActivityAt(id: string): number | undefined }, ids: string[]) => { for (const id of ids) store.lastActivityAt(id); };

  it("names store.lastActivityAt as the caller of the newest-message query", async () => {
    const { store, ids } = await reopenedStore(5);
    const { callers } = await countLastAtQueries(() => broadcast(store, ids));
    expect([...callers].join("\n")).toMatch(/newestMessageAt/);
    expect([...callers].join("\n")).toMatch(/lastActivityAt/);
  });

  it("costs a constant number of queries per broadcast, however many threads exist", async () => {
    const per: number[] = [];
    for (const threads of [3, 60]) {
      const { store, ids } = await reopenedStore(threads);
      broadcast(store, ids); // the first broadcast may read each thread once
      const { count } = await countLastAtQueries(() => { for (let i = 0; i < 20; i++) broadcast(store, ids); });
      per.push(count);
      const { closeMessageDb } = await import("./message-db.ts");
      closeMessageDb();
      removeTempDirSync(home);
    }
    console.log("IDLE_SCAN_COUNTS warm 20 broadcasts, threads 3 and 60:", JSON.stringify(per));
    expect(per).toEqual([0, 0]);
  });

  // One process holds one Store, and every message write goes through it: the writes below are made by the same Store the
  // broadcasts read, as the server's are (a second Store in one process is not a thing the server does).
  it("a write to one thread costs no re-read of any thread, and the next broadcast shows it", async () => {
    const { store, ids } = await reopenedStore(40);
    broadcast(store, ids);
    store.appendMessage(ids[7]!, { role: "bot", kind: "text", text: "new", at: 50_000 });
    const { count } = await countLastAtQueries(() => { for (let i = 0; i < 10; i++) broadcast(store, ids); });
    expect(count).toBe(0);
    expect(store.lastActivityAt(ids[7]!)).toBe(50_000);
    expect(store.lastActivityAt(ids[8]!)).toBe(1_008);
  });

  it("stays correct when a thread gains messages or is deleted", async () => {
    const { store, ids } = await reopenedStore(3);
    const [a, b] = ids as [string, string];
    expect(store.lastActivityAt(a)).toBe(1_000);
    store.appendMessage(a, { role: "bot", kind: "text", text: "later", at: 9_000 });
    expect(store.lastActivityAt(a)).toBe(9_000);
    expect(store.lastActivityAt(b)).toBe(1_001);
    store.appendMessage(b, { role: "bot", kind: "text", text: "tail", at: 12_000 });
    expect(store.lastActivityAt(b)).toBe(12_000);
    const botId = store.bots.find((bot) => bot.tasks?.some((task) => task.threadId === a))!.id;
    store.deleteTask(botId, a);
    expect(store.lastActivityAt(a)).toBeUndefined();
    expect(store.lastActivityAt(b)).toBe(12_000);
  });
});

describe("the newest-at cache", () => {
  it("is capped, evicts the least recently used thread, and keeps answering correctly", async () => {
    const { store, ids } = await reopenedStore(6);
    const { NEWEST_AT_CAP } = await import("./message-db.ts");
    expect(NEWEST_AT_CAP).toBeGreaterThanOrEqual(1024);
    // lookups of far more threads than the cap, none of which exist: nulls are held too, and still bounded
    const { newestMessageAt } = await import("./message-db.ts");
    for (let i = 0; i < NEWEST_AT_CAP + 50; i++) expect(newestMessageAt(`ghost-${i}`)).toBeNull();
    // the earliest ghost was evicted: it costs one read again; a recent one does not
    const evicted = await countLastAtQueries(() => { newestMessageAt("ghost-0"); });
    expect(evicted.count).toBe(1);
    const recent = await countLastAtQueries(() => { newestMessageAt(`ghost-${NEWEST_AT_CAP + 49}`); });
    expect(recent.count).toBe(0);
    expect(store.lastActivityAt(ids[2]!)).toBe(1_002);
  });

  it("a hit touches neither the filesystem nor the database", async () => {
    const { store, ids } = await reopenedStore(3);
    expect(store.lastActivityAt(ids[1]!)).toBe(1_001); // warms the entry
    const { DATA_DIR } = await import("./config.ts");
    const file = join(DATA_DIR, "messages.db");
    unlinkSync(file); // an existence check would now notice and reopen; a hit must not look
    const { newestMessageAt } = await import("./message-db.ts");
    const { databaseGeneration } = await import("./database.ts");
    const before = databaseGeneration();
    const tid = ids[1]!;
    expect(newestMessageAt(tid)).toBe(1_001);
    expect(databaseGeneration()).toBe(before);
  });
});

describe("the task window cache", () => {
  it("an idle roster broadcast does no windowing work, and any task, usage, grant or run write rebuilds it", async () => {
    const { createTaskAggregateCache, taskWindowWork } = await import("./task-window.ts");
    home = mkdtempSync(join(tmpdir(), "murage-idle-scan-"));
    vi.resetModules();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const fresh = await import("./store.ts");
    const store = new fresh.Store(() => ({ instanceId: "claude", model: "m" }));
    const bot = store.createBot(undefined, { seedMessages: false });
    for (let i = 0; i < 300; i++) store.createTask(bot.id);
    const cache = createTaskAggregateCache();
    const read = () => { const b = store.bot(bot.id)!; return cache.get(b.id, b.tasks!, b.threadId, String(store.revision), 10, () => undefined); };
    const first = read();
    expect(first.window.total).toBe(b0(store, bot.id));
    const base = { ...taskWindowWork };
    for (let i = 0; i < 50; i++) read();
    console.log("TASK_WINDOW_WORK idle 50 broadcasts, 301 tasks:", JSON.stringify({ builds: taskWindowWork.builds - base.builds, tasksVisited: taskWindowWork.tasksVisited - base.tasksVisited }));
    expect(taskWindowWork).toEqual(base);
    const n = (): number => taskWindowWork.builds;
    const tid = store.bot(bot.id)!.tasks![5]!.threadId;
    let before = n();
    store.patchTask(bot.id, tid, { pinned: true }); read();
    expect(n()).toBe(before + 1);
    before = n();
    store.addTaskUsage(bot.id, tid, { input: 5, output: 5, costUsd: 0.01, cachedInput: 0 }, "k1"); read();
    expect(n()).toBe(before + 1);
    expect(read().usage.input).toBe(5);
    before = n();
    store.setTaskActivity(bot.id, tid, "working"); read();
    expect(n()).toBe(before + 1);
    before = n();
    store.createTask(bot.id); read();
    expect(n()).toBe(before + 1);
    before = n();
    for (let i = 0; i < 20; i++) read();
    expect(n()).toBe(before);
  });
});
const b0 = (store: { bot(id: string): { tasks?: unknown[] } | null | undefined }, id: string) => store.bot(id)!.tasks!.length;

describe("the shared rows cache", () => {
  async function sharedFixture() {
    home = mkdtempSync(join(tmpdir(), "murage-idle-scan-"));
    vi.resetModules();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "m" }));
    const make = (name: string, section: string) => { const bot = store.createBot(undefined, { seedMessages: false }); store.patchBot(bot.id, { name, section }); return store.bot(bot.id)!; };
    const iris = make("Iris", "Design");
    for (let i = 0; i < 40; i++) make(`Peer${i}`, `Team${i % 8}`);
    store.patchBot(iris.id, { sharedWith: { mode: "all", teams: [] } } as never);
    const wire = await import("./shared-wire.ts");
    const { insertRoomRequest } = await import("./room-requests.ts");
    const { database } = await import("./database.ts");
    return { store, iris, wire, insertRoomRequest, database, make };
  }

  it("an idle broadcast builds nothing and visits nothing; each relevant write rebuilds exactly once", async () => {
    const { store, iris, wire, insertRoomRequest, database, make } = await sharedFixture();
    const read = () => wire.sharedRowsFor(store, store.bot(iris.id)!);
    const work = () => ({ ...wire.sharedRowsWork });
    const first = read();
    expect(first.length).toBeGreaterThan(0);
    let base = work();
    for (let i = 0; i < 50; i++) read();
    const idle = { builds: wire.sharedRowsWork.builds - base.builds, itemsVisited: wire.sharedRowsWork.itemsVisited - base.itemsVisited };
    console.log("SHARED_ROWS_WORK idle 50 broadcasts:", JSON.stringify(idle));
    expect(idle).toEqual({ builds: 0, itemsVisited: 0 });

    const rebuildsAfter = (write: () => void) => {
      const before = wire.sharedRowsWork.builds;
      write();
      read(); read(); read();
      return wire.sharedRowsWork.builds - before;
    };
    // a room request (the thread's load is part of the row)
    const team = read()[0]!;
    const task = store.createSharedWorkTask(iris.id, team.teamId ?? (await import("./team-identities.ts")).teamIdFor(team.teamName))!;
    expect(rebuildsAfter(() => { /* the task write above is read next */ })).toBe(1);
    const row = () => read().find(item => item.threadId === task.threadId)!;
    expect(row().waiting).toBe(0);
    let created = "";
    expect(rebuildsAfter(() => {
      created = insertRoomRequest(database(), { groupId: "g1", verb: "ask", fromKind: "bot", toBotId: iris.id, targetThreadId: task.threadId, admissionKey: "idle-scan-1", lineage: { rootThreadId: task.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false }, now: 1 }).request.id;
    })).toBe(1);
    expect(row().waiting).toBe(1);
    expect(rebuildsAfter(() => { database().prepare("UPDATE room_requests SET state='running' WHERE id=?").run(created); })).toBe(1);
    expect(row()).toMatchObject({ waiting: 0, working: true });
    // a channel membership / section change
    expect(rebuildsAfter(() => { store.createGroup("Ops", [iris.id], false, "Ops"); })).toBe(1);
    const group = store.groups.find(item => item.name === "Ops")!;
    expect(rebuildsAfter(() => { store.patchGroup(group.id, { memberIds: [iris.id, make("Late", "Late").id] }); })).toBe(1);
    expect(read().some(item => item.teamName === "Late" || item.teamName === "Ops")).toBe(true);
    // a task change on the bot
    expect(rebuildsAfter(() => { store.createTask(iris.id); })).toBe(1);
    // and then nothing again
    base = work();
    for (let i = 0; i < 20; i++) read();
    expect(work()).toEqual(base);
  });
});

describe("the group task window cache", () => {
  it("an idle channel broadcast does no windowing work; a channel task, member or room write rebuilds it once", async () => {
    const { createTaskAggregateCache, taskWindowWork } = await import("./task-window.ts");
    home = mkdtempSync(join(tmpdir(), "murage-idle-scan-"));
    vi.resetModules();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "m" }));
    const a = store.createBot(undefined, { seedMessages: false }), b = store.createBot(undefined, { seedMessages: false });
    const created = store.createGroup("Ops", [a.id], false, "Ops");
    for (let i = 0; i < 200; i++) store.createGroupTask(created.id, `t${i}`, false);
    const cache = createTaskAggregateCache();
    const read = () => { const g = store.group(created.id)!; return cache.get(g.id, g.tasks!, g.threadId, String(store.revision), 10, () => undefined); };
    read();
    let base = { ...taskWindowWork };
    for (let i = 0; i < 50; i++) read();
    console.log("GROUP_WINDOW_WORK idle 50 broadcasts, 201 tasks:", JSON.stringify({ builds: taskWindowWork.builds - base.builds, tasksVisited: taskWindowWork.tasksVisited - base.tasksVisited }));
    expect(taskWindowWork).toEqual(base);
    const rebuilds = (write: () => void) => { const before = taskWindowWork.builds; write(); read(); read(); return taskWindowWork.builds - before; };
    expect(rebuilds(() => { store.createGroupTask(created.id, "new", false); })).toBe(1);
    expect(rebuilds(() => { store.patchGroup(created.id, { memberIds: [a.id, b.id] }); })).toBe(1);
    expect(rebuilds(() => { store.deleteGroupTask(created.id, store.group(created.id)!.tasks![3]!.threadId); })).toBe(1);
    expect(rebuilds(() => { store.patchGroup(created.id, { name: "Ops2" }); })).toBe(1);
    base = { ...taskWindowWork };
    for (let i = 0; i < 20; i++) read();
    expect(taskWindowWork).toEqual(base);
  });
});

describe("the shared rows stamp", () => {
  it("50 idle broadcasts with the push flush running build nothing; only room request and team identity writes rebuild, once each", async () => {
    home = mkdtempSync(join(tmpdir(), "murage-idle-scan-"));
    vi.resetModules();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "m" }));
    const iris = store.createBot(undefined, { seedMessages: false });
    store.patchBot(iris.id, { name: "Iris", section: "Design", sharedWith: { mode: "all", teams: [] } } as never);
    for (let i = 0; i < 10; i++) { const b = store.createBot(undefined, { seedMessages: false }); store.patchBot(b.id, { section: `Team${i % 3}` }); }
    const wire = await import("./shared-wire.ts");
    const { database, databaseSharedRowsStamp } = await import("./database.ts");
    const { insertRoomRequest } = await import("./room-requests.ts");
    const { teamIdFor } = await import("./team-identities.ts");
    const { PushStore } = await import("./mobile-push-store.ts");
    const pushStore = new PushStore(() => database());
    const read = () => wire.sharedRowsFor(store, store.bot(iris.id)!);
    read();
    // the 5 s push flush: nothing has expired, so it must not move the stamp
    const stampBefore = databaseSharedRowsStamp();
    const builds0 = wire.sharedRowsWork.builds;
    for (let i = 0; i < 50; i++) { pushStore.prune(Date.now() + i); read(); }
    expect(wire.sharedRowsWork.builds - builds0).toBe(0);
    expect(databaseSharedRowsStamp()).toBe(stampBefore);
    // an unrelated write (a message, a DELETE that matches nothing) rebuilds nothing
    const task = store.createTask(iris.id)!;
    read();
    const rebuilds = (write: () => void) => { const b = wire.sharedRowsWork.builds; write(); read(); read(); return wire.sharedRowsWork.builds - b; };
    expect(rebuilds(() => { store.appendMessage(task.threadId, { role: "user", kind: "text", text: "hello", at: 5_000 }); })).toBe(0);
    expect(rebuilds(() => { database().prepare("DELETE FROM room_requests WHERE id='nope'").run(); })).toBe(0);
    // each room request or team identity write rebuilds exactly once
    let id = "";
    expect(rebuilds(() => { id = insertRoomRequest(database(), { groupId: "g1", verb: "ask", fromKind: "bot", toBotId: iris.id, targetThreadId: task.threadId, admissionKey: "stamp-1", lineage: { rootThreadId: task.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false }, now: 1 }).request.id; })).toBe(1);
    expect(rebuilds(() => { database().prepare("UPDATE room_requests SET state='running' WHERE id=?").run(id); })).toBe(1);
    expect(rebuilds(() => { teamIdFor("Brand New Team"); })).toBe(1);
    // a push prune that really expires rows touches no shared-row table
    expect(rebuilds(() => { pushStore.prune(Date.now() + 10 * 365 * 86_400_000); })).toBe(0);
  });
});
