// Astra r19 closing findings (P1-1, P1-2, P2), resolved within DESIGN-r20.md:
//  a. the queue of pending handoffs is a SQLite table: one pass and its async drains write only the rows they change, at 1k and at 100k pending;
//  b. a deleted conversation's handoffs leave the due structure with it (no stale entries to walk);
//  c. the legacy delegations.json is imported once, exactly once, whatever crashes in between;
//  d. a kill between the start of the peer's turn and the removal of the row never starts a second turn;
//  e. (restore and snapshot cases live in installation-restore-preparation.test.ts and installation-database-snapshot.test.ts);
//  f. retiring restore holds and pruning requests do not scan the owed set per request;
//  g. (the r14-r19 delegation repros stay in their own files and run with this one).
// The scaling tests measure work that really happened: rows and bytes the production statements wrote and read, the bytes the process handed to
// write() (Linux /proc/self/io), and the growth of the write-ahead log, at 1k and at 100k pending handoffs.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { CommsBus } from "./comms-visibility.ts";
import { closeDatabase, database } from "./database.ts";
import {
  DUE_PARKED_BATCH, PENDING_SQL, _drainingCount, _delegationPassLooked, _delegationQueueWrites, _loadPending, _pendingCount, _resetPending, _simulateRestart, discardDelegations,
  dropUnreachableDelegations, findDelegationReceipt, forgetDelegationsForThreads, hasActiveDelegationWork, pendingDelegationInfo, pendingThreads, queueDelegation, reconcileStartedDelegations, releaseParkedDelegations,
} from "./delegations.ts";
import { drainDelegations, drainDelegationsRaw, forceStarted, runOf, writePrompt } from "./testing/handoff-turn.ts";
import { importLegacyDelegations, initializePendingDelegations, queuedDelegationsByThread } from "./pending-delegations-schema.ts";
import { pruneTerminalRoomRequests, reconcileRoomRequestsAtBoot, retireSettledRoomRequestHolds, settledHoldSql, completeRequest, insertRoomRequest, markRequestDispatched, roomRequestByKey } from "./room-requests.ts";
import { RESTORE_HOLDS_DDL } from "./restore-fence.ts";
import { Store } from "./store.ts";
import { released } from "./testing/released.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// ── measuring ─────────────────────────────────────────────────────────────────────
interface Work { statements: number; rowsWritten: number; bytesWritten: number; rowsRead: number }
const work: Work = { statements: 0, rowsWritten: 0, bytesWritten: 0, rowsRead: 0 };
const resetWork = () => { work.statements = 0; work.rowsWritten = 0; work.bytesWritten = 0; work.rowsRead = 0; };
const prototype = DatabaseSync.prototype as unknown as { prepare: (sql: string) => any };
const realPrepare = prototype.prepare;
let counting = false;
/** Wraps every statement that names the queue table, so what a pass really wrote and read is counted rather than assumed. */
function countQueueStatements(): void {
  prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    if (!/pending_delegations\b/.test(sql) || /^\s*(CREATE|PRAGMA)/i.test(sql)) return statement;
    const write = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
    const run = statement.run.bind(statement), get = statement.get.bind(statement), all = statement.all.bind(statement);
    statement.run = (...args: unknown[]) => {
      const result = run(...args);
      if (counting) { work.statements++; if (write && Number(result.changes) > 0) { work.rowsWritten += Number(result.changes); work.bytesWritten += args.reduce<number>((sum, arg) => sum + (typeof arg === "string" ? Buffer.byteLength(arg) : 8), 0); } }
      return result;
    };
    statement.get = (...args: unknown[]) => { const row = get(...args); if (counting) { work.statements++; if (row !== undefined) work.rowsRead++; } return row; };
    statement.all = (...args: unknown[]) => {
      const rows = all(...args);
      if (counting) {
        work.statements++;
        if (write) { work.rowsWritten += rows.length; work.bytesWritten += args.reduce<number>((sum, arg) => sum + (typeof arg === "string" ? Buffer.byteLength(arg) : 8), 0) * rows.length; } else work.rowsRead += rows.length;
      }
      return rows;
    };
    return statement;
  };
}
const processWriteBytes = (): number => {
  try { return Number(/^wchar:\s*(\d+)/m.exec(readFileSync("/proc/self/io", "utf8"))?.[1] ?? NaN); } catch { return NaN; }
};
const walBytes = (): number => { try { return statSync(join(DATA_DIR, "messages.db-wal")).size; } catch { return 0; } };

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); countQueueStatements(); counting = false; resetWork(); _resetPending(); });
afterEach(() => { counting = false; prototype.prepare = realPrepare; _resetPending(); closeDatabase(); });

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out waiting for the drains to finish"); await tick(); }
}
const bus = (liveSender: boolean): CommsBus => ({
  store: { bot: (id: string) => (liveSender && id === "sender" ? { id: "sender", name: "Sender", color: "#000" } : null), botByThread: () => null, groupByThread: () => undefined,
    appendMessage: () => ({ id: "line" }), patchMessage: () => {}, messagesFor: () => [] },
  broadcast: () => {},
}) as unknown as CommsBus;

