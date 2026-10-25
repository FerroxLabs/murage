// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F3 (designs/F3.md): a request tree ends once, as a tree, and survives a restart.
// One completion rule in completeRequest (park on done, cancel the subtree otherwise),
// whole-subtree cancel with the interrupt set, the cancelled-ancestor fence on asks and
// continuation wakes only, the crash table C1-C9, and the ordinary room-turn guard.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import * as rr from "./room-requests.ts";
import {
  cancelRoomRequest,
  completeRequest,
  finishRequestTurn,
  insertRoomRequest,
  listRoomRequests,
  markRequestDispatched,
  reconcileRoomRequestsAtBoot,
  recoverCommittedAskResults,
  roomRequest,
  roomRequestByKey,
  type RoomRequest,
  type RoomRequestLineage,
} from "./room-requests.ts";

let db: DatabaseSync;
const lineage: RoomRequestLineage = { rootThreadId: "room-t", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
const root = (now = 1000, notOwner = false) => insertRoomRequest(db, {
  groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: `owner_send:g1:s-${now}`, lineage: { ...lineage, notOwnerAudience: notOwner }, payloadText: "hello", now,
}).request;
const turn = (parentId: string, botId: string, key: string, now = 1100) => {
  const q = insertRoomRequest(db, { groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: botId, targetThreadId: "room-t", parentId, admissionKey: key, now, priority: "coordinator" }).request;
  markRequestDispatched(db, q.id, { now: now + 10 });
  return roomRequest(db, q.id)!;
};
/** An ask (a hand-off) from `from` to `to`, running in `to`'s own thread. */
const ask = (parentId: string, from: string, to: string, key: string, now = 1200, run = true) => {
  const q = insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", fromBotId: from, toBotId: to, parentId, admissionKey: key, now,
    payloadText: "can you check?", returnThreadId: "room-t", returnBotId: from, targetThreadId: `desk-${to}` }).request;
  if (run) markRequestDispatched(db, q.id, { now: now + 1 });
  return roomRequest(db, q.id)!;
};
/** A card run (an `assign`) the lead's turn created: it inherits that turn as parent (project-envelope.ts) but nothing waits on it there. */
const card = (parentId: string, key: string, now = 1200, run = true) => {
  const q = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: `w-${key}`, parentId, admissionKey: key, now,
    returnBotId: "lead", returnThreadId: "room-t", targetThreadId: `desk-${key}` }).request;
  if (run) markRequestDispatched(db, q.id, { now: now + 1 });
  return roomRequest(db, q.id)!;
};
const state = (q: RoomRequest) => roomRequest(db, q.id)!.state;
const ids = (rows: RoomRequest[] | undefined) => (rows ?? []).map((q) => q.id).sort();

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
});

/** A -> B -> C -> D: A a room turn waiting on its hand-off B, which asked C, which asked D; all three running. */
function chain() {
  const r = root();
  const a = turn(r.id, "lead", "room_turn:a");
  const b = ask(a.id, "lead", "bea", "ask:b", 1200);
  const c = ask(b.id, "bea", "cal", "ask:c", 1210);
  const d = ask(c.id, "cal", "dan", "ask:d", 1220);
  expect(finishRequestTurn(db, a.id, { ok: true, now: 1300 }).request.state).toBe("waiting_bot");
  return { r, a, b, c, d };
}

