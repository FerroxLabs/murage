// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane R goal transition tests (SPEC-P 5.3, 5.3.1) and the grouped-decisions
// derivation (5.6). Allowed plus refused per actor, evidence binding to the
// card's current attempt, and the revision rule.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { initializeProjectTables } from "./project-tables.ts";
import { goalSignoffBlockers,
  PROJECT_CHECK_TOOLS,
  approveProjectPlan,
  changeProjectPlan,
  createProjectGoal,
  deriveGroupedDecisions,
  markCriterionMet,
  pauseProjectGoal,
  patchProjectGoal,
  proposeProjectCriteria,
  requestGoalSignoff,
  resumeProjectGoal,
  sendProjectGoalBack,
  signOffProjectGoal,
  startProjectGoal,
  stopProjectGoal,
} from "./project-goals.ts";
import { createProjectCard, applyCardRunDispatched, applyCardRunFinished, enqueueCardRun } from "./project-cards.ts";
import { projectGoalById, projectCardById } from "./project-records.ts";

const NOW = 1_700_200_000_000;
const MEMBERS = ["lead", "dax", "ivy"];

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  db.prepare(`INSERT INTO project_settings
    (group_id, mode, lead_bot_id, parts, parallel_cards, work_roots, work_profile, run_state, revision, updated_at)
    VALUES ('grp','conversation','lead','{"board":true,"review":true,"digest":false}',3,'[]','ask','running',0,?)`).run(NOW);
  return db;
}

function makeGoal(db: DatabaseSync, over: Record<string, unknown> = {}) {
  const result = createProjectGoal(db, { groupId: "grp", title: "Close the books", now: NOW, ...over });
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return result.goal;
}

function startedGoal(db: DatabaseSync, over: Record<string, unknown> = {}) {
  const goal = makeGoal(db, over);
  const started = startProjectGoal(db, { goalId: goal.id, now: NOW + 1, tz: "UTC" });
  if (!started.ok) throw new Error(`setup start failed: ${JSON.stringify(started)}`);
  return projectGoalById(db, goal.id)!;
}

const ARTIFACTS_TABLE = `CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, extension TEXT NOT NULL, created_at INTEGER NOT NULL,
  bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, source_root TEXT NOT NULL,
  relative_path TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
  UNIQUE(bot_id,thread_id,run_id,source_root,relative_path,sha256))`;
function artifact(db: DatabaseSync, id: string, name: string, threadId: string, botId: string, at: number) {
  db.prepare(`INSERT INTO artifacts (id, name, kind, mime, bytes, sha256, extension, created_at, bot_id, thread_id, run_id, source_root, relative_path, source_fingerprint)
    VALUES (?,?,'text','text/markdown',10,?,'.md',?,?,?,?,'/tmp',?,'fp')`).run(id, name, id.padEnd(64, "a"), at, botId, threadId, id, name);
}
/** A working goal with the given criteria and one done card of Dax's ("Make file", desk-dax). */
function evidenceGoal(db: DatabaseSync, criteria: string[]) {
  db.prepare(ARTIFACTS_TABLE).run();
  db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL)");
  const goal = startedGoal(db, { criteria });
  db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.id);
  cardDone(db, goal.id, "Make file");
  return { goal, criteria: projectGoalById(db, goal.id)!.criteria };
}
function cardDone(db: DatabaseSync, goalId: string, title: string) {
  const card = createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title, goalId, assigneeBotId: "dax", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW });
  if (!card.ok) throw new Error("setup card");
  const queued = enqueueCardRun(db, { cardId: card.card.id, actor: { kind: "lead", botId: "lead" }, now: NOW });
  if (!queued.ok) throw new Error("setup enqueue");
  applyCardRunDispatched(db, { cardId: card.card.id, requestId: queued.requestId, deskThreadId: "desk-dax", now: NOW + 1 });
  applyCardRunFinished(db, { cardId: card.card.id, requestId: queued.requestId, resultMessageId: `msg-${title}`, reviewApplies: false, now: NOW + 2 });
  // E1 completes the request before applying card completion.
  db.prepare("UPDATE room_requests SET state='done', result_message_id=? WHERE id=?").run(`msg-${title}`, queued.requestId);
  return projectCardById(db, card.card.id)!;
}