/** The r19 fixture, written the way a 1.0.1 build wrote it and brought in by the real import: `threads` source threads of `perThread` parked
 * handoffs to a target the registry does not list, `due` threads whose first handoff has waited out its backoff, the rest an hour from due. */
function seedLegacy(threads: number, perThread: number, due: number, sender = "sender"): number {
  const now = Date.now();
  const queue: Record<string, unknown[]> = {};
  for (let t = 0; t < threads; t++) {
    queue[`src-${t}`] = Array.from({ length: perThread }, (_, j) => ({ id: `d-${t}-${j}`, toBotId: "peer", message: `work ${"x".repeat(200)}`, depth: 0, attempts: 0, fromBotId: sender,
      unknownTarget: true, unknownAttempts: 1, unknownRetryAt: t < due && j === 0 ? 1 : now + 3_600_000 }));
  }
  writeFileSync(join(DATA_DIR, "delegations.json"), JSON.stringify(queue, null, 2));
  _loadPending();
  return now;
}
const pendingRows = () => Number((database().prepare("SELECT COUNT(*) AS n FROM pending_delegations").get() as { n: number }).n);

// ── a ─────────────────────────────────────────────────────────────────────────────
describe("a. one timer pass and its async drains do work that follows the due items, never the backlog", () => {
  interface Measured { pending: number; looked: number; queueWrites: number; rowsWritten: number; bytesWritten: number; rowsRead: number; statements: number; processBytes: number; walDelta: number; jsonFile: boolean }
  const measured: Measured[] = [];
  async function onePass(pending: number, liveSender: boolean, due: number): Promise<Measured> {
    const perThread = 10, threads = pending / perThread;
    const now = seedLegacy(threads, perThread, due, liveSender ? "sender" : "sender-not-listed");
    expect(pendingRows()).toBe(pending);
    const db = database();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0");
    const b = bus(liveSender), approvalBus = { store: b.store, broadcast: () => {} } as never;
    resetWork(); counting = true;
    const writesBefore = _delegationQueueWrites(), walBefore = walBytes(), ioBefore = processWriteBytes();
    for (const thread of releaseParkedDelegations(() => false, now)) drainDelegations(b, approvalBus, thread, () => {});
    await until(() => _drainingCount() === 0);                              // the async continuations of every drain have finished
    await tick(); await tick();
    counting = false;
    const result: Measured = { pending, looked: _delegationPassLooked(), queueWrites: _delegationQueueWrites() - writesBefore, rowsWritten: work.rowsWritten, bytesWritten: work.bytesWritten, rowsRead: work.rowsRead,
      statements: work.statements, processBytes: processWriteBytes() - ioBefore, walDelta: walBytes() - walBefore, jsonFile: existsSync(join(DATA_DIR, "delegations.json")) };
    return result;
  }

  for (const pending of [1_000, 100_000]) {
    it(`${pending} pending (10 per thread), live sender, unavailable targets, 100 due: at most 100 row writes, bounded bytes, a bounded read, no queue file`, async () => {
      const result = await onePass(pending, true, 100);
      measured.push(result);
      console.log(`[r20 scaling] ${JSON.stringify(result)}`);
      expect(result.looked).toBe(DUE_PARKED_BATCH);
      expect(result.jsonFile).toBe(false);                                   // the whole-file store is gone
      // everything the process handed to write(), WAL pages included: a few MB, where rewriting the whole backlog per change was 46 MB at 1k and 4.6 GB at 100k
      if (!Number.isNaN(result.processBytes)) expect(result.processBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(result.queueWrites).toBeLessThanOrEqual(100);
      expect(result.rowsWritten).toBeLessThanOrEqual(100);                  // one row per due handoff, however many are queued
      expect(result.rowsWritten).toBeGreaterThan(0);
      // an item is a few hundred bytes plus ids; nothing close to the size of the backlog is written
      expect(result.bytesWritten).toBeLessThanOrEqual(100 * 1_000);
      expect(result.walDelta).toBeLessThanOrEqual(4 * 1024 * 1024);
      // the due query's 100 rows plus, per drained thread of 10, its rows read for the snapshot, again per item, and once at the end (all bounded by the thread, none by the backlog)
      expect(result.rowsRead).toBeLessThanOrEqual(100 + 100 * (10 + 10 + 10) + 10);
    }, 300_000);
  }
  it("the work is the same at 1k and 100k pending: equal rows, equal bytes, equal reads, the same write-ahead log growth", () => {
    expect(measured).toHaveLength(2);
    const [small, large] = measured as [Measured, Measured];
    expect(large.rowsWritten).toBe(small.rowsWritten);
    expect(large.bytesWritten).toBe(small.bytesWritten);
    expect(large.rowsRead).toBe(small.rowsRead);
    expect(large.statements).toBe(small.statements);
    expect(large.looked).toBe(small.looked);
    // pages touched differ only by where the b-tree puts the rows: a handful of 4 KiB frames at most
    expect(Math.abs(large.walDelta - small.walDelta)).toBeLessThanOrEqual(64 * 4_120);
    if (!Number.isNaN(small.processBytes)) expect(large.processBytes).toBeLessThanOrEqual(small.processBytes * 2 + 1024 * 1024);
  });
  for (const pending of [1_000, 100_000]) {
    it(`${pending} pending whose sender the registry does not list: one due handoff is looked at and exactly one row is written`, async () => {
      const result = await onePass(pending, false, 1);
      console.log(`[r20 scaling, sender missing] ${JSON.stringify(result)}`);
      expect(result.rowsWritten).toBe(1);
      expect(result.queueWrites).toBe(1);
      expect(result.looked).toBe(1);
      expect(result.jsonFile).toBe(false);
    }, 300_000);
  }
  it("a settling drain of one thread writes only that thread's rows: queueing, parking and removing a handoff at 100k pending", async () => {
    seedLegacy(10_000, 10, 0);
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const from = store.createBot(), target = store.createBot();
    const b = { store, broadcast: () => {} } as unknown as CommsBus;
    resetWork(); counting = true;
    const queued = queueDelegation(b, from, { toBotId: target.id, message: "one more", depth: 0 }, 2);
    counting = false;
    expect(queued.result).toBe("ok");
    expect(work.rowsWritten).toBe(1);
    expect(work.rowsRead).toBeLessThanOrEqual(2);
    resetWork(); counting = true;
    discardDelegations(b, from.threadId);
    counting = false;
    expect(work.rowsWritten).toBe(1);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
  }, 120_000);
});

// ── b ─────────────────────────────────────────────────────────────────────────────
describe("b. a handoff that left the queue leaves the due structure with it", () => {
  it("100k parked handoffs of deleted conversations: the next pass visits no rows and runs one due probe", { tags: ["nightly"], timeout: 300_000 }, () => {
    const now = seedLegacy(100_000, 1, 100_000);
    expect(pendingRows()).toBe(100_000);
    const threads = Array.from({ length: 100_000 }, (_, i) => `src-${i}`);
    forgetDelegationsForThreads(threads);
    expect(pendingRows()).toBe(0);
    resetWork(); counting = true;
    expect(releaseParkedDelegations(() => false, now)).toEqual([]);
    counting = false;
    expect(_delegationPassLooked()).toBe(0);                    // the old heap handed back 100k stale entries here
    expect(work.rowsRead).toBe(0);
    expect(work.rowsWritten).toBe(0);
    const due = work.statements;
    expect(due).toBeLessThanOrEqual(3);                         // the due probe, and the (empty) walk over busy target bots
    expect(pendingDelegationInfo("d-5-0")).toBeNull();
  });
  it("the due query is an index range scan on pd_due and the busy walk uses the partial index", () => {
    const db = database();
    const plan = (sql: string, ...args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
    expect(plan(PENDING_SQL.due, 1, 1, 1)).toMatch(/USING INDEX pd_due/);
    expect(plan(PENDING_SQL.due, 1, 1, 1)).not.toMatch(/SCAN pending_delegations(?! USING)/);
    expect(plan(PENDING_SQL.nextBusyBot, "")).toMatch(/pd_busy/);
    expect(plan(PENDING_SQL.busyOfBot, "b", "")).toMatch(/pd_busy/);
    expect(plan(PENDING_SQL.byThread, "t")).toMatch(/pd_thread/);
    expect(plan(PENDING_SQL.forgetThread, "t")).toMatch(/pd_thread/);
  });
});

// ── c ─────────────────────────────────────────────────────────────────────────────
describe("c. the legacy delegations.json is imported once", () => {
  const legacyFile = () => join(DATA_DIR, "delegations.json");
  const item = (id: string | undefined, extra: Record<string, unknown> = {}) => ({ ...(id ? { id } : {}), toBotId: "peer", message: `m-${id}`, depth: 0, attempts: 0, fromBotId: "sender", ...extra });
  const write = (queue: Record<string, unknown[]>) => writeFileSync(legacyFile(), JSON.stringify(queue, null, 2));
  const ids = () => Object.values(queuedDelegationsByThread(database())).flat().map((row) => row.id as string);

  it("a crash before the commit leaves the table empty and the file in place; the next start imports everything", () => {
    write({ a: [item("1"), item("2")], b: [item("3")] });
    const db = database();
    expect(() => importLegacyDelegations(db, { beforeCommit: () => { throw new Error("killed before the commit"); } })).toThrow("killed");
    expect(pendingRows()).toBe(0);
    expect(existsSync(legacyFile())).toBe(true);
    expect(importLegacyDelegations(db)).toBe(3);
    expect(ids().sort()).toEqual(["1", "2", "3"]);
    expect(existsSync(legacyFile())).toBe(false);
  });
  it("a crash after the commit with the file still present: the next start only removes the file, nothing is duplicated", () => {
    write({ a: [item("1"), item("2")] });
    const db = database();
    expect(() => importLegacyDelegations(db, { afterCommit: () => { throw new Error("killed after the commit"); } })).toThrow("killed");
    expect(pendingRows()).toBe(2);
    expect(existsSync(legacyFile())).toBe(true);
    expect(importLegacyDelegations(db)).toBe(0);
    expect(existsSync(legacyFile())).toBe(false);
    expect(ids().sort()).toEqual(["1", "2"]);
    // even a copy of the same file put back (a restored data directory) is not imported twice
    write({ a: [item("1"), item("2"), item("9")] });
    expect(importLegacyDelegations(db)).toBe(0);
    expect(ids().sort()).toEqual(["1", "2"]);
  });
  it("a file written before items had ids gives each an id once, and the same file is never imported again", () => {
    write({ a: [item(undefined), item(undefined)], b: [item(undefined)] });
    _loadPending();
    const first = ids();
    expect(first).toHaveLength(3);
    expect(new Set(first).size).toBe(3);
    _simulateRestart(); _loadPending();
    expect(ids()).toEqual(first);
  });
  it("a corrupt file is kept as evidence in recovery-quarantine and the marker is set", () => {
    writeFileSync(legacyFile(), "{not json");
    _loadPending();
    expect(pendingRows()).toBe(0);
    expect(existsSync(legacyFile())).toBe(false);
    expect(readdirSync(join(DATA_DIR, "recovery-quarantine")).some((name) => name.startsWith("delegations.unreadable-"))).toBe(true);
    expect(Boolean(database().prepare("SELECT 1 AS x FROM pending_delegations_import").get())).toBe(true);
  });
  it("entries that do not validate are not imported; the others keep their order", () => {
    write({ a: [item("ok-1"), item("bad", { eventId: " " }), item("ok-2"), { id: "no-message", toBotId: "peer", depth: 0 }, item("ok-3", { executionAudience: { v: 1, kind: "team", human: "owner", team: "../escape", rootRequestId: "r" } })] });
    _loadPending();
    expect(ids()).toEqual(["ok-1", "ok-2"]);
  });
  it("the phase and the retry time come from the file's own flags", () => {
    const now = Date.now();
    write({ a: [item("fresh"), item("busy", { waitingOnBusy: true, waitingSince: now }), item("parked", { unknownTarget: true, unknownRetryAt: now + 5 })] });
    _loadPending();
    const rows = database().prepare("SELECT id, phase, retry_at FROM pending_delegations ORDER BY rowid").all() as Array<{ id: string; phase: string; retry_at: number | null }>;
    expect(rows).toEqual([{ id: "fresh", phase: "fresh", retry_at: null }, { id: "busy", phase: "busy", retry_at: now + 5 * 60_000 }, { id: "parked", phase: "parked", retry_at: now + 5 }]);
  });
  it("a 1.0.1 queue of 100k items (the layout of commit 196c48ae8) is imported whole, in order, and every handoff runs once", async () => {
    const threads = 10_000, per = 10;
    const queue: Record<string, unknown[]> = {};
    for (let t = 0; t < threads; t++) queue[`t-${t}`] = Array.from({ length: per }, (_, j) => ({ id: `i-${t}-${j}`, toBotId: "peer", message: `go ${t}.${j}`, depth: 0, attempts: 0, fromBotId: "sender" }));
    write(queue);
    const started = Date.now();
    _loadPending();
    console.log(`[r20 import] 100000 items imported in ${Date.now() - started} ms`);
    expect(pendingRows()).toBe(threads * per);
    expect(existsSync(legacyFile())).toBe(false);
    // per-thread order is the file's order
    const grouped = queuedDelegationsByThread(database());
    for (let t = 0; t < threads; t += 997) expect(grouped[`t-${t}`]!.map((row) => row.id)).toEqual(Array.from({ length: per }, (_, j) => `i-${t}-${j}`));
    expect(Object.keys(grouped)).toHaveLength(threads);
    // a restart brings nothing in a second time
    _simulateRestart(); _loadPending();
    expect(pendingRows()).toBe(threads * per);
    // drain a sample of threads: every handoff of them runs exactly once, in order
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const sender = store.createBot(), peer = store.createBot();
    const live = { store, broadcast: () => {} } as unknown as CommsBus;
    const sample = 40, ran: string[] = [];
    database().prepare("UPDATE pending_delegations SET to_bot_id=?, from_bot_id=? WHERE source_thread_id IN (SELECT source_thread_id FROM pending_delegations GROUP BY source_thread_id LIMIT ?)").run(peer.id, sender.id, sample);
    const threadsToDrain = (database().prepare("SELECT DISTINCT source_thread_id AS t FROM pending_delegations WHERE to_bot_id=? ORDER BY rowid").all(peer.id) as Array<{ t: string }>).map((row) => row.t);
    for (const thread of threadsToDrain) drainDelegations(live, { store, broadcast: () => {} } as never, thread, async (_to, message) => { ran.push(message.replace(/^.*\n\n/s, "")); });
    await until(() => !hasActiveDelegationWork() || ran.length >= sample * per, 120_000);
    await until(() => _pendingCount(threadsToDrain[0]!) === 0 && threadsToDrain.every((thread) => _pendingCount(thread) === 0), 120_000);
    expect(ran).toHaveLength(sample * per);
    expect(new Set(ran).size).toBe(sample * per);
    for (const thread of threadsToDrain.slice(0, 5)) {
      const [, t] = /^t-(\d+)$/.exec(thread)!;
      expect(ran.filter((message) => message.startsWith(`go ${t}.`))).toEqual(Array.from({ length: per }, (_, j) => `go ${t}.${j}`));
    }
    // the drained hand-offs are started (their rows stay until their turns' receipts); every other one is still queued
    expect(Number((database().prepare("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase<>'started'").get() as { n: number }).n)).toBe((threads - sample) * per);
  }, 600_000);
  it("an entry added to the table by hand that no longer validates is removed with an error receipt, never run", async () => {
    initializePendingDelegations(database());
    database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item) VALUES('broken','tt','peer','sender','fresh',NULL,'{not json')").run();
    expect(pendingDelegationInfo("broken")).toBeNull();
    expect(pendingRows()).toBe(0);
    expect(findDelegationReceipt("broken")).toMatchObject({ status: "error", result: "the queued handoff could not be read" });
  });
});

// ── d ─────────────────────────────────────────────────────────────────────────────
describe("d. a kill between the start of the peer's turn and the removal of the row never starts a second turn", () => {
  function setup() {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const from = store.createBot(), target = store.createBot();
    store.patchBot(target.id, { name: "Helper" });
    // a room turn made the handoff: its running root request, and the child ask the harness creates for the handoff (index.ts beginRoomAsk)
    insertRoomRequest(database(), { id: "root", groupId: "g", verb: "owner_send", fromKind: "owner", toBotId: from.id, targetThreadId: from.threadId, admissionKey: "root", now: 1,
      lineage: { rootThreadId: from.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } });
    markRequestDispatched(database(), "root", { now: 1 });
    // a room hand-off starts once the turn that made it has settled: that turn waits on its asks (F3: a turn still running at boot ends its whole subtree)
    database().prepare("UPDATE room_requests SET state='waiting_bot', waiting_since=1 WHERE id='root'").run();
    const b = { store, broadcast: () => {}, prepareDelegation: (fromBotId: string, to: string, source: string, _message: string, id: string) => {
      insertRoomRequest(database(), { id, groupId: "g", verb: "ask", fromKind: "bot", fromBotId, toBotId: to, parentId: "root", returnThreadId: source, returnBotId: fromBotId, admissionKey: `ask:delegation:${id}`, now: 2 });
      return "room" as const;
    } } as unknown as CommsBus;
    return { store, from, target, b, approvalBus: { store, broadcast: () => {} } as never };
  }
  it("the row is still there after the kill; the re-drain starts nothing and leaves one receipt", async () => {
    const { from, target, b, approvalBus } = setup();
    const queued = queueDelegation(b, from, { toBotId: target.id, message: "do it once", depth: 0 }, 2);
    expect(queued.result).toBe("ok");
    const started: string[] = [];
    // the first process: the turn starts (the request is dispatched) and the process dies before the drain removes the row
    drainDelegationsRaw(b, approvalBus, from.threadId, (_to, message, _depth, _source, _channel, taskId) => {
      started.push(message);
      // what index.ts startTurn does: the prompt under the row's turn key and the start, in one commit; then the provider takes the turn
      writePrompt(b, runOf(taskId), target.threadId);
      runOf(taskId).accepted("turn-1");
      return new Promise<void>(() => { /* never returns: the kill */ });
    });
    await until(() => started.length === 1);
    expect(_pendingCount(from.threadId)).toBe(0);                // started: not queued work any more
    expect(pendingRows()).toBe(1);                               // the row stays until the turn's receipt
    // the restart: the previous process's memory is gone; boot settles the row first, then the room requests
    _simulateRestart();
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 1 });
    expect(reconcileRoomRequestsAtBoot(database(), 3)).toMatchObject({ unknown: 1 });     // the hand-off's request (the room turn waits on it and is woken)
    const again: string[] = [];
    drainDelegations(b, approvalBus, from.threadId, (_to, message) => { again.push(message); });
    await tick();
    expect(again).toEqual([]);                                   // no second turn
    expect(started).toHaveLength(1);
    expect(pendingRows()).toBe(0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "failed", result: "interrupted by a restart" });
    // and a further drain finds nothing to do
    drainDelegations(b, approvalBus, from.threadId, (_to, message) => { again.push(message); });
    await tick();
    expect(again).toEqual([]);
  });
  it("a turn still running when its handoff is drained again is left alone: no second turn, no receipt of its own", async () => {
    const { from, target, b, approvalBus } = setup();
    const queued = queueDelegation(b, from, { toBotId: target.id, message: "still running", depth: 0 }, 2);
    forceStarted(queued.id!, "peer-thread");
    const again: string[] = [];
    drainDelegations(b, approvalBus, from.threadId, (_to, message) => { again.push(message); });
    await tick();
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(again).toEqual([]);
    expect(findDelegationReceipt(queued.id!)).toBeNull();
    expect(roomRequestByKey(database(), `ask:delegation:${queued.id}`)!.state).toBe("running");
  });
  it("a receipt already on record for the handoff is not replaced by the cancelled one", async () => {
    const { from, target, b, approvalBus } = setup();
    const queued = queueDelegation(b, from, { toBotId: target.id, message: "already answered", depth: 0 }, 2);
    const row = roomRequestByKey(database(), `ask:delegation:${queued.id}`)!;
    completeRequest(database(), row.id, { state: "done", now: 3 });
    const { recordDelegationReceipt } = await import("./delegations.ts");
    recordDelegationReceipt({ id: queued.id!, sourceThreadId: from.threadId, toBotId: target.id, toBotName: "Helper", status: "done", result: released("the real answer") });
    drainDelegations(b, approvalBus, from.threadId, () => { throw new Error("must not start"); });
    await until(() => _pendingCount(from.threadId) === 0);
    // a receipt keeps the reply as bounded plain text (DelegationReceipt.result is a string; its origin rides in copyOf)
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "done", result: "the real answer" });
  });
});

