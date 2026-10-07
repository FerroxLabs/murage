// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "./i18n";
import type { GoalState, ProjectGoal, ProjectGoalAction, ProjectGoalCreate, ProjectGoalPatch, ProjectGoalEvidence, ProjectCard, ProjectBudget, UsageRead, RoomRequest } from "./project-client";
export const goalStateNames: Record<GoalState, string> = { draft: "Not started", planning: "Planning", awaiting_plan_ok: "The plan needs your OK", working: "Working", awaiting_signoff: "Ready for your sign-off", paused: "Paused", done: "Done", stopped: "Stopped", failed: "Could not continue" };
/** The English names. Ids and membership checks use these; what a person reads goes through goalStateLabel. */
export function goalStateLabel(state: GoalState): string { return Object.hasOwn(goalStateNames, state) ? t(`projects.goalState.${state}`) : t("projects.goalState.updated"); }
/** The English labels. The screen reads goalActionLabel. */
export const goalActionLabels: Record<ProjectGoalAction, string> = { start: "Start", approve_plan: "Approve plan", change_plan: "Change plan", sign_off: "Sign off", send_back: "Send back", pause: "Pause", resume: "Resume", stop: "Stop goal" };
export const goalActionLabel = (action: ProjectGoalAction): string => t(`projects.goalAction.${action}`);
export function goalActions(state: GoalState): ProjectGoalAction[] {
  switch (state) {
    case "draft": return ["start"];
    case "awaiting_plan_ok": return ["approve_plan", "change_plan"];
    case "awaiting_signoff": return ["sign_off", "send_back"];
    case "planning": case "working": return ["pause", "stop"];
    case "paused": return ["resume", "stop"];
    default: return [];
  }
}
export function canEditGoal(state: GoalState): boolean { return ["draft", "planning", "awaiting_plan_ok", "working", "paused"].includes(state); }
export function goalActionBody(goal: ProjectGoal, action: ProjectGoalAction, note = ""): ProjectGoalPatch | { error: string } {
  if (!goalActions(goal.state).includes(action)) return { error: t("projects.goalAction.unavailable") };
  const needsNote = action === "send_back" || action === "change_plan";
  if (needsNote && !note.trim()) return { error: t("projects.goalAction.noteFirst") };
  if (note.length > 500) return { error: t("projects.goalAction.noteLong") };
  return { expectedRevision: goal.revision, action, ...(needsNote ? { note: note.trim() } : {}) };
}
export interface GoalForm { title: string; description: string; criteria: Array<{ id?: string; text: string }>; planFirst: boolean; review: boolean; deadline: string }
export function goalFormBody(form: GoalForm): ProjectGoalCreate | { error: string };
export function goalFormBody(form: GoalForm, goal: ProjectGoal): ProjectGoalPatch | { error: string };
export function goalFormBody(form: GoalForm, goal?: ProjectGoal): ProjectGoalCreate | ProjectGoalPatch | { error: string } {
  if (!form.title.trim() || form.title.trim().length > 200) return { error: t("projects.goalForm.errTitle") };
  if (form.description.length > 2000) return { error: t("projects.goalForm.errDescription") };
  if (form.criteria.length > 10 || form.criteria.some(c => !c.text.trim() || c.text.trim().length > 300)) return { error: t("projects.goalForm.errCriteria") };
  const base = { title: form.title.trim(), description: form.description };
  if (goal) {
    const criteria = form.criteria.map(c => ({ ...(c.id ? { id: c.id } : {}), text: c.text.trim() }));
    const changed = criteria.length !== (goal.criteria?.length ?? 0) || criteria.some((c, i) => c.id !== goal.criteria?.[i]?.id || c.text !== goal.criteria?.[i]?.text);
    return { expectedRevision: goal.revision, ...(base.title !== goal.title ? { title: base.title } : {}), ...(base.description !== (goal.description ?? "") ? { description: base.description } : {}), ...(changed ? { criteria } : {}) };
  }
  const deadlineAt = form.deadline ? new Date(`${form.deadline}T23:59:59.999`).getTime() : null;
  if (deadlineAt !== null && !Number.isFinite(deadlineAt)) return { error: t("projects.goalForm.errDeadline") };
  return { ...base, criteria: form.criteria.map(c => c.text.trim()), planFirst: form.planFirst, review: form.review, deadlineAt };
}
export function criterionTarget(evidence: ProjectGoalEvidence, cards: ProjectCard[], roomThreadId?: string): { artifactId: string; botId?: string } | { threadId: string; messageId: string } | null {
  const card = cards.find(c => c.id === evidence.workItemId);
  if (evidence.kind === "file") return { artifactId: evidence.ref, botId: card?.assigneeBotId ?? undefined };
  const threadId = card?.deskThreadId ?? roomThreadId;
  return threadId ? { threadId, messageId: evidence.ref } : null;
}
/** Verify the exact message in work, room and producing request threads, including review desks. */
export async function resolveCriterionTarget(evidence: ProjectGoalEvidence, cards: ProjectCard[], roomThreadId: string, read: (path: string) => Promise<{ messages?: Array<{ id: string }> }>, readRequests?: () => Promise<RoomRequest[]>) {
  const target = criterionTarget(evidence, cards, roomThreadId);
  if (!target || "artifactId" in target) return target;
  const threads = new Set([target.threadId, roomThreadId]);
  if (readRequests) {
    // Request history adds candidate threads; desk and room lookup still works without it.
    for (const request of await readRequests().catch(() => [])) {
      const thread = request.targetThreadId ?? request.threadId;
      if (request.workItemId === evidence.workItemId && thread) threads.add(thread);
    }
  }
  for (const threadId of threads) {
    try {
      const page = await read(`/api/threads/${encodeURIComponent(threadId)}/messages?around=${encodeURIComponent(evidence.ref)}&limit=1`);
      if (page.messages?.some(message => message.id === evidence.ref)) return { threadId, messageId: evidence.ref };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  return null;
}
const work = (ms: number) => { const minutes = Math.floor(ms / 60000); return minutes >= 60 ? minutes % 60 ? t("projects.time.hoursMin", { h: Math.floor(minutes / 60), m: minutes % 60 }) : t("projects.time.hours", { n: Math.floor(minutes / 60) }) : t("projects.time.min", { n: minutes }); };
const tokens = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
export function goalBudgetLines(budget: ProjectBudget | undefined, usage: UsageRead, members: Array<{id: string; name: string}>): string[] {
  const lines = [budget?.maxWorkMinutes != null ? t("projects.budget.workOf", { used: work(usage.totals.workMs), max: work(budget.maxWorkMinutes * 60000) }) : t("projects.budget.workUsed", { used: work(usage.totals.workMs) })];
  if (usage.totals.tokensReported) lines.push(budget?.maxTokens != null ? t("projects.budget.tokensOf", { used: tokens(usage.totals.input + usage.totals.output), max: tokens(budget.maxTokens) }) : t("projects.budget.tokens", { used: tokens(usage.totals.input + usage.totals.output) }));
  for (const id of usage.notReported) lines.push(t("projects.budget.notReported", { name: members.find(m => m.id === id)?.name ?? t("projects.budget.aTeammate") }));
  if (budget?.state === "ok") lines.push(t("projects.budget.within"));
  if (budget?.state === "warned") lines.push(t("projects.budget.warned"));
  if (budget?.state === "paused") lines.push(t("projects.budget.paused"));
  if (usage.totals.charge !== null) lines.push(t("projects.budget.charge", { amount: usage.totals.charge.toFixed(4) }));
  return lines;
}
