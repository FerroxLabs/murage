// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotTurnState, readBotRecords } from "./bot-turn-state.ts";
import { flushCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store, type BotRecord, type StoreChange } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { memoryAccess, backgroundMemoryScopes, ensureScope, reconcileMemoryRoster, inMemoryAccessPass, type MemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { prepareRecallContextSync } from "./memory/recall-view.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { threadHumanPrincipal } from "./human-principals.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";

const selection = () => ({ instanceId: "fixture", model: "model" });
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => { flushCoalesced(); vi.restoreAllMocks(); closeDatabase(); });
const checkpoint = () => readFileSync(join(DATA_DIR, "bots.json"), "utf8");
function neighbour(store: Store, count: number) {
  const bot = store.createBot({ name: "History" }, { seedMessages: false }), template = bot.tasks![0]!;
  store.patchBot(bot.id, { tasks: Array.from({ length: count }, (_, n) => ({ ...template, threadId: n ? `history-${n}` : bot.threadId })) });
  return bot;
}
it("A2: sole-task unread survives restart without rewriting a checkpoint beside 5,000 tasks", () => {
  const store = new Store(selection), bot = store.createBot({ name: "Speaker" }, { seedMessages: false });
  neighbour(store, 5_000);
  const before = checkpoint(), held = bot.tasks![0], revision = store.taskRevision(bot.id);
  store.patchBot(bot.id, { unread: true });
  expect(checkpoint()).toBe(before);
  expect(bot.tasks![0]).toBe(held);
  expect(held!.unread).toBe(true);
  expect(store.taskRevision(bot.id)).toBe(revision + 1);
  const again = new Store(selection).bot(bot.id)!;
  expect(again.unread).toBe(true);
  expect(again.tasks![0]!.unread).toBe(true);
});
it("A3: soleTask deltas are fenced by thread, task count and checkpoint generation", () => {
  const store = new Store(selection), bot = store.createBot({ name: "Speaker" }, { seedMessages: false });
  const original = JSON.parse(checkpoint());
  for (const mode of ["thread", "length", "generation"]) {
    const records = structuredClone(original), record = records.find((b: BotRecord) => b.id === bot.id);
    if (mode === "length") record.tasks.push({ ...record.tasks[0], threadId: "second" });
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(records));
    writeFileSync(join(DATA_DIR, "bot-turn-state.json"), JSON.stringify({ version: 1, bots: { [bot.id]: { base: mode === "generation" ? "stale" : record.turnStateBase, state: { unread: true, soleTask: { threadId: mode === "thread" ? "different" : bot.threadId, unread: true } } } } }));
    const loaded = readBotRecords(DATA_DIR).find(b => b.id === bot.id)!;
    expect(loaded.tasks![0]!.unread, mode).not.toBe(true);
    expect(loaded.unread, mode).toBe(mode === "generation" ? false : true);
  }
});
it("A3 strict shape: soleTask accepts exactly a string threadId and boolean unread", () => {
  const store = new Store(selection), bot = store.createBot({ name: "Speaker" }, { seedMessages: false });
  const base = JSON.parse(checkpoint())[0].turnStateBase;
  for (const soleTask of [null, [], {}, { threadId: 1, unread: true }, { threadId: bot.threadId, unread: 1 }, { threadId: bot.threadId, unread: true, extra: true }]) {
    writeFileSync(join(DATA_DIR, "bot-turn-state.json"), JSON.stringify({ version: 1, bots: { [bot.id]: { base, state: { soleTask } } } }));
    expect(() => readBotRecords(DATA_DIR)).toThrow(expect.objectContaining({ reason: "invalid-shape" }));
  }
});
it("A4: a sole-task sidecar failure publishes no task, revision or event", () => {
  const store = new Store(selection), bot = store.createBot({ name: "Speaker" }, { seedMessages: false });
  const task = bot.tasks![0]!, before = structuredClone(bot), revision = store.taskRevision(bot.id), allRevision = store.revision, changes: StoreChange[] = [];
  store.onChange(change => changes.push(change));
  vi.spyOn(BotTurnState.prototype, "flush").mockImplementationOnce(() => { throw new Error("sidecar refused"); });
  expect(() => store.patchBot(bot.id, { unread: true })).toThrow("sidecar refused");
  expect(bot).toEqual(before); expect(bot.tasks![0]).toBe(task);
  expect(store.taskRevision(bot.id)).toBe(revision); expect(store.revision).toBe(allRevision); expect(changes).toEqual([]);
});
function access(roster: MemoryRoster, botId: string, threadId: string) {
  // Explicit offline maintenance: a plain fixture must publish its roster before preparing a view.
  if(!(roster instanceof Store))reconcileMemoryRoster(roster);
  const oracle=[...new Set(backgroundMemoryScopes(botId,threadId,roster))].sort();
  prepareRecallContextSync(botId,threadId,roster);
  const registry = new InternalCapabilities(); registry.begin(botId, threadId, "fixture");
  const claim = registry.resolve(`Bearer ${registry.mint({ botId, threadId, generation: "fixture", depth: 0, kind: "memory", skillAuthoring: false })}`)!;
  const issued=memoryAccess(registry, claim, () => roster);
  expect(issued.scopeIds).toEqual(oracle);
  return issued;
}
function memoryWorld(count = 3) {
  setMemoryMode("active");
  const store = new Store(selection), bot = store.createBot({ name: "Speaker" }, { seedMessages: false });
  const template = bot.tasks![0]!;
  store.patchBot(bot.id, { tasks: Array.from({ length: count }, (_, n) => ({ ...template, threadId: n ? `own-${n}` : bot.threadId })) });
  store.finishSharingBoot();
  const get = () => access(store, bot.id, bot.threadId).scopeIds;
  return { store, bot, get };
}
function binding(id: string, type: string, subject: string, intent: unknown, scope = ensureScope("workspace", "fixture"), db = database()) {
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,?,?,1,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent,state='granted'").run(id, scope, type, subject, JSON.stringify(intent));
}
// These guards test the changed authorization answer, not merely a revision counter.
it("A7.1/2/3: owner exclusions, human-thread bindings and room grants invalidate eligibility", () => {
  const { store, bot, get } = memoryWorld(), own = ensureScope("conversation", "own-1"), own2 = ensureScope("conversation", "own-2");
  get(); expect(get()).toContain(own);
  binding("memory-owner-settings", "system", "owner", { excludedThreadIds: ["own-1"] });
  expect(get()).not.toContain(own);
  binding("human-thread:own-2", "human-thread", "own-2", { personId: "fixture-person", bindingId: "fixture-binding", revision: 1 });
  expect(get()).not.toContain(own2);
  const room = store.createGroup("Room", [bot.id]), granted = ensureScope("project", "shared-fixture");
  binding("fixture-room-grant", "room", room.id, {}, granted);
  const roomGet = () => access(store, bot.id, room.threadId).scopeIds;
  roomGet(); expect(roomGet()).toContain(granted);
  database().prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id='fixture-room-grant'").run();
  expect(roomGet()).not.toContain(granted);
});
it("A7.4/5/6: structural task changes, aliases and room membership invalidate eligibility", () => {
  const { store, bot, get } = memoryWorld(), old = bot.tasks![1]!;
  get(); get();
  const added = store.createTask(bot.id, "Added")!, addedScope = ensureScope("conversation", added.threadId);
  expect(get()).toContain(addedScope);
  store.deleteTask(bot.id, added.threadId);
  expect(get()).not.toContain(addedScope);
  const other = store.createBot({ name: "Other" }, { seedMessages: false });
  get(); const oldScope = ensureScope("conversation", old.threadId); expect(get()).toContain(oldScope);
  store.patchBot(other.id, { tasks: [{ ...other.tasks![0]!, threadId: old.threadId }] });
  expect(get()).not.toContain(oldScope);
  const room = store.createGroup("Room", []), roomScope = ensureScope("room", room.id);
  get(); expect(get()).not.toContain(roomScope);
  store.patchGroup(room.id, { memberIds: [bot.id] });
  expect(get()).toContain(roomScope);
  const aliasRoom = store.createGroup("Alias room", []);
  aliasRoom.tasks = [...aliasRoom.tasks!, { ...aliasRoom.tasks![0]!, threadId: "own-2" }];
  store.patchGroup(aliasRoom.id, { name: "Alias room updated" });
  expect(get()).not.toContain(ensureScope("conversation", "own-2"));
  store.patchGroup(room.id, { memberIds: [] }); expect(get()).not.toContain(roomScope);
});
it("A7.7: another connection's binding commit invalidates eligibility", () => {
  const { get } = memoryWorld(), scope = ensureScope("conversation", "own-1"), workspace = ensureScope("workspace", "fixture");
  get(); expect(get()).toContain(scope);
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try { binding("memory-owner-settings", "system", "owner", { excludedThreadIds: ["own-1"] }, workspace, other); } finally { other.close(); }
  expect(get()).not.toContain(scope);
});
it("A7.8: first access in a transaction stores no answer and rollback stays fresh", () => {
  const { get } = memoryWorld(), db = database(), scope = ensureScope("conversation", "own-1");
  db.exec("BEGIN");
  try { binding("memory-owner-settings", "system", "owner", { excludedThreadIds: ["own-1"] }); expect(get()).not.toContain(scope); } finally { db.exec("ROLLBACK"); }
  expect(get()).toContain(scope);
});
it("A7 compute-write: scopes created during computation are not cached under the new stamp", () => {
  const { store, bot } = memoryWorld();
  // A controlled indexed lookup writes exactly while eligibleScopes computes.
  const original = store.threadIdsForBot.bind(store); let once = true;
  const spy = vi.spyOn(store, "threadIdsForBot").mockImplementation(id => { if (once) { once = false; ensureScope("project", "created-during-compute"); } return original(id); });
  access(store, bot.id, bot.threadId); const calls = spy.mock.calls.length;
  access(store, bot.id, bot.threadId); expect(spy.mock.calls.length).toBe(calls + 1);
});
it("A8: unread and coalesced usage retain the frozen answer across accesses and passes", () => {
  const { store, bot, get } = memoryWorld(); get(); const first = get(), spy = vi.spyOn(store, "threadIdsForBot");
  store.patchBot(bot.id, { unread: true }); store.addRoomTurnUsage(bot.id, { input: 3 }, "fixture-usage"); flushCoalesced();
  expect(get()).toBe(first); expect(spy).not.toHaveBeenCalled(); expect(Object.isFrozen(first)).toBe(true);
  inMemoryAccessPass(() => { expect(backgroundMemoryScopes(bot.id, bot.threadId, store)).toBe(first); expect(backgroundMemoryScopes(bot.id, bot.threadId, store)).toBe(first); });
});
it("A6: one eligibility miss does not rescan 1,000 room tasks per own thread", () => {
  const samples = [50, 5_000].map(count => {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    const { store, bot } = memoryWorld(count), room = store.createGroup("Unrelated", []);
    room.tasks = Array.from({ length: 1_000 }, (_, n) => ({ ...room.tasks![0]!, threadId: `room-${n}` }));
    store.patchGroup(room.id, { name: "Unrelated updated" });
    store.groupByThread(room.threadId); (store as any).threadHolder?.(bot.threadId);
    let reads = 0; room.tasks = new Proxy(room.tasks!, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
    // Warm structural indexes after wrapping; this initialization is per change.
    store.groupByThread(room.threadId); (store as any).threadHolder?.(bot.threadId); reads = 0;
    access(store, bot.id, bot.threadId); return reads;
  });
  expect(samples[1]).toBe(samples[0]); expect(samples[1]).toBeLessThanOrEqual(2_000);
});
it.each([7, 8, 9, 10, 11, 12, 13] as const)("A9: downgrade target %s folds matching turn state, strips bases and removes the sidecar idempotently", async target => {
  const store = new Store(selection), bot = store.createBot({ name: "Speaker" }, { seedMessages: false }), stale = store.createBot({ name: "Stale" }, { seedMessages: false });
  const records = JSON.parse(checkpoint()), record = records.find((b: BotRecord) => b.id === bot.id);
  writeFileSync(join(DATA_DIR, "bot-turn-state.json"), JSON.stringify({ version: 1, bots: {
    [bot.id]: { base: record.turnStateBase, state: { unread: true, usageMonths: { "2026-01": { input: 7, output: 2, replies: 1 } }, usageRoutineMonths: { "2026-01": { input: 3, replies: 1 } }, soleTask: { threadId: bot.threadId, unread: true } } },
    [stale.id]: { base: "stale", state: { unread: true } },
  } }));
  closeDatabase(); await stopWalMaintenance();
  await downgradeInstallationMemorySchema(DATA_DIR, target);
  const folded = JSON.parse(checkpoint()), live = folded.find((b: BotRecord) => b.id === bot.id);
  expect(live.unread).toBe(true); expect(live.tasks[0].unread).toBe(true);
  expect(live.usageMonths["2026-01"].input).toBe(7); expect(live.usageRoutineMonths["2026-01"].input).toBe(3);
  expect(folded.find((b: BotRecord) => b.id === stale.id).unread).toBe(false);
  expect(folded.every((b: object) => !Object.hasOwn(b, "turnStateBase"))).toBe(true);
  expect(existsSync(join(DATA_DIR, "bot-turn-state.json"))).toBe(false);
  if (process.platform !== "win32") expect(statSync(join(DATA_DIR, "bots.json")).mode & 0o777).toBe(0o600);
  const before = checkpoint(); await downgradeInstallationMemorySchema(DATA_DIR, target); expect(checkpoint()).toBe(before);
});

it("A7 roster-stamp: adding/removing already-scoped tasks and aliases invalidates without a database write", () => {
  setMemoryMode("active");
  const bot = { id: "fixture-bot", threadId: "fixture-main", tasks: [{ threadId: "fixture-main" }, { threadId: "fixture-old" }] };
  const other = { id: "fixture-other", threadId: "fixture-other-main", tasks: [{ threadId: "fixture-other-main" }] };
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [bot, other], groups: [] };
  reconcileMemoryRoster(roster); const added = ensureScope("conversation", "fixture-added"), old = ensureScope("conversation", "fixture-old");
  const get = () => access(roster, bot.id, bot.threadId).scopeIds;
  get(); get(); bot.tasks.push({ threadId: "fixture-added" }); roster.memoryRosterRevision!++;
  expect(get()).toContain(added);
  bot.tasks = bot.tasks.filter(t => t.threadId !== "fixture-added"); roster.memoryRosterRevision!++;
  expect(get()).not.toContain(added);
  expect(get()).toContain(old); other.tasks.push({ threadId: "fixture-old" }); roster.memoryRosterRevision!++;
  expect(get()).not.toContain(old);
});