// ── the optional items: one transaction for queueing, paged roster checks ─────────────────
describe("queueing is one transaction, and the roster check is paged", () => {
  it("a failed insert takes the room request prepared for the handoff with it", () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const from = store.createBot(), target = store.createBot();
    const b = { store, broadcast: () => {}, prepareDelegation: (_f: string, to: string, source: string, _m: string, id: string) => {
      insertRoomRequest(database(), { groupId: "g", verb: "ask", fromKind: "bot", toBotId: to, admissionKey: `ask:delegation:${id}`, now: 1,
        lineage: { rootThreadId: source, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } });
      return "room" as const;
    } } as unknown as CommsBus;
    database().exec("CREATE TRIGGER pd_refuse BEFORE INSERT ON pending_delegations BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(() => queueDelegation(b, from, { toBotId: target.id, message: "refused", depth: 0 }, 2)).toThrow("DELEGATION_PERSISTENCE_FAILED");
    expect(Number((database().prepare("SELECT COUNT(*) AS n FROM room_requests").get() as { n: number }).n)).toBe(0);
    expect(pendingRows()).toBe(0);
    database().exec("DROP TRIGGER pd_refuse");
    expect(queueDelegation(b, from, { toBotId: target.id, message: "accepted", depth: 0 }, 2).result).toBe("ok");
    expect(Number((database().prepare("SELECT COUNT(*) AS n FROM room_requests").get() as { n: number }).n)).toBe(1);
  });
  it("a team change over 1,200 queued handoffs is checked in pages of 500 with the event loop free between them", async () => {
    const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const sender = store.createBot({ name: "Sender", section: "Ops" }), moved = store.createBot({ name: "Moved", section: "Ops" }), stays = store.createBot({ name: "Stays", section: "Ops" });
    const b = { store, broadcast: () => {} } as unknown as CommsBus;
    const insert = database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item) VALUES(?,?,?,?,'fresh',NULL,?)");
    database().exec("BEGIN");
    for (let i = 0; i < 1_200; i++) insert.run(`p-${i}`, sender.threadId, i % 2 === 0 ? moved.id : stays.id, sender.id, JSON.stringify({ message: `m${i}`, depth: 0, attempts: 0 }));
    database().exec("COMMIT");
    expect(store.setBotsSection([moved.id], "Sales").ok).toBe(true);
    let freeBetweenPages = false;
    const sweep = dropUnreachableDelegations(b);
    setImmediate(() => { freeBetweenPages = true; });
    const dropped = await sweep;
    expect(freeBetweenPages).toBe(true);
    expect(dropped).toBe(600);
    expect(pendingRows()).toBe(600);
    expect(findDelegationReceipt("p-1198")).toMatchObject({ status: "dropped" });   // (the receipt drawer keeps the newest 100)
    expect(findDelegationReceipt("p-1199")).toBeNull();
    // a change that arrives while a sweep runs gets one more pass after it
    const first = dropUnreachableDelegations(b), second = dropUnreachableDelegations(b);
    expect(await first).toBe(await second);
  }, 120_000);
});

