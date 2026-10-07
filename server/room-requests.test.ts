// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-P 3.2, 5.2, 6: durable room requests, lineage, one completion
// primitive with continuation wakes, deadlock walk, root counters, boot and
// restore handling, pruning.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { settleProjectUsage } from "./usage-ledger.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { assignCardReview } from "./project-cards.ts";
import {
  askWouldDeadlock,
  cancelRoomRequest,
  completeRequest,
  conversationCounters,
  expireOverdueRoomRequests,
  finishRequestTurn,
  insertRoomRequest,
  listRoomRequests,
  markRequestDispatched,
  openAskChildren,
  pruneTerminalRoomRequests,
  queuedRoomRequests,
  reconcileRoomRequestsAtBoot,
  recoverCommittedAskResults,
  requestReplyTarget,
  roomRequest,
  rootCounters,
  type RoomRequestLineage,
} from "./room-requests.ts";

const ledgerHooks = { settleUsage: (db: DatabaseSync, request: import("./room-requests.ts").RoomRequest) => {
  settleProjectUsage(db, request, { threadId: request.targetThreadId ?? request.rootThreadId, botId: request.toBotId!, engine: "fake", turnGeneration: request.id, at: request.finishedAt!, ok: true });
} };
let db: DatabaseSync;
const lineage: RoomRequestLineage = { rootThreadId: "room-t", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
const root = (now = 1000) => insertRoomRequest(db, {
  groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: `owner_send:g1:s-${now}`, lineage, payloadText: "hello", sendId: `s-${now}`, now,
}).request;
const turn = (parentId: string, botId: string, key: string, now = 1100) => insertRoomRequest(db, {
  groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: botId, targetThreadId: "room-t", parentId, admissionKey: key, now, priority: "coordinator",
}).request;
const ask = (parentId: string, from: string, to: string, key: string, now = 1200) => insertRoomRequest(db, {
  groupId: "g1", verb: "ask", fromKind: "bot", fromBotId: from, toBotId: to, parentId, admissionKey: key, now,
  payloadText: "can you check?", returnThreadId: "room-t", returnBotId: from,
}).request;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
});

