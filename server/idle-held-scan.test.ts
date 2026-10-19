// SPDX-License-Identifier: AGPL-3.0-or-later
// The 30 s room sweep drains every bot's held work (index.ts drainHeldContinuations). It used to walk every historical thread of every bot
// and look each one up three times by linear search (Astra idle-scan r4: 150,015,000 comparisons for 10,000 tasks holding nothing). The
// drain now visits only the threads in the store's pending-work set; these tests count the comparisons, prove each kind of pending work is
// drained exactly as the full walk drained it, and cover the set's rebuild at load, its hourly reconcile and the push prune's indexes.
// Round 5 (Astra idle-scan r5): held room threads by map, the full walk's drain order, project reminders through the open-card lists,
// close records read again only after a change, the sliced reconcile, deletion leaving no stale entry, and the budget check's live budgets.
import { mkdtempSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDirSync } from "./testing/cleanup.ts";
let home = "";

async function freshHome() {
  if (home) await cleanup();
  home = mkdtempSync(join(tmpdir(), "murage-idle-held-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
}

async function cleanup() {
  if (!home) return;
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  removeTempDirSync(home);
  home = "";
}

afterEach(async () => { await cleanup(); vi.unstubAllEnvs(); });

const SOURCE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
// a Set: the walk adds the threads that came to hold work while it handed the loop back (1.0.3 L3 stall r1, kept beside this selection)
const NEW_SELECTION = "const threads = new Set(await store.pendingThreadsForSliced(botId, heldScanYield));";
/** The full walk the drain did before the pending set: every task thread of the bot, then every thread of its rooms. */
const LEGACY_SELECTION = "const threads = new Set([...store.tasks(botId).map(task => task.threadId), ...store.groups.filter(group => group.memberIds.includes(botId)).flatMap(group => [group.threadId, ...(group.tasks ?? []).map(task => task.threadId)])]);";

/** index.ts from noteHeldQueue through drainHeldContinuations, run against a real Store with inert outside services. */
async function extractDrain(store: unknown, scope: Record<string, unknown>, legacy = false) {
  const start = SOURCE.indexOf("function noteHeldQueue(");
  const end = SOURCE.indexOf("\nstore.onChange(change =>", start);
  let code = SOURCE.slice(start, end);
  expect(code).toContain(NEW_SELECTION);
  if (legacy) { code = code.replace(NEW_SELECTION, LEGACY_SELECTION); useLinearLookups(store as never); }
  const { heldScanYield } = await import("./held-scan.ts");
  const { runnableContinuation } = await import("./restore-fence.ts");
  const { heldQueueText, heldQueueWaiting } = await import("./external-context-delivery.ts");
  const context = {
    store, heldScanYield, runnableContinuation, heldQueueText, heldQueueWaiting,
    roomEngine: { ready: true }, routeHasTools: (caps?: { tools?: boolean }) => caps?.tools === true,
    registry: { get: (id: string) => ({ adapter: { capabilities: { tools: id !== "notools" } } }) },
    roomRequest: () => undefined, database: () => null, isTerminalRoomRequestState: () => true, roomDispatcher: { tick: () => {} },
    threadHumanPrincipal: () => ({ kind: "owner", personId: "owner" }), routines: undefined,
    turnSessionAudience: () => "owner", latestRoomUserMessage: () => undefined,
    startTurn: async () => {}, startCardContinuation: async () => {},
    ...scope,
  };
  return runInNewContext(stripTypeScriptTypes(code) + "\n({ drain: drainHeldContinuations, note: noteHeldQueue });", context) as {
    drain: (botId: string) => Promise<void>; note: (botId: string, threadId: string) => void;
  };
}

/** The store's thread lookups as they were before their maps (store.ts taskByThread, groupByThread, groupTaskByThread, continuationHolder). */
function useLinearLookups(store: import("./store.ts").Store) {
  store.taskByThread = (botId, threadId) => store.bot(botId)?.tasks?.find(t => t.threadId === threadId);
  store.groupTaskByThread = (groupId, threadId) => { const group = store.group(groupId); return !group || group.dm ? undefined : group.tasks?.find(task => task.threadId === threadId); };
  store.groupByThread = (threadId) => store.groups.find(group => group.threadId === threadId || group.tasks?.some(task => task.threadId === threadId));
  store.continuationHolder = (botId, threadId) => {
    const group = store.groupByThread(threadId);
    return store.taskByThread(botId, threadId) ?? (group?.dm ? group : group ? store.groupTaskByThread(group.id, threadId) : undefined);
  };
}

/** Counts every element an array search or walk visits (find, some, filter, map, ...) while `run` executes: the comparisons. */
async function countComparisons(run: () => Promise<void>): Promise<number> {
  const names = ["find", "findIndex", "some", "every", "filter", "map", "flatMap", "forEach", "includes", "indexOf"] as const;
  const proto = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const originals = new Map(names.map(name => [name, proto[name]!]));
  let count = 0;
  for (const name of names) {
    const original = originals.get(name)!;
    proto[name] = function (this: unknown[], first: unknown, ...rest: unknown[]) {
      if (typeof first === "function") return original.call(this, (...args: unknown[]) => { count++; return (first as (...a: unknown[]) => unknown)(...args); }, ...rest);
      count += this.length; // includes / indexOf: a linear search over the array
      return original.call(this, first, ...rest);
    };
  }
  try { await run(); } finally { for (const name of names) proto[name] = originals.get(name)!; }
  return count;
}

const owner = JSON.stringify({ kind: "owner", personId: "owner" });

/** One bot with `threads` historical tasks holding nothing (written straight into its record: 10,000 createTask calls would each save). */
async function idleFixture(threads: number) {
  await freshHome();
  const { Store } = await import("./store.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "m" }));
  const bot = store.createBot(undefined, { seedMessages: false });
  const record = store.bot(bot.id)!;
  record.tasks = [...(record.tasks ?? []), ...Array.from({ length: threads }, (_, i) => ({ threadId: `idle-${i}`, title: `t${i}`, createdAt: i, resumeCursors: {} }))];
  return { store, bot: record };
}

describe("the idle held drain", () => {
  it("costs a constant number of comparisons, however many tasks exist, when nothing is pending", async () => {
    const counts: Record<number, number> = {};
    for (const threads of [100, 10_000]) {
      const { store, bot } = await idleFixture(threads);
      const { drain } = await extractDrain(store, {});
      await drain(bot.id); // the first call may build the thread maps once
      counts[threads] = await countComparisons(async () => { for (let i = 0; i < 20; i++) await drain(bot.id); });
      expect(store.hasPendingWork()).toBe(false);
      expect(store.pendingThreadsFor(bot.id)).toEqual([]);
    }
    // the full walk at 10,000 tasks, measured the same way: one sweep
    const { store, bot } = await idleFixture(10_000);
    const { drain: legacy } = await extractDrain(store, {}, true);
    const before = await countComparisons(async () => { await legacy(bot.id); });
    console.log("IDLE_HELD_COMPARISONS", JSON.stringify({ before_one_sweep_10000: before, after_20_sweeps: counts }));
    expect(before).toBeGreaterThan(100_000_000);
    expect(counts[10_000]).toBe(counts[100]);
    expect(counts[10_000]).toBeLessThan(20 * 10);
  }, 120_000);

  it("the room sweep skips every bot when nothing is pending, and checks the records once an hour", () => {
    const sweep = SOURCE.slice(SOURCE.indexOf('guardedWriter("room-sweep"'), SOURCE.indexOf('guardedWriter("room-prune"'));
    expect(sweep).toContain("if (store.hasPendingWork()) for (const bot of store.bots) void drainHeldContinuations(bot.id);");
    // the hourly check walks the records in slices of the loop, one at a time
    expect(sweep).toMatch(/guardedWriter\("held-reconcile", \(\) => \{\s+if \(heldReconciling\) return;[\s\S]*?void store\.reconcilePendingWork\(heldScanYield\)[\s\S]*?\}\), 60 \* 60_000\)/);
  });
});

/** Every kind of pending work the drain consumes, among idle threads, on a bot and in a room. Labels name threads across twin runs. */
async function pendingFixture() {
  await freshHome();
  const { Store } = await import("./store.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "m" }));
  const bot = store.createBot(undefined, { seedMessages: false });
  const peer = store.createBot(undefined, { seedMessages: false });
  const labels = new Map<string, string>();
  const task = (label: string) => { const t = store.createTask(bot.id, label, false)!; labels.set(t.threadId, label); return t.threadId; };
  for (let i = 0; i < 30; i++) task(`idle-${i}`);
  // a held item the engine can take now
  const runnable = task("runnable");
  store.holdTaskContinuation(bot.id, runnable, "RUN_ME", { id: "run", dispatcher: "direct", principal: owner });
  // a held item waiting on its retry time, and one waiting on the owner's authority: visited, never sent
  const later = task("retry-later");
  store.holdTaskContinuation(bot.id, later, "LATER", { id: "later", dispatcher: "direct", principal: owner, state: "retry", error: "busy", retryAt: Date.now() + 3_600_000 });
  const authority = task("authority");
  store.holdTaskContinuation(bot.id, authority, "ASK_FIRST", { id: "auth", dispatcher: "direct", principal: owner, state: "authority", error: "needs you" });
  // messages owed an engine without tools: the queue row is written by the drain's look at the thread
  const owed = task("owed");
  store.taskByThread(bot.id, owed)!.modelSelection = { instanceId: "notools", model: "m" };
  const owedRow = store.appendMessage(owed, { role: "user", kind: "text", text: "delivered outside a turn" });
  store.recordTaskExternalUpdate(bot.id, owed, owedRow.id);
  // a queue row whose items already went out: the drain settles it
  const settled = task("settle");
  const queueRow = store.appendMessage(settled, { role: "bot", kind: "activity", actorKind: "murage", tool: { name: "1 item waiting", ok: true }, murage: { kind: "queue", held: { count: 1, items: [{ id: "gone", text: "gone" }] } } } as never);
  store.setTaskHeldQueueRow(bot.id, settled, queueRow.id);
  // a room's held item for this bot whose original request has ended
  const group = store.createGroup("Room", [bot.id, peer.id]);
  labels.set(group.threadId, "room");
  store.holdTaskContinuation(bot.id, group.threadId, "ROOM_ITEM", { id: "room", dispatcher: "room-request", requestId: "ended", principal: owner });
  for (let i = 0; i < 30; i++) task(`idle-late-${i}`);
  return { store, bot, peer, labels, group };
}

/** What the drain left behind, by label: held items, queue rows, and the turns it started, in order. */
async function drainOutcome(legacy: boolean) {
  const { store, bot, peer, labels } = await pendingFixture();
  const started: string[] = [];
  const visited: string[] = [];
  const { drain } = await extractDrain(store, {
    startTurn: async (botId: string, text: string, options: { threadId: string; heldContinuationId: string }) => {
      started.push(`${labels.get(options.threadId)}:${text}`);
      store.consumeTaskHeldContinuations(botId, options.threadId, [options.heldContinuationId]);
    },
  }, legacy);
  const holder = store.continuationHolder.bind(store);
  store.continuationHolder = ((botId: string, threadId: string) => { visited.push(labels.get(threadId) ?? threadId); return holder(botId, threadId); }) as typeof store.continuationHolder;
  for (let i = 0; i < 4; i++) { await drain(bot.id); await drain(peer.id); }
  store.continuationHolder = holder;
  const state: Record<string, unknown> = {};
  for (const [threadId, label] of labels) {
    const h = store.continuationHolder(bot.id, threadId) as { heldContinuations?: Array<{ id: string; state?: string; error?: string }>; heldQueueRowId?: string } | undefined;
    const rows = store.messagesFor(threadId).filter(row => row.murage?.kind === "queue").map(row => ({ text: row.tool?.name, held: row.murage?.held }));
    const entry = { held: (h?.heldContinuations ?? []).map(item => [item.id, item.state, item.error]), row: Boolean(h?.heldQueueRowId), rows };
    if (entry.held.length || entry.row || rows.length) state[label] = entry;
  }
  // ids are random per run: name the bots and blank the row ids
  const named = JSON.parse(JSON.stringify(state).replaceAll(bot.id, "BOT").replaceAll(peer.id, "PEER").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "ID")) as Record<string, unknown>;
  return { started, state: named, visited: [...new Set(visited)].sort(), pendingAfter: store.pendingThreadsFor(bot.id).map(id => labels.get(id)).sort() };
}

describe("pending work is drained exactly as the full walk drained it", () => {
  it("held items, retries, authority waits, owed messages, settled queue rows and room items end the same", async () => {
    const before = await drainOutcome(true);
    const after = await drainOutcome(false);
    expect(after.started).toEqual(before.started);
    expect(after.state).toEqual(before.state);
    expect(before.started).toEqual(["runnable:RUN_ME"]);
    expect(Object.keys(after.state).sort()).toEqual(["authority", "owed", "retry-later", "room", "runnable", "settle"]);
    // the sent item's queue row is settled at zero, as is the row whose items already went out
    for (const label of ["runnable", "settle"]) expect(after.state[label]).toMatchObject({ held: [], row: false, rows: [expect.objectContaining({ held: { count: 0, items: [] } })] });
    expect(after.state.room).toMatchObject({ held: [["room", "authority", expect.stringContaining("original request has ended")]] });
    expect(after.state.settle).toMatchObject({ row: false });
    expect(after.state.owed).toMatchObject({ row: true, rows: [expect.objectContaining({ held: expect.objectContaining({ count: 1 }) })] });
    // the full walk looked at every thread; the drain looks only at those with work
    expect(before.visited.filter(label => label.startsWith("idle")).length).toBe(60);
    expect(after.visited.filter(label => label.startsWith("idle"))).toEqual([]);
    // what still waits stays in the set; what was sent or settled left it
    expect(after.pendingAfter).toEqual(["authority", "owed", "retry-later", "room"]);
  }, 60_000);

  it("every writer keeps the set: holding, consuming, owing, delivering and settling", async () => {
    await freshHome();
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "m" }));
    const bot = store.createBot(undefined, { seedMessages: false });
    const t = store.createTask(bot.id, "t", false)!.threadId;
    const pending = () => store.pendingThreadsFor(bot.id);
    expect(pending()).toEqual([]);
    store.holdTaskContinuation(bot.id, t, "x", { id: "a", dispatcher: "direct", principal: owner });
    expect(pending()).toEqual([t]);
    store.consumeTaskHeldContinuations(bot.id, t, ["a"]);
    expect(pending()).toEqual([]);
    const row = store.appendMessage(t, { role: "user", kind: "text", text: "owed" });
    store.recordTaskExternalUpdate(bot.id, t, row.id);
    expect(pending()).toEqual([t]);
    store.consumeTaskExternalUpdates(bot.id, t, [row.id]);
    expect(pending()).toEqual([]);
    store.setTaskHeldQueueRow(bot.id, t, row.id);
    expect(pending()).toEqual([t]);
    store.setTaskHeldQueueRow(bot.id, t, undefined);
    expect(pending()).toEqual([]);
    expect(store.hasPendingWork()).toBe(false);
  });
});

