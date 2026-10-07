// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane R settings and lifecycle tests (SPEC-P 3.1, 5.7): settings PATCH with
// revision conflicts, lead/board off pausing the active goal, viewed marks,
// End project, make-a-project (channel to project, including after End),
// and the closed/reopened row writers lane N uses.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { initializeProjectTables } from "./project-tables.ts";
import {
  channelToProjectRows,
  endProjectRows,
  markProjectViewed,
  patchProjectSettings,
  setProjectClosed,
  setProjectReopened,
} from "./project-settings.ts";
import { createProjectGoal, startProjectGoal } from "./project-goals.ts";
import { createProjectCard, enqueueCardRun } from "./project-cards.ts";
import { currentProjectBrief, projectCardById, projectGoalById, projectSettingsFor } from "./project-records.ts";

const NOW = 1_700_400_000_000;
const MEMBERS = ["lead", "dax"];

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  db.prepare(`INSERT INTO project_settings
    (group_id, mode, lead_bot_id, parts, parallel_cards, work_roots, work_profile, run_state, revision, updated_at)
    VALUES ('grp','conversation','lead','{"board":true,"review":true,"digest":false}',3,'[]','ask','running',0,?)`).run(NOW);
  return db;
}

describe("patchProjectSettings", () => {
  it("changes mode, lead, parts and parallel cards, bumping the revision", () => {
    const db = freshDb();
    const result = patchProjectSettings(db, { groupId: "grp", expectedRevision: 0, mode: "ongoing", parallelCards: 2, tz: "UTC", memberIds: MEMBERS, now: NOW + 1 });
    expect(result.ok).toBe(true);
    const settings = projectSettingsFor(db, "grp")!;
    expect(settings).toMatchObject({ mode: "ongoing", parallelCards: 2, revision: 1 });
    // switching to ongoing creates the week budget with the approved defaults
    const budget = db.prepare("SELECT * FROM project_budgets WHERE group_id='grp'").get() as Record<string, unknown>;
    expect(budget).toMatchObject({ period: "week", max_work_minutes: 120 });
    expect(lastActivityKind(db)).toBe("settings");
    db.close();
  });

  it("a stale expectedRevision is 409 changed with the current settings", () => {
    const db = freshDb();
    const stale = patchProjectSettings(db, { groupId: "grp", expectedRevision: 3, mode: "ongoing", tz: "UTC", memberIds: MEMBERS, now: NOW });
    expect(stale).toMatchObject({ ok: false, error: "changed" });
    if (!stale.ok && stale.error === "changed") expect(stale.settings.revision).toBe(0);
    db.close();
  });

  it("refuses an unknown parts key, an out-of-range parallel count and a non-member lead", () => {
    const db = freshDb();
    expect(patchProjectSettings(db, { groupId: "grp", expectedRevision: 0, parts: { bogus: true } as never, memberIds: MEMBERS, now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(patchProjectSettings(db, { groupId: "grp", expectedRevision: 0, parallelCards: 9, memberIds: MEMBERS, now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    expect(patchProjectSettings(db, { groupId: "grp", expectedRevision: 0, leadBotId: "outsider", memberIds: MEMBERS, now: NOW })).toMatchObject({ ok: false, error: "invalid" });
    db.close();
  });

  it("turning the lead off pauses the active goal; turning the board off does too", () => {
    const db = freshDb();
    const goal = createProjectGoal(db, { groupId: "grp", title: "Run", now: NOW });
    if (!goal.ok) throw new Error("setup");
    startProjectGoal(db, { goalId: goal.goal.id, now: NOW, tz: "UTC" });
    const off = patchProjectSettings(db, { groupId: "grp", expectedRevision: projectSettingsFor(db, "grp")!.revision, leadBotId: null, memberIds: MEMBERS, now: NOW + 1 });
    expect(off.ok).toBe(true);
    expect(projectGoalById(db, goal.goal.id)).toMatchObject({ state: "paused", stateReason: "Pick a lead to resume" });
    const db2 = freshDb();
    const goal2 = createProjectGoal(db2, { groupId: "grp", title: "Run", now: NOW });
    if (!goal2.ok) throw new Error("setup");
    startProjectGoal(db2, { goalId: goal2.goal.id, now: NOW, tz: "UTC" });
    patchProjectSettings(db2, { groupId: "grp", expectedRevision: projectSettingsFor(db2, "grp")!.revision, parts: { board: false }, memberIds: MEMBERS, now: NOW + 1 });
    expect(projectGoalById(db2, goal2.goal.id)!.state).toBe("paused");
    db.close(); db2.close();
  });

  it("ongoing -> conversation keeps the period budget", () => {
    const db = freshDb();
    patchProjectSettings(db, { groupId: "grp", expectedRevision: 0, mode: "ongoing", tz: "UTC", memberIds: MEMBERS, now: NOW });
    const back = patchProjectSettings(db, { groupId: "grp", expectedRevision: 1, mode: "conversation", memberIds: MEMBERS, now: NOW + 1 });
    expect(back.ok).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_budgets WHERE group_id='grp' AND period='week'").get() as { n: number }).n).toBe(1);
    db.close();
  });
});

function lastActivityKind(db: DatabaseSync): string | null {
  return (db.prepare("SELECT kind FROM project_activity ORDER BY at DESC, rowid DESC LIMIT 1").get() as { kind: string } | undefined)?.kind ?? null;
}

describe("markProjectViewed", () => {
  it("stamps the since-you-left cursor", () => {
    const db = freshDb();
    markProjectViewed(db, { groupId: "grp", now: NOW + 5 });
    expect(projectSettingsFor(db, "grp")!.ownerViewedAt).toBe(NOW + 5);
    db.close();
  });
});

describe("End project (5.7)", () => {
  it("stops the active goal, cancels open cards and requests, clears authority fields, keeps the row", () => {
    const db = freshDb();
    const goal = createProjectGoal(db, { groupId: "grp", title: "Run", now: NOW });
    if (!goal.ok) throw new Error("setup");
    startProjectGoal(db, { goalId: goal.goal.id, now: NOW, tz: "UTC" });
    const card = createProjectCard(db, { groupId: "grp", title: "Work", goalId: goal.goal.id, assigneeBotId: "dax", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: MEMBERS, now: NOW });
    if (!card.ok) throw new Error("setup");
    const queued = enqueueCardRun(db, { cardId: card.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: NOW });
    if (!queued.ok) throw new Error("setup");
    db.prepare("UPDATE project_settings SET work_roots=?, work_profile='auto-in-roots' WHERE group_id='grp'")
      .run(JSON.stringify([{ path: "/tmp/x", dev: "1", ino: "2", label: "x", addedAt: 1 }]));
    const result = endProjectRows(db, { groupId: "grp", now: NOW + 9 });
    expect(result.ok).toBe(true);
    const settings = projectSettingsFor(db, "grp")!;
    expect(settings.endedAt).toBe(NOW + 9);
    expect(settings).toMatchObject({ workRoots: [], workProfile: "ask", runState: "running" });
    expect(projectGoalById(db, goal.goal.id)!.state).toBe("stopped");
    const after = projectCardById(db, card.card.id)!;
    expect(after).toMatchObject({ state: "cancelled" });
    expect(after.archivedAt).toBeGreaterThan(0);
    expect((db.prepare("SELECT state FROM room_requests WHERE id=?").get(queued.requestId) as { state: string }).state).toBe("cancelled");
    // the JSON step copies the current brief rules back into the bulletin
    expect(result.ok && result.bulletin).toBe("");
    db.close();
  });

  it("history stays readable after End project; writes are refused", () => {
    const db = freshDb();
    endProjectRows(db, { groupId: "grp", now: NOW });
    expect(projectSettingsFor(db, "grp")!.endedAt).toBe(NOW);
    expect(currentProjectBrief(db, "grp")).toBeNull(); // never had one; settings row survives regardless
    expect(createProjectGoal(db, { groupId: "grp", title: "x", now: NOW })).toMatchObject({ ok: false, error: "not_allowed" });
    db.close();
  });
});

describe("channel to project (5.7), including after End project", () => {
  it("inserts settings and a brief version from the bulletin", () => {
    const db = freshDb();
    db.prepare("DELETE FROM project_settings WHERE group_id='grp'").run();
    const created = channelToProjectRows(db, { groupId: "grp", bulletin: "The bulletin", leadBotId: "lead", now: NOW });
    expect(created.ok).toBe(true);
    expect(projectSettingsFor(db, "grp")).toMatchObject({ endedAt: null, runState: "running" });
    expect(currentProjectBrief(db, "grp")).toMatchObject({ version: 1, rules: "The bulletin" });
    db.close();
  });

  it("re-making a project after End clears ended_at and continues the brief versions", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO project_briefs (group_id, version, summary, done_means, rules, where_work_is, decisions, updated_by, change, updated_at)
      VALUES ('grp',1,'','','old rules','[]','[]','owner','owner_edit',?)`).run(NOW);
    endProjectRows(db, { groupId: "grp", now: NOW });
    expect(projectSettingsFor(db, "grp")!.endedAt).toBe(NOW);
    const remade = channelToProjectRows(db, { groupId: "grp", bulletin: "new bulletin", leadBotId: "dax", now: NOW + 10 });
    expect(remade.ok).toBe(true);
    const settings = projectSettingsFor(db, "grp")!;
    expect(settings.endedAt).toBeNull();
    const brief = currentProjectBrief(db, "grp")!;
    expect(brief).toMatchObject({ version: 2, rules: "new bulletin" });
    db.close();
  });
});

describe("closed/reopened row writers (5.7, for lane N)", () => {
  it("setProjectClosed stamps closed_at; setProjectReopened clears it and leaves run_state paused", () => {
    const db = freshDb();
    setProjectClosed(db, { groupId: "grp", at: NOW + 1 });
    expect(projectSettingsFor(db, "grp")!.closedAt).toBe(NOW + 1);
    setProjectReopened(db, { groupId: "grp", at: NOW + 2 });
    const settings = projectSettingsFor(db, "grp")!;
    expect(settings.closedAt).toBeNull();
    expect(settings.runState).toBe("paused"); // the owner resumes
    expect(lastActivityKind(db)).toBe("reopen");
    db.close();
  });
});
