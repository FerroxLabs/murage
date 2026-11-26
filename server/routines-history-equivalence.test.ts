// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: rhist-s1b owns the independent oracle/fixtures; rhist-h1 owns the implementation under test.
import { mkdtempSync, readFileSync, cpSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import type { Store } from "./store.ts";
import { MAILBOX_PLACEHOLDER } from "./mailbox/projection.ts";
import { pageChats, chatSearchRows, type ChatSource, type ChatFilters } from "./chat-list.ts";
import { directRoutineHistoryFixture, historyInside, HISTORY_NOW } from "./testing/routine-history-fixture.ts";
import { measureHistoryWork } from "./testing/routine-history-work.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// Same journal open/fsync boundaries as routine-journal-crash.test.ts. Capture the
// durable files at the fault, before the surviving manager can reconcile them.
const historyFault = vi.hoisted(() => ({ stage: "", capture: undefined as undefined | (() => void), files: new Map<number, string>(), deterministic: false, serial: 0 }));
vi.mock("node:crypto", async original => {
  const crypto = await original<typeof import("node:crypto")>();
  return { ...crypto, randomUUID: () => historyFault.deterministic ? `fixture-id-${historyFault.serial++}` : crypto.randomUUID() };
});
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const hit = (stage: string, file: string) => {
    if (historyFault.stage !== stage || !file.endsWith(".jsonl")) return;
    historyFault.stage = ""; historyFault.capture?.(); throw new Error(`fixture crash ${stage}`);
  };
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => { hit("before", String(args[0])); const fd = fs.openSync(...args); historyFault.files.set(fd, String(args[0])); return fd; },
    fsyncSync: (fd: number) => { fs.fsyncSync(fd); hit("after", historyFault.files.get(fd) ?? ""); },
    closeSync: (fd: number) => { historyFault.files.delete(fd); return fs.closeSync(fd); },
  };
});

// Independent pre-H1 computation. Preserve this even after the old function is deleted.
function oldMap(manager: RoutineManager) {
  const byThread = new Map<string, { botId?: string; groupId?: string; routineId: string; routineName: string }>();
  // manager.listRuns() establishes stable insertion ties, NaN ordering and quarantine exclusion.
  for (const run of manager.listRuns()) {
    if (!run.threadId || byThread.has(run.threadId)) continue;
    if (run.target === "room-goal") {
      if (run.groupId) byThread.set(run.threadId, { groupId: run.groupId, routineId: run.routineId, routineName: run.routineName });
    } else if (run.triggerSource !== "channel") {
      byThread.set(run.threadId, { botId: run.botId, routineId: run.routineId, routineName: run.routineName });
    }
  }
  return byThread;
}

// Execute the actual current production closure, including its owner check. This works before
// and after H1; it neither supplies a future accessor nor substitutes an oracle for the subject.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const declarations = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
  && ["chatSource", "chatRoutineRuns"].includes(node.name?.text ?? "")).map(node => node.getText(ast)).join("\n");
