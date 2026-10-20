// Astra r20 findings (P1-1, P1-2) and the two follow-ups, resolved within DESIGN-r20.md:
//  a. a DELETE of a queue row that fails is never reported as done: Stop, drop, discard and a deleted conversation either remove the row
//     (and only then say so) or leave everything as it was;
//  b. the legacy import tells a failed read (retry) from a file that reads but is not a queue (quarantine);
//  c. every handoff has its durable ask:delegation record, owner-conversation ones included, so none starts twice;
//  d. going back to 1.0.1 returns the waiting handoffs to delegations.json in the shape 1.0.1 loads, and a later upgrade imports them once.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { CommsBus } from "./comms-visibility.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import {
  reconcileStartedDelegations, recordDelegationReceipt, onOwedHandoffReply, DELEGATION_STOP_FAILED, _drainingCount, _loadPending, _pendingCount, _resetPending, _simulateRestart, discardDelegations, dropQueuedDelegation, findDelegationReceipt,
  pendingDelegationInfo, queueDelegation, stopWaitingDelegation,
} from "./delegations.ts";
import { drainDelegations, drainDelegationsRaw, runOf, startLikeIndex, writePrompt } from "./testing/handoff-turn.ts";
import { coordinationTraceSchema } from "./coordination-budget.ts";
import { validExecutionAudience } from "./execution-audience.ts";
import { ROUTINE_PERMISSION_MODES } from "./routine-permissions.ts";
import { ownerDeletedThread, recordOwnerDeletion } from "./owner-deletions.ts";
import { importLegacyDelegations, initializePendingDelegations, queuedDelegationsByThread } from "./pending-delegations-schema.ts";
import { downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import { listRoomRequests, reconcileRoomRequestsAtBoot, roomRequestByKey } from "./room-requests.ts";
import { Store } from "./store.ts";
import { status } from "./murage-status.ts";
import { handoffReplyId, replayOwedReply } from "./handoff-reply.ts";
import { released } from "./testing/released.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../scripts/installation-recovery.ts", import.meta.url));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const legacyFile = () => join(DATA_DIR, "delegations.json");
const pendingRows = () => Number((database().prepare("SELECT COUNT(*) AS n FROM pending_delegations").get() as { n: number }).n);
const requestRows = () => Number((database().prepare("SELECT COUNT(*) AS n FROM room_requests").get() as { n: number }).n);

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); });
afterEach(() => { onOwedHandoffReply(undefined); _resetPending(); closeDatabase(); });

const exportForDowngrade = (db: DatabaseSync, dataDir = DATA_DIR) => { const r = downgradeApplicationSchemaTo101(db, dataDir); return { exported: r.exported, started: r.interrupted }; };
function setup(extra: Partial<CommsBus> = {}) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const from = store.createBot(), target = store.createBot();
  store.patchBot(target.id, { name: "Helper" });
  const b = { store, broadcast: () => {}, ...extra } as unknown as CommsBus;
  // the server's writer of the line a receipt owes its source conversation (index.ts onOwedHandoffReply), registered at every start before any
  // settle: a boot receipt that owes a line (a restart's "interrupted") settles only through it
  onOwedHandoffReply((receipt) => replayOwedReply(store, receipt));
  return { store, from, target, b, approvalBus: { store, broadcast: () => {} } as never };
}
const refuseDeletes = () => database().exec("CREATE TRIGGER pd_nodelete BEFORE DELETE ON pending_delegations BEGIN SELECT RAISE(ABORT, 'refused'); END");
const allowDeletes = () => database().exec("DROP TRIGGER pd_nodelete");

