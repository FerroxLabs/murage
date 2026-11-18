// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-P 3.2, 5.2, 6: durable room requests, lineage, one completion
// primitive with continuation wakes, deadlock walk, root counters, boot and
// restore handling, pruning.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { settleProjectUsage } from "./usage-ledger.ts";
import { initializeProjectTables, prepareProjectTablesForRestore } from "./project-tables.ts";
import { readyTeams } from "./shared-ready.ts";
import { assignCardReview, cancelProjectCard, createProjectCard } from "./project-cards.ts";
import { channelToProjectRows, endProjectRows } from "./project-settings.ts";
import { changeProjectPlan, createProjectGoal } from "./project-goals.ts";
import { handleProjectRoute } from "./project-routes.ts";
import { endAllLivePairedRequests, endLiveRequestsOfThread } from "./handoff-pair.ts";
import { initializePendingDelegations } from "./pending-delegations-schema.ts";
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
  dueRetainedRoomRequests,
  deferRetainedRoomRequest,
  clearRetainedRoomRequest,
  recordRoomRequestRefusal,
  runnableRoomRequestIds,
  runnableRoomRequestIdsSql,
  queuedRoomRequests,
  requeueSpendHeldRoomRequest,
  scrubOwnerSendsOfThread,
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
    expect(cancelled?.request.state).toBe("cancelled");
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

// fprod4 C: a start the spend gate refused after admission let it through must not cycle queued -> start -> requeue on every pump.
describe("spend-held requeue", () => {
  const selected = (now: number) => [...queuedRoomRequests(db), ...dueRetainedRoomRequests(db, now)].map(r => r.id);
  /** Every pump: the dispatcher selects the request, marks it running, the gate refuses, the start requeues. */
  const cycle = (id: string, now: number, admissionSeesHold: boolean): number => {
    let starts = 0;
    for (let pump = 0; pump < 50; pump++) {
      if (!selected(now).includes(id)) continue;
      if (!markRequestDispatched(db, id, { now, targetThreadId: "room-t" })) continue;
      starts++;
      requeueSpendHeldRoomRequest(db, id, now, admissionSeesHold);
    }
    return starts;
  };
  it("admission sees no hold but the gate refuses: one start in 50 pumps, then parked 30 s, visible as queued", () => {
    const request = turn(root().id, "b", "spend:1");
    expect(cycle(request.id, 5_000, false)).toBe(1);
    expect(roomRequest(db, request.id)!.state).toBe("queued");
    expect(selected(5_000 + 29_999)).not.toContain(request.id);
    expect(selected(5_000 + 30_000)).toContain(request.id);
  });
  it("admission sees the hold: the request stays queued with its refusal line, admission step 5a refuses it before any start", () => {
    const request = turn(root().id, "b", "spend:2");
    markRequestDispatched(db, request.id, { now: 5_000, targetThreadId: "room-t" });
    expect(requeueSpendHeldRoomRequest(db, request.id, 5_000, true)).toBe(true);
    expect(roomRequest(db, request.id)).toMatchObject({ state: "queued", refusal: "spend_limit" });
    expect(selected(5_001)).toContain(request.id);
  });
  it("a request that is not running is left alone", () => {
    const request = turn(root().id, "b", "spend:3");
    expect(requeueSpendHeldRoomRequest(db, request.id, 5_000, false)).toBe(false);
    expect(selected(5_000)).toContain(request.id);
  });
});