const body = ts.transpileModule(`let chatRoutineRunCache: any = null;\n${declarations}\nreturn chatSource(desktop);`, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
const currentSource = new Function("routines", "store", "desktop", body) as (manager: RoutineManager, store: Pick<ChatSource, "bots" | "groups" | "lastActivityAt"> & Pick<Store, "isMailboxSealed">, desktop: boolean) => ChatSource;
const filters: ChatFilters[] = [{}, { routines: false }, { routines: true }, { unread: true, routines: true }, { pinned: true, routines: true },
  { groupId: "history-room-0", routines: true }, { dateFrom: HISTORY_NOW - 10, dateTo: HISTORY_NOW + 10, routines: true },
  { q: "nothing-matches", routines: true }, { archived: true, routines: true }];
function chatRoster(sealed: ReadonlySet<string> = new Set()) {
  const task = (threadId: string, n: number) => ({ threadId, title: `Fixture ${n}`, createdAt: HISTORY_NOW - Math.floor(n / 2), pinned: n % 7 === 0, unread: n % 3 === 0 });
  const bots = Array.from({ length: 3 }, (_, b) => ({ id: `history-bot-${b}`, name: `Fixture ${b}`, threadId: `bot-main-${b}`, hidden: b === 2,
    tasks: Array.from({ length: 20 }, (_, n) => ({ ...task(`chat-b${b}-${n}`, n), ...(n % 5 === 0 ? { channelProjectDesk: { groupId: "history-room-0" } } : {}) })) }));
  const groups = Array.from({ length: 2 }, (_, g) => ({ id: `history-room-${g}`, name: `Fixture room ${g}`, threadId: `room-main-${g}`, hidden: g === 1, createdAt: HISTORY_NOW,
    tasks: Array.from({ length: 10 }, (_, n) => task(`chat-g${g}-${n}`, n)) }));
  // The same thread is present under a bot and a room: room projection must never expose botId.
  bots[0].tasks[10].threadId = groups[0].tasks[0].threadId;
  // chatSource (index.ts) reads the real Store seam store.isMailboxSealed (store.ts:3562, a Store method every store has); a thread is sealed only when the caller names it.
  return { bots, groups, lastActivityAt: (threadId: string) => threadId.endsWith("0") ? HISTORY_NOW : undefined, isMailboxSealed: (threadId: string) => sealed.has(threadId) };
}
// A throw from the production chatSource under test (for example a store seam the fake lacks) is returned as a value, so it fails the list/search comparison below instead of aborting setup.
function settle<T>(run: () => T): T | { threw: string } {
  try { return run(); } catch (error) { return { threw: String(error) }; }
}
function compare(manager: RoutineManager, roster: ReturnType<typeof chatRoster>) {
  const map = oldMap(manager);
  const accessor = (manager as RoutineManager & { chatRoutineOf?: (threadId: string) => unknown }).chatRoutineOf;
  if (accessor) for (const thread of new Set([...map.keys(), ...roster.bots.flatMap(bot => bot.tasks.map(task => task.threadId)), ...roster.groups.flatMap(group => group.tasks.map(task => task.threadId)), "missing-thread"]))
    expect(accessor.call(manager, thread), thread).toEqual(map.get(thread));
  for (const desktop of [true, false]) {
    const actual = currentSource(manager, roster, desktop);
    const expected: ChatSource = { ...roster, desktop, routineOf: (threadId, owner) => {
      const run = map.get(threadId);
      return run && (owner.groupId ? run.groupId === owner.groupId : run.botId === owner.botId) ? { routineId: run.routineId, routineName: run.routineName } : undefined;
    } };
    for (const filter of filters) {
      let cursor: string | null = null, pages = 0;
      do {
        const page = settle(() => pageChats(actual, filter, cursor, 7)), reference = pageChats(expected, filter, cursor, 7);
        expect(page, `complete page desktop=${desktop} filter=${JSON.stringify(filter)}`).toEqual(reference);
        cursor = reference!.next; expect(++pages).toBeLessThan(30);
      } while (cursor);
      expect(settle(() => chatSearchRows(actual, filter)), `complete search desktop=${desktop}`).toEqual(chatSearchRows(expected, filter));
    }
  }
  expect(manager.verifyIndexes()).toEqual([]);
}
function seedCases(manager: RoutineManager) {
  const inside = historyInside(manager), template = manager.listRuns()[0];
  let serial = 0;
  function add(threadId: string, fields: Partial<RoutineRun> = {}) {
    return inside.appendRun({ ...template, id: `case-run-${serial++}`, threadId, botId: "history-bot-0", target: "bot", groupId: undefined,
      scheduledFor: HISTORY_NOW + serial, finishedAt: HISTORY_NOW, status: "completed", delivery: { state: "pending" }, ...fields });
  }
  const first = add("chat-b0-0", { scheduledFor: HISTORY_NOW + 100, routineName: "Tie first" });
  add("chat-b0-0", { scheduledFor: first.scheduledFor, routineName: "Tie second" });
  add("chat-b0-1", { routineName: "Older ordinary" }); add("chat-b0-1", { triggerSource: "channel", routineName: "Channel excluded" });
  add("chat-b0-2", { routineName: "Older bot" }); add("chat-b0-2", { target: "room-goal", groupId: undefined });
  add("chat-g0-0", { target: "room-goal", groupId: "history-room-0", botId: "history-bot-0", routineName: "Room only" });
  add("chat-b0-3", { routineName: "Older owner A" }); add("chat-b0-3", { botId: "history-bot-1", routineName: "Newest owner B" });
  add("chat-b0-4", { routineName: "Saved name before rename" });
  add("chat-b0-5", { routineId: "deleted-routine", routineName: "Saved deleted routine" });
  add("deleted-bot-task", { botId: "deleted-bot" }); add("deleted-room-task", { target: "room-goal", groupId: "deleted-room" });
  add("chat-b2-0", { botId: "history-bot-2" }); add("chat-g1-0", { target: "room-goal", groupId: "history-room-1" });
  add("chat-b0-6", { status: "failed", seenAt: HISTORY_NOW }); add("chat-b0-7", { status: "running", finishedAt: undefined });
  add("chat-b0-8", { scheduledFor: NaN, routineName: "Invalid date" });
  add("chat-b0-9", { status: "completed", seenAt: HISTORY_NOW });
  manager.recoverPersistence();
  return { add, first };
}

type Mutations = ReturnType<typeof historyInside> & {
  commitScoped(scope: { runs?: RoutineRun[]; append?: RoutineRun }, change: () => void): void;
  commitMutation(change: () => void): void;
  serviceRetirement(token: { remaining: number }): void;
};

it("H1 full list/search output matches pre-H1 selection for all edge cases and 200 deterministic mutations", () => {
  const root = mkdtempSync(join(tmpdir(), "routine-history-equivalence-"));
  const f = directRoutineHistoryFixture(root, 2_000), manager = f.manager, inside = historyInside(manager) as Mutations, roster = chatRoster();
  try {
    const cases = seedCases(manager);
    compare(manager, roster);
    const initial = oldMap(manager);
    expect(initial.get("chat-b0-0")?.routineName).toBe("Tie first");
    expect(initial.get("chat-b0-1")?.routineName).toBe("Older ordinary");
    expect(initial.get("chat-b0-2")?.routineName).toBe("Older bot");
    expect(initial.get("chat-b0-3")?.botId).toBe("history-bot-1");
    expect(initial.get("chat-g0-0")).not.toHaveProperty("botId");
    expect(initial.get("chat-b0-8")?.routineName).toBe("Invalid date");
    manager.update(f.definitions[0].id, { name: "Renamed definition" });
    manager.remove(f.definitions[1].id);
    compare(manager, roster);
    for (let step = 0; step < 200; step++) {
      const run = inside.indexes.runsById.get("history-run-9")!;
      switch (step % 10) {
        case 0: cases.add(`chat-b0-${step % 20}`, { scheduledFor: HISTORY_NOW + step + 1000 }); break;
        case 1: run.threadId = `chat-b0-${step % 20}`; break;
        case 2: run.status = step % 20 === 2 ? "failed" : "completed"; run.seenAt = step % 30 ? HISTORY_NOW : undefined; break;
        case 3: run.scheduledFor = step % 30 ? HISTORY_NOW + step : NaN; break;
        case 4: {
          const victim = [...inside.runStore].find(row => row.id.startsWith("case-run-") && row !== cases.first);
          if (victim) manager.deleteRun(victim.id); break;
        }
        case 5: {
          // Above the cap, only deliberately expired completed runs can be retired.
          const expired = cases.add(`chat-b0-${step % 20}`, { finishedAt: HISTORY_NOW - 25 * 3600000, scheduledFor: HISTORY_NOW + step + 2000 });
          inside.serviceRetirement({ remaining: 32 }); expect(inside.runStore.has(expired)).toBe(false); break;
        }
        case 6: {
          manager.recoverPersistence();
          const old = run.threadId;
          expect(() => inside.commitScoped({ runs: [run] }, () => { run.threadId = "rolled-back-thread"; throw new Error("fixture scoped rollback"); })).toThrow("fixture scoped rollback");
          expect(run.threadId).toBe(old); break;
        }
        case 7: {
          manager.recoverPersistence();
          const append: RoutineRun = { ...manager.listRuns()[0], id: `quarantine-${step}`, threadId: "chat-b0-1", scheduledFor: HISTORY_NOW + 5000 + step };
          const fault = vi.spyOn(inside.journal, "append").mockImplementation(() => { throw new Error("fixture durable failure"); });
          try { expect(() => inside.commitScoped({ append }, () => { inside.appendRun(append); })).toThrow("fixture durable failure"); } finally { fault.mockRestore(); }
          expect(inside.indexes.runsById.has(append.id)).toBe(true);
          expect(manager.listRuns().some(row => row.id === append.id)).toBe(false);
          compare(manager, roster); manager.recoverPersistence(); break;
        }
        case 8: {
          const before = oldMap(manager);
          const fault = vi.spyOn(inside, "save").mockImplementationOnce(() => { throw new Error("fixture full save failure"); });
          try { expect(() => inside.commitMutation(() => { run.threadId = "full-rollback-thread"; })).toThrow("fixture full save failure"); } finally { fault.mockRestore(); }
          expect(oldMap(manager)).toEqual(before); break;
        }
        case 9: inside.replaceStore(manager.listRuns()); break;
      }
      compare(manager, roster);
    }
    inside.saveFull(); manager.stop();
    const restarted = new RoutineManager({ file: join(root, "routines.json"), now: () => HISTORY_NOW, botState: () => "ready", createTask: () => null, startTurn: async () => {} });
    try { compare(restarted, roster); } finally { restarted.stop(); }
  } finally { manager.stop(); removeTempDirSync(root); }
}, 300_000);

it("H1 focused membership and projection preserve the full old output", () => {
  const root = mkdtempSync(join(tmpdir(), "routine-history-focused-"));
  const f = directRoutineHistoryFixture(root, 10), manager = f.manager, inside = historyInside(manager) as Mutations, roster = chatRoster();
  try {
    const cases = seedCases(manager); compare(manager, roster);
    const previous = manager.chatRoutineOf("chat-b0-0");
    cases.first.routineName = "Updated saved run name";
    const renamed = manager.chatRoutineOf("chat-b0-0");
    expect(renamed).not.toBe(previous); expect(renamed).toEqual({ ...previous, routineName: "Updated saved run name" });
    compare(manager, roster);
    const run = inside.indexes.runsById.get("history-run-9")!;
    run.threadId = "chat-b0-1"; run.scheduledFor = HISTORY_NOW + 9000; compare(manager, roster);
    run.threadId = "chat-b0-2"; run.scheduledFor = HISTORY_NOW + 9001; compare(manager, roster);
    manager.deleteRun(cases.first.id); compare(manager, roster);
    const append = { ...manager.listRuns()[0], id: "focused-quarantine", threadId: "chat-b0-1", scheduledFor: HISTORY_NOW + 10000 };
    const fault = vi.spyOn(inside.journal, "append").mockImplementation(() => { throw new Error("fixture append failure"); });
    try { expect(() => inside.commitScoped({ append }, () => { inside.appendRun(append); })).toThrow("fixture append failure"); }
    finally { fault.mockRestore(); }
    expect(manager.listRuns().some(row => row.id === append.id)).toBe(false);
    compare(manager, roster); manager.recoverPersistence();
  } finally { manager.stop(); removeTempDirSync(root); }
});

function seedRestartCases(manager: RoutineManager) {
  seedCases(manager);
  const inside = historyInside(manager);
  for (const run of [...inside.runStore].reverse()) {
    if (inside.runStore.size === 2000) break;
    if (run.id.startsWith("history-run-")) inside.removeRun(run);
  }
  expect(inside.runStore.size, "all selection cases within exactly 2,000 retained runs").toBe(2000);
  inside.saveFull();
}

function reload(root: string) {
  return new RoutineManager({ file: join(root, "routines.json"), now: () => HISTORY_NOW, botState: () => "ready", createTask: () => null, startTurn: async () => {} });
}
for (const stage of ["before", "after"]) it(`H1 journal crash ${stage} scoped append durable write rebuilds old list/search output`, () => {
  const root = mkdtempSync(join(tmpdir(), "routine-history-crash-")), snapshot = mkdtempSync(join(tmpdir(), "routine-history-crash-snapshot-"));
  const f = directRoutineHistoryFixture(root, 2000), manager = f.manager, inside = historyInside(manager) as Mutations;
  try {
    seedRestartCases(manager); manager.stop();
    const append = { ...manager.listRuns()[0], id: "crash-append", threadId: "chat-b0-0", scheduledFor: HISTORY_NOW + 10000 };
    let captured = false;
    historyFault.capture = () => { cpSync(root, snapshot, { recursive: true }); captured = true; };
    historyFault.stage = stage;
    expect(() => inside.commitScoped({ append }, () => { inside.appendRun(append); })).toThrow();
    expect(captured).toBe(true);
    const restarted = reload(snapshot);
    try {
      expect(historyInside(restarted).runStore.size).toBe(2000 + (stage === "after" ? 1 : 0));
      expect(restarted.runById(append.id) !== null).toBe(stage === "after");
      compare(restarted, chatRoster());
    } finally { restarted.stop(); }
  } finally { historyFault.stage = ""; historyFault.capture = undefined; manager.stop(); removeTempDirSync(root); removeTempDirSync(snapshot); }
});

it("H1 failed save and timed index repair preserve list/search output", async () => {
  const root = mkdtempSync(join(tmpdir(), "routine-history-recovery-"));
  const f = directRoutineHistoryFixture(root, 2000), manager = f.manager, inside = historyInside(manager) as Mutations & { halted: boolean; requestRecovery(indexRepair: boolean): void };
  try {
    seedRestartCases(manager);
    const failed = vi.spyOn(inside.journal, "append").mockImplementationOnce(() => { throw new Error("fixture save failure"); });
    const run = inside.indexes.runsById.get("history-run-9")!; run.output = "Updated before recovery";
    try { expect(() => inside.save({ runs: [run] })).toThrow("fixture save failure"); } finally { failed.mockRestore(); }
    inside.indexes.runsById.delete(run.id); // Force repair to rebuild, rather than only verify.
    const repair = vi.spyOn(manager, "repairIndexes");
    inside.halted = false; inside.requestRecovery(true);
    await expect.poll(() => repair.mock.calls.length, { timeout: 15000 }).toBeGreaterThan(0);
    manager.stop(); expect(inside.indexes.runsById.has(run.id)).toBe(true); compare(manager, chatRoster());
    const restarted = reload(root); try { expect(historyInside(restarted).runStore.size).toBe(2000); compare(restarted, chatRoster()); } finally { restarted.stop(); }
  } finally { manager.stop(); removeTempDirSync(root); }
});

it("H1 fixed persisted script has an index-independent byte snapshot", () => {
  historyFault.deterministic = true; historyFault.serial = 0;
  const root = mkdtempSync(join(tmpdir(), "routine-history-bytes-"));
  const f = directRoutineHistoryFixture(root, 2000), manager = f.manager, inside = historyInside(manager);
  try {
    seedRestartCases(manager);
    const run = inside.indexes.runsById.get("history-run-9")!;
    run.threadId = "chat-b0-1"; run.routineName = "Saved fixture name"; inside.save({ runs: [run] }); inside.saveFull(); manager.stop();
    function snapshot(dir: string, prefix = ""): Record<string, string> {
      const result: Record<string, string> = {};
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) Object.assign(result, snapshot(join(dir, entry.name), name + "/"));
        else result[name] = readFileSync(join(dir, entry.name)).toString("base64");
      }
      return result;
    }
    // The mutation driver compares this fixed script's actual files with M10.
    if (process.env.RHIST_BYTES_FILE) writeFileSync(process.env.RHIST_BYTES_FILE, JSON.stringify(snapshot(root)));
    const restarted = reload(root); try { expect(historyInside(restarted).runStore.size).toBe(2000); compare(restarted, chatRoster()); } finally { restarted.stop(); }
  } finally { historyFault.deterministic = false; manager.stop(); removeTempDirSync(root); }
});

