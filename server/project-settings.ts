// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Project settings and lifecycle (SPEC-P 3.1 and 5.7). The settings row owns
// mode, lead, parts, parallel cards, work roots and profile, run_state and
// the lifecycle columns. Rows first, JSON second: these functions only touch
// messages.db inside the caller's transaction; the caller (a route, lane N,
// the reconciler) writes groups.json and the desk archive stamps after.
import { projectIsClosing } from "./project-records.ts";
import type { DatabaseSync } from "node:sqlite";

import { createDefaultPeriodBudget, DEFAULT_PROJECT_PARALLEL_CARDS, DEFAULT_PROJECT_PARTS, type ProjectFeatureFlags } from "./project-defaults.ts";
import { insertProjectBriefVersion, insertProjectActivity, projectSettingsFor, currentProjectBrief, type ProjectParts, type ProjectSettings } from "./project-records.ts";
import { cancelProjectCard, type ProjectActor } from "./project-cards.ts";
import { pauseProjectGoal, stopProjectGoal } from "./project-goals.ts";
import { activeProjectGoal } from "./project-records.ts";

export type SettingsFailure =
  | { ok: false; error: "not_allowed"; reason: string }
  | { ok: false; error: "invalid"; reason: string }
  | { ok: false; error: "not_found"; reason: string }
  | { ok: false; error: "changed"; reason: string; settings: ProjectSettings };

export type SettingsOutcome = { ok: true; settings: ProjectSettings } | SettingsFailure;

const invalid = (reason: string): SettingsFailure => ({ ok: false, error: "invalid", reason });