describe("insertRoomRequest", () => {
  it("issues root lineage and copies it to children, never widening the audience", () => {
    const r = insertRoomRequest(db, {
      groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:g1:a",
      lineage: { ...lineage, notOwnerAudience: true, unattended: true, origin: "unproven" }, now: 1,
    }).request;
    expect(r.rootId).toBe(r.id);
    const child = insertRoomRequest(db, {
      groupId: "g1", verb: "ask", fromKind: "bot", fromBotId: "a", toBotId: "b", parentId: r.id,
      admissionKey: "ask:x", now: 2, lineage: { ...lineage },
    }).request;
    expect(child.rootId).toBe(r.id);
    expect(child.parentId).toBe(r.id);
    expect(child.origin).toBe("unproven");
    expect(child.notOwnerAudience).toBe(true);
    expect(child.unattended).toBe(true);
    expect(child.rootThreadId).toBe("room-t");
  });

  it("lets a child's own caller narrow the lineage it copies, never widen it (lane retryowner)", () => {
    const owner = root();
    const unproven: RoomRequestLineage = { rootThreadId: "room-t", origin: "unproven", audienceFingerprint: "unproven", notOwnerAudience: true, unattended: true };
    const narrowed = insertRoomRequest(db, {
      groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: "b", targetThreadId: "room-t", parentId: owner.id,
      admissionKey: "retry:narrow", now: 2, narrow: unproven,
    }).request;
    expect(narrowed.parentId).toBe(owner.id);
    expect(narrowed.rootThreadId).toBe("room-t");
    expect(narrowed.origin).toBe("unproven");
    expect(narrowed.audienceFingerprint).toBe("unproven");
    expect(narrowed.notOwnerAudience).toBe(true);
    expect(narrowed.unattended).toBe(true);
    // an owner's lineage offered to a narrowed parent's child grants nothing
    const kept = insertRoomRequest(db, {
      groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: "b", targetThreadId: "room-t", parentId: narrowed.id,
      admissionKey: "retry:widen", now: 3, narrow: lineage,
    }).request;
    expect(kept.origin).toBe("unproven");
    expect(kept.notOwnerAudience).toBe(true);
    expect(kept.unattended).toBe(true);
    // with no narrowing the child is its parent's, as before
    expect(turn(owner.id, "b", "plain").origin).toBe("desktop");
    expect(turn(owner.id, "c", "plain2").notOwnerAudience).toBe(false);
  });

  it("copies the execution audience tag from parent to child and writes NULL at roots", () => {
    const r = root();
    expect(r.executionAudience).toBeNull();
    db.prepare("UPDATE room_requests SET execution_audience=? WHERE id=?").run(JSON.stringify({ v: 1, kind: "home", human: "owner", rootRequestId: r.id }), r.id);
    const child = ask(r.id, "a", "b", "ask:tag");
    expect(child.executionAudience).toEqual({ v: 1, kind: "home", human: "owner", rootRequestId: r.id });
  });

  it("dedupes on admission_key and returns the existing row", () => {
    const first = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:g1:dup", lineage, payloadText: "one", now: 1 });
    const again = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:g1:dup", lineage, payloadText: "two", now: 2 });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(first.request.id);
    expect(again.request.payloadText).toBe("one");
  });

  it("refuses a root without lineage and a child of a missing parent", () => {
    expect(() => insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "k", now: 1 })).toThrow();
    expect(() => insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", parentId: "nope", admissionKey: "k2", now: 1 })).toThrow();
  });

  it("orders the queue by priority, then created_at, then id", () => {
    const r = root();
    const work = insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", parentId: r.id, admissionKey: "w", now: 5, priority: "work" }).request;
    const coord = insertRoomRequest(db, { groupId: "g1", verb: "wake", fromKind: "murage", parentId: r.id, admissionKey: "c", now: 9, priority: "coordinator" }).request;
    const owner = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", lineage, admissionKey: "o", now: 20, priority: "owner" }).request;
    expect(queuedRoomRequests(db).map((q) => q.id).filter((id) => id !== r.id)).toEqual([owner.id, coord.id, work.id]);
  });
});

