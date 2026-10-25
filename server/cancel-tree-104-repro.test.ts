// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CANCEL-TREE-104 measurement (CANCEL-TREE-DESIGN-OPUS.md section 10): the three user harms and Astra's cases, written against the 1.0.4
// base (F3 merged) BEFORE any product change, to learn which still fail. "Cannot start" is measured where every start site is decided:
// a row starts only through a `state='queued'` flip (markRequestDispatched, applyCardRunDispatched) or, for an ask created running, through
// insertRoomRequest, whose F3 fence and the start guards (index.ts closeFencedQueuedRequest, roomAskRefused) all read cancelledAncestorOrSelf.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import {
  askerEnded,
  cancelRoomRequest,
  cancelledAncestorOrSelf,
  closeQueuedIfAskerEnded,
  finishRequestTurn,
  insertRoomRequest,
  markRequestDispatched,
  roomRequest,
  roomRequestByKey,
  type RoomRequest,
  type RoomRequestLineage,
} from "./room-requests.ts";

let db: DatabaseSync;
const lineage: RoomRequestLineage = { rootThreadId: "room-t", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
const root = (now = 1000) => insertRoomRequest(db, {
  groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: `owner_send:g1:s-${now}`, lineage, payloadText: "hello", now,
}).request;
const turn = (parentId: string, botId: string, key: string, now = 1100) => {
  const q = insertRoomRequest(db, { groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: botId, targetThreadId: "room-t", parentId, admissionKey: key, now, priority: "coordinator" }).request;
  markRequestDispatched(db, q.id, { now: now + 10 });
  return roomRequest(db, q.id)!;
};
const ask = (parentId: string, from: string, to: string, key: string, now = 1200, run = true) => {
  const q = insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", fromBotId: from, toBotId: to, parentId, admissionKey: key, now,
    payloadText: "can you check?", returnThreadId: "room-t", returnBotId: from, targetThreadId: `desk-${to}` }).request;
  if (run) markRequestDispatched(db, q.id, { now: now + 1 });
  return roomRequest(db, q.id)!;
};
const card = (parentId: string, key: string, now = 1200, run = true) => {
  const q = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: `w-${key}`, parentId, admissionKey: key, now,
    returnBotId: "lead", returnThreadId: "room-t", targetThreadId: `desk-${key}` }).request;
  if (run) markRequestDispatched(db, q.id, { now: now + 1 });
  return roomRequest(db, q.id)!;
};
const state = (q: RoomRequest) => roomRequest(db, q.id)!.state;
/** Would any start site start this row now? Only a queued row can be flipped; the flip is the start. */
const starts = (q: RoomRequest, now = 9000) => markRequestDispatched(db, q.id, { now });
const ids = (rows: RoomRequest[] | undefined) => (rows ?? []).map((q) => q.id).sort();

/** P (a room turn) waiting on one ask that has answered: its continuation `wake:<P>` is queued. */
function waitingWithContinuation(tag: string) {
  const r = root();
  const p = turn(r.id, "lead", `room_turn:${tag}`);
  const q = ask(p.id, "lead", "bea", `ask:${tag}`);
  expect(finishRequestTurn(db, p.id, { ok: true, now: 1300 }).request.state).toBe("waiting_bot");
  const w = finishRequestTurn(db, q.id, { ok: true, now: 1400 }).wakes[0];
  expect(w.admissionKey).toBe(`wake:${p.id}`);
  return { r, p, q, w };
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
});

describe("(a) cancelling a waiting_bot request whose wake:<parent> continuation is queued or running", () => {
  it("a1 queued continuation: cancelled with the request, never starts", () => {
    const { p, w } = waitingWithContinuation("a1");
    cancelRoomRequest(db, p.id, { now: 1500 });
    expect(state(w)).toBe("cancelled");
    expect(starts(w)).toBe(false);
  });
  it("a2 running continuation: cancelled and returned for interruption; its late ask is refused", () => {
    const { p, w } = waitingWithContinuation("a2");
    expect(starts(w, 1450)).toBe(true);
    const out = cancelRoomRequest(db, p.id, { now: 1500 });
    expect(state(w)).toBe("cancelled");
    expect(ids(out?.interrupt)).toContain(w.id);
    expect(() => ask(w.id, "lead", "moss", "ask:a2-late", 1600, false)).toThrow(/has ended/);
  });
});