describe("the pending set is rebuilt at load and reconciled", () => {
  it("a restart finds pending work saved before it, including work no writer of this build recorded", async () => {
    await freshHome();
    const { Store } = await import("./store.ts");
    const writer = new Store(() => ({ instanceId: "claude", model: "m" }));
    const bot = writer.createBot(undefined, { seedMessages: false });
    const held = writer.createTask(bot.id, "held", false)!.threadId;
    writer.holdTaskContinuation(bot.id, held, "x", { id: "a", dispatcher: "direct", principal: owner });
    // saved by an older build: in the record, never through a writer that keeps the set
    const old = writer.createTask(bot.id, "old", false)!.threadId;
    const record = writer.taskByThread(bot.id, old)!;
    record.externalUpdates = ["m1"];
    (writer as unknown as { saveBots(): void }).saveBots();
    const group = writer.createGroup("Room", [bot.id]);
    const roomHolder = writer.continuationHolder(bot.id, group.threadId)!;
    roomHolder.heldQueueRowId = "row";
    (writer as unknown as { saveGroups(): void }).saveGroups();
    const reopened = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reopened.hasPendingWork()).toBe(true);
    expect(reopened.pendingThreadsFor(bot.id).sort()).toEqual([held, old, group.threadId].sort());
    expect(await reopened.reconcilePendingWork()).toEqual({ missed: [], stale: [] });
  });

  it("the reconcile names and repairs drift: a missed write is put back, a stale entry leaves", async () => {
    await freshHome();
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "m" }));
    const bot = store.createBot(undefined, { seedMessages: false });
    const a = store.createTask(bot.id, "a", false)!.threadId;
    const b = store.createTask(bot.id, "b", false)!.threadId;
    // drift one way: work written past every writer is invisible to the drain until the reconcile
    store.taskByThread(bot.id, a)!.heldContinuations = [{ id: "x", botId: bot.id, text: "x", at: 1, dispatcher: "direct", principal: owner } as never];
    expect(store.pendingThreadsFor(bot.id)).toEqual([]);
    // drift the other way: a thread recorded as pending whose work was cleared past every writer
    store.holdTaskContinuation(bot.id, b, "y", { id: "y", dispatcher: "direct", principal: owner });
    store.taskByThread(bot.id, b)!.heldContinuations = [];
    expect(await store.reconcilePendingWork()).toEqual({ missed: [a], stale: [b] });
    expect(store.pendingThreadsFor(bot.id)).toEqual([a]);
    expect(await store.reconcilePendingWork()).toEqual({ missed: [], stale: [] });
  });

  it("thread lookups answer as the linear walks did, after tasks and rooms are added and removed", async () => {
    await freshHome();
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "m" }));
    const bot = store.createBot(undefined, { seedMessages: false });
    const peer = store.createBot(undefined, { seedMessages: false });
    const tasks = Array.from({ length: 5 }, (_, i) => store.createTask(bot.id, `t${i}`, false)!.threadId);
    const group = store.createGroup("Room", [bot.id, peer.id]);
    const roomTask = store.createGroupTask(group.id, "room task", false)!;
    const check = () => {
      for (const threadId of [...tasks, group.threadId, roomTask.threadId, "missing"]) {
        expect(store.taskByThread(bot.id, threadId)).toBe(store.bot(bot.id)!.tasks!.find(t => t.threadId === threadId));
        expect(store.groupByThread(threadId)).toBe(store.groups.find(g => g.threadId === threadId || g.tasks?.some(t => t.threadId === threadId)));
      }
    };
    check();
    store.deleteTask(bot.id, tasks[2]!); check();
    tasks.push(store.createTask(bot.id, "new", false)!.threadId); check();
    store.deleteGroupTask(group.id, roomTask.threadId); check();
    store.createGroup("Second", [bot.id]); check();
  });
});

