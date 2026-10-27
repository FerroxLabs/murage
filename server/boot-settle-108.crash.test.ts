// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOOT-SETTLE-108 (docs/designs/BOOT-SETTLE-HELD-SENDS-108.md section 6, server/boot-settle-108.crash.test.ts rows): what survives a real process death.
// Each death is a spawned child (server/testing/boot-settle-108-child.ts) that exits at the named point; the next start is this process, with the
// receipts read back from disk and nothing else remembered (_simulateRestart, _loadPending), the room sweep first, then the boot settling.
//  - SQL batches: death before and after COMMIT, two restarts, durable row/control/registration state
//  - a held hand-off whose receipt reached disk before its settle committed: the sweep leaves the partner live, the settling completes it once
//  - Dismiss and Send again: death before and after COMMIT; the partner, the row and the replacement are all or nothing
//  - the held partner settled before a later batch fails, a failed receipt commit retried in the same process, an existing notice receipt re-entered
//  - dispatch boundaries: death after the prompt and start commit (one more start, same prompt) and after the submission (held, never sent again)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskerWakes, type AskerWakeSnapshot } from "./asker-wake.ts";
import { DATA_DIR } from "./config.ts";
import { wakeAfterRecoveredReceipt, type AskerWakePort } from "./handoff-boundary.ts";
import { closeDatabase, database } from "./database.ts";
import {
  HELD_PARTNER_LIVE, _loadPending, _resetPending, _simulateRestart, appendHeldLine, dismissHeldDelegation, drainDelegations, findDelegationReceipt, heldLineId,
  onDelegationReceipt, onOwedHandoffReply, queueDelegation, reconcileStartedDelegations, recordDelegationReceipt, resendHeldDelegation, resettleStranded,
  settleStartedDelegations,
} from "./delegations.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { completeRequest, insertRoomRequest, isTerminalRoomRequestState, reconcileRoomRequestsAtBoot, roomRequest } from "./room-requests.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { dispatchHandoffRequest } from "./testing/handoff-turn.ts";
import { LINEAGE, ownerWorld, sharedWorld, type OwnerWorld } from "./testing/handoff-worlds.ts";
import { released } from "./testing/released.ts";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "testing", "boot-settle-108-child.ts");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) { if (Date.now() > deadline) throw new Error("timed out"); await tick(); }
}
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
const rowOf = (id: string) => database().prepare("SELECT phase, origin, started_at, submitted_at, start_attempts FROM pending_delegations WHERE id=?").get(id) as Record<string, unknown> | undefined;
const stateOf = (id: string) => roomRequest(database(), id)?.state;
const wakes = (id: string) => count("SELECT COUNT(*) AS n FROM room_requests WHERE admission_key=?", `wake:${id}`);
const restartWakes = (id: string) => count("SELECT COUNT(*) AS n FROM room_requests WHERE admission_key=?", `wake:restart:${id}`);
/** Every time a request's result was handed back in a wake, with the wake it rode in: a result for an asker whose wake has not started joins that wake (room-requests.ts insertWake), so a wake keyed by this request is not the only place it can arrive. */
const returned = (id: string): Array<{ requestId?: string; state?: string; toBotId: string; threadId: string }> =>
  (database().prepare("SELECT to_bot_id, target_thread_id, payload_text FROM room_requests WHERE verb='wake' AND payload_text LIKE '[%'").all() as Array<{ to_bot_id: string; target_thread_id: string; payload_text: string }>)
    .flatMap((w) => (JSON.parse(w.payload_text) as Array<{ requestId?: string; state?: string }>).map((r) => ({ ...r, toBotId: w.to_bot_id, threadId: w.target_thread_id })))
    .filter((r) => r.requestId === id);
