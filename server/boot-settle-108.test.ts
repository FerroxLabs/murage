// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOOT-SETTLE-108 (docs/designs/BOOT-SETTLE-HELD-SENDS-108.md section 6, server/boot-settle-108.test.ts rows): the boot settling in bounded units.
//  - SQL-only cleanup: expired owner holds and orphan controls batch up to 100 per commit, FULL throughout, rollback hides the patches
//  - mixed held rows: key order kept, no receipt listener or owed-line writer runs inside a batch, one receipt-bearing row per unit
//  - every unit yields, the last one too; the owed pass reads each receipt as it is now
//  - the gate, the automatic retry (busy exhaustion, 1 s to 60 s), one content-free warning per retry, one success continuation
//  - row deferral, Stop/Dismiss/Send again between units, and a drain while the gate is closed
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import {
  BOOT_SETTLE_RETRY_FIRST_MS, BOOT_SETTLE_RETRY_MAX_MS, SETTLE_PAGE, _drainingCount, _resetPending, appendHeldLine, dismissHeldDelegation, drainDelegations,
  findDelegationReceipt, heldLineId, isBootSettleOperationalError, joinBootSettle, onDelegationReceipt, onOwedHandoffReply, queueDelegation, reconcileStartedDelegations,
  recordDelegationReceipt, registerHeldLine, releaseOwedReply, resendHeldDelegation, settleStartedDelegations, type HeldDelegation,
} from "./delegations.ts";
import { ClassificationViolation } from "./message-db.ts";
import { OLD_OWNER_HANDOFF_GROUP, _resetOwnerMigration, delegationAdmissionHeld, runOwnerHandoffMigration } from "./pending-delegations-schema.ts";
import { completeRequest, insertRoomRequest, isTerminalRoomRequestState, roomRequest } from "./room-requests.ts";
import { Store } from "./store.ts";
import { afterCommit } from "./tx-scope.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { released } from "./testing/released.ts";
import { dispatchHandoffRequest } from "./testing/handoff-turn.ts";
import { LINEAGE, ownerWorld, type OwnerWorld } from "./testing/handoff-worlds.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const rowOf = (id: string) => database().prepare("SELECT phase, origin, started_at, submitted_at FROM pending_delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;
const pad = (i: number) => String(i).padStart(4, "0");

const listened: string[] = [];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); listened.splice(0); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); onDelegationReceipt(undefined); onOwedHandoffReply(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

/** As the server's receipt listener (index.ts onDelegationReceipt): a held reply completes nothing; any other receipt ends a live request with its outcome. */
function listen(refuse: (id: string) => boolean = () => false): void {
  onDelegationReceipt((receipt) => {
    listened.push(receipt.id);
    if (refuse(receipt.id)) throw new Error("the completion failed");
    if (receipt.held) return;
    const row = roomRequest(database(), receipt.id);
    if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: receipt.status === "done" ? "done" : receipt.status === "cancelled" ? "cancelled" : "failed", now: Date.now() });
  });
}
/** An expired owner hold (submitted long ago, no request, no receipt): the SQL-only expiry. With `line`, its control is a real held line. */
function expiredHold(w: OwnerWorld, id: string, options: { line?: boolean; registerOnly?: boolean } = { line: true }): void {
  database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, submitted_at, started_at) VALUES(?,?,?,?,'started',NULL,?, 'owner', ?, 1, NULL)")
    .run(id, w.from.threadId, w.target.id, w.from.id, JSON.stringify({ message: "m", depth: 0, attempts: 0 }), `dlg-${id}`);
  const held: HeldDelegation = { id, sourceThreadId: w.from.threadId, toBotId: w.target.id, fromBotId: w.from.id, toBotName: "Helper", text: "held" };
  if (options.line) appendHeldLine(w.store, held);
  else if (options.registerOnly) registerHeldLine(held);
}
/** A store that counts the write-bearing outer commits of held-line releases (one marker per outer transaction) and the patches between two event-loop turns. */
function countingStore(real: Pick<Store, "patchMessage">, fault?: (patch: number, id: string) => void) {
  const seen = { commits: 0, patches: 0, ids: [] as string[] };
  let marked = false;
  const store = {
    patchMessage: (thread: string, id: string, patch: Parameters<Store["patchMessage"]>[2], within?: () => void) => real.patchMessage(thread, id, patch, () => {
      seen.patches++;
      fault?.(seen.patches, id);
      if (!marked) { marked = true; afterCommit(() => { seen.commits++; marked = false; }); }
      seen.ids.push(id);
      within?.();
    }),
  };
  return { seen, store: store as unknown as Pick<Store, "patchMessage">, reset: () => { marked = false; } };
}
const controlOf = (store: Pick<Store, "messageById">, thread: string, id: string): unknown => store.messageById(thread, heldLineId(id))?.delegationHeld;
const storedControl = (thread: string, id: string): unknown => {
  const row = database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(thread, heldLineId(id)) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as { delegationHeld?: unknown }).delegationHeld : "no line";
};
/** A held room hand-off whose request is still live, as a restart leaves one that was handed to the provider (submitted, no evidence): its ask request
 * running (or waiting on the owner), the row held, and its line with the control. */