it("H1 first request and first routine turn after restart have history-independent work", async () => {
  const requests = [], turns = [];
  for (const size of [10, 10000]) {
    const root = mkdtempSync(join(tmpdir(), "routine-history-first-turn-"));
    const f = directRoutineHistoryFixture(root, size), options = historyInside(f.manager).options;
    const changed = [...historyInside(f.manager).runStore];
    for (let n = 0; n < changed.length; n++) {
      changed[n].threadId = `chat-b0-${n % 10}`; changed[n].botId = "history-bot-0";
      changed[n].target = "bot"; changed[n].groupId = undefined;
    }
    historyInside(f.manager).saveFull(); f.manager.stop();
    const manager = new RoutineManager(options), inside = historyInside(manager);
    try {
      expect(inside.runStore.size).toBe(size);
      const request = await measureHistoryWork(manager, () => settle(() => pageChats(currentSource(manager, chatRoster(), true), {}, null, 10)));
      expect(request.value, "first request page").not.toHaveProperty("threw");
      for (const key of ["storeTraversals", "storeVisits", "runsMaterialized", "cloneRun", "trieEnumerations", "indexTraversals", "indexVisits"] as const) expect(request.work[key], `first request ${key}@${size}`).toBe(0);
      expect(request.work.trieCalls).toBe(10);
      const warm = await measureHistoryWork(manager, () => settle(() => pageChats(currentSource(manager, chatRoster(), true), {}, null, 10)));
      expect(warm.value, "warm request page").not.toHaveProperty("threw");
      expect(warm.work).toEqual(request.work);
      requests.push(request.work);
      const queued = manager.runNow(f.definitions[5].id)!;
      const measured = await measureHistoryWork(manager, async () => {
        await manager.tick(); await new Promise<void>(resolve => setImmediate(resolve));
        const run = inside.indexes.runsById.get(queued.id)!;
        expect(run.status).toBe("running");
        expect(settle(() => pageChats(currentSource(manager, chatRoster(), true), {}, null, 10)), "turn page").not.toHaveProperty("threw");
        manager.handleRuntimeEvent(f.event(run, "turn.started"));
        manager.handleRuntimeEvent(f.event(run, "turn.completed", { ok: true }));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settle(() => pageChats(currentSource(manager, chatRoster(), true), {}, null, 10)), "turn page").not.toHaveProperty("threw");
        expect(run.status).toBe("completed");
      });
      for (const key of ["storeTraversals", "storeVisits", "runsMaterialized", "trieEnumerations", "retainedMapVisits", "journalFullTraversals", "fullCommits"] as const) expect(measured.work[key], `first turn ${key}@${size}`).toBe(0);
      expect(inside.runStore.size).toBe(size + 1); turns.push(measured.work);
      console.info("RHIST_RESTART", JSON.stringify({ size, request: request.work, turn: measured.work }));
      expect(manager.verifyIndexes()).toEqual([]);
    } finally { manager.stop(); removeTempDirSync(root); }
  }
  for (const pair of [requests, turns]) for (const key of ["cloneRun", "runArrayVisits", "runSortComparisons", "serializedRuns"] as const) expect(pair[1][key], `restart parity ${key}`).toBe(pair[0][key]);
  expect(requests[1].trieCalls).toBe(requests[0].trieCalls);
  expect(turns[1].trieCalls - turns[1].retirementChecks).toBe(turns[0].trieCalls - turns[0].retirementChecks);
});