const storedControl = (thread: string, id: string): unknown => {
  const row = database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(thread, heldLineId(id)) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as { delegationHeld?: unknown }).delegationHeld : "no line";
};
const pad = (i: number) => String(i).padStart(4, "0");
// every death is a fresh node process loading the server modules
vi.setConfig({ testTimeout: 180_000 });

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); });
afterEach(() => { vi.restoreAllMocks(); onDelegationReceipt(undefined); onOwedHandoffReply(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

/** The child dies at its point; this process is the next start. */
function crash(scenario: string, id = ""): void {
  closeDatabase();
  const env: NodeJS.ProcessEnv = { HOME: homedir(), USERPROFILE: homedir(), MURAGE_DATA_DIR: DATA_DIR, BOOT_SETTLE_108_CHILD: "1", MURAGE_TEST_ENV_SCRUBBED: "1" };
  for (const key of ["PATH", "SystemRoot", "MURAGE_ENGINE_EXCLUSION_PATH"]) if (process.env[key]) env[key] = process.env[key];
  const child = spawnSync(process.execPath, [CHILD, scenario, id], { cwd: join(dirname(CHILD), "..", ".."), env, encoding: "utf8", timeout: 60_000 });
  expect(child.stdout.includes("NOT_REACHED") ? `${scenario} never reached its death point:\n${child.stdout}\n${child.stderr}` : "").toBe("");
  expect(child.status, `${scenario}: ${child.stderr}`).toBe(9);
}
/** A fresh start in this process: only what is on disk (the database, the receipts file). */
function restart(): Store {
  _simulateRestart(); _loadPending();
  return new Store(() => ({ instanceId: "fixture", model: "fixture" }));
}
/** As the server's receipt listener: a held reply completes nothing; any other receipt ends a live request with its outcome (the wakes are the request's own). */
const listened: string[] = [];
function listen(refuse: (id: string) => boolean = () => false): void {
  listened.splice(0);
  onDelegationReceipt((receipt) => {
    listened.push(receipt.id);
    if (refuse(receipt.id)) throw new Error("the completion failed");
    if (receipt.held) return;
    const row = roomRequest(database(), receipt.id);
    if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: receipt.status === "done" ? "done" : receipt.status === "cancelled" ? "cancelled" : "failed", now: Date.now() });
  });
}
/** A room ask that returns its result to the asking bot (no parent, a return conversation), whose hand-off is held after a restart: handed to the provider,
 * no evidence. Its request is running, or waiting on the owner. */
function heldAsk(w: OwnerWorld, id: string, options: { state?: "running" | "waiting_owner"; submittedAt?: number; started?: boolean } = {}): string {
  insertRoomRequest(database(), { id, groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.from.id, toBotId: w.target.id, returnThreadId: w.from.threadId, returnBotId: w.from.id, admissionKey: `ask:delegation:${id}`, now: 2, lineage: LINEAGE(w.from.threadId) });
  dispatchHandoffRequest(database(), id, { now: 2 });
  if (options.state === "waiting_owner") database().prepare("UPDATE room_requests SET state='waiting_owner', waiting_since=3 WHERE id=?").run(id);
  const at = options.submittedAt ?? Date.now();
  database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, submitted_at, started_at) VALUES(?,?,?,?,'started',NULL,?,'room',?,?,?)")
    .run(id, w.from.threadId, w.target.id, w.from.id, JSON.stringify({ message: "room work", depth: 0, attempts: 0 }), `dlg-${id}`, at, options.started ? at : null);
  if (!options.started) appendHeldLine(w.store, { id, sourceThreadId: w.from.threadId, toBotId: w.target.id, fromBotId: w.from.id, toBotName: "Helper", text: "held" });
  return id;
}
function expiredHold(w: OwnerWorld, id: string): void {
  database().prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, retry_at, item, origin, turn_key, submitted_at, started_at) VALUES(?,?,?,?,'started',NULL,?,'owner',?,1,NULL)")
    .run(id, w.from.threadId, w.target.id, w.from.id, JSON.stringify({ message: "m", depth: 0, attempts: 0 }), `dlg-${id}`);
  appendHeldLine(w.store, { id, sourceThreadId: w.from.threadId, toBotId: w.target.id, fromBotId: w.from.id, toBotName: "Helper", text: "held" });
}
/** The boot as the server runs it: the room sweep first, then the settling. */
async function boot(store: Store): Promise<void> {
  reconcileRoomRequestsAtBoot(database(), Date.now());
  await settleStartedDelegations({ store, botName: () => "Helper" });
}

