// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import type { DatabaseSync } from "node:sqlite";
import { mirrorMurageLine, type CommsBus } from "./comms-visibility.ts";
import { projectBudgetsForGroup } from "./project-defaults.ts";
import { budgetPeriodStart } from "./project-budget-period.ts";
import { deriveGroupedDecisions, type GroupedDecisions } from "./project-goals.ts";
import { projectCardsForGroup, projectGoalById } from "./project-records.ts";
import { projectUsage } from "./usage-ledger.ts";

interface DigestDeps {
  db: DatabaseSync;
  bus: CommsBus;
  features?: { projectsDigest?: boolean };
  openApprovals?: (groupId: string) => GroupedDecisions["approvals"];
  timeZone?: string;
}
const goalStates: Record<string, string> = { draft: "Not started", planning: "Planning", awaiting_plan_ok: "The plan needs your OK", working: "Working", awaiting_signoff: "Ready for your sign-off", paused: "Paused", done: "Done", stopped: "Stopped", failed: "Could not continue" };
function workTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
}
/** Synchronous, so the persisted message is the dedupe receipt before another
 * tick can run. The caller holds restore admission for boot and interval runs. */
export function runProjectDigests(deps: DigestDeps, now: number): number {
  if (deps.features?.projectsDigest === false) return 0;
  const { db, bus } = deps;
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_settings'").get() || !db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages'").get()) return 0;
  let posted = 0;
  for (const settings of db.prepare("SELECT group_id FROM project_settings WHERE closed_at IS NULL AND ended_at IS NULL AND json_extract(parts,'$.digest')=1").all()) {
    const groupId = String(settings.group_id);
    try {
      const group = bus.store.group(groupId);
      if (!group || group.dm) continue;
      const tz = projectBudgetsForGroup(db, groupId).find(b => b.period !== "goal")?.tz ?? deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map(p => [p.type, p.value]));
      if (Number(parts.hour) < 8) continue;
      const digestDay = `${parts.year}-${parts.month}-${parts.day}`;
      const predicate = "thread_id=? AND json_extract(json,'$.actorKind')='murage' AND json_extract(json,'$.murage.kind')='status' AND json_type(json,'$.murage.digestDay')='text'";
      if (db.prepare(`SELECT 1 FROM messages WHERE ${predicate} AND json_extract(json,'$.murage.digestDay')=? LIMIT 1`).get(group.threadId, digestDay)) continue;
      const previous = db.prepare(`SELECT at FROM messages WHERE ${predicate} AND at<=? ORDER BY at DESC LIMIT 1`).get(group.threadId, now);
      const since = previous ? Number(previous.at) : now - 86400000;
      const cards = projectCardsForGroup(db, groupId, true);
      const goalRow = db.prepare("SELECT id FROM project_goals WHERE group_id=? ORDER BY CASE WHEN state IN ('done','stopped','failed') THEN 1 ELSE 0 END,created_at DESC LIMIT 1").get(groupId);
      const goal = goalRow ? projectGoalById(db, String(goalRow.id)) : null;
      if (!cards.length && !goal) continue;
      const activity = db.prepare("SELECT kind,work_item_id,detail FROM project_activity WHERE group_id=? AND at>? AND at<=? ORDER BY at").all(groupId, since, now);
      const dayStart = budgetPeriodStart("day", tz, now);
      const changedUsage = db.prepare("SELECT 1 FROM usage_ledger WHERE group_id=? AND at>? AND at<=? LIMIT 1").get(groupId, since, now);
      const label = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(now);
      let text = `Daily digest for ${label}: nothing changed since the last digest.`;
      if (activity.length || changedUsage || cards.some(card => card.updatedAt > since && card.updatedAt <= now) || (goal && goal.createdAt > since && goal.createdAt <= now)) {
        const done = new Set(activity.filter(row => (row.kind === "card_moved" || row.kind === "card_result") && JSON.parse(String(row.detail)).to === "done").map(row => String(row.work_item_id))).size;
        const doing = cards.filter(card => card.state === "doing").length;
        const waiting = cards.filter(card => card.state === "waiting" || card.state === "failed").length;
        const needs = deriveGroupedDecisions(db, { groupId, openApprovals: deps.openApprovals?.(groupId) ?? [], now }).count;
        text = `Daily digest for ${label}: ${done} ${done === 1 ? "card" : "cards"} done, ${doing} in progress, ${waiting} waiting, ${needs} ${needs === 1 ? "needs" : "need"} you.`;
        if (goal) text += ` Goal '${goal.title}': ${goalStates[goal.state]}.`;
        text += ` Work used today: ${workTime(projectUsage(db, { groupId, since: dayStart }).totals.workMs)}.`;
      }
      mirrorMurageLine(bus, group, text, { kind: "status", digestDay });
      posted++;
    } catch (error) {
      console.error("[project-digest] Project digest failed", groupId, error instanceof Error ? error.name : "Error");
    }
  }
  return posted;
}