describe("completeRequest and continuations", () => {
  it("a turn that ends with an open ask waits, and the answer wakes it exactly once", () => {
    const r = root();
    const lead = turn(r.id, "lead", "room_turn:m1:lead");
    markRequestDispatched(db, lead.id, { now: 1150 });
    const a = ask(lead.id, "lead", "dax", "ask:1");
    markRequestDispatched(db, a.id, { now: 1250 });
    const ended = finishRequestTurn(db, lead.id, { ok: true, now: 1300, resultMessageId: "m-lead" });
    expect(ended.request.state).toBe("waiting_bot");
    expect(ended.wakes).toEqual([]);
    const answered = completeRequest(db, a.id, { state: "done", now: 1400, resultMessageId: "m-dax" });
    expect(answered.wakes).toHaveLength(1);
    const wake = answered.wakes[0];
    expect(wake.verb).toBe("wake");
    expect(wake.toBotId).toBe("lead");
    expect(wake.targetThreadId).toBe("room-t");
    expect(wake.admissionKey).toBe(`wake:${lead.id}`);
    expect(wake.rootId).toBe(r.id);
    expect(JSON.parse(wake.payloadText!)).toEqual([{ requestId: a.id, botId: "dax", state: "done", messageId: "m-dax" }]);
    // a repeat of the completion is a no-op
    expect(completeRequest(db, a.id, { state: "done", now: 1500 }).wakes).toEqual([]);
    expect(listRoomRequests(db, { groupId: "g1" }).filter((q) => q.verb === "wake")).toHaveLength(1);
  });

  it("gives one wake whichever finishes first, with two open asks", () => {
    const r = root();
    const lead = turn(r.id, "lead", "room_turn:m2:lead");
    markRequestDispatched(db, lead.id, { now: 1150 });
    const a = ask(lead.id, "lead", "dax", "ask:a", 1200);
    const b = ask(lead.id, "lead", "moss", "ask:b", 1201);
    // child a finishes while the parent is still running: nothing yet
    expect(completeRequest(db, a.id, { state: "done", now: 1300, resultMessageId: "ma" }).wakes).toEqual([]);
    // parent ends: b still open, so it waits
    expect(finishRequestTurn(db, lead.id, { ok: true, now: 1350 }).request.state).toBe("waiting_bot");
    // b cancelled: last open child, one wake carrying both
    const done = completeRequest(db, b.id, { state: "cancelled", now: 1400, outcomeNote: "cancelled by you" });
    expect(done.wakes).toHaveLength(1);
    expect(JSON.parse(done.wakes[0].payloadText!).map((x: { requestId: string; state: string }) => [x.requestId, x.state])).toEqual([[a.id, "done"], [b.id, "cancelled"]]);
  });

  it("a parent whose asks all finished during its own turn is woken once when the turn ends", () => {
    const r = root();
    const lead = turn(r.id, "lead", "room_turn:m3:lead");
    markRequestDispatched(db, lead.id, { now: 1150 });
    const a = ask(lead.id, "lead", "dax", "ask:c");
    completeRequest(db, a.id, { state: "done", now: 1200, resultMessageId: "ma" });
    const ended = finishRequestTurn(db, lead.id, { ok: true, now: 1300 });
    expect(ended.request.state).toBe("waiting_bot");
    expect(ended.wakes.map((w) => w.admissionKey)).toEqual([`wake:${lead.id}`]);
  });

  it("an ask answered inline (the asker saw it) wakes nobody", () => {
    const r = root();
    const lead = turn(r.id, "lead", "room_turn:m4:lead");
    markRequestDispatched(db, lead.id, { now: 1150 });
    const a = ask(lead.id, "lead", "dax", "ask:d");
    completeRequest(db, a.id, { state: "done", now: 1200, outcomeNote: "delivered" });
    const ended = finishRequestTurn(db, lead.id, { ok: true, now: 1300 });
    expect(ended.request.state).toBe("done");
    expect(ended.wakes).toEqual([]);
  });

  it("the waiting parent completes when its continuation wake completes, and passes its own result on", () => {
    const r = root();
    const lead = turn(r.id, "lead", "room_turn:m5:lead");
    markRequestDispatched(db, lead.id, { now: 1150 });
    const a = ask(lead.id, "lead", "dax", "ask:e");
    finishRequestTurn(db, lead.id, { ok: true, now: 1200 });
    const wake = completeRequest(db, a.id, { state: "done", now: 1300 }).wakes[0];
    markRequestDispatched(db, wake.id, { now: 1310 });
    const woke = finishRequestTurn(db, wake.id, { ok: true, now: 1400, resultMessageId: "m-lead-2" });
    expect(woke.request.state).toBe("done");
    expect(roomRequest(db, lead.id)!.state).toBe("done");
    expect(roomRequest(db, lead.id)!.resultMessageId).toBe("m-lead-2");
  });

  it("a card run that asked a teammate moves its card once, when its continuation finishes, and wakes the lead once", () => {
    const r = root();
    const run = insertRoomRequest(db, {
      groupId: "g1", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: "jax", parentId: r.id, admissionKey: "assign:card:c1:1:1",
      workItemId: "c1", cardGeneration: 1, returnBotId: "lead", returnThreadId: "room-t", targetThreadId: "desk-jax", now: 1100,
    }).request;
    markRequestDispatched(db, run.id, { now: 1110 });
    const a = ask(run.id, "jax", "dax", "ask:card");
    const moved: string[] = [];
    const hooks = { cardGenerationCurrent: () => true, cardEffect: (_: DatabaseSync, q: { id: string; verb: string }) => { moved.push(q.verb); } };
    expect(finishRequestTurn(db, run.id, { ok: true, now: 1200 }, hooks).request.state).toBe("waiting_bot");
    const continuation = completeRequest(db, a.id, { state: "done", now: 1300, resultMessageId: "m-dax" }, hooks).wakes[0];
    expect(continuation.workItemId).toBe("c1");
    expect(continuation.toBotId).toBe("jax");
    markRequestDispatched(db, continuation.id, { now: 1310 });
    const finished = finishRequestTurn(db, continuation.id, { ok: true, now: 1400, resultMessageId: "m-jax" }, hooks);
    expect(moved).toEqual(["assign"]);
    expect(finished.wakes.map((w) => [w.toBotId, w.admissionKey])).toEqual([["lead", `wake:${run.id}:return`]]);
    expect(roomRequest(db, run.id)!.resultMessageId).toBe("m-jax");
  });

  it("an assign or review result wakes its return bot through the outbox", () => {
    const r = root();
    const assign = insertRoomRequest(db, {
      groupId: "g1", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: "jax", parentId: r.id, admissionKey: "assign:card:c1:1:1",
      workItemId: "c1", cardGeneration: 1, returnBotId: "lead", returnThreadId: "room-t", now: 1100,
    }).request;
    markRequestDispatched(db, assign.id, { now: 1150 });
    const done = finishRequestTurn(db, assign.id, { ok: true, now: 1200, resultMessageId: "m-jax" });
    expect(done.wakes.map((w) => [w.admissionKey, w.toBotId, w.priority])).toEqual([[`wake:${assign.id}`, "lead", "coordinator"]]);
  });

  it("absorbs a second result into a wake that has not started", () => {
    const r = root();
    const mk = (key: string) => {
      const q = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: "jax", parentId: r.id, admissionKey: key, returnBotId: "lead", returnThreadId: "room-t", now: 1100 }).request;
      markRequestDispatched(db, q.id, { now: 1110 });
      return q;
    };
    const one = mk("assign:1"), two = mk("assign:2");
    expect(finishRequestTurn(db, one.id, { ok: true, now: 1200 }).wakes).toHaveLength(1);
    const second = finishRequestTurn(db, two.id, { ok: true, now: 1210 });
    expect(second.wakes).toEqual([]);
    const wakes = listRoomRequests(db, { groupId: "g1" }).filter((q) => q.verb === "wake");
    expect(wakes).toHaveLength(1);
    expect(JSON.parse(wakes[0].payloadText!).map((x: { requestId: string }) => x.requestId)).toEqual([one.id, two.id]);
  });

  it("outbox atomicity: a hook that throws rolls back the state change and the wake", () => {
    const r = root();
    const assign = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", toBotId: "jax", parentId: r.id, admissionKey: "assign:atom", returnBotId: "lead", returnThreadId: "room-t", now: 1100 }).request;
    markRequestDispatched(db, assign.id, { now: 1110 });
    expect(() => completeRequest(db, assign.id, { state: "done", now: 1200 }, { settleUsage: () => { throw new Error("crash"); } })).toThrow("crash");
    expect(roomRequest(db, assign.id)!.state).toBe("running");
    expect(listRoomRequests(db, { groupId: "g1" }).filter((q) => q.verb === "wake")).toHaveLength(0);
  });

  it("fencing: a stale card generation still settles usage but moves nothing and wakes nobody", () => {
    const r = root();
    const assign = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", toBotId: "jax", parentId: r.id, admissionKey: "assign:fence", workItemId: "c1", cardGeneration: 1, returnBotId: "lead", returnThreadId: "room-t", now: 1100 }).request;
    markRequestDispatched(db, assign.id, { now: 1110 });
    const settled: string[] = [], moved: string[] = [];
    const done = completeRequest(db, assign.id, { state: "done", now: 1200 }, {
      cardGenerationCurrent: () => false,
      settleUsage: (_db, q) => { settled.push(q.id); },
      cardEffect: (_db, q) => { moved.push(q.id); },
    });
    expect(done.request.outcomeNote).toBe("superseded");
    expect(settled).toEqual([assign.id]);
    expect(moved).toEqual([]);
    expect(done.wakes).toEqual([]);
  });

  it("a request that never ran settles no usage", () => {
    const r = root();
    const a = ask(r.id, "a", "b", "ask:never");
    const settled: string[] = [];
    completeRequest(db, a.id, { state: "cancelled", now: 5 }, { settleUsage: (_db, q) => { settled.push(q.id); } });
    expect(settled).toEqual([]);
  });

  it("no wake for a chain that is not the owner's audience", () => {
    const r = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "ns", lineage: { ...lineage, notOwnerAudience: true }, now: 1 }).request;
    const assign = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", toBotId: "jax", parentId: r.id, admissionKey: "assign:ns", returnBotId: "lead", returnThreadId: "room-t", now: 2 }).request;
    markRequestDispatched(db, assign.id, { now: 3 });
    expect(finishRequestTurn(db, assign.id, { ok: true, now: 4 }).wakes).toEqual([]);
  });
});

