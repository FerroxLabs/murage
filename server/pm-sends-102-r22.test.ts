// Astra r21 findings, resolved within DESIGN-r22.md: a hand-off's queue row owns its own exactly-once state.
//  1. the start is one commit with the prompt message (idempotency key = the prompt's id, dlg-<id>); a restart settles every started row by the row alone;
//  2. there is no stand-in room record for an owner-conversation hand-off: sweeps, pruning, completion and restore never see one;
//  3. the owner's recorded deletions (source conversation, sender, target) are checked independently of each other, at import, queue, drain and start;
//  4. going back to 1.0.1 drops every 1.0.2 application object (frozen list), verified against the REAL 1.0.1 inspector extracted from git (d950cbf67).
import { MESSAGE_ID_103_OBJECTS } from "./message-id-index.ts"; // 1.0.3: removed by the downgrade's own step too
import { SEQ_103_OBJECTS } from "./transcript-seq.ts"; // 1.0.3: removed by the downgrade's own step before this one (installation-memory-downgrade.ts)
import { isInboxProjectionObject } from "./inbox.ts";
import { UPGRADE_104_TABLES, UPGRADE_108_TABLES } from "./memory/upgrade-app-tables.ts"; // 1.0.4 and 1.0.8: dropped by the memory downgrade (schema.ts UPGRADE_DERIVED_TABLES)
import { PUSH_RETENTION_103_INDEXES } from "./mobile-push-store.ts"; // 1.0.3: removed by the downgrade's own step before this one (installation-memory-downgrade.ts)
import { BOT_CALLS_109_OBJECTS } from "./bot-calls-schema.ts"; // 1.0.9: removed by the downgrade's own step too (downgradeBotCallsTo108)
import { APP_TRIGGER_OBJECTS } from "./app-trigger-store.ts"; // 1.0.12: removed by the downgrade's own step too (downgradeAppTriggers)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { CommsBus } from "./comms-visibility.ts";
import { closeDatabase, database } from "./database.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import {
  DELEGATION_DELETED, DELEGATION_NOT_STARTABLE, PENDING_SQL, _drainingCount, _loadPending, _pendingCount, _resetPending, _simulateRestart, findDelegationReceipt,
  queueDelegation, reconcileStartedDelegations, recordDelegationReceipt, startedDelegation,
} from "./delegations.ts";
import { dispatchHandoffRequest, drainDelegations, drainDelegationsRaw, runOf, startLikeIndex, writePrompt } from "./testing/handoff-turn.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { APP_SCHEMA_102_ADDITIONS, DOWNGRADE_WORK_PENDING, downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { delegationTurnKey, importLegacyDelegations, legacyImportSkipped, migrateOwnerHandoffRecords } from "./pending-delegations-schema.ts";
import { initializeImageLibrary, initializeImageOperations } from "./image-operations-schema.ts";
import { fenceRestoredSql } from "./restore-fence.ts";
import { insertRoomRequest, markRequestDispatched, pruneTerminalRoomRequests, reconcileRoomRequestsAtBoot, roomRequest, roomRequestByKey, cancelRoomRequest } from "./room-requests.ts";
import { SCHEMA_1_0_1 } from "./schema-1.0.1.ts";
import { recordOwnerDeletion } from "./owner-deletions.ts";
import { Store } from "./store.ts";
import { haveV101 as haveV101Ref, realV101 } from "./testing/pm-sends-v101.ts";
import { released } from "./testing/released.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const haveV101 = haveV101Ref;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const legacyFile = () => join(DATA_DIR, "delegations.json");
const receiptsFile = () => join(DATA_DIR, "delegation-receipts.json");
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const pendingRows = () => count("SELECT COUNT(*) AS n FROM pending_delegations");
const requestRows = () => count("SELECT COUNT(*) AS n FROM room_requests");
const receiptsOf = (id: string) => (existsSync(receiptsFile()) ? JSON.parse(readFileSync(receiptsFile(), "utf8")) as Array<{ id: string }> : []).filter((r) => r.id === id);

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); });
afterEach(() => { _resetPending(); closeDatabase(); });