it("A7.3 person: revoking a linked person's grant removes it from the next access", () => {
  const { store, bot } = memoryWorld(), db = database();
  const principal = { personId: "fixture-person", bindingId: "fixture-human", revision: 1 };
  const preferences = ensureScope("preferences", "person:fixture-person"), project = ensureScope("project", "fixture-person-project");
  binding(principal.bindingId, "human-binding", principal.bindingId, { id: principal.bindingId, personId: principal.personId, revision: 1, active: true,
    origin: { platform: "slack", connectionId: "fixture-connection", authorityId: "fixture-authority", userId: "fixture-user" } }, preferences);
  binding(`human-thread:${bot.threadId}`, "human-thread", bot.threadId, principal, preferences);
  binding("fixture-person-grant", "person", principal.personId, {}, project);
  const registry = new InternalCapabilities(); registry.begin(bot.id, bot.threadId, "fixture", principal);
  const claim = registry.resolve(`Bearer ${registry.mint({ botId: bot.id, threadId: bot.threadId, generation: "fixture", depth: 0, kind: "memory", skillAuthoring: false, humanPrincipal: principal })}`)!;
  const get = () => {prepareRecallContextSync(bot.id,bot.threadId,store);return memoryAccess(registry, claim, () => store).scopeIds;};
  expect(threadHumanPrincipal(bot.threadId)).toEqual(principal);
  get(); expect(get()).toContain(project);
  db.prepare("UPDATE memory_scope_bindings SET state='revoked' WHERE id='fixture-person-grant'").run();
  expect(get()).not.toContain(project);
});
it("A7 read-set update: moving a binding out of the watched subject types invalidates the old audience", () => {
  const { get } = memoryWorld(), own = ensureScope("conversation", "own-1");
  binding("human-thread:own-1", "human-thread", "own-1", { personId: "fixture-person" });
  get(); expect(get()).not.toContain(own);
  database().prepare("UPDATE memory_scope_bindings SET subject_type='system' WHERE id='human-thread:own-1'").run();
  expect(get()).toContain(own);
});