// ── SQL durability boundaries ────────────────────────────────────────────────────────
describe("SQL batches: a death before or after COMMIT", () => {
  it.each(["expiry-before-commit", "expiry-after-commit"])("%s: the committed batch is whole, the rest is untouched, two restarts finish the cleanup, nothing is started", async (scenario) => {
    const w = ownerWorld("owner");
    for (let i = 0; i < 200; i++) expiredHold(w, `e${pad(i)}`);
    crash(scenario);
    restart();
    // before COMMIT of the second batch (patch 150) or right after the first COMMIT: exactly the first batch is gone, row, control and registration together
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(100);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(100);
    expect(storedControl(w.from.threadId, "e0099")).toBeUndefined();
    expect(storedControl(w.from.threadId, "e0100")).toEqual({ id: "e0100" });
    for (let start = 0; start < 2; start++) await boot(restart());
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines")).toBe(0);
    expect(storedControl(w.from.threadId, "e0199")).toBeUndefined();
    expect(w.turns).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'dlg-%'")).toBe(0);              // no prompt was ever written
  });
});

// ── saved held receipt, sweep before settle ─────────────────────────────────────────────
describe("a held hand-off's receipt reached disk, then the process died before its settle committed", () => {
  it.each(["running", "waiting_owner"] as const)("room ask %s: the sweep leaves it live, the settling ends it from the saved receipt, one return wake, no restart wake, twice", async (state) => {
    const w = ownerWorld("room");
    heldAsk(w, "h1", { state });
    heldAsk(w, "h2", { state, submittedAt: 1 });                                                   // an old hold with no receipt yet: settled before it expires
    const cancelled = heldAsk(w, "h3", { state });
    completeRequest(database(), cancelled, { state: "cancelled", now: 3 });                       // already ended: closed as cancelled, never re-entered
    crash("receipt-saved");
    let store = restart();
    expect(findDelegationReceipt("h1")).toMatchObject({ status: "failed" });                       // the receipt is on disk
    expect(stateOf("h1")).toBe(state);                                                             // its settle never committed
    listen();
    reconcileRoomRequestsAtBoot(database(), Date.now());
    for (const id of ["h1", "h2"]) { expect(stateOf(id)).toBe(state); expect(restartWakes(id)).toBe(0); }
    await settleStartedDelegations({ store, botName: () => "Helper" });
    expect(stateOf("h1")).toBe("failed");
    expect(returned("h1")).toMatchObject([{ state: "failed", toBotId: w.from.id, threadId: w.from.threadId }]);
    expect(restartWakes("h1")).toBe(0);
    expect(rowOf("h1")).toMatchObject({ phase: "started", started_at: null });                    // still held for the owner, its notice kept
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id=?", heldLineId("h1"))).toBe(1);
    expect(stateOf("h2")).toBe("failed");                                                          // completed first, then let go
    expect(returned("h2")).toMatchObject([{ state: "failed", toBotId: w.from.id, threadId: w.from.threadId }]);
    expect(rowOf("h2")).toBeUndefined();
    expect(stateOf("h3")).toBe("cancelled");
    expect(rowOf("h3")).toBeUndefined();
    expect(restartWakes("h3")).toBe(0);
    // a second start: the same outcome, the same one wake, the same one notice
    store = restart();
    listen();
    await boot(store);
    expect(stateOf("h1")).toBe("failed");
    expect(returned("h1")).toMatchObject([{ state: "failed", toBotId: w.from.id, threadId: w.from.threadId }]);
    expect(restartWakes("h1")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id=?", heldLineId("h1"))).toBe(1);
    expect(listened).not.toContain("h1");                                                          // its partner is terminal: nothing to re-enter
    expect(w.turns).toEqual([]);
  });
  it("shared work: the sweep leaves it live, the settling ends it from the saved receipt, its capacity is free, nothing is sent again", async () => {
    const w = sharedWorld();
    w.handoff("sh1");
    database().prepare("UPDATE pending_delegations SET phase='started', started_at=NULL, submitted_at=? WHERE id='sh1'").run(Date.now());
    database().prepare("UPDATE room_requests SET state='running', dispatched_at=2 WHERE id='sh1'").run();
    crash("receipt-saved");
    const store = restart();
    expect(findDelegationReceipt("sh1")).toBeTruthy();
    listen();
    reconcileRoomRequestsAtBoot(database(), Date.now());
    expect(stateOf("sh1")).toBe("running");
    expect(restartWakes("sh1")).toBe(0);
    await settleStartedDelegations({ store, botName: () => "Iris" });
    expect(stateOf("sh1")).toBe("failed");                                                         // terminal: the shared slot is free
    expect(count("SELECT COUNT(*) AS n FROM room_requests WHERE state IN ('queued','running','waiting_owner','waiting_bot') AND id='sh1'")).toBe(0);
    expect(w.turns).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase='fresh'")).toBe(0);    // no new hand-off
  });
});

// ── owner action before held settlement ───────────────────────────────────────────────
describe("Dismiss and Send again on a held hand-off whose request is still live", () => {
  it.each(["dismiss-before-commit", "send-before-commit"])("%s: everything rolls back together: the row, the control, the live request, no new id", async (scenario) => {
    const w = ownerWorld("room");
    heldAsk(w, "o1");
    const rowsBefore = count("SELECT COUNT(*) AS n FROM pending_delegations");
    crash(scenario, "o1");
    restart();
    expect(rowOf("o1")).toMatchObject({ phase: "started", started_at: null });
    expect(stateOf("o1")).toBe("running");
    expect(storedControl(w.from.threadId, "o1")).toEqual({ id: "o1" });
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines WHERE delegation_id='o1'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(rowsBefore);
  });
  it.each(["dismiss-after-commit", "send-after-commit"])("%s: the partner is cancelled with the row's removal; two restarts add no restart wake, no second wake and no start", async (scenario) => {
    const w = ownerWorld("room");
    heldAsk(w, "o2");
    crash(scenario, "o2");
    for (let start = 0; start < 2; start++) {
      const store = restart();
      expect(rowOf("o2")).toBeUndefined();
      expect(stateOf("o2")).toBe("cancelled");
      expect(storedControl(w.from.threadId, "o2")).toBeUndefined();
      expect(count("SELECT COUNT(*) AS n FROM held_notice_lines WHERE delegation_id='o2'")).toBe(0);
      listen();
      await boot(store);
      expect(restartWakes("o2")).toBe(0);
      expect(wakes("o2")).toBeLessThanOrEqual(1);
      expect(stateOf("o2")).toBe("cancelled");
      const fresh = count("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase='fresh'");
      expect(fresh).toBe(scenario === "send-after-commit" ? 1 : 0);                                // at most one replacement, queued behind the gate
    }
    expect(w.turns).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'dlg-%'")).toBe(0);
  });
  it("Send again ends the partner from a usable saved receipt; Dismiss cancels it whatever the receipt says; a held reply's receipt and an already ended request do not decide", () => {
    const w = ownerWorld("room");
    heldAsk(w, "r1"); heldAsk(w, "r2"); heldAsk(w, "r3"); heldAsk(w, "r4");
    recordDelegationReceipt({ id: "r1", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("found it") });
    recordDelegationReceipt({ id: "r2", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("held words"), held: { messageId: "m-held", since: Date.now() } });
    recordDelegationReceipt({ id: "r4", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("found it too") });
    completeRequest(database(), "r3", { state: "failed", now: 3 });
    for (const id of ["r1", "r2", "r4"]) expect(stateOf(id)).toBe("running");                     // saved while nothing completed them
    listen();
    expect(dismissHeldDelegation("r1", w.store)).toBe(true);
    expect(stateOf("r1")).toBe("cancelled");                                                       // Dismiss cancels (design 3, 6): the receipt does not decide it
    expect(listened).not.toContain("r1");
    expect(resendHeldDelegation(w.bus, "r4").result).toBe("ok");
    expect(stateOf("r4")).toBe("done");                                                            // Send again: from the receipt
    expect(resendHeldDelegation(w.bus, "r2").result).toBe("ok");
    expect(stateOf("r2")).toBe("cancelled");                                                       // a held reply never completes a live request
    expect(dismissHeldDelegation("r3", w.store)).toBe(true);
    expect(stateOf("r3")).toBe("failed");                                                          // an ended request keeps its own outcome
    for (const id of ["r1", "r2", "r3", "r4"]) expect(rowOf(id)).toBeUndefined();
  });
  it("a receipt settle that leaves the partner waiting on its own asks refuses Send again: the pair, the control, the open ask and no new id", () => {
    const w = ownerWorld("room");
    heldAsk(w, "wb");
    // the partner asked a teammate of its own, still open: a done result parks it waiting_bot instead of ending it (room-requests.ts completeRequest)
    insertRoomRequest(database(), { id: "wb-child", groupId: "g", verb: "ask", fromKind: "bot", fromBotId: w.target.id, toBotId: w.from.id, parentId: "wb", admissionKey: "ask:child:wb", now: 3 });
    recordDelegationReceipt({ id: "wb", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("done, but asked someone") });
    expect(stateOf("wb")).toBe("running");
    const rowsBefore = count("SELECT COUNT(*) AS n FROM pending_delegations");
    listen();
    let refusal: unknown;
    try { resendHeldDelegation(w.bus, "wb"); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: HELD_PARTNER_LIVE, reason: "waiting" });                // deferred: the route words it as waiting, not "try again"
    expect(listened).toContain("wb");                                                              // the receipt was settled, and that settle rolled back with the rest
    expect(stateOf("wb")).toBe("running");
    expect(stateOf("wb-child")).not.toBe("cancelled");                                             // the open work was not cancelled
    expect(isTerminalRoomRequestState(stateOf("wb-child")!)).toBe(false);
    expect(rowOf("wb")).toMatchObject({ phase: "started", started_at: null });
    expect(storedControl(w.from.threadId, "wb")).toEqual({ id: "wb" });
    expect(count("SELECT COUNT(*) AS n FROM held_notice_lines WHERE delegation_id='wb'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(rowsBefore);
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase='fresh'")).toBe(0);
  });
  it("Send again's other removals end the partner too: already ran, and an unreadable payload", () => {
    const w = ownerWorld("room");
    heldAsk(w, "ar"); heldAsk(w, "un");
    database().prepare("UPDATE pending_delegations SET accepted_turn_id='turn-1' WHERE id='ar'").run();
    database().prepare("UPDATE pending_delegations SET item='{' WHERE id='un'").run();
    expect(resendHeldDelegation(w.bus, "ar").result).toBe("already_ran");
    expect(resendHeldDelegation(w.bus, "un").result).toBe("not_held");
    for (const id of ["ar", "un"]) {
      expect(rowOf(id)).toBeUndefined(); expect(stateOf(id)).toBe("cancelled");
      expect(storedControl(w.from.threadId, id)).toBeUndefined();                                  // the control goes with the row, in the same commit
      expect(count("SELECT COUNT(*) AS n FROM held_notice_lines WHERE delegation_id=?", id)).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations WHERE phase='fresh'")).toBe(0);
  });
  it("a deferred settle, a completion that fails and a refused replacement roll the whole action back: the pair, the control and no new id", () => {
    const w = ownerWorld("room");
    vi.spyOn(console, "error").mockImplementation(() => {});
    heldAsk(w, "f1"); heldAsk(w, "f2"); heldAsk(w, "f3");
    // f1: its saved receipt cannot be settled now (the completion throws): stranded, and Send again (which ends the request from the receipt) is refused
    listen((id) => id === "f1");
    recordDelegationReceipt({ id: "f1", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("x") });
    let refusal: unknown;
    try { resendHeldDelegation(w.bus, "f1"); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: HELD_PARTNER_LIVE });
    expect((refusal as { reason?: unknown }).reason).toBeUndefined();                              // transient: the route keeps "Try again in a moment"
    // f2: the room's cancel fails
    expect(() => dismissHeldDelegation("f2", w.store, { cancelPartner: () => { throw new Error("the cancel failed"); } })).toThrow("the cancel failed");
    // f3: the conversation already holds as many hand-offs as one turn may queue: the replacement is refused
    const before = count("SELECT COUNT(*) AS n FROM pending_delegations");
    for (let i = 0; i < 40 && queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: `fill ${i}`, depth: 0 }, 9).result === "ok"; i++) { /* fill the queue */ }
    const filled = count("SELECT COUNT(*) AS n FROM pending_delegations");
    expect(resendHeldDelegation(w.bus, "f3").result).toBe("too_many");
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations")).toBe(filled);
    expect(filled).toBeGreaterThan(before);
    for (const id of ["f1", "f2", "f3"]) {
      expect(rowOf(id)).toMatchObject({ phase: "started", started_at: null });
      expect(stateOf(id)).toBe("running");
      expect(storedControl(w.from.threadId, id)).toEqual({ id });
    }
    // the stranded settle of f1 settles the row that is still there once the completion works
    listen();
    expect(resettleStranded()).toBe(1);
    expect(stateOf("f1")).toBe("done");
    expect(rowOf("f1")).toMatchObject({ phase: "started", started_at: null });
  });
});

