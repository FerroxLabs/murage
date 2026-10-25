// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CANCEL-TREE-104 R5 (lanes/release104/designs/CANCEL-TREE-104.md): a wake under cancelled work can carry a result that belongs to other work (a return wake
// absorbs every result for the same bot and thread that arrives while it is queued). The cancel ends the wake with its own results; what belongs outside the
// cancelled work is re-queued under `wake:kept:<wake>` and reaches its bot.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import {
  askerEnded, cancelRoomRequest, completeRequest, continuationResults, finishRequestTurn, insertRoomRequest, markRequestDispatched, roomRequest, roomRequestByKey,
  type RoomRequest, type RoomRequestLineage,
} from "./room-requests.ts";

let db: DatabaseSync;
const lineage: RoomRequestLineage = { rootThreadId: "room-t", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
const root = (now: number) => insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: `owner_send:g1:s-${now}`, lineage, payloadText: "hello", now }).request;
const turn = (parentId: string, key: string, now: number) => {
  const q = insertRoomRequest(db, { groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: "lead", targetThreadId: "room-t", parentId, admissionKey: key, now, priority: "coordinator" }).request;
  markRequestDispatched(db, q.id, { now: now + 1 });
  return roomRequest(db, q.id)!;
};
const ask = (parentId: string, key: string, now: number) => {
  const q = insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", fromBotId: "lead", toBotId: "bea", parentId, admissionKey: key, now, payloadText: "can you check?", returnThreadId: "room-t", returnBotId: "lead", targetThreadId: "desk-bea" }).request;
  markRequestDispatched(db, q.id, { now: now + 1 });
  return roomRequest(db, q.id)!;
};
/** A card the lead handed out: its result comes back to the lead in the room. */
const card = (parentId: string, key: string, now: number) => {
  const q = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: `w-${key}`, parentId, admissionKey: key, now, returnBotId: "lead", returnThreadId: "room-t", targetThreadId: `desk-${key}` }).request;
  markRequestDispatched(db, q.id, { now: now + 1 });
  return roomRequest(db, q.id)!;
};
const state = (q: RoomRequest) => roomRequest(db, q.id)!.state;
const ids = (rows: RoomRequest[] | undefined) => (rows ?? []).map((q) => q.id).sort();
const resultIds = (q: RoomRequest) => continuationResults(roomRequest(db, q.id)!).map((r) => r.requestId).sort();

/** The lead's turn P waits on an ask; its card A is done, so A's return wake W (to the lead, in the room) is queued under A. A card B of another root's
 * turn finishes next: its result for the same bot and thread is absorbed into W (W now carries A's and B's results). */
function mixedReturnWake() {
  const r1 = root(1000);
  const p = turn(r1.id, "room_turn:p", 1100);
  const q = ask(p.id, "ask:q", 1200);
  expect(finishRequestTurn(db, p.id, { ok: true, now: 1300 }).request.state).toBe("waiting_bot");
  const a = card(p.id, "card-a", 1400);
  const w = completeRequest(db, a.id, { state: "done", now: 1500, resultMessageId: "ra" }).wakes[0]!;
  expect(w).toMatchObject({ verb: "wake", parentId: a.id, toBotId: "lead", targetThreadId: "room-t", admissionKey: `wake:${a.id}`, state: "queued" });
  const r2 = root(2000);
  const p2 = turn(r2.id, "room_turn:p2", 2100);
  const b = card(p2.id, "card-b", 2200);
  expect(completeRequest(db, b.id, { state: "done", now: 2300, resultMessageId: "rb" }).wakes).toEqual([]);   // absorbed into W
  expect(resultIds(w)).toEqual([a.id, b.id].sort());
  return { p, q, a, w, b, p2 };
}

beforeEach(() => { db = new DatabaseSync(":memory:"); initializeProjectTables(db); });