// ── a ─────────────────────────────────────────────────────────────────────────────
describe("a. a queue row that cannot be deleted is never reported as stopped, dropped or finished", () => {
  async function parkedOnBusy() {
    const s = setup({ canStartHandoff: () => false } as Partial<CommsBus>);
    const queued = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "wait for me", depth: 0 }, 2);
    expect(queued.result).toBe("ok");
    drainDelegations(s.b, s.approvalBus, s.from.threadId, () => {});
    await until(() => _drainingCount() === 0);
    expect(pendingDelegationInfo(queued.id!)).not.toBeNull();
    return { ...s, id: queued.id! };
  }
  const waitLines = (s: { store: Store; from: { threadId: string } }) => s.store.messagesFor(s.from.threadId).filter((m) => (m as { delegationWait?: unknown }).delegationWait);

  it("Stop on a waiting line: a failed DELETE throws, nothing is cancelled or receipted, the line and the request stay; the retry then stops it", async () => {
    const s = await parkedOnBusy();
    expect(waitLines(s)).toHaveLength(1);
    refuseDeletes();
    expect(() => stopWaitingDelegation(s.b, s.id)).toThrow(DELEGATION_STOP_FAILED);
    expect(pendingRows()).toBe(1);
    expect(findDelegationReceipt(s.id)).toBeNull();
    expect(waitLines(s)).toHaveLength(1);
    allowDeletes();
    expect(stopWaitingDelegation(s.b, s.id)).toBe(true);
    expect(pendingRows()).toBe(0);
    expect(findDelegationReceipt(s.id)).toMatchObject({ status: "cancelled" });
    expect(waitLines(s)).toHaveLength(0);
  });
  it("dropping a queued handoff: a failed DELETE drops nothing and writes no receipt; the next drain settles it against its cancelled request", async () => {
    const s = setup();
    const queued = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "drop me", depth: 0 }, 2);
    refuseDeletes();
    expect(dropQueuedDelegation(s.b, queued.id!, status("receipt_cancelled"))).toBe(false);
    expect(pendingRows()).toBe(1);
    expect(findDelegationReceipt(queued.id!)).toBeNull();
    allowDeletes();
    expect(dropQueuedDelegation(s.b, queued.id!, status("receipt_cancelled"))).toBe(true);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "cancelled" });
    expect(pendingRows()).toBe(0);
  });
  it("discarding the handoffs of an unfinished turn: a failed DELETE leaves them queued and tells no one they were dropped", () => {
    const s = setup();
    const queued = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "unfinished", depth: 0 }, 2);
    const lines = s.store.messagesFor(s.from.threadId).length;
    refuseDeletes();
    discardDelegations(s.b, s.from.threadId);
    expect(pendingRows()).toBe(1);
    expect(findDelegationReceipt(queued.id!)).toBeNull();
    expect(s.store.messagesFor(s.from.threadId)).toHaveLength(lines);
    allowDeletes();
    discardDelegations(s.b, s.from.threadId);
    expect(pendingRows()).toBe(0);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "dropped" });
  });
  it("a handoff whose turn started keeps its row until its receipt: a restart never runs it again, and a failed DELETE of the row is settled by the receipt at the next start", async () => {
    const s = setup();
    const queued = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "ran once", depth: 0 }, 2);
    const started: string[] = [];
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, message, _d, _s, _c, taskId) => {
      started.push(message);
      writePrompt(s.b, runOf(taskId), s.target.threadId);
      runOf(taskId).accepted("turn-1");
    });
    await until(() => _drainingCount() === 0);
    expect(started).toHaveLength(1);
    expect(_pendingCount(s.from.threadId)).toBe(0);                      // started: it is no longer queued work
    expect(pendingRows()).toBe(1);                                        // but its row stays until the receipt
    refuseDeletes();
    expect(recordDelegationReceipt({ id: queued.id!, sourceThreadId: s.from.threadId, toBotId: s.target.id, toBotName: "Helper", status: "done", result: released("ok") })).toBe(true);
    expect(pendingRows()).toBe(1);                                        // the DELETE was refused: the receipt is on record, the row is not gone
    allowDeletes();
    _simulateRestart();
    _loadPending();
    expect(reconcileStartedDelegations()).toMatchObject({ receipted: 1 });
    expect(pendingRows()).toBe(0);
    drainDelegations(s.b, s.approvalBus, s.from.threadId, () => { throw new Error("must not start a second turn"); });
    await tick();
    expect(started).toHaveLength(1);
  });
  it("a deleted conversation's handoffs leave in the transaction that records its deletion; a rolled-back deletion leaves them", () => {
    const s = setup();
    const queued = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "from a deleted chat", depth: 0 }, 2);
    expect(() => transaction((db) => { recordOwnerDeletion(db, s.from.threadId); throw new Error("the deletion rolled back"); })).toThrow("rolled back");
    expect(ownerDeletedThread(database(), s.from.threadId)).toBe(false);
    expect(pendingRows()).toBe(1);
    transaction((db) => { recordOwnerDeletion(db, s.from.threadId); });
    expect(ownerDeletedThread(database(), s.from.threadId)).toBe(true);
    expect(pendingRows()).toBe(0);                                          // never a committed deletion with a runnable row
    expect(queued.id).toBeTruthy();
  });
  it("deleting a whole bot or channel record touches no queue row of another conversation", () => {
    const s = setup();
    queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "stays", depth: 0 }, 2);
    transaction((db) => { recordOwnerDeletion(db, `bot:${s.target.id}`); recordOwnerDeletion(db, "group:other"); recordOwnerDeletion(db, "some-other-thread"); });
    expect(pendingRows()).toBe(1);
  });
});

