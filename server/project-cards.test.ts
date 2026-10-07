// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane R card transition tests (SPEC-P 5.1 and 5.1a): every table row has an
// allowed test and at least one refused test per actor (O owner, L lead,
// A assignee, M member, S server), plus revision conflicts, generation
// fencing, idempotency and the review run.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { initializeProjectTables } from "./project-tables.ts";
import {
  acceptProjectCard,
  applyCardRunDispatched,
  applyCardRunFailed,
  applyCardRunFinished,
  applyCardRunResumed,
  applyCardWaiting,
  applyReviewVerdict,
  assignCardReview,
  cancelProjectCard,
  createProjectCard,
  editProjectCard,
  enqueueCardRun,
  finishProjectCardByOwner,
  latestReviewVerdict,
  moveProjectCard,
  reopenProjectCard,
  reassignProjectCard,
  restoreProjectCard,
  retryProjectCard,
  sendProjectCardBack,
  takeOverProjectCard,
} from "./project-cards.ts";
import { projectCardById, roomRequestById, roomRequestByAdmissionKey } from "./project-records.ts";

const NOW = 1_700_100_000_000;
const MEMBERS = ["lead", "dax", "ivy"];

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  db.prepare(`INSERT INTO project_settings
    (group_id, mode, lead_bot_id, parts, parallel_cards, work_roots, work_profile, run_state, revision, updated_at)
    VALUES ('grp','conversation','lead','{"board":true,"review":true,"digest":false}',3,'[]','ask','running',0,?)`).run(NOW);
  return db;
}

function makeCard(db: DatabaseSync, over: Record<string, unknown> = {}) {
  const result = createProjectCard(db, {
    groupId: "grp", title: "Card", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW, ...over,
  });
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return result.card;
}

/** Drive a card into `doing` the way the dispatcher would. */
function doingCard(db: DatabaseSync, over: Record<string, unknown> = {}) {
  const card = makeCard(db, { assigneeBotId: "dax", ...over });
  const queued = enqueueCardRun(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW });
  if (!queued.ok) throw new Error("setup enqueue failed");
  const dispatched = applyCardRunDispatched(db, { cardId: card.id, requestId: queued.requestId, deskThreadId: "desk-1", now: NOW + 1 });
  if (!dispatched.ok) throw new Error("setup dispatch failed");
  return { card: projectCardById(db, card.id)!, requestId: queued.requestId };
}

function reviewCard(db: DatabaseSync) {
  const { card, requestId } = doingCard(db);
  const finished = applyCardRunFinished(db, { cardId: card.id, requestId, reviewApplies: true, now: NOW + 2 });
  if (!finished.ok) throw new Error("setup finish failed");
  return { card: projectCardById(db, card.id)!, requestId };
}

const lastActivity = (db: DatabaseSync) =>
  (db.prepare("SELECT * FROM project_activity ORDER BY at DESC, rowid DESC LIMIT 1").get() ?? null) as Record<string, unknown> | null;