describe("R5: a cancelled subtree's wake keeps the results of other work", () => {
  it("cancel P: W ends with A's result only; B's result is re-queued under wake:kept:<W> with parent B, listed in the completion's wakes, and can start", () => {
    const { p, q, a, w, b, p2 } = mixedReturnWake();
    const cancelled = cancelRoomRequest(db, p.id, { now: 3000 })!;
    expect(ids(cancelled.cancelled)).toEqual(ids([q, w]));
    expect(state(w)).toBe("cancelled");
    expect(resultIds(w)).toEqual([a.id]);
    const kept = roomRequestByKey(db, `wake:kept:${w.id}`)!;
    expect(kept).toMatchObject({ verb: "wake", parentId: b.id, toBotId: "lead", targetThreadId: "room-t", state: "queued" });
    expect(resultIds(kept)).toEqual([b.id]);
    expect(askerEnded(db, kept)).toBe(false);
    expect(markRequestDispatched(db, kept.id, { now: 3100 })).toBe(true);
    expect(state(b)).toBe("done");
    expect(state(p2)).toBe("running");
  });

  it("the completion lists the kept wake so the dispatcher is pumped", () => {
    const { p, w } = mixedReturnWake();
    const ended = completeRequest(db, p.id, { state: "cancelled", now: 3000, outcomeNote: "cancelled" }, {}, { continuation: true });
    expect(ids(ended.wakes)).toEqual([roomRequestByKey(db, `wake:kept:${w.id}`)!.id]);
  });

  it("a running mixed wake: interrupted and cancelled, B's result still re-queued", () => {
    const { p, w, b } = mixedReturnWake();
    expect(markRequestDispatched(db, w.id, { now: 2500 })).toBe(true);
    const cancelled = cancelRoomRequest(db, p.id, { now: 3000 })!;
    expect(ids(cancelled.interrupt)).toContain(w.id);
    expect(state(w)).toBe("cancelled");
    expect(roomRequestByKey(db, `wake:kept:${w.id}`)).toMatchObject({ parentId: b.id, state: "queued" });
  });

  it("root rule: the owner cancels W itself: A's result (its parent's) ends with it, B's absorbed result is kept, A stays done", () => {
    const { a, w, b } = mixedReturnWake();
    const cancelled = cancelRoomRequest(db, w.id, { now: 3000 })!;
    expect(state(w)).toBe("cancelled");
    expect(resultIds(w)).toEqual([a.id]);
    expect(state(a)).toBe("done");
    expect(roomRequestByKey(db, `wake:kept:${w.id}`)).toMatchObject({ parentId: b.id, state: "queued" });
    expect(ids(cancelled.cancelled)).toEqual([]);
  });

  it("a result whose request row is gone has nowhere to go: it ends with the wake, reported", () => {
    const { p, a, w, b } = mixedReturnWake();
    db.prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run(JSON.stringify([...continuationResults(roomRequest(db, w.id)!), { requestId: "ghost", botId: "x", state: "done" }]), w.id);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      cancelRoomRequest(db, p.id, { now: 3000 });
      expect(resultIds(w)).toEqual([a.id, "ghost"].sort());
      expect(roomRequestByKey(db, `wake:kept:${w.id}`)).toMatchObject({ parentId: b.id });
      expect(error).toHaveBeenCalledWith(expect.stringContaining("request is gone"), expect.objectContaining({ wake: w.id, result: "ghost" }));
    } finally { error.mockRestore(); }
  });

  it("a second cancel of a wake with the same id takes the next kept key", () => {
    const { p, w } = mixedReturnWake();
    insertRoomRequest(db, { groupId: "g1", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "room-t", parentId: p.id, admissionKey: `wake:kept:${w.id}`, now: 2600, payloadText: "[]", priority: "coordinator" });
    db.prepare("UPDATE room_requests SET state='done', finished_at=2700 WHERE admission_key=?").run(`wake:kept:${w.id}`);
    cancelRoomRequest(db, p.id, { now: 3000 });
    expect(roomRequestByKey(db, `wake:kept:${w.id}:2`)).toMatchObject({ state: "queued" });
  });

  it("guard: a wake carrying only the cancelled work's results is simply cancelled, nothing kept", () => {
    const r1 = root(1000);
    const p = turn(r1.id, "room_turn:p", 1100);
    ask(p.id, "ask:q", 1200);
    expect(finishRequestTurn(db, p.id, { ok: true, now: 1300 }).request.state).toBe("waiting_bot");
    const a = card(p.id, "card-a", 1400);
    const w = completeRequest(db, a.id, { state: "done", now: 1500, resultMessageId: "ra" }).wakes[0]!;
    const cancelled = cancelRoomRequest(db, p.id, { now: 3000 })!;
    expect(ids(cancelled.cancelled)).toContain(w.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE admission_key LIKE 'wake:kept:%'").get()).toMatchObject({ n: 0 });
  });
});
