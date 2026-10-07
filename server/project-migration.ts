// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Migration and the boot reconciler for project records (SPEC-P section 4 and
// the cross-store rule of section 2).
//
// messages.db rows and the groups.json record can never share a transaction,
// so every operation that touches both writes the rows first and the JSON
// second, and `reconcileProjectRecords()` runs at boot before the scheduler,
// the routine manager and any dispatch to repair a crash between the two.
import { projectCreationRecord } from "./project-new.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { DatabaseSync } from "node:sqlite";

import { database, transaction } from "./database.ts";
import { DEFAULT_GOAL_REVIEW, DEFAULT_PROJECT_PARALLEL_CARDS, DEFAULT_PROJECT_PARTS } from "./project-defaults.ts";
import { deleteProjectRows, validateProjectRows } from "./project-tables.ts";
import { currentProjectBrief, insertProjectBriefVersion, projectSettingsFor, projectSettingsFromRow, activeProjectGoal } from "./project-records.ts";
import type { GroupRecord, Store } from "./store.ts";

const MIGRATED_GOAL_REASON = "From before the update: Start it to run it as a goal";

/** The goal text a reconciled channelProject block carries when the JSON side
 * was lost: the active goal's title, else the brief's summary, else a plain
 * placeholder (the block's schema needs at least one character). */
function reconciledGoalText(db: DatabaseSync, groupId: string): string {
  const goal = activeProjectGoal(db, groupId);
  if (goal) return goal.title.slice(0, 2000);
  const brief = currentProjectBrief(db, groupId);
  const summary = brief?.summary.trim();
  if (summary) return summary.slice(0, 2000);
  return "Project";
}

/** The row writes of "this group is a project": settings, brief version and,
 * for the upgrade migration, the goal row from the old channelProject block.
 * Runs inside the caller's transaction; the groups.json write is the caller's
 * second step. Idempotent: an existing settings row is the marker. */
export function migrateChannelProjectGroup(
  db: DatabaseSync,
  group: GroupRecord,
  now: number,
  options: { migration: boolean } = { migration: true },
): boolean {
  if (projectSettingsFor(db, group.id)) return false;
  const lead = group.defaultResponder.kind === "member" && group.memberIds.includes(group.defaultResponder.botId)
    ? group.defaultResponder.botId
    : null;
  const project = group.channelProject;
  const done = options.migration && project?.status === "done";
  db.prepare(`INSERT INTO project_settings
    (group_id, mode, lead_bot_id, parts, parallel_cards, work_roots, work_profile, migrated_from, owner_viewed_at, run_state, run_state_reason, closed_at, ended_at, revision, updated_at)
    VALUES (?,?,?,?,?,?,?,?,NULL,'running',NULL,?,NULL,0,?)`).run(
    group.id, "conversation", lead, JSON.stringify(DEFAULT_PROJECT_PARTS), DEFAULT_PROJECT_PARALLEL_CARDS, "[]", "ask",
    options.migration ? (group.bulletin.trim() ? "both" : "channelProject") : null,
    done ? (project!.completedAt ?? now) : null, now,
  );
  const bulletin = group.bulletin.slice(0, 12000);
  insertProjectBriefVersion(db, {
    groupId: group.id,
    summary: (project?.goal.split("\n")[0]?.trim() || "Project").slice(0, 200),
    doneMeans: "",
    rules: bulletin,
    whereWorkIs: [],
    decisions: [],
    updatedBy: options.migration ? "migration" : "owner",
    change: options.migration ? "migration" : "owner_edit",
    now,
  });
  if (options.migration && project) {
    // The whole old goal text is kept (Astra 21); active and paused become
    // draft, because a migrated paused goal would otherwise block every new
    // goal under the one-active-goal rule (SPEC-P 4, deviation from plan 3.4).
    const state = project.status === "done" ? "done" : "draft";
    db.prepare(`INSERT INTO project_goals
      (id, group_id, title, description, criteria, state, state_reason, plan_first, review, replans, no_progress, lead_wakes, revision, created_at, started_at, finished_at, summary_message_id, deadline_at)
      VALUES (?,?,?,?,'[]',?,?,0,?,0,0,0,0,?,NULL,?,NULL,NULL)`).run(
      randomUUID(), group.id,
      (project.goal.split("\n")[0]?.trim() || project.goal.trim() || "Migrated goal").slice(0, 200),
      project.goal.slice(0, 2000),
      state, state === "draft" ? MIGRATED_GOAL_REASON : null,
      DEFAULT_GOAL_REVIEW ? 1 : 0, now, state === "done" ? (project.completedAt ?? now) : null,
    );
  }
  return true;
}

/** Runs once at boot after the store loads, before the scheduler, the
 * routine manager and any dispatch. For each group with `channelProject` and
 * no settings row, the full migration row set is written. Idempotent. */
export function migrateChannelProjects(store: Store): number {
  let migrated = 0;
  for (const group of store.groups) {
    if (!group.channelProject) continue;
    const created = transaction((db) => migrateChannelProjectGroup(db, group, Date.now()));
    if (created) migrated += 1;
  }
  return migrated;
}

