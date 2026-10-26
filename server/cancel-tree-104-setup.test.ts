// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CANCEL-TREE-104 R2, R3, R4, R6 (lanes/release104/designs/CANCEL-TREE-104.md): a cancel that lands while a hand-off's turn is being set up (the row is
// started, nothing handed to the provider yet) ends that hand-off: the hand-over is refused, the row is settled as cancelled whatever its attempts, the
// source room gets one closing line linked to the request, and nobody wakes the cancelled asker. The same at a restart and for a shared hand-off.
import { mkdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import {
  _resetPending, dropQueuedDelegation, findDelegationReceipt, handoffClosingLineId, onDelegationReceipt, queueDelegation, reconcileStartedDelegations,
  settleStartedDelegations,
} from "./delegations.ts";
import { configureHandoffDispatch, dispatchHandoff, type CouldNotStart, type HandoffTurnOptions } from "./handoff-dispatch.ts";
import { storedMessage } from "./message-db.ts";
import { status } from "./murage-status.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { cancelRoomRequest, completeRequest, isTerminalRoomRequestState, roomRequest } from "./room-requests.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { fakeHost, heldNotices, rememberRun, writePrompt } from "./testing/handoff-turn.ts";
import { ownerWorld, sharedWorld, type OwnerWorld, type SharedWorld } from "./testing/handoff-worlds.ts";

const CLOSING = (target: string) => `Hand-off to @${target} cancelled because the request that asked ended`;
const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); heldNotices.splice(0); };
beforeEach(() => {
  fresh();
  // the server's receipt listener (index.ts onDelegationReceipt): a hand-off's receipt ends its room request
  onDelegationReceipt((receipt) => {
    const row = roomRequest(database(), receipt.id);
    if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: receipt.status === "done" ? "done" : "cancelled", now: Date.now() });
  });
});
afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

const pendingRow = (id: string) => database().prepare("SELECT phase, started_at, submitted_at, accepted_turn_id, start_attempts FROM pending_delegations WHERE id=?").get(id) as
  { phase: string; started_at: number | null; submitted_at: number | null; accepted_turn_id: string | null; start_attempts: number | null } | undefined;
const lineCount = (threadId: string, id: string) => Number((database().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id=?").get(threadId, id) as { n: number }).n);
const wakesUnder = (parentId: string) => Number((database().prepare("SELECT COUNT(*) AS n FROM room_requests WHERE parent_id=? AND verb='wake'").get(parentId) as { n: number }).n);
/** The owner's cancel of the asker (root), as the server does it: the walk ends the hand-off's ask in the same commit. */
const cancelAsker = () => {
  database().prepare("UPDATE room_requests SET state='waiting_bot' WHERE id='root'").run();
  const cancelled = cancelRoomRequest(database(), "root", { now: Date.now() });
  expect(cancelled).not.toBeNull();
  return cancelled!;
};
/** The closing line in the source room: once, Murage's own, linked to the request, no `to`. */
function expectClosed(w: OwnerWorld, id: string) {
  const line = storedMessage(w.from.threadId, handoffClosingLineId(id));
  expect(line?.tool?.name).toBe(CLOSING("Helper"));
  expect(line?.requestId).toBe(id);
  expect(line?.to).toBeUndefined();
  expect(lineCount(w.from.threadId, handoffClosingLineId(id))).toBe(1);
  expect(findDelegationReceipt(id)?.status).toBe("cancelled");
  expect(pendingRow(id)).toBeUndefined();
  expect(roomRequest(database(), id)!.state).toBe("cancelled");
  expect(wakesUnder("root")).toBe(0);                                                  // nobody wakes the cancelled asker
  expect(heldNotices).toEqual([]);
}
/** A server whose startTurn stamps the start (prompt and row in one commit), then runs the test's own steps in the setup window. */
function attach(w: OwnerWorld, steps: (turn: HandoffTurnOptions) => void | Promise<void>, couldNotStart: CouldNotStart[] = []): void {
  configureHandoffDispatch({
    ...fakeHost(w.bus, () => {}, { stamp: false }),
    startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => {
      rememberRun(turn.delegationRun);
      writePrompt(w.bus, turn.delegationRun, turn.threadId, text);
      await steps(turn);
    },
    couldNotStart: (info) => { couldNotStart.push(info); },
  }, { bus: w.bus, approvalBus: w.approvalBus });
}
const queued = (w: OwnerWorld) => queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "find the number", depth: 0 }, 2).id!;