function heldRoom(w: OwnerWorld, id: string, options: { submittedAt?: number; state?: "running" | "waiting_owner"; line?: boolean } = {}): string {
  insertRoomRequest(database(), { id, groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.from.id, toBotId: w.target.id, parentId: "root", returnThreadId: w.from.threadId, returnBotId: w.from.id, admissionKey: `ask:delegation:${id}`, now: 2 });
  dispatchHandoffRequest(database(), id, { now: 2 });
  if (options.state === "waiting_owner") database().prepare("UPDATE room_requests SET state='waiting_owner', waiting_since=3 WHERE id=?").run(id);
  database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, submitted_at, started_at) VALUES(?,?,?,?,'started',NULL,?,'room',?,?,NULL)")
    .run(id, w.from.threadId, w.target.id, w.from.id, JSON.stringify({ message: "room work", depth: 0, attempts: 0 }), `dlg-${id}`, options.submittedAt ?? Date.now());
  if (options.line !== false) appendHeldLine(w.store, { id, sourceThreadId: w.from.threadId, toBotId: w.target.id, fromBotId: w.from.id, toBotName: "Helper", text: "held" });
  expect(isTerminalRoomRequestState(roomRequest(database(), id)!.state)).toBe(false);
  return id;
}

// ── SQL-only cleanup ─────────────────────────────────────────────────────────────────
describe("SQL-only cleanup: expired owner holds batch up to 100 per commit", () => {
  it.each([0, 1, 99, 100, 101, 205])("%i eligible rows: ceil(n/100) commits, FULL, row, control and registration together", async (n) => {
    const w = ownerWorld("owner");
    for (let i = 0; i < n; i++) expiredHold(w, `e${pad(i)}`);
    const counted = countingStore(w.store);
    expect(database().prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
    await settleStartedDelegations({ store: counted.store });
    expect(counted.seen.commits).toBe(Math.ceil(n / SETTLE_PAGE));
    expect(counted.seen.patches).toBe(n);
    expect(counted.seen.ids).toEqual(Array.from({ length: n }, (_, i) => heldLineId(`e${pad(i)}`)));      // key order
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
    for (let i = 0; i < n; i++) expect(storedControl(w.from.threadId, `e${pad(i)}`)).toBeUndefined();
    expect(database().prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
  });
  it("an empty boot writes no receipt file", async () => {
    ownerWorld("owner");
    await settleStartedDelegations({});
    expect(existsSync(join(DATA_DIR, "delegation-receipts.json"))).toBe(false);
  });
  it("an unloaded thread and a missing message: the row and the registration still go, and no conversation is made", async () => {
    const w = ownerWorld("owner");
    for (let i = 0; i < 3; i++) expiredHold(w, `u${i}`);
    expiredHold(w, "missing", { registerOnly: true });                                          // registered, but its line is not there
    const cold = new Store(() => ({ instanceId: "fixture", model: "fixture" }));               // the thread is not loaded in this store
    await settleStartedDelegations({ store: cold });
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
    for (let i = 0; i < 3; i++) expect(storedControl(w.from.threadId, `u${i}`)).toBeUndefined();
    expect(storedControl(w.from.threadId, "missing")).toBe("no line");
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id=?", heldLineId("missing"))).toBe(0);
  });
  it("a batch that fails rolls back as one: the rows, the registrations and the controls are as they were, and the cache shows the stored line", () => {
    const w = ownerWorld("owner");
    for (let i = 0; i < 100; i++) expiredHold(w, `r${pad(i)}`);
    const counted = countingStore(w.store, (patch) => { if (patch === 50) throw Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 }); });
    expect(() => reconcileStartedDelegations({ store: counted.store })).toThrow("disk I/O error");
    expect(counted.seen.commits).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(100);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(100);
    for (const i of [0, 48, 99]) {
      expect(storedControl(w.from.threadId, `r${pad(i)}`)).toEqual({ id: `r${pad(i)}` });
      expect(controlOf(w.store, w.from.threadId, `r${pad(i)}`)).toEqual({ id: `r${pad(i)}` });   // the patched cache was dropped and reloaded
    }
  });
  it("orphan controls clear a page per commit, and a control a held row still backs is left alone", async () => {
    const w = ownerWorld("owner");
    for (let i = 0; i < 150; i++) registerHeldLine({ id: `o${pad(i)}`, sourceThreadId: w.from.threadId });
    database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, submitted_at, started_at) VALUES('o0007',?,?,?,'started',NULL,'{\"message\":\"m\",\"depth\":0,\"attempts\":0}','owner','dlg-o0007',?,NULL)")
      .run(w.from.threadId, w.target.id, w.from.id, Date.now());
    const counted = countingStore(w.store);
    await settleStartedDelegations({ store: counted.store, botName: () => "Helper" });
    expect(counted.seen.commits).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines WHERE delegation_id='o0007'")).toBe(1);
  });
});