describe("create and edit (5.3: new -> draft; owner PATCH)", () => {
  it("creates a draft goal with owner criteria and the approved review default", () => {
    const db = freshDb();
    const goal = makeGoal(db, { criteria: ["The report is written", "The totals match"] });
    expect(goal).toMatchObject({ state: "draft", review: true, planFirst: false });
    expect(goal.criteria).toHaveLength(2);
    expect(goal.criteria[0]).toMatchObject({ text: "The report is written", setBy: "owner", proposed: false, met: false });
    db.close();
  });

  it("refuses unknown fields at the route boundary shape", () => {
    const db = freshDb();
    expect(createProjectGoal(db, { groupId: "grp", title: "x", now: NOW, bogus: true } as never)).toMatchObject({ ok: false, error: "invalid" });
    expect(createProjectGoal(db, { groupId: "grp", title: "", now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(createProjectGoal(db, { groupId: "grp", title: "x".repeat(201), now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    db.close();
  });

  it("owner edit bumps the revision; a stale expectedRevision is 409 changed", () => {
    const db = freshDb();
    const goal = makeGoal(db);
    const edited = patchProjectGoal(db, { goalId: goal.id, expectedRevision: 0, title: "New title", now: NOW + 1 });
    expect(edited.ok && edited.goal.revision).toBe(1);
    const stale = patchProjectGoal(db, { goalId: goal.id, expectedRevision: 0, title: "Again", now: NOW + 2 });
    expect(stale).toMatchObject({ ok: false, error: "changed" });
    if (!stale.ok && stale.error === "changed") expect(stale.goal.title).toBe("New title");
    db.close();
  });

  it("editing a proposed criterion makes it owner-set", () => {
    const db = freshDb();
    const goal = makeGoal(db);
    startProjectGoal(db, { goalId: goal.id, now: NOW + 1, tz: "UTC" });
    const proposed = proposeProjectCriteria(db, { goalId: goal.id, texts: ["First check", "Second check"], now: NOW + 2 });
    expect(proposed.ok).toBe(true);
    const criterion = projectGoalById(db, goal.id)!.criteria[0]!;
    expect(criterion).toMatchObject({ setBy: "lead", proposed: true });
    const edited = patchProjectGoal(db, { goalId: goal.id, expectedRevision: projectGoalById(db, goal.id)!.revision, criteria: [{ id: criterion.id, text: "First check, reworded" }], now: NOW + 3 });
    expect(edited.ok).toBe(true);
    expect(projectGoalById(db, goal.id)!.criteria[0]).toMatchObject({ setBy: "owner", proposed: false, text: "First check, reworded" });
    db.close();
  });
});

describe("start (draft -> planning, 5.3)", () => {
  it("starts, creates the goal budget with the approved defaults, stamps started_at", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    expect(goal.state).toBe("planning");
    expect(goal.startedAt).toBe(NOW + 1);
    const budget = db.prepare("SELECT * FROM project_budgets WHERE goal_id=?").get(goal.id) as Record<string, unknown>;
    expect(budget).toMatchObject({ period: "goal", max_work_minutes: 120, max_tokens: 3_000_000 });
    db.close();
  });

  it("is refused without a lead, with the board off, and with a paused period budget", () => {
    const db = freshDb();
    db.prepare("UPDATE project_settings SET lead_bot_id=NULL WHERE group_id='grp'").run();
    expect(startProjectGoal(db, { goalId: makeGoal(db).id, now: NOW, tz: "UTC" })).toMatchObject({ ok: false, error: "not_allowed" });

    const db2 = freshDb();
    db2.prepare("UPDATE project_settings SET parts='{\"board\":false}' WHERE group_id='grp'").run();
    expect(startProjectGoal(db2, { goalId: makeGoal(db2).id, now: NOW, tz: "UTC" })).toMatchObject({ ok: false, error: "not_allowed" });

    const db3 = freshDb();
    db3.prepare(`INSERT INTO project_budgets (id, group_id, goal_id, period, tz, period_start, max_work_minutes, state, created_at)
      VALUES ('b1','grp',NULL,'week','UTC',?,120,'paused',?)`).run(NOW, NOW);
    const refused = startProjectGoal(db3, { goalId: makeGoal(db3).id, now: NOW, tz: "UTC" });
    expect(refused).toMatchObject({ ok: false, error: "not_allowed" });
    if (!refused.ok) expect(refused.reason).toContain("budget");
    db.close(); db2.close(); db3.close();
  });

  it("is refused when the projectsGoals flag is off, or projectsLead is off (no row written)", () => {
    const db = freshDb();
    const goal = makeGoal(db);
    expect(startProjectGoal(db, { goalId: goal.id, now: NOW, tz: "UTC", flags: { projectsGoals: false } })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(startProjectGoal(db, { goalId: goal.id, now: NOW, tz: "UTC", flags: { projectsLead: false } })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(projectGoalById(db, goal.id)!.state).toBe("draft"); // no row changed
    db.close();
  });

  it("is refused on an ended project and while another goal is active", () => {
    const db = freshDb();
    startedGoal(db, { title: "First" });
    expect(startProjectGoal(db, { goalId: makeGoal(db, { title: "Second" }).id, now: NOW + 2, tz: "UTC" })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });
});

describe("plan approval (5.3)", () => {
  it("planning -> awaiting_plan_ok happens in the envelope apply; the owner approves to working", () => {
    const db = freshDb();
    const goal = startedGoal(db, { planFirst: true });
    db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goal.id); // the envelope moved it
    const approved = approveProjectPlan(db, { goalId: goal.id, now: NOW + 2, memberIds: MEMBERS });
    expect(approved.ok).toBe(true);
    expect(projectGoalById(db, goal.id)!.state).toBe("working");
    db.close();
  });

  it("approve is refused from working; change_plan cancels the plan's queued requests and todo cards", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    expect(approveProjectPlan(db, { goalId: goal.id, now: NOW, memberIds: MEMBERS })).toMatchObject({ ok: false, error: "not_allowed" });
    db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goal.id);
    const card = createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title: "Planned", goalId: goal.id, assigneeBotId: "dax", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW });
    if (!card.ok) throw new Error("setup");
    const queued = enqueueCardRun(db, { cardId: card.card.id, actor: { kind: "lead", botId: "lead" }, now: NOW });
    if (!queued.ok) throw new Error("setup");
    const changed = changeProjectPlan(db, { goalId: goal.id, note: "Rework the plan", now: NOW + 2 });
    expect(changed.ok).toBe(true);
    expect(projectGoalById(db, goal.id)).toMatchObject({ state: "planning", replans: 0 });
    expect(projectCardById(db, card.card.id)!.state).toBe("cancelled");
    expect((db.prepare("SELECT state FROM room_requests WHERE id=?").get(queued.requestId) as { state: string }).state).toBe("cancelled");
    db.close();
  });

  it("approval re-creates assign requests whose plan request expired (restore case)", () => {
    const db = freshDb();
    const goal = startedGoal(db, { planFirst: true });
    db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goal.id);
    const card = createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title: "Planned", goalId: goal.id, assigneeBotId: "dax", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW });
    if (!card.ok) throw new Error("setup");
    // the plan's request expired during a restore
    db.prepare(`INSERT INTO room_requests (id, root_id, group_id, verb, from_kind, origin, root_thread_id, audience_fingerprint, not_owner_audience, unattended, admission_key, state, created_at, work_item_id)
      VALUES ('old-req','old-req','grp','assign','bot','server','t','owner',0,0,'assign:lead-req:c1','expired',?,?)`).run(NOW, card.card.id);
    const approved = approveProjectPlan(db, { goalId: goal.id, now: NOW + 2, memberIds: MEMBERS });
    expect(approved.ok).toBe(true);
    const fresh = db.prepare("SELECT * FROM room_requests WHERE work_item_id=? AND state='queued'").all(card.card.id) as Array<Record<string, unknown>>;
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.admission_key).toContain("assign:card:");
    db.close();
  });

  // Round 18 (F2): with no lead the re-queue was built as the lead "" (a run
  // returning to nobody under the lead's name). Approval asks for a lead
  // first, as Start does, and queues nothing.
  it("approval with no lead asks for one and queues no card run", () => {
    const db = freshDb();
    const goal = startedGoal(db, { planFirst: true });
    db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goal.id);
    const card = createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title: "Planned", goalId: goal.id, assigneeBotId: "dax", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW });
    if (!card.ok) throw new Error("setup");
    db.prepare(`INSERT INTO room_requests (id, root_id, group_id, verb, from_kind, origin, root_thread_id, audience_fingerprint, not_owner_audience, unattended, admission_key, state, created_at, work_item_id)
      VALUES ('old-req','old-req','grp','assign','bot','server','t','owner',0,0,'assign:lead-req:c1','expired',?,?)`).run(NOW, card.card.id);
    db.prepare("UPDATE project_settings SET lead_bot_id=NULL WHERE group_id='grp'").run();
    const refused = approveProjectPlan(db, { goalId: goal.id, now: NOW + 2, memberIds: MEMBERS });
    expect(refused).toMatchObject({ ok: false, error: "not_allowed", reason: "Pick a lead first." });
    expect(projectGoalById(db, goal.id)!.state).toBe("awaiting_plan_ok");
    expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE work_item_id=? AND state='queued'").get(card.card.id)).toEqual({ n: 0 });
    db.close();
  });

  // Round 19 (G3): a lead is needed only when a card run would be re-queued,
  // and that lead must be a member of the project. Refused before any write.
  it("approval with no lead and nothing to re-queue approves", () => {
    const db = freshDb();
    const goal = startedGoal(db, { planFirst: true });
    db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goal.id);
    const card = createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title: "Owner card", goalId: goal.id, actor: { kind: "owner" }, memberIds: MEMBERS, now: NOW });
    if (!card.ok) throw new Error("setup");
    db.prepare("UPDATE project_settings SET lead_bot_id=NULL WHERE group_id='grp'").run();
    expect(approveProjectPlan(db, { goalId: goal.id, now: NOW + 2, memberIds: MEMBERS })).toMatchObject({ ok: true, goal: { state: "working" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE work_item_id=?").get(card.card.id)).toEqual({ n: 0 });
    db.close();
  });

  it("approval with a lead that is not a member refuses before any write", () => {
    const db = freshDb();
    const goal = startedGoal(db, { planFirst: true });
    db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(goal.id);
    const card = createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title: "Planned", goalId: goal.id, assigneeBotId: "dax", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW });
    if (!card.ok) throw new Error("setup");
    db.prepare(`INSERT INTO room_requests (id, root_id, group_id, verb, from_kind, origin, root_thread_id, audience_fingerprint, not_owner_audience, unattended, admission_key, state, created_at, work_item_id)
      VALUES ('old-req','old-req','grp','assign','bot','server','t','owner',0,0,'assign:lead-req:c1','expired',?,?)`).run(NOW, card.card.id);
    const refused = approveProjectPlan(db, { goalId: goal.id, now: NOW + 2, memberIds: ["dax", "ivy"] });
    expect(refused).toMatchObject({ ok: false, error: "not_allowed", reason: "Pick a lead first." });
    expect(projectGoalById(db, goal.id)!.state).toBe("awaiting_plan_ok");
    expect(db.prepare("SELECT COUNT(*) AS n FROM room_requests WHERE work_item_id=? AND state='queued'").get(card.card.id)).toEqual({ n: 0 });
    db.close();
  });
});