// ── pages ─────────────────────────────────────────────────────────────────────────
describe("the boot and capacity drains read pages of threads that run or wait on a teammate", () => {
  it("pendingThreads(after, limit) is ordered, paged, and leaves parked handoffs to the due query", () => {
    const insert = database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item) VALUES(?,?,?,?,?,?,?)");
    database().exec("BEGIN");
    for (let i = 0; i < 250; i++) insert.run(`f-${i}`, `fresh-${String(i).padStart(3, "0")}`, "peer", "s", i % 5 === 0 ? "busy" : "fresh", i % 5 === 0 ? 1 : null, "{}");
    for (let i = 0; i < 50; i++) insert.run(`k-${i}`, `parked-${i}`, "peer", "s", "parked", 1, "{}");
    database().exec("COMMIT");
    const first = pendingThreads("", 100);
    expect(first).toHaveLength(100);
    expect(first).toEqual([...first].sort());
    const second = pendingThreads(first.at(-1)!, 100), third = pendingThreads(second.at(-1)!, 100);
    expect([...first, ...second, ...third]).toHaveLength(250);
    expect(new Set([...first, ...second, ...third]).size).toBe(250);
    expect([...first, ...second, ...third].some((thread) => thread.startsWith("parked-"))).toBe(false);
    expect(pendingThreads(third.at(-1)!, 100)).toEqual([]);
  });
});