// ── b ─────────────────────────────────────────────────────────────────────────────
describe("b. the import keeps a file it could not read and quarantines one that reads but is not a queue", () => {
  const item = (id: string) => ({ id, toBotId: "peer", message: `m-${id}`, depth: 0, attempts: 0, fromBotId: "sender" });
  it("one injected read failure keeps the file and leaves the marker unset; the next clean read imports every item", () => {
    writeFileSync(legacyFile(), JSON.stringify({ a: [item("1"), item("2")], b: [item("3")] }));
    const db = database();
    expect(importLegacyDelegations(db, { readFile: () => { throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); } })).toBe(0);
    expect(existsSync(legacyFile())).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_delegations_import").get()).toMatchObject({ n: 0 });
    expect(pendingRows()).toBe(0);
    expect(existsSync(join(DATA_DIR, "recovery-quarantine"))).toBe(false);
    expect(importLegacyDelegations(db)).toBe(3);
    expect(pendingRows()).toBe(3);
    expect(existsSync(legacyFile())).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_delegations_import").get()).toMatchObject({ n: 1 });
  });
  it("a boot with a failed read, then a later _loadPending, imports everything once", () => {
    writeFileSync(legacyFile(), JSON.stringify({ a: [item("1")] }));
    expect(importLegacyDelegations(database(), { readFile: () => { throw new Error("EACCES"); } })).toBe(0);
    _loadPending();
    expect(pendingRows()).toBe(1);
    _loadPending();
    expect(pendingRows()).toBe(1);
  });
  it("a file that reads but is corrupt JSON is quarantined and the marker is set", () => {
    writeFileSync(legacyFile(), "{ not json");
    const db = database();
    expect(importLegacyDelegations(db)).toBe(0);
    expect(existsSync(legacyFile())).toBe(false);
    expect(readdirSync(join(DATA_DIR, "recovery-quarantine")).some((name) => name.startsWith("delegations.unreadable-"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_delegations_import").get()).toMatchObject({ n: 1 });
  });
});

// ── c ─────────────────────────────────────────────────────────────────────────────
describe("c. the queue row owns its handoff: none starts twice, and an owner-conversation handoff has no stand-in record", () => {
  it("an owner-conversation handoff has no room request at all: a failed insert leaves nothing, an accepted one is its row alone", () => {
    const s = setup();
    refuseInserts();
    expect(() => queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "refused", depth: 0 }, 2)).toThrow("DELEGATION_PERSISTENCE_FAILED");
    expect(requestRows()).toBe(0);
    database().exec("DROP TRIGGER pd_refuse");
    const queued = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "accepted", depth: 0 }, 2);
    expect(roomRequestByKey(database(), `ask:delegation:${queued.id}`)).toBeNull();
    expect(requestRows()).toBe(0);
    expect(database().prepare("SELECT origin, turn_key FROM pending_delegations WHERE id=?").get(queued.id!)).toMatchObject({ origin: "owner", turn_key: `dlg-${queued.id}` });
    function refuseInserts() { database().exec("CREATE TRIGGER pd_refuse BEFORE INSERT ON pending_delegations BEGIN SELECT RAISE(ABORT, 'refused'); END"); }
  });
  it("nothing in any room lists it, and cancelling it wakes no one", () => {
    const s = setup();
    const queued = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "owner chat", depth: 0 }, 2);
    for (const groupId of ["room-1", s.from.threadId, "g", "owner-handoff"]) expect(listRoomRequests(database(), { groupId })).toEqual([]);
    expect(dropQueuedDelegation(s.b, queued.id!, status("receipt_cancelled"))).toBe(true);
    expect(Number((database().prepare("SELECT COUNT(*) AS n FROM room_requests").get() as { n: number }).n)).toBe(0);
  });
  it("owner-conversation handoff, crash after the provider took the turn but before the row left, restart: one target turn and one 'interrupted' receipt", async () => {
    const s = setup();
    const queued = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "do it exactly once", depth: 0 }, 2);
    const started: string[] = [];
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, message, _d, _s, _c, taskId) => {
      started.push(message);
      writePrompt(s.b, runOf(taskId), s.target.threadId);
      runOf(taskId).accepted("turn-1");
      return new Promise<void>(() => { /* never returns: the kill */ });
    });
    await until(() => started.length === 1);
    _simulateRestart();
    expect(reconcileStartedDelegations()).toMatchObject({ interrupted: 1 });
    const again: string[] = [];
    drainDelegations(s.b, s.approvalBus, s.from.threadId, (_to, message) => { again.push(message); });
    await tick();
    expect(again).toEqual([]);
    expect(started).toHaveLength(1);
    expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "failed", result: "interrupted by a restart" });
    expect(pendingRows()).toBe(0);
    expect(requestRows()).toBe(0);
  });
  it("owner-conversation handoff, crash after the provider took the turn, restart: the owner reads 'interrupted by a restart' where the reply would have been", async () => {
    const s = setup();
    const queued = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "do it exactly once", depth: 0 }, 2);
    const started: string[] = [];
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, message, _d, _s, _c, taskId) => {
      started.push(message);
      writePrompt(s.b, runOf(taskId), s.target.threadId);
      runOf(taskId).accepted("turn-1");
      return new Promise<void>(() => { /* never returns: the kill */ });
    });
    await until(() => started.length === 1);
    _simulateRestart();
    expect(reconcileStartedDelegations({ botName: (botId) => s.store.bot(botId)?.name })).toMatchObject({ interrupted: 1 });
    // the receipt owes the line until it is written; the settle wrote it under the hand-off's stable id, so the lead is not left blank
    const line = s.store.messageById(s.from.threadId, handoffReplyId(queued.id!)) as { tool?: { name?: string; ok?: boolean } } | undefined;
    expect(line?.tool).toEqual({ name: "Delegation to @Helper failed: interrupted by a restart", ok: false });
    expect(pendingRows()).toBe(0);
    expect(requestRows()).toBe(0);
  });
  it("a handoff imported from a 1.0.1 file: a crash after its start never starts a second turn", async () => {
    const s = setup();
    writeFileSync(legacyFile(), JSON.stringify({ [s.from.threadId]: [{ id: "imported-1", toBotId: s.target.id, message: "from the old build", depth: 0, attempts: 0, fromBotId: s.from.id }] }));
    _loadPending();
    expect(database().prepare("SELECT origin FROM pending_delegations WHERE id='imported-1'").get()).toMatchObject({ origin: "legacy" });
    const started: string[] = [];
    drainDelegationsRaw(s.b, s.approvalBus, s.from.threadId, (_to, message, _d, _s, _c, taskId) => {
      started.push(message);
      writePrompt(s.b, runOf(taskId), s.target.threadId);
      runOf(taskId).accepted("turn-1");
      return new Promise<void>(() => {});
    });
    await until(() => started.length === 1);
    _simulateRestart();
    reconcileStartedDelegations();
    reconcileRoomRequestsAtBoot(database(), 3);
    drainDelegations(s.b, s.approvalBus, s.from.threadId, () => { throw new Error("must not start a second turn"); });
    await tick();
    expect(findDelegationReceipt("imported-1")).toMatchObject({ status: "failed" });
    expect(pendingRows()).toBe(0);
  });
  it("owner-visible behaviour is unchanged: the chip names the teammate, nothing else is written", () => {
    const s = setup();
    queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "visible", depth: 0 }, 2);
    const chips = s.store.messagesFor(s.from.threadId).map((m) => (m as { tool?: { name?: string } }).tool?.name).filter(Boolean);
    // LINEAGE-DESIGN-S6 rule 6: the queue transaction also writes the sender's "Messaged @target" row, the source the room copy names
    expect(chips).toEqual(["Messaged @Helper", "Delegated to @Helper"]);
  });
});