describe("the push prune", () => {
  it("asks each retained-history table through its index, and the step back to 1.0.2 drops the indexes", async () => {
    const { initializeMobilePush, PUSH_RETENTION_103_INDEXES, downgradePushRetentionIndexesTo102 } = await import("./mobile-push-store.ts");
    const db = new DatabaseSync(":memory:");
    try {
      initializeMobilePush(db);
      const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...[...new Set(sql.match(/\?\d/g) ?? [])].map(() => 1)) as Array<{ detail: string }>).map(row => row.detail).join(" | ");
      const due = plan("SELECT EXISTS(SELECT 1 FROM push_events WHERE expires_at<=?1) AS e, EXISTS(SELECT 1 FROM push_risk WHERE rated_at<=?2) AS r, EXISTS(SELECT 1 FROM push_decisions WHERE decided_at<=?3) AS d");
      for (const [name] of PUSH_RETENTION_103_INDEXES) expect(due).toContain(`INDEX ${name}`);
      expect(due).not.toMatch(/SCAN push_/);
      expect(plan("DELETE FROM push_events WHERE expires_at<=?1")).toContain("push_events_expires");
      expect(plan("DELETE FROM push_risk WHERE rated_at<=?1")).toContain("push_risk_rated");
      expect(plan("DELETE FROM push_decisions WHERE decided_at<=?1")).toContain("push_decisions_decided");
      const names = () => (db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name IN ('push_events_expires','push_risk_rated','push_decisions_decided')").all() as Array<{ name: string }>).map(row => row.name).sort();
      expect(names()).toEqual(["push_decisions_decided", "push_events_expires", "push_risk_rated"]);
      expect(downgradePushRetentionIndexesTo102(db)).toEqual({ dropped: 3 });
      expect(names()).toEqual([]);
      expect(downgradePushRetentionIndexesTo102(db)).toEqual({ dropped: 0 });
      // the next start of 1.0.3 builds them again
      initializeMobilePush(db);
      expect(names()).toHaveLength(3);
    } finally { db.close(); }
  });

  it("Prepare to reinstall runs the step on messages.db", () => {
    const source = readFileSync(new URL("./installation-memory-downgrade.ts", import.meta.url), "utf8");
    expect(source.indexOf("downgradePushRetentionIndexesTo102(db);")).toBeGreaterThan(-1);
    expect(source.indexOf("downgradePushRetentionIndexesTo102(db);")).toBeLessThan(source.indexOf("const app = to <= 6 ? downgradeApplicationSchemaTo101"));
  });
});