describe("(b) a nested ask two levels down under a cancelled request", () => {
  it("b1 E -> ask A1 (waiting) -> ask A2 (queued): cancel E, A2 never starts; a late ask under A1 is refused", () => {
    const r = root();
    const e = turn(r.id, "lead", "room_turn:b1");
    const a1 = ask(e.id, "lead", "bea", "ask:b1-a1");
    finishRequestTurn(db, e.id, { ok: true, now: 1300 });
    const a2 = ask(a1.id, "bea", "cal", "ask:b1-a2", 1310, false);
    expect(finishRequestTurn(db, a1.id, { ok: true, now: 1320 }).request.state).toBe("waiting_bot");
    cancelRoomRequest(db, e.id, { now: 1400 });
    expect([state(a1), state(a2)]).toEqual(["cancelled", "cancelled"]);
    expect(starts(a2)).toBe(false);
    expect(() => ask(a1.id, "bea", "dan", "ask:b1-late", 1500, false)).toThrow(/has ended/);
  });
  it("b2 E waiting -> its continuation W (waiting on its own ask X, queued): cancel E, X never starts", () => {
    const { p, w } = waitingWithContinuation("b2");
    starts(w, 1450);
    const x = ask(w.id, "lead", "cal", "ask:b2-x", 1460, false);
    expect(finishRequestTurn(db, w.id, { ok: true, now: 1470 }).request.state).toBe("waiting_bot");
    cancelRoomRequest(db, p.id, { now: 1500 });
    expect([state(w), state(x)]).toEqual(["cancelled", "cancelled"]);
    expect(starts(x)).toBe(false);
  });
});

describe("(c) a FAILED or Stopped turn's queued asks (failed, not cancelled)", () => {
  it("c1 failed turn with a queued ask: the ask never starts", () => {
    const r = root();
    const t = turn(r.id, "lead", "room_turn:c1");
    const q = ask(t.id, "lead", "moss", "ask:c1", 1200, false);
    expect(finishRequestTurn(db, t.id, { ok: false, now: 1300 }).request.state).toBe("failed");
    expect(state(q)).toBe("cancelled");
    expect(starts(q)).toBe(false);
  });
  it("c2 failed turn with an ask two levels down: neither starts", () => {
    const r = root();
    const t = turn(r.id, "lead", "room_turn:c2");
    const a1 = ask(t.id, "lead", "bea", "ask:c2-a1");
    const a2 = ask(a1.id, "bea", "cal", "ask:c2-a2", 1210, false);
    finishRequestTurn(db, t.id, { ok: false, now: 1300 });
    expect([state(a1), state(a2)]).toEqual(["cancelled", "cancelled"]);
    expect(starts(a2)).toBe(false);
  });
  it("c3 Stop of a running continuation (its turn ends not-ok): its queued ask never starts and the waiting parent fails", () => {
    const { p, w } = waitingWithContinuation("c3");
    starts(w, 1450);
    const x = ask(w.id, "lead", "cal", "ask:c3-x", 1460, false);
    finishRequestTurn(db, w.id, { ok: false, now: 1500 });
    expect([state(w), state(x), state(p)]).toEqual(["failed", "cancelled", "failed"]);
    expect(starts(x)).toBe(false);
  });
  it("c4 a late ask created under the failed request itself is refused, like one under a cancelled request", () => {
    const r = root();
    const t = turn(r.id, "lead", "room_turn:c4");
    finishRequestTurn(db, t.id, { ok: false, now: 1300 });
    expect(state(t)).toBe("failed");
    // the sync-ask fence (roomAskRefused) and the insert fence both read this predicate
    expect(cancelledAncestorOrSelf(db, t.id)).toBe(true);
    expect(() => ask(t.id, "lead", "moss", "ask:c4-late", 1400, false)).toThrow(/has ended/);
  });
});