// ── mixed held rows ──────────────────────────────────────────────────────────────────
describe("mixed held rows: the batch takes only plain expiries, in key order; receipt-bearing rows are one per unit", () => {
  it("expiries, a live room partner, an owed receipt and an orphan: order kept, nothing receipt-bearing inside a batch, live work kept", async () => {
    const w = ownerWorld("room");
    listen((id) => id === "keep-live");
    const events: Array<{ tick: number; what: string; id: string }> = [];
    let tickNo = 0;
    onOwedHandoffReply((receipt) => { events.push({ tick: tickNo, what: "writer", id: receipt.id }); return { id: `line-${receipt.id}` }; });
    for (const id of ["a1", "a3", "a5", "a6", "a7"]) expiredHold(w, id);
    // a2: a room hand-off, long expired, whose request is still live: settled first (individually), then let go
    heldRoom(w, "a2", { submittedAt: 1 });
    // a4: an owner hold whose receipt still owes its line: never batched, the line is written before the row goes
    expiredHold(w, "a4");
    onOwedHandoffReply(undefined);
    recordDelegationReceipt({ id: "a4", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("the answer"), reply: { text: "the answer" } });
    onOwedHandoffReply((receipt) => { events.push({ tick: tickNo, what: "writer", id: receipt.id }); return { id: `line-${receipt.id}` }; });
    // keep-live: a room hold whose request stays live (its completion fails): the row and the request stay
    heldRoom(w, "keep-live", { submittedAt: 1, line: false });
    registerHeldLine({ id: "zz-orphan", sourceThreadId: w.from.threadId });
    const counted = countingStore(w.store, (_patch, id) => { events.push({ tick: tickNo, what: "patch", id }); });
    onDelegationReceipt((receipt) => {
      events.push({ tick: tickNo, what: "listener", id: receipt.id });
      if (receipt.id === "keep-live") throw new Error("the completion failed");
      const row = roomRequest(database(), receipt.id);
      if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: "failed", now: Date.now() });
    });
    let over = false;
    const ticker = (async () => { while (!over) { await tick(); tickNo++; } })();
    await settleStartedDelegations({ store: counted.store, botName: () => "Helper" });
    over = true; await ticker;
    const batched = new Set(["a1", "a3", "a5", "a6", "a7"].map(heldLineId));
    const batchTicks = new Set(events.filter((e) => e.what === "patch" && batched.has(e.id)).map((e) => e.tick));
    for (const e of events.filter((x) => x.what !== "patch")) expect(batchTicks.has(e.tick), `${e.what} ${e.id} ran in a batch's turn`).toBe(false);
    // one receipt-bearing row per turn of the event loop
    const perTick = new Map<number, number>();
    for (const e of events.filter((x) => x.what === "listener")) perTick.set(e.tick, (perTick.get(e.tick) ?? 0) + 1);
    expect(Math.max(0, ...perTick.values())).toBeLessThanOrEqual(1);
    // key order of the releases
    const patchedIds = events.filter((e) => e.what === "patch").map((e) => e.id);
    expect(patchedIds).toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "zz-orphan"].map(heldLineId));
    expect(roomRequest(database(), "a2")!.state).toBe("failed");                                 // its request ended from the receipt before the expiry
    expect(events.some((e) => e.what === "writer" && e.id === "a4")).toBe(true);                 // its line before its row
    expect(rowOf("keep-live")).toMatchObject({ phase: "started", started_at: null });             // a live partner is never removed
    expect(isTerminalRoomRequestState(roomRequest(database(), "keep-live")!.state)).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines WHERE delegation_id='zz-orphan'")).toBe(0);
  });
});