describe("F3 test 1 / failure 'orphaned turn': cancel walks the whole subtree", () => {
  it("A->B->C->D, cancel at A: every descendant cancelled, every running one in interrupt", () => {
    const { a, b, c, d } = chain();
    const cancelled = cancelRoomRequest(db, a.id, { now: 1400 }) as unknown as { request?: RoomRequest; interrupt?: RoomRequest[]; runningChildren?: RoomRequest[] };
    expect(state(a)).toBe("cancelled");
    expect([state(b), state(c), state(d)]).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(ids(cancelled.interrupt)).toEqual(ids([b, c, d]));
    expect(roomRequest(db, d.id)!.outcomeNote).toBe("cancelled with the request that asked");
  });

  it("B ends not-ok with C open: C cancelled and C's running child returned for interruption", () => {
    const { b, c, d } = chain();
    const failed = completeRequest(db, b.id, { state: "failed", now: 1400 });
    expect([state(c), state(d)]).toEqual(["cancelled", "cancelled"]);
    expect(ids(failed.interrupt)).toEqual(ids([c, d]));
  });

  it("boot sweep marks B unknown with C queued: C cancelled", () => {
    const r = root();
    const a = turn(r.id, "lead", "room_turn:boot");
    const b = ask(a.id, "lead", "bea", "ask:boot-b");
    const c = ask(b.id, "bea", "cal", "ask:boot-c", 1210, false);
    finishRequestTurn(db, a.id, { ok: true, now: 1250 });
    reconcileRoomRequestsAtBoot(db, 5000);
    expect(state(b)).toBe("unknown");
    expect(state(c)).toBe("cancelled");
    expect(roomRequestByKey(db, `wake:${a.id}`)?.state).toBe("queued");
  });

  it("a queued return wake under a finished intermediate is found by the walk", () => {
    const r = root();
    const a = turn(r.id, "lead", "room_turn:ret");
    expect(finishRequestTurn(db, a.id, { ok: true, now: 1150 }).request.state).toBe("done");
    // a card run under the finished lead turn, finished, whose return wake is queued
    const card = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: "jax", parentId: a.id, admissionKey: "assign:ret",
      returnBotId: "lead", returnThreadId: "room-t", targetThreadId: "desk-jax", now: 1160 }).request;
    markRequestDispatched(db, card.id, { now: 1161 });
    const wake = finishRequestTurn(db, card.id, { ok: true, now: 1170 }).wakes[0];
    expect(wake.state).toBe("queued");
    // the owner's root over all of it is cancelled while still open: put it back to queued to model a cancel of an open ancestor
    db.prepare("UPDATE room_requests SET state='queued', finished_at=NULL WHERE id=?").run(r.id);
    cancelRoomRequest(db, r.id, { now: 1200 });
    expect(state(wake)).toBe("cancelled");
  });
});

describe("F3 test 2 / failure 'early completion': a parent is not terminal while an ask is open", () => {
  it("finalizer or sync close: completeRequest(B, done) with C open parks B", () => {
    const { b, c } = chain();
    const ended = completeRequest(db, b.id, { state: "done", now: 1400, resultMessageId: "m-b" });
    expect(ended.request.state).toBe("waiting_bot");
    expect(state(b)).toBe("waiting_bot");
    expect(state(c)).toBe("running");
    expect(roomRequest(db, b.id)!.resultMessageId).toBe("m-b");
  });

  it("boot recovery of a committed result with C open parks B", () => {
    const { b } = chain();
    recoverCommittedAskResults(db, 5000, (q) => q.id === b.id ? { messageId: "m-b", ok: true } : null);
    expect(state(b)).toBe("waiting_bot");
  });

  it("C done while B ran, then B's receipt replayed: B parks, ONE wake:<B> with C's result, A woken with B's final answer", () => {
    const r = root();
    const a = turn(r.id, "lead", "room_turn:replay");
    const b = ask(a.id, "lead", "bea", "ask:replay-b");
    const c = ask(b.id, "bea", "cal", "ask:replay-c", 1210);
    expect(finishRequestTurn(db, a.id, { ok: true, now: 1250 }).request.state).toBe("waiting_bot");
    // C finishes while B's turn still runs: nothing yet
    expect(completeRequest(db, c.id, { state: "done", now: 1300, resultMessageId: "m-c" }).wakes).toEqual([]);
    // B's receipt replayed after a restart (the receipt listener completes B done)
    const replayed = completeRequest(db, b.id, { state: "done", now: 2000, resultMessageId: "m-b1" });
    expect(state(b)).toBe("waiting_bot");
    expect(replayed.wakes.map((w) => w.admissionKey)).toEqual([`wake:${b.id}`]);
    expect(JSON.parse(replayed.wakes[0].payloadText!).map((x: { requestId: string }) => x.requestId)).toEqual([c.id]);
    // G: a second completion while the wake is open changes nothing (no second wake)
    expect(completeRequest(db, b.id, { state: "done", now: 2001 }).changed).toBe(false);
    expect(listRoomRequests(db, { groupId: "g1" }).filter((q) => q.admissionKey === `wake:${b.id}`)).toHaveLength(1);
    // the wake's end completes B outright, with its final answer, and wakes A
    const wake = replayed.wakes[0];
    markRequestDispatched(db, wake.id, { now: 2010 });
    const woke = finishRequestTurn(db, wake.id, { ok: true, now: 2100, resultMessageId: "m-b-final" });
    expect(state(b)).toBe("done");
    expect(roomRequest(db, b.id)!.resultMessageId).toBe("m-b-final");
    expect(woke.wakes.map((w) => w.admissionKey)).toEqual([`wake:${a.id}`]);
    expect(JSON.parse(woke.wakes[0].payloadText!)).toEqual([{ requestId: b.id, botId: "bea", state: "done", messageId: "m-b-final" }]);
  });
});