// ── Astra idle-scan r5: room threads, project reminders, close records, drain order, reconcile and deletion ──

type StoreT = import("./store.ts").Store;
const heldItem = (botId: string, id: string) => ({ id, botId, text: id, at: 1, dispatcher: "direct", principal: owner, state: "authority", error: "needs you" }) as never;

/** One bot and a peer in a room with `history` historical room tasks holding nothing, written straight into the records. */
async function roomFixture(history: number) {
  await freshHome();
  const { Store } = await import("./store.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "m" }));
  const bot = store.createBot(undefined, { seedMessages: false });
  const peer = store.createBot(undefined, { seedMessages: false });
  const group = store.createGroup("Room", [bot.id, peer.id]);
  const record = store.group(group.id)!;
  record.tasks = [...(record.tasks ?? []), ...Array.from({ length: history }, (_, i) => ({ threadId: `room-${i}`, title: `r${i}`, createdAt: i }))];
  return { store, bot: store.bot(bot.id)!, peer, group: record };
}

/** The room selection as round 4 left it (store.ts pendingThreadsFor at 453cd8ab0): thread maps, but groupTaskByThread's linear walk. */
function round4Selection(store: StoreT, pending: Set<string>, botId: string): string[] {
  const own: string[] = [], rooms: string[] = [];
  for (const threadId of [...pending]) {
    const task = store.taskByThread(botId, threadId);
    if (task) { own.push(threadId); continue; }
    const room = store.groupByThread(threadId);
    if (!room?.memberIds.includes(botId)) continue;
    const holder = room.dm ? room : room.tasks?.find(t => t.threadId === threadId);
    if (holder?.heldContinuations?.length) rooms.push(threadId);
  }
  return [...own, ...rooms];
}

describe("held room threads (r5)", () => {
  it("10,000 held room threads: the selection costs a few looks per thread and hands the loop back", async () => {
    const { store, bot, group } = await roomFixture(10_000);
    for (const task of group.tasks!) task.heldContinuations = [heldItem(bot.id, task.threadId)];
    // written past every writer: the reconcile finds them all (and is itself sliced)
    let pauses = 0;
    const { missed } = await store.reconcilePendingWork(async () => { pauses++; });
    expect(missed.length).toBe(10_001);
    expect(pauses).toBeGreaterThanOrEqual(39);
    const pending = (store as unknown as { pendingWork: Set<string> }).pendingWork;
    const before = await countComparisons(async () => { round4Selection(store, pending, bot.id); });
    store.pendingThreadsFor(bot.id); // builds the maps once
    let order: string[] = [];
    const after = await countComparisons(async () => { order = store.pendingThreadsFor(bot.id); });
    let slices = 0;
    const sliced = await store.pendingThreadsForSliced(bot.id, async () => { slices++; });
    console.log("ROOM_SELECTION_COMPARISONS", JSON.stringify({ held_room_threads: 10_000, before, after, slices }));
    expect(before).toBeGreaterThan(50_000_000);
    expect(after).toBeLessThan(5 * 10_001);
    expect(sliced).toEqual(order);
    expect(slices).toBe(Math.floor(10_001 / 256));
    // room order: the room's thread, then its tasks in order
    expect(order).toEqual([group.threadId, ...group.tasks!.map(t => t.threadId)].filter((id, i, all) => all.indexOf(id) === i));
  }, 180_000);

  it("an idle sweep costs the same with 100 or 10,000 historical room threads", async () => {
    const counts: Record<number, number> = {};
    for (const history of [100, 10_000]) {
      const { store, bot, group } = await roomFixture(history);
      store.holdTaskContinuation(bot.id, group.tasks![5]!.threadId, "x", { id: "x", dispatcher: "direct", principal: owner, state: "authority", error: "needs you" });
      // the loop budget is time: a slow machine hands back more often, and each hand-back looks at the bot again; that is not history
      const { drain } = await extractDrain(store, { heldScanYield: async () => false });
      await drain(bot.id);
      counts[history] = await countComparisons(async () => { for (let i = 0; i < 20; i++) await drain(bot.id); });
    }
    console.log("IDLE_ROOM_COMPARISONS", JSON.stringify(counts));
    expect(counts[10_000]).toBe(counts[100]);
  }, 120_000);
});

describe("the drain order (r5)", () => {
  it("visits pending threads in the full walk's order across own tasks and rooms, whatever order the work was held in", async () => {
    async function run(legacy: boolean) {
      await freshHome();
      const { Store } = await import("./store.ts");
      const store = new Store(() => ({ instanceId: "claude", model: "m" }));
      const bot = store.createBot(undefined, { seedMessages: false });
      const peer = store.createBot(undefined, { seedMessages: false });
      const labels = new Map<string, string>();
      const own = Array.from({ length: 8 }, (_, i) => { const t = store.createTask(bot.id, `own-${i}`, false)!.threadId; labels.set(t, `own-${i}`); return t; });
      const rooms = ["A", "B", "C"].map(name => {
        const g = store.createGroup(name, name === "C" ? [peer.id] : [bot.id, peer.id]);
        labels.set(g.threadId, `${name}-main`);
        const tasks = Array.from({ length: 4 }, (_, i) => { const t = store.createGroupTask(g.id, `${name}${i}`, false)!.threadId; labels.set(t, `${name}-${i}`); return t; });
        return { g, tasks };
      });
      const hold = (threadId: string) => store.holdTaskContinuation(threadId === rooms[2]!.tasks[1] ? peer.id : bot.id, threadId, "x", { id: labels.get(threadId)!, dispatcher: "direct", principal: owner, state: "authority", error: "needs you" });
      // held in an order unlike any array's
      for (const threadId of [rooms[1]!.tasks[2]!, own[6]!, rooms[0]!.g.threadId, rooms[2]!.tasks[1]!, own[1]!, rooms[0]!.tasks[3]!, own[4]!, rooms[1]!.g.threadId, rooms[0]!.tasks[0]!, own[0]!]) hold(threadId);
      const visited: string[] = [];
      const { drain } = await extractDrain(store, {}, legacy);
      const holder = store.continuationHolder.bind(store);
      store.continuationHolder = ((botId: string, threadId: string) => { if (!visited.includes(threadId)) visited.push(threadId); return holder(botId, threadId); }) as typeof store.continuationHolder;
      await drain(bot.id);
      const pending = new Set(store.pendingThreadsFor(bot.id));
      return visited.filter(threadId => pending.has(threadId)).map(threadId => labels.get(threadId));
    }
    const before = await run(true), after = await run(false);
    expect(after).toEqual(before);
    expect(after).toHaveLength(9);
    expect(after.slice(0, 4).every(label => label?.startsWith("own-"))).toBe(true);
  }, 60_000);
});

describe("deletion leaves no stale entry (r5)", () => {
  it("deleting a task, a room task, a room or a bot takes its threads out of the pending set", async () => {
    await freshHome();
    const { Store } = await import("./store.ts");
    const store = new Store(() => ({ instanceId: "claude", model: "m" }));
    const bot = store.createBot(undefined, { seedMessages: false });
    const other = store.createBot(undefined, { seedMessages: false });
    const set = () => (store as unknown as { pendingWork: Set<string> }).pendingWork;
    const hold = (botId: string, threadId: string) => store.holdTaskContinuation(botId, threadId, "x", { id: threadId, dispatcher: "direct", principal: owner, state: "authority", error: "needs you" });
    const task = store.createTask(bot.id, "t", false)!.threadId; hold(bot.id, task);
    const group = store.createGroup("Room", [bot.id]);
    const roomTask = store.createGroupTask(group.id, "rt", false)!.threadId; hold(bot.id, roomTask);
    const gone = store.createGroup("Gone", [bot.id]);
    const goneTask = store.createGroupTask(gone.id, "gt", false)!.threadId; hold(bot.id, goneTask);
    const otherTask = store.createTask(other.id, "o", false)!.threadId; hold(other.id, otherTask);
    expect([...set()].sort()).toEqual([task, roomTask, goneTask, otherTask].sort());
    store.deleteTask(bot.id, task);
    expect(set().has(task)).toBe(false);
    store.deleteGroupTask(group.id, roomTask);
    expect(set().has(roomTask)).toBe(false);
    store.deleteGroup(gone.id);
    expect(set().has(goneTask)).toBe(false);
    store.deleteBot(other.id);
    expect(set().size).toBe(0);
    expect(await store.reconcilePendingWork()).toEqual({ missed: [], stale: [] });
  });
});

describe("project reminders (r5)", () => {
  /** index.ts readProjectDecisions, run against a real Store; `legacy` puts back the walk of every project thread. */
  function extractDecisions(store: unknown, legacy: boolean) {
    const start = SOURCE.indexOf("function readProjectDecisions(");
    let code = SOURCE.slice(start, SOURCE.indexOf("\nfunction projectMemberProfile(", start));
    const selection = "const withCards=store.threadsWithOpenCards();";
    expect(code).toContain(selection);
    if (legacy) code = code.replace(selection, "const withCards=null;");
    return runInNewContext(stripTypeScriptTypes(code) + "\nreadProjectDecisions;", {
      store, database: () => null, cardAuditSummary: () => undefined, projectDecisionSentence: (_: string, n: number) => `${n}`,
      deriveGroupedDecisions: (_: unknown, input: { openApprovals: unknown[] }) => ({ approvals: input.openApprovals, goals: [], deadWaitCards: [], count: input.openApprovals.length }),
    }) as (group: unknown) => { approvals: Array<{ requestId: string; threadId: string }> };
  }

  it("10,000 historical project threads with no approvals ask no thread; open cards are found as the full walk found them", async () => {
    const calls: Record<string, number> = {};
    let found: Record<string, string[]> = {};
    for (const history of [100, 10_000]) {
      const { store, bot, group } = await roomFixture(history);
      // the project's desk tasks on the bot, as many again
      bot.tasks = [...bot.tasks!, ...Array.from({ length: history }, (_, i) => ({ threadId: `desk-${i}`, title: `d${i}`, createdAt: i, resumeCursors: {}, channelProjectDesk: { groupId: group.id } }))];
      let asked = 0;
      const openCards = store.openCardsOnBranch.bind(store);
      store.openCardsOnBranch = (threadId: string) => { asked++; return openCards(threadId); };
      for (const legacy of [true, false]) {
        asked = 0;
        const decisions = extractDecisions(store, legacy)(group);
        calls[`${legacy ? "before" : "after"}_${history}`] = asked;
        expect(decisions.approvals).toEqual([]);
      }
      if (history !== 100) continue;
      for (const threadId of ["desk-7", group.tasks![3]!.threadId, group.threadId, "desk-2"]) {
        store.appendMessage(threadId, { role: "bot", kind: "options", text: "Approve?", card: { requestId: `req-${threadId}`, title: "Approve?", options: [] } } as never);
      }
      found = Object.fromEntries([true, false].map(legacy => [legacy ? "before" : "after", extractDecisions(store, legacy)(group).approvals.map(a => a.requestId)]));
    }
    console.log("PROJECT_REMINDER_CALLS", JSON.stringify(calls));
    expect(calls.before_10000).toBeGreaterThan(20_000);
    expect(calls.after_10000).toBe(0);
    expect(calls.after_100).toBe(0);
    expect(found.after).toEqual(found.before);
    expect(found.after).toHaveLength(4);
  }, 120_000);
});

describe("close records (r5)", () => {
  /** Counts the rows statements return and the JSON parsed while `run` executes. */
  function countReads(db: DatabaseSync, run: () => void): { rows: number; parsed: number } {
    let rows = 0, parsed = 0;
    const prepare = db.prepare.bind(db), parse = JSON.parse;
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (key === "all") return (...args: never[]) => { const result = (value as (...a: never[]) => unknown[]).apply(target, args); rows += result.length; return result; };
        if (key === "get") return (...args: never[]) => { const result = (value as (...a: never[]) => unknown).apply(target, args); if (result) rows++; return result; };
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      } });
    }) as typeof db.prepare;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parsed++; return parse(...args); }) as typeof JSON.parse;
    try { run(); } finally { db.prepare = prepare; JSON.parse = parse; }
    return { rows, parsed };
  }

  it("the room sweep reads a project's close records again only after they change", async () => {
    const { initializeProjectTables } = await import("./project-tables.ts");
    const { channelToProjectRows } = await import("./project-settings.ts");
    const { insertProjectActivity, noteProjectCloseRecords } = await import("./project-records.ts");
    const { resumeProjectCloses, resumeGoalCloseSummaries } = await import("./project-close.ts");
    const sweeps: Record<string, { rows: number; parsed: number }> = {};
    for (const history of [100, 10_000]) {
      const db = new DatabaseSync(":memory:");
      try {
        initializeProjectTables(db);
        channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: "lead", now: 1 });
        for (let i = 0; i < history; i++) insertProjectActivity(db, { groupId: "g", kind: "close", actor: "server", at: 2, goalId: `goal-${i}`, detail: { goalSummary: `goal-${i}`, step: 3, summaryRequestId: null } });
        const deps = { groupId: "g", threadId: "room", memberIds: ["lead"], now: 10, lineage: { rootThreadId: "room", origin: "server" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
          deliverables: () => [], routineNames: () => [], pauseRoutines: () => {}, post: () => { throw new Error("nothing to post"); }, summary: () => null, sync: () => {} };
        const sweep = () => { resumeProjectCloses(db, deps); resumeGoalCloseSummaries(db, deps); };
        sweep();
        sweeps[`idle_${history}`] = countReads(db, sweep);
        noteProjectCloseRecords(db); // what a write does: the next sweep reads the rows once
        sweeps[`after_change_${history}`] = countReads(db, sweep);
        sweeps[`idle_again_${history}`] = countReads(db, sweep);
      } finally { db.close(); }
    }
    console.log("CLOSE_RECORD_READS", JSON.stringify(sweeps));
    expect(sweeps.idle_10000).toEqual(sweeps.idle_100);
    expect(sweeps.idle_again_10000).toEqual(sweeps.idle_100);
    expect(sweeps.idle_10000!.parsed).toBe(0);
    expect(sweeps.after_change_10000!.parsed).toBeGreaterThanOrEqual(10_000);
  }, 120_000);

  it("a close written, rolled back or pruned is seen by the next read", async () => {
    const { initializeProjectTables, pruneProjectActivity } = await import("./project-tables.ts");
    const { channelToProjectRows } = await import("./project-settings.ts");
    const { currentProjectClose, insertProjectActivity } = await import("./project-records.ts");
    const db = new DatabaseSync(":memory:");
    try {
      initializeProjectTables(db);
      channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: "lead", now: 1 });
      expect(currentProjectClose(db, "g")).toBeNull();
      db.exec("BEGIN");
      insertProjectActivity(db, { groupId: "g", kind: "close", actor: "owner", at: 2, detail: { closeSeq: 5, step: 1, summaryRequestId: null } });
      expect(currentProjectClose(db, "g")).toMatchObject({ closeSeq: 5, step: 1 });
      db.exec("ROLLBACK");
      expect(currentProjectClose(db, "g")).toBeNull();
      insertProjectActivity(db, { groupId: "g", kind: "close", actor: "owner", at: 2, detail: { closeSeq: 6, step: 1, summaryRequestId: null } });
      expect(currentProjectClose(db, "g")).toMatchObject({ closeSeq: 6, step: 1 });
      insertProjectActivity(db, { groupId: "g", kind: "reopen", actor: "owner", at: 3, detail: {} });
      expect(currentProjectClose(db, "g")).toBeNull();
      pruneProjectActivity(db, 10 ** 13);
      expect(currentProjectClose(db, "g")).toBeNull();
    } finally { db.close(); }
  });
});