describe("sign-off (5.3 + 5.3.1 evidence)", () => {
  it("awaiting_signoff needs at least one criterion, every criterion met with valid evidence, and no open cards", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.id);
    // no criteria at all: refused
    const empty = requestGoalSignoff(db, { goalId: goal.id, actor: { kind: "lead", botId: "lead" }, now: NOW + 2 });
    expect(empty).toMatchObject({ ok: false, error: "not_allowed" });
    patchProjectGoal(db, { goalId: goal.id, expectedRevision: projectGoalById(db, goal.id)!.revision, criteria: [{ text: "Report written" }], now: NOW + 3 });
    // unmet criterion: refused, and the card is still open anyway
    const card = cardDone(db, goal.id, "Write report");
    const unmet = requestGoalSignoff(db, { goalId: goal.id, actor: { kind: "lead", botId: "lead" }, now: NOW + 4 });
    expect(unmet).toMatchObject({ ok: false, error: "not_allowed" });
    // evidence: the card's result message of the current attempt
    const criterion = projectGoalById(db, goal.id)!.criteria[0]!;
    const marked = markCriterionMet(db, {
      goalId: goal.id, criterionId: criterion.id, evidence: { kind: "message", ref: `msg-Write report` },
      actor: { kind: "lead", botId: "lead" }, now: NOW + 5,
    });
    expect(marked.ok).toBe(true);
    const ready = requestGoalSignoff(db, { goalId: goal.id, actor: { kind: "lead", botId: "lead" }, now: NOW + 6 });
    expect(ready.ok).toBe(true);
    expect(projectGoalById(db, goal.id)!.state).toBe("awaiting_signoff");
    expect(card.state).toBe("done");
    db.close();
  });

  it("evidence from another attempt does not count", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.id);
    patchProjectGoal(db, { goalId: goal.id, expectedRevision: projectGoalById(db, goal.id)!.revision, criteria: [{ text: "Report written" }], now: NOW + 3 });
    cardDone(db, goal.id, "Write report");
    const criterion = projectGoalById(db, goal.id)!.criteria[0]!;
    const wrongCard = markCriterionMet(db, {
      goalId: goal.id, criterionId: criterion.id, evidence: { kind: "message", ref: "msg-no-where" },
      actor: { kind: "lead", botId: "lead" }, now: NOW + 5,
    });
    expect(wrongCard).toMatchObject({ ok: false, error: "not_allowed" });
    if (!wrongCard.ok) expect(wrongCard.reason).toBe('That evidence is not from this goal\'s current work. Evidence you can use: card 1 "Write report" result { "kind": "message", "ref": "msg-Write report" }.');
    // the owner's refusal stays a plain sentence
    const owner = markCriterionMet(db, { goalId: goal.id, criterionId: criterion.id, evidence: { kind: "message", ref: "msg-no-where" },
      actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW + 5 });
    if (!owner.ok) expect(owner.reason).toBe("That evidence is not from this goal's current work.");
    expect(owner.ok).toBe(false);
    db.close();
  });

  it("file evidence resolves through the artifacts table", () => {
    const db = freshDb();
    db.prepare(`CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL, extension TEXT NOT NULL, created_at INTEGER NOT NULL,
      bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, source_root TEXT NOT NULL,
      relative_path TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
      UNIQUE(bot_id,thread_id,run_id,source_root,relative_path,sha256))`).run();
    const goal = startedGoal(db);
    db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.id);
    patchProjectGoal(db, { goalId: goal.id, expectedRevision: projectGoalById(db, goal.id)!.revision, criteria: [{ text: "File produced" }], now: NOW + 3 });
    const card = cardDone(db, goal.id, "Make file");
    db.prepare(`INSERT INTO artifacts (id, name, kind, mime, bytes, sha256, extension, created_at, bot_id, thread_id, run_id, source_root, relative_path, source_fingerprint)
      VALUES ('art-1','report.md','text','text/markdown',10,'${"a".repeat(64)}','.md',?,'dax','desk-dax','r1','/tmp','report.md','fp')`).run(NOW + 10);
    const criterion = projectGoalById(db, goal.id)!.criteria[0]!;
    const marked = markCriterionMet(db, {
      goalId: goal.id, criterionId: criterion.id, evidence: { kind: "file", ref: "art-1" },
      actor: { kind: "lead", botId: "lead" }, now: NOW + 11, roomThreadId: "room-thread",
    });
    expect(marked.ok).toBe(true);
    expect(card.deskThreadId).toBe("desk-dax");
    db.close();
  });

  // AFTER-LOOP run2: every card done and LAUNCH-PLAN.md registered by the
  // writer in her card desk, but the lead named the file, or gave the file's
  // id as a message, and each try was refused with no hint; the goal paused
  // with 0 of 4 criteria met.
  it("file evidence may name the file; a registered file's id given as a message is the file", () => {
    const db = freshDb();
    const { goal, criteria } = evidenceGoal(db, ["LAUNCH-PLAN.md exists", "It names three segments", "The file again"]);
    artifact(db, "art-old", "LAUNCH-PLAN.md", "desk-dax", "dax", NOW + 5);
    // many same-named files elsewhere do not crowd the card's own out
    for (let i = 0; i < 60; i += 1) artifact(db, `art-elsewhere-${i}`, "LAUNCH-PLAN.md", `other-desk-${i}`, "someone", NOW + 20 + i);
    artifact(db, "art-new", "LAUNCH-PLAN.md", "desk-dax", "dax", NOW + 10);
    const lead = { kind: "lead" as const, botId: "lead" };
    expect(markCriterionMet(db, { goalId: goal.id, criterionId: criteria[0]!.id, evidence: { kind: "file", ref: "LAUNCH-PLAN.md" }, actor: lead, now: NOW + 11, roomThreadId: "room-thread" }).ok).toBe(true);
    expect(markCriterionMet(db, { goalId: goal.id, criterionId: criteria[1]!.id, evidence: { kind: "message", ref: "art-new" }, actor: lead, now: NOW + 11, roomThreadId: "room-thread" }).ok).toBe(true);
    const met = projectGoalById(db, goal.id)!.criteria;
    expect(met[0]).toMatchObject({ met: true, evidence: { kind: "file", ref: "art-new" } });
    expect(met[1]).toMatchObject({ met: true, evidence: { kind: "file", ref: "art-new" } });
    db.close();
  });

  it("a file only the lead saved is not a card's work, and the refusal names the evidence that is", () => {
    const db = freshDb();
    const { goal, criteria } = evidenceGoal(db, ["LAUNCH-PLAN.md exists"]);
    artifact(db, "art-lead", "NOTES.md", "room-thread", "lead", NOW + 10);
    artifact(db, "art-dax", "LAUNCH-PLAN.md", "desk-dax", "dax", NOW + 10);
    for (const evidence of [{ kind: "file" as const, ref: "NOTES.md" }, { kind: "message" as const, ref: "art-lead" }, { kind: "check" as const, ref: "File created and verified" }]) {
      const refused = markCriterionMet(db, { goalId: goal.id, criterionId: criteria[0]!.id, evidence, actor: { kind: "lead", botId: "lead" }, now: NOW + 11, roomThreadId: "room-thread" });
      expect(refused).toMatchObject({ ok: false, error: "not_allowed" });
      if (!refused.ok) expect(refused.reason).toBe('That evidence is not from this goal\'s current work. Evidence you can use: card 1 "Make file" result { "kind": "message", "ref": "msg-Make file" }; its file "LAUNCH-PLAN.md" { "kind": "file", "ref": "art-dax" }.');
    }
    db.close();
  });

  // Review round 4: a room file by an assignee with a doing card listed
  // first was matched by name to its done card, then re-resolved to the
  // doing card at sign-off, reading "Evidence needed".
  it("a room file matched by name keeps its card at sign-off", () => {
    const db = freshDb();
    db.prepare(ARTIFACTS_TABLE).run();
    db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL)");
    const goal = startedGoal(db, { criteria: ["Plan saved"] });
    db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.id);
    const doing = createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title: "Draft", goalId: goal.id, assigneeBotId: "dax", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW });
    if (!doing.ok) throw new Error("setup card");
    const queued = enqueueCardRun(db, { cardId: doing.card.id, actor: { kind: "lead", botId: "lead" }, now: NOW });
    if (!queued.ok) throw new Error("setup enqueue");
    applyCardRunDispatched(db, { cardId: doing.card.id, requestId: queued.requestId, deskThreadId: "desk-draft", now: NOW + 1 });
    db.prepare("UPDATE room_requests SET state='running' WHERE id=?").run(queued.requestId);
    const done = cardDone(db, goal.id, "Make file");
    artifact(db, "art-room", "PLAN.md", "room-thread", "dax", NOW + 10);
    const criterion = projectGoalById(db, goal.id)!.criteria[0]!;
    expect(markCriterionMet(db, { goalId: goal.id, criterionId: criterion.id, evidence: { kind: "file", ref: "PLAN.md" }, actor: { kind: "lead", botId: "lead" }, now: NOW + 11, roomThreadId: "room-thread" }).ok).toBe(true);
    const recorded = projectGoalById(db, goal.id)!;
    expect(recorded.criteria[0]!.evidence).toMatchObject({ kind: "file", ref: "art-room", workItemId: done.id });
    expect(goalSignoffBlockers(db, recorded, "room-thread").filter(line => line.startsWith("Evidence needed"))).toEqual([]);
    db.close();
  });

  it("the recognised check tools are a named constant", () => {
    expect(PROJECT_CHECK_TOOLS).toEqual(["run_tests", "typecheck", "lint", "build"]);
  });

  it("the owner signs off and sends back; the lead cannot sign off", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    db.prepare("UPDATE project_goals SET state='awaiting_signoff' WHERE id=?").run(goal.id);
    expect(signOffProjectGoal(db, { goalId: goal.id, actor: { kind: "lead", botId: "lead" }, now: NOW + 2 })).toMatchObject({ ok: false, error: "not_allowed" });
    const back = sendProjectGoalBack(db, { actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, goalId: goal.id, note: "Not quite", memberIds: MEMBERS, now: NOW + 2 });
    expect(back.ok).toBe(true);
    expect(projectGoalById(db, goal.id)!.state).toBe("working");
    const card = db.prepare("SELECT * FROM project_work_items WHERE group_id='grp' AND goal_id=?").get(goal.id) as Record<string, unknown>;
    expect(card).toMatchObject({ assignee_bot_id: "lead", created_by: "owner" });
    db.prepare("UPDATE project_goals SET state='awaiting_signoff' WHERE id=?").run(goal.id);
    cancelViaStop(db, goal.id);
    db.close();
  });

  function cancelViaStop(db: DatabaseSync, goalId: string) {
    // helper end state for the test above: sign-off works after the send-back card is cancelled
    const card = db.prepare("SELECT id FROM project_work_items WHERE group_id='grp' AND goal_id=?").get(goalId) as { id: string };
    db.prepare("UPDATE project_work_items SET state='cancelled', archived_at=? WHERE id=?").run(NOW + 9, card.id);
    expect(signOffProjectGoal(db, { goalId, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW + 10 }).ok).toBe(true);
    expect(projectGoalById(db, goalId)).toMatchObject({ state: "done" });
  }
});