// ── held partner and the receipts' own commits ──────────────────────────────────────────
describe("a held partner settles on its own unit, before any later batch", () => {
  it("STARTED holds a submitted room ask, HELD settles its partner; a later batch fails: the completion and its wake stay, the batch rows stay", async () => {
    const w = ownerWorld("room");
    heldAsk(w, "a-st", { started: true });
    for (let i = 0; i < 3; i++) expiredHold(w, `z${i}`);
    listen();
    let patches = 0;
    const failing = { patchMessage: (t: string, i: string, p: never, within?: () => void) => w.store.patchMessage(t, i, p, () => { if (i.startsWith("held-z") && ++patches === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); within?.(); }) };
    expect(() => reconcileStartedDelegations({ store: failing as never, botName: () => "Helper" })).toThrow("disk full");
    expect(rowOf("a-st")).toMatchObject({ phase: "started", started_at: null });                 // held by the STARTED pass
    expect(stateOf("a-st")).toBe("failed");                                                        // its partner ended in its own commit
    expect(wakes("a-st")).toBe(1);                                                                 // and the wake with it
    expect(count("SELECT COUNT(*) AS n FROM pending_delegations WHERE id LIKE 'z%'")).toBe(3);     // the failed batch rolled back whole
  });
  it("the receipt's own commit fails: the same process settles it again from the stranded set; an existing notice receipt is re-entered", async () => {
    const w = ownerWorld("room");
    vi.spyOn(console, "error").mockImplementation(() => {});
    heldAsk(w, "c1"); heldAsk(w, "c2");
    // c2 already has its notice receipt from an earlier start, saved while its request stayed live
    onDelegationReceipt(undefined);
    recordDelegationReceipt({ id: "c2", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "failed", result: released("uncertain") });
    expect(stateOf("c2")).toBe("running");
    let refuse = true;
    listen((id) => id === "c1" && refuse);
    await settleStartedDelegations({ store: w.store, botName: () => "Helper" });
    expect(stateOf("c1")).toBe("running");
    expect(stateOf("c2")).toBe("failed");                                                          // explicit re-entry from the saved receipt
    expect(listened).toContain("c2");
    refuse = false;
    expect(resettleStranded()).toBe(1);
    expect(stateOf("c1")).toBe("failed");
    expect(returned("c1")).toMatchObject([{ state: "failed", toBotId: w.from.id, threadId: w.from.threadId }]);
  });
  it("an owed line acknowledged once is never delivered or woken again by a later start", async () => {
    const w = ownerWorld("owner");
    const lines: string[] = [];
    onOwedHandoffReply(undefined);
    recordDelegationReceipt({ id: "ow1", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("r"), reply: { text: "the answer" } });
    onOwedHandoffReply((receipt) => { lines.push(receipt.id); return { id: `line-${receipt.id}` }; });
    listen();
    await settleStartedDelegations({ botName: () => "Helper" });
    expect(lines).toEqual(["ow1"]);
    for (let start = 0; start < 2; start++) {
      restart();
      onOwedHandoffReply((receipt) => { lines.push(receipt.id); return { id: `line-${receipt.id}` }; });
      listen();
      await settleStartedDelegations({ botName: () => "Helper" });
    }
    expect(lines).toEqual(["ow1"]);
    expect(listened).toEqual([]);
  });
});