describe("F3 failure 'double completion / cancel racing completion'", () => {
  it("child completes then parent is cancelled: one terminal write each, and the queued wake:<parent> is cancelled", () => {
    const { a, b } = (() => { const r = root(); const a = turn(r.id, "lead", "room_turn:race1"); const b = ask(a.id, "lead", "bea", "ask:race1"); finishRequestTurn(db, a.id, { ok: true, now: 1300 }); return { a, b }; })();
    const done = completeRequest(db, b.id, { state: "done", now: 1400 });
    expect(done.wakes.map((w) => w.admissionKey)).toEqual([`wake:${a.id}`]);
    expect(cancelRoomRequest(db, a.id, { now: 1500 })).toBeTruthy();
    expect(state(b)).toBe("done");
    expect(state(a)).toBe("cancelled");
    expect(roomRequestByKey(db, `wake:${a.id}`)!.state).toBe("cancelled");
  });

  it("parent cancelled then child completes: the child's late completion is a no-op", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:race2"); const b = ask(a.id, "lead", "bea", "ask:race2"); finishRequestTurn(db, a.id, { ok: true, now: 1300 });
    cancelRoomRequest(db, a.id, { now: 1400 });
    const late = completeRequest(db, b.id, { state: "done", now: 1500, resultMessageId: "late" });
    expect(late.changed).toBe(false);
    expect(late.wakes).toEqual([]);
    expect(roomRequest(db, b.id)!.finishedAt).toBe(1400);
  });
});

describe("F3 failure 'renewed work after cancel': the fence", () => {
  it("a late ask under a cancelled parent is refused", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:fence"); ask(a.id, "lead", "bea", "ask:fence-b"); finishRequestTurn(db, a.id, { ok: true, now: 1300 });
    cancelRoomRequest(db, a.id, { now: 1400 });
    expect(() => ask(a.id, "lead", "moss", "ask:late", 1500, false)).toThrow(/has ended/);
  });

  it("a late ask from a running grandchild of a cancelled request is refused", () => {
    const { a, d } = chain();
    cancelRoomRequest(db, a.id, { now: 1400 });
    expect(() => ask(d.id, "dan", "eve", "ask:late-d", 1500, false)).toThrow(/has ended/);
  });

  it("guard: a member room turn under a done owner root, and a return wake under a cancelled card run, are lineage edges", () => {
    const r = root();
    completeRequest(db, r.id, { state: "done", now: 1050 });
    const member = turn(r.id, "moss", "room_turn:after-done");
    expect(member.state).toBe("running");
    const card = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: "jax", parentId: r.id, admissionKey: "assign:fence",
      returnBotId: "lead", returnThreadId: "room-t", targetThreadId: "desk-jax", now: 1100 }).request;
    const cancelled = cancelRoomRequest(db, card.id, { now: 1200, note: "cancelled by you" });
    expect(cancelled).toBeTruthy();
    // the cancelled card is returned to its lead under wake:<card>, never refused by the fence
    expect(roomRequestByKey(db, `wake:${card.id}`)?.toBotId).toBe("lead");
  });
});