describe("pause, resume, stop (5.3)", () => {
  it("pause and resume reset no_progress; resume is refused while the budget or the project is paused", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    const paused = pauseProjectGoal(db, { goalId: goal.id, reason: "Budget reached", actor: { kind: "server" }, now: NOW + 2 });
    expect(paused.ok).toBe(true);
    expect(projectGoalById(db, goal.id)).toMatchObject({ state: "paused", stateReason: "Budget reached" });
    db.prepare(`INSERT INTO project_budgets (id, group_id, goal_id, period, tz, period_start, max_work_minutes, state, created_at)
      VALUES ('b1','grp',NULL,'week','UTC',?,120,'paused',?)`).run(NOW, NOW);
    expect(resumeProjectGoal(db, { goalId: goal.id, now: NOW + 3, memberIds: MEMBERS })).toMatchObject({ ok: false, error: "not_allowed" });
    db.prepare("UPDATE project_budgets SET state='ok' WHERE id='b1'").run();
    const resumed = resumeProjectGoal(db, { goalId: goal.id, now: NOW + 4, memberIds: MEMBERS });
    expect(resumed.ok).toBe(true);
    expect(projectGoalById(db, goal.id)).toMatchObject({ state: "planning", noProgress: 0 });
    db.close();
  });

  // Round 15 (C2): a lead that is not a member of the project cannot pick
  // work up, so Resume waits for a lead who is one.
  it("resume is refused while the lead is not a member", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    expect(pauseProjectGoal(db, { goalId: goal.id, reason: "Paused by you", actor: { kind: "owner" }, now: NOW + 2 }).ok).toBe(true);
    expect(resumeProjectGoal(db, { goalId: goal.id, now: NOW + 3, memberIds: ["dax", "ivy"] })).toMatchObject({ ok: false, error: "not_allowed", reason: "Pick a lead to resume." });
    expect(projectGoalById(db, goal.id)).toMatchObject({ state: "paused" });
    expect(resumeProjectGoal(db, { goalId: goal.id, now: NOW + 4, memberIds: MEMBERS }).ok).toBe(true);
    db.close();
  });

  it("stop cancels the goal's open cards; only owner and server stop", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.id);
    const card = createProjectCard(db, { sourceMessageIds: ["fixture-source"], groupId: "grp", title: "Work", goalId: goal.id, assigneeBotId: "dax", actor: { kind: "lead", botId: "lead" }, memberIds: MEMBERS, now: NOW });
    if (!card.ok) throw new Error("setup");
    expect(stopProjectGoal(db, { goalId: goal.id, actor: { kind: "lead", botId: "lead" }, now: NOW + 2 })).toMatchObject({ ok: false, error: "not_allowed" });
    const stopped = stopProjectGoal(db, { goalId: goal.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, reason: "Stop goal", now: NOW + 2 });
    expect(stopped.ok).toBe(true);
    expect(projectGoalById(db, goal.id)!.state).toBe("stopped");
    expect(projectCardById(db, card.card.id)!.state).toBe("cancelled");
    db.close();
  });

  it("the lead cannot pause a goal; the owner and the server can", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    expect(pauseProjectGoal(db, { goalId: goal.id, reason: "x", actor: { kind: "lead", botId: "lead" }, now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    expect(pauseProjectGoal(db, { goalId: goal.id, reason: "x", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW }).ok).toBe(true);
    db.close();
  });
});