it("H1 accessor visits only its winning run and never enumerates history", async () => {
  const root = mkdtempSync(join(tmpdir(), "routine-history-lookup-"));
  const { manager } = directRoutineHistoryFixture(root, 10);
  try {
    const { value, work } = await measureHistoryWork(manager, () => manager.chatRoutineOf("history-thread-5"));
    expect(value?.routineName).toBe("History 5");
    for (const key of ["storeTraversals", "storeVisits", "runsMaterialized", "cloneRun", "trieEnumerations", "indexTraversals", "indexVisits", "runArrayVisits"] as const) expect(work[key], `accessor ${key}`).toBe(0);
    expect(work.trieCalls).toBe(1);
  } finally { manager.stop(); removeTempDirSync(root); }
});

it("H1 production chatSource shows the mailbox placeholder for exactly the sealed thread, in list and search", async () => {
  const root = mkdtempSync(join(tmpdir(), "routine-history-sealed-"));
  const { manager } = directRoutineHistoryFixture(root, 10);
  try {
    const sealedId = "chat-b0-3", plainId = "chat-b0-4", roster = chatRoster(new Set([sealedId]));
    const source = currentSource(manager, roster, true);
    const page = settle(() => pageChats(source, {}, null, 200)!.chats), search = settle(() => chatSearchRows(source, {}));
    const titleOf = (rows: typeof page | typeof search, id: string) => "threw" in rows ? rows.threw : rows.find(row => row.threadId === id)?.title;
    for (const rows of [page, search]) {
      expect(titleOf(rows, sealedId), "sealed thread title").toBe(MAILBOX_PLACEHOLDER);
      expect(titleOf(rows, plainId), "unsealed thread title").toBe("Fixture 4");
    }
  } finally { manager.stop(); removeTempDirSync(root); }
});