describe("cancel, deadlock, counters", () => {
  it("cancels a waiting parent and its open asks without a wake", () => {
    const r = root();
    const lead = turn(r.id, "lead", "room_turn:c:lead");
    markRequestDispatched(db, lead.id, { now: 1150 });
    const a = ask(lead.id, "lead", "dax", "ask:cc");
    finishRequestTurn(db, lead.id, { ok: true, now: 1200 });
    const cancelled = cancelRoomRequest(db, lead.id, { now: 1300 });
    expect(cancelled?.state).toBe("cancelled");
    expect(roomRequest(db, a.id)!.state).toBe("cancelled");
    expect(listRoomRequests(db, { groupId: "g1" }).some((q) => q.verb === "wake")).toBe(false);
  });

  it("refuses to cancel a running request", () => {
    const r = root();
    const lead = turn(r.id, "lead", "room_turn:cr:lead");
    markRequestDispatched(db, lead.id, { now: 1150 });
    expect(cancelRoomRequest(db, lead.id, { now: 1300 })).toBeNull();
  });

  it("walks persisted wait edges to find a deadlock", () => {
    const r = root();
    const dax = turn(r.id, "dax", "room_turn:d:dax");
    markRequestDispatched(db, dax.id, { now: 1150 });
    ask(dax.id, "dax", "moss", "ask:dm");
    finishRequestTurn(db, dax.id, { ok: true, now: 1200 });
    // Dax waits on Moss. Moss asking Dax closes the cycle; Moss asking Finch does not.
    expect(askWouldDeadlock(db, "moss", "dax")).toBe(true);
    expect(askWouldDeadlock(db, "moss", "finch")).toBe(false);
    expect(openAskChildren(db, dax.id)).toHaveLength(1);
  });

  it("counts wakes and team work time under a root, surviving as rows", () => {
    const r = root(0);
    const lead = turn(r.id, "lead", "room_turn:n:lead", 0);
    markRequestDispatched(db, lead.id, { now: 0 });
    finishRequestTurn(db, lead.id, { ok: true, now: 60_000 }, ledgerHooks);
    for (let i = 0; i < 2; i += 1) {
      const w = insertRoomRequest(db, { groupId: "g1", verb: "wake", fromKind: "murage", toBotId: "lead", parentId: r.id, admissionKey: `wake:x${i}`, now: 70_000 }).request;
      markRequestDispatched(db, w.id, { now: 70_000 });
      finishRequestTurn(db, w.id, { ok: true, now: 100_000 }, ledgerHooks);
    }
    const counts = rootCounters(db, r.id, 100_000);
    expect(counts.wakes).toBe(2);
    expect(counts.workMs).toBe(60_000 + 2 * 30_000);
  });
});