describe("(c, upgrade) rows a 1.0.3 failed or cancelled turn left queued, met first at a 1.0.4 start", () => {
  // the start guard every dispatcher runs (closeQueuedIfAskerEnded) decides with this predicate
  const guardFences = (q: RoomRequest) => askerEnded(db, roomRequest(db, q.id)!);
  it("c5 a queued ask under a FAILED turn (1.0.3 data): the start guard fences it", () => {
    const r = root();
    const t = turn(r.id, "lead", "room_turn:c5");
    const q = ask(t.id, "lead", "moss", "ask:c5", 1200, false);
    db.prepare("UPDATE room_requests SET state='failed', finished_at=1300 WHERE id=?").run(t.id);
    expect(guardFences(q)).toBe(true);
  });
  it("c6 guard: a queued continuation under a CANCELLED parent (1.0.3 data): the start guard fences it", () => {
    const { p, w } = waitingWithContinuation("c6");
    db.prepare("UPDATE room_requests SET state='cancelled', finished_at=1500 WHERE id=?").run(p.id);
    expect(guardFences(w)).toBe(true);
  });
});

describe("(d) a wake that absorbed other requests' results under a cancelled parent: the outside results reach their bot, the cancelled asker's do not", () => {
  it("d1 a card's return result for the lead, arriving while the lead waits on its continuation: still delivered after the lead's request is cancelled", () => {
    const r = root();
    const q0 = turn(r.id, "lead", "room_turn:d1-earlier", 1050);
    const c = card(q0.id, "d1-card", 1060);
    finishRequestTurn(db, q0.id, { ok: true, now: 1070 });
    const { p, w } = waitingWithContinuation("d1");
    const ret = finishRequestTurn(db, c.id, { ok: true, now: 1450 }).wakes[0];
    expect(ret?.admissionKey).toBe(`wake:${c.id}`);
    cancelRoomRequest(db, p.id, { now: 1500 });
    expect(state(w)).toBe("cancelled");
    expect(state(ret)).toBe("queued");
    expect(cancelledAncestorOrSelf(db, ret.parentId)).toBe(false);
    expect(starts(ret)).toBe(true);
  });
  it("d2 upgrade data (1.0.3 left the continuation queued under its cancelled parent) that then absorbed a card result: fenced, the card's result kept, the asker's answers end with it", () => {
    const { p, q, w } = waitingWithContinuation("d2");
    db.prepare("UPDATE room_requests SET state='cancelled', finished_at=1500 WHERE id=?").run(p.id);
    // a card of another turn finishes once P is cancelled: P no longer waits, so its result joins P's queued continuation (insertWake absorb)
    const q0 = turn(root(1600).id, "lead", "room_turn:d2-other", 1650);
    const c = card(q0.id, "d2-card", 1660);
    expect(finishRequestTurn(db, c.id, { ok: true, now: 1700 }).wakes).toEqual([]);
    expect(JSON.parse(roomRequest(db, w.id)!.payloadText!).map((r: { requestId: string }) => r.requestId).sort()).toEqual([c.id, q.id].sort());
    expect(askerEnded(db, roomRequest(db, w.id)!)).toBe(true);
    const closed = closeQueuedIfAskerEnded(db, w.id, 1800);
    expect(closed?.request.state).toBe("cancelled");
    expect(JSON.parse(roomRequest(db, w.id)!.payloadText!).map((r: { requestId: string }) => r.requestId)).toEqual([q.id]);   // the cancelled asker's answer ends with it
    const kept = roomRequestByKey(db, `wake:kept:${w.id}`)!;
    expect(kept).toMatchObject({ parentId: c.id, toBotId: "lead", state: "queued" });
    expect(JSON.parse(kept.payloadText!).map((r: { requestId: string }) => r.requestId)).toEqual([c.id]);
    expect(ids(closed?.wakes)).toEqual([kept.id]);
    expect(starts(kept)).toBe(true);
  });
});