/** Request-scoped second write; full reconciliation remains a boot operation. */
export function materializeProjectCreation(store: Store, groupId: string): void {
  const db = database();
  if (db.prepare("SELECT 1 FROM project_activity WHERE group_id=? AND json_extract(detail,'$.creation')='materialized'").get(groupId)) return;
  const creation = projectCreationRecord(db,groupId);
  if (!creation) return;
  const group = store.materializeProjectGroup(creation);
  db.prepare("INSERT INTO project_activity (id,group_id,at,kind,actor,detail) VALUES (?,?,?,'settings','server',?)")
    .run(randomUUID(),group.id,Date.now(),JSON.stringify({creation:'materialized'}));
}

/** A consistent copy of messages.db beside it, taken before a boot-time bulk
 * delete. Returns false when the copy could not be made. */
function snapshotProjectRows(db: DatabaseSync, now: number): boolean {
  const target = join(DATA_DIR, `project-rows-before-prune-${now}.db`);
  try {
    if (existsSync(target)) return true;
    db.prepare("VACUUM INTO ?").run(target);
    try { chmodSync(target, 0o600); } catch { /* platforms without POSIX modes */ }
    return true;
  } catch {
    return false;
  }
}

/** Boot repair for half-done cross-store operations (SPEC-P section 2):
 *  - a settings row with `ended_at IS NULL` whose group lacks channelProject
 *    gets the block back; if the group is gone, the rows are deleted;
 *  - a group with channelProject and no settings row gets default rows;
 *  - a desk task whose project rows are gone is archived (never removed). */
export function reconcileProjectRecords(store: Store): void {
  const db = database();
  const now = Date.now();
  const rows = db.prepare("SELECT * FROM project_settings").all() as Array<Record<string, unknown>>;
  // A roster of zero groups next to project rows means groups.json is missing or
  // was lost (partial copy, sync tool, interrupted restore): the roster is
  // UNKNOWN, not empty, so no row may be deleted on its say-so (audit C-1).
  const rosterUnknown = store.groups.length === 0 && rows.length > 0;
  let snapshotted = false;
  for (const row of rows) {
    const settings = projectSettingsFromRow(row);
    materializeProjectCreation(store,settings.groupId);
    const group = store.group(settings.groupId);
    if (!group) {
      if (rosterUnknown) {
        console.warn("[project-migration] groups.json lists no groups; project rows kept");
        continue;
      }
      // Crash repair for a deleted group. Hard deletes are permanent, so the
      // database is copied first; if the copy cannot be made, nothing is deleted.
      if (!snapshotted) {
        if (!snapshotProjectRows(db, now)) {
          console.warn("[project-migration] snapshot failed; project rows of removed groups kept");
          continue;
        }
        snapshotted = true;
      }
      transaction((tx) => deleteProjectRows(tx, settings.groupId, now));
      continue;
    }
    if (settings.endedAt !== null) {
      if (group.channelProject) store.patchGroup(group.id, { channelProject: undefined, bulletin: currentProjectBrief(db, group.id)?.rules ?? group.bulletin });
      store.setChannelProjectDeskArchived(group.id, settings.endedAt);
      continue;
    }
    const status = settings.closedAt !== null ? "done" : "active";
    if (group.channelProject && group.channelProject.status !== status) {
      store.patchGroup(group.id, { channelProject: { ...group.channelProject, status, updatedAt: settings.updatedAt, completedAt: settings.closedAt ?? undefined } });
    }
    store.setChannelProjectDeskArchived(group.id, settings.closedAt ?? undefined);
    if (!group.channelProject && !group.dm) {
      // Rows are the source of truth and already exist; the JSON block is the
      // second write and idempotent.
      store.patchGroup(group.id, {
        channelProject: {
          goal: reconciledGoalText(db, group.id),
          status: settings.closedAt !== null ? "done" : "active",
          startedAt: settings.updatedAt,
          updatedAt: settings.updatedAt,
          ...(settings.closedAt !== null ? { completedAt: settings.closedAt } : {}),
        },
      });
    }
  }
  for (const group of store.groups) {
    if (!group.channelProject) continue;
    transaction((tx) => migrateChannelProjectGroup(tx, group, now));
  }
  transaction(tx => validateProjectRows(tx, { groups: store.groups, botIds: new Set(store.bots.map(bot => bot.id)), now, requirePaused: false }));
  const archivedGroups = new Set<string>();
  for (const bot of store.bots) {
    for (const task of bot.tasks ?? []) {
      const desk = task.channelProjectDesk;
      if (!desk || desk.archivedAt !== undefined || archivedGroups.has(desk.groupId)) continue;
      if (projectSettingsFor(db, desk.groupId)) continue;
      store.setChannelProjectDeskArchived(desk.groupId, now);
      archivedGroups.add(desk.groupId);
    }
  }
}