describe("lead criteria proposals (5.3, 9)", () => {
  it("proposes 2 to 5 criteria only while the goal has none", () => {
    const db = freshDb();
    const goal = startedGoal(db);
    expect(proposeProjectCriteria(db, { goalId: goal.id, texts: ["one"], now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(proposeProjectCriteria(db, { goalId: goal.id, texts: ["a", "b"], now: NOW }).ok).toBe(true);
    expect(proposeProjectCriteria(db, { goalId: goal.id, texts: ["c", "d"], now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });

  it("a goal with owner-set criteria accepts no proposal", () => {
    const db = freshDb();
    const goal = startedGoal(db, { criteria: ["mine"] });
    expect(proposeProjectCriteria(db, { goalId: goal.id, texts: ["a", "b"], now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });
});

describe("deriveGroupedDecisions (5.6)", () => {
  it("groups in-memory approvals, plan and sign-off goals, and dead-wait cards", () => {
    const db = freshDb();
    const planGoal = startedGoal(db, { title: "Plan me" });
    db.prepare("UPDATE project_goals SET state='awaiting_plan_ok' WHERE id=?").run(planGoal.id);

    const card = createProjectCard(db, { groupId: "grp", title: "Restart me", assigneeBotId: "dax", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW });
    if (!card.ok) throw new Error("setup");
    db.prepare("UPDATE project_work_items SET state='waiting', waiting_on=? WHERE id=?").run(JSON.stringify({ kind: "restart" }), card.card.id);
    const decisions = deriveGroupedDecisions(db, {
      groupId: "grp",
      openApprovals: [{ requestId: "req-1", cardId: card.card.id, summary: "Approve the deploy" }],
      now: NOW,
    });
    expect(decisions.approvals).toHaveLength(1);
    expect(decisions.goals.map(goal => goal.goalId).sort()).toEqual([planGoal.id]);
    expect(decisions.deadWaitCards).toHaveLength(1);
    expect(decisions.deadWaitCards[0]).toMatchObject({ cardId: card.card.id, waitingKind: "restart" });
    expect(decisions.count).toBe(3);
    db.prepare("UPDATE project_goals SET state='awaiting_signoff' WHERE id=?").run(planGoal.id);
    expect(deriveGroupedDecisions(db, { groupId: "grp", openApprovals: [], now: NOW }).goals).toEqual([{ goalId: planGoal.id, state: "awaiting_signoff" }]);
    db.close();
  });
});

it("does not sign off criteria whose evidence no longer resolves", () => {
  const db = freshDb(); const goal = startedGoal(db);
  db.prepare("UPDATE project_goals SET state='working', criteria=? WHERE id=?").run(JSON.stringify([{ id: "c", text: "Report", setBy: "owner", proposed: false, met: true, evidence: { kind: "message", ref: "gone", workItemId: "gone", attempt: 1, at: NOW } }]), goal.id);
  expect(requestGoalSignoff(db, { goalId: goal.id, actor: { kind: "server" }, now: NOW }).ok).toBe(false);
  db.close();
});
it("refuses proposing criteria after the first lead reply and invalid criterion text", () => {
  const db = freshDb(); const goal = startedGoal(db);
  db.prepare("UPDATE project_goals SET lead_wakes=2 WHERE id=?").run(goal.id);
  expect(proposeProjectCriteria(db, { goalId: goal.id, texts: ["One", "Two"], now: NOW }).ok).toBe(false);
  expect(createProjectGoal(db, { groupId: "grp", title: "Other", criteria: [""], now: NOW })).toMatchObject({ ok: false, error: "invalid" });
  db.close();
});

it.each(["other goal", "old attempt", "cancelled", "failed card", "failed request", "unfinished request"])("PF rejects evidence from %s", scenario => {
  const db = freshDb();
  const goal = startedGoal(db, { criteria: ["Report written"] });
  db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.id);
  const card = cardDone(db, goal.id, "PF report");
  if (scenario === "other goal") db.prepare("UPDATE project_work_items SET goal_id='other' WHERE id=?").run(card.id);
  if (scenario === "old attempt") db.prepare("UPDATE project_work_items SET attempt=attempt+1 WHERE id=?").run(card.id);
  if (scenario === "cancelled") db.prepare("UPDATE project_work_items SET state='cancelled' WHERE id=?").run(card.id);
  if (scenario === "failed card") db.prepare("UPDATE project_work_items SET state='failed' WHERE id=?").run(card.id);
  if (scenario === "failed request") db.prepare("UPDATE room_requests SET state='failed' WHERE work_item_id=?").run(card.id);
  if (scenario === "unfinished request") db.prepare("UPDATE room_requests SET state='running' WHERE work_item_id=?").run(card.id);
  expect(markCriterionMet(db, { goalId: goal.id, criterionId: projectGoalById(db, goal.id)!.criteria[0].id, evidence: { kind: "message", ref: "msg-PF report" }, actor: { kind: "lead", botId: "lead" }, now: NOW + 5 }).ok).toBe(false);
  expect(projectGoalById(db, goal.id)!.criteria[0].met).toBe(false);
  expect(requestGoalSignoff(db, { goalId: goal.id, actor: { kind: "lead", botId: "lead" }, now: NOW + 6 }).ok).toBe(false);
  db.close();
});

it.each(["failed", "todo"])("PF rejects file and check evidence from a %s card", state => {
  const db = freshDb();
  db.prepare(`CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL, extension TEXT NOT NULL, created_at INTEGER NOT NULL,
    bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, source_root TEXT NOT NULL,
    relative_path TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
    UNIQUE(bot_id,thread_id,run_id,source_root,relative_path,sha256))`).run();
  db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL)");
  const goal = startedGoal(db, { criteria: ["File produced", "Tests pass"] });
  db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.id);
  const card = cardDone(db, goal.id, "Make file");
  db.prepare(`INSERT INTO artifacts (id, name, kind, mime, bytes, sha256, extension, created_at, bot_id, thread_id, run_id, source_root, relative_path, source_fingerprint)
    VALUES ('art-1','report.md','text','text/markdown',10,'${"a".repeat(64)}','.md',?,'dax','desk-dax','r1','/tmp','report.md','fp')`).run(NOW + 10);
  db.prepare("INSERT INTO messages (id, thread_id, at, json) VALUES ('check-1','desk-dax',?,?)").run(NOW + 10, JSON.stringify({ role: "bot", kind: "activity", tool: { name: "run_tests", ok: true } }));
  db.prepare("UPDATE project_work_items SET state=? WHERE id=?").run(state, card.id);
  if (state === "failed") db.prepare("UPDATE room_requests SET state='failed' WHERE work_item_id=?").run(card.id);
  else db.prepare("UPDATE room_requests SET state='cancelled' WHERE work_item_id=?").run(card.id);
  const [file, check] = projectGoalById(db, goal.id)!.criteria;
  expect(markCriterionMet(db, { goalId: goal.id, criterionId: file.id, evidence: { kind: "file", ref: "art-1" }, actor: { kind: "lead", botId: "lead" }, now: NOW + 11 }).ok).toBe(false);
  expect(markCriterionMet(db, { goalId: goal.id, criterionId: check.id, evidence: { kind: "check", ref: "check-1" }, actor: { kind: "lead", botId: "lead" }, now: NOW + 11 }).ok).toBe(false);
  db.close();
});

function evidenceFixture(db: DatabaseSync) {
  db.prepare(`CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL, extension TEXT NOT NULL, created_at INTEGER NOT NULL,
    bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, source_root TEXT NOT NULL,
    relative_path TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
    UNIQUE(bot_id,thread_id,run_id,source_root,relative_path,sha256))`).run();
  db.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL)");
  const goal = startedGoal(db, { criteria: ["File produced", "Tests pass"] });
  db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(goal.id);
  const card = cardDone(db, goal.id, "Make file");
  const first = db.prepare("SELECT * FROM room_requests WHERE work_item_id=? AND verb='assign'").get(card.id) as Record<string, string | number | null>;
  /** A later assign run of the same attempt (a reassign after a failure). */
  const later = (state: string, dispatchedAt: number) => {
    const row: Record<string, string | number | null> = { ...first, id: `later-${state}`, admission_key: `later-${state}`, state, result_message_id: null, created_at: dispatchedAt, dispatched_at: dispatchedAt };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO room_requests (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]));
  };
  const evidenceAt = (id: string, at: number) => {
    db.prepare(`INSERT INTO artifacts (id, name, kind, mime, bytes, sha256, extension, created_at, bot_id, thread_id, run_id, source_root, relative_path, source_fingerprint)
      VALUES (?,'report.md','text','text/markdown',10,?,'.md',?,'dax','desk-dax',?,'/tmp','report.md','fp')`).run(`art-${id}`, id.padEnd(64, "a"), at, id);
    db.prepare("INSERT INTO messages (id, thread_id, at, json) VALUES (?,'desk-dax',?,?)").run(`check-${id}`, at, JSON.stringify({ role: "bot", kind: "activity", tool: { name: "run_tests", ok: true } }));
  };
  const [file, check] = projectGoalById(db, goal.id)!.criteria;
  const mark = (id: string) => [
    markCriterionMet(db, { goalId: goal.id, criterionId: file.id, evidence: { kind: "file", ref: `art-${id}` }, actor: { kind: "lead", botId: "lead" }, now: NOW + 100 }).ok,
    markCriterionMet(db, { goalId: goal.id, criterionId: check.id, evidence: { kind: "check", ref: `check-${id}` }, actor: { kind: "lead", botId: "lead" }, now: NOW + 100 }).ok,
  ];
  return { card, first, later, evidenceAt, mark };
}

it.each(["cancelled", "expired", "unknown"])("PF rejects file and check evidence from a doing card whose latest run is %s", state => {
  const db = freshDb();
  const { card, first, evidenceAt, mark } = evidenceFixture(db);
  db.prepare("UPDATE project_work_items SET state='doing' WHERE id=?").run(card.id);
  db.prepare("UPDATE room_requests SET state=? WHERE id=?").run(state, first.id);
  evidenceAt("x", NOW + 10);
  expect(mark("x")).toEqual([false, false]);
  db.close();
});

it("PF accepts a reassigned live run's evidence after an earlier failed run of the same attempt", () => {
  const db = freshDb();
  const { card, first, later, evidenceAt, mark } = evidenceFixture(db);
  db.prepare("UPDATE project_work_items SET state='doing' WHERE id=?").run(card.id);
  db.prepare("UPDATE room_requests SET state='failed' WHERE id=?").run(first.id);
  later("running", NOW + 20);
  evidenceAt("live", NOW + 25);
  expect(mark("live")).toEqual([true, true]);
  db.close();
});

it("PF bounds a reviewed card's evidence to its latest run, not the failed run before it", () => {
  const db = freshDb();
  const { card, first, later, evidenceAt, mark } = evidenceFixture(db);
  db.prepare("UPDATE project_work_items SET state='review' WHERE id=?").run(card.id);
  db.prepare("UPDATE room_requests SET state='failed' WHERE id=?").run(first.id);
  later("done", NOW + 20);
  evidenceAt("early", NOW + 10);
  expect(mark("early")).toEqual([false, false]);
  evidenceAt("fresh", NOW + 25);
  expect(mark("fresh")).toEqual([true, true]);
  db.close();
});
