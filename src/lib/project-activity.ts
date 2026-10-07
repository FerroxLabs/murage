// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import type { GoalState, ProjectActivityRow, ProjectCard, ProjectGoal, ProjectRead } from "./project-client";
import { stateName, stateNames } from "./project-board";
import { goalStateLabel, goalStateNames } from "./project-goal-view";
import { t } from "./i18n";
const knownState = (value: unknown): value is ProjectCard["state"] => typeof value === "string" && Object.hasOwn(stateNames, value);
const knownGoalState = (value: unknown): value is GoalState => typeof value === "string" && Object.hasOwn(goalStateNames, value);
const otherKinds = ["criteria", "decision_opened", "decision_closed", "budget_warned", "budget_paused", "budget_raised", "member_error", "routine_run", "settings", "work_roots", "restore", "close", "reopen", "deadline"] as const;
export function activityLine(row: ProjectActivityRow, cards: ProjectCard[], goal: ProjectGoal | null): string {
  const card = cards.find(c => c.id === row.workItemId), name = card?.number != null ? t("projects.common.cardLabel", { number: card.number }) : t("projects.act.aCard");
  const from = knownState(row.detail.from) ? stateName(row.detail.from) : null, to = knownState(row.detail.to) ? stateName(row.detail.to) : null;
  switch (row.kind) {
    case "card_created": return card ? t("projects.act.cardAddedTitled", { name, title: card.title }) : t("projects.act.cardAdded", { name });
    case "card_moved": return from && to ? t("projects.act.moved", { name, from, to }) : t(row.detail.reorder === true ? "projects.act.reordered" : "projects.act.movedPlain", { name });
    case "card_reassigned": return t("projects.act.reassigned", { name });
    case "card_took_over": return t("projects.act.tookOver", { name });
    case "card_failed": return t("projects.act.failed", { name });
    case "card_result": return t("projects.act.result", { name });
    case "brief_version": return typeof row.detail.version === "number" ? t("projects.act.briefVersion", { version: row.detail.version }) : t("projects.act.brief");
    case "goal_state": { const state = typeof row.detail.to === "string" ? knownGoalState(row.detail.to) ? row.detail.to : undefined : goal?.id === row.goalId ? goal.state : undefined; return state ? t("projects.act.goalNow", { state: goalStateLabel(state) }) : t("projects.act.goalChanged"); }
    default: return (otherKinds as readonly string[]).includes(row.kind) ? t(`projects.act.${row.kind as (typeof otherKinds)[number]}`) : t("projects.act.updated");
  }
}
export function activityActor(actor: string, members: Array<{id: string; name: string}>): string { return actor === "owner" ? t("projects.face.you") : actor === "server" ? "Murage" : members.find(m => m.id === actor)?.name ?? t("projects.act.aTeammate"); }
export function activityTime(at: number, now = Date.now()): string { const minutes = Math.floor(Math.max(0, now - at) / 60000); return minutes < 1 ? t("projects.time.justNow") : minutes < 60 ? t("projects.time.minAgo", { n: minutes }) : minutes < 1440 ? t("projects.time.hourAgo", { n: Math.floor(minutes / 60) }) : t("projects.time.dayAgo", { n: Math.floor(minutes / 1440) }); }
export function mergeActivity(held: ProjectActivityRow[], page: ProjectActivityRow[]): ProjectActivityRow[] { return [...held, ...page.filter(row => !held.some(old => old.id === row.id))]; }
export type ActivityPage = { before: number; limit: number; blocked: false } | { blocked: true };
/** The English line. The screen reads projects.act.pageLimit. */
export const ACTIVITY_PAGE_LIMIT = "More activity shares this timestamp than can be loaded. Older activity could not be shown.";
export function nextActivityPage(page: ProjectActivityRow[], limit: number): ActivityPage | null {
  if (page.length < limit) return null;
  const last = page.at(-1)!;
  const tied = page[0].at === last.at;
  // Keep the boundary millisecond. Expand tied pages up to the route limit;
  // never advance past rows we could not read with a timestamp-only cursor.
  if (tied && limit >= 100) return { blocked: true };
  return { before: last.at + 1, limit: tied ? Math.min(100, limit * 2) : limit, blocked: false };
}
export function sinceYouLeftLine(counts: ProjectRead["sinceYouLeft"]): string {
  const count = (n: number, one: "projects.since.messageOne" | "projects.since.cardOne" | "projects.since.decisionOne", other: "projects.since.messageOther" | "projects.since.cardOther" | "projects.since.decisionOther") => n ? t(n === 1 ? one : other, { count: n }) : "";
  const parts = [count(counts.messages, "projects.since.messageOne", "projects.since.messageOther"), count(counts.cards, "projects.since.cardOne", "projects.since.cardOther"), count(counts.decisions, "projects.since.decisionOne", "projects.since.decisionOther")].filter(Boolean);
  return parts.length ? t("projects.since.line", { parts: parts.join(t("projects.since.sep")) }) : "";
}