// ── every unit yields; the owed pass reads the receipt as it is now ──────────────────────
describe("every unit yields, the last one too", () => {
  it("started rows, holds, shared ranges, orphans and more than 100 owed replies: at most 100 rows and one receipt-bearing write between two turns", async () => {
    const w = ownerWorld("room");
    // three started rows never handed over: each is reset to fresh, one per unit
    for (let i = 0; i < 3; i++) database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, started_at) VALUES(?,?,?,?,'started',NULL,?,'owner',?,?)")
      .run(`s${i}`, w.from.threadId, w.target.id, w.from.id, JSON.stringify({ message: "m", depth: 0, attempts: 0 }), `dlg-s${i}`, 1 + i);
    for (let i = 0; i < 130; i++) expiredHold(w, `e${pad(i)}`);
    // sparse request rows: the shared ranges walk the rowids
    for (let i = 0; i < 250; i++) insertRoomRequest(database(), { id: `rr${i}`, groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.from.id, toBotId: w.target.id, parentId: "root", admissionKey: `rr-${i}`, now: 5 });
    database().prepare("DELETE FROM room_requests WHERE id LIKE 'rr%' AND (rowid % 3)=0").run();
    for (let i = 0; i < 120; i++) registerHeldLine({ id: `o${pad(i)}`, sourceThreadId: w.from.threadId });
    // 150 receipts that still owe their line and have no row: written while nobody could write the line
    onOwedHandoffReply(undefined);
    for (let i = 0; i < 150; i++) recordDelegationReceipt({ id: `owed${pad(i)}`, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("r"), reply: { text: `r${i}` } });
    let tickNo = 0, writes = 0, lastWriteTick = -1, worstWrites = 0, inTickWrites = 0, worstPatches = 0, inTickPatches = 0;
    onOwedHandoffReply((receipt) => { writes++; inTickWrites++; lastWriteTick = tickNo; return { id: `line-${receipt.id}` }; });
    const counted = countingStore(w.store, () => { inTickPatches++; });
    let over = false;
    const ticker = (async () => { while (!over) { await tick(); worstWrites = Math.max(worstWrites, inTickWrites); worstPatches = Math.max(worstPatches, inTickPatches); inTickWrites = 0; inTickPatches = 0; tickNo++; } })();
    let resolvedTick = -1;
    await settleStartedDelegations({ store: counted.store, botName: () => "Helper" }).then(() => { resolvedTick = tickNo; });
    over = true; await ticker;
    expect(writes).toBe(150);
    expect(worstWrites).toBeLessThanOrEqual(1);
    expect(worstPatches).toBeLessThanOrEqual(SETTLE_PAGE);
    expect(resolvedTick).toBeGreaterThan(lastWriteTick);                                          // the last unit yields before the settling is done
    expect(tickNo).toBeGreaterThanOrEqual(150);                                                  // a turn of the event loop per unit, owed replies included
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase='fresh'")).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
  });
  it("the owed pass looks each receipt up again: an acknowledged one is skipped, a replaced one delivers its current words once", async () => {
    const w = ownerWorld("owner");
    onOwedHandoffReply(undefined);
    for (const id of ["c", "b", "a"]) recordDelegationReceipt({ id, sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("r"), reply: { text: `old ${id}` } });
    const delivered: string[] = [];
    let live = false;
    onOwedHandoffReply((receipt) => {
      const words = (receipt.reply as { text?: string }).text ?? "";
      if (live && receipt.id === "c") throw new Error("the line could not be written right now");
      delivered.push(`${receipt.id}:${words}`);
      if (receipt.id === "a") setImmediate(() => {
        releaseOwedReply("b");                                                                     // b's line reached its conversation another way
        live = true;
        // c is replaced while the pass runs; its live settle fails, so the pass meets the replacement
        recordDelegationReceipt({ id: "c", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("r2"), reply: { text: "new c" } });
        live = false;
      });
      return { id: `line-${receipt.id}` };
    });
    await settleStartedDelegations({ botName: () => "Helper" });
    expect(delivered).toEqual(["a:old a", "c:new c"]);
    expect(findDelegationReceipt("b")?.reply).toBeUndefined();
  });
});

