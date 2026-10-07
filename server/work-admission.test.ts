// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPEC-P 7: one admission arbiter for every start in a room or project.
import { describe, expect, it } from "vitest";
import {
  createWorkAdmission as createUnconfiguredAdmission,
  PLACEHOLDER_BUDGET_GATE,
  type AdmissionInput,
  type ProjectContext,
  type WorkAdmissionDeps,
} from "./work-admission.ts";

function createWorkAdmission(dependencies: WorkAdmissionDeps) {
  const admission = createUnconfiguredAdmission(dependencies);
  admission.setBudgetGate({ check: () => ({ ok: true }) });
  return admission;
}
function deps(overrides: Partial<WorkAdmissionDeps> = {}): WorkAdmissionDeps {
  return {
    restoreReview: () => false,
    flags: () => ({ autonomy: true, budgets: true }),
    threadRunning: () => false,
    speakingInRoom: () => false,
    directThreads: () => 0,
    maxThreads: 3,
    installCardCap: 4,
    rootCounters: () => ({ wakes: 0, workMs: 0 }),
    askWouldDeadlock: () => false,
    reachable: () => true,
    dependencyOpen: () => false,
    claimWriterRoot: () => () => {},
    now: () => 1_000_000,
    ...overrides,
  };
}
const channel: ProjectContext = { groupId: "g1", isProject: false, closed: false, runState: "running", boardOn: false, parallelCards: 3, mode: "conversation" };
const project = (extra: Partial<ProjectContext> = {}): ProjectContext => ({ groupId: "g1", isProject: true, closed: false, runState: "running", leadBotId: "lead", boardOn: true, parallelCards: 3, mode: "conversation", ...extra });
const input = (extra: Partial<AdmissionInput> = {}): AdmissionInput => ({
  kind: "room_turn", priority: "coordinator", botId: "dax", threadId: "room-t", project: channel, requestId: "r1", rootId: "root",
  ownerOrigin: false, audience: { ownerAudience: true, fingerprint: "owner" }, now: 1_000_000, ...extra,
});

