// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLOUD-COMPUTER-BOOT-105 H1 (lanes/release105/designs/CLOUD-COMPUTER-BOOT-105.md): a hand-off that was handed over (accepted or submitted) or is held,
// whose request ended, is settled as cancelled: the CANCEL-TREE-104 R6 closing line, the cancelled receipt, the row gone. Never "interrupted by a
// restart", never held for the owner, nobody woken. With no line writer the row is kept (unsettled), never the interrupted or held path.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import * as delegations from "./delegations.ts";
import { _resetPending, findDelegationReceipt, handoffClosingLineId, onDelegationReceipt, queueDelegation, reconcileStartedDelegations, settleStartedDelegations } from "./delegations.ts";
import { configureHandoffDispatch, dispatchHandoff, type HandoffTurnOptions } from "./handoff-dispatch.ts";
import { storedMessage } from "./message-db.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { cancelRoomRequest, completeRequest, isTerminalRoomRequestState, roomRequest } from "./room-requests.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { fakeHost, heldNotices, rememberRun, writePrompt } from "./testing/handoff-turn.ts";
import { ownerWorld, type OwnerWorld } from "./testing/handoff-worlds.ts";

const CLOSING = (target: string) => `Hand-off to @${target} cancelled because the request that asked ended`;
const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); heldNotices.splice(0); };
beforeEach(() => {
  fresh();
  onDelegationReceipt((receipt) => {
    const row = roomRequest(database(), receipt.id);
    // as the server's listener (index.ts onDelegationReceipt): a held hand-off's "failed" receipt ends its own request as failed
    if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: receipt.status === "done" ? "done" : receipt.status === "cancelled" ? "cancelled" : "failed", now: Date.now() });
  });
});
afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

const pendingRow = (id: string) => database().prepare("SELECT phase, started_at, submitted_at, accepted_turn_id FROM pending_delegations WHERE id=?").get(id) as
  { phase: string; started_at: number | null; submitted_at: number | null; accepted_turn_id: string | null } | undefined;
const lineCount = (threadId: string, id: string) => Number((database().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND id=?").get(threadId, id) as { n: number }).n);
const wakesUnder = (parentId: string) => Number((database().prepare("SELECT COUNT(*) AS n FROM room_requests WHERE parent_id=? AND verb='wake'").get(parentId) as { n: number }).n);
const cancelAsker = () => {
  database().prepare("UPDATE room_requests SET state='waiting_bot' WHERE id='root'").run();
  expect(cancelRoomRequest(database(), "root", { now: Date.now() })).not.toBeNull();
};
function expectClosed(w: OwnerWorld, id: string, requestState: "cancelled" | "failed" = "cancelled") {
  const line = storedMessage(w.from.threadId, handoffClosingLineId(id));
  expect(line?.tool?.name).toBe(CLOSING("Helper"));
  expect(line?.requestId).toBe(id);
  expect(lineCount(w.from.threadId, handoffClosingLineId(id))).toBe(1);
  expect(findDelegationReceipt(id)?.status).toBe("cancelled");
  expect(findDelegationReceipt(id)?.result).not.toBe("interrupted by a restart");
  expect(pendingRow(id)).toBeUndefined();
  expect(roomRequest(database(), id)!.state).toBe(requestState);              // a held hand-off's request already ended with its hold
  expect(wakesUnder("root")).toBe(0);
  expect(heldNotices).toEqual([]);
}
/** The provider's side of the start: the test's own steps after the prompt is stamped. */
function attach(w: OwnerWorld, steps: (turn: HandoffTurnOptions) => void | Promise<void>): void {
  configureHandoffDispatch({
    ...fakeHost(w.bus, () => {}, { stamp: false }),
    startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => {
      rememberRun(turn.delegationRun);
      writePrompt(w.bus, turn.delegationRun, turn.threadId, text);
      await steps(turn);
    },
  }, { bus: w.bus, approvalBus: w.approvalBus });
}
const queued = (w: OwnerWorld) => queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "find the number", depth: 0 }, 2).id!;
/** A hand-off the cloud computer took (submitted, then accepted), then the process died. */
async function handedOver(w: OwnerWorld, accepted: boolean): Promise<string> {
  attach(w, (turn) => { turn.delegationRun.submitted(); if (accepted) turn.delegationRun.accepted("cloud:1"); });
  const id = queued(w);
  await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
  expect(pendingRow(id)).toMatchObject({ phase: "started", ...(accepted ? { accepted_turn_id: "cloud:1" } : { accepted_turn_id: null }) });
  expect(pendingRow(id)?.submitted_at).not.toBeNull();
  return id;
}