describe("F3 failure 'stranded surviving parent'", () => {
  it("cancelling a continuation wake cancels its waiting parent and wakes that parent's own asker", () => {
    const r = root();
    const a = turn(r.id, "lead", "room_turn:strand");
    const b = ask(a.id, "lead", "bea", "ask:strand-b");
    finishRequestTurn(db, a.id, { ok: true, now: 1250 });
    const c = ask(b.id, "bea", "cal", "ask:strand-c", 1260);
    expect(completeRequest(db, b.id, { state: "done", now: 1300 }).request.state).toBe("waiting_bot");
    const wakeB = completeRequest(db, c.id, { state: "done", now: 1400 }).wakes[0];
    expect(wakeB.admissionKey).toBe(`wake:${b.id}`);
    const out = cancelRoomRequest(db, wakeB.id, { now: 1500, note: "cancelled by you" });
    expect(out).toBeTruthy();
    expect(state(b)).toBe("cancelled");
    expect(roomRequestByKey(db, `wake:${a.id}`)?.state).toBe("queued");
  });

  it("a waiting_bot ask cancelled under a waiting asker still wakes that asker", () => {
    const r = root();
    const a = turn(r.id, "lead", "room_turn:strand2");
    const b = ask(a.id, "lead", "bea", "ask:strand2-b");
    finishRequestTurn(db, a.id, { ok: true, now: 1250 });
    ask(b.id, "bea", "cal", "ask:strand2-c", 1260);
    completeRequest(db, b.id, { state: "done", now: 1300 });
    expect(state(b)).toBe("waiting_bot");
    cancelRoomRequest(db, b.id, { now: 1400 });
    expect(roomRequestByKey(db, `wake:${a.id}`)?.state).toBe("queued");
  });
});

describe("F3 failure 'non-owner chain never settles'", () => {
  it("non-owner A waiting on B waiting on C; C ends: B completes, A completes 'answers posted, nobody woken'", () => {
    const r = root(1000, true);
    const a = turn(r.id, "lead", "room_turn:ns");
    const b = ask(a.id, "lead", "bea", "ask:ns-b");
    finishRequestTurn(db, a.id, { ok: true, now: 1250 });
    const c = ask(b.id, "bea", "cal", "ask:ns-c", 1260);
    completeRequest(db, b.id, { state: "done", now: 1300 });
    expect(state(b)).toBe("waiting_bot");
    completeRequest(db, c.id, { state: "done", now: 1400 });
    expect(state(b)).toBe("done");
    expect(state(a)).toBe("done");
    expect(roomRequest(db, a.id)!.outcomeNote).toBe("answers posted, nobody woken");
  });
});

describe("F3 H1: only an explicit cancel takes the cards a lead's turn handed out; a failure or a restart cancels its dependencies alone", () => {
  it("the lead's turn fails: its queued and running cards still run, its ask is cancelled and interrupted", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:h1-fail");
    const queuedCard = card(a.id, "assign:h1-q", 1150, false);
    const runningCard = card(a.id, "assign:h1-r", 1160);
    const b = ask(a.id, "lead", "bea", "ask:h1-b", 1170);
    const failed = finishRequestTurn(db, a.id, { ok: false, now: 1300 });
    expect(state(a)).toBe("failed");
    expect([state(queuedCard), state(runningCard)]).toEqual(["queued", "running"]);
    expect(state(b)).toBe("cancelled");
    expect(ids(failed.cancelled)).toEqual(ids([b]));
    expect(ids(failed.interrupt)).toEqual(ids([b]));
    // nothing fences the cards' own work: a running card may still ask a teammate
    expect(() => ask(runningCard.id, "w-assign:h1-r", "cal", "ask:h1-card-ask", 1400, false)).not.toThrow();
    // and the running card's own end is its own, not a no-op
    expect(finishRequestTurn(db, runningCard.id, { ok: true, now: 1500 }).changed).toBe(true);
  });

  it("a restart during the lead's turn: the queued card survives, the running card ends unknown for Retry (not cancelled with its asker)", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:h1-boot");
    const queuedCard = card(a.id, "assign:h1-bq", 1150, false);
    const runningCard = card(a.id, "assign:h1-br", 1160);
    const b = ask(a.id, "lead", "bea", "ask:h1-bb", 1170, false);
    reconcileRoomRequestsAtBoot(db, 9000);
    expect(state(a)).toBe("unknown");
    expect(state(b)).toBe("cancelled");
    expect(state(queuedCard)).toBe("queued");
    expect(state(runningCard)).toBe("unknown");
    expect(roomRequest(db, runningCard.id)!.outcomeNote).not.toBe(rr.CANCELLED_WITH_ASKER);
  });

  it("an expired lead turn leaves its cards alone", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:h1-exp");
    const queuedCard = card(a.id, "assign:h1-eq", 1150, false);
    const ended = completeRequest(db, a.id, { state: "expired", now: 1300 });
    expect(state(a)).toBe("expired");
    expect(state(queuedCard)).toBe("queued");
    expect(ended.cancelled ?? []).toEqual([]);
  });

  it("guard: an explicit cancel of the waiting lead turn cancels its cards too, and the running one comes back for interruption", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:h1-cancel");
    const queuedCard = card(a.id, "assign:h1-cq", 1150, false);
    const runningCard = card(a.id, "assign:h1-cr", 1160);
    const b = ask(a.id, "lead", "bea", "ask:h1-cb", 1170);
    expect(finishRequestTurn(db, a.id, { ok: true, now: 1300 }).request.state).toBe("waiting_bot");
    const cancelled = cancelRoomRequest(db, a.id, { now: 1400 })!;
    expect([state(queuedCard), state(runningCard), state(b)]).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(roomRequest(db, queuedCard.id)!.outcomeNote).toBe(rr.CANCELLED_WITH_ASKER);
    expect(ids(cancelled.interrupt)).toEqual(ids([runningCard, b]));
  });
});