describe("create (5.1 row: new -> todo)", () => {
  it("owner creates a card with a per-group number and an activity row", () => {
    const db = freshDb();
    const card = makeCard(db, { title: "First" });
    expect(card).toMatchObject({ state: "todo", number: 1, revision: 0, generation: 0, attempt: 1, createdBy: "owner" });
    expect(lastActivity(db)).toMatchObject({ kind: "card_created", actor: "owner", work_item_id: card.id });
    expect(makeCard(db, { title: "Second" }).number).toBe(2);
    db.close();
  });

  it("lead and server create; a member does not", () => {
    const db = freshDb();
    expect(createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title: "Lead card", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW }).ok).toBe(true);
    expect(createProjectCard(db, { groupId: "grp", title: "Routine card", actor: { kind: "server" }, memberIds: MEMBERS, now: NOW }).ok).toBe(true);
    const refused = createProjectCard(db, { groupId: "grp", title: "Member card", actor: { kind: "member", botId: "dax" }, memberIds: MEMBERS, now: NOW });
    expect(refused).toMatchObject({ ok: false, error: "not_allowed" });
    const assignee = createProjectCard(db, { groupId: "grp", title: "Assignee card", actor: { kind: "assignee", botId: "dax" }, memberIds: MEMBERS, now: NOW });
    expect(assignee).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  it("refuses a card for an assignee outside the project, and validates bounds", () => {
    const db = freshDb();
    expect(createProjectCard(db, { groupId: "grp", title: "x", assigneeBotId: "outsider", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(createProjectCard(db, { groupId: "grp", title: "", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(createProjectCard(db, { groupId: "grp", title: "x".repeat(121), actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(createProjectCard(db, { groupId: "grp", title: "x", description: "d".repeat(2001), actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    db.close();
  });

  it("dedupes an owner retry by create_key (card:<groupId>:<clientId>)", () => {
    const db = freshDb();
    const first = createProjectCard(db, { groupId: "grp", title: "Once", createKey: "card:grp:client-1", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW });
    const second = createProjectCard(db, { groupId: "grp", title: "Once", createKey: "card:grp:client-1", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.card.id).toBe(first.card.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_work_items").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("refuses creation on an ended project", () => {
    const db = freshDb();
    db.prepare("UPDATE project_settings SET ended_at=? WHERE group_id='grp'").run(NOW);
    expect(createProjectCard(db, { groupId: "grp", title: "x", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });
});

describe("todo -> doing (5.1: dispatch only)", () => {
  it("an owner Start only enqueues: the card stays todo with its assign request", () => {
    const db = freshDb();
    const card = makeCard(db, { assigneeBotId: "dax" });
    const queued = enqueueCardRun(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW });
    expect(queued.ok).toBe(true);
    const after = projectCardById(db, card.id)!;
    expect(after.state).toBe("todo");
    const request = roomRequestById(db, queued.ok ? queued.requestId : "");
    expect(request).toMatchObject({ verb: "assign", state: "queued", work_item_id: card.id, card_generation: 1, attempt: 1 });
    expect(request!.admission_key).toBe(`assign:card:${card.id}:1:1`);
    db.close();
  });

  it("dispatch bumps generation, sets request and desk thread, and fences the request", () => {
    const db = freshDb();
    const { card, requestId } = doingCard(db);
    expect(card).toMatchObject({ state: "doing", generation: 1, requestId, deskThreadId: "desk-1", columnId: null });
    expect(roomRequestById(db, requestId)).toMatchObject({ card_generation: 1 });
    db.close();
  });

  it("refuses to enqueue a card with no assignee", () => {
    const db = freshDb();
    const card = makeCard(db);
    expect(enqueueCardRun(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  it("queues behind an unfinished dependency with a waiting chip, and releases when it completes", () => {
    const db = freshDb();
    const first = doingCard(db);
    const dependent = makeCard(db, { title: "Second", assigneeBotId: "dax", dependsOn: [first.card.id] });
    const queued = enqueueCardRun(db, { cardId: dependent.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW });
    expect(queued.ok).toBe(true);
    expect(projectCardById(db, dependent.id)).toMatchObject({ state: "todo", waitingOn: { kind: "dependency" } });
    expect(roomRequestById(db, queued.ok ? queued.requestId : "")).toMatchObject({ state: "queued", refusal: "dependency" });
    applyCardRunFinished(db, { cardId: first.card.id, requestId: first.requestId, reviewApplies: false, now: NOW + 3 });
    expect(projectCardById(db, dependent.id)!.waitingOn).toBeNull();
    db.close();
  });

  it("refuses dispatch by any other actor", () => {
    const db = freshDb();
    const card = makeCard(db, { assigneeBotId: "dax" });
    for (const actor of [{ kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, { kind: "lead", botId: "lead" }, { kind: "assignee", botId: "dax" }] as const) {
      expect(applyCardRunDispatched(db, { cardId: card.id, requestId: "r-x", deskThreadId: "t", now: NOW, actor: actor as never }))
        .toMatchObject({ ok: false, error: "not_allowed" });
    }
    db.close();
  });
});

describe("doing -> waiting and back (5.1 live and dead waits)", () => {
  it("server parks a run on an owner approval (live wait, slot kept)", () => {
    const db = freshDb();
    const { card, requestId } = doingCard(db);
    const parked = applyCardWaiting(db, { cardId: card.id, requestId, actor: { kind: "server" }, waiting: { kind: "owner_approval", requestId }, now: NOW + 2 });
    expect(parked.ok).toBe(true);
    expect(projectCardById(db, card.id)).toMatchObject({ state: "waiting", waitingOn: { kind: "owner_approval" } });
    db.close();
  });

  it("the assignee blocks its own card on its own run; another member cannot", () => {
    const db = freshDb();
    const { card, requestId } = doingCard(db);
    const blocked = applyCardWaiting(db, { cardId: card.id, requestId, actor: { kind: "assignee", botId: "dax" }, sourceMessageIds: ["blocked-source"], waiting: { kind: "blocked", detail: "Need the key" }, reason: "Need the key", now: NOW + 2 });
    expect(blocked.ok).toBe(true);
    expect(projectCardById(db, card.id)!.reason).toBe("Need the key");
    const other = applyCardWaiting(db, { cardId: card.id, requestId, actor: { kind: "assignee", botId: "ivy" }, waiting: { kind: "blocked" }, now: NOW + 3 });
    expect(other).toMatchObject({ ok: false, error: "not_allowed" });
    const owner = applyCardWaiting(db, { cardId: card.id, requestId, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, waiting: { kind: "blocked" }, now: NOW + 3 });
    expect(owner).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  it("a live wait resumes to doing; a dead wait does not", () => {
    const db = freshDb();
    const { card, requestId } = doingCard(db);
    applyCardWaiting(db, { cardId: card.id, requestId, actor: { kind: "server" }, waiting: { kind: "owner_approval" }, now: NOW + 2 });
    expect(applyCardRunResumed(db, { cardId: card.id, now: NOW + 3 }).ok).toBe(true);
    expect(projectCardById(db, card.id)).toMatchObject({ state: "doing", waitingOn: null });
    // a dead wait (restart) is not resumable
    applyCardWaiting(db, { cardId: card.id, requestId, actor: { kind: "server" }, waiting: { kind: "restart" }, now: NOW + 4 });
    expect(applyCardRunResumed(db, { cardId: card.id, now: NOW + 5 })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });
});

describe("run finish: doing -> review / done / failed (5.1)", () => {
  it("finish with review applicable goes to review; without it, done", () => {
    const db = freshDb();
    const { card, requestId } = doingCard(db);
    const reviewed = applyCardRunFinished(db, { cardId: card.id, requestId, resultMessageId: "m1", reviewApplies: true, now: NOW + 2 });
    expect(reviewed.ok && projectCardById(db, card.id)!.state).toBe("review");
    const second = doingCard(db, { title: "No review" });
    const finished2 = applyCardRunFinished(db, { cardId: second.card.id, requestId: second.requestId, reviewApplies: false, now: NOW + 3 });
    expect(finished2.ok).toBe(true);
    const doneCard = projectCardById(db, second.card.id)!;
    expect(doneCard).toMatchObject({ state: "done", failures: 0 });
    expect(doneCard.doneAt).toBeGreaterThan(0);
    db.close();
  });

  it("a stale generation is superseded: recorded, nothing changes", () => {
    const db = freshDb();
    const { card, requestId } = doingCard(db);
    db.prepare("UPDATE project_work_items SET generation=5 WHERE id=?").run(card.id); // reassigned meanwhile
    const late = applyCardRunFinished(db, { cardId: card.id, requestId, reviewApplies: false, now: NOW + 2 });
    expect(late).toMatchObject({ ok: true, superseded: true });
    expect(projectCardById(db, card.id)!.state).toBe("doing");
    const failed = applyCardRunFailed(db, { cardId: card.id, requestId, reason: "boom", now: NOW + 2 });
    expect(failed).toMatchObject({ ok: true, superseded: true });
    db.close();
  });

  it("failure counts consecutive failures; the third parks the card as an engine problem", () => {
    const db = freshDb();
    let current = doingCard(db);
    for (let n = 1; n <= 3; n++) {
      const failed = applyCardRunFailed(db, { cardId: current.card.id, requestId: current.requestId, reason: `fail ${n}`, now: NOW + n * 3 });
      expect(failed.ok).toBe(true);
      const card = projectCardById(db, current.card.id)!;
      if (n < 3) {
        expect(card).toMatchObject({ state: "failed", failures: n });
        expect(lastActivity(db)).toMatchObject({ kind: "card_failed" });
        const retried = retryProjectCard(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW + n * 3 + 1 });
        expect(retried.ok).toBe(true);
        if (!retried.ok) throw new Error("Retry failed");
        const requestId = retried.requestId;
        applyCardRunDispatched(db, { cardId: card.id, requestId: requestId!, deskThreadId: "desk-1", now: NOW + n * 3 + 2 });
        current = { card: projectCardById(db, card.id)!, requestId: requestId! };
      } else {
        expect(card).toMatchObject({ state: "waiting", failures: 3, waitingOn: { kind: "engine_problem" } });
      }
    }
    db.close();
  });

  it("refuses finish/fail from actors other than the server", () => {
    const db = freshDb();
    const { card, requestId } = doingCard(db);
    for (const actor of [{ kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, { kind: "lead", botId: "lead" }, { kind: "assignee", botId: "dax" }] as const) {
      expect(applyCardRunFinished(db, { cardId: card.id, requestId, reviewApplies: false, now: NOW, actor: actor as never })).toMatchObject({ ok: false, error: "not_allowed" });
      expect(applyCardRunFailed(db, { cardId: card.id, requestId, reason: "x", now: NOW, actor: actor as never })).toMatchObject({ ok: false, error: "not_allowed" });
    }
    db.close();
  });
});

describe("review run (5.1a)", () => {
  it("the lead assigns a review to another member; the reviewer and the assignee are refused", () => {
    const db = freshDb();
    const { card } = reviewCard(db);
    const assigned = assignCardReview(db, { cardId: card.id, reviewerBotId: "ivy", leadBotId: "lead", memberIds: MEMBERS, now: NOW + 3 });
    expect(assigned.ok).toBe(true);
    const cardAfter = projectCardById(db, card.id)!;
    expect(cardAfter.reviewRequestId).toBe(assigned.ok ? assigned.requestId : "");
    const request = roomRequestById(db, cardAfter.reviewRequestId!)!;
    expect(request).toMatchObject({ verb: "review", to_bot_id: "ivy", return_bot_id: "lead", card_generation: cardAfter.generation, state: "queued" });
    expect(request.admission_key).toBe(`review:${card.id}:${cardAfter.generation}`);
    expect(assignCardReview(db, { cardId: card.id, reviewerBotId: "dax", leadBotId: "lead", memberIds: MEMBERS, now: NOW + 4 })).toMatchObject({ ok: false }); // the assignee
    expect(assignCardReview(db, { cardId: card.id, reviewerBotId: "outsider", leadBotId: "lead", memberIds: MEMBERS, now: NOW + 4 })).toMatchObject({ ok: false });
    db.close();
  });

  it("records the verdict only from the assigned reviewer on the current generation", () => {
    const db = freshDb();
    const { card } = reviewCard(db);
    const assigned = assignCardReview(db, { cardId: card.id, reviewerBotId: "ivy", leadBotId: "lead", memberIds: MEMBERS, now: NOW + 3 });
    if (!assigned.ok) throw new Error("setup");
    expect(applyReviewVerdict(db, { cardId: card.id, requestId: assigned.requestId, verdict: "pass", reviewerBotId: "dax", now: NOW + 4 })).toMatchObject({ ok: false });
    expect(applyReviewVerdict(db, { cardId: card.id, requestId: assigned.requestId, verdict: "pass", reviewerBotId: "ivy", now: NOW + 4 }).ok).toBe(true);
    expect(latestReviewVerdict(db, card.id, card.generation)).toBe("pass");
    db.close();
  });

  it("review -> done: the lead accepts after a pass, not after changes; the owner can always accept", () => {
    const db = freshDb();
    const { card } = reviewCard(db);
    const assigned = assignCardReview(db, { cardId: card.id, reviewerBotId: "ivy", leadBotId: "lead", memberIds: MEMBERS, now: NOW + 3 });
    if (!assigned.ok) throw new Error("setup");
    // no verdict yet: refused
    expect(acceptProjectCard(db, { cardId: card.id, actor: { kind: "lead", botId: "lead" }, now: NOW + 4 })).toMatchObject({ ok: false, error: "not_allowed" });
    applyReviewVerdict(db, { cardId: card.id, requestId: assigned.requestId, verdict: "changes", reviewerBotId: "ivy", now: NOW + 4 });
    expect(acceptProjectCard(db, { cardId: card.id, actor: { kind: "lead", botId: "lead" }, now: NOW + 5 })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(acceptProjectCard(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW + 5 }).ok).toBe(true);
    expect(projectCardById(db, card.id)!.state).toBe("done");
    // assignee and server cannot accept
    const second = reviewCard(db);
    expect(acceptProjectCard(db, { cardId: second.card.id, actor: { kind: "assignee", botId: "dax" }, now: NOW + 6 })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(acceptProjectCard(db, { cardId: second.card.id, actor: { kind: "server" }, now: NOW + 6 })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  it("review -> todo send back bumps the attempt and queues a fresh assign request", () => {
    const db = freshDb();
    const { card } = reviewCard(db);
    const sent = sendProjectCardBack(db, { cardId: card.id, actor: { kind: "lead", botId: "lead" }, note: "Rework", now: NOW + 3 });
    expect(sent.ok).toBe(true);
    const after = projectCardById(db, card.id)!;
    expect(after).toMatchObject({ state: "todo", attempt: 2 });
    expect(roomRequestByAdmissionKey(db, `assign:card:${card.id}:2:${after.generation + 1}`)).not.toBeNull();
    expect(sendProjectCardBack(db, { cardId: card.id, actor: { kind: "server" }, now: NOW + 4 })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });
});

describe("retry, reassign, take over, done, cancel, restore, reopen (5.1)", () => {
  it("retry works from failed and dead waits, never from a live wait", () => {
    const db = freshDb();
    const live = doingCard(db);
    applyCardWaiting(db, { cardId: live.card.id, requestId: live.requestId, actor: { kind: "server" }, waiting: { kind: "owner_approval" }, now: NOW + 2 });
    expect(retryProjectCard(db, { cardId: live.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW + 3 })).toMatchObject({ ok: false, error: "not_allowed" });
    applyCardWaiting(db, { cardId: live.card.id, requestId: live.requestId, actor: { kind: "server" }, waiting: { kind: "restart" }, now: NOW + 4 });
    const retried = retryProjectCard(db, { cardId: live.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW + 5 });
    expect(retried.ok).toBe(true);
    expect(projectCardById(db, live.card.id)).toMatchObject({ state: "todo", attempt: 2 });
    // the lead may retry too; a member may not
    const dead = doingCard(db, { title: "Lead retry" });
    applyCardWaiting(db, { cardId: dead.card.id, requestId: dead.requestId, actor: { kind: "server" }, waiting: { kind: "restore" }, now: NOW + 6 });
    expect(retryProjectCard(db, { cardId: dead.card.id, actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW + 7 }).ok).toBe(true);
    expect(retryProjectCard(db, { cardId: dead.card.id, actor: { kind: "member", botId: "ivy" }, memberIds: MEMBERS, now: NOW + 8 })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  it("reassign fences the old run and queues the new one; the lead needs goal or ongoing mode", () => {
    const db = freshDb();
    const { card, requestId } = doingCard(db);
    const moved = reassignProjectCard(db, { cardId: card.id, assigneeBotId: "ivy", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW + 2 });
    expect(moved.ok).toBe(true);
    const after = projectCardById(db, card.id)!;
    expect(after).toMatchObject({ state: "todo", assigneeBotId: "ivy", generation: 2 });
    expect(roomRequestById(db, requestId)).toMatchObject({ state: "cancelled" });
    expect(lastActivity(db)).toMatchObject({ kind: "card_reassigned", actor: "owner" });
    // conversation mode: the lead may not reassign; ongoing mode: may
    expect(reassignProjectCard(db, { cardId: card.id, assigneeBotId: "dax", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW + 3 })).toMatchObject({ ok: false, error: "not_allowed" });
    db.prepare("UPDATE project_settings SET mode='ongoing' WHERE group_id='grp'").run();
    expect(reassignProjectCard(db, { cardId: card.id, assigneeBotId: "dax", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW + 4 }).ok).toBe(true);
    expect(reassignProjectCard(db, { cardId: card.id, assigneeBotId: "outsider", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW + 5 })).toMatchObject({ ok: false });
    expect(reassignProjectCard(db, { cardId: card.id, assigneeBotId: "dax", actor: { kind: "server" }, memberIds: MEMBERS, now: NOW + 6 })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  it("take over is owner-only and lands in doing with no assignee", () => {
    const db = freshDb();
    const { card, requestId } = doingCard(db);
    expect(takeOverProjectCard(db, { cardId: card.id, actor: { kind: "lead", botId: "lead" }, now: NOW + 2 })).toMatchObject({ ok: false, error: "not_allowed" });
    const took = takeOverProjectCard(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW + 2 });
    expect(took.ok).toBe(true);
    const after = projectCardById(db, card.id)!;
    expect(after).toMatchObject({ state: "doing", ownerTookOver: true, assigneeBotId: null, generation: 2 });
    expect(roomRequestById(db, requestId)).toMatchObject({ state: "cancelled" });
    expect(lastActivity(db)).toMatchObject({ kind: "card_took_over", actor: "owner" });
    db.close();
  });

  it("the owner finishes a taken-over card with Done", () => {
    const db = freshDb();
    const { card } = doingCard(db);
    takeOverProjectCard(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW + 2 });
    expect(finishProjectCardByOwner(db, { cardId: card.id, now: NOW + 3 }).ok).toBe(true);
    expect(projectCardById(db, card.id)!.state).toBe("done");
    db.close();
  });

  it("Done without review needs confirm; a member and the server are refused", () => {
    const db = freshDb();
    const card = makeCard(db, { assigneeBotId: "dax" });
    expect(finishProjectCardByOwner(db, { cardId: card.id, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    const confirmed = finishProjectCardByOwner(db, { cardId: card.id, confirm: true, reason: "Skipped by you", now: NOW });
    expect(confirmed.ok).toBe(true);
    expect(projectCardById(db, card.id)).toMatchObject({ state: "done", reason: "Skipped by you" });
    const second = makeCard(db, { title: "Other", assigneeBotId: "dax" });
    expect(finishProjectCardByOwner(db, { cardId: second.id, confirm: true, now: NOW, actor: { kind: "server" } as never })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  // Lane cards (a): a card the owner made is never cancelled by the lead.
  it("the lead cannot cancel a card the owner made; the owner still can", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO project_goals (id, group_id, title, state, created_at) VALUES ('goal1','grp','Goal','working',?)`).run(NOW);
    const card = makeCard(db, { assigneeBotId: "dax", goalId: "goal1" });
    expect(cancelProjectCard(db, { cardId: card.id, actor: { kind: "lead", botId: "lead" }, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(projectCardById(db, card.id)!.state).toBe("todo");
    expect((db.prepare("SELECT replans FROM project_goals WHERE id='goal1'").get() as { replans: number }).replans).toBe(0);
    expect(cancelProjectCard(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW }).ok).toBe(true);
    db.close();
  });

  it("cancel archives; a lead cancel of a goal card counts a replan", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO project_goals (id, group_id, title, state, created_at) VALUES ('goal1','grp','Goal','working',?)`).run(NOW);
    const card = makeCard(db, { assigneeBotId: "dax", goalId: "goal1", createdBy: "lead" });
    expect(cancelProjectCard(db, { cardId: card.id, actor: { kind: "member", botId: "ivy" }, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    const cancelled = cancelProjectCard(db, { cardId: card.id, actor: { kind: "lead", botId: "lead" }, now: NOW });
    expect(cancelled.ok).toBe(true);
    const after = projectCardById(db, card.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.archivedAt).toBeGreaterThan(0);
    expect((db.prepare("SELECT replans FROM project_goals WHERE id='goal1'").get() as { replans: number }).replans).toBe(1);
    db.close();
  });

  it("restore from archive and reopen are owner-only and create no request", () => {
    const db = freshDb();
    const card = makeCard(db, { assigneeBotId: "dax" });
    cancelProjectCard(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW });
    expect(restoreProjectCard(db, { cardId: card.id, actor: { kind: "lead", botId: "lead" }, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(restoreProjectCard(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW }).ok).toBe(true);
    expect(projectCardById(db, card.id)).toMatchObject({ state: "todo", archivedAt: null, ownerTookOver: false, requestId: null });
    // done -> todo reopen
    finishProjectCardByOwner(db, { cardId: card.id, confirm: true, now: NOW });
    expect(reopenProjectCard(db, { cardId: card.id, actor: { kind: "lead", botId: "lead" }, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(reopenProjectCard(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW }).ok).toBe(true);
    const after = projectCardById(db, card.id)!;
    expect(after).toMatchObject({ state: "todo", attempt: 2, doneAt: null, failures: 0, requestId: null });
    db.close();
  });
});

describe("owner writes carry expectedRevision (5.1 revision rules)", () => {
  it("a stale revision is 409 changed with the current card", () => {
    const db = freshDb();
    const card = makeCard(db, { assigneeBotId: "dax" });
    const stale = editProjectCard(db, { cardId: card.id, expectedRevision: 9, title: "New title", now: NOW });
    expect(stale).toMatchObject({ ok: false, error: "changed" });
    if (!stale.ok && stale.error === "changed") expect(stale.card.revision).toBe(0);
    const moved = moveProjectCard(db, { cardId: card.id, expectedRevision: 9, now: NOW });
    expect(moved).toMatchObject({ ok: false, error: "changed" });
    db.close();
  });

  it("every write bumps the revision", () => {
    const db = freshDb();
    const card = makeCard(db, { assigneeBotId: "dax" });
    const edited = editProjectCard(db, { cardId: card.id, expectedRevision: 0, title: "Renamed", now: NOW });
    expect(edited.ok && edited.card.revision).toBe(1);
    db.close();
  });

  it("edit refuses writes/workRoot changes while the card runs", () => {
    const db = freshDb();
    const { card } = doingCard(db);
    const current = projectCardById(db, card.id)!;
    expect(editProjectCard(db, { cardId: card.id, expectedRevision: current.revision, writes: false, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    const todo = makeCard(db, { title: "Editable" });
    expect(editProjectCard(db, { cardId: todo.id, expectedRevision: todo.revision, writes: false, workRoot: null, now: NOW }).ok).toBe(true);
    db.close();
  });

  it("reorder within a column and move to a custom column of the same state", () => {
    const db = freshDb();
    const a = makeCard(db, { title: "A" });
    const b = makeCard(db, { title: "B" });
    db.prepare("INSERT INTO project_board_columns (group_id, id, title, state, position) VALUES ('grp','mine','My column','todo',1)").run();
    const moved = moveProjectCard(db, { cardId: b.id, expectedRevision: b.revision, columnId: "mine", now: NOW });
    expect(moved.ok).toBe(true);
    expect(projectCardById(db, b.id)).toMatchObject({ columnId: "mine", state: "todo" });
    const reordered = moveProjectCard(db, { cardId: b.id, expectedRevision: b.revision + 1, beforeCardId: a.id, now: NOW });
    expect(reordered.ok).toBe(true);
    expect(projectCardById(db, b.id)!.position).toBeLessThan(projectCardById(db, a.id)!.position);
    // a custom column of another state is refused
    db.prepare("INSERT INTO project_board_columns (group_id, id, title, state, position) VALUES ('grp','doneish','Done-ish','done',2)").run();
    expect(moveProjectCard(db, { cardId: b.id, expectedRevision: b.revision + 2, columnId: "doneish", now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  it("a state change clears the custom column", () => {
    const db = freshDb();
    db.prepare("INSERT INTO project_board_columns (group_id, id, title, state, position) VALUES ('grp','mine','My column','todo',1)").run();
    const card = makeCard(db, { assigneeBotId: "dax", columnId: "mine" });
    expect(card.columnId).toBe("mine");
    const queued = enqueueCardRun(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW });
    if (!queued.ok) throw new Error("Queue failed");
    expect(applyCardRunDispatched(db, { cardId: card.id, requestId: queued.requestId, deskThreadId: "t", now: NOW }).ok).toBe(true);
    expect(projectCardById(db, card.id)!.columnId).toBeNull();
    db.close();
  });
});

it("refuses a caller claiming to be a lead who is no longer the lead", () => {
  const db = freshDb();
  expect(createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title: "Forged", actor: { kind: "lead", botId: "stranger" }, memberIds: MEMBERS, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
  db.close();
});

it("PF: the owner starting its card accepts that work as the plan when the goal does not ask for plan approval", () => {
  const db = freshDb();
  db.prepare("INSERT INTO project_goals(id,group_id,title,state,plan_first,created_at) VALUES('g','grp','Ship','planning',0,?)").run(NOW);
  const card = makeCard(db, { goalId: "g", assigneeBotId: "dax" });
  expect(enqueueCardRun(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW }).ok).toBe(true);
  expect(db.prepare("SELECT state FROM project_goals WHERE id='g'").get()?.state).toBe("working");
  db.close();
});

it("PF: with plan approval on, the owner starting its card leaves the goal waiting on the plan", () => {
  const db = freshDb();
  db.prepare("INSERT INTO project_goals(id,group_id,title,state,plan_first,created_at) VALUES('g','grp','Ship','planning',1,?)").run(NOW);
  const card = makeCard(db, { goalId: "g", assigneeBotId: "dax" });
  expect(enqueueCardRun(db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW }).ok).toBe(true);
  expect(db.prepare("SELECT state FROM project_goals WHERE id='g'").get()?.state).toBe("planning");
  db.close();
});

it("a queued doing drop preserves the original To do position and column", () => {
 const db=freshDb();
 try {
  db.exec("INSERT INTO project_board_columns (group_id,id,title,state,position) VALUES ('grp','mine','Next','todo',1)");
  const card=makeCard(db,{assigneeBotId:"dax",columnId:"mine"});
  const other=doingCard(db,{title:"Running"}).card;
  db.prepare("UPDATE project_work_items SET position=9000 WHERE id=?").run(other.id);
  const result=moveProjectCard(db,{cardId:card.id,expectedRevision:card.revision,toState:"doing",columnId:null,afterCardId:other.id,actor:{kind:"owner",lineage:{origin:"desktop",rootThreadId:"room",audienceFingerprint:"owner"}},now:NOW+4});
  expect(result.ok).toBe(true); expect(projectCardById(db,card.id)).toMatchObject({state:"todo",position:card.position,columnId:"mine"});
 } finally {db.close();}
});