describe("R2/R3: the asker is cancelled while the hand-off's turn is being set up", () => {
  it("submitted() is refused, the provider never gets the turn, the hand-off ends cancelled with the closing line, no could-not-start chip", async () => {
    const w = ownerWorld("room");
    const couldNotStart: CouldNotStart[] = [];
    let provider = 0;
    attach(w, (turn) => {
      expect(pendingRow(turn.delegationRun.id)?.phase).toBe("started");
      const cancelled = cancelAsker();
      expect(cancelled.cancelled.map((q) => q.id)).toContain(turn.delegationRun.id);
      expect(() => turn.delegationRun.submitted()).toThrow(/request that asked ended/);
      // nothing was written: the row still reads never handed over
      expect(pendingRow(turn.delegationRun.id)).toMatchObject({ phase: "started", submitted_at: null, accepted_turn_id: null });
      provider += 0;                                                                     // the provider step is after the fence: never reached
      turn.onDispatchError("turn stopped before dispatch: the request that asked ended");  // the host's quiet cancelled path (index.ts DirectTurnSetupCancelled)
    }, couldNotStart);
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(provider).toBe(0);
    expectClosed(w, id);
    expect(couldNotStart).toEqual([]);
  });

  it("the other acceptance order: accepted() before the submit is refused too, same end", async () => {
    const w = ownerWorld("room");
    attach(w, (turn) => {
      cancelAsker();
      expect(() => turn.delegationRun.accepted("cloud:1")).toThrow(/request that asked ended/);
      expect(() => turn.delegationRun.submitted()).toThrow(/request that asked ended/);
      expect(pendingRow(turn.delegationRun.id)).toMatchObject({ submitted_at: null, accepted_turn_id: null });
      turn.onDispatchError("turn stopped before dispatch: the request that asked ended");
    });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expectClosed(w, id);
  });

  it("a start past the attempt limit is still settled as cancelled, never held for the owner", async () => {
    const w = ownerWorld("room");
    attach(w, (turn) => {
      cancelAsker();
      expect(() => turn.delegationRun.submitted()).toThrow(/request that asked ended/);
      turn.onDispatchError("turn stopped before dispatch: the request that asked ended");
    });
    const id = queued(w);
    database().prepare("UPDATE pending_delegations SET start_attempts=1 WHERE id=?").run(id);   // this start makes it 2, the limit
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expectClosed(w, id);
  });

  it("guard: an open asker is handed over as before", async () => {
    const w = ownerWorld("room");
    attach(w, (turn) => { turn.delegationRun.submitted(); turn.delegationRun.accepted("turn-1"); });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(pendingRow(id)).toMatchObject({ phase: "started", accepted_turn_id: "turn-1" });
    expect(roomRequest(database(), id)!.state).toBe("running");
  });
});