describe("the budget check (r5)", () => {
  it("looks only at the period budget and open goals' budgets, in the same order", async () => {
    const { initializeProjectTables } = await import("./project-tables.ts");
    const { projectBudgetsForGroup, liveProjectBudgetsForGroup } = await import("./project-defaults.ts");
    const db = new DatabaseSync(":memory:");
    try {
      initializeProjectTables(db);
      // one goal at most in an active state (project_goals_one_active)
      const states = ["done", "working", "stopped", "failed", "draft", "done", "draft"];
      states.forEach((state, i) => {
        db.prepare("INSERT INTO project_goals (id, group_id, title, state, created_at) VALUES (?, 'g', 'Goal', ?, ?)").run(`goal-${i}`, state, i);
        db.prepare("INSERT INTO project_budgets (id, group_id, goal_id, period, tz, period_start, max_work_minutes, created_at) VALUES (?, 'g', ?, 'goal', 'UTC', 0, 60, ?)").run(`b-${i}`, `goal-${i}`, 10 - i);
      });
      db.prepare("INSERT INTO project_budgets (id, group_id, goal_id, period, tz, period_start, max_work_minutes, created_at) VALUES ('week', 'g', NULL, 'week', 'UTC', 0, 60, 5)").run();
      const finished = new Set(["done", "stopped", "failed"]);
      const expected = projectBudgetsForGroup(db, "g").filter(b => !b.goalId || !finished.has(states[Number(b.goalId.split("-")[1])]!));
      expect(liveProjectBudgetsForGroup(db, "g")).toEqual(expected);
      expect(expected.map(b => b.id)).toEqual(["b-6", "week", "b-4", "b-1"]);
    } finally { db.close(); }
  });
});