// ── d ─────────────────────────────────────────────────────────────────────────────
const validEventId101 = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
/** The loader of the 1.0.1 tag (d950cbf67 server/delegations.ts _loadPending), transcribed: what 1.0.1 would run from delegations.json. */
function loadAs101(file: string): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = {};
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const [threadId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const items = list.flatMap((value): Array<Record<string, unknown>> => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, any>;
      if (typeof item.toBotId !== "string" || typeof item.message !== "string" || !Number.isFinite(item.depth)) return [];
      if (Object.hasOwn(item, "eventId") && !validEventId101(item.eventId)) return [];
      if (Object.hasOwn(item, "executionAudience") && !validExecutionAudience(item.executionAudience)) return [];
      if (item.routineAuthority !== undefined && (!item.routineAuthority || !ROUTINE_PERMISSION_MODES.includes(item.routineAuthority.permissionMode) || !["manual", "schedule"].includes(item.routineAuthority.triggerSource))) return [];
      if (item.coordination !== undefined && !coordinationTraceSchema.safeParse(item.coordination).success) return [];
      const loaded: Record<string, unknown> = {
        id: typeof item.id === "string" && item.id ? item.id : "generated", toBotId: item.toBotId, message: item.message,
        ...(typeof item.reason === "string" ? { reason: item.reason } : {}), depth: Math.max(0, Math.trunc(item.depth)),
        attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.trunc(item.attempts)) : 0,
        ...(typeof item.fromBotId === "string" && item.fromBotId ? { fromBotId: item.fromBotId } : {}),
        ...(item.eventId !== undefined ? { eventId: item.eventId } : {}),
        ...(item.executionAudience ? { executionAudience: item.executionAudience } : {}),
      };
      if (item.waitingOnBusy === true) { loaded.waitingOnBusy = true; loaded.waitingSince = Number.isFinite(item.waitingSince) ? item.waitingSince : Date.now(); }
      return [loaded];
    });
    if (items.length) out[threadId] = items;
  }
  return out;
}
const snapshotRows = (db: DatabaseSync) => db.prepare("SELECT id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item FROM pending_delegations ORDER BY id").all();