describe("work admission", () => {
  it("admits a free member and tracks the live turn until released", () => {
    const arbiter = createWorkAdmission(deps());
    const decision = arbiter.admit(input());
    expect(decision.admit).toBe(true);
    if (!decision.admit) return;
    expect(arbiter.liveTurns({ botId: "dax" }).map((claim) => claim.id)).toEqual([decision.claim.id]);
    expect(arbiter.liveTurns({ groupId: "g1" })).toHaveLength(1);
    decision.claim.release();
    decision.claim.release();
    expect(arbiter.liveTurns({ botId: "dax" })).toEqual([]);
  });

  it("refuses the same thread twice and a second room turn for a speaking member", () => {
    const arbiter = createWorkAdmission(deps({ threadRunning: (_bot, thread) => thread === "busy-t", speakingInRoom: (bot) => bot === "dax" }));
    expect(arbiter.admit(input({ threadId: "busy-t" }))).toMatchObject({ admit: false, reason: "thread_running", retry: "queue" });
    expect(arbiter.admit(input())).toMatchObject({ admit: false, reason: "speaking_in_room" });
  });

  it("counts a bot's direct threads and its room turns against the ceiling", () => {
    let direct = 2;
    const arbiter = createWorkAdmission(deps({ directThreads: () => direct }));
    const first = arbiter.admit(input({ threadId: "a" }));
    expect(first.admit).toBe(true);
    const refused = arbiter.admit(input({ threadId: "b", kind: "ask", fromBotId: "moss" }));
    expect(refused).toMatchObject({ admit: false, reason: "bot_thread_ceiling", line: "dax is busy in another conversation" });
    direct = 0;
    expect(arbiter.admit(input({ threadId: "b", kind: "ask", fromBotId: "moss" })).admit).toBe(true);
  });

  it("owner first: an owner's direct send takes one reserved slot above the ceiling", () => {
    const arbiter = createWorkAdmission(deps({ directThreads: () => 3 }));
    const owner = arbiter.admit(input({ kind: "owner_direct", priority: "owner", ownerOrigin: true, threadId: "own", project: undefined }));
    expect(owner.admit).toBe(true);
    const second = arbiter.admit(input({ kind: "owner_direct", priority: "owner", ownerOrigin: true, threadId: "own2", project: undefined }));
    expect(second).toMatchObject({ admit: false, reason: "bot_thread_ceiling", retry: "queue" });
    const unproven = createWorkAdmission(deps({ directThreads: () => 3 })).admit(input({ kind: "owner_direct", priority: "owner", ownerOrigin: false, threadId: "x", project: undefined }));
    expect(unproven).toMatchObject({ admit: false, reason: "bot_thread_ceiling" });
  });

  it("restore review refuses automation but never the owner's direct send", () => {
    const arbiter = createWorkAdmission(deps({ restoreReview: () => true }));
    expect(arbiter.admit(input())).toMatchObject({ admit: false, reason: "restore_review" });
    expect(arbiter.admit(input({ kind: "owner_direct", priority: "owner", ownerOrigin: true, project: undefined })).admit).toBe(true);
  });

  it("autonomy off refuses wakes and card runs; budgets off forces autonomy off; conversation still works", () => {
    const off = createWorkAdmission(deps({ flags: () => ({ autonomy: false, budgets: true }) }));
    expect(off.admit(input({ kind: "wake" }))).toMatchObject({ admit: false, reason: "autonomy_off", line: "Projects work on their own is off" });
    expect(off.admit(input({ kind: "card_run", project: project() }))).toMatchObject({ reason: "autonomy_off" });
    expect(off.admit(input({ kind: "room_turn" })).admit).toBe(true);
    const noWakes = createWorkAdmission(deps({ flags: () => ({ autonomy: true, budgets: true, autoWake: false }) }));
    expect(noWakes.admit(input({ kind: "wake" }))).toMatchObject({ admit: false, reason: "autonomy_off", line: "Waking is off" });
    expect(noWakes.admit(input({ kind: "card_run", project: project(), threadId: "c9" })).admit).toBe(true);
    const noBudgets = createWorkAdmission(deps({ flags: () => ({ autonomy: true, budgets: false }) }));
    expect(noBudgets.admit(input({ kind: "wake" }))).toMatchObject({ reason: "autonomy_off" });
  });

  it("project paused holds wakes and cards, but not the owner's room turn or the lead's one reply", () => {
    const arbiter = createWorkAdmission(deps());
    const paused = project({ runState: "paused" });
    expect(arbiter.admit(input({ kind: "wake", project: paused }))).toMatchObject({ admit: false, reason: "project_paused", retry: "queue", line: "Paused" });
    expect(arbiter.admit(input({ kind: "card_run", project: paused }))).toMatchObject({ reason: "project_paused" });
    expect(arbiter.admit(input({ kind: "room_turn", project: paused, ownerReplyTo: "send-1", threadId: "x1" })).admit).toBe(true);
    expect(arbiter.admit(input({ kind: "lead_turn", project: paused, ownerReplyTo: "send-2", botId: "lead", threadId: "x2" })).admit).toBe(true);
    expect(arbiter.admit(input({ kind: "wake", project: project({ goalId: "goal", goalState: "paused" }), threadId: "x3" }))).toMatchObject({ reason: "project_paused" });
    expect(arbiter.admit(input({ kind: "card_run", project: project({ boardOn: false }), threadId: "x4" }))).toMatchObject({ reason: "project_paused" });
    expect(arbiter.admit(input({ kind: "wake", project: project({ leadBotId: null }), threadId: "x5" }))).toMatchObject({ reason: "project_paused" });
    expect(arbiter.admit(input({ kind: "wake", project: project({ closed: true }), closeSummary: true, botId: "zed", threadId: "x6" })).admit).toBe(true);
  });

  it("holds a goal's cards until the plan is approved", () => {
    const arbiter = createWorkAdmission(deps());
    expect(arbiter.admit(input({ kind: "card_run", project: project({ goalId: "g", goalState: "awaiting_plan_ok" }) }))).toMatchObject({ admit: false, reason: "plan_not_approved", line: "Waiting for your OK on the plan" });
    expect(arbiter.admit(input({ kind: "card_run", project: project({ goalId: "g", goalState: "working" }), threadId: "d1" })).admit).toBe(true);
  });

  it("refuses an unreachable target for good, and a deadlock with a plain line", () => {
    const unreachable = createWorkAdmission(deps({ reachable: () => false }));
    expect(unreachable.admit(input({ kind: "ask", fromBotId: "a" }))).toMatchObject({ admit: false, reason: "not_reachable", retry: "never" });
    const cycle = createWorkAdmission(deps({ askWouldDeadlock: () => true, botName: (id) => id === "dax" ? "Dax" : id }));
    expect(cycle.admit(input({ kind: "ask", fromBotId: "moss", botId: "dax" }))).toMatchObject({ admit: false, reason: "deadlock", retry: "never", line: "Dax is already waiting on you, so answer him first." });
  });

  it("queues a card behind an open dependency", () => {
    const arbiter = createWorkAdmission(deps({ dependencyOpen: () => true }));
    expect(arbiter.admit(input({ kind: "card_run", project: project(), workItemId: "c1" }))).toMatchObject({ admit: false, reason: "dependency", retry: "queue" });
  });

  it("conversation cap: 6 wakes or 30 minutes of team work per owner message", () => {
    const six = createWorkAdmission(deps({ rootCounters: () => ({ wakes: 6, workMs: 0 }) }));
    expect(six.admit(input({ kind: "wake" }))).toMatchObject({ admit: false, reason: "root_cap", line: "Paused: 6 team steps since your last message. Say continue." });
    expect(six.admit(input({ kind: "room_turn" })).admit).toBe(true);
    const long = createWorkAdmission(deps({ rootCounters: () => ({ wakes: 1, workMs: 30 * 60_000 }) }));
    expect(long.admit(input({ kind: "ask", fromBotId: "a" }))).toMatchObject({ reason: "root_cap" });
    // in goal mode the budget and progress checks apply instead
    expect(six.admit(input({ kind: "wake", botId: "lead", threadId: "t2", project: project({ goalId: "g", goalState: "working" }) })).admit).toBe(true);
  });

  it("card caps: one per bot per project, the project's parallel cards, and four install-wide", () => {
    const arbiter = createWorkAdmission(deps());
    const p = project({ parallelCards: 2 });
    expect(arbiter.admit(input({ kind: "card_run", project: p, botId: "a", threadId: "a1", now: 0 })).admit).toBe(true);
    expect(arbiter.admit(input({ kind: "card_run", project: p, botId: "a", threadId: "a2", now: 10_000 }))).toMatchObject({ reason: "bot_card_in_project" });
    expect(arbiter.admit(input({ kind: "card_run", project: p, botId: "b", threadId: "b1", now: 20_000 })).admit).toBe(true);
    expect(arbiter.admit(input({ kind: "card_run", project: p, botId: "c", threadId: "c1", now: 30_000 }))).toMatchObject({ reason: "project_card_cap" });
    // coordinator kinds never count as a card slot
    expect(arbiter.admit(input({ kind: "wake", project: p, botId: "lead", threadId: "room" })).admit).toBe(true);
    const other = project({ groupId: "g2", parallelCards: 5 });
    expect(arbiter.admit(input({ kind: "card_run", project: other, botId: "d", threadId: "d1", now: 40_000 })).admit).toBe(true);
    expect(arbiter.admit(input({ kind: "card_run", project: other, botId: "e", threadId: "e1", now: 50_000 })).admit).toBe(true);
    expect(arbiter.admit(input({ kind: "card_run", project: other, botId: "f", threadId: "f1", now: 60_000 }))).toMatchObject({ reason: "install_card_cap" });
  });

  it("staggers card starts two seconds apart", () => {
    const arbiter = createWorkAdmission(deps());
    expect(arbiter.admit(input({ kind: "card_run", project: project(), botId: "a", threadId: "a", now: 0 })).admit).toBe(true);
    expect(arbiter.admit(input({ kind: "card_run", project: project(), botId: "b", threadId: "b", now: 1_000 }))).toMatchObject({ reason: "stagger" });
    expect(arbiter.admit(input({ kind: "card_run", project: project(), botId: "b", threadId: "b", now: 2_000 })).admit).toBe(true);
  });

  it("a writer root is claimed with the admission; a project room turn runs without it when it is held", () => {
    let held = false;
    const arbiter = createWorkAdmission(deps({ claimWriterRoot: () => held ? null : () => { held = false; } }));
    const root = { canonicalPath: "/w", dev: "1", ino: "2" };
    const card = arbiter.admit(input({ kind: "card_run", project: project(), writerRoot: root, threadId: "c" }));
    expect(card.admit && card.claim.writerRoot).toEqual(root);
    held = true;
    expect(arbiter.admit(input({ kind: "card_run", project: project(), writerRoot: root, botId: "b", threadId: "d", now: 5_000_000 }))).toMatchObject({ reason: "writer_root_busy", line: "Waiting for the folder" });
    const roomTurn = arbiter.admit(input({ kind: "room_turn", project: project(), writerRoot: root, botId: "lead", threadId: "room" }));
    expect(roomTurn.admit).toBe(true);
    expect(roomTurn.admit && roomTurn.claim.writerRoot).toBeUndefined();
  });

  it("the budget gate refuses everything but the owner and the lead's one reply", () => {
    const arbiter = createWorkAdmission(deps());
    arbiter.setBudgetGate({ check: () => ({ ok: false, budgetId: "b1", line: "Budget reached" }) });
    expect(arbiter.admit(input({ kind: "wake" }))).toMatchObject({ admit: false, reason: "budget_reached", line: "Budget reached" });
    expect(arbiter.admit(input({ kind: "room_turn", ownerReplyTo: "s1", threadId: "t1" })).admit).toBe(true);
    expect(arbiter.admit(input({ kind: "owner_direct", priority: "owner", ownerOrigin: true, threadId: "t2", project: undefined })).admit).toBe(true);
    expect(arbiter.admit(input({kind:"wake",closeSummary:true,botId:"closing-lead",project:project({closed:true,runState:"paused"}),threadId:"closing"}))).toMatchObject({admit:false,reason:"budget_reached"});
    expect(arbiter.budgetGateIsPlaceholder()).toBe(false);
    expect(createUnconfiguredAdmission(deps()).budgetGateIsPlaceholder()).toBe(true);
    expect(createUnconfiguredAdmission(deps()).admit(input())).toMatchObject({ admit: false, reason: "budget_reached" });
    expect(PLACEHOLDER_BUDGET_GATE.check({ groupId: "g", kind: "wake", now: 0 })).toMatchObject({ ok: false });
  });
});

describe("PF owner-approved cards", () => {
  it.each(["planning", "awaiting_plan_ok"] as const)("admits the owner's card in %s", goalState => {
    expect(createWorkAdmission(deps()).admit(input({ kind: "card_run", ownerApprovedCard: true,
      project: project({ goalId: "goal", goalState }) })).admit).toBe(true);
  });
  it("distinguishes waiting for the lead's plan from waiting for approval", () => {
    expect(createWorkAdmission(deps({ botName: () => "Nova" })).admit(input({ kind: "card_run",
      project: project({ goalId: "goal", goalState: "planning" }) }))).toMatchObject({ line: "Waiting for Nova's plan" });
  });
  it.each(["paused", "stopped", "failed"] as const)("refuses owner cards in %s", goalState => {
    expect(createWorkAdmission(deps()).admit(input({ kind: "card_run", ownerApprovedCard: true,
      project: project({ goalId: "goal", goalState }) }))).toMatchObject({ admit: false, reason: "project_paused" });
  });
});