type Origin = "owner" | "room" | "legacy";
function setup(origin: Origin = "owner") {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const from = store.createBot(), target = store.createBot();
  store.patchBot(target.id, { name: "Helper" });
  let extra: Partial<CommsBus> = {};
  if (origin === "room") {
    // a room turn made the handoff: its running root request, and the child ask the harness creates for the handoff (index.ts beginRoomAsk)
    insertRoomRequest(database(), { id: "root", groupId: "g", verb: "owner_send", fromKind: "owner", toBotId: from.id, targetThreadId: from.threadId, admissionKey: "root", now: 1,
      lineage: { rootThreadId: from.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } });
    markRequestDispatched(database(), "root", { now: 1 });
    // a room hand-off starts once the turn that made it has settled: that turn waits on its asks (F3: a turn still running at boot ends its whole subtree)
    database().prepare("UPDATE room_requests SET state='waiting_bot', waiting_since=1 WHERE id='root'").run();
    extra = { prepareDelegation: (fromBotId: string, to: string, source: string, _m: string, id: string) => {
      insertRoomRequest(database(), { id, groupId: "g", verb: "ask", fromKind: "bot", fromBotId, toBotId: to, parentId: "root", returnThreadId: source, returnBotId: fromBotId, admissionKey: `ask:delegation:${id}`, now: 2 });
      return "room" as const;
    } };
  }
  const b = { store, broadcast: () => {}, ...extra } as unknown as CommsBus;
  return { store, from, target, b, approvalBus: { store, broadcast: () => {} } as never };
}
type World = ReturnType<typeof setup>;

const promptCount = (s: World) => Number((database().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id LIKE 'dlg-%'").get(s.target.threadId) as { n: number }).n);
const refuseDeletes = () => database().exec("CREATE TRIGGER pd_nodelete BEFORE DELETE ON pending_delegations BEGIN SELECT RAISE(ABORT, 'refused'); END");
const allowDeletes = () => database().exec("DROP TRIGGER pd_nodelete");

// ── 1. crash points x origins ───────────────────────────────────────────────────────
type Crash = "before-commit" | "after-commit" | "after-accept" | "after-receipt";
const expectedAfterRestart: Record<Crash, number> = { "before-commit": 1, "after-commit": 1, "after-accept": 0, "after-receipt": 0 };

describe.each(["owner", "room", "legacy"] as Origin[])("1. a hand-off of %s origin starts exactly once through every crash", (origin) => {
  it.each(Object.keys(expectedAfterRestart) as Crash[])("crash %s", async (crash) => {
    const s = setup(origin);
    let id: string;
    if (origin === "legacy") {
      writeFileSync(legacyFile(), JSON.stringify({ [s.from.threadId]: [{ id: "legacy-1", toBotId: s.target.id, message: "from the old build", depth: 0, attempts: 0, fromBotId: s.from.id }] }));
      _loadPending();
      id = "legacy-1";
    } else {
      id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "do it exactly once", depth: 0 }, 2).id!;
    }
    expect(database().prepare("SELECT origin FROM pending_delegations WHERE id=?").get(id)).toMatchObject({ origin: origin === "legacy" ? "legacy" : origin });
    // the first process
    let first = 0;
    if (crash === "after-receipt") refuseDeletes();
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, _m, _d, _s, _c, taskId) => {
      first++;
      if (crash !== "before-commit") writePrompt(s.b, runOf(taskId), s.target.threadId);
      if (crash === "after-accept" || crash === "after-receipt") runOf(taskId).accepted("turn-1");
      if (crash === "after-receipt") recordDelegationReceipt({ id: taskId, sourceThreadId: s.from.threadId, toBotId: s.target.id, toBotName: "Helper", status: "done", result: released("answer") });
      return new Promise<void>(() => { /* never returns: the kill */ });
    });
    await until(() => first === 1);
    if (crash === "after-receipt") expect(pendingRows()).toBe(1);     // the receipt is on record and the row is not gone: the kill
    // the restart: boot settles the started rows first, then the room requests, then the drain
    _simulateRestart();
    if (crash === "after-receipt") allowDeletes();
    _loadPending();
    reconcileStartedDelegations();
    reconcileRoomRequestsAtBoot(database(), 3);
    let second = 0;
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, _m, _d, _s, _c, taskId) => {
      second++;
      writePrompt(s.b, runOf(taskId), s.target.threadId);
      runOf(taskId).accepted("turn-2");
      recordDelegationReceipt({ id: taskId, sourceThreadId: s.from.threadId, toBotId: s.target.id, toBotName: "Helper", status: "done", result: released("answer") });
    });
    await until(() => _drainingCount() === 0);
    await tick();
    expect(second).toBe(expectedAfterRestart[crash]);
    expect(promptCount(s)).toBe(crash === "before-commit" && second === 0 ? 0 : 1);   // one prompt, never two
    expect(pendingRows()).toBe(0);
    expect(findDelegationReceipt(id)).not.toBeNull();
    expect(receiptsOf(id).length).toBeLessThanOrEqual(1);
    if (origin === "room") {
      // the request side agrees: the room reconcile left a re-dispatched request alone, and an interrupted one is closed
      expect(roomRequest(database(), id)).not.toBeNull();
    }
  });
});