// Round 6 (Astra idle-scan r6): the budget tick reads running totals; the digest tick reads one budget.
describe("the budget tick and the digest tick do not grow with history (r6)", () => {
  type Counts = { sql: string[]; rows: number };
  // A handle that records every statement and the rows each one hands back
  function counted(db: DatabaseSync): { handle: DatabaseSync; counts: Counts; reset(): void } {
    const counts: Counts = { sql: [], rows: 0 };
    const handle = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => {
          const stmt = target.prepare(sql);
          return new Proxy(stmt, { get(inner, name) {
            const value = Reflect.get(inner, name, inner);
            if (name === "all") return (...args: never[]) => { counts.sql.push(sql); const rows = inner.all(...args); counts.rows += rows.length; return rows; };
            if (name === "get") return (...args: never[]) => { counts.sql.push(sql); const row = inner.get(...args); counts.rows += row ? 1 : 0; return row; };
            if (name === "run") return (...args: never[]) => { counts.sql.push(sql); return inner.run(...args); };
            return typeof value === "function" ? value.bind(inner) : value;
          } });
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DatabaseSync;
    return { handle, counts, reset() { counts.sql.length = 0; counts.rows = 0; } };
  }
  async function ledgerFixture(rows: number, historicalBudgets: number) {
    const { initializeProjectTables } = await import("./project-tables.ts");
    const db = new DatabaseSync(":memory:");
    initializeProjectTables(db);
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${rows})
      INSERT INTO usage_ledger (settle_key,group_id,goal_id,bot_id,thread_id,engine,input,output,tokens_reported,charge_kind,work_ms,ok,at)
      SELECT 'k'||i,'g',CASE WHEN i%2=0 THEN 'goal-live' ELSE 'goal-old' END,'bot','t','claude',i%7,i%5,1,'none',i%13,1,1000+i FROM n`);
    for (let i = 0; i < historicalBudgets; i++) {
      db.prepare("INSERT INTO project_goals (id, group_id, title, state, created_at) VALUES (?, 'g', 'Goal', 'done', ?)").run(`old-${i}`, i);
      db.prepare("INSERT INTO project_budgets (id, group_id, goal_id, period, tz, period_start, max_work_minutes, created_at) VALUES (?, 'g', ?, 'goal', 'UTC', 0, 60, ?)").run(`ob-${i}`, `old-${i}`, i);
    }
    db.prepare("INSERT INTO project_goals (id, group_id, title, state, created_at) VALUES ('goal-live', 'g', 'Goal', 'working', 1000000000)").run();
    db.prepare("INSERT INTO project_budgets (id, group_id, goal_id, period, tz, period_start, max_work_minutes, max_tokens, created_at) VALUES ('live', 'g', 'goal-live', 'goal', 'UTC', 0, 100000, 1000000000, 1000000000)").run();
    return db;
  }
  const oldAggregate = (db: DatabaseSync, scope: { groupId: string; goalId?: string; since?: number }) => {
    const clauses = ["group_id=?"]; const values: (string | number)[] = [scope.groupId];
    if (scope.goalId) { clauses.push("goal_id=?"); values.push(scope.goalId); }
    if (scope.since !== undefined) { clauses.push("at>=?"); values.push(scope.since); }
    const row = db.prepare(`SELECT COALESCE(SUM(work_ms),0) AS workMs, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output FROM usage_ledger WHERE ${clauses.join(" AND ")}`).get(...values) as Record<string, number>;
    return { workMs: Number(row.workMs), input: Number(row.input), output: Number(row.output) };
  };

  it("an idle budget tick reads the same few rows at 1,000 and at 100,000 usage rows, and never sums the ledger", async () => {
    const { createProjectBudgetGate } = await import("./project-budgets.ts");
    const work: number[] = [];
    for (const size of [1000, 100000]) {
      const db = await ledgerFixture(size, 300);
      try {
        const spy = counted(db);
        const gate = createProjectBudgetGate(spy.handle);
        gate.evaluate("g", 5000); // the first look builds the totals once
        spy.reset();
        for (let tick = 0; tick < 20; tick++) gate.evaluate("g", 5000 + tick);
        work.push(spy.counts.rows);
        expect(spy.counts.sql.some(sql => /SUM\(/i.test(sql))).toBe(false);
        // the totals are the old aggregate, exactly
        expect(gate.usage(await liveBudget(db), 5000).workMs).toBe(oldAggregate(db, { groupId: "g", goalId: "goal-live" }).workMs);
      } finally { db.close(); }
    }
    console.log("BUDGET_TICK_READS", JSON.stringify({ rows_1000: work[0], rows_100000: work[1] }));
    expect(work[1]).toBe(work[0]);
    expect(work[0]).toBeLessThan(200);
  });
  async function liveBudget(db: DatabaseSync) {
    const { projectBudgetFromRow } = await import("./project-defaults.ts");
    return projectBudgetFromRow(db.prepare("SELECT * FROM project_budgets WHERE id='live'").get() as never);
  }

  it("the catch-up after new usage reads only the new rows, by rowid", async () => {
    const { budgetUsageTotals } = await import("./usage-ledger.ts");
    const db = await ledgerFixture(50000, 0);
    try {
      budgetUsageTotals(db, { groupId: "g", goalId: "goal-live" });
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT COALESCE(SUM(work_ms),0) FROM usage_ledger WHERE rowid>? AND +group_id=? AND +goal_id=?").all(1, "g", "goal-live").map(r => String(r.detail)).join(" ");
      expect(plan).toMatch(/SEARCH usage_ledger USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    } finally { db.close(); }
  });

  it("the totals equal the old aggregate after mixed writes, a removal and a rebuild", async () => {
    const { budgetUsageTotals, reconcileBudgetTotals, rollupSettledUsage } = await import("./usage-ledger.ts");
    const db = await ledgerFixture(2000, 0);
    try {
      const scopes = [{ groupId: "g", goalId: "goal-live" }, { groupId: "g", since: 1500 }, { groupId: "g" }, { groupId: "g", goalId: "goal-old", since: 1200 }];
      const same = () => { for (const scope of scopes) expect(budgetUsageTotals(db, scope)).toEqual(oldAggregate(db, scope)); };
      same();
      const add = db.prepare("INSERT INTO usage_ledger (settle_key,group_id,goal_id,bot_id,thread_id,engine,input,output,tokens_reported,charge_kind,work_ms,ok,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (let i = 0; i < 40; i++) {
        add.run(`m${i}`, i % 5 === 0 ? "other" : "g", i % 3 === 0 ? "goal-live" : "goal-old", "bot", "t", "claude", i % 2 ? null : i, i % 2 ? null : 3, i % 2 ? 0 : 1, "none", 100 + i, 1, 900 + i * 40);
        if (i % 9 === 0) same();
      }
      same();
      // a removal (the unknown-usage replacement and the rollup both do this) rebuilds, and reuse of a freed rowid cannot hide a row
      db.prepare("DELETE FROM usage_ledger WHERE settle_key IN ('m39','m38')").run();
      add.run("after-removal", "g", "goal-live", "bot", "t", "claude", 7, 7, 1, "none", 77, 1, 3000);
      rollupSettledUsage(db, 10 ** 13);
      same();
      // a drifted total is found and repaired by the hourly reconcile
      const before = budgetUsageTotals(db, scopes[0]!);
      db.prepare("DELETE FROM usage_ledger WHERE settle_key IN (SELECT settle_key FROM usage_ledger WHERE goal_id='goal-live' AND work_ms>0 LIMIT 1)").run();
      expect(reconcileBudgetTotals(db)).toBeGreaterThan(0);
      expect(budgetUsageTotals(db, scopes[0]!)).toEqual(oldAggregate(db, scopes[0]!));
      expect(budgetUsageTotals(db, scopes[0]!)).not.toEqual(before);
      expect(reconcileBudgetTotals(db)).toBe(0);
      same();
    } finally { db.close(); }
  });

  it("a digest tick reads one budget however many finished goals have budgets", async () => {
    const { periodBudgetForGroup, projectBudgetsForGroup } = await import("./project-defaults.ts");
    const rows: number[] = [];
    for (const history of [10, 1000]) {
      const db = await ledgerFixture(10, history);
      try {
        db.prepare("INSERT INTO project_budgets (id, group_id, goal_id, period, tz, period_start, max_work_minutes, created_at) VALUES ('week', 'g', NULL, 'week', 'Europe/Paris', 0, 60, 5)").run();
        const spy = counted(db);
        expect(periodBudgetForGroup(spy.handle, "g")?.tz).toBe(projectBudgetsForGroup(db, "g").find(b => b.period !== "goal")?.tz);
        expect(periodBudgetForGroup(spy.handle, "nobody")).toBeNull();
        rows.push(spy.counts.rows);
      } finally { db.close(); }
    }
    expect(rows[1]).toBe(rows[0]);
    expect(rows[0]).toBe(1);
    expect(readFileSync(new URL("./project-digest.ts", import.meta.url), "utf8")).not.toContain("projectBudgetsForGroup(");
  });
});
