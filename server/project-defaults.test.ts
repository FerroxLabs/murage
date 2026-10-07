// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane R tests for the approved owner-decision constants and the default
// goal budget seam lane B extends (.lane-brief.md section 2; SPEC-P 3.7).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_GOAL_REVIEW,
  DEFAULT_GOAL_TOKENS,
  DEFAULT_GOAL_WORK_MINUTES,
  DEFAULT_PROJECT_PARALLEL_CARDS,
  DEFAULT_PROJECT_PARTS,
  PROJECT_CARD_RUNS_INSTALL_CAP,
  createDefaultGoalBudget,
  createDefaultPeriodBudget,
  projectsAutonomyEnabled,
  projectsGoalsEnabled,
  projectsLeadEnabled,
} from "./project-defaults.ts";
import { initializeProjectTables } from "./project-tables.ts";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initializeProjectTables(db);
  return db;
}

describe("owner-decision constants (approved 2026-09-28)", () => {
  it("holds the approved values", () => {
    expect(DEFAULT_PROJECT_PARALLEL_CARDS).toBe(3);
    expect(PROJECT_CARD_RUNS_INSTALL_CAP).toBe(4);
    expect(DEFAULT_GOAL_WORK_MINUTES).toBe(120);
    expect(DEFAULT_GOAL_TOKENS).toBe(3_000_000);
    expect(DEFAULT_GOAL_REVIEW).toBe(true);
    expect(DEFAULT_PROJECT_PARTS).toEqual({ board: true, review: true, digest: false });
  });
});

describe("feature flag readers", () => {
  it("defaults every projects flag to on when the key is absent", () => {
    expect(projectsAutonomyEnabled(undefined)).toBe(true);
    expect(projectsAutonomyEnabled({})).toBe(true);
    expect(projectsLeadEnabled({})).toBe(true);
    expect(projectsGoalsEnabled({})).toBe(true);
  });
  it("reads an explicit off", () => {
    expect(projectsAutonomyEnabled({ projectsAutonomy: false })).toBe(false);
    expect(projectsLeadEnabled({ projectsLead: false })).toBe(false);
    expect(projectsGoalsEnabled({ projectsGoals: false })).toBe(false);
  });
});

describe("createDefaultGoalBudget", () => {
  it("inserts the goal budget with the approved defaults, explicitly", () => {
    const db = freshDb();
    const budget = createDefaultGoalBudget(db, { groupId: "grp", goalId: "g1", tz: "Europe/Dublin", now: 1000 });
    expect(budget).toMatchObject({
      groupId: "grp", goalId: "g1", period: "goal", tz: "Europe/Dublin",
      periodStart: 1000, maxWorkMinutes: 120, maxTokens: 3_000_000, state: "ok",
    });
    const row = db.prepare("SELECT * FROM project_budgets WHERE goal_id='g1'").get() as Record<string, unknown>;
    expect(row.max_work_minutes).toBe(120);
    expect(row.max_tokens).toBe(3_000_000);
    db.close();
  });

  it("is idempotent: a second start of the same goal returns the existing row", () => {
    const db = freshDb();
    const first = createDefaultGoalBudget(db, { groupId: "grp", goalId: "g1", tz: "Europe/Dublin", now: 1000 });
    const second = createDefaultGoalBudget(db, { groupId: "grp", goalId: "g1", tz: "Europe/Dublin", now: 2000 });
    expect(second.id).toBe(first.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_budgets").get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe("createDefaultPeriodBudget", () => {
  it("creates one period budget per project and never a second", () => {
    const db = freshDb();
    const first = createDefaultPeriodBudget(db, { groupId: "grp", period: "week", tz: "Europe/Dublin", now: 1000 });
    expect(first).toMatchObject({ period: "week", maxWorkMinutes: 120, maxTokens: 3_000_000, state: "ok" });
    const again = createDefaultPeriodBudget(db, { groupId: "grp", period: "week", tz: "Europe/Dublin", now: 2000 });
    expect(again.id).toBe(first.id);
    db.close();
  });
});

it("keeps project feature flags through config parsing", async () => {
  const { parseStoredConfig } = await import("./config.ts");
  expect(parseStoredConfig({ features: { projectsLead: false, projectsGoals: false } }).features).toMatchObject({ projectsLead: false, projectsGoals: false });
});