// ── gate, retries, event tickets ─────────────────────────────────────────────────────
describe("the gate, the automatic retry and the one success continuation", () => {
  it("a pending migration is not a settling: nothing starts and no continuation runs; once it opens, one job, and later calls join it", async () => {
    const w = ownerWorld("owner");
    const standIn = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "owner hand-off", depth: 0 }, 9).id!;
    insertRoomRequest(database(), { id: standIn, groupId: OLD_OWNER_HANDOFF_GROUP, verb: "ask", fromKind: "bot", admissionKey: `ask:delegation:${standIn}`, state: "queued", now: 1, lineage: LINEAGE(w.from.threadId) });
    database().exec("CREATE TRIGGER rr_nodelete BEFORE DELETE ON room_requests BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(runOwnerHandoffMigration(database())).toBe(false);
    let runs = 0;
    expect(joinBootSettle(async () => { runs++; })).toBeNull();
    expect(runs).toBe(0);
    database().exec("DROP TRIGGER rr_nodelete");
    expect(runOwnerHandoffMigration(database())).toBe(true);
    const first = joinBootSettle(() => { runs++; return settleStartedDelegations({}); })!;
    const again = joinBootSettle(() => { runs++; return settleStartedDelegations({}); })!;
    expect(first.first).toBe(true);
    expect(again.first).toBe(false);
    expect(again.job).toBe(first.job);
    await first.job;
    expect(joinBootSettle(async () => { runs++; })!.first).toBe(false);                         // after it finished too
    expect(runs).toBe(1);
  });
  it("the classifier: busy, no space, I/O, memory, descriptors, locked, full, cannot open (with extended codes) are operational; anything else is the row's", () => {
    const sqlite = (errcode: number) => Object.assign(new Error("sqlite"), { code: "ERR_SQLITE_ERROR", errcode });
    const node = (code: string) => Object.assign(new Error(code), { code });
    for (const error of [sqlite(5), sqlite(517), sqlite(6), sqlite(262), sqlite(7), sqlite(10), sqlite(266), sqlite(3850), sqlite(13), sqlite(14), sqlite(1038),
      node("ENOSPC"), node("EDQUOT"), node("EIO"), node("ENOMEM"), node("EMFILE"), node("ENFILE"), new Error("database is locked")]) {
      expect(isBootSettleOperationalError(error), String((error as { errcode?: number; code?: string }).errcode ?? (error as { code?: string }).code)).toBe(true);
    }
    for (const error of [sqlite(1), sqlite(19), sqlite(11), node("ERR_SQLITE_ERROR"), new Error("disk I/O error"), new ClassificationViolation("A Murage-voice row stays classified: x"), "EIO", null, undefined]) {
      expect(isBootSettleOperationalError(error)).toBe(false);
    }
  });
  it("a classification refusal stays the row's own: the rest of the batch commits and no retry is scheduled", async () => {
    const w = ownerWorld("owner");
    for (let i = 0; i < 3; i++) expiredHold(w, `k${i}`);
    const warn = vi.spyOn(console, "warn");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const counted = countingStore(w.store, (_patch, id) => { if (id === heldLineId("k1")) throw new ClassificationViolation(`A Murage-voice row stays classified: ${id}`); });
    await settleStartedDelegations({ store: counted.store });
    expect(warn).not.toHaveBeenCalled();
    expect(rowOf("k0")).toBeUndefined();
    expect(rowOf("k1")).toMatchObject({ phase: "started" });
    expect(rowOf("k2")).toBeUndefined();
  });
  it("busy 20 times, then the outer retry: one warning, the hold kept, no continuation until it succeeds, then exactly one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = ownerWorld("owner");
    for (let i = 0; i < 2; i++) expiredHold(w, `b${i}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let busy = 25, attempts = 0;
    const store = { patchMessage: (t: string, i: string, p: never, within?: () => void) => { attempts++; if (busy > 0) { busy--; throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }); } return w.store.patchMessage(t, i, p, within); } };
    let continued = 0;
    const boot = joinBootSettle(() => settleStartedDelegations({ store: store as never }))!;
    void boot.job.then(() => { continued++; });
    let done = false;
    void boot.job.then(() => { done = true; });
    while (!done) {
      expect(delegationAdmissionHeld()).toBe(true);
      expect(continued).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      await tick();
    }
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ phase: "held", code: "SQLITE_5", attempt: 1, nextDelayMs: BOOT_SETTLE_RETRY_FIRST_MS });
    expect(attempts).toBe(25 + 2);
    expect(continued).toBe(1);
    expect(delegationAdmissionHeld()).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(0);
  });
  it("an I/O error each time: 1 s doubling to 60 s, one content-free warning per retry, then recovery with no one asked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = ownerWorld("owner");
    expiredHold(w, "io0");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let failures = 9;
    const store = { patchMessage: (t: string, i: string, p: never, within?: () => void) => { if (failures > 0) { failures--; throw Object.assign(new Error("disk I/O error reading the secret words of row io0"), { code: "ERR_SQLITE_ERROR", errcode: 266 }); } return w.store.patchMessage(t, i, p, within); } };
    let done = false;
    const job = settleStartedDelegations({ store: store as never }).then(() => { done = true; });
    for (let k = 0; k < 9; k++) {
      await until(() => warn.mock.calls.length === k + 1);
      expect(delegationAdmissionHeld()).toBe(true);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync((warn.mock.calls[k]![1] as { nextDelayMs: number }).nextDelayMs);
    }
    await job;
    const delays = warn.mock.calls.map((call) => (call[1] as { nextDelayMs: number }).nextDelayMs);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, BOOT_SETTLE_RETRY_MAX_MS, BOOT_SETTLE_RETRY_MAX_MS, BOOT_SETTLE_RETRY_MAX_MS]);
    warn.mock.calls.forEach((call, k) => {
      expect(call[1]).toMatchObject({ phase: "held", cursor: "start", code: "SQLITE_266", attempt: k + 1 });
      expect(JSON.stringify(call)).not.toMatch(/secret|io0/);
    });
    expect(rowOf("io0")).toBeUndefined();
  });
  it("the database closes while a retry waits: the timer goes, the job ends, nothing runs after", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const w = ownerWorld("owner");
    expiredHold(w, "c0");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const store = { patchMessage: () => { calls++; throw Object.assign(new Error("io"), { code: "EIO" }); } };
    let continued = 0;
    const boot = joinBootSettle(() => settleStartedDelegations({ store: store as never }))!;
    const ended = boot.job.then(() => { continued++; }, (error: { code?: string }) => error.code);
    await until(() => warn.mock.calls.length === 1);
    closeDatabase();
    expect(await ended).toBe("BOOT_SETTLE_DATABASE_CLOSED");
    await vi.advanceTimersByTimeAsync(5 * BOOT_SETTLE_RETRY_MAX_MS);
    expect(calls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(continued).toBe(0);
  });
});

// ── row deferral, owner actions between units, the closed-gate drain ───────────────────
describe("row deferral and the owner's controls during the settling", () => {
  it("the first 100 individual completions fail: row 101 is still settled, the failed ones stay non-runnable", { timeout: 60_000 }, async () => {
    const w = ownerWorld("room");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sorted = Array.from({ length: 101 }, (_, i) => heldRoom(w, `d${pad(i)}`));
    listen((id) => sorted.indexOf(id) < 100);
    await settleStartedDelegations({ store: w.store, botName: () => "Helper" });
    expect(roomRequest(database(), sorted[100]!)!.state).toBe("failed");
    for (const id of sorted.slice(0, 100)) {
      expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null });
      expect(isTerminalRoomRequestState(roomRequest(database(), id)!.state)).toBe(false);
    }
  });
  it("Dismiss and Send again between units: the partner ends in the same commit, nothing is restored, and the replacement waits behind the gate", async () => {
    const w = ownerWorld("room");
    const [first, , dismissed, resent] = ["h1", "h2", "h3", "h4"].map((id) => heldRoom(w, id));
    let replacement: string | undefined;
    onDelegationReceipt((receipt) => {
      listened.push(receipt.id);
      if (receipt.id === first) setImmediate(() => {
        expect(dismissHeldDelegation(dismissed!, w.store)).toBe(true);
        const sent = resendHeldDelegation(w.bus, resent!);
        expect(sent.result).toBe("ok");
        replacement = sent.id;
      });
      const row = roomRequest(database(), receipt.id);
      if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: "failed", now: Date.now() });
    });
    const settling = settleStartedDelegations({ store: w.store, botName: () => "Helper" });
    await until(() => replacement !== undefined);
    expect(delegationAdmissionHeld()).toBe(true);
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);                                       // the gate is closed: nothing starts
    expect(_drainingCount()).toBe(0);
    await settling;
    for (const id of [dismissed!, resent!]) {
      expect(rowOf(id)).toBeUndefined();
      expect(roomRequest(database(), id)!.state).toBe("cancelled");
      expect(listened).not.toContain(id);
      expect(storedControl(w.from.threadId, id)).toBeUndefined();
    }
    expect(rowOf(replacement!)).toMatchObject({ phase: "fresh" });
    expect(w.turns.map((turn) => turn.id)).not.toContain(replacement);
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await until(() => w.turns.some((turn) => turn.id === replacement));
    expect(w.turns.filter((turn) => turn.id === replacement)).toHaveLength(1);
  });
  it("a drain while the gate is closed, over more than 100 queued items, does not hold the conversation draining; afterwards they start in queue order", async () => {
    const w = ownerWorld("owner");
    const insert = database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key) VALUES(?,?,?,?,'fresh',NULL,?,'owner',?)");
    for (let i = 0; i < 150; i++) insert.run(`q${pad(i)}`, w.from.threadId, w.target.id, w.from.id, JSON.stringify({ toBotId: w.target.id, message: `m${i}`, depth: 0, attempts: 0 }), `dlg-q${pad(i)}`);
    expiredHold(w, "e0");
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const settling = settleStartedDelegations({ store: w.store, ready });
    await tick();
    expect(delegationAdmissionHeld()).toBe(true);
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    expect(_drainingCount()).toBe(0);                                                              // Stop is never held up behind a closed-gate walk
    expect(w.turns).toEqual([]);
    release();
    await settling;
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await until(() => w.turns.length >= 1);
    expect(w.turns[0]!.id).toBe("q0000");
    const started = w.turns.map((turn) => turn.id);
    expect(started).toEqual([...started].sort());
  });
});