describe("the conversation budget (SPEC-P 6.2)", () => {
  it("counts steps since the owner's last message in the thread, and only the work inside that window", () => {
    const first = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "o1", lineage, targetThreadId: "room-t", now: 0 }).request;
    completeRequest(db, first.id, { state: "done", now: 0 });
    // a handoff dispatched under the first message, still running
    const handoff = insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", fromBotId: "lead", toBotId: "dax", parentId: first.id, admissionKey: "h", returnThreadId: "room-t", returnBotId: "lead", now: 10 }).request;
    markRequestDispatched(db, handoff.id, { now: 10 });
    for (let i = 0; i < 3; i += 1) {
      const w = insertRoomRequest(db, { groupId: "g1", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "room-t", parentId: first.id, admissionKey: `w${i}`, now: 20 });
      markRequestDispatched(db, w.request.id, { now: 20 });
      finishRequestTurn(db, w.request.id, { ok: true, now: 30 }, ledgerHooks);
    }
    expect(conversationCounters(db, { groupId: "g1", threadId: "room-t", now: 100 })).toEqual({ wakes: 3, workMs: 90 + 3 * 10 });
    // the owner writes again at 100: a fresh budget, and the running handoff counts from then on
    const second = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "o2", lineage, targetThreadId: "room-t", now: 100 }).request;
    completeRequest(db, second.id, { state: "done", now: 100 });
    expect(conversationCounters(db, { groupId: "g1", threadId: "room-t", now: 160 })).toEqual({ wakes: 0, workMs: 60 });
    // another room thread has its own budget
    expect(conversationCounters(db, { groupId: "g1", threadId: "other-t", now: 160 })).toEqual({ wakes: 0, workMs: 0 });
  });
});