describe("H1 at boot: the request ended while the provider had the turn (cancel before or during the crash)", () => {
  it("an accepted hand-off is closed as cancelled, not receipted 'interrupted by a restart'", async () => {
    const w = ownerWorld("room");
    const id = await handedOver(w, true);
    cancelAsker();                                                                       // the commit landed; the process died before the effects
    await settleStartedDelegations({ store: w.store });
    expectClosed(w, id);
  });

  it("a submitted-only hand-off (the POST in flight at the crash) is closed as cancelled, not held for the owner", async () => {
    const w = ownerWorld("room");
    const id = await handedOver(w, false);
    cancelAsker();
    await settleStartedDelegations({ store: w.store });
    expectClosed(w, id);
  });

  it("a hand-off already held by an earlier start is closed when its request has since ended", async () => {
    const w = ownerWorld("room");
    const id = await handedOver(w, false);
    reconcileStartedDelegations({ store: w.store });                                    // the first restart: held for the owner
    expect(pendingRow(id)).toMatchObject({ phase: "started", started_at: null });
    heldNotices.splice(0);
    cancelAsker();                                                                       // the owner cancels the asker; then another restart
    await settleStartedDelegations({ store: w.store });
    expectClosed(w, id, "failed");
  });

  it("with no line writer the row is kept as it is: never the interrupted or held path", async () => {
    const w = ownerWorld("room");
    const id = await handedOver(w, true);
    cancelAsker();
    await settleStartedDelegations({});
    expect(pendingRow(id)).toMatchObject({ phase: "started", accepted_turn_id: "cloud:1" });
    expect(findDelegationReceipt(id)).toBeFalsy();
    expect(storedMessage(w.from.threadId, handoffClosingLineId(id))).toBeFalsy();
  });

  it("guard: a request still running keeps today's path (the asker is told the restart interrupted it)", async () => {
    const w = ownerWorld("room");
    const id = await handedOver(w, true);
    await settleStartedDelegations({ store: w.store });
    expect(findDelegationReceipt(id)?.status).toBe("failed");
    expect(findDelegationReceipt(id)?.result).toBe("interrupted by a restart");
    expect(storedMessage(w.from.threadId, handoffClosingLineId(id))).toBeFalsy();
  });
});

describe("H1 guard for held rows", () => {
  it("a held hand-off whose asker is still open stays held for the owner (its own hold ended its request, not a cancel)", async () => {
    const w = ownerWorld("room");
    const id = await handedOver(w, false);
    reconcileStartedDelegations({ store: w.store });
    expect(roomRequest(database(), id)!.state).toBe("failed");
    await settleStartedDelegations({ store: w.store });
    expect(pendingRow(id)).toMatchObject({ phase: "started", started_at: null });
    expect(storedMessage(w.from.threadId, handoffClosingLineId(id))).toBeFalsy();
  });
});

describe("H1 live", () => {
  it("the box took the prompt, then the cancel landed and accepted() was refused: the failed start is closed as cancelled, not held", async () => {
    const w = ownerWorld("room");
    attach(w, (turn) => {
      turn.delegationRun.submitted();
      cancelAsker();
      expect(() => turn.delegationRun.accepted("cloud:1")).toThrow(/request that asked ended/);
      turn.onDispatchError("turn stopped before dispatch: the request that asked ended");
    });
    const id = queued(w);
    await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
    expectClosed(w, id);
  });

  it("the cancel's post-commit closes a held hand-off of the cancelled request (settleHeldOfEndedRequest)", async () => {
    const w = ownerWorld("room");
    const id = await handedOver(w, false);
    reconcileStartedDelegations({ store: w.store });
    heldNotices.splice(0);
    cancelAsker();
    const settleHeld = (delegations as Record<string, unknown>).settleHeldOfEndedRequest as ((id: string, options: { store: unknown }) => boolean) | undefined;
    expect(typeof settleHeld).toBe("function");
    expect(settleHeld!(id, { store: w.store })).toBe(true);
    expectClosed(w, id, "failed");
    expect(storedMessage(w.from.threadId, `held-${id}`)?.delegationHeld).toBeUndefined();
  });
});