describe("R6: the closing line, once, at both sites", () => {
  it("site 1 (the drain): a queued hand-off whose asker ended gets one line; a second drain adds nothing", async () => {
    const w = ownerWorld("room");
    const id = queued(w);
    database().prepare("UPDATE room_requests SET state='cancelled', finished_at=5 WHERE id='root'").run();
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expectClosed(w, id);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(lineCount(w.from.threadId, handoffClosingLineId(id))).toBe(1);
    expect(w.turns).toEqual([]);
  });

  it("site 2 (the post-commit drop): the same line, the receipt, then the row; a later drain adds nothing", async () => {
    const w = ownerWorld("room");
    const id = queued(w);
    const cancelled = cancelAsker();
    expect(cancelled.cancelled.map((q) => q.id)).toContain(id);
    expect(dropQueuedDelegation(w.bus, id, status("receipt_cancelled"))).toBe(true);
    expectClosed(w, id);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(lineCount(w.from.threadId, handoffClosingLineId(id))).toBe(1);
    expect(database().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND json_extract(json,'$.tool.name') LIKE 'Delegation to @%'").get(w.from.threadId)).toMatchObject({ n: 0 });
  });

  it("a cancelled SHARED request's hand-off is receipted and closed the same way", async () => {
    const w: SharedWorld = sharedWorld();
    const ask = w.handoff("ask");
    database().prepare("UPDATE room_requests SET state='cancelled', finished_at=5 WHERE id=?").run(ask.id);
    const source = (database().prepare("SELECT source_thread_id FROM pending_delegations WHERE id=?").get(ask.id) as { source_thread_id: string }).source_thread_id;
    await dispatchHandoff(ask.id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(w.turns.map((turn) => turn.id)).not.toContain(ask.id);
    expect(findDelegationReceipt(ask.id)?.status).toBe("cancelled");
    expect(pendingRow(ask.id)).toBeUndefined();
    const line = storedMessage(source, handoffClosingLineId(ask.id));
    expect(line?.tool?.name).toMatch(/^Hand-off to @.* cancelled because the request that asked ended$/);
    expect(line?.requestId).toBe(ask.id);
  });
});

describe("R4: a restart in the middle of the cancel", () => {
  it("a started, never handed-over row (attempts at the limit) whose asker ended: boot resets it, the drain settles it cancelled, no start, one line", async () => {
    const w = ownerWorld("room");
    let starts = 0;
    // the start that the crash cut short: stamped (prompt and row in one commit), nothing handed over, the process gone before any more happened
    attach(w, () => { starts += 1; });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(starts).toBe(1);
    expect(pendingRow(id)).toMatchObject({ phase: "started", submitted_at: null, accepted_turn_id: null });
    starts = 0;
    database().prepare("UPDATE pending_delegations SET start_attempts=2 WHERE id=?").run(id);
    cancelAsker();                                                                       // the commit landed; the process died before the effects ran
    expect(roomRequest(database(), id)!.state).toBe("cancelled");
    await settleStartedDelegations({ store: w.store });
    reconcileStartedDelegations({ store: w.store });
    expect(pendingRow(id)?.phase).toBe("fresh");                                         // not held: nothing for the owner to decide
    expect(heldNotices).toEqual([]);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expect(starts).toBe(0);
    expectClosed(w, id);
  });
});

describe("R1/R2c sites in index.ts (the server is not loaded here)", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("hand-off turns are bound to their request by generation; the interrupt revokes the bound setup first, and only the bound one", () => {
    // only a hand-off that has a request row (room, shared) is bound: an owner's plain hand-off has none, and a bound id that names no row made the
    // work check refuse a partitioned teammate's turn (shared-bots-socket.test.ts R3c C2/A2 delegator, partitioned=true)
    expect(source).toContain("else if (opts?.delegationRun && handoffRequest(database(), opts.delegationRun.id)) turnRequestByGeneration.set(dispatchClaimId, opts.delegationRun.id);");
    expect(source).not.toContain("else if (opts?.delegationRun) turnRequestByGeneration.set(");
    const fn = source.slice(source.indexOf("function interruptRequestTurns("), source.indexOf("function dropDelegationsOf("));
    expect(fn).toContain("if (!generation || turnRequestByGeneration.get(generation) !== request.id) continue;");
    expect(fn).not.toContain("ownSetup");
    expect(fn.indexOf("cancelDirectTurnDispatch(bot.id, threadId")).toBeGreaterThan(0);
    expect(fn.indexOf("cancelDirectTurnDispatch(bot.id, threadId")).toBeLessThan(fn.indexOf(".adapter.interruptTurn(threadId)"));
  });
  it("a room setup that is still queued behind the room reads its own row first (the setup steps after it: cancel-tree-104-setup-row-api.test.ts)", () => {
    expect(source).toContain('return isTerminalRoomRequestState(roomRequest(database(), requestId)?.state ?? "cancelled");');
    const start = source.slice(source.indexOf("function startRoomRequestTurn("), source.indexOf("const writerRootClaims = new WriterRootClaims();"));
    expect(start).toContain("const setupCancelled = () => operation.cancelled || roomSetupRowEnded(request.id);");
    expect(start).toContain("if (setupCancelled()) return;");
  });
  it("the refused hand-over takes the quiet cancelled path at both hand-over sites", () => {
    expect(source.match(/DELEGATION_REQUEST_ENDED \? new DirectTurnSetupCancelled\(/g)?.length).toBe(1);
    expect(source).toContain("if (code === DELEGATION_REQUEST_ENDED) throw new DirectTurnSetupCancelled(\"turn stopped before dispatch: the request that asked ended\");");
    expect(source).toContain("if (code === DELEGATION_NOT_STARTABLE) throw new DirectTurnSetupCancelled(\"turn stopped before dispatch: the handoff is not startable\");");
  });
});