describe("F3 crash table C1-C9 (each row's committed state is what recovery reads)", () => {
  it("C1/C8: after the cancel tx the subtree is closed; a late completion of a running descendant is a no-op and the fence holds", () => {
    const { a, d } = chain();
    cancelRoomRequest(db, a.id, { now: 1400 });
    // the process died: boot finds nothing running under A
    expect(reconcileRoomRequestsAtBoot(db, 9000).unknown).toBe(0);
    expect(completeRequest(db, d.id, { state: "done", now: 9100 }).changed).toBe(false);
    expect(rr.cancelledAncestorOrSelf(db, d.id)).toBe(true);
  });

  it("C2: interrupt never confirmed: the turn's own end is a no-op, its asks refused", () => {
    const { a, c } = chain();
    cancelRoomRequest(db, a.id, { now: 1400 });
    expect(finishRequestTurn(db, c.id, { ok: true, now: 1500 }).changed).toBe(false);
    expect(() => ask(c.id, "cal", "eve", "ask:c2", 1600, false)).toThrow(/has ended/);
  });

  it("C3/C4: a ticket's paired request survives as running until boot ends it unknown", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:c3"); const b = ask(a.id, "lead", "bea", "ask:c3");
    finishRequestTurn(db, a.id, { ok: true, now: 1300 });
    const boot = reconcileRoomRequestsAtBoot(db, 9000);
    expect(state(b)).toBe("unknown");
    expect(boot.wakes.map((w) => w.admissionKey)).toEqual([`wake:${a.id}`]);
  });

  it("C5: a persisted receipt replayed before the finalizer's commit parks B and queues its wake (rule ii)", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:c5"); const b = ask(a.id, "lead", "bea", "ask:c5-b");
    const c = ask(b.id, "bea", "cal", "ask:c5-c", 1210);
    completeRequest(db, c.id, { state: "done", now: 1300 });
    const replay = completeRequest(db, b.id, { state: "done", now: 9000 });
    expect(state(b)).toBe("waiting_bot");
    expect(replay.wakes).toHaveLength(1);
  });

  it("C6: a child's end commits the terminal state and the wake together; the dispatcher reads the committed queued wake", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:c6"); const b = ask(a.id, "lead", "bea", "ask:c6");
    finishRequestTurn(db, a.id, { ok: true, now: 1300 });
    completeRequest(db, b.id, { state: "done", now: 1400 });
    expect(rr.queuedRoomRequests(db, { groupId: "g1" }).filter((q) => q.verb === "wake").map((q) => q.admissionKey)).toEqual([`wake:${a.id}`]);
  });

  it("C7: an allowance spent with no child row: the boot sweep closes the running asker unknown and its open subtree with it", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:c7"); const b = ask(a.id, "lead", "bea", "ask:c7-b");
    const c = ask(b.id, "bea", "cal", "ask:c7-c", 1210, false);
    const queuedCard = card(a.id, "assign:c7", 1220, false);
    reconcileRoomRequestsAtBoot(db, 9000);
    // A's turn ends unknown and what waits on its answer (its asks, theirs) is cancelled with it; the card it handed out is not a dependency
    expect([state(a), state(b), state(c)]).toEqual(["unknown", "cancelled", "cancelled"]);
    expect(state(queuedCard)).toBe("queued");
  });

  it("C9: the parent's park and its wake commit together; a second completion hits rule (iii)", () => {
    const r = root(); const a = turn(r.id, "lead", "room_turn:c9"); const b = ask(a.id, "lead", "bea", "ask:c9");
    completeRequest(db, b.id, { state: "done", now: 1300 });
    const ended = finishRequestTurn(db, a.id, { ok: true, now: 1400 });
    expect(ended.wakes.map((w) => w.admissionKey)).toEqual([`wake:${a.id}`]);
    expect(completeRequest(db, a.id, { state: "done", now: 1500 }).changed).toBe(false);
    expect(listRoomRequests(db, { groupId: "g1" }).filter((q) => q.admissionKey === `wake:${a.id}`)).toHaveLength(1);
  });
});

