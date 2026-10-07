// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane E1 against the SPEC-P project tables: ProjectContext, generation
// fencing, and the stop rules after each lead wake (plan 3.2, SPEC-P 5.3).
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyCardRunEffect, cardGenerationCurrent, goalOpenCards, leadNextStep, projectContextFor, queueHeldReviewWakes, recordLeadWake, reviewWakeTarget } from "./project-turn-engine.ts";
import { deriveGroupedDecisions, pauseProjectGoal, resumeProjectGoal, stopProjectGoal } from "./project-goals.ts";
import { patchProjectSettings } from "./project-settings.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { applyCardRunDispatched, applyCardRunFinished, enqueueCardRun, retryProjectCard, reassignProjectCard, sendProjectCardBack, cancelProjectCard, takeOverProjectCard } from "./project-cards.ts";
import { createRoomDispatcher } from "./room-dispatcher.ts";
import { createWorkAdmission } from "./work-admission.ts";
import { cancelRoomRequest, completeRequest, insertRoomRequest, markRequestDispatched, roomRequest, reconcileRoomRequestsAtBoot } from "./room-requests.ts";

// The lead's wake: its bot and thread (the partition check runs for them;
// unpartitioned here, so it passes: shared-bots-leak.test.ts covers it).
const viewer = { botId: "lead", threadId: "room" };

let db: DatabaseSync;
const flags = { lead: true, board: true, goals: true, parallelCards: true };
const lineage = { rootThreadId: "t", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };

function settings(extra: Record<string, unknown> = {}) {
  const row = { group_id: "g", mode: "conversation", lead_bot_id: "lead", parts: "{}", parallel_cards: 3, work_roots: "[]", work_profile: "ask", run_state: "running", updated_at: 1, ...extra };
  db.prepare(`INSERT INTO project_settings (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row) as Array<string | number | null>);
}
function goal(extra: Record<string, unknown> = {}) {
  const row = { id: "goal", group_id: "g", title: "Ship", criteria: "[]", state: "working", created_at: 1, ...extra };
  db.prepare(`INSERT INTO project_goals (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row) as Array<string | number | null>);
}
let number = 0;
function card(extra: Record<string, unknown> = {}) {
  number += 1;
  const row = { id: `c${number}`, group_id: "g", goal_id: "goal", number, title: `Card ${number}`, state: "todo", position: number, created_by: "lead", created_at: 1, updated_at: 1, ...extra };
  db.prepare(`INSERT INTO project_work_items (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row) as Array<string | number | null>);
  return row.id as string;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  
  number = 0;
});

describe("ProjectContext (SPEC-P 7.1)", () => {
  it("a group without an open settings row, or without the tables, is a channel", () => {
    expect(projectContextFor(db, { groupId: "g", flags }).isProject).toBe(false);
    const bare = new DatabaseSync(":memory:");
    expect(projectContextFor(bare, { groupId: "g", flags })).toMatchObject({ isProject: false, mode: "conversation" });
    settings({ ended_at: 5 });
    expect(projectContextFor(db, { groupId: "g", flags }).isProject).toBe(false);
  });
  it("reads the settings and the active goal", () => {
    settings({ run_state: "paused", mode: "ongoing", parallel_cards: 2, parts: JSON.stringify({ board: false }) });
    goal({ state: "awaiting_plan_ok" });
    expect(projectContextFor(db, { groupId: "g", flags })).toMatchObject({ isProject: true, runState: "paused", mode: "ongoing", leadBotId: "lead", boardOn: false, parallelCards: 2, goalId: "goal", goalState: "awaiting_plan_ok" });
  });
  it("folds the flags in without writing a row", () => {
    settings();
    goal();
    expect(projectContextFor(db, { groupId: "g", flags: { lead: false, board: false, goals: false, parallelCards: false } })).toMatchObject({ leadBotId: null, boardOn: false, parallelCards: 1, goalState: "paused" });
    expect((db.prepare("SELECT state FROM project_goals").get() as { state: string }).state).toBe("working");
  });
});

describe("generation fencing (SPEC-P 5.1)", () => {
  it("a run whose card moved on is fenced: it settles, moves nothing, wakes nobody", () => {
    settings(); goal();
    const cardId = card({ state: "doing", generation: 2 });
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r", lineage, now: 1 }).request;
    const stale = insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "bot", toBotId: "jax", parentId: root.id, admissionKey: "a1", workItemId: cardId, cardGeneration: 1, returnBotId: "lead", returnThreadId: "t", now: 2 }).request;
    const current = insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "bot", toBotId: "kim", parentId: root.id, admissionKey: "a2", workItemId: cardId, cardGeneration: 2, returnBotId: "lead", returnThreadId: "t", now: 3 }).request;
    expect(cardGenerationCurrent(db, stale)).toBe(false);
    expect(cardGenerationCurrent(db, current)).toBe(true);
    markRequestDispatched(db, stale.id, { now: 4 });
    const settled: string[] = [], moved: string[] = [];
    const hooks = { cardGenerationCurrent, settleUsage: (_: DatabaseSync, q: { id: string }) => { settled.push(q.id); }, cardEffect: (_: DatabaseSync, q: { id: string }) => { moved.push(q.id); } };
    const late = completeRequest(db, stale.id, { state: "done", now: 5 }, hooks);
    expect(late.request.outcomeNote).toBe("superseded");
    expect(late.wakes).toEqual([]);
    expect(settled).toEqual([stale.id]);
    expect(moved).toEqual([]);
    markRequestDispatched(db, current.id, { now: 6 });
    const fresh = completeRequest(db, current.id, { state: "done", now: 7 }, hooks);
    expect(moved).toEqual([current.id]);
    expect(fresh.wakes).toHaveLength(1);
    expect(roomRequest(db, current.id)!.outcomeNote).toBeNull();
  });
});

describe("stop rules after a lead wake (SPEC-P 5.3)", () => {
  beforeEach(() => { settings(); goal(); });

  it("three wakes without progress pause the goal, naming what stalled", () => {
    card({ title: "Pricing page", state: "todo" });
    expect(recordLeadWake(db, { goalId: "goal", since: 0, now: 10_000_000 }).pause).toBeUndefined();
    expect(recordLeadWake(db, { goalId: "goal", since: 0, now: 10_000_000 }).pause).toBeUndefined();
    const third = recordLeadWake(db, { goalId: "goal", since: 0, now: 10_000_000 });
    expect(third.noProgress).toBe(3);
    expect(third.pause).toBe('Paused: 3 team steps without progress on "Pricing page". Open the goal and press Resume.');
    expect((db.prepare("SELECT lead_wakes, no_progress FROM project_goals").get() as Record<string, number>)).toEqual({ lead_wakes: 3, no_progress: 3 });
  });

  it("a card moving into review, a criterion met or an owner reply is progress and resets the count", () => {
    const moved = card({ state: "review", updated_at: 500 });
    db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, work_item_id, detail) VALUES ('m1','g',500,'card_moved','server',?,?)").run(moved, JSON.stringify({ from: "doing", to: "review" }));
    db.prepare("UPDATE project_goals SET no_progress=2").run();
    expect(recordLeadWake(db, { goalId: "goal", since: 100, now: 10_000_000 })).toMatchObject({ progressed: true, noProgress: 0 });
    // the same card again, long ago: not progress now; nor is an edit to it
    db.prepare("UPDATE project_work_items SET updated_at=700, description='edited'").run();
    expect(recordLeadWake(db, { goalId: "goal", since: 600, now: 10_000_000 }).progressed).toBe(false);
    db.prepare("UPDATE project_goals SET criteria=?").run(JSON.stringify([{ id: "k", text: "x", setBy: "owner", proposed: false, met: true, evidence: { kind: "message", ref: "m", workItemId: "c1", attempt: 1, at: 900 } }]));
    expect(recordLeadWake(db, { goalId: "goal", since: 800, now: 10_000_000 }).progressed).toBe(true);
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "o", lineage, now: 1000 }).request;
    completeRequest(db, root.id, { state: "done", now: 1000 });
    expect(recordLeadWake(db, { goalId: "goal", since: 950, now: 10_000_000 }).progressed).toBe(true);
  });

  it("only a card's first move into review or done in its attempt is progress", () => {
    const c = card({ state: "done", updated_at: 400 });
    const move = (id: string, at: number, to: string) => db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, work_item_id, detail) VALUES (?,'g',?,'card_moved','server',?,?)").run(id, at, c, JSON.stringify({ to }));
    move("a1", 200, "review");
    move("a2", 400, "done"); // the same attempt: review then done is one advance
    expect(recordLeadWake(db, { goalId: "goal", since: 300, now: 10_000_000 }).progressed).toBe(false);
    move("a3", 500, "todo"); // sent back: a new attempt
    move("a4", 600, "review");
    expect(recordLeadWake(db, { goalId: "goal", since: 550, now: 10_000_000 }).progressed).toBe(true);
  });

  it("a card run lane R finishes (card_result into review) is progress", () => {
    const c = card({ assignee_bot_id: "jax" });
    const queued = enqueueCardRun(db, { cardId: c, actor: { kind: "server" }, now: 150 });
    if (!queued.ok) throw new Error(queued.reason);
    expect(applyCardRunDispatched(db, { cardId: c, requestId: queued.requestId, deskThreadId: "desk", now: 160 }).ok).toBe(true);
    expect(recordLeadWake(db, { goalId: "goal", since: 100, now: 10_000_000 }).progressed).toBe(false);
    expect(applyCardRunFinished(db, { cardId: c, requestId: queued.requestId, reviewApplies: true, now: 200 }).ok).toBe(true);
    expect(recordLeadWake(db, { goalId: "goal", since: 170, now: 10_000_000 })).toMatchObject({ progressed: true, noProgress: 0 });
  });

  it("an unreadable plan is a wake without progress", () => {
    const moved = card({ state: "review", updated_at: 500 });
    db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, work_item_id, detail) VALUES ('m2','g',500,'card_moved','server',?,?)").run(moved, JSON.stringify({ from: "doing", to: "review" }));
    expect(recordLeadWake(db, { goalId: "goal", since: 100, now: 10_000_000, unreadable: true }).progressed).toBe(false);
  });

  it("a card working with real recent activity suspends the stall count; a row update is not activity", () => {
    const now = 10_000_000;
    const busy = card({ state: "doing", updated_at: now - 60_000 });
    db.prepare("UPDATE project_goals SET no_progress=2").run();
    const suspended = recordLeadWake(db, { goalId: "goal", since: now - 1_000, now, cardActive: (row) => row.id === busy });
    expect(suspended.noProgress).toBe(2);
    expect(suspended.pause).toBeUndefined();
    expect(recordLeadWake(db, { goalId: "goal", since: now - 1_000, now }).pause).toMatch(/3 team steps without progress/);
  });

  it("a limit passed by more than one in a single window still pauses", () => {
    for (let i = 0; i < 4; i += 1) card({ title: "Same job", assignee_bot_id: "jax", created_at: 10 + i, state: "cancelled" });
    expect(recordLeadWake(db, { goalId: "goal", since: 5, now: 10_000_000 }).pause).toMatch(/assigned 3 times/);
  });

  it("the same assignment a third time, the same card failing a third time, and a hand-back cycle each pause once", () => {
    for (let i = 0; i < 3; i += 1) card({ title: "Write  the FAQ", assignee_bot_id: "jax", created_at: 10 + i, state: "cancelled" });
    expect(recordLeadWake(db, { goalId: "goal", since: 5, now: 10_000_000 }).pause).toMatch(/assigned 3 times/);
    expect(recordLeadWake(db, { goalId: "goal", since: 50, now: 10_000_000 }).pause).toBeUndefined();
    const deploy = card({ title: "Deploy", failures: 3, updated_at: 100 });
    db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, work_item_id, detail) VALUES ('f3','g',100,'card_failed','server',?,'{}')").run(deploy);
    expect(recordLeadWake(db, { goalId: "goal", since: 60, now: 10_000_000 }).pause).toBe('Paused: "Deploy" failed 3 times. Open the goal and press Resume.');
    // an edit to that card after the owner resumed is not a new failure
    db.prepare("UPDATE project_work_items SET updated_at=180 WHERE id=?").run(deploy);
    expect(recordLeadWake(db, { goalId: "goal", since: 150, now: 10_000_000 }).pause ?? "").not.toMatch(/failed 3 times/);
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "rr", lineage, now: 1 }).request;
    const asked = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "dax", toBotId: "moss", parentId: root.id, projectGoalId: "goal", admissionKey: "x1", now: 200, payloadText: "Check the deploy logs" }).request;
    insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "bot", fromBotId: "moss", toBotId: "dax", parentId: asked.id, projectGoalId: "goal", admissionKey: "x2", now: 210, payloadText: "Check the deploy logs." });
    const names: Record<string, string> = { dax: "Dax", moss: "Moss" };
    expect(recordLeadWake(db, { goalId: "goal", since: 150, now: 10_000_000, botName: (id) => names[id] }).pause).toBe("Paused: Dax and Moss keep handing the same work back to each other. Open the goal and press Resume.");
  });

  // Round 14 (B2): the pause line reaches the room and the goal strip; a
  // stale card is named by its number, never by its title.
  describe("a pause line never quotes a stale card's title", () => {
    const removed = "(its details are left out: they cite something the owner removed)";
    it("assigned three times", () => {
      for (let i = 0; i < 3; i += 1) card({ title: "Call Dana at home", assignee_bot_id: "jax", created_at: 10 + i, state: "cancelled", stale: 1 });
      const line = recordLeadWake(db, { goalId: "goal", since: 5, now: 10_000_000 }).pause!;
      expect(line).toBe(`Paused: card 3 ${removed} was assigned 3 times without finishing. Open the goal and press Resume.`);
    });
    it("failed three times", () => {
      const failed = card({ title: "Call Dana at home", failures: 3, updated_at: 100, stale: 1 });
      db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, work_item_id, detail) VALUES ('f3','g',100,'card_failed','server',?,'{}')").run(failed);
      const line = recordLeadWake(db, { goalId: "goal", since: 60, now: 10_000_000 }).pause!;
      expect(line).toBe(`Paused: card 1 ${removed} failed 3 times. Open the goal and press Resume.`);
    });
    it("no progress", () => {
      card({ title: "Pricing page", state: "todo" });
      card({ title: "Call Dana at home", state: "todo", stale: 1 });
      for (let i = 0; i < 2; i += 1) recordLeadWake(db, { goalId: "goal", since: 0, now: 10_000_000 });
      const line = recordLeadWake(db, { goalId: "goal", since: 0, now: 10_000_000 }).pause!;
      expect(line).toBe(`Paused: 3 team steps without progress on "Pricing page", card 2 ${removed}. Open the goal and press Resume.`);
    });
  });

  // AFTER-PF finiteCards: Nova assigned Wren a card, Wren asked Nova one
  // question from it, and the goal paused as a hand-back loop.
  describe("a request cycle (SPEC-P 5.3 loop checks) is work handed back, not a question", () => {
    // Every hop carries what it asks for: a cycle is the SAME work handed
    // back (SPEC-P 5.3 "the same assignment"), so the texts matter.
    const hop = (verb: "ask" | "assign", from: string, to: string, parentId: string, key: string, now: number, payloadText = "Write the pricing FAQ") =>
      insertRoomRequest(db, { groupId: "g", verb, fromKind: "bot", fromBotId: from, toBotId: to, parentId, projectGoalId: "goal", admissionKey: key, now, payloadText }).request;
    const rootId = () => insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "nova", admissionKey: "root", lineage, now: 1 }).request.id;
    const pause = () => recordLeadWake(db, { goalId: "goal", since: 150, now: 10_000_000, botName: (id) => ({ nova: "Nova", wren: "Wren", reed: "Reed" })[id] ?? id }).pause;

    it("assign, then one question back to the assigner: no pause", () => {
      const root = rootId();
      const assigned = hop("assign", "nova", "wren", root, "h1", 200);
      hop("ask", "wren", "nova", assigned.id, "h2", 210);
      expect(pause()).toBeUndefined();
    });
    it("ask, then one question back: no pause", () => {
      const root = rootId();
      hop("ask", "nova", "wren", root, "h1", 200);
      hop("ask", "wren", "nova", root, "h2", 210);
      expect(pause()).toBeUndefined();
    });
    it("assign, then the work assigned back: pause", () => {
      const root = rootId();
      const assigned = hop("assign", "nova", "wren", root, "h1", 200);
      hop("assign", "wren", "nova", assigned.id, "h2", 210);
      expect(pause()).toBe("Paused: Nova and Wren keep handing the same work back to each other. Open the goal and press Resume.");
    });
    it("ask, ask back, ask again, each from the one before: pause", () => {
      const root = rootId();
      const first = hop("ask", "nova", "wren", root, "h1", 200);
      const back = hop("ask", "wren", "nova", first.id, "h2", 210);
      hop("ask", "nova", "wren", back.id, "h3", 220);
      expect(pause()).toBe("Paused: Nova and Wren keep handing the same work back to each other. Open the goal and press Resume.");
    });
    // Round 12 (H1): two opposite hops in one root are not a hand-back
    // unless the second came from the first.
    it("assign card 1, a question from it, then card 2 assigned from the lead's own wake: no pause", () => {
      const root = rootId();
      const card1 = hop("assign", "nova", "wren", root, "h1", 200);
      hop("ask", "wren", "nova", card1.id, "h2", 210);
      hop("assign", "nova", "wren", root, "h3", 220);
      expect(pause()).toBeUndefined();
    });
    // Round 13 (A1): a lead's card is parented to the request its turn
    // serves, so card 2, made in the turn answering Wren's ask, descends
    // from that ask. The lead making a card is not work handed back.
    // a card run carries no text of its own: its work is the card
    const cardHop = (from: string, to: string, parentId: string, key: string, now: number, workItemId: string, title = "Write the pricing FAQ") => {
      if (!db.prepare("SELECT 1 FROM project_work_items WHERE id=?").get(workItemId)) card({ id: workItemId, title, assignee_bot_id: to });
      return insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "bot", fromBotId: from, toBotId: to, parentId, projectGoalId: "goal", admissionKey: key, workItemId, now }).request;
    };
    it("card 1, a question from it, then card 2 made by the lead in the turn answering that question: no pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const card1 = cardHop("nova", "wren", root, "h1", 200, "c1", "Draft the launch plan");
      const asked = hop("ask", "wren", "nova", card1.id, "h2", 210, "Which customer segments should the plan use?");
      cardHop("nova", "wren", asked.id, "h3", 220, "c2", "List three customer segments");
      expect(pause()).toBeUndefined();
    });
    // Round 14 (B1): a delegation is work handed over, not a question: the
    // lead giving it straight back as a card is a hand-back.
    it("a member delegating to the lead, then the lead reassigning it back as a card: pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const delegated = hop("ask", "wren", "nova", root, "ask:delegation:d1", 200);
      cardHop("nova", "wren", delegated.id, "h2", 210, "c1");
      expect(pause()).toBe("Paused: Wren and Nova keep handing the same work back to each other. Open the goal and press Resume.");
    });
    it("a member (not the lead) handing the lead's ask back as a card: pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const asked = hop("ask", "nova", "wren", root, "h1", 200);
      cardHop("wren", "nova", asked.id, "h2", 210, "c1");
      expect(pause()).toBe("Paused: Nova and Wren keep handing the same work back to each other. Open the goal and press Resume.");
    });
    it("the lead handing a member's assignment back as a card: pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const assigned = hop("assign", "wren", "nova", root, "h1", 200);
      cardHop("nova", "wren", assigned.id, "h2", 210, "c1");
      expect(pause()).toBe("Paused: Wren and Nova keep handing the same work back to each other. Open the goal and press Resume.");
    });
    it("three unrelated questions over a long goal in one root: no pause", () => {
      const root = rootId();
      hop("ask", "nova", "wren", root, "h1", 200);
      hop("ask", "wren", "nova", root, "h2", 210);
      hop("ask", "nova", "wren", root, "h3", 220);
      expect(pause()).toBeUndefined();
    });
    it("work assigned back a few hops further down the same chain: pause", () => {
      const root = rootId();
      const assigned = hop("assign", "nova", "wren", root, "h1", 200);
      const wake = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "wren", parentId: assigned.id, projectGoalId: "goal", admissionKey: "h1w", now: 205 }).request;
      hop("assign", "wren", "nova", wake.id, "h2", 210);
      expect(pause()).toBe("Paused: Nova and Wren keep handing the same work back to each other. Open the goal and press Resume.");
    });
    // Round 12 (H2): delegate_bot is an ask with a delegation key, and it
    // hands work over like an assign.
    it("ask, then the work handed back with delegate_bot: pause", () => {
      const root = rootId();
      const asked = hop("ask", "nova", "wren", root, "h1", 200);
      hop("ask", "wren", "nova", asked.id, "ask:delegation:d1", 210);
      expect(pause()).toBe("Paused: Nova and Wren keep handing the same work back to each other. Open the goal and press Resume.");
    });
    // AFTER-REVIEW (0.1.61 review): both goals paused 1 to 2
    // minutes in. Wren, on the card Nova gave her, used delegate_bot to ask
    // Nova for inputs. A question for inputs is not the card handed back.
    it("finiteGoal: a member delegating a question for inputs to the lead from its card: no pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const assigned = cardHop("nova", "wren", root, "h1", 200, "c1", "Plan four-week launch timeline with owners");
      hop("ask", "wren", "nova", assigned.id, "ask:delegation:d1", 210, "Nova, I'm building the four-week launch timeline for Tallyroo. I need a quick brief: What are the main launch goals or deliverables? What are the team members' roles? And are there any hard constraints (like a specific launch date, budget, or dependencies)? One or two sentences each is fine.");
      expect(pause()).toBeUndefined();
    });
    it("finiteCards: a member delegating 'has Cole finished?' to the lead from its card, quoting the card's work: no pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const assigned = cardHop("nova", "wren", root, "h1", 200, "c1", "Write LAUNCH-PLAN.md");
      hop("ask", "wren", "nova", assigned.id, "ask:delegation:d1", 210, "Hi Nova, I'm ready to write LAUNCH-PLAN.md but I need Cole's output on card 2 (pricing). Has Cole finished their work on Tallyroo's real pricing and founding offer?");
      expect(pause()).toBeUndefined();
    });
    it("the lead answering that delegation with a different card for the member: no pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const assigned = cardHop("nova", "wren", root, "h1", 200, "c1", "Write LAUNCH-PLAN.md");
      const asked = hop("ask", "wren", "nova", assigned.id, "ask:delegation:d1", 210, "I need the pricing first. Where is it?");
      cardHop("nova", "wren", asked.id, "h3", 220, "c2", "Add the FOUNDER40 pricing to the plan");
      expect(pause()).toBeUndefined();
    });
    // lane cards (c): a member delegating to its lead is not a hand-back to the owner
    it("a member delegating a hand-off to its lead, even repeating the card's work: no pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const assigned = cardHop("nova", "wren", root, "h1", 200, "c1", "Write LAUNCH-PLAN.md");
      hop("ask", "wren", "nova", assigned.id, "ask:delegation:d1", 210, "Write LAUNCH-PLAN.md please.");
      expect(pause()).toBeUndefined();
    });
    it("a member delegating to its lead twice from the same card: no pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const assigned = cardHop("nova", "wren", root, "h1", 200, "c1", "Write LAUNCH-PLAN.md");
      hop("ask", "wren", "nova", assigned.id, "ask:delegation:d1", 210, "Write LAUNCH-PLAN.md please.");
      hop("ask", "wren", "nova", assigned.id, "ask:delegation:d2", 220, "Write LAUNCH-PLAN.md please.");
      expect(pause()).toBeUndefined();
    });
    it("a member delegating the card's work to another member who delegates it back: pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const first = hop("ask", "wren", "reed", root, "ask:delegation:d1", 200, "Write the pricing FAQ");
      hop("ask", "reed", "wren", first.id, "ask:delegation:d2", 210, "Write the pricing FAQ");
      expect(pause()).toBe("Paused: Wren and Reed keep handing the same work back to each other. Open the goal and press Resume.");
    });
    it("a member assigning the very card back to the lead: pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const assigned = cardHop("nova", "wren", root, "h1", 200, "c1", "Write LAUNCH-PLAN.md");
      cardHop("wren", "nova", assigned.id, "h2", 210, "c1");
      expect(pause()).toBe("Paused: Nova and Wren keep handing the same work back to each other. Open the goal and press Resume.");
    });
    it("a member asking the lead to do X, and the lead making X a card for that member: pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const asked = hop("ask", "wren", "nova", root, "h1", 200, "Please write the pricing FAQ");
      cardHop("nova", "wren", asked.id, "h2", 210, "c1", "Write the pricing FAQ");
      expect(pause()).toBe("Paused: Wren and Nova keep handing the same work back to each other. Open the goal and press Resume.");
    });
    // Review of 92888c89: a short title quoted in a short request for
    // inputs, and a member offering to do the work, are not hand-backs.
    it("a short card title quoted in a short question for inputs: no pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const assigned = cardHop("nova", "wren", root, "h1", 200, "c1", "Write LAUNCH-PLAN.md");
      hop("ask", "wren", "nova", assigned.id, "ask:delegation:d1", 210, "Blocked on Write LAUNCH-PLAN.md: pricing?");
      expect(pause()).toBeUndefined();
    });
    it("a short card title inside a longer request for inputs: no pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const assigned = cardHop("nova", "wren", root, "h1", 200, "c1", "Draft the launch plan");
      hop("ask", "wren", "nova", assigned.id, "ask:delegation:d1", 210, "Need pricing for draft the launch plan");
      expect(pause()).toBeUndefined();
    });
    it("a member offering to do X, and the lead making X that member's card: no pause", () => {
      db.exec("UPDATE project_settings SET lead_bot_id='nova'");
      const root = rootId();
      const asked = hop("ask", "wren", "nova", root, "h1", 200, "Want me to write the pricing FAQ?");
      cardHop("nova", "wren", asked.id, "h2", 210, "c1", "Write the pricing FAQ");
      expect(pause()).toBeUndefined();
    });
    it("an assignment whose own text asks something, handed back nearly word for word: pause", () => {
      const root = rootId();
      const assigned = hop("assign", "nova", "wren", root, "h1", 200, "Write the full pricing FAQ?");
      hop("ask", "wren", "nova", assigned.id, "ask:delegation:d1", 210, "Write the full pricing FAQ please");
      expect(pause()).toBe("Paused: Nova and Wren keep handing the same work back to each other. Open the goal and press Resume.");
    });
    it("work assigned back with different work: no pause", () => {
      const root = rootId();
      const assigned = hop("assign", "nova", "wren", root, "h1", 200, "Write the pricing FAQ");
      hop("assign", "wren", "nova", assigned.id, "h2", 210, "Send me the price list");
      expect(pause()).toBeUndefined();
    });
    it("a question and answer exchange, each question from the one before: no pause", () => {
      const root = rootId();
      const first = hop("ask", "nova", "wren", root, "h1", 200, "What does the founding offer include?");
      const back = hop("ask", "wren", "nova", first.id, "h2", 210, "Do you mean the annual or the monthly plan?");
      hop("ask", "nova", "wren", back.id, "h3", 220, "The annual plan, with the FOUNDER40 code.");
      expect(pause()).toBeUndefined();
    });
    it("a delegation, then one question back to the delegator: no pause", () => {
      const root = rootId();
      const delegated = hop("ask", "nova", "wren", root, "ask:delegation:d1", 200);
      hop("ask", "wren", "nova", delegated.id, "h2", 210);
      expect(pause()).toBeUndefined();
    });
    it("the same hops in different roots are not a cycle", () => {
      hop("assign", "nova", "wren", rootId(), "h1", 200);
      const other = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "nova", admissionKey: "root2", lineage, now: 2 }).request.id;
      hop("assign", "wren", "nova", other, "h2", 210);
      expect(pause()).toBeUndefined();
    });
  });

  it("every pause line tells the owner how to go on", () => {
    card({ title: "Same job", assignee_bot_id: "jax", created_at: 10, state: "cancelled" });
    card({ title: "Same job", assignee_bot_id: "jax", created_at: 11, state: "cancelled" });
    card({ title: "Same job", assignee_bot_id: "jax", created_at: 12, state: "cancelled" });
    expect(recordLeadWake(db, { goalId: "goal", since: 5, now: 10_000_000 }).pause).toBe('Paused: "Same job" was assigned 3 times without finishing. Open the goal and press Resume.');
    db.prepare("UPDATE project_goals SET replans=3").run();
    db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, detail) VALUES ('rp','g',300,'card_moved','lead',?)").run(JSON.stringify({ from: "todo", to: "cancelled" }));
    expect(recordLeadWake(db, { goalId: "goal", since: 200, now: 10_000_000 }).pause).toBe("Paused: the lead wants to replan a third time. Look at the plan, then open the goal and press Resume.");
  });

  it("a third replan pauses the goal in the wake it happens", () => {
    db.prepare("UPDATE project_goals SET replans=3").run();
    db.prepare("INSERT INTO project_activity (id, group_id, at, kind, actor, detail) VALUES ('a1','g',300,'card_moved','lead',?)").run(JSON.stringify({ from: "todo", to: "cancelled" }));
    expect(recordLeadWake(db, { goalId: "goal", since: 200, now: 10_000_000 }).pause).toMatch(/replan a third time/);
    expect(recordLeadWake(db, { goalId: "goal", since: 400, now: 10_000_000 }).pause).toBeUndefined();
  });

  // Round 12 (L3): the goal keeps 200 characters of the reason; long titles
  // and names are cut, never the way to go on.
  it("a pause line with long titles or long names still ends with the way to go on, within what the goal keeps", () => {
    for (let i = 0; i < 3; i += 1) card({ title: `${"Research every competitor pricing page in the market ".repeat(2)}${i}`, state: "todo" });
    for (let i = 0; i < 2; i += 1) recordLeadWake(db, { goalId: "goal", since: 0, now: 10_000_000 });
    const stalled = recordLeadWake(db, { goalId: "goal", since: 0, now: 10_000_000 }).pause!;
    expect(stalled).toMatch(/^Paused: 3 team steps without progress on "Research every/);
    expect(stalled.endsWith(" Open the goal and press Resume.")).toBe(true);
    expect(stalled.length).toBeLessThanOrEqual(200);
    expect(pauseProjectGoal(db, { goalId: "goal", reason: stalled, actor: { kind: "server" }, now: 1 }).ok).toBe(true);
    expect((db.prepare("SELECT state_reason FROM project_goals").get() as { state_reason: string }).state_reason).toBe(stalled);
    const root = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "nova", admissionKey: "root", lineage, now: 1 }).request;
    const asked = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "nova", toBotId: "wren", parentId: root.id, projectGoalId: "goal", admissionKey: "l1", now: 200, payloadText: "Summarise the competitor pages" }).request;
    insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "bot", fromBotId: "wren", toBotId: "nova", parentId: asked.id, projectGoalId: "goal", admissionKey: "l2", now: 210, payloadText: "Summarise the competitor pages" });
    const long = (id: string) => `${id} the very thorough research and writing assistant `.repeat(3);
    const cycle = recordLeadWake(db, { goalId: "goal", since: 150, now: 10_000_000, botName: long }).pause!;
    expect(cycle).toMatch(/^Paused: nova the very thorough/);
    expect(cycle.endsWith(" keep handing the same work back to each other. Open the goal and press Resume.")).toBe(true);
    expect(cycle.length).toBeLessThanOrEqual(200);
  });
});

// SPEC-P 5.2: the completion primitive applies lane R's 5.1 card effect,
// generation-fenced, in its own transaction.
describe("card effects on completion (SPEC-P 5.1, 5.2)", () => {
  const hooks = (members = ["lead", "jax", "rev"]) => ({ cardGenerationCurrent, cardEffect: (tx: DatabaseSync, request: Parameters<typeof applyCardRunEffect>[1]) => applyCardRunEffect(tx, request, { memberIds: members, now: 5_000 }) });
  beforeEach(() => { settings(); goal(); });
  const running = () => {
    const c = card({ assignee_bot_id: "jax" });
    const queued = enqueueCardRun(db, { cardId: c, actor: { kind: "server" }, now: 100 });
    if (!queued.ok) throw new Error(queued.reason);
    expect(applyCardRunDispatched(db, { cardId: c, requestId: queued.requestId, deskThreadId: "desk", now: 110 }).ok).toBe(true);
    return { c, requestId: queued.requestId };
  };
  const state = (c: string) => db.prepare("SELECT state, waiting_on FROM project_work_items WHERE id=?").get(c) as { state: string; waiting_on: string | null };

  it("a finished run goes to review when someone else can review it, else to done", () => {
    const a = running();
    completeRequest(db, a.requestId, { state: "done", now: 200, resultMessageId: "m1" }, hooks());
    expect(state(a.c).state).toBe("review");
    const b = running();
    completeRequest(db, b.requestId, { state: "done", now: 210 }, hooks(["jax"]));
    expect(state(b.c).state).toBe("done");
  });

  it("F1 keeps every lead restart action owner-only and posts one status per group without waking", () => {
    const first = running();
    running();
    const lines: Array<{ groupId: string; cards: string[] }> = [];
    reconcileRoomRequestsAtBoot(db, 5000, { ...hooks(), restartCards: (groupId: string, cards: string[]) => lines.push({ groupId, cards }) });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.groupId).toBe("g");
    expect(lines[0]!.cards).toHaveLength(2);
    const input = { cardId: first.c, actor: { kind: "lead" as const, botId: "lead", lineage: { ...lineage, parentId: first.requestId, rootId: roomRequest(db, first.requestId)!.rootId } }, memberIds: ["lead", "jax", "rev"], now: 6000 };
    for (const result of [retryProjectCard(db, input), reassignProjectCard(db, { ...input, assigneeBotId: "rev" }), enqueueCardRun(db, input), sendProjectCardBack(db, input), cancelProjectCard(db, input)]) {
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("The owner picks Retry step or Skip.") });
    }
    expect(db.prepare("SELECT id FROM room_requests WHERE state='queued'").all()).toEqual([]);
  });

  it("restart starts nothing and the owner's Retry creates exactly one new attempt",()=>{
    const run=running();const old=roomRequest(db,run.requestId)!;
    const boot=reconcileRoomRequestsAtBoot(db,5000,{...hooks(),returnThread:()=>"room"});
    expect(boot.wakes).toEqual([]);
    expect(state(run.c)).toMatchObject({state:"waiting",waiting_on:JSON.stringify({kind:"restart"})});
    expect(db.prepare("SELECT * FROM room_requests WHERE state='queued'").all()).toEqual([]);
    const input={cardId:run.c,actor:{kind:"owner" as const,lineage},memberIds:["lead","jax","rev"],now:6000};
    expect(retryProjectCard(db,input).ok).toBe(true);
    expect(retryProjectCard(db,input).ok).toBe(false);
    const next=db.prepare("SELECT attempt FROM room_requests WHERE work_item_id=? AND state='queued'").all(run.c);
    expect(next).toHaveLength(1);expect(next[0]!.attempt).toBe(old.attempt+1);
  });

  it.each(["wake", "review"] as const)("F2 %s interrupted at boot becomes one owner decision without queued work", verb => {
    const run = running();
    db.prepare("UPDATE room_requests SET state='waiting_bot' WHERE id=?").run(run.requestId);
    if (verb === "review") db.prepare("UPDATE project_work_items SET state='review' WHERE id=?").run(run.c);
    const child = insertRoomRequest(db, { groupId: "g", verb, fromKind: "murage", toBotId: "jax", parentId: run.requestId,
      workItemId: run.c, cardGeneration: roomRequest(db, run.requestId)!.cardGeneration!, admissionKey: verb === "wake" ? `wake:${run.requestId}` : "review:restart", now: 200 }).request;
    markRequestDispatched(db, child.id, { now: 210 });
    const boot = reconcileRoomRequestsAtBoot(db, 5000, hooks());
    expect(boot.wakes).toEqual([]);
    expect(state(run.c)).toMatchObject({ state: "waiting", waiting_on: JSON.stringify({ kind: "restart" }) });
    if (verb === "wake") expect(roomRequest(db, run.requestId)!.state).toBe("unknown");
    expect(deriveGroupedDecisions(db, { groupId: "g", openApprovals: [], now: 5000 }).deadWaitCards).toHaveLength(1);
    expect(db.prepare("SELECT id FROM room_requests WHERE state='queued'").all()).toEqual([]);
  });

  it("a failed run fails the card; one a restart cut off waits for Retry step", () => {
    const a = running();
    completeRequest(db, a.requestId, { state: "failed", now: 200 }, hooks());
    expect(state(a.c).state).toBe("failed");
    const b = running();
    completeRequest(db, b.requestId, { state: "unknown", now: 210 }, hooks());
    expect(state(b.c)).toMatchObject({ state: "waiting", waiting_on: JSON.stringify({ kind: "restart" }) });
  });

  it("a run the card moved past changes nothing; a queued run cancelled is not 'superseded'", () => {
    const a = running();
    db.prepare("UPDATE project_work_items SET generation=generation+1 WHERE id=?").run(a.c);
    expect(completeRequest(db, a.requestId, { state: "done", now: 200 }, hooks()).request.outcomeNote).toBe("superseded");
    expect(state(a.c).state).toBe("doing");
    const c = card({ assignee_bot_id: "jax" });
    const queued = enqueueCardRun(db, { cardId: c, actor: { kind: "server" }, now: 300 });
    if (!queued.ok) throw new Error(queued.reason);
    cancelRoomRequest(db, queued.requestId, { now: 310, note: "cancelled by you" }, hooks());
    expect(roomRequest(db, queued.requestId)).toMatchObject({ state: "cancelled", outcomeNote: "cancelled by you" });
    expect(state(c).state).toBe("todo");
  });
});

// The AFTER-PF finiteCards run: three owner cards reached review and stayed
// there. Nobody handed them over, so nothing woke the lead, and nothing it
// was told named the review, accept or criteria tools or a card id.
describe("the lead's next step when a card waits on it in goal mode", () => {
  const members = ["lead", "jax", "rev"];
  const names = new Map([["lead", "Nova"], ["jax", "Jax"], ["rev", "Reed"]]);
  const criteria = JSON.stringify([
    { id: "k1", text: "LAUNCH-PLAN.md exists", setBy: "owner", proposed: false, met: false },
    { id: "k2", text: "Three segments", setBy: "owner", proposed: false, met: true },
  ]);
  const ownerCardRun = (id: string) => {
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: `r-${id}`, lineage, now: 1 }).request;
    const run = insertRoomRequest(db, { groupId: "g", verb: "assign", fromKind: "owner", toBotId: "jax", parentId: root.id, workItemId: id,
      cardGeneration: 1, admissionKey: `assign:card:${id}:1:1`, projectGoalId: "goal", now: 2 }).request;
    db.prepare("UPDATE project_work_items SET request_id=? WHERE id=?").run(run.id, id);
    markRequestDispatched(db, run.id, { now: 3 });
    return run;
  };
  const hooks = {
    cardEffect: (d: DatabaseSync, r: import("./room-requests.ts").RoomRequest) => applyCardRunEffect(d, r, { memberIds: members, now: 4 }),
    reviewWake: (d: DatabaseSync, r: import("./room-requests.ts").RoomRequest) => reviewWakeTarget(d, r, { memberIds: members, roomThreadId: "room" }),
  };

  it("an owner card entering review wakes the lead in the room, once, with the review step", () => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "doing", generation: 1, title: "Three segments" });
    const run = ownerCardRun(id);
    const done = completeRequest(db, run.id, { state: "done", now: 4, resultMessageId: "m-result" }, hooks);
    expect(db.prepare("SELECT state FROM project_work_items WHERE id=?").get(id)).toEqual({ state: "review" });
    expect(done.wakes.map((wake) => [wake.toBotId, wake.targetThreadId, wake.admissionKey])).toEqual([["lead", "room", `wake:review:${run.id}`]]);
    expect(completeRequest(db, run.id, { state: "done", now: 5 }, hooks).wakes).toEqual([]);
    // lane review: the server named Reed as its reviewer; the lead hears who reviews it
    expect(leadNextStep(db, roomRequest(db, run.id)!, { memberIds: members, viewer, name: (bot) => names.get(bot) ?? "a member" })).toEqual({
      step: "reviewing", card: { id, number: 1, title: "Three segments" }, resultMessageId: "m-result",
      reviewer: "Reed", criteria: [{ id: "k1", text: "LAUNCH-PLAN.md exists" }],
    });
  });

  it("no review wake without goal review, for a card the lead handed over, or once the card moved on", () => {
    settings(); goal({ review: 0, criteria });
    const plain = card({ assignee_bot_id: "jax", state: "doing", generation: 1 });
    expect(completeRequest(db, ownerCardRun(plain).id, { state: "done", now: 4 }, hooks).wakes).toEqual([]);
    db.exec("UPDATE project_goals SET review=1");
    const moved = card({ assignee_bot_id: "jax", state: "doing", generation: 1 });
    const run = ownerCardRun(moved);
    db.prepare("UPDATE project_work_items SET generation=2 WHERE id=?").run(moved);
    expect(completeRequest(db, run.id, { state: "done", now: 4 }, hooks).wakes).toEqual([]);
    expect(leadNextStep(db, roomRequest(db, run.id)!, { memberIds: members, viewer, name: () => "x" })).toBeUndefined();
  });

  it("a review verdict points the lead at accept or at send back", () => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "review", generation: 1, result_message_id: "m-result" });
    const review = insertRoomRequest(db, { groupId: "g", verb: "review", fromKind: "bot", fromBotId: "lead", toBotId: "rev", workItemId: id,
      cardGeneration: 1, admissionKey: `review:${id}:1`, returnBotId: "lead", lineage, now: 5 }).request;
    db.prepare("UPDATE project_work_items SET review_request_id=? WHERE id=?").run(review.id, id);
    const verdict = (note: string) => { db.prepare("UPDATE room_requests SET outcome_note=? WHERE id=?").run(note, review.id); return roomRequest(db, review.id)!; };
    const step = (note: string) => leadNextStep(db, verdict(note), { memberIds: members, viewer, name: (bot) => names.get(bot) ?? "a member" });
    expect(step("pass")).toEqual({ step: "accept", card: { id, number: 1, title: "Card 1" }, resultMessageId: "m-result", criteria: [{ id: "k1", text: "LAUNCH-PLAN.md exists" }] });
    expect(step("changes")).toMatchObject({ step: "send_back", card: { id } });
  });

  // Round 8: a review run that ended without a verdict left the card in
  // review and the lead with no step at all.
  it.each([
    ["failed", null], ["cancelled", "cancelled by you"], ["expired", null], ["failed", "stopped"],
  ] as const)("a review run that ended %s (%s) without a verdict points the lead at a new review", (ended, note) => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "review", generation: 1, result_message_id: "m-result" });
    const review = insertRoomRequest(db, { groupId: "g", verb: "review", fromKind: "bot", fromBotId: "lead", toBotId: "rev", workItemId: id,
      cardGeneration: 1, admissionKey: `review:${id}:1`, returnBotId: "lead", lineage, now: 5 }).request;
    db.prepare("UPDATE project_work_items SET review_request_id=? WHERE id=?").run(review.id, id);
    db.prepare("UPDATE room_requests SET state=?, outcome_note=? WHERE id=?").run(ended, note, review.id);
    expect(leadNextStep(db, roomRequest(db, review.id)!, { memberIds: members, viewer, name: (bot) => names.get(bot) ?? "a member" })).toEqual({
      step: "review", card: { id, number: 1, title: "Card 1" }, resultMessageId: "m-result",
      reviewers: [{ id: "lead", name: "Nova" }, { id: "rev", name: "Reed" }], criteria: [{ id: "k1", text: "LAUNCH-PLAN.md exists" }],
    });
  });

  // Round 13 (A2): a stale card reaches the lead's next step without its
  // title (a card citing another team's thread: shared-bots-leak.test.ts).
  it("a stale card's next step leaves its title out", () => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "doing", generation: 1, title: "CANARY title", stale: 1 });
    const run = ownerCardRun(id);
    completeRequest(db, run.id, { state: "done", now: 4, resultMessageId: "m-result" }, hooks);
    const step = leadNextStep(db, roomRequest(db, run.id)!, { memberIds: members, viewer, name: (bot) => names.get(bot) ?? "a member" });
    expect(step).toMatchObject({ step: "reviewing", card: { id, number: 1, title: null, stale: true } });
    expect(JSON.stringify(step)).not.toContain("CANARY");
  });

  // Round 9 (C3): a review that is no longer the card's current one (a
  // newer review was assigned) points the lead at nothing.
  it.each([["pass"], ["changes"], [null]] as const)("a result from a superseded review (%s) is no next step", (note) => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "review", generation: 1, result_message_id: "m-result" });
    const review = (key: string) => insertRoomRequest(db, { groupId: "g", verb: "review", fromKind: "bot", fromBotId: "lead", toBotId: "rev", workItemId: id,
      cardGeneration: 1, admissionKey: key, returnBotId: "lead", lineage, now: 5 }).request;
    const old = review(`review:${id}:1`), current = review(`review:${id}:2`);
    db.prepare("UPDATE project_work_items SET review_request_id=? WHERE id=?").run(current.id, id);
    db.prepare("UPDATE room_requests SET state='done', outcome_note=? WHERE id=?").run(note, old.id);
    expect(leadNextStep(db, roomRequest(db, old.id)!, { memberIds: members, viewer, name: (bot) => names.get(bot) ?? "a member" })).toBeUndefined();
    db.prepare("UPDATE room_requests SET state='done', outcome_note=? WHERE id=?").run(note, current.id);
    expect(leadNextStep(db, roomRequest(db, current.id)!, { memberIds: members, viewer, name: (bot) => names.get(bot) ?? "a member" })).toMatchObject({ card: { id } });
  });

  // What the review wake claims, each proven on the rows (round 8).
  const admissionDeps = {
    restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false, speakingInRoom: () => false,
    directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }), askWouldDeadlock: () => false,
    reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 10,
  };
  const room = (partFlags: { lead: boolean } = { lead: true }, roomUsable: (request: import("./room-requests.ts").RoomRequest) => boolean = () => true, memberIds: readonly string[] = members) => {
    const started: string[] = [], paused: string[] = [];
    const admission = createWorkAdmission(admissionDeps);
    admission.setBudgetGate({ check: () => ({ ok: true }) });
    const dispatcher = createRoomDispatcher({
      db: () => db, admission, now: () => 10, open: () => true, roomUsable, roomBusy: () => false,
      projectContext: (request) => projectContextFor(db, { groupId: request.groupId, goalId: request.projectGoalId, flags: { ...flags, ...partFlags } }),
      audienceStillValid: () => true, ownerOrigin: () => true, startOwnerSend: () => {}, memberIds: () => memberIds,
      startMemberTurn: (request, claim) => { started.push(`${request.toBotId} ${request.admissionKey}`); claim.release(); },
      onClosed: () => {}, onStillWaiting: () => {}, changed: () => {}, onGoalPaused: (_request, line) => { paused.push(line); },
    });
    return { dispatcher, started, paused, partFlags };
  };
  const reviewWakes = () => db.prepare("SELECT id, to_bot_id, state, outcome_note, payload_text FROM room_requests WHERE admission_key LIKE 'wake:review:%' ORDER BY created_at, id").all() as
    Array<{ id: string; to_bot_id: string; state: string; outcome_note: string | null; payload_text: string }>;

  it("a genuinely repeated completion of the same run queues no second wake", () => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "doing", generation: 1 });
    const run = ownerCardRun(id);
    expect(completeRequest(db, run.id, { state: "done", now: 4 }, hooks).wakes).toHaveLength(1);
    // the wake started, so a repeat cannot fold into it; then the run's
    // completion is replayed (a crash between its effects and the commit)
    const first = reviewWakes()[0]!;
    markRequestDispatched(db, first.id, { now: 5 });
    db.prepare("UPDATE room_requests SET state='running', finished_at=NULL WHERE id=?").run(run.id);
    db.prepare("UPDATE project_work_items SET state='doing' WHERE id=?").run(id);
    expect(completeRequest(db, run.id, { state: "done", now: 6 }, hooks).wakes).toEqual([]);
    expect(reviewWakes().map((wake) => wake.id)).toEqual([first.id]);
  });

  it.each([
    ["the goal is paused", () => db.exec("UPDATE project_goals SET state='paused'"), () => db.exec("UPDATE project_goals SET state='working'")],
    ["the project is paused", () => db.exec("UPDATE project_settings SET run_state='paused'"), () => db.exec("UPDATE project_settings SET run_state='running'")],
  ] as const)("while %s the review wake waits, and runs on resume", (_label, pause, resume) => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "doing", generation: 1 });
    const run = ownerCardRun(id);
    pause();
    expect(completeRequest(db, run.id, { state: "done", now: 4 }, hooks).wakes).toHaveLength(1);
    const lead = room();
    lead.dispatcher.pump();
    expect(lead.started).toEqual([]);
    expect(reviewWakes()[0]).toMatchObject({ state: "queued" });
    expect(roomRequest(db, reviewWakes()[0]!.id)!.refusal).toBe("project_paused");
    resume();
    lead.dispatcher.pump();
    expect(lead.started).toEqual([`lead wake:review:${run.id}`]);
  });

  it("while the lead is off the review wake waits, and runs when the lead is back", () => {
    settings(); goal({ review: 1, criteria });
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const lead = room({ lead: false });
    lead.dispatcher.pump();
    expect(lead.started).toEqual([]);
    lead.partFlags.lead = true;
    lead.dispatcher.pump();
    expect(lead.started).toEqual([`lead wake:review:${run.id}`]);
  });

  it("a stopped goal wakes nobody: not at completion, not a wake already queued", () => {
    settings(); goal({ review: 1, criteria });
    const queued = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, queued.id, { state: "done", now: 4 }, hooks);
    const late = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    // the owner's Stop, through the goal's own transition (round 9, C7)
    expect(stopProjectGoal(db, { goalId: "goal", actor: { kind: "owner" }, now: 5 }).ok).toBe(true);
    expect(completeRequest(db, late.id, { state: "done", now: 6 }, hooks).wakes).toEqual([]);
    expect(reviewWakes().map((wake) => wake.state)).toEqual(["cancelled"]);
    const lead = room();
    lead.dispatcher.pump();
    expect(lead.started).toEqual([]);
    expect(queueHeldReviewWakes(db, { groupId: "g", memberIds: members, roomThreadId: "room", now: 7 })).toEqual([]);
  });

  it("a lead change before admission wakes the current lead, with the next step, and not the old one", () => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "doing", generation: 1 });
    const run = ownerCardRun(id);
    completeRequest(db, run.id, { state: "done", now: 4, resultMessageId: "m-result" }, hooks);
    const [old] = reviewWakes();
    db.exec("UPDATE project_settings SET lead_bot_id='rev'");
    const lead = room();
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    expect(lead.started).toEqual([`rev wake:review:${run.id}:${old!.id}`]);
    const wakes = reviewWakes();
    expect(wakes[0]).toMatchObject({ id: old!.id, to_bot_id: "lead", state: "done", outcome_note: "absorbed" });
    expect(wakes[1]).toMatchObject({ to_bot_id: "rev" });
    expect(JSON.parse(wakes[1]!.payload_text).map((result: { requestId: string }) => result.requestId)).toEqual([run.id]);
    expect(leadNextStep(db, roomRequest(db, run.id)!, { memberIds: members, viewer, name: (bot) => names.get(bot) ?? "a member" })).toMatchObject({ step: "reviewing", card: { id } });
  });

  // Round 13 (A6): a lead that is not a member of the room (a stale lead
  // setting) is not handed the review wake, as reviewWakeTarget refuses it:
  // the wake is held where it is.
  it("a lead change to a bot that is not a member holds the review wake", () => {
    settings(); goal({ review: 1, criteria });
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const [old] = reviewWakes();
    db.exec("UPDATE project_settings SET lead_bot_id='zed'");
    const lead = room();
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    expect(lead.started).toEqual([]);
    expect(reviewWakes().map((wake) => [wake.id, wake.to_bot_id, wake.state])).toEqual([[old!.id, "lead", "queued"]]);
    // once the lead is a member, the wake moves to it (after the owner
    // resumes the goal the held wake paused, round 14)
    const joined = room({ lead: true }, () => true, [...members, "zed"]);
    expect(resumeProjectGoal(db, { goalId: "goal", actor: { kind: "owner" }, now: 9, memberIds: [...members, "zed"] }).ok).toBe(true);
    joined.dispatcher.pump();
    joined.dispatcher.pump();
    expect(joined.started).toEqual([`zed wake:review:${run.id}:${old!.id}`]);
  });

  // Round 14 (B3): nothing clears a lead that left the room, so a review
  // wake held for it waited with no sign. The goal pauses once with an
  // owner line, and the answers to the old lead's own asks are not held.
  it("a review wake held for a lead that is not a member pauses the goal once, and the old lead keeps its own answers", () => {
    settings(); goal({ review: 1, criteria });
    const ids = (text: string | null) => (JSON.parse(text ?? "[]") as Array<{ requestId: string }>).map((result) => result.requestId);
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const [old] = reviewWakes();
    const ask = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "lead", toBotId: "jax", returnBotId: "lead", returnThreadId: "room",
      admissionKey: "own-ask", lineage, now: 5 }).request;
    markRequestDispatched(db, ask.id, { now: 5 });
    completeRequest(db, ask.id, { state: "done", now: 6 });
    db.exec("UPDATE project_settings SET lead_bot_id='zed'");
    const lead = room();
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    const line = "Paused: the lead is not in this project. Pick a lead to resume.";
    expect(lead.paused).toEqual([line]);
    expect(db.prepare("SELECT state, state_reason FROM project_goals").get()).toEqual({ state: "paused", state_reason: line });
    expect(roomRequest(db, old!.id)).toMatchObject({ state: "queued", toBotId: "lead" });
    expect(ids(roomRequest(db, old!.id)!.payloadText)).toEqual([run.id]);
    expect(roomRequest(db, old!.id)!.refusal).toBe("lead_not_member");
    const kept = db.prepare("SELECT payload_text FROM room_requests WHERE admission_key=?").get(`wake:kept:${old!.id}`) as { payload_text: string };
    expect(ids(kept.payload_text)).toEqual([ask.id]);
    expect(lead.started).toEqual([]);
    // the owner resumes (Resume needs the lead to be a member, round 16) and
    // the lead is away again: no second pause, and the old lead gets its
    // own answers
    expect(resumeProjectGoal(db, { goalId: "goal", actor: { kind: "owner" }, now: 9, memberIds: [...members, "zed"] }).ok).toBe(true);
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    expect(lead.paused).toEqual([line]);
    expect(lead.started).toEqual([`lead wake:kept:${old!.id}`]);
    expect(roomRequest(db, old!.id)).toMatchObject({ state: "queued", toBotId: "lead" });
  });

  // Round 15 (C1): a held review wake is still a queued wake addressed to
  // the old lead, so a later answer for it was absorbed there, and the next
  // pump dropped that answer (its `wake:kept:` key already existed).
  it("an answer for the old lead after a held review wake split reaches the old lead", () => {
    settings(); goal({ review: 1, criteria });
    const ids = (text: string | null) => (JSON.parse(text ?? "[]") as Array<{ requestId: string }>).map((result) => result.requestId);
    const answer = (key: string, now: number) => {
      const ask = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "lead", toBotId: "jax", returnBotId: "lead", returnThreadId: "room",
        admissionKey: key, lineage, now }).request;
      markRequestDispatched(db, ask.id, { now });
      completeRequest(db, ask.id, { state: "done", now: now + 1 });
      return ask.id;
    };
    const oldLeadWakes = (held: string) => db.prepare("SELECT id, admission_key, payload_text FROM room_requests WHERE verb='wake' AND to_bot_id='lead' AND state='queued' AND id<>? ORDER BY created_at, id")
      .all(held) as Array<{ id: string; admission_key: string; payload_text: string }>;
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const [old] = reviewWakes();
    const first = answer("own-ask", 5);
    db.exec("UPDATE project_settings SET lead_bot_id='zed'");
    const lead = room();
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    const second = answer("own-ask-2", 7);
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    expect(ids(roomRequest(db, old!.id)!.payloadText)).toEqual([run.id]);
    expect(oldLeadWakes(old!.id).flatMap((wake) => ids(wake.payload_text))).toEqual([first, second]);
    // a held wake still carrying an answer (absorbed before this round)
    // after its kept wake ran: a fresh kept wake, then the held one drops it
    const [kept] = oldLeadWakes(old!.id);
    markRequestDispatched(db, kept!.id, { now: 11 });
    completeRequest(db, kept!.id, { state: "done", now: 12 }, {}, { continuation: false });
    const stray = { requestId: "stray", botId: "jax", state: "done" };
    db.prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run(JSON.stringify([...JSON.parse(roomRequest(db, old!.id)!.payloadText!), stray]), old!.id);
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    expect(ids(roomRequest(db, old!.id)!.payloadText)).toEqual([run.id]);
    expect(oldLeadWakes(old!.id).map((wake) => [wake.admission_key, ids(wake.payload_text)])).toEqual([[`wake:kept:${old!.id}:2`, ["stray"]]]);
    // the owner picks a lead who is a member: the old lead gets its answers
    const joined = room({ lead: true }, () => true, [...members, "zed"]);
    expect(resumeProjectGoal(db, { goalId: "goal", actor: { kind: "owner" }, now: 13, memberIds: [...members, "zed"] }).ok).toBe(true);
    joined.dispatcher.pump();
    joined.dispatcher.pump();
    expect(joined.started).toContain(`lead wake:kept:${old!.id}:2`);
  });

  // Round 16 (D4): a stray answer on the held wake while its kept wake is
  // still queued joins that kept wake; no fresh key is made.
  it("a stray answer on a held review wake joins its kept wake while that is still queued", () => {
    settings(); goal({ review: 1, criteria });
    const ids = (text: string | null) => (JSON.parse(text ?? "[]") as Array<{ requestId: string }>).map((result) => result.requestId);
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const [old] = reviewWakes();
    const ask = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "lead", toBotId: "jax", returnBotId: "lead", returnThreadId: "room",
      admissionKey: "own-ask", lineage, now: 5 }).request;
    markRequestDispatched(db, ask.id, { now: 5 });
    completeRequest(db, ask.id, { state: "done", now: 6 });
    db.exec("UPDATE project_settings SET lead_bot_id='zed'");
    const lead = room();
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    const kept = () => db.prepare("SELECT admission_key, state, payload_text FROM room_requests WHERE admission_key LIKE ? ORDER BY created_at, id")
      .all(`wake:kept:${old!.id}%`) as Array<{ admission_key: string; state: string; payload_text: string }>;
    expect(kept().map((wake) => [wake.admission_key, wake.state, ids(wake.payload_text)])).toEqual([[`wake:kept:${old!.id}`, "queued", [ask.id]]]);
    const stray = { requestId: "stray", botId: "jax", state: "done" };
    db.prepare("UPDATE room_requests SET payload_text=? WHERE id=?").run(JSON.stringify([...JSON.parse(roomRequest(db, old!.id)!.payloadText!), stray]), old!.id);
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    expect(ids(roomRequest(db, old!.id)!.payloadText)).toEqual([run.id]);
    expect(kept().map((wake) => [wake.admission_key, wake.state, ids(wake.payload_text)])).toEqual([[`wake:kept:${old!.id}`, "queued", [ask.id, "stray"]]]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE admission_key=?").get(`wake:kept:${old!.id}:2`)).toEqual({ n: 0 });
  });

  // Round 9 (C1): with no lead at all when the card reached review (the
  // lead removed, so the goal paused), nobody was woken, and setting a lead
  // or resuming woke nobody either: the card sat in review.
  it("an owner card that reached review with no lead wakes the lead set later, once, and runs on resume", () => {
    settings(); goal({ review: 1, criteria });
    const revision = () => Number((db.prepare("SELECT revision FROM project_settings").get() as { revision: number }).revision);
    const held = (now: number) => queueHeldReviewWakes(db, { groupId: "g", memberIds: members, roomThreadId: "room", now });
    const id = card({ assignee_bot_id: "jax", state: "doing", generation: 1 });
    const run = ownerCardRun(id);
    expect(patchProjectSettings(db, { groupId: "g", expectedRevision: revision(), leadBotId: null, memberIds: members, now: 3 }).ok).toBe(true);
    expect(db.prepare("SELECT s.lead_bot_id, g.state FROM project_settings s, project_goals g").get()).toEqual({ lead_bot_id: null, state: "paused" });
    expect(completeRequest(db, run.id, { state: "done", now: 4, resultMessageId: "m-result" }, hooks).wakes).toEqual([]);
    expect(db.prepare("SELECT state FROM project_work_items WHERE id=?").get(id)).toEqual({ state: "review" });
    expect(held(5)).toEqual([]);
    expect(patchProjectSettings(db, { groupId: "g", expectedRevision: revision(), leadBotId: "rev", memberIds: members, now: 6 }).ok).toBe(true);
    expect(held(7).map((wake) => [wake.toBotId, wake.targetThreadId, wake.admissionKey])).toEqual([["rev", "room", `wake:review:${run.id}`]]);
    expect(held(8)).toEqual([]);
    const lead = room();
    lead.dispatcher.pump();
    expect(lead.started).toEqual([]);
    expect(resumeProjectGoal(db, { goalId: "goal", actor: { kind: "owner" }, now: 9, memberIds: members }).ok).toBe(true);
    expect(held(10)).toEqual([]);
    lead.dispatcher.pump();
    expect(lead.started).toEqual([`rev wake:review:${run.id}`]);
    expect(JSON.parse(reviewWakes()[0]!.payload_text).map((result: { requestId: string }) => result.requestId)).toEqual([run.id]);
  });

  // Round 9 (C4): only an owner card's result moves to the new lead; the
  // answers to the old lead's own asks stay with it while it is a member.
  it.each([[true], [false]])("a lead change moves only the owner card's result (old lead still a member: %s)", (member) => {
    settings(); goal({ review: 1, criteria });
    const ids = (text: string | null) => (JSON.parse(text ?? "[]") as Array<{ requestId: string }>).map((result) => result.requestId);
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const [old] = reviewWakes();
    const ask = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "lead", toBotId: "jax", returnBotId: "lead", returnThreadId: "room",
      admissionKey: "own-ask", lineage, now: 5 }).request;
    markRequestDispatched(db, ask.id, { now: 5 });
    expect(completeRequest(db, ask.id, { state: "done", now: 6 }).wakes).toEqual([]);
    expect(ids(roomRequest(db, old!.id)!.payloadText)).toEqual([run.id, ask.id]);
    db.exec("UPDATE project_settings SET lead_bot_id='rev'");
    const lead = room({ lead: true }, (request) => member || request.toBotId !== "lead");
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    const moved = reviewWakes().find((wake) => wake.to_bot_id === "rev")!;
    expect(ids(moved.payload_text)).toEqual([run.id]);
    expect(lead.started).toContain(`rev wake:review:${run.id}:${old!.id}`);
    // the base wake, addressed to a bot no longer the lead, never runs: the
    // old lead's answers ride a kept wake of their own (round 18)
    expect(roomRequest(db, old!.id)!).toMatchObject({ state: "done", outcomeNote: "absorbed" });
    const kept = db.prepare("SELECT to_bot_id, payload_text FROM room_requests WHERE admission_key=?").get(`wake:kept:${old!.id}`) as { to_bot_id: string; payload_text: string } | undefined;
    if (member) {
      expect(kept!.to_bot_id).toBe("lead");
      expect(ids(kept!.payload_text)).toEqual([ask.id]);
      expect(lead.started).toContain(`lead wake:kept:${old!.id}`);
    } else {
      expect(kept).toBeUndefined();
    }
  });

  // Round 19 (G1): the old lead's answers go to it in a kept wake only while
  // it is a member of the room; nothing is queued for a bot that left.
  it.each([["rev"], ["zed"]])("a lead change queues no kept wake for an old lead that is not a member (new lead %s)", (next) => {
    settings(); goal({ review: 1, criteria });
    const ids = (text: string | null) => (JSON.parse(text ?? "[]") as Array<{ requestId: string }>).map((result) => result.requestId);
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const [old] = reviewWakes();
    const ask = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "lead", toBotId: "jax", returnBotId: "lead", returnThreadId: "room",
      admissionKey: "own-ask", lineage, now: 5 }).request;
    markRequestDispatched(db, ask.id, { now: 5 });
    completeRequest(db, ask.id, { state: "done", now: 6 });
    db.exec(`UPDATE project_settings SET lead_bot_id='${next}'`);
    const lead = room({ lead: true }, () => true, ["jax", "rev"]);
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE admission_key LIKE ?").get(`wake:kept:${old!.id}%`)).toEqual({ n: 0 });
    expect(lead.started.filter((started) => started.startsWith("lead "))).toEqual([]);
    if (next === "rev") {
      expect(roomRequest(db, old!.id)!).toMatchObject({ state: "done", outcomeNote: "absorbed" });
      expect(lead.started).toContain(`rev wake:review:${run.id}:${old!.id}`);
    } else {
      expect(roomRequest(db, old!.id)!).toMatchObject({ state: "queued", toBotId: "lead" });
      expect(ids(roomRequest(db, old!.id)!.payloadText)).toEqual([run.id, ask.id]);
    }
  });

  // Round 19 (G2): when the old lead's answers cannot be kept, the base wake
  // stays where it is, held, instead of being absorbed with them in it.
  it("a lead change whose kept wake cannot be queued holds the base wake", () => {
    settings(); goal({ review: 1, criteria });
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const [old] = reviewWakes();
    const ask = insertRoomRequest(db, { groupId: "g", verb: "ask", fromKind: "bot", fromBotId: "lead", toBotId: "jax", returnBotId: "lead", returnThreadId: "room",
      admissionKey: "own-ask", lineage, now: 5 }).request;
    markRequestDispatched(db, ask.id, { now: 5 });
    completeRequest(db, ask.id, { state: "done", now: 6 });
    // a finished kept wake under the key the next one would take
    const taken = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "room", parentId: run.id,
      admissionKey: `wake:kept:${old!.id}:2`, payloadText: "[]", now: 6 }).request;
    completeRequest(db, taken.id, { state: "cancelled", now: 6 }, {}, { continuation: false });
    db.exec("UPDATE project_settings SET lead_bot_id='rev'");
    const lead = room();
    lead.dispatcher.pump();
    lead.dispatcher.pump();
    expect(roomRequest(db, old!.id)!).toMatchObject({ state: "queued", toBotId: "lead" });
    expect(lead.started).toEqual([]);
    expect(reviewWakes().filter((wake) => wake.to_bot_id === "rev")).toEqual([]);
  });

  // Round 10 (R1): the lead removed from the room while its review wake
  // waited: the wake is held, not cancelled as if the room were gone, and
  // goes to the lead set later.
  it("a review wake whose lead left the room is held, and goes to the next lead", () => {
    settings(); goal({ review: 1, criteria });
    const revision = () => Number((db.prepare("SELECT revision FROM project_settings").get() as { revision: number }).revision);
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const [queued] = reviewWakes();
    const left = ["jax", "rev"];
    expect(patchProjectSettings(db, { groupId: "g", expectedRevision: revision(), leadBotId: null, memberIds: left, now: 5 }).ok).toBe(true);
    const lead = room({ lead: true }, (request) => !request.toBotId || left.includes(request.toBotId));
    lead.dispatcher.pump();
    expect(roomRequest(db, queued!.id)).toMatchObject({ state: "queued" });
    expect(patchProjectSettings(db, { groupId: "g", expectedRevision: revision(), leadBotId: "rev", memberIds: left, now: 6 }).ok).toBe(true);
    expect(queueHeldReviewWakes(db, { groupId: "g", memberIds: left, roomThreadId: "room", now: 7 })).toEqual([]);
    lead.dispatcher.pump();
    expect(lead.started).toEqual([]);
    expect(resumeProjectGoal(db, { goalId: "goal", actor: { kind: "owner" }, now: 8, memberIds: left }).ok).toBe(true);
    lead.dispatcher.pump();
    expect(lead.started).toEqual([`rev wake:review:${run.id}:${queued!.id}`]);
    expect(roomRequest(db, queued!.id)).toMatchObject({ state: "done", outcomeNote: "absorbed" });
  });

  it("a review wake that ended before it was delivered is queued again under a fresh key", () => {
    settings(); goal({ review: 1, criteria });
    const held = (now: number) => queueHeldReviewWakes(db, { groupId: "g", memberIds: members, roomThreadId: "room", now }).map((wake) => [wake.toBotId, wake.admissionKey]);
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    // a card with no review run (lane review assigns one; its verdict tells the lead)
    db.exec("DELETE FROM room_requests WHERE verb='review'; UPDATE project_work_items SET review_request_id=NULL");
    completeRequest(db, reviewWakes()[0]!.id, { state: "cancelled", now: 5, outcomeNote: "the room is gone" });
    expect(held(6)).toEqual([["lead", `wake:review:${run.id}:held:1`]]);
    expect(held(7)).toEqual([]);
    // the held wake also named its reviewer (lane review), whose verdict tells the lead
    expect(db.prepare("SELECT to_bot_id FROM room_requests WHERE verb='review'").all()).toEqual([{ to_bot_id: "rev" }]);
    completeRequest(db, reviewWakes()[1]!.id, { state: "cancelled", now: 8 });
    expect(held(9)).toEqual([]);
  });

  // Round 10 (R2): a lead that already heard of the card is not woken for
  // it again by a later settings patch or resume.
  it("a settings patch after the lead assigned the card's review wakes nobody", () => {
    settings(); goal({ review: 1, criteria });
    const revision = () => Number((db.prepare("SELECT revision FROM project_settings").get() as { revision: number }).revision);
    const id = card({ assignee_bot_id: "jax", state: "doing", generation: 1 });
    const run = ownerCardRun(id);
    completeRequest(db, run.id, { state: "done", now: 4 }, hooks);
    const [wake] = reviewWakes();
    markRequestDispatched(db, wake!.id, { now: 5 });
    const review = insertRoomRequest(db, { groupId: "g", verb: "review", fromKind: "bot", fromBotId: "lead", toBotId: "rev", workItemId: id,
      cardGeneration: 1, admissionKey: `review:${id}:1`, returnBotId: "lead", lineage, now: 6 }).request;
    db.prepare("UPDATE project_work_items SET review_request_id=? WHERE id=?").run(review.id, id);
    completeRequest(db, wake!.id, { state: "done", now: 7 });
    // a wake of the lead's that has not started would take the result in
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r-later", lineage, now: 8 }).request;
    const pending = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "room", parentId: root.id,
      payloadText: "[]", admissionKey: "wake:later", priority: "coordinator", now: 8 }).request;
    expect(patchProjectSettings(db, { groupId: "g", expectedRevision: revision(), parallelCards: 2, memberIds: members, now: 9 }).ok).toBe(true);
    expect(queueHeldReviewWakes(db, { groupId: "g", memberIds: members, roomThreadId: "room", now: 10 })).toEqual([]);
    expect(roomRequest(db, pending.id)!.payloadText).toBe("[]");
    expect(reviewWakes().map((row) => row.id)).toEqual([wake!.id]);
  });

  it("a result the lead's own wake took in and delivered wakes nobody on a later settings patch", () => {
    settings(); goal({ review: 1, criteria });
    const revision = () => Number((db.prepare("SELECT revision FROM project_settings").get() as { revision: number }).revision);
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r-pending", lineage, now: 1 }).request;
    const pending = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "room", parentId: root.id,
      payloadText: "[]", admissionKey: "wake:earlier", priority: "coordinator", now: 2 }).request;
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    expect(completeRequest(db, run.id, { state: "done", now: 4 }, hooks).wakes).toEqual([]);
    markRequestDispatched(db, pending.id, { now: 5 });
    completeRequest(db, pending.id, { state: "done", now: 6 });
    expect(patchProjectSettings(db, { groupId: "g", expectedRevision: revision(), parallelCards: 2, memberIds: members, now: 7 }).ok).toBe(true);
    expect(queueHeldReviewWakes(db, { groupId: "g", memberIds: members, roomThreadId: "room", now: 8 })).toEqual([]);
    expect(reviewWakes()).toEqual([]);
  });

  it("a result for a lead whose wake has not started joins that wake", () => {
    settings(); goal({ review: 1, criteria });
    const root = insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "r-pending", lineage, now: 1 }).request;
    const pending = insertRoomRequest(db, { groupId: "g", verb: "wake", fromKind: "murage", toBotId: "lead", targetThreadId: "room", parentId: root.id,
      payloadText: JSON.stringify([{ requestId: "earlier", botId: "rev", state: "done" }]), admissionKey: "wake:earlier", priority: "coordinator", now: 2 }).request;
    const run = ownerCardRun(card({ assignee_bot_id: "jax", state: "doing", generation: 1 }));
    expect(completeRequest(db, run.id, { state: "done", now: 4 }, hooks).wakes).toEqual([]);
    expect(reviewWakes()).toEqual([]);
    expect(JSON.parse(roomRequest(db, pending.id)!.payloadText!).map((result: { requestId: string }) => result.requestId)).toEqual(["earlier", run.id]);
  });

  it("a card sent back that reaches review again wakes the lead again, under the new run's id", () => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "doing", generation: 1 });
    const first = ownerCardRun(id);
    completeRequest(db, first.id, { state: "done", now: 4 }, hooks);
    const [wake] = reviewWakes();
    markRequestDispatched(db, wake!.id, { now: 5 });
    completeRequest(db, wake!.id, { state: "done", now: 6 });
    const back = sendProjectCardBack(db, { cardId: id, actor: { kind: "owner", lineage }, note: "tighten it", now: 7 });
    if (!back.ok || !back.requestId) throw new Error("send back refused");
    expect(applyCardRunDispatched(db, { cardId: id, requestId: back.requestId, deskThreadId: "desk", now: 8 }).ok).toBe(true);
    const again = completeRequest(db, back.requestId, { state: "done", now: 9 }, hooks);
    expect(again.wakes.map((next) => [next.toBotId, next.admissionKey])).toEqual([["lead", `wake:review:${back.requestId}`]]);
    expect(again.wakes[0]!.id).not.toBe(wake!.id);
  });

  it("a card the owner took over gets no review wake and no next step", () => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "doing", generation: 1 });
    const run = ownerCardRun(id);
    expect(takeOverProjectCard(db, { cardId: id, actor: { kind: "owner" }, now: 4 }).ok).toBe(true);
    expect(completeRequest(db, run.id, { state: "done", now: 5 }, hooks).wakes).toEqual([]);
    expect(db.prepare("SELECT state, owner_took_over FROM project_work_items WHERE id=?").get(id)).toEqual({ state: "doing", owner_took_over: 1 });
    expect(leadNextStep(db, roomRequest(db, run.id)!, { memberIds: members, viewer, name: () => "x" })).toBeUndefined();
  });

  it("a review run that failed wakes the lead with a new review step for its card", () => {
    settings(); goal({ review: 1, criteria });
    const id = card({ assignee_bot_id: "jax", state: "review", generation: 1, result_message_id: "m-result" });
    const review = insertRoomRequest(db, { groupId: "g", verb: "review", fromKind: "bot", fromBotId: "lead", toBotId: "rev", workItemId: id,
      cardGeneration: 1, admissionKey: `review:${id}:1`, returnBotId: "lead", lineage, now: 5 }).request;
    db.prepare("UPDATE project_work_items SET review_request_id=? WHERE id=?").run(review.id, id);
    markRequestDispatched(db, review.id, { now: 6 });
    const failed = completeRequest(db, review.id, { state: "failed", now: 7 }, { ...hooks, returnThread: () => "room" });
    expect(failed.wakes.map((wake) => [wake.toBotId, wake.targetThreadId])).toEqual([["lead", "room"]]);
    expect(db.prepare("SELECT state FROM project_work_items WHERE id=?").get(id)).toEqual({ state: "review" });
    expect(leadNextStep(db, roomRequest(db, review.id)!, { memberIds: members, viewer, name: (bot) => names.get(bot) ?? "a member" }))
      .toMatchObject({ step: "review", card: { id }, resultMessageId: "m-result", reviewers: [{ id: "lead" }, { id: "rev" }] });
  });
});

// Round 11 (D1): what the lead's wakes list as the goal's open cards.
describe("goalOpenCards", () => {
  it("lists the goal's open cards by number with the assignee's name, and nothing finished, archived or of another goal", () => {
    settings(); goal();
    card({ title: "Segments", assignee_bot_id: "reed", state: "doing" });
    card({ title: "Pricing", assignee_bot_id: "cole", state: "review" });
    card({ title: "Old", assignee_bot_id: "reed", state: "done" });
    card({ title: "Dropped", assignee_bot_id: "reed", state: "cancelled" });
    card({ title: "Hidden", assignee_bot_id: "reed", state: "todo", archived_at: 5 });
    card({ title: "Elsewhere", assignee_bot_id: "reed", state: "todo", goal_id: null });
    card({ title: "Nobody", state: "todo" });
    // lane cards: an OWNER card with no goal of its own is still the project's work, a server card is not
    card({ title: "Loose owner card", state: "todo", goal_id: null, created_by: "owner" });
    card({ title: "Routine run", assignee_bot_id: "reed", state: "failed", goal_id: null, created_by: "server" });
    const names: Record<string, string> = { reed: "Reed", cole: "Cole" };
    expect(goalOpenCards(db, "goal", (id) => names[id] ?? "a member", viewer)).toEqual({ more: 0, cards: [
      { id: "c1", number: 1, title: "Segments", assignee: "Reed", state: "doing" },
      { id: "c2", number: 2, title: "Pricing", assignee: "Cole", state: "review" },
      { id: "c7", number: 7, title: "Nobody", assignee: null, state: "todo" },
      { id: "c8", number: 8, title: "Loose owner card", assignee: null, state: "todo" },
    ] });
  });
  // Round 12 (S1): a card a forgotten message made stale keeps its number,
  // id, assignee and state, never its title.
  it("leaves a stale card's title out", () => {
    settings(); goal();
    card({ title: "STALE_CANARY pricing", assignee_bot_id: "reed", state: "doing", stale: 1 });
    expect(goalOpenCards(db, "goal", () => "Reed", viewer)).toEqual({ more: 0, cards: [{ id: "c1", number: 1, title: null, assignee: "Reed", state: "doing", stale: true }] });
  });
  // Round 14 (B7): a wake with no bot to read as fails closed, never open.
  it("leaves every title out when there is no viewing bot", () => {
    settings(); goal();
    card({ title: "Segments", assignee_bot_id: "reed", state: "doing" });
    expect(goalOpenCards(db, "goal", () => "Reed", { botId: "", threadId: "room" })).toEqual({ more: 0, cards: [{ id: "c1", number: 1, title: null, assignee: "Reed", state: "doing" }] });
  });
  // Round 12 (L2): the list is cut at 30 and says how many more there are.
  it("says how many more open cards there are past the first 30", () => {
    settings(); goal();
    for (let i = 0; i < 33; i += 1) card({ state: "todo" });
    const open = goalOpenCards(db, "goal", () => "Reed", viewer);
    expect(open.cards).toHaveLength(30);
    expect(open.more).toBe(3);
  });
});