// ── f ─────────────────────────────────────────────────────────────────────────────
describe("f. restore holds and request pruning do not scan the owed set per request", () => {
  const COLUMNS = "id,root_id,parent_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,payload_text,refusal,created_at,deadline_at,finished_at,root_thread_id,return_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key";
  const planOf = (db: DatabaseSync, sql: string, args: unknown[] = []) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");

  function setup(db: DatabaseSync, holds: number, owed: number): void {
    const insert = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,NULL,?,'ask','bot','b0','tt0','expired',NULL,NULL,1,NULL,1,'t',NULL,'desktop','fp',0,0,?)`);
    const hold = db.prepare("INSERT INTO restore_holds(kind,row_id,generation) VALUES('room_request',?,'gen')");
    const owe = db.prepare("INSERT OR IGNORE INTO room_request_owed(kind, request_id) VALUES('fanout', ?)");
    db.exec(RESTORE_HOLDS_DDL);
    db.exec("BEGIN");
    for (let i = 0; i < holds; i++) { insert.run(`req-${i}`, `req-${i}`, "g", `key-${i}`); hold.run(`req-${i}`); }
    for (let i = 0; i < owed; i++) owe.run(`other-${i}`);   // owed requests unrelated to the holds
    db.exec("COMMIT");
  }
  it("the statement that decides a hold has no list subquery and no scan of the owed set", () => {
    const db = database();
    const plan = planOf(db, settledHoldSql(db), ["req-0"]);
    expect(plan).not.toMatch(/LIST SUBQUERY/);
    expect(plan).not.toMatch(/SCAN (room_request_owed|project_card_delivery_owed|room_request_dismissal_receipts)\b/);
    expect(plan).toMatch(/room_request_owed_request|sqlite_autoindex_room_request_owed/);
  });
  it("the owed index exists and the trigger that clears owed rows with a pruned request searches it", () => {
    const db = database();
    expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='index' AND name='room_request_owed_request'").get()).toBeTruthy();
    // the trigger's own statement (its text is unchanged, so an older archive still passes inspection) searches the index
    const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='room_request_owed_gone'").get() as { sql: string };
    expect(trigger.sql).toContain("DELETE FROM room_request_owed WHERE request_id=OLD.id");
    const plan = planOf(db, "DELETE FROM room_request_owed WHERE request_id=?", ["req-0"]);
    expect(plan).not.toMatch(/SCAN room_request_owed\b/);
    expect(plan).toMatch(/room_request_owed_request/);
  });
  const timings: Array<{ owed: number; retireMs: number; pruneMs: number; retired: number; pruned: number }> = [];
  for (const owed of [1_000, 100_000]) {
    it(`10k holds with ${owed} owed rows: every hold retires, then pruning 10k requests, at a cost that does not follow the owed set`, () => {
      const db = database();
      setup(db, 10_000, owed);
      const retireStart = performance.now();
      const retired = retireSettledRoomRequestHolds(db);
      const retireMs = performance.now() - retireStart;
      expect(retired).toBe(10_000);
      const pruneStart = performance.now();
      const pruned = pruneTerminalRoomRequests(db, 400 * 86_400_000);
      const pruneMs = performance.now() - pruneStart;
      expect(pruned).toBe(10_000);
      console.log(`[r20 holds] owed=${owed} retire ${Math.round(retireMs)} ms for 10000 holds, prune ${Math.round(pruneMs)} ms for 10000 requests`);
      timings.push({ owed, retireMs, pruneMs, retired, pruned });
    }, 300_000);
  }
  it("retirement and pruning take about the same time at 1k and 100k owed (flat per hold)", () => {
    const [small, large] = timings as [typeof timings[number], typeof timings[number]];
    expect(large.retireMs).toBeLessThan(Math.max(small.retireMs * 4, 2_000));
    expect(large.pruneMs).toBeLessThan(Math.max(small.pruneMs * 4, 4_000));
  });
});