describe("1b. the start is one commit with the prompt", () => {
  it("a start that cannot be recorded leaves no prompt; a second start of the same hand-off is refused and adds no second prompt", async () => {
    const s = setup("owner");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "once", depth: 0 }, 2).id!;
    database().exec("CREATE TRIGGER pd_nostart BEFORE UPDATE OF started_at ON pending_delegations BEGIN SELECT RAISE(ABORT, 'refused'); END");
    await expect(startLikeIndex(s.b, s.approvalBus, id)).rejects.toThrow("refused");
    expect(promptCount(s)).toBe(0);
    expect(startedDelegation(id)).toBeNull();
    database().exec("DROP TRIGGER pd_nostart");
    await startLikeIndex(s.b, s.approvalBus, id);
    expect(promptCount(s)).toBe(1);
    expect(startedDelegation(id)).toMatchObject({ targetThreadId: s.target.threadId, turnKey: `dlg-${id}`, startAttempts: 1, acceptedTurnId: null });
    expect(() => runOf(id).start(s.target.threadId)).toThrow(expect.objectContaining({ code: DELEGATION_NOT_STARTABLE }));
    // the same key appended again returns the held prompt and runs no `within`
    let ran = false;
    s.store.appendMessage(s.target.threadId, { role: "user", kind: "text", text: "again" }, delegationTurnKey(id), () => { ran = true; });
    expect(ran).toBe(false);
    expect(promptCount(s)).toBe(1);
  });
  it("a hand-off the queue no longer holds cannot start", async () => {
    const s = setup("owner");
    await expect(startLikeIndex(s.b, s.approvalBus, "nope")).resolves.toBeUndefined();     // the dispatch finds no such hand-off: nothing is started
    expect(promptCount(s)).toBe(0);
    expect(await dispatchHandoff("nope", { bus: s.b, approvalBus: s.approvalBus })).toBe("settled");
  });
  it("a second cut-short start is held for the owner (did not start) instead of a third turn, and is never deleted", async () => {
    const s = setup("owner");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "twice cut", depth: 0 }, 2).id!;
    await startLikeIndex(s.b, s.approvalBus, id);                       // attempt 1, never accepted
    expect(reconcileStartedDelegations()).toMatchObject({ redispatched: 1 });
    expect(database().prepare("SELECT phase, start_attempts FROM pending_delegations WHERE id=?").get(id)).toMatchObject({ phase: "fresh", start_attempts: 1 });
    await startLikeIndex(s.b, s.approvalBus, id);                       // attempt 2 (the held prompt), never accepted
    expect(startedDelegation(id)!.startAttempts).toBe(2);
    expect(reconcileStartedDelegations()).toMatchObject({ held: 1 });
    expect(database().prepare("SELECT phase, started_at FROM pending_delegations WHERE id=?").get(id)).toMatchObject({ phase: "started", started_at: null });   // held, not deleted
    expect(promptCount(s)).toBe(1);
  });
});