function writeSettings(db: DatabaseSync, groupId: string, fields: Record<string, unknown>, now: number): void {
  const sets: string[] = ["revision=revision+1", "updated_at=?"];
  const values: unknown[] = [now];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key}=?`);
    values.push(value === undefined ? null : value);
  }
  values.push(groupId);
  db.prepare(`UPDATE project_settings SET ${sets.join(", ")} WHERE group_id=?`).run(...values as never[]);
}

/** O: the settings PATCH (11.1). Revision-checked. Turning the lead or the
 * board off pauses the active goal with its line (5.7). Switching to ongoing
 * creates the period budget when none exists. */
export function patchProjectSettings(
  db: DatabaseSync,
  input: {
    groupId: string;
    expectedRevision: number;
    mode?: "conversation" | "ongoing";
    leadBotId?: string | null;
    parts?: Partial<ProjectParts>;
    parallelCards?: number;
    memberIds: string[];
    tz?: string;
    now: number;
  },
): SettingsOutcome {
  const settings = projectSettingsFor(db, input.groupId);
  if (!settings) return { ok: false, error: "not_found", reason: "Not a project." };
  if (settings.endedAt !== null) return { ok: false, error: "not_allowed", reason: "This is a channel now." };
  if (settings.closedAt !== null) return { ok: false, error: "not_allowed", reason: "This project is closed." };
  if (projectIsClosing(db,input.groupId)) return { ok: false, error: "not_allowed", reason: "This project is closing." };
  if (input.expectedRevision !== settings.revision) {
    return { ok: false, error: "changed", reason: "The project settings changed since you read them.", settings };
  }
  const fields: Record<string, unknown> = {};
  const detail: Record<string, unknown> = {};
  if (input.mode !== undefined && input.mode !== settings.mode) {
    if (input.mode !== "conversation" && input.mode !== "ongoing") return invalid("The mode is conversation or ongoing.");
    fields.mode = input.mode;
    detail.mode = input.mode;
  }
  if (input.leadBotId !== undefined && input.leadBotId !== settings.leadBotId) {
    if (input.leadBotId !== null && !input.memberIds.includes(input.leadBotId)) return invalid("The lead is a member of this project.");
    fields.lead_bot_id = input.leadBotId;
    detail.lead = input.leadBotId ?? "off";
  }
  if (input.parts !== undefined) {
    const parts = input.parts as Record<string, unknown>;
    const unknown = Object.keys(parts).filter(key => !["board", "review", "digest"].includes(key));
    if (unknown.length > 0) return invalid(`Unknown part: ${unknown[0]}.`);
    if (Object.values(parts).some(value => typeof value !== "boolean")) return invalid("A part is on or off.");
    const merged = { ...settings.parts, ...parts };
    fields.parts = JSON.stringify(merged);
    detail.parts = Object.keys(parts);
  }
  if (input.parallelCards !== undefined && input.parallelCards !== settings.parallelCards) {
    if (!Number.isInteger(input.parallelCards) || input.parallelCards < 1 || input.parallelCards > 5) return invalid("Parallel cards is 1 to 5.");
    fields.parallel_cards = input.parallelCards;
    detail.parallelCards = input.parallelCards;
  }
  if (Object.keys(fields).length === 0) return { ok: true, settings };
  writeSettings(db, input.groupId, fields, input.now);
  if (fields.mode === "ongoing") {
    createDefaultPeriodBudget(db, { groupId: input.groupId, period: "week", tz: input.tz ?? "UTC", now: input.now });
  }
  // Lead off or board off pauses the active goal (5.7).
  const goal = activeProjectGoal(db, input.groupId);
  if (goal && (Object.hasOwn(fields, "lead_bot_id") && fields.lead_bot_id === null)) {
    pauseProjectGoal(db, { goalId: goal.id, reason: "Pick a lead to resume", actor: { kind: "server" }, now: input.now });
  } else if (goal && fields.parts !== undefined && (JSON.parse(String(fields.parts)) as ProjectParts).board === false) {
    pauseProjectGoal(db, { goalId: goal.id, reason: "Turn the board on to resume", actor: { kind: "server" }, now: input.now });
  }
  insertProjectActivity(db, { groupId: input.groupId, kind: "settings", actor: "owner", at: input.now, detail });
  return { ok: true, settings: projectSettingsFor(db, input.groupId)! };
}

/** The "since you left" cursor (POST project/viewed, 11.1). */
export function markProjectViewed(db: DatabaseSync, input: { groupId: string; now: number }): void {
  db.prepare("UPDATE project_settings SET owner_viewed_at=? WHERE group_id=?").run(input.now, input.groupId);
}

// ── lifecycle (5.7) ─────────────────────────────────────────────────────────

/** Channel to project. Rows only: insert or reopen the settings row (clears
 * ended_at) and write the next brief version from the bulletin. The caller
 * then writes `channelProject` into groups.json and clears desk archive
 * stamps. */
export function channelToProjectRows(
  db: DatabaseSync,
  input: { groupId: string; bulletin: string; leadBotId: string | null; now: number },
): { ok: true; settings: ProjectSettings } {
  if (projectIsClosing(db,input.groupId)) throw new Error("This project is closing.");
  const existing = projectSettingsFor(db, input.groupId);
  if (existing) {
    writeSettings(db, input.groupId, {
      ended_at: null, closed_at: null, run_state: "running", run_state_reason: null,
      lead_bot_id: input.leadBotId,
    }, input.now);
  } else {
    db.prepare(`INSERT INTO project_settings
      (group_id, mode, lead_bot_id, parts, parallel_cards, work_roots, work_profile, migrated_from, owner_viewed_at, run_state, run_state_reason, closed_at, ended_at, revision, updated_at)
      VALUES (?,?,?,?,?,?,?,NULL,NULL,'running',NULL,NULL,NULL,0,?)`).run(
      input.groupId, "conversation", input.leadBotId, JSON.stringify(DEFAULT_PROJECT_PARTS), DEFAULT_PROJECT_PARALLEL_CARDS, "[]", "ask", input.now,
    );
  }
  // Re-making a project continues the brief versions from the bulletin.
  const version = insertProjectBriefVersion(db, {
    groupId: input.groupId, summary: "", doneMeans: "", rules: input.bulletin.slice(0, 12000),
    whereWorkIs: [], decisions: [], updatedBy: "owner", change: "owner_edit", now: input.now,
  });
  insertProjectActivity(db, { groupId: input.groupId, kind: "settings", actor: "owner", at: input.now, detail: { project: true, briefVersion: version.version } });
  return { ok: true, settings: projectSettingsFor(db, input.groupId)! };
}

/** End project (project to channel). Rows only: the active goal is stopped,
 * open requests cancelled, open cards cancelled and archived, authority
 * fields cleared, ended_at set, the row kept so history stays readable. The
 * caller then copies the returned bulletin into groups.json, clears
 * channelProject and archives the desk tasks. */
export function endProjectRows(
  db: DatabaseSync,
  input: { groupId: string; now: number },
): { ok: true; bulletin: string } | SettingsFailure {
  const settings = projectSettingsFor(db, input.groupId);
  if (!settings) return { ok: false, error: "not_found", reason: "Not a project." };
  if (settings.endedAt !== null) return { ok: false, error: "not_allowed", reason: "This project already ended." };
  if (settings.closedAt !== null) return { ok: false, error: "not_allowed", reason: "This project is closed." };
  if (projectIsClosing(db,input.groupId)) return { ok: false, error: "not_allowed", reason: "This project is closing." };
  const goal = activeProjectGoal(db, input.groupId);
  if (goal) stopProjectGoal(db, { goalId: goal.id, actor: { kind: "server" }, reason: "End project", now: input.now });
  db.prepare("UPDATE room_requests SET state='cancelled', finished_at=?, waiting_since=NULL, outcome_note='project ended' WHERE group_id=? AND state IN ('queued','running','waiting_owner','waiting_bot')").run(input.now, input.groupId);
  const cards = db.prepare("SELECT id FROM project_work_items WHERE group_id=? AND state IN ('todo','doing','waiting','review','failed')").all(input.groupId) as Array<{ id: string }>;
  for (const card of cards) cancelProjectCard(db, { cardId: card.id, actor: { kind: "server" }, now: input.now });
  writeSettings(db, input.groupId, {
    work_roots: "[]", work_profile: "ask", run_state: "running", run_state_reason: null, ended_at: input.now,
  }, input.now);
  insertProjectActivity(db, { groupId: input.groupId, kind: "settings", actor: "owner", at: input.now, detail: { project: false } });
  return { ok: true, bulletin: currentProjectBrief(db, input.groupId)?.rules ?? "" };
}

/** Lane N's row writers for Close and Reopen (5.7). Close is the sequence
 * lane N drives; these are the durable stamps it lands. */
export function setProjectClosed(db: DatabaseSync, input: { groupId: string; at: number }): void {
  writeSettings(db, input.groupId, { closed_at: input.at, run_state: "paused", run_state_reason: "This project is closed" }, input.at);
  insertProjectActivity(db, { groupId: input.groupId, kind: "close", actor: "owner", at: input.at, detail: {} });
}

export function setProjectReopened(db: DatabaseSync, input: { groupId: string; at: number }): void {
  // The owner resumes after a reopen (5.7): run_state stays paused until then.
  writeSettings(db, input.groupId, { closed_at: null, run_state: "paused", run_state_reason: "Reopened. Resume when ready." }, input.at);
  insertProjectActivity(db, { groupId: input.groupId, kind: "reopen", actor: "owner", at: input.at, detail: {} });
}

/** Pause and resume the whole project (control routes are lane E1's; the row
 * writes are R's). */
export function setProjectRunState(db: DatabaseSync, input: { groupId: string; runState: "running" | "paused"; reason?: string | null; actor: ProjectActor | "owner"; now: number }): SettingsOutcome {
  const settings = projectSettingsFor(db, input.groupId);
  if (!settings) return { ok: false, error: "not_found", reason: "Not a project." };
  if (settings.endedAt !== null) return { ok: false, error: "not_allowed", reason: "This is a channel now." };
  if (settings.closedAt !== null && input.runState === "running") return { ok: false, error: "not_allowed", reason: "This project is closed. Reopen it first." };
  if (input.runState === "running" && projectIsClosing(db,input.groupId)) return { ok: false, error: "not_allowed", reason: "This project is closing." };
  writeSettings(db, input.groupId, { run_state: input.runState, run_state_reason: input.reason ?? null }, input.now);
  insertProjectActivity(db, { groupId: input.groupId, kind: "settings", actor: "owner", at: input.now, detail: { runState: input.runState } });
  return { ok: true, settings: projectSettingsFor(db, input.groupId)! };
}

export type { ProjectFeatureFlags };
