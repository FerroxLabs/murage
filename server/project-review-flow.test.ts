// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane review: in goal mode a card that reaches review always ends in a
// verdict. AFTER-PF: every goal run ended with its cards in review. The
// review waited for the lead to call project_review_assign (F1: it never
// did), and a review that ran ended without a verdict, which counted as
// "changes" and left the card waiting on the lead again (F2).
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyCardRunEffect, cardGenerationCurrent, leadNextStep, queueHeldReviewWakes, reviewWakeTarget } from "./project-turn-engine.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { acceptProjectCard, applyCardRunDispatched, applyReviewVerdict, enqueueCardRun } from "./project-cards.ts";
import { projectCardById } from "./project-records.ts";
import { completeRequest, insertRoomRequest, markRequestDispatched, roomRequest, type RoomRequest } from "./room-requests.ts";

let db: DatabaseSync;
const viewer = { botId: "lead", threadId: "room" };
const names = new Map([["lead", "Nova"], ["jax", "Jax"], ["rev", "Reed"], ["cole", "Cole"]]);
const name = (id: string) => names.get(id) ?? "a member";
const lineage = { rootThreadId: "t", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };

function insert(table: string, row: Record<string, unknown>) {
  db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row) as Array<string | number | null>);
}
let number = 0;
function card(extra: Record<string, unknown> = {}) {
  number += 1;
  const row = { id: `c${number}`, group_id: "g", goal_id: "goal", number, title: `Card ${number}`, state: "todo", position: number, created_by: "lead", created_at: 1, updated_at: 1, assignee_bot_id: "jax", ...extra };
  insert("project_work_items", row);
  return row.id as string;
}
const hooks = (members: readonly string[]) => ({
  cardGenerationCurrent,
  cardEffect: (tx: DatabaseSync, request: RoomRequest) => applyCardRunEffect(tx, request, { memberIds: members, now: 500 }),
  returnThread: () => "room",
  reviewWake: (tx: DatabaseSync, request: RoomRequest) => reviewWakeTarget(tx, request, { memberIds: members, roomThreadId: "room" }),
});
/** A lead-assigned card of jax's, dispatched and running. */
function running(assignee = "jax") {
  const c = card({ assignee_bot_id: assignee });
  const queued = enqueueCardRun(db, { cardId: c, actor: { kind: "server" }, now: 100 });
  if (!queued.ok) throw new Error(queued.reason);
  db.prepare("UPDATE room_requests SET return_bot_id='lead' WHERE id=?").run(queued.requestId);
  expect(applyCardRunDispatched(db, { cardId: c, requestId: queued.requestId, deskThreadId: `desk-${assignee}`, now: 110 }).ok).toBe(true);
  return { c, requestId: queued.requestId };
}
const reviews = (c: string) => db.prepare("SELECT id, to_bot_id, return_bot_id, state, card_generation, outcome_note FROM room_requests WHERE verb='review' AND work_item_id=? ORDER BY created_at, id").all(c) as
  Array<{ id: string; to_bot_id: string; return_bot_id: string | null; state: string; card_generation: number; outcome_note: string | null }>;
const cardState = (c: string) => projectCardById(db, c)!.state;
/** The lead is woken with this result: a new wake, or one still queued that took it in. */
const leadWokenWith = (requestId: string) => Number((db.prepare(`SELECT count(*) AS n FROM room_requests WHERE verb='wake' AND to_bot_id='lead'
  AND state='queued' AND (admission_key=? OR payload_text LIKE ?)`).get(`wake:${requestId}`, `%${requestId}%`) as { n: number }).n);