describe("guard: ordinary room turns keep their flow", () => {
  it("a member turn under a done owner root with no asks completes done; an inline (delivered) ask owes nothing", () => {
    const r = root();
    completeRequest(db, r.id, { state: "done", now: 1050 });
    const plain = turn(r.id, "lead", "room_turn:plain");
    expect(finishRequestTurn(db, plain.id, { ok: true, now: 1300, resultMessageId: "m1" }).request.state).toBe("done");
    const inline = turn(r.id, "moss", "room_turn:inline");
    const a = ask(inline.id, "moss", "dax", "ask:inline");
    completeRequest(db, a.id, { state: "done", now: 1350, outcomeNote: "delivered" });
    const ended = finishRequestTurn(db, inline.id, { ok: true, now: 1400 });
    expect(ended.request.state).toBe("done");
    expect(ended.wakes).toEqual([]);
  });

  it("a failed member turn with no descendants ends failed with nothing to interrupt", () => {
    const r = root();
    const t = turn(r.id, "lead", "room_turn:fail");
    const ended = finishRequestTurn(db, t.id, { ok: false, now: 1300 });
    expect(ended.request.state).toBe("failed");
    expect(ended.interrupt ?? []).toEqual([]);
  });
});

describe("F3 02-3: the trace is derived from the tree", () => {
  it("guard: an owner root is never the chain root; a member turn is, and each ask under it extends the path", () => {
    const r = root();
    expect(rr.requestTrace(db, r)).toBeNull();
    const lead = turn(r.id, "lead", "room_turn:trace");
    expect(rr.requestTrace(db, lead)).toEqual({ rootId: `req:${lead.id}`, path: ["lead"], commsDepth: 0 });
    const b = ask(lead.id, "lead", "bea", "ask:trace-b");
    const c = ask(b.id, "bea", "cal", "ask:trace-c", 1210);
    expect(rr.requestTrace(db, c)).toEqual({ rootId: `req:${lead.id}`, path: ["lead", "bea", "cal"], commsDepth: 2 });
  });

  it("a continuation wake inherits its asker's trace; a parentless ask derives nothing from the tree", () => {
    const r = root();
    const lead = turn(r.id, "lead", "room_turn:trace2");
    const b = ask(lead.id, "lead", "bea", "ask:trace2-b");
    finishRequestTurn(db, lead.id, { ok: true, now: 1300 });
    const wake = completeRequest(db, b.id, { state: "done", now: 1400 }).wakes[0];
    expect(rr.requestTrace(db, wake)).toEqual({ rootId: `req:${lead.id}`, path: ["lead"], commsDepth: 0 });
    const loose = insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", fromBotId: "x", toBotId: "y", admissionKey: "ask:thread-1:gen-7:abcd", lineage, now: 5 }).request;
    expect(rr.requestTrace(db, loose)).toBeNull();
    expect(rr.askKeyGeneration(loose.admissionKey)).toBe("gen-7");
    expect(rr.askKeyGeneration("ask:delegation:abc")).toBeNull();
  });
});