describe("boot, restore, expiry, pruning", () => {
  it("boot leaves interrupted cards unknown for the owner without dispatching a wake", () => {
    const r = root();
    const mk = (key: string, card: string) => {
      const q = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", toBotId: "jax", parentId: r.id, admissionKey: key, workItemId: card, cardGeneration: 1, returnBotId: "lead", returnThreadId: "room-t", now: 1100 }).request;
      markRequestDispatched(db, q.id, { now: 1110 });
      return q;
    };
    const c1 = mk("assign:b1", "c1"), c2 = mk("assign:b2", "c2");
    const queued = ask(r.id, "a", "b", "ask:stay");
    const result = reconcileRoomRequestsAtBoot(db, 5000);
    expect(roomRequest(db, c1.id)!.state).toBe("unknown");
    expect(roomRequest(db, c2.id)!.state).toBe("unknown");
    expect(roomRequest(db, c1.id)!.outcomeNote).toMatch(/restart/);
    expect(roomRequest(db, queued.id)!.state).toBe("queued");
    const wakes = listRoomRequests(db, { groupId: "g1" }).filter((q) => q.verb === "wake");
    expect(wakes).toEqual([]);
    expect(result.wakes).toEqual([]);
    expect(result.unknown).toBe(2);
  });

  it("boot completes an ask whose result was written before the crash, instead of calling it interrupted", () => {
    const r = root();
    const lead = turn(r.id, "lead", "room_turn:boot:lead");
    markRequestDispatched(db, lead.id, { now: 1150 });
    const answered = ask(lead.id, "lead", "dax", "ask:answered");
    const lost = ask(lead.id, "lead", "moss", "ask:lost");
    markRequestDispatched(db, answered.id, { now: 1200 });
    markRequestDispatched(db, lost.id, { now: 1200 });
    finishRequestTurn(db, lead.id, { ok: true, now: 1300 });
    recoverCommittedAskResults(db, 2000, (row) => row.id === answered.id ? { messageId: "m-dax", ok: true } : null);
    expect(roomRequest(db, answered.id)).toMatchObject({ state: "done", resultMessageId: "m-dax" });
    const boot = reconcileRoomRequestsAtBoot(db, 2001);
    expect(roomRequest(db, lost.id)!.state).toBe("unknown");
    expect(boot.wakes).toHaveLength(1);
    expect(JSON.parse(boot.wakes[0].payloadText!).map((x: { requestId: string; state: string }) => [x.requestId, x.state]).sort()).toEqual([[answered.id, "done"], [lost.id, "unknown"]].sort());
  });

  it("expires queued requests past their deadline", () => {
    const r = root();
    const t = insertRoomRequest(db, { groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: "dax", parentId: r.id, admissionKey: "rt:late", now: 0, deadlineAt: 100 }).request;
    expect(expireOverdueRoomRequests(db, 50)).toEqual([]);
    expect(expireOverdueRoomRequests(db, 200).map((q) => q.id)).toEqual([t.id]);
    expect(roomRequest(db, t.id)!.state).toBe("expired");
  });

  it("prunes terminal rows older than 30 days, except a parent of an open request", () => {
    const day = 24 * 60 * 60 * 1000;
    const old = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "old", lineage, now: 0 }).request;
    completeRequest(db, old.id, { state: "done", now: 1 });
    const kept = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "kept", lineage, now: 0 }).request;
    completeRequest(db, kept.id, { state: "done", now: 1 });
    ask(kept.id, "a", "b", "ask:open", 2);
    pruneTerminalRoomRequests(db, 31 * day);
    expect(roomRequest(db, old.id)).toBeNull();
    expect(roomRequest(db, kept.id)).not.toBeNull();
  });
});