describe("d. going back to 1.0.1 keeps the waiting handoffs", () => {
  const now = Date.now();
  const queue = () => ({
    "thread-a": [
      { id: "h1", toBotId: "peer", message: "fresh one", reason: "because", depth: 1, attempts: 0, fromBotId: "sender", eventId: "evt-1.a", executionAudience: { v: 1, human: "owner", kind: "home", rootRequestId: "root-1" },
        notOwnerAudience: true, unattended: true, approvalAlreadyGranted: true },
      { id: "h2", toBotId: "peer", message: "busy one", depth: 0, attempts: 1, fromBotId: "sender", waitingOnBusy: true, waitingSince: now - 60_000, waitMessageId: "line-9" },
    ],
    "thread-b": [{ id: "h3", toBotId: "ghost", message: "parked one", depth: 0, attempts: 0, fromBotId: "sender", unknownTarget: true, unknownAttempts: 2, unknownRetryAt: now + 120_000 }],
  });
  const importQueue = () => { writeFileSync(legacyFile(), JSON.stringify(queue(), null, 2)); _loadPending(); expect(pendingRows()).toBe(3); };

  it("1.0.2 rows -> export -> a file 1.0.1's validator accepts -> re-import gives the same rows, no duplicates", () => {
    importQueue();
    const db = database();
    const before = snapshotRows(db);
    expect(existsSync(legacyFile())).toBe(false);
    expect(exportForDowngrade(db, DATA_DIR)).toEqual({ exported: 3, started: 0 });
    // what 1.0.1 would load: all three, with their ids, payloads and the busy mark
    const loaded = loadAs101(legacyFile());
    expect(Object.values(loaded).flat().map((i) => i.id).sort()).toEqual(["h1", "h2", "h3"]);
    expect(loaded["thread-a"]!.map((i) => i.id)).toEqual(["h1", "h2"]);        // queue order within a conversation
    expect(loaded["thread-a"]![1]).toMatchObject({ waitingOnBusy: true, waitingSince: now - 60_000 });
    expect(loaded["thread-a"]![0]).toMatchObject({ eventId: "evt-1.a", reason: "because", depth: 1 });
    // the table 1.0.1 does not know, and the import marker, are gone
    for (const name of ["pending_delegations", "pending_delegations_import"]) expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name=?").get(name)).toBeUndefined();
    // a second run changes nothing and does not clobber the file
    const text = readFileSync(legacyFile(), "utf8");
    expect(exportForDowngrade(db, DATA_DIR)).toEqual({ exported: 0, started: 0 });
    expect(readFileSync(legacyFile(), "utf8")).toBe(text);
    // the next 1.0.2 start: the table is created again, the marker is unset, and the file is imported once
    initializePendingDelegations(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pending_delegations_import").get()).toMatchObject({ n: 0 });
    expect(importLegacyDelegations(db)).toBe(3);
    expect(snapshotRows(db)).toEqual(before);
    expect(importLegacyDelegations(db)).toBe(0);
    expect(existsSync(legacyFile())).toBe(false);
    expect(snapshotRows(db)).toEqual(before);
  });
  it("a file 1.0.1 left or ran from is merged by id: nothing doubles, and what was only in the file stays", () => {
    importQueue();
    const db = database();
    writeFileSync(legacyFile(), JSON.stringify({ "thread-a": [{ id: "h1", toBotId: "peer", message: "already there", depth: 0 }, { id: "old", toBotId: "peer", message: "only in the file", depth: 0 }] }));
    // the table was imported before; the file reappeared (an older build wrote it)
    expect(exportForDowngrade(db, DATA_DIR)).toEqual({ exported: 3, started: 0 });       // every row in the table; the leftover with the same id is replaced
    const entries = Object.values(loadAs101(legacyFile())).flat();
    expect(entries.map((i) => i.id).sort()).toEqual(["h1", "h2", "h3", "old"]);
    expect(entries.find((i) => i.id === "h1")).toMatchObject({ message: "fresh one" });
  });
  it("a handoff whose turn the provider took is not handed to 1.0.1 (it would start again); it gets an 'interrupted by the reinstall' receipt", () => {
    const s = setup();
    const a = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "queued", depth: 0 }, 2);
    const b2 = queueDelegation(s.b, s.from, { toBotId: s.target.id, message: "started", depth: 0 }, 2);
    startLikeIndex(s.b, s.approvalBus, b2.id!, { accept: "turn-9" });
    expect(exportForDowngrade(database(), DATA_DIR)).toEqual({ exported: 1, started: 1 });
    expect(Object.values(loadAs101(legacyFile())).flat().map((i) => i.id)).toEqual([a.id]);
    const receipts = JSON.parse(readFileSync(join(DATA_DIR, "delegation-receipts.json"), "utf8")) as Array<{ id: string; status: string; result: string }>;
    expect(receipts.find((r) => r.id === b2.id)).toMatchObject({ status: "failed", result: "interrupted by the reinstall" });
  });
  it("a leftover file that is not a queue is kept in recovery-quarantine, never merged or dropped", () => {
    importQueue();
    writeFileSync(legacyFile(), "{ not json");
    expect(exportForDowngrade(database(), DATA_DIR)).toEqual({ exported: 3, started: 0 });
    expect(readdirSync(join(DATA_DIR, "recovery-quarantine")).some((name) => name.startsWith("delegations.unreadable-"))).toBe(true);
    expect(Object.values(loadAs101(legacyFile())).flat()).toHaveLength(3);
  });
  it("the real command: memory-downgrade --to 6 writes delegations.json and removes the 1.0.2-only tables; a later start imports it", async () => {
    importQueue();
    const root = mkdtempSync(join(tmpdir(), "murage-handoff-downgrade-"));
    try {
      const live = database();
      live.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const copy = join(root, "data"); mkdirSync(copy);
      const db = new DatabaseSync(join(copy, "messages.db"));
      db.exec("PRAGMA journal_mode=WAL");
      initializePendingDelegations(db);
      // the same three handoffs, as rows
      for (const row of live.prepare("SELECT * FROM pending_delegations ORDER BY rowid").all() as Array<Record<string, any>>) {
        db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item) VALUES(?,?,?,?,?,?,?)").run(row.id, row.source_thread_id, row.to_bot_id, row.from_bot_id, row.phase, row.retry_at, row.item);
      }
      db.close();
      const { migrateMemorySchema } = await import("./memory/schema.ts");
      const prep = new DatabaseSync(join(copy, "messages.db"));
      prep.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));");
      migrateMemorySchema(prep, "active");
      prep.close();
      const result = JSON.parse((await exec(process.execPath, [cli, "memory-downgrade", "--data-dir", copy, "--to", "6"], { timeout: 60_000 })).stdout);
      expect(result).toMatchObject({ ok: true, operation: "memory-downgrade", status: "downgraded", to: 6, handoffs: 3 });
      expect(Object.values(loadAs101(join(copy, "delegations.json"))).flat().map((i) => i.id).sort()).toEqual(["h1", "h2", "h3"]);
      const after = new DatabaseSync(join(copy, "messages.db"));
      try {
        expect(after.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name LIKE 'pending_delegations%'").get()).toBeUndefined();
        initializePendingDelegations(after);
        expect(importLegacyDelegations(after, { dataDir: copy })).toBe(3);
        expect(Object.keys(queuedDelegationsByThread(after)).sort()).toEqual(["thread-a", "thread-b"]);
      } finally { after.close(); }
    } finally { removeTempDirSync(root); }
  }, 120_000);
});