describe("1c. shared work: the row is stamped by the start, after the approval wait, never by the dispatch", () => {
  function sharedHandoff(id: string) {
    const s = setup("owner");
    insertRoomRequest(database(), { id, groupId: "g", verb: "ask", fromKind: "bot", fromBotId: s.from.id, toBotId: s.target.id, admissionKey: `ask:delegation:${id}`, now: 1,
      lineage: { rootThreadId: s.from.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } });
    database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, s.from.threadId, s.target.id, s.from.id, "fresh", null, JSON.stringify({ message: "m", depth: 0, attempts: 0 }), "shared", delegationTurnKey(id));
    return s;
  }
  it("dispatching the request leaves the row unstarted; the start (after the wait) stamps it; a restart that finds it accepted receipts it as interrupted, never re-runs it", async () => {
    const s = sharedHandoff("sh-1");
    expect(dispatchHandoffRequest(database(), "sh-1", { now: 5, targetThreadId: s.target.threadId })).toBe(true);
    expect(database().prepare("SELECT phase, target_thread_id, start_attempts FROM pending_delegations WHERE id='sh-1'").get()).toMatchObject({ phase: "fresh", target_thread_id: null, start_attempts: null });
    await startLikeIndex(s.b, s.approvalBus, "sh-1", { accept: "turn-1" });
    expect(database().prepare("SELECT phase, target_thread_id, start_attempts FROM pending_delegations WHERE id='sh-1'").get()).toMatchObject({ phase: "started", target_thread_id: s.target.threadId, start_attempts: 1 });
    _simulateRestart();
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 1 });
    expect(pendingRows()).toBe(0);
    expect(findDelegationReceipt("sh-1")).toMatchObject({ status: "failed", result: "interrupted by a restart" });
    expect(reconcileRoomRequestsAtBoot(database(), 6)).toMatchObject({ unknown: 1 });
    expect(roomRequest(database(), "sh-1")!.state).toBe("unknown");
  });
  it("a shared hand-off whose request is gone is settled with a receipt, never started as a plain hand-off", async () => {
    const s = sharedHandoff("sh-2");
    database().prepare("DELETE FROM room_requests WHERE id='sh-2'").run();
    let started = 0;
    drainDelegations(s.b, s.approvalBus, s.from.threadId, () => { started++; });
    await until(() => _drainingCount() === 0);
    expect(started).toBe(0);
    expect(findDelegationReceipt("sh-2")).toMatchObject({ status: "failed" });
    expect(pendingRows()).toBe(0);
  });
});

// ── 2. r21 finding 2: the prune sequence ────────────────────────────────────────────
describe("2. a pruned or unknown request can no longer bring a hand-off back", () => {
  it("interrupt, unresolved sender, prune at day 31, sender restored: exactly one start in all", async () => {
    const s = setup("room");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "once", depth: 0 }, 2).id!;
    let starts = 0;
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, _m, _d, _s, _c, taskId) => { starts++; writePrompt(s.b, runOf(taskId), s.target.threadId); runOf(taskId).accepted("t1"); return new Promise<void>(() => {}); });
    await until(() => starts === 1);
    _simulateRestart();
    reconcileStartedDelegations();                                       // before the room sweep: receipt, row gone
    expect(reconcileRoomRequestsAtBoot(database(), 3)).toMatchObject({ unknown: 1 });     // the hand-off's request (the room turn waits on it and is woken)
    cancelRoomRequest(database(), "root", { now: 3 });                   // the room turn is let go too, so nothing under the root is live at the prune
    pruneTerminalRoomRequests(database(), 3 + 31 * 24 * 60 * 60 * 1000);
    expect(roomRequestByKey(database(), `ask:delegation:${id}`)).toBeNull();   // pruned
    drainDelegations(s.b, s.approvalBus, s.from.threadId, () => { starts++; });
    await tick();
    expect(starts).toBe(1);
  });
  it("a request whose hand-off row is still in the queue is never pruned from under it, and the boot sweep leaves it alone", () => {
    const s = setup("room");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "waiting", depth: 0 }, 2).id!;
    database().prepare("UPDATE room_requests SET state='done', finished_at=1 WHERE id='root'").run();      // the room turn is over; only the hand-off's own row keeps its request
    database().prepare("UPDATE room_requests SET state='cancelled', finished_at=1 WHERE id=?").run(id);
    pruneTerminalRoomRequests(database(), 1 + 40 * 24 * 60 * 60 * 1000);
    expect(roomRequest(database(), id)).not.toBeNull();
    // a running request with a queued row (the re-dispatch case) is skipped by the boot sweep
    database().prepare("UPDATE room_requests SET state='running', finished_at=NULL, dispatched_at=2 WHERE id=?").run(id);
    expect(reconcileRoomRequestsAtBoot(database(), 9).unknown).toBe(0);
    expect(roomRequest(database(), id)!.state).toBe("running");
  });
});