// Lane R's review rows (5.1a): a re-run after a failed review takes the key
// review:<cardId>:<generation>:<seq>, and every review's result comes back to
// the lead through the outbox. R's rows name the lead as return bot but no
// thread, so the room's main thread is where the result goes.
describe("lane R review rows", () => {
  const hooks = { returnThread: () => "room-t" };
  beforeEach(() => {
    db.prepare("INSERT INTO project_settings (group_id, lead_bot_id, updated_at) VALUES ('g1','lead',1)").run();
    db.prepare(`INSERT INTO project_work_items (id, group_id, number, title, state, position, assignee_bot_id, generation, created_by, created_at, updated_at)
      VALUES ('c1','g1',7,'Pricing','review',1,'jax',1,'lead',1,1)`).run();
  });
  const review = (now: number) => {
    const assigned = assignCardReview(db, { cardId: "c1", reviewerBotId: "rev", leadBotId: "lead", memberIds: ["lead", "jax", "rev"], now });
    if (!assigned.ok) throw new Error(assigned.reason);
    return roomRequest(db, assigned.requestId)!;
  };

  it("wakes the lead with each review's result, first run and re-run alike", () => {
    const first = review(10);
    expect(first.admissionKey).toBe("review:c1:1");
    markRequestDispatched(db, first.id, { now: 11 });
    const failed = finishRequestTurn(db, first.id, { ok: false, now: 12 }, hooks);
    expect(failed.wakes.map((wake) => [wake.toBotId, wake.targetThreadId, wake.admissionKey])).toEqual([["lead", "room-t", `wake:${first.id}`]]);

    const again = review(20);
    expect(again.admissionKey).toBe("review:c1:1:1");
    expect(again.parentId).toBe(first.id);
    markRequestDispatched(db, again.id, { now: 21 });
    const passed = finishRequestTurn(db, again.id, { ok: true, now: 22 }, hooks);
    expect(passed.request.state).toBe("done");
    // the first wake is still queued: the second result joins it, the lead wakes once
    expect(passed.wakes).toEqual([]);
    const wakes = listRoomRequests(db, { groupId: "g1" }).filter((row) => row.verb === "wake");
    expect(wakes).toHaveLength(1);
    expect(JSON.parse(wakes[0].payloadText!).map((result: { requestId: string }) => result.requestId)).toEqual([first.id, again.id]);
  });

  it("without a room thread to return to, nobody is woken", () => {
    const first = review(10);
    markRequestDispatched(db, first.id, { now: 11 });
    expect(finishRequestTurn(db, first.id, { ok: true, now: 12 }).wakes).toEqual([]);
  });
});

