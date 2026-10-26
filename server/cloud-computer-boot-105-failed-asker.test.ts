// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLOUD-COMPUTER-BOOT-105 (Grok r1 Medium, follow-up): H1 closes a handed-over or held hand-off as cancelled only when the request that asked was
// CANCELLED: its own state, or an asker above it. An asker above it that FAILED is not a cancel. Before this, requestEndedForHandoff used askerEnded,
// which also counts a failed asker, so such a hand-off was receipted cancelled at boot (and completeRequest cancelled its subtree) instead of the
// restart path that tells the asker what happened.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { _resetPending, findDelegationReceipt, handoffClosingLineId, onDelegationReceipt, queueDelegation, requestEndedForHandoff, settleStartedDelegations } from "./delegations.ts";
import { configureHandoffDispatch, dispatchHandoff, type HandoffTurnOptions } from "./handoff-dispatch.ts";
import { storedMessage } from "./message-db.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { cancelRoomRequest, completeRequest, isTerminalRoomRequestState, roomRequest } from "./room-requests.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { fakeHost, heldNotices, rememberRun, writePrompt } from "./testing/handoff-turn.ts";
import { ownerWorld, type OwnerWorld } from "./testing/handoff-worlds.ts";

const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); heldNotices.splice(0); };
/** Every receipt the settle delivered (Astra r1 Medium): the request is ended by it, as the server's listener does (index.ts onDelegationReceipt). */
const receipts: Array<{ id: string; status: string }> = [];
beforeEach(() => {
  fresh();
  receipts.splice(0);
  onDelegationReceipt((receipt) => {
    receipts.push({ id: receipt.id, status: receipt.status });
    const row = roomRequest(database(), receipt.id);
    if (row && !isTerminalRoomRequestState(row.state)) completeRequest(database(), row.id, { state: receipt.status === "done" ? "done" : receipt.status === "cancelled" ? "cancelled" : "failed", now: Date.now() });
  });
});
afterEach(() => { onDelegationReceipt(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

const pendingRow = (id: string) => database().prepare("SELECT phase, accepted_turn_id FROM pending_delegations WHERE id=?").get(id) as
  { phase: string; accepted_turn_id: string | null } | undefined;
/** The asker above the hand-off's request ends as `failed` (its own turn failed), with its open asks still open. */
const failAsker = () => {
  expect(Number(database().prepare("UPDATE room_requests SET state='failed' WHERE id='root'").run().changes)).toBe(1);
};
const cancelAsker = () => {
  database().prepare("UPDATE room_requests SET state='waiting_bot' WHERE id='root'").run();
  expect(cancelRoomRequest(database(), "root", { now: Date.now() })).not.toBeNull();
};
/** A hand-off the cloud computer took (submitted, then accepted), then the process died. */
async function handedOver(w: OwnerWorld): Promise<string> {
  configureHandoffDispatch({
    ...fakeHost(w.bus, () => {}, { stamp: false }),
    startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => {
      rememberRun(turn.delegationRun);
      writePrompt(w.bus, turn.delegationRun, turn.threadId, text);
      turn.delegationRun.submitted();
      turn.delegationRun.accepted("cloud:1");
    },
  }, { bus: w.bus, approvalBus: w.approvalBus });
  const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "find the number", depth: 0 }, 2).id!;
  await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
  expect(pendingRow(id)).toMatchObject({ phase: "started", accepted_turn_id: "cloud:1" });
  return id;
}

describe("H1 closes a hand-off only for a cancel, never for an asker that failed", () => {
  it("a room ask under a failed asker has not ended for the hand-off; under a cancelled asker it has", async () => {
    const w = ownerWorld("room");
    const id = await handedOver(w);
    failAsker();
    expect(requestEndedForHandoff(roomRequest(database(), id)!)).toBe(false);
    cancelAsker();
    expect(requestEndedForHandoff(roomRequest(database(), id)!)).toBe(true);
  });

  it("at boot, an accepted hand-off under a failed asker takes the restart path: no cancelled receipt, no closing line, its request not cancelled", async () => {
    const w = ownerWorld("room");
    const id = await handedOver(w);
    failAsker();
    await settleStartedDelegations({ store: w.store });
    expect(findDelegationReceipt(id)?.status).toBe("failed");
    expect(findDelegationReceipt(id)?.result).toBe("interrupted by a restart");
    expect(storedMessage(w.from.threadId, handoffClosingLineId(id))).toBeFalsy();
    // the receipt reached the listener and ended the request as failed (not merely "not cancelled" while it still runs), and the row is gone
    expect(receipts).toEqual([{ id, status: "failed" }]);
    expect(roomRequest(database(), id)!.state).toBe("failed");
    expect(pendingRow(id)).toBeUndefined();
    await settleStartedDelegations({ store: w.store });                                // a second boot settles nothing again
    expect(receipts).toHaveLength(1);
    expect(roomRequest(database(), id)!.state).toBe("failed");
  });
});