// ── 3. deletions ────────────────────────────────────────────────────────────────────
describe("3. the owner's recorded deletions settle hand-offs independently of the sender", () => {
  const item = (id: string, from: string, to: string) => ({ id, toBotId: to, message: `m-${id}`, depth: 0, attempts: 0, fromBotId: from });
  it("a delayed import skips entries whose source conversation, sender or target was deleted, and counts them", () => {
    const db = database();
    recordOwnerDeletion(db, "deleted-thread");
    recordOwnerDeletion(db, "bot:gone-sender");
    recordOwnerDeletion(db, "bot:gone-target");
    writeFileSync(legacyFile(), JSON.stringify({
      "deleted-thread": [item("d1", "live", "peer")],
      "live-thread": [item("d2", "gone-sender", "peer"), item("d3", "live", "gone-target"), item("ok", "live", "peer")],
    }));
    expect(importLegacyDelegations(db)).toBe(1);
    expect(legacyImportSkipped()).toBe(3);
    expect(database().prepare("SELECT id FROM pending_delegations").all()).toEqual([{ id: "ok" }]);
  });
  it("a live sender does not hide a deleted source conversation: the drain cancels with a receipt and no chip, and nothing starts", async () => {
    const s = setup("owner");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "from a chat deleted later", depth: 0 }, 2).id!;
    // a deletion that did not remove the row (the row was written after, or imported late): the record alone
    database().prepare("INSERT OR IGNORE INTO owner_deleted_threads(thread_id, deleted_at) VALUES(?,1)").run(s.from.threadId);
    const lines = s.store.messagesFor(s.from.threadId).length;
    let starts = 0;
    drainDelegations(s.b, s.approvalBus, s.from.threadId, () => { starts++; });
    await tick();
    expect(starts).toBe(0);
    expect(findDelegationReceipt(id)).toMatchObject({ status: "cancelled", result: "the conversation was deleted" });
    expect(pendingRows()).toBe(0);
    expect(s.store.messagesFor(s.from.threadId)).toHaveLength(lines);
  });
  it("queueing from a deleted conversation is refused", () => {
    const s = setup("owner");
    database().prepare("INSERT OR IGNORE INTO owner_deleted_threads(thread_id, deleted_at) VALUES(?,1)").run(s.from.threadId);
    expect(queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "late", depth: 0 }, 2)).toEqual({ result: "source_deleted" });
    expect(pendingRows()).toBe(0);
  });
  it("a deletion that lands between the drain's check and the start transaction rolls the start back: no prompt, no started row", async () => {
    const s = setup("owner");
    const id = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "racing", depth: 0 }, 2).id!;
    let error: unknown;
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, _m, _d, _s, _c, taskId) => {
      recordOwnerDeletion(database(), `bot:${s.target.id}`);             // after the drain's last look
      try { writePrompt(s.b, runOf(taskId), s.target.threadId); } catch (caught) { error = caught; }
    });
    await until(() => _drainingCount() === 0);
    expect(error).toMatchObject({ code: DELEGATION_DELETED });
    expect(promptCount(s)).toBe(0);
    expect(startedDelegation(id)).toBeNull();
  });
});