describe("a restart during a continuation", () => {
  it("leaves the waiting asker unknown (a restart), not failed", () => {
    const r = root();
    const work = insertRoomRequest(db, { groupId: "g1", verb: "assign", fromKind: "bot", fromBotId: "lead", toBotId: "jax", parentId: r.id, admissionKey: "assign:w", targetThreadId: "desk", now: 1100 }).request;
    markRequestDispatched(db, work.id, { now: 1110 });
    const question = ask(work.id, "jax", "dax", "ask:q", 1120);
    markRequestDispatched(db, question.id, { now: 1130 });
    finishRequestTurn(db, work.id, { ok: true, now: 1140 });
    expect(roomRequest(db, work.id)!.state).toBe("waiting_bot");
    const woke = completeRequest(db, question.id, { state: "done", now: 1150, resultMessageId: "m-dax" });
    const continuation = woke.wakes[0];
    expect(continuation.admissionKey).toBe(`wake:${work.id}`);
    markRequestDispatched(db, continuation.id, { now: 1160 });
    completeRequest(db, continuation.id, { state: "unknown", now: 1170, outcomeNote: "interrupted by a restart" });
    expect(roomRequest(db, work.id)).toMatchObject({ state: "unknown", outcomeNote: "interrupted by a restart" });
  });
});

it("F8 root and conversation work use settled work, excluding the restart gap", () => {
  const r = root(0);
  completeRequest(db, r.id, { state: "done", now: 0 });
  const run = turn(r.id, "lead", "restart-gap", 10);
  markRequestDispatched(db, run.id, { now: 10 });
  completeRequest(db, run.id, { state: "unknown", now: 100000 });
  db.prepare(`INSERT INTO usage_ledger (settle_key,group_id,root_id,request_id,thread_id,bot_id,engine,at,work_ms,tokens_reported,charge_kind,ok)
    VALUES ('unknown:test','g1',?,?,'room-t','lead','fake',100000,40,0,'none',0)`).run(r.id,run.id);
  expect(rootCounters(db,r.id,100000).workMs).toBe(40);
  expect(conversationCounters(db,{groupId:'g1',threadId:'room-t',now:100000}).workMs).toBe(40);
});

// SPEC-P 10: a bot's reply or result names what it answers in the same
// thread. The AFTER-PF run lost it on wake continuations and delegation
// results, whose own request carries no source message.
describe("requestReplyTarget", () => {
  it("is the nearest source message up the lineage that is in this thread", () => {
    const r = root();
    const owner = insertRoomRequest(db, { groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: "lead", targetThreadId: "room-t", parentId: r.id,
      admissionKey: "room_turn:m-owner:lead", sourceMessageId: "m-owner", now: 1100 }).request;
    const delegation = ask(owner.id, "lead", "jax", "ask:delegation:t1");
    const wake = insertRoomRequest(db, { groupId: "g1", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "room-t", parentId: owner.id, admissionKey: `wake:${owner.id}`, now: 1300 }).request;
    const room = new Set(["m-owner"]);
    expect(requestReplyTarget(db, owner, (id) => room.has(id))).toBe("m-owner");
    expect(requestReplyTarget(db, delegation, (id) => room.has(id))).toBe("m-owner");
    expect(requestReplyTarget(db, wake, (id) => room.has(id))).toBe("m-owner");
    // another thread never borrows the room's message: lineage stays in requestId
    expect(requestReplyTarget(db, wake, () => false)).toBeUndefined();
    expect(requestReplyTarget(db, null, () => true)).toBeUndefined();
  });
});