// ── a direct hand-off's owed line and its asker's wake ────────────────────────────────────
/** The asker wakes kept on disk, one snapshot per thread, as the child keeps them (the real AskerWakes, its own persist). */
const WAKES_FILE = () => join(DATA_DIR, "bs108-asker-wakes.json");
const wakesOnDisk = (): Record<string, AskerWakeSnapshot> => { try { return JSON.parse(readFileSync(WAKES_FILE(), "utf8")) as Record<string, AskerWakeSnapshot>; } catch { return {}; } };
function diskWakes(): AskerWakes {
  const wakes = new AskerWakes((_bot, threadId, snapshot) => { const all = wakesOnDisk(); if (snapshot) all[threadId] = snapshot; else delete all[threadId]; writeFileSync(WAKES_FILE(), JSON.stringify(all)); });
  for (const [threadId, snapshot] of Object.entries(wakesOnDisk())) wakes.restore(threadId, snapshot, new Set());
  return wakes;
}
/** As the server's receipt listener for a direct hand-off (no request): its follow-up wakes the asker through wakeAfterRecoveredReceipt and says whether that wake is on disk. */
function listenDirect(wakes: AskerWakes, lines: string[]): void {
  const port: AskerWakePort = { register: (t, a) => wakes.register(t, a), consume: (t) => wakes.consume(t), returned: (t, th, r) => { wakes.deliver(t, r); return wakes.durable(th); } };
  onOwedHandoffReply((receipt) => { lines.push(receipt.id); return { id: `line-${receipt.id}` }; });
  onDelegationReceipt((receipt, delivered) => () => wakeAfterRecoveredReceipt(port, receipt, delivered?.id));
}
const wakeResults = (thread: string, id: string): number => (wakesOnDisk()[thread]?.wakes ?? []).flatMap((r) => r.results).filter((r) => r.taskId === id).length;
describe("a direct hand-off's owed line is kept until its asker's wake is on disk", () => {
  it("a death after the settle's commit and before the wake reaches disk: the next start delivers the wake once, from the line still owed", async () => {
    const w = ownerWorld("owner");
    onOwedHandoffReply(undefined);
    recordDelegationReceipt({ id: "dw1", sourceThreadId: w.from.threadId, toBotId: w.target.id, toBotName: "Helper", status: "done", result: released("r"), reply: { text: "the answer" } });
    expect(diskWakes().register("dw1", { botId: w.from.id, threadId: w.from.threadId, depth: 1, notOwnerAudience: false, unattended: false })).toBe(true);
    // depth 1: a depth-0 intent needs its root allowance to read back (asker-wake.ts restoredIntent), which this fixture does not model
    expect(diskWakes().intends("dw1")).toBe(true);
    // the child's OWED pass commits the line, then its follow-up dies inside the wake's own write to disk
    crash("owed-wake-death", "dw1");
    restart();
    expect(findDelegationReceipt("dw1")?.reply).toBeDefined();                                     // still owed: the obligation outlived the death
    expect(wakeResults(w.from.threadId, "dw1")).toBe(0);                                           // and the wake never reached disk
    const lines: string[] = [];
    for (let start = 0; start < 2; start++) {
      if (start) restart();
      const wakes = diskWakes();
      listenDirect(wakes, lines);
      await settleStartedDelegations({ botName: () => "Helper" });
      expect(wakeResults(w.from.threadId, "dw1")).toBe(1);                                         // one wake, on disk, the second start too
      expect(findDelegationReceipt("dw1")?.reply).toBeUndefined();                                 // released only now
    }
    expect(lines).toEqual(["dw1"]);                                                                // the second start owes nothing
  });
});

// ── receipt and dispatch boundaries ──────────────────────────────────────────────────
describe("a death at the dispatch's own commits", () => {
  it("after the prompt and the start committed: one more start, reusing the same prompt; after the submission: held, never sent again", async () => {
    const w = ownerWorld("owner");
    const prompted = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "prompt then die", depth: 0 }, 2).id!;
    const submitted = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "submit then die", depth: 0 }, 2).id!;
    crash("dispatch-prompt", prompted);
    crash("dispatch-submit", submitted);
    const store = restart();
    const prompts = () => count("SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'dlg-%'");
    expect(prompts()).toBe(2);
    await boot(store);
    expect(rowOf(prompted)).toMatchObject({ phase: "fresh" });
    expect(rowOf(submitted)).toMatchObject({ phase: "started", started_at: null });                // uncertain: held for the owner
    w.attach();
    drainDelegations(w.bus, w.approvalBus, w.from.threadId);
    await until(() => w.turns.length >= 1);
    await tick(); await tick();
    expect(w.turns.map((turn) => turn.id)).toEqual([prompted]);                                    // the submitted one is never started again
    expect(prompts()).toBe(2);                                                                     // the same prompt, not a second one
  });
});