// ── 4. scale and completion ─────────────────────────────────────────────────────────
describe("4. owner hand-offs cost the rooms nothing", () => {
  it("100,000 parked owner hand-offs: the room tables hold no row for them, and the new statements plan without a table scan", () => {
    const db = database();
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key)
      SELECT 'p'||i, 't'||(i%1000), 'peer', 'sender', 'parked', i+1000000, '{}', 'owner', 'dlg-p'||i FROM n`);
    expect(requestRows()).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM room_requests WHERE group_id='owner-handoff'")).toBe(0);
    const plan = (sql: string, ...args: Array<string | number>) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
    for (const [name, sql, args] of [
      ["startedPage", PENDING_SQL.startedPage, []],
      ["byThread", PENDING_SQL.byThread, ["t1"]],
      ["due", PENDING_SQL.due, [1, 1, 1]],
      ["started by id", "SELECT 1 FROM pending_delegations WHERE id=? AND phase='started'", ["p1"]],
      ["owner deletion", PENDING_SQL.forgetThread.replace("DELETE FROM", "SELECT 1 FROM"), ["t1"]],
    ] as Array<[string, string, Array<string | number>]>) {
      const detail = plan(sql, ...args);
      expect(detail, name).not.toMatch(/\bSCAN\b/);
    }
    expect(reconcileStartedDelegations()).toEqual({ held: 0, receipted: 0, interrupted: 0, redispatched: 0, fresh: 0 });
  }, 120_000);
  it("completion leaves no running record behind: after the receipt there is no row and no room request", async () => {
    const s = setup("owner");
    queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "owner chat", depth: 0 }, 2);
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, _m, _d, _s, _c, taskId) => {
      writePrompt(s.b, runOf(taskId), s.target.threadId);
      runOf(taskId).accepted("t1");
      recordDelegationReceipt({ id: taskId, sourceThreadId: s.from.threadId, toBotId: s.target.id, toBotName: "Helper", status: "done", result: released("answer") });
    });
    await until(() => _drainingCount() === 0);
    expect(pendingRows()).toBe(0);
    expect(requestRows()).toBe(0);
    expect(_pendingCount(s.from.threadId)).toBe(0);
  });
  it("a restore with 50 owner hand-offs reports no room-request notices and holds nothing for them", () => {
    setup("owner");
    database().exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50)
      INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key) SELECT 'h'||i, 't', 'peer', 'sender', 'fresh', NULL, '{}', 'owner', 'dlg-h'||i FROM n`);
    expect(pendingRows()).toBe(50);
    const notes = fenceRestoredSql(database(), "gen-1");
    expect(notes.filter((note) => /room request/.test(note.action))).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM restore_holds")).toBe(0);
  });
  it("the one-time cleanup of the development stand-in records keeps a running hand-off from ever running again", () => {
    const s = setup("owner");
    const a = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "queued", depth: 0 }, 99).id!;
    const r = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "running", depth: 0 }, 99).id!;
    for (const [id, state] of [[a, "queued"], [r, "running"]] as const) {
      insertRoomRequest(database(), { id, groupId: "owner-handoff", verb: "ask", fromKind: "bot", admissionKey: `ask:delegation:${id}`, state, now: 1,
        lineage: { rootThreadId: s.from.threadId, origin: "server", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } });
    }
    expect(migrateOwnerHandoffRecords(database())).toBe(2);
    expect(requestRows()).toBe(0);
    expect(database().prepare("SELECT phase FROM pending_delegations WHERE id=?").get(a)).toMatchObject({ phase: "fresh" });
    expect(database().prepare("SELECT phase, accepted_turn_id FROM pending_delegations WHERE id=?").get(r)).toMatchObject({ phase: "started", accepted_turn_id: "migrated" });
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 1 });
    expect(findDelegationReceipt(r)).toMatchObject({ status: "failed" });
    expect(migrateOwnerHandoffRecords(database())).toBe(0);
  });
});