/** The review run of `c`, dispatched, then ended with `verdict` (null: none given). */
function reviewEnds(c: string, verdict: "pass" | "changes" | null, members: readonly string[], state: "done" | "failed" = "done") {
  const review = reviews(c).at(-1)!;
  markRequestDispatched(db, review.id, { now: 200 });
  if (verdict) expect(applyReviewVerdict(db, { cardId: c, requestId: review.id, reviewerBotId: review.to_bot_id, verdict, now: 210 }).ok).toBe(true);
  return completeRequest(db, review.id, { state, now: 220, resultMessageId: "m-review" }, hooks(members));
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  number = 0;
  insert("project_settings", { group_id: "g", mode: "conversation", lead_bot_id: "lead", parts: "{}", parallel_cards: 3, work_roots: "[]", work_profile: "ask", run_state: "running", updated_at: 1 });
  insert("project_goals", { id: "goal", group_id: "g", title: "Ship", state: "working", review: 1, created_at: 1,
    criteria: JSON.stringify([{ id: "k1", text: "It exists", setBy: "owner", proposed: false, met: false }]) });
});

describe("a card reaching review gets its reviewer from the server", () => {
  it("another member than the assignee and the lead reviews it, returning to the lead", () => {
    const a = running();
    completeRequest(db, a.requestId, { state: "done", now: 150, resultMessageId: "m-result" }, hooks(["lead", "jax", "rev"]));
    expect(cardState(a.c)).toBe("review");
    expect(reviews(a.c)).toEqual([expect.objectContaining({ to_bot_id: "rev", return_bot_id: "lead", state: "queued", card_generation: 1 })]);
    expect(projectCardById(db, a.c)!.reviewRequestId).toBe(reviews(a.c)[0]!.id);
  });

  it("the lead reviews when no other member exists", () => {
    const a = running();
    completeRequest(db, a.requestId, { state: "done", now: 150 }, hooks(["lead", "jax"]));
    expect(reviews(a.c)).toEqual([expect.objectContaining({ to_bot_id: "lead", return_bot_id: "lead" })]);
  });

  it("the review goes to the member with the least review work", () => {
    const a = running();
    completeRequest(db, a.requestId, { state: "done", now: 150 }, hooks(["lead", "jax", "rev", "cole"]));
    const b = running();
    completeRequest(db, b.requestId, { state: "done", now: 160 }, hooks(["lead", "jax", "rev", "cole"]));
    expect([reviews(a.c)[0]!.to_bot_id, reviews(b.c)[0]!.to_bot_id]).toEqual(["rev", "cole"]);
  });

  it("a card that reached review while there was no lead gets its reviewer once a lead is set", () => {
    const a = running();
    db.prepare("UPDATE room_requests SET return_bot_id=NULL WHERE id=?").run(a.requestId); // an owner card's run
    completeRequest(db, a.requestId, { state: "done", now: 150 }, hooks(["jax", "rev"]));
    expect(reviews(a.c)).toEqual([]);
    queueHeldReviewWakes(db, { groupId: "g", memberIds: ["lead", "jax", "rev"], roomThreadId: "room", now: 300 });
    expect(reviews(a.c)).toEqual([expect.objectContaining({ to_bot_id: "rev", return_bot_id: "lead" })]);
  });

  it("a card the old lead assigned that reached review with no lead gets its reviewer once a lead is set", () => {
    const a = running();
    completeRequest(db, a.requestId, { state: "done", now: 150 }, hooks(["jax", "rev"]));
    expect(reviews(a.c)).toEqual([]);
    const wakes = queueHeldReviewWakes(db, { groupId: "g", memberIds: ["lead", "jax", "rev"], roomThreadId: "room", now: 300 });
    expect(reviews(a.c)).toEqual([expect.objectContaining({ to_bot_id: "rev", return_bot_id: "lead" })]);
    expect(wakes).toEqual([]); // not an owner card: its result already went to whoever assigned it
  });

  it("no reviewer is assigned without a lead in the room, without goal review, or for a one-member project", () => {
    const a = running();
    completeRequest(db, a.requestId, { state: "done", now: 150 }, hooks(["jax", "rev"]));
    expect(cardState(a.c)).toBe("review");
    expect(reviews(a.c)).toEqual([]);
    db.exec("UPDATE project_goals SET review=0");
    const b = running();
    completeRequest(db, b.requestId, { state: "done", now: 160 }, hooks(["lead", "jax", "rev"]));
    expect(cardState(b.c)).toBe("done");
    expect(reviews(b.c)).toEqual([]);
  });

  it("an owner card's run gets its reviewer too, and the lead's wake says who reviews", () => {
    const c = card({ state: "doing", generation: 1 });
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r", lineage, now: 1 }).request;
    const run = insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "owner", toBotId: "jax", parentId: root.id, workItemId: c,
      cardGeneration: 1, admissionKey: `assign:card:${c}:1:1`, projectGoalId: "goal", now: 2 }).request;
    db.prepare("UPDATE project_work_items SET request_id=? WHERE id=?").run(run.id, c);
    markRequestDispatched(db, run.id, { now: 3 });
    const done = completeRequest(db, run.id, { state: "done", now: 4, resultMessageId: "m-result" }, hooks(["lead", "jax", "rev"]));
    expect(done.wakes.map(wake => wake.toBotId)).toEqual(["lead"]);
    expect(reviews(c)).toEqual([expect.objectContaining({ to_bot_id: "rev", return_bot_id: "lead" })]);
    expect(leadNextStep(db, roomRequest(db, run.id)!, { memberIds: ["lead", "jax", "rev"], viewer, name })).toEqual({
      step: "reviewing", card: { id: c, number: 1, title: "Card 1" }, reviewer: "Reed", resultMessageId: "m-result", criteria: [{ id: "k1", text: "It exists" }],
    });
  });
});