// fprod4 C (r3 section 9 + M3): a spend park leaves the runnable index; its reason stays visible.
describe("spend park out of the runnable index", () => {
  const COLUMNS = "id,root_id,parent_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,payload_text,refusal,created_at,deadline_at,finished_at,root_thread_id,return_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key,execution_audience";
  function fill(rows: number, prefix: string, bot = "b0", audience: string | null = null): string[] {
    const insert = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?,?)`);
    const ids: string[] = [];
    db.exec("BEGIN");
    for (let i = 0; i < rows; i++) {
      const id = `${prefix}-${i}`;
      ids.push(id);
      insert.run(id, id, null, "g1", "room_turn", "owner", bot, "t", "queued", null, null, 1_000 + i, null, null, "t", null, `key-${id}`, audience);
    }
    db.exec("COMMIT");
    return ids;
  }
  const park = (ids: string[], at: number) => { db.exec("BEGIN"); for (const id of ids) deferRetainedRoomRequest(db, id, at, "spend_limit"); db.exec("COMMIT"); };
  function rowsVisited(sql: string, args: unknown[]): number {
    let visited = 0;
    db.function("visit", (_rowid: unknown) => { visited++; return 1; });
    db.prepare(sql.replace(/\bWHERE /, "WHERE visit(rowid) AND ")).all(...(args as never[]));
    return visited;
  }
  const plan = (sql: string, args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
  const R = 5;
  for (const parked of [0, 1000, 10_000]) {
    it(`C-W1 the runnable statements visit only the runnable rows with ${parked} spend parks`, () => {
      fill(R, "run");
      park(fill(parked, "park"), 5_000);
      const variants: Array<[string, Parameters<typeof runnableRoomRequestIdsSql>[0], unknown[]]> = [["all", {}, []], ["group", { groupId: "g1" }, ["g1"]], ["bot", { toBotId: "b0" }, ["b0"]]];
      for (const [name, filter, args] of variants) {
        const sql = runnableRoomRequestIdsSql(filter);
        expect(rowsVisited(sql, args), name).toBe(R);
        expect(runnableRoomRequestIds(db, filter), name).toHaveLength(R);
        expect(plan(sql, args), name).toMatch(/room_requests_runnable/);
        expect(plan(sql, args), name).not.toMatch(/CORRELATED|SCALAR SUBQUERY|room_request_retry/);
      }
    });
  }
  it("C-W2 the reason stays visible: a parked row reads spend_limit, a cleared one keeps it, a dispatched one has none", () => {
    const r = turn(root().id, "b", "park:1");
    deferRetainedRoomRequest(db, r.id, 5_000, "spend_limit");
    expect(roomRequest(db, r.id)).toMatchObject({ state: "queued", refusal: "spend_limit" });
    expect(listRoomRequests(db, {}).find((row) => row.id === r.id)).toMatchObject({ refusal: "spend_limit" });
    expect(db.prepare("SELECT refusal, parked_refusal FROM room_requests WHERE id=?").get(r.id)).toEqual({ refusal: "retained_unresolved", parked_refusal: "spend_limit" });
    expect(queuedRoomRequests(db).map((row) => row.id)).not.toContain(r.id);
    expect(clearRetainedRoomRequest(db, r.id)).toBe(true);
    expect(roomRequest(db, r.id)).toMatchObject({ refusal: "spend_limit" });
    expect(db.prepare("SELECT parked_refusal FROM room_requests WHERE id=?").get(r.id)).toEqual({ parked_refusal: null });
    deferRetainedRoomRequest(db, r.id, 6_000, "spend_limit");
    expect(markRequestDispatched(db, r.id, { now: 40_000, targetThreadId: "room-t" })).toBe(true);
    expect(roomRequest(db, r.id)!.refusal).toBeNull();
    expect(db.prepare("SELECT parked_refusal FROM room_requests WHERE id=?").get(r.id)).toEqual({ parked_refusal: null });
    // the history a dispatch keeps for a spend park, so the backoff keeps doubling
    expect(db.prepare("SELECT attempts FROM room_request_retry WHERE request_id=?").get(r.id)).toEqual({ attempts: 1 });
  });
  it("C-W2b an unresolved park keeps no parked reason, and completion clears the marker: an unresolved park ends with no reason, a spend park with spend_limit as on base", () => {
    const r = turn(root().id, "b", "park:2");
    deferRetainedRoomRequest(db, r.id, 5_000);
    expect(db.prepare("SELECT refusal, parked_refusal FROM room_requests WHERE id=?").get(r.id)).toEqual({ refusal: "retained_unresolved", parked_refusal: null });
    deferRetainedRoomRequest(db, r.id, 6_000, "spend_limit");
    completeRequest(db, r.id, { state: "cancelled", now: 7_000 });
    expect(db.prepare("SELECT refusal, parked_refusal FROM room_requests WHERE id=?").get(r.id)).toEqual({ refusal: "spend_limit", parked_refusal: null });
    const u = turn(root().id, "b", "park:2u");
    deferRetainedRoomRequest(db, u.id, 5_000);
    completeRequest(db, u.id, { state: "cancelled", now: 7_000 });
    expect(db.prepare("SELECT refusal, parked_refusal FROM room_requests WHERE id=?").get(u.id)).toEqual({ refusal: null, parked_refusal: null });
  });
  it("C-W4 the upgrade backfill takes a base-shaped spend park out of the runnable index, and a spend refusal without a retry row stays runnable", () => {
    const [parked, loose] = fill(2, "up");
    fill(R, "run");
    db.prepare("UPDATE room_requests SET refusal='spend_limit' WHERE id IN (?,?)").run(parked, loose);
    db.prepare("INSERT INTO room_request_retry(request_id,retry_at,attempts) VALUES(?,?,?)").run(parked, 99_000, 3);
    expect(rowsVisited(runnableRoomRequestIdsSql(), [])).toBe(R + 2);
    initializeProjectTables(db);
    initializeProjectTables(db);
    expect(rowsVisited(runnableRoomRequestIdsSql(), [])).toBe(R + 1);
    expect(runnableRoomRequestIds(db)).toContain(loose);
    expect(roomRequest(db, parked)).toMatchObject({ refusal: "spend_limit" });
    expect(db.prepare("SELECT retry_at, attempts FROM room_request_retry WHERE request_id=?").get(parked)).toEqual({ retry_at: 99_000, attempts: 3 });
  });
  it("C-I1 every writer that takes a spend park out of the queue leaves no park behind: the reason is back on the row and the column is empty", () => {
    const broken = () => db.prepare(`SELECT id, state, refusal, parked_refusal FROM room_requests WHERE parked_refusal IS NOT NULL
      AND NOT (state='queued' AND refusal='retained_unresolved' AND EXISTS (SELECT 1 FROM room_request_retry WHERE request_id=room_requests.id))`).all();
    const park = (id: string) => { deferRetainedRoomRequest(db, id, 5_000, "spend_limit"); return id; };
    const stored = (id: string) => db.prepare("SELECT state, refusal, parked_refusal FROM room_requests WHERE id=?").get(id);
    const retry = (id: string) => db.prepare("SELECT 1 AS x FROM room_request_retry WHERE request_id=?").get(id);
    // a deleted conversation closes its waiting owner send (the production caller)
    const send = park(root(2000).id);
    expect(stored(send)).toEqual({ state: "queued", refusal: "retained_unresolved", parked_refusal: "spend_limit" });
    expect(scrubOwnerSendsOfThread(db, "room-t", 9_000)).toBeGreaterThan(0);
    expect(stored(send)).toEqual({ state: "cancelled", refusal: "spend_limit", parked_refusal: null });
    expect(retry(send)).toBeUndefined();
    expect(broken()).toEqual([]);
    // an expiry (the production caller)
    const late = park(insertRoomRequest(db, { groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: "b", targetThreadId: "room-t", parentId: root(2100).id, admissionKey: "ci1:late", now: 2200, priority: "coordinator", deadlineAt: 3_000 }).request.id);
    expireOverdueRoomRequests(db, 10_000, ledgerHooks);
    expect(stored(late)).toMatchObject({ state: "expired", parked_refusal: null });
    expect(broken()).toEqual([]);
    // the statements the project writers run (project ended, plan changed, a card cancelled, a hand-off's conversation deleted, a group removed)
    for (const [n, sql] of [
      "UPDATE room_requests SET state='cancelled', finished_at=1, waiting_since=NULL, outcome_note='project ended' WHERE id=? AND state IN ('queued','running','waiting_owner','waiting_bot')",
      "UPDATE room_requests SET state='cancelled', finished_at=1, waiting_since=NULL, outcome_note='plan changed' WHERE id=? AND state='queued'",
      "UPDATE room_requests SET state='cancelled', finished_at=1, outcome_note='x', waiting_since=NULL WHERE id=?",
      "UPDATE room_requests SET state='failed', finished_at=1 WHERE id=?",
    ].entries()) {
      const id = park(turn(root(3000 + n).id, "b", `ci1:${n}`).id);
      db.prepare(sql).run(id);
      expect(stored(id)).toMatchObject({ refusal: "spend_limit", parked_refusal: null });
      expect(retry(id)).toBeUndefined();
      expect(roomRequest(db, id)).toMatchObject({ refusal: "spend_limit" });
    }
    expect(broken()).toEqual([]);
    // the lifecycle writers keep their own endings: a dispatch and a completion leave no park and no stale reason
    const run = park(turn(root(4000).id, "b", "ci1:run").id);
    expect(markRequestDispatched(db, run, { now: 40_000, targetThreadId: "room-t" })).toBe(true);
    expect(stored(run)).toEqual({ state: "running", refusal: null, parked_refusal: null });
    expect(broken()).toEqual([]);
  });
  it("C-I1 through the writers themselves: a cancelled request and an ended project leave no park behind", () => {
    const stored = (id: string) => db.prepare("SELECT state, refusal, parked_refusal FROM room_requests WHERE id=?").get(id);
    const retry = (id: string) => db.prepare("SELECT 1 AS x FROM room_request_retry WHERE request_id=?").get(id);
    const park = (id: string) => { deferRetainedRoomRequest(db, id, 5_000, "spend_limit"); expect(stored(id)).toMatchObject({ refusal: "retained_unresolved", parked_refusal: "spend_limit" }); return id; };
    const one = park(turn(root(5000).id, "b", "ci1w:cancel").id);
    expect(cancelRoomRequest(db, one, { now: 50_000 })).not.toBeNull();
    expect(stored(one)).toEqual({ state: "cancelled", refusal: "spend_limit", parked_refusal: null });
    expect(retry(one)).toBeUndefined();
    channelToProjectRows(db, { groupId: "g1", bulletin: "", leadBotId: null, now: 1 });
    const ended = park(turn(root(5100).id, "b", "ci1w:end").id);
    expect(endProjectRows(db, { groupId: "g1", now: 51_000 })).toMatchObject({ ok: true });
    expect(stored(ended)).toEqual({ state: "cancelled", refusal: "spend_limit", parked_refusal: null });
    expect(retry(ended)).toBeUndefined();
    expect(db.prepare("SELECT id FROM room_requests WHERE parked_refusal IS NOT NULL").all()).toEqual([]);
  });
  it.each(["plan", "card", "interrupt", "handoff-thread", "handoff-all", "restore"])("C-I1 real %s writer clears a spend park and its retry, keeping the reason", (writer) => {
    channelToProjectRows(db, { groupId: "g1", bulletin: "", leadBotId: null, now: 1 });
    const parent = root(5200);
    const created = createProjectCard(db, { groupId: "g1", title: "Work", actor: { kind: "owner" }, memberIds: ["b"], now: 2 });
    if (!created.ok) throw new Error(created.reason);
    const card = created.card;
    const request = insertRoomRequest(db, { groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: "b", targetThreadId: "room-t", parentId: parent.id,
      admissionKey: "ci1:writer", workItemId: card.id, cardGeneration: card.generation, now: 3 }).request;
    deferRetainedRoomRequest(db, request.id, 5000, "spend_limit");
    expect(db.prepare("SELECT state, refusal, parked_refusal FROM room_requests WHERE id=?").get(request.id))
      .toEqual({ state: "queued", refusal: "retained_unresolved", parked_refusal: "spend_limit" });
    expect(db.prepare("SELECT 1 FROM room_request_retry WHERE request_id=?").get(request.id)).toBeDefined();
    if (writer === "plan") {
      const goal = createProjectGoal(db, { groupId: "g1", title: "Goal", now: 4 });
      if (!goal.ok) throw new Error(goal.reason);
      db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goal.goal.id);
      db.prepare("UPDATE room_requests SET project_goal_id=? WHERE id=?").run(goal.goal.id, request.id);
      expect(changeProjectPlan(db, { goalId: goal.goal.id, note: "Change the plan", now: 6000 }).ok).toBe(true);
    } else if (writer === "card") {
      expect(cancelProjectCard(db, { cardId: card.id, actor: { kind: "owner" }, now: 6000 }).ok).toBe(true);
    } else if (writer === "interrupt") {
      db.prepare("UPDATE project_work_items SET state='doing', request_id=? WHERE id=?").run(request.id, card.id);
      expect(handleProjectRoute(db, { method: "PATCH", path: `/api/groups/g1/board/cards/${card.id}`, query: new URLSearchParams(),
        body: { expectedRevision: card.revision, action: "interrupt" }, group: { id: "g1", memberIds: ["b"], threadId: "room-t" }, now: 6000 }))
        .toMatchObject({ status: 200 });
    } else if (writer === "restore") {
      prepareProjectTablesForRestore(db, { groups: [{ id: "g1", channelProject: {} }], botIds: new Set(["b"]), now: 6000 });
    } else {
      initializePendingDelegations(db);
      db.prepare("INSERT INTO pending_delegations(id,source_thread_id,to_bot_id,phase,item,origin) VALUES (?,'room-t','b','fresh','{}','room')").run(request.id);
      if (writer === "handoff-thread") endLiveRequestsOfThread(db, "room-t", "Conversation deleted", 6000);
      else endAllLivePairedRequests(db, "Restore", 6000);
    }
    expect(db.prepare("SELECT state, refusal, parked_refusal FROM room_requests WHERE id=?").get(request.id))
      .toEqual({ state: writer === "restore" ? "expired" : "cancelled", refusal: "spend_limit", parked_refusal: null });
    expect(db.prepare("SELECT 1 FROM room_request_retry WHERE request_id=?").get(request.id)).toBeUndefined();
    expect(roomRequest(db, request.id)).toMatchObject({ refusal: "spend_limit" });
  });
  it("C-W5 a spend-parked shared row no longer counts as ready for its team, and returns when cleared", () => {
    db.prepare("INSERT INTO shared_request_provenance(request_id, origin) VALUES('sh-0', 'none')").run();
    const [id] = fill(1, "sh", "b0", JSON.stringify({ kind: "team", team: "T1" }));
    expect(readyTeams(db, "b0", 10)).toContain("T1");
    deferRetainedRoomRequest(db, id!, 5_000, "spend_limit");
    expect(readyTeams(db, "b0", 10)).not.toContain("T1");
    clearRetainedRoomRequest(db, id!);
    expect(readyTeams(db, "b0", 10)).toContain("T1");
  });
  it("parity: a spend refusal seen by admission parks a row that has retry history in place, and not one without", () => {
    const withHistory = turn(root().id, "b", "parity:1");
    const without = turn(root().id, "b", "parity:2");
    deferRetainedRoomRequest(db, withHistory.id, 5_000, "spend_limit");
    markRequestDispatched(db, withHistory.id, { now: 40_000, targetThreadId: "room-t" });
    markRequestDispatched(db, without.id, { now: 40_000, targetThreadId: "room-t" });
    const before = db.prepare("SELECT retry_at, attempts FROM room_request_retry WHERE request_id=?").get(withHistory.id);
    expect(requeueSpendHeldRoomRequest(db, withHistory.id, 40_000, true)).toBe(true);
    expect(requeueSpendHeldRoomRequest(db, without.id, 40_000, true)).toBe(true);
    expect(db.prepare("SELECT retry_at, attempts FROM room_request_retry WHERE request_id=?").get(withHistory.id)).toEqual(before);
    expect(db.prepare("SELECT refusal, parked_refusal FROM room_requests WHERE id=?").get(withHistory.id)).toEqual({ refusal: "retained_unresolved", parked_refusal: "spend_limit" });
    expect(roomRequest(db, withHistory.id)).toMatchObject({ refusal: "spend_limit" });
    expect(runnableRoomRequestIds(db)).not.toContain(withHistory.id);
    expect(runnableRoomRequestIds(db)).toContain(without.id);
    expect(db.prepare("SELECT parked_refusal FROM room_requests WHERE id=?").get(without.id)).toEqual({ parked_refusal: null });
  });
  it("M3 a spend park that meets another refusal becomes an ordinary queued row; an unresolved park keeps its marker", () => {
    const spend = turn(root().id, "b", "m3:1");
    const unresolved = turn(root().id, "b", "m3:2");
    deferRetainedRoomRequest(db, spend.id, 5_000, "spend_limit");
    deferRetainedRoomRequest(db, unresolved.id, 5_000);
    recordRoomRequestRefusal(db, spend.id, "spend_limit");
    expect(db.prepare("SELECT refusal, parked_refusal FROM room_requests WHERE id=?").get(spend.id)).toEqual({ refusal: "retained_unresolved", parked_refusal: "spend_limit" });
    expect(db.prepare("SELECT 1 AS x FROM room_request_retry WHERE request_id=?").get(spend.id)).toBeDefined();
    recordRoomRequestRefusal(db, spend.id, "speaking_in_room");
    recordRoomRequestRefusal(db, unresolved.id, "speaking_in_room");
    expect(db.prepare("SELECT refusal, parked_refusal FROM room_requests WHERE id=?").get(spend.id)).toEqual({ refusal: "speaking_in_room", parked_refusal: null });
    expect(db.prepare("SELECT 1 AS x FROM room_request_retry WHERE request_id=?").get(spend.id)).toBeUndefined();
    expect(runnableRoomRequestIds(db)).toContain(spend.id);
    expect(dueRetainedRoomRequests(db, 10 ** 9).map((row) => row.id)).not.toContain(spend.id);
    expect(db.prepare("SELECT refusal FROM room_requests WHERE id=?").get(unresolved.id)).toEqual({ refusal: "retained_unresolved" });
    // the spend hold returns after the other refusal: parked again from attempt 1
    markRequestDispatched(db, spend.id, { now: 50_000, targetThreadId: "room-t" });
    requeueSpendHeldRoomRequest(db, spend.id, 50_000, false);
    expect(db.prepare("SELECT attempts FROM room_request_retry WHERE request_id=?").get(spend.id)).toEqual({ attempts: 1 });
    expect(roomRequest(db, spend.id)).toMatchObject({ refusal: "spend_limit" });
  });
});