// ── 5. going back to 1.0.1 ──────────────────────────────────────────────────────────
describe("5. the downgrade drops every 1.0.2 application object (frozen list) and the real 1.0.1 inspector accepts the result", () => {
  /** A fully populated 1.0.2 database: queued, busy, parked and started hand-offs, a retained request, a closed request, a stand-in record. */
  async function populated() {
    const s = setup("room");
    const ids = { fresh: "", busy: "", parked: "", started: "", accepted: "" };
    for (const key of Object.keys(ids) as Array<keyof typeof ids>) ids[key] = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: `hand-off ${key}`, depth: 0, reason: key }, 99).id!;
    const db = database();
    db.prepare("UPDATE pending_delegations SET phase='busy', retry_at=? WHERE id=?").run(Date.now() + 1000, ids.busy);
    db.prepare("UPDATE pending_delegations SET phase='parked', retry_at=? WHERE id=?").run(Date.now() + 1000, ids.parked);
    await startLikeIndex(s.b, s.approvalBus, ids.started);
    await startLikeIndex(s.b, s.approvalBus, ids.accepted, { accept: "turn-7" });
    db.prepare("UPDATE room_requests SET refusal='retained_unresolved' WHERE id=?").run(ids.fresh);
    initializeImageOperations(db); initializeImageLibrary(db);
    return { s, ids };
  }
  const run = (to: 6 = 6) => downgradeInstallationMemorySchema(DATA_DIR, to);

  it.skipIf(!haveV101)("the downgraded file is accepted by the real 1.0.1 inspector; any one 1.0.2 object left behind is rejected", async () => {
    await populated();
    closeDatabase(); await stopWalMaintenance(); /* closeDatabase stops the checkpointer without waiting (wal3); a second connection must wait for it */
    const result = run();
    expect(result).toMatchObject({ status: "downgraded", to: 6, handoffs: 4, handoffsStarted: 1 });
    const { inspectInstallationDatabase } = await realV101();
    const file = join(DATA_DIR, "messages.db");
    const open = () => new DatabaseSync(file);
    const accepted = open();
    try { expect(() => inspectInstallationDatabase(accepted)).not.toThrow(); } finally { accepted.close(); }
    // each kind of leftover is rejected: a table, an index, a trigger (and the same object under a 1.0.1 name with another shape)
    for (const sql of [
      "CREATE TABLE owner_deleted_threads (thread_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)",
      "CREATE INDEX pd_started ON messages(at)",
      "CREATE TRIGGER room_request_retry_gone AFTER DELETE ON room_requests BEGIN SELECT 1; END",
      "CREATE INDEX room_requests_runnable ON room_requests(state)",
    ]) {
      const db = open();
      try { db.exec(sql); expect(() => inspectInstallationDatabase(db), sql).toThrow(expect.objectContaining({ code: "DATABASE_SCHEMA_UNSUPPORTED" })); } finally { db.close(); }
      rmSync(`${file}-wal`, { force: true }); rmSync(`${file}-shm`, { force: true });
      // the added object is removed again so the next one is judged alone
      const clean = open();
      try { for (const kind of ["TABLE owner_deleted_threads", "INDEX pd_started", "TRIGGER room_request_retry_gone", "INDEX room_requests_runnable"]) clean.exec(`DROP ${kind.replace(" ", " IF EXISTS ")}`); } finally { clean.close(); }
    }
  }, 120_000);

  it("the frozen manifest equals the 1.0.1 referenceSchema(), and every 1.0.2 object is either a 1.0.1 object, a memory object or in the frozen list", async () => {
    const db = database();
    initializeImageOperations(db); initializeImageLibrary(db);
    const head = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
    const known = new Set(SCHEMA_1_0_1.map((object) => object.name));
    const listed = new Set<string>([...APP_SCHEMA_102_ADDITIONS.triggers, ...APP_SCHEMA_102_ADDITIONS.indexes, ...APP_SCHEMA_102_ADDITIONS.tables]);
    const unlisted = head.filter((row) => row.sql !== null && !row.name.startsWith("memory_") && !row.tbl_name.startsWith("memory_") && !known.has(row.name) && !listed.has(row.name) && !SEQ_103_OBJECTS.includes(row.name) && !MESSAGE_ID_103_OBJECTS.includes(row.name) && !(UPGRADE_104_TABLES as readonly string[]).includes(row.name) && !(UPGRADE_108_TABLES as readonly string[]).includes(row.tbl_name) && !PUSH_RETENTION_103_INDEXES.some(([name]) => name === row.name) && !BOT_CALLS_109_OBJECTS.includes(row.name) && !APP_TRIGGER_OBJECTS.includes(row.name) && !isInboxProjectionObject(row)).map((row) => row.name); // (the Inbox projection is derived data: a restore and the snapshot inspector treat it so)
    expect(unlisted, "a 1.0.2 object that downgradeApplicationSchemaTo101 would leave behind").toEqual([]);
    for (const name of listed) expect(known.has(name), `${name} is in both lists`).toBe(false);
    if (!haveV101) return;
    const { referenceSchema, rawSchema } = await realV101();
    const raw = new Map(rawSchema().map((row) => [row.name, row.sql]));
    const real = [...referenceSchema()].map(([name, o]) => ({ name, type: o.type, table: o.table, sql: [...o.sql], columns: o.columns, ddl: raw.get(name) ?? null }));
    expect(JSON.parse(JSON.stringify(SCHEMA_1_0_1))).toEqual(real);
  });

  it("an injected failure right before the commit changes nothing; the retry writes the same files; a third run is a no-op", async () => {
    const { ids } = await populated();
    closeDatabase(); await stopWalMaintenance(); /* closeDatabase stops the checkpointer without waiting (wal3); a second connection must wait for it */
    const file = join(DATA_DIR, "messages.db");
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const before = (db.prepare("SELECT type,name FROM sqlite_schema ORDER BY name").all() as unknown[]).length;
      expect(() => downgradeApplicationSchemaTo101(db, DATA_DIR, { beforeCommit: () => { throw new Error("injected"); } })).toThrow("injected");
      expect((db.prepare("SELECT type,name FROM sqlite_schema ORDER BY name").all() as unknown[]).length).toBe(before);
      expect(count2(db, "SELECT COUNT(*) AS n FROM pending_delegations")).toBe(5);
      const firstFile = readFileSync(legacyFile(), "utf8"), firstReceipts = readFileSync(receiptsFile(), "utf8");
      const done = downgradeApplicationSchemaTo101(db, DATA_DIR);
      expect(done).toMatchObject({ exported: 4, interrupted: 1 });
      expect(readFileSync(legacyFile(), "utf8")).toBe(firstFile);
      expect(JSON.parse(readFileSync(receiptsFile(), "utf8")).map((r: { id: string; finishedAt: number }) => r.id)).toEqual(JSON.parse(firstReceipts).map((r: { id: string }) => r.id));
      const exported = Object.values(JSON.parse(firstFile) as Record<string, Array<{ id: string }>>).flat().map((entry) => entry.id).sort();
      expect(exported).toEqual([ids.busy, ids.fresh, ids.parked, ids.started].sort());      // the started-not-accepted row is exported as queued; the accepted one is not
      expect(JSON.parse(firstReceipts)).toEqual([expect.objectContaining({ id: ids.accepted, status: "failed", result: "interrupted by the reinstall" })]);
      const again = downgradeApplicationSchemaTo101(db, DATA_DIR);
      expect(again).toMatchObject({ exported: 0, interrupted: 0, dropped: 0 });
      expect(readFileSync(legacyFile(), "utf8")).toBe(firstFile);
      expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name IN ('pending_delegations','owner_sends','restore_holds','pd_started')").get()).toBeUndefined();
      expect(db.prepare("SELECT refusal FROM room_requests WHERE id=?").get(ids.fresh)).toMatchObject({ refusal: null });
    } finally { db.close(); }
  }, 120_000);

  it("a leftover entry with the same id is replaced, one that must not run is removed, and a re-upgrade imports every hand-off exactly once", async () => {
    const { s, ids } = await populated();
    writeFileSync(legacyFile(), JSON.stringify({ [s.from.threadId]: [{ id: ids.fresh, toBotId: "stale", message: "stale copy", depth: 0 }, { id: ids.accepted, toBotId: s.target.id, message: "must not run", depth: 0 }, { id: "only-in-file", toBotId: s.target.id, message: "stays", depth: 0 }] }));
    closeDatabase(); await stopWalMaintenance(); /* closeDatabase stops the checkpointer without waiting (wal3); a second connection must wait for it */
    run();
    const entries = Object.values(JSON.parse(readFileSync(legacyFile(), "utf8")) as Record<string, Array<{ id: string; message: string }>>).flat();
    expect(entries.map((e) => e.id).sort()).toEqual([ids.busy, ids.fresh, ids.parked, ids.started, "only-in-file"].sort());
    expect(entries.find((e) => e.id === ids.fresh)!.message).toBe("hand-off fresh");
    // the next 1.0.2 start: tables are created again and the file is imported once, by id
    const db = database();
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(5);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_delegations_import").get()).toMatchObject({ n: 1 });
    _loadPending();
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(5);
  }, 120_000);

  it("it refuses, touching nothing, while an owner send or a restore hold still keeps the owner's words", async () => {
    await populated();
    const db = database();
    db.prepare("INSERT INTO owner_sends (kind,owner_id,thread_id,queue_id,fingerprint,text,status,created_at,updated_at) VALUES ('bot','b','t','q1','f','keep me','queued',1,1)").run();
    db.prepare("INSERT INTO restore_holds(kind,row_id,generation) VALUES('room_request','r1','g1')").run();
    closeDatabase(); await stopWalMaintenance(); /* closeDatabase stops the checkpointer without waiting (wal3); a second connection must wait for it */
    let thrown: unknown;
    try { run(); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: DOWNGRADE_WORK_PENDING, message: "You have 2 messages still waiting to send or restore. Send or cancel them, then try again." });
    expect(existsSync(legacyFile())).toBe(false);
    expect(existsSync(receiptsFile())).toBe(false);
    const check = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try { expect(check.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='pending_delegations'").get()).toBeDefined(); } finally { check.close(); }
  }, 120_000);
});
const count2 = (db: DatabaseSync, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