describe("(e) a chain deeper than 50 hops must not start", () => {
  /** E waiting -> W1 (wake:E) waiting on x1 -> W2 (wake:W1) ... -> Wn queued. */
  function wakeChain(n: number) {
    const { r, p: e, w: w1 } = waitingWithContinuation("e");
    let w = w1;
    const chain = [w1];
    for (let i = 1; i < n; i++) {
      starts(w, 2000 + i * 10);
      const x = ask(w.id, "lead", "bea", `ask:e-x${i}`, 2001 + i * 10);
      expect(finishRequestTurn(db, w.id, { ok: true, now: 2002 + i * 10 }).request.state).toBe("waiting_bot");
      w = finishRequestTurn(db, x.id, { ok: true, now: 2003 + i * 10 }).wakes[0];
      chain.push(w);
    }
    return { r, e, chain, last: w };
  }
  it("e1 cancel E over a 55-deep continuation chain: the queued W55 never starts", () => {
    const { e, last, chain } = wakeChain(55);
    expect(chain).toHaveLength(55);
    cancelRoomRequest(db, e.id, { now: 5000 });
    expect(state(last)).toBe("cancelled");
    expect(starts(last)).toBe(false);
  });
  it("e3 a loop in the parent links (corrupt rows) is fail-closed: treated as ended", () => {
    const { p, w } = waitingWithContinuation("e3");
    db.prepare("UPDATE room_requests SET parent_id=? WHERE id=?").run(w.id, p.id);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(cancelledAncestorOrSelf(db, w.parentId)).toBe(true);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
  it("e2 upgrade data (1.0.3 cancelled E and left the 55-deep chain open): an ask under W55 is refused and W55 is fenced", () => {
    const { e, last } = wakeChain(55);
    db.prepare("UPDATE room_requests SET state='cancelled', finished_at=5000 WHERE id=?").run(e.id);
    expect(cancelledAncestorOrSelf(db, last.parentId)).toBe(true);
    expect(askerEnded(db, roomRequest(db, last.id)!)).toBe(true);
    starts(last, 5100);
    expect(() => ask(last.id, "lead", "moss", "ask:e2-late", 5200, false)).toThrow(/has ended/);
  });
});

describe("(f) a legitimate return wake under a terminal parent still runs", () => {
  for (const ending of ["failed", "cancelled"] as const) {
    it(`f1 a card run that ${ending} itself: its return wake to the lead is queued and starts`, () => {
      const r = root();
      const t = turn(r.id, "lead", "room_turn:f1");
      finishRequestTurn(db, t.id, { ok: true, now: 1150 });
      const run = card(t.id, `f1-${ending}`, 1200, ending === "failed");
      if (ending === "failed") finishRequestTurn(db, run.id, { ok: false, now: 1300 });
      else cancelRoomRequest(db, run.id, { now: 1300, note: "cancelled by you" });
      expect(state(run)).toBe(ending);
      const ret = roomRequestByKey(db, `wake:${run.id}`)!;
      expect(ret.toBotId).toBe("lead");
      expect(starts(ret)).toBe(true);
    });
  }
  it("f2 the :return form (the card run had asked a teammate) under a failed run still starts", () => {
    const r = root();
    const t = turn(r.id, "lead", "room_turn:f2");
    finishRequestTurn(db, t.id, { ok: true, now: 1150 });
    const run = card(t.id, "f2");
    const x = ask(run.id, "w-f2", "bea", "ask:f2-x", 1210);
    finishRequestTurn(db, run.id, { ok: true, now: 1220 });
    const cw = finishRequestTurn(db, x.id, { ok: true, now: 1230 }).wakes[0];
    expect(cw.admissionKey).toBe(`wake:${run.id}`);
    starts(cw, 1240);
    finishRequestTurn(db, cw.id, { ok: false, now: 1250 });
    expect(state(run)).toBe("failed");
    const ret = roomRequestByKey(db, `wake:${run.id}:return`)!;
    expect(ret.toBotId).toBe("lead");
    expect(starts(ret)).toBe(true);
  });
  it("f3 (F3 kept, ruling 2026-10-22) a finished card's queued return wake to the lead, when the owner cancels the lead's waiting request above it: the wake is cancelled, the card's result stays", () => {
    const r = root();
    const p = turn(r.id, "lead", "room_turn:f3");
    const q = ask(p.id, "lead", "bea", "ask:f3");
    const run = card(p.id, "f3", 1210);
    finishRequestTurn(db, p.id, { ok: true, now: 1300 });
    expect(state(p)).toBe("waiting_bot");
    const ret = finishRequestTurn(db, run.id, { ok: true, now: 1310, resultMessageId: "card-result" }).wakes[0];
    expect(ret.admissionKey).toBe(`wake:${run.id}`);
    cancelRoomRequest(db, p.id, { now: 1400 });
    expect(state(q)).toBe("cancelled");
    expect(state(ret)).toBe("cancelled");
    expect(starts(ret)).toBe(false);
    expect(roomRequest(db, run.id)).toMatchObject({ state: "done", resultMessageId: "card-result" });
  });
});

describe("(h1) Astra H1: a same-bot return wake is not a continuation", () => {
  it("the lead reviews a card it is also the return bot for; the review fails: the lead's turn on that return wake can still ask", () => {
    const r = root();
    const t = turn(r.id, "lead", "room_turn:h1");
    finishRequestTurn(db, t.id, { ok: true, now: 1150 });
    const review = insertRoomRequest(db, { groupId: "g1", verb: "review", fromKind: "bot", fromBotId: "lead", toBotId: "lead", parentId: t.id, admissionKey: "review:h1",
      returnBotId: "lead", returnThreadId: "room-t", targetThreadId: "desk-lead", now: 1200 }).request;
    starts(review, 1201);
    finishRequestTurn(db, review.id, { ok: false, now: 1300 });
    expect(state(review)).toBe("failed");
    const ret = roomRequestByKey(db, `wake:${review.id}`)!;
    expect(ret).toMatchObject({ toBotId: "lead", parentId: review.id });
    expect(askerEnded(db, ret)).toBe(false);
    expect(starts(ret, 1400)).toBe(true);
    expect(cancelledAncestorOrSelf(db, ret.id)).toBe(false);
    expect(ask(ret.id, "lead", "moss", "ask:h1-after", 1500, false).state).toBe("queued");
  });
});

describe("(h2) Astra r4: an ordinary return wake shares the wake:<id> key but is not a continuation", () => {
  it("h2 the owner cancels card A's queued return wake after it absorbed child card B's result: B's result is kept for the lead, A's ends", () => {
    const q0 = turn(root().id, "lead", "room_turn:h2", 1100);
    const a = card(q0.id, "h2-a", 1200);
    const b = card(a.id, "h2-b", 1250);
    const ret = finishRequestTurn(db, a.id, { ok: true, now: 1300 }).wakes[0];
    expect(ret).toMatchObject({ admissionKey: `wake:${a.id}`, parentId: a.id, toBotId: "lead", state: "queued" });
    expect(finishRequestTurn(db, b.id, { ok: true, now: 1400 }).wakes).toEqual([]);   // B's result joined A's queued return wake
    expect(JSON.parse(roomRequest(db, ret.id)!.payloadText!).map((r: { requestId: string }) => r.requestId).sort()).toEqual([a.id, b.id].sort());
    const out = cancelRoomRequest(db, ret.id, { now: 1500 });
    expect(state(ret)).toBe("cancelled");
    expect(JSON.parse(roomRequest(db, ret.id)!.payloadText!).map((r: { requestId: string }) => r.requestId)).toEqual([a.id]);
    const kept = roomRequestByKey(db, `wake:kept:${ret.id}`)!;
    expect(kept).toMatchObject({ toBotId: "lead", state: "queued" });
    expect(JSON.parse(kept.payloadText!).map((r: { requestId: string }) => r.requestId)).toEqual([b.id]);
    expect(out).toBeTruthy();
    expect(starts(kept)).toBe(true);
  });
});