describe("a review always ends in a verdict or a decision for the lead", () => {
  const members = ["lead", "jax", "rev"];
  const toReview = () => {
    const a = running();
    completeRequest(db, a.requestId, { state: "done", now: 150, resultMessageId: "m-result" }, hooks(members));
    return a;
  };

  it("a pass moves the card to done and the lead is woken to record the criteria", () => {
    const a = toReview();
    reviewEnds(a.c, "pass", members);
    expect(cardState(a.c)).toBe("done");
    expect(leadWokenWith(reviews(a.c)[0]!.id)).toBe(1);
    const review = roomRequest(db, reviews(a.c)[0]!.id)!;
    expect(leadNextStep(db, review, { memberIds: members, viewer, name })).toEqual({
      step: "accepted", card: { id: a.c, number: 1, title: "Card 1" }, resultMessageId: "m-result", criteria: [{ id: "k1", text: "It exists" }],
    });
  });

  it("changes leave the card in review and point the lead at send back", () => {
    const a = toReview();
    reviewEnds(a.c, "changes", members);
    expect(cardState(a.c)).toBe("review");
    expect(leadNextStep(db, roomRequest(db, reviews(a.c)[0]!.id)!, { memberIds: members, viewer, name })).toMatchObject({ step: "send_back" });
    expect(acceptProjectCard(db, { cardId: a.c, actor: { kind: "lead", botId: "lead" }, now: 300 })).toMatchObject({ ok: false });
  });

  it("a review that finished without a verdict wakes the lead to decide, and the lead may accept", () => {
    const a = toReview();
    reviewEnds(a.c, null, members);
    expect(cardState(a.c)).toBe("review");
    expect(leadWokenWith(reviews(a.c)[0]!.id)).toBe(1);
    const review = roomRequest(db, reviews(a.c)[0]!.id)!;
    expect(review.outcomeNote).toBe("No verdict given");
    expect(leadNextStep(db, review, { memberIds: members, viewer, name })).toMatchObject({
      step: "decide", card: { id: a.c }, reviewer: "Reed", reviewers: [{ id: "lead", name: "Nova" }, { id: "rev", name: "Reed" }],
    });
    expect(acceptProjectCard(db, { cardId: a.c, actor: { kind: "lead", botId: "lead" }, now: 300 })).toMatchObject({ ok: true });
    expect(cardState(a.c)).toBe("done");
  });

  // review of 9ea1c2c7: a review that did not finish reviewed nothing (5.1a Failure)
  it.each([["failed", null], ["failed", "Stopped by you"], ["cancelled", "Stopped by you"], ["expired", null]] as const)("a review that ended %s (%s) asks for another review and the lead cannot accept", (state, note) => {
    const a = toReview();
    const review = reviews(a.c)[0]!;
    if (state !== "cancelled" && state !== "expired") markRequestDispatched(db, review.id, { now: 200 });
    completeRequest(db, review.id, { state, now: 220, outcomeNote: note }, hooks(members));
    expect(cardState(a.c)).toBe("review");
    expect(leadNextStep(db, roomRequest(db, review.id)!, { memberIds: members, viewer, name })).toMatchObject({ step: "review", card: { id: a.c } });
    expect(acceptProjectCard(db, { cardId: a.c, actor: { kind: "lead", botId: "lead" }, now: 300 })).toMatchObject({ ok: false });
  });

  it("a review that finished with another note (not shown the card, a late verdict) is reviewed again, not decided", () => {
    const a = toReview();
    const review = reviews(a.c)[0]!;
    markRequestDispatched(db, review.id, { now: 200 });
    completeRequest(db, review.id, { state: "done", now: 220, outcomeNote: "The reviewer could not be shown the card." }, hooks(members));
    expect(leadNextStep(db, roomRequest(db, review.id)!, { memberIds: members, viewer, name })).toMatchObject({ step: "review" });
    expect(acceptProjectCard(db, { cardId: a.c, actor: { kind: "lead", botId: "lead" }, now: 300 })).toMatchObject({ ok: false });
  });

  it("a verdict for a review that has ended is refused", () => {
    const a = toReview();
    reviewEnds(a.c, null, members);
    expect(applyReviewVerdict(db, { cardId: a.c, requestId: reviews(a.c)[0]!.id, reviewerBotId: "rev", verdict: "pass", now: 400 })).toMatchObject({ ok: false });
  });

  it("the verdict goes to whoever leads when the review ends", () => {
    const a = toReview();
    db.exec("UPDATE project_settings SET lead_bot_id='cole'");
    const withCole = [...members, "cole"];
    const review = reviews(a.c)[0]!;
    markRequestDispatched(db, review.id, { now: 200 });
    completeRequest(db, review.id, { state: "done", now: 220 }, hooks(withCole));
    expect(roomRequest(db, review.id)!.returnBotId).toBe("cole");
    expect(Number((db.prepare("SELECT count(*) AS n FROM room_requests WHERE verb='wake' AND to_bot_id='cole' AND admission_key=?").get(`wake:${review.id}`) as { n: number }).n)).toBe(1);
  });

  it("the lead cannot accept while the review is still running", () => {
    const a = toReview();
    markRequestDispatched(db, reviews(a.c)[0]!.id, { now: 200 });
    expect(acceptProjectCard(db, { cardId: a.c, actor: { kind: "lead", botId: "lead" }, now: 300 })).toMatchObject({ ok: false });
  });

  it("a review that asked a teammate first gives its verdict in its continuation, applied once", () => {
    const a = toReview();
    const review = reviews(a.c)[0]!;
    markRequestDispatched(db, review.id, { now: 200 });
    db.prepare("UPDATE room_requests SET state='waiting_bot' WHERE id=?").run(review.id);
    const next = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "rev", parentId: review.id, workItemId: a.c,
      cardGeneration: 1, admissionKey: `wake:${review.id}`, now: 230 }).request;
    markRequestDispatched(db, next.id, { now: 240 });
    expect(applyReviewVerdict(db, { cardId: a.c, requestId: review.id, reviewerBotId: "rev", verdict: "pass", now: 250 }).ok).toBe(true);
    completeRequest(db, next.id, { state: "done", now: 260 }, hooks(members));
    expect(roomRequest(db, review.id)!.state).toBe("done");
    expect(cardState(a.c)).toBe("done");
  });

  it("a verdict for a generation the card moved past changes nothing", () => {
    const a = toReview();
    const review = reviews(a.c)[0]!;
    markRequestDispatched(db, review.id, { now: 200 });
    db.prepare("UPDATE room_requests SET outcome_note='pass' WHERE id=?").run(review.id);
    db.prepare("UPDATE project_work_items SET generation=generation+1 WHERE id=?").run(a.c);
    completeRequest(db, review.id, { state: "done", now: 220 }, hooks(members));
    expect(cardState(a.c)).toBe("review");
  });
});
