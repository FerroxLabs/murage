// SPDX-License-Identifier: AGPL-3.0-or-later
import { cardRequestIsReview } from "./project-card-executor.ts";
import { roomRequest } from "./room-requests.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { audienceFingerprint, turnAudienceIsOwner } from "./owner-audience.ts";
import { z } from "zod";
import * as cards from "./project-cards.ts";
import * as goals from "./project-goals.ts";
import * as records from "./project-records.ts";
import { patchProjectBrief } from "./project-briefs.ts";
import { endProjectRows, markProjectViewed, patchProjectSettings } from "./project-settings.ts";
import { projectBudgetsForGroup, projectsGoalsEnabled, projectsLeadEnabled, type ProjectFeatureFlags } from "./project-defaults.ts";

import { DATA_DIR } from "./config.ts";
import { canonicalProjectRoots } from "./project-work-profile.ts";
import { createProjectBudgetGate, patchProjectBudget, type ProjectBudgetGate } from "./project-budgets.ts";
import { createDefaultPeriodBudget, DEFAULT_GOAL_TOKENS, DEFAULT_GOAL_WORK_MINUTES } from "./project-defaults.ts";
import { projectUsage } from "./usage-ledger.ts";
const zone = z.string().refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } });
const budgetFields = { maxWorkMinutes: z.number().int().min(1).max(100000).optional(), maxTokens: z.number().int().positive().optional(), warnAt: z.number().gt(0).lt(1).optional(), tz: zone.optional() };
const budgetPatch = z.object({ budgetId: z.string(), expectedRevision: z.number().int().nonnegative(), ...budgetFields }).strict();
const budgetCreate = z.object({ ...budgetFields, period: z.enum(["day","week","month"]), tz: zone, maxWorkMinutes: z.number().int().min(1).max(100000) }).strict();
const rootsSchema = z.object({ expectedRevision: z.number().int().nonnegative(), roots: z.array(z.object({ path: z.string().min(1), label: z.string().max(60).optional() }).strict()).max(8) }).strict();
const profileSchema = z.object({ expectedRevision: z.number().int().nonnegative(), workProfile: z.enum(["ask","auto-in-roots"]) }).strict();
const id = z.string().regex(/^[\w-]+$/);
const revision = z.number().int().nonnegative();
const states = z.enum(["todo", "doing", "waiting", "review", "done", "failed", "cancelled"]);
const briefSchema = z.object({ expectedVersion: revision, summary: z.string().max(200).optional(), doneMeans: z.string().max(4000).optional(), rules: z.string().max(12000).optional(), whereWorkIs: z.array(z.object({ text: z.string().min(1).max(500), path: z.string().max(512).optional(), by: z.string(), at: z.number(), sourceMessageIds: z.array(id).max(20).optional(), lineageSourceMessageIds: z.array(id).max(50).optional() }).strict()).max(20).optional(), restoreVersion: z.number().int().positive().optional() }).strict();
const goalCreateSchema = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(), criteria: z.array(z.string().trim().min(1).max(300)).max(10).optional(), planFirst: z.boolean().optional(), review: z.boolean().optional(), deadlineAt: z.number().int().nullable().optional() }).strict();
const goalPatchSchema = z.object({ expectedRevision: revision, action: z.enum(["start", "approve_plan", "change_plan", "sign_off", "send_back", "pause", "resume", "stop"]).optional(), note: z.string().max(500).optional(), title: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(), criteria: z.array(z.object({ id: id.optional(), text: z.string().trim().min(1).max(300) }).strict()).max(10).optional() }).strict();
const settingsSchema = z.object({ expectedRevision: revision, mode: z.enum(["conversation", "ongoing"]).optional(), leadBotId: id.nullable().optional(), parts: z.object({ board: z.boolean().optional(), review: z.boolean().optional(), digest: z.boolean().optional() }).strict().optional(), parallelCards: z.number().int().min(1).max(5).optional() }).strict();
const cardCreateSchema = z.object({ clientId: id, title: z.string().trim().min(1).max(120), description: z.string().max(2000).optional(), assigneeBotId: id.optional(), goalId: id.optional(), columnId: id.optional(), dueAt: z.number().int().optional(), writes: z.boolean().optional(), workRoot: z.number().int().nonnegative().optional() }).strict();
const cardPatchSchema = z.object({ expectedRevision: revision, action: z.enum(["move", "reorder", "reassign", "take_over", "start", "retry", "interrupt", "done", "accept", "cancel", "restore", "reopen", "edit"]), toState: states.optional(), columnId: id.nullable().optional(), beforeCardId: id.optional(), afterCardId: id.optional(), assigneeBotId: id.optional(), confirm: z.boolean().optional(), title: z.string().trim().min(1).max(120).optional(), description: z.string().max(2000).optional(), dueAt: z.number().int().nullable().optional(), writes: z.boolean().optional(), workRoot: z.number().int().nonnegative().nullable().optional() }).strict();
const columnsSchema = z.object({ expectedRevision: revision, columns: z.array(z.object({ id: id.optional(), title: z.string().trim().min(1).max(40), state: states, position: z.number().finite() }).strict()).max(12) }).strict();

export interface ProjectRouteInput {
  botName?: (id: string) => string;
  origin?: "desktop" | "companion" | "unproven";
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  group: { id: string; memberIds: string[]; threadId: string; dm?: boolean } | undefined;
  now: number;
  flags?: ProjectFeatureFlags;
  budgetGate?: ProjectBudgetGate;
  openApprovals?: goals.GroupedDecisions["approvals"];
  effectiveProfiles?: Record<string, "ask" | "engine" | "auto-in-roots">;
}
export interface ProjectRouteResult { status: number; body: Record<string, unknown> }
const error = (status: number, message: string): ProjectRouteResult => ({ status, body: { error: message } });
const ok = (body: Record<string, unknown>): ProjectRouteResult => ({ status: 200, body });
const refused = (reason: string): ProjectRouteResult => ({ status: 409, body: { error: "not_allowed", reason } });
function outcome(value: { ok: boolean; error?: string; reason?: string; [key: string]: unknown }): ProjectRouteResult {
  const { ok: success, ...body } = value;
  if (success) return ok(body);
  return { status: value.error === "invalid" ? 400 : value.error === "not_found" ? 404 : 409, body };
}
function parse<T>(schema: z.ZodType<T>, body: unknown): T | ProjectRouteResult {
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : error(400, "Invalid project request fields.");
}
function isError(value: unknown): value is ProjectRouteResult { return !!value && typeof value === "object" && "status" in value; }

/** Explicit route patterns are also consumed by the route-policy discovery gate. */
export function handleProjectRoute(db: DatabaseSync, input: ProjectRouteInput): ProjectRouteResult | null {
  const route = projectRouteMatch(input.method, input.path);
  if (!route) return null;
  const { action, recordId } = route;
  const { method } = input;
  const group = input.group;
  if (!group || group.dm) return error(404, "not a project");
  if (["budget-create","budget-patch","work-roots","work-profile"].includes(action) && input.origin !== "desktop") return error(403, "This needs the Murage app on your computer.");
  const settings = records.projectSettingsFor(db, group.id);
  if (!settings && action !== "usage") return error(404, "not a project");
  if (action === "usage") {
    const budgets = projectBudgetsForGroup(db, group.id);
    const period = input.query.get("period"); const goalId = input.query.get("goal") ?? undefined;
    const selected = period ? budgets.find(b => b.id === period || b.period === period) : undefined;
    if (period && !selected) return error(400, "No such budget period.");
    return ok({ ...projectUsage(db, { groupId: group.id, goalId, ...(selected ? { since: selected.periodStart } : {}) }), budgets });
  }
  if (!settings) return error(404, "not a project");
  const lifecycle = records.projectLifecycle(settings);
  if (method !== "GET" && records.projectIsClosing(db,group.id)) return refused("This project is closing.");
  if (method !== "GET" && lifecycle !== "open") return refused(lifecycle === "ended" ? "This is a channel now" : "This project is closed");
  const { now, query } = input;
  const groupId = group.id;
  const audience = { origin: input.origin, rootThreadId: group.threadId };
  const owner: cards.ProjectActor = { kind: "owner", ...(input.origin === "desktop" || input.origin === "companion" ? {
    lineage: { origin: input.origin, rootThreadId: group.threadId, audienceFingerprint: audienceFingerprint(group.threadId, audience), notOwnerAudience: !turnAudienceIsOwner(group.threadId, audience) },
  } : {}) };
  const memberIds = group.memberIds;
  const before = query.has("before") ? Number(query.get("before")) : undefined;
  const limit = query.has("limit") ? Number(query.get("limit")) : action === "activity" ? 100 : 50;
  if ((before !== undefined && (!Number.isFinite(before) || before < 0)) || !Number.isInteger(limit) || limit < 1 || limit > (action === "activity" ? 100 : 50)) return error(400, "Invalid page bounds.");
  if (method === "GET") {
    if (action === "project") {
      const goal = goalsForRead(db, groupId);
      const decisions = goals.deriveGroupedDecisions(db, { groupId, openApprovals: input.openApprovals ?? [], now });
      const budgets = projectBudgetsForGroup(db, groupId);
      const activeGoal=records.activeProjectGoal(db,groupId);
      const period=budgets.find(budget=>budget.period!=="goal");
      const usageRead = projectUsage(db, { groupId, ...(activeGoal ? { goalId: activeGoal.id } : period ? {since:period.periodStart} : {}) });
      const usage = { ...usageRead.totals, notReported: usageRead.notReported, interrupted: usageRead.interrupted };
      const viewed = settings.ownerViewedAt ?? 0;
      const changedCards = db.prepare("SELECT COUNT(*) AS n FROM project_work_items WHERE group_id=? AND updated_at>?").get(groupId, viewed)?.n ?? 0;
      const changedDecisions = db.prepare("SELECT COUNT(*) AS n FROM project_activity WHERE group_id=? AND at>? AND kind='criteria'").get(groupId, viewed)?.n ?? 0;
      const messages = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages'").get()
        ? db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id=? AND at>?").get(group.threadId, viewed)?.n ?? 0 : 0;
      const reason = settings.runState === "paused" ? settings.runStateReason ?? "Paused"
        : goal?.state === "planning" ? `Waiting for ${settings.leadBotId && input.botName ? input.botName(settings.leadBotId) : "the lead"}'s plan`
        : goal?.state === "awaiting_plan_ok" ? "Waiting for your OK on the plan"
        : goal?.state === "paused" ? goal.stateReason ?? "Paused" : goal?.stateReason ?? null;
      const queuedCards = db.prepare("SELECT work_item_id AS cardId, refusal FROM room_requests WHERE group_id=? AND state='queued' AND work_item_id IS NOT NULL").all(groupId)
        .map(row => ({ cardId: String(row.cardId), reason: row.refusal === "plan_not_approved" ? reason : queuedCardReason(String(row.refusal ?? "")) }));
      const waitingSlots = (db.prepare("SELECT id FROM room_requests WHERE group_id=? AND state='waiting_owner' AND work_item_id IS NOT NULL AND verb IN ('assign','wake')").all(groupId) as Array<{ id: string }>).filter(({ id }) => !cardRequestIsReview(db, roomRequest(db, id)!)).length;
      const parallelCards = input.flags?.projectsParallelCards === false ? 1 : settings.parallelCards;
      return ok({ lifecycle, closing: records.projectIsClosing(db,groupId), closeStep: records.currentProjectClose(db,groupId)?.step ?? null, settings: { ...settings, effectiveProfiles: input.effectiveProfiles ?? {} }, brief: records.currentProjectBrief(db, groupId), goal, budgets, strip: { reason, queuedCards, line: !projectsLeadEnabled(input.flags) || !settings.leadBotId ? "Paused: the lead is off" : !projectsGoalsEnabled(input.flags) ? "Paused: goals are off" : settings.runState === "paused" ? "Paused" : waitingSlots ? `${waitingSlots} of ${Math.max(parallelCards, waitingSlots)} slots waiting on you` : goal?.title ?? "", needsYou: decisions.count, usage }, sinceYouLeft: { messages, cards: changedCards, decisions: changedDecisions }, revision: settings.revision });
    }
    if (action === "board") {
      const all = records.projectCardsForGroup(db, groupId, query.get("archived") === "1");
      const usage = new Map<string, { workMs: number; tokens: number; tokensReported: boolean }>();
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='usage_ledger'").get()) {
        for (const row of db.prepare(`SELECT work_item_id, SUM(work_ms) AS work_ms,
          SUM(COALESCE(input,0)+COALESCE(output,0)) AS tokens, MIN(tokens_reported) AS reported
          FROM usage_ledger WHERE group_id=? AND work_item_id IS NOT NULL GROUP BY work_item_id`).all(groupId)) {
          usage.set(String(row.work_item_id), { workMs: Number(row.work_ms), tokens: Number(row.tokens), tokensReported: row.reported === 1 });
        }
      }
      return ok({ lifecycle, columns: [...canonicalColumns, ...records.projectBoardColumnsForGroup(db, groupId)], columnsRevision: settings.revision, cards: all.filter(card => (!query.get("goal") || card.goalId === query.get("goal")) && (!query.get("bot") || card.assigneeBotId === query.get("bot"))).map(card => ({ ...card, usage: usage.get(card.id) ?? { workMs: 0, tokens: 0, tokensReported: false } })) });
    }
    if (action === "activity") {
      const cardId = query.get("card");
      if (cardId !== null && !id.safeParse(cardId).success) return error(400, "Invalid card id.");
      return ok({ lifecycle, items: records.listProjectActivity(db, groupId, { before, limit, cardId: cardId ?? undefined }) });
    }
    if (action === "versions") return ok({ lifecycle, versions: db.prepare("SELECT version, updated_by AS updatedBy, change, updated_at AS updatedAt FROM project_briefs WHERE group_id=? AND version<? ORDER BY version DESC LIMIT ?").all(groupId, before ?? Number.MAX_SAFE_INTEGER, limit) });
    const brief = records.projectBriefVersion(db, groupId, Number(recordId));
    return brief ? ok({ lifecycle, brief }) : error(404, "no such brief version");
  }
  db.exec("SAVEPOINT project_route");
  try {
    const result = write();
    if (result.status >= 400) db.exec("ROLLBACK TO project_route");
    db.exec("RELEASE project_route");
    return result;
  } catch (cause) {
    db.exec("ROLLBACK TO project_route; RELEASE project_route");
    throw cause;
  }
  function write(): ProjectRouteResult {
    if (action === "viewed") {
      const body = parse(z.object({}).strict(), input.body); if (isError(body)) return body;
      markProjectViewed(db, { groupId, now }); return ok({ ok: true });
    }
    if (action === "brief") {
      const body = parse(briefSchema, input.body); if (isError(body)) return body;
      return outcome(patchProjectBrief(db, { ...body, groupId, now }));
    }
    if (action === "budget-create" || action === "budget-patch") {
      const gate = input.budgetGate ?? createProjectBudgetGate(db);
      if (action === "budget-create") {
        const body = parse(budgetCreate,input.body); if (isError(body)) return body;
        if (projectBudgetsForGroup(db,groupId).some(b => b.period !== "goal")) return refused("A period budget already exists. Change it instead.");
        const budget = createDefaultPeriodBudget(db,{groupId,period:body.period,tz:body.tz,now});
        const result = patchProjectBudget(db,{...body,budgetId:budget.id,expectedRevision:budget.revision,now},gate);
        return result.ok ? ok({budget:result.budget}) : refused("The budget changed.");
      }
      const body = parse(budgetPatch,input.body); if (isError(body)) return body;
      if (!projectBudgetsForGroup(db,groupId).some(b => b.id === body.budgetId)) return error(404,"no such budget");
      const result = patchProjectBudget(db,{...body,now},gate);
      return result.ok ? ok({budget:result.budget}) : {status:409,body:{error:"changed",budget:result.budget}};
    }
    if (action === "work-roots" || action === "work-profile") {
      const body = action === "work-roots" ? parse(rootsSchema,input.body) : parse(profileSchema,input.body);
      if (isError(body)) return body;
      if (body.expectedRevision !== settings!.revision) return {status:409,body:{error:"changed",settings}};
      if (action === "work-profile" && input.flags?.projectsWorkProfile === false) return refused("Project work profiles are off.");
      if ("roots" in body) {
        try {
          const roots = canonicalProjectRoots(body.roots,{dataDir:DATA_DIR}).map(root => ({...root,label:root.label ?? "Work folder",addedAt:now}));
          db.prepare("UPDATE project_settings SET work_roots=?,revision=revision+1,updated_at=? WHERE group_id=?").run(JSON.stringify(roots),now,groupId);
        } catch (cause) { return error(400,cause instanceof Error ? cause.message : "Choose a work folder."); }
      } else db.prepare("UPDATE project_settings SET work_profile=?,revision=revision+1,updated_at=? WHERE group_id=?").run(body.workProfile,now,groupId);
      records.insertProjectActivity(db,{groupId,kind:action === "work-roots" ? "work_roots" : "settings",actor:"owner",at:now,detail:{field:action}});
      return ok({settings:records.projectSettingsFor(db,groupId)});
    }
    if (action === "settings") {
      const body = parse(settingsSchema, input.body); if (isError(body)) return body;
      return outcome(patchProjectSettings(db, { ...body, groupId, memberIds, now }));
    }
    if (action === "goal-create") {
      const body = parse(goalCreateSchema, input.body); if (isError(body)) return body;
      return outcome(goals.createProjectGoal(db, { ...body, groupId, now }));
    }
    if (action === "goal-patch") {
      const body = parse(goalPatchSchema, input.body); if (isError(body)) return body;
      const goal = records.projectGoalById(db, recordId!);
      if (!goal || goal.groupId !== groupId) return error(404, "no such goal");
      if (goal.revision !== body.expectedRevision) return { status: 409, body: { error: "changed", goal } };
      const base = { goalId: goal.id, now };
      if (body.action && (body.title !== undefined || body.description !== undefined || body.criteria !== undefined)) return error(400, "Edit the goal separately from its action.");
      switch (body.action) {
        case "start": {
          if (input.origin === "companion") {
            const period = projectBudgetsForGroup(db,groupId).find(b => b.period !== "goal");
            const used = period ? (input.budgetGate ?? createProjectBudgetGate(db)).usage(period,now) : null;
            if (!period || !used || period.maxWorkMinutes * 60000 - used.workMs < DEFAULT_GOAL_WORK_MINUTES * 60000
              || (period.maxTokens !== null && period.maxTokens - used.tokens < DEFAULT_GOAL_TOKENS)) return error(403,"This needs the Murage app on your computer.");
          }
          return outcome(goals.startProjectGoal(db, { ...base, tz: projectBudgetsForGroup(db,groupId).find(b => b.period !== "goal")?.tz ?? "UTC", flags: input.flags }));
        }
        case "approve_plan": return outcome(goals.approveProjectPlan(db, { ...base, memberIds }));
        case "change_plan": return outcome(goals.changeProjectPlan(db, { ...base, note: body.note ?? "" }));
        case "sign_off": return outcome(goals.signOffProjectGoal(db, { ...base, actor: owner }));
        case "send_back": return outcome(goals.sendProjectGoalBack(db, { ...base, actor: owner, note: body.note ?? "", memberIds }));
        case "pause": return outcome(goals.pauseProjectGoal(db, { ...base, actor: owner, reason: body.note ?? "Paused by you" }));
        case "resume": {
          const verdict=(input.budgetGate??createProjectBudgetGate(db)).check({groupId,goalId:goal.id,kind:"wake",now});
          return verdict.ok ? outcome(goals.resumeProjectGoal(db, { ...base, flags: input.flags, memberIds })) : refused(verdict.line);
        }
        case "stop": return outcome(goals.stopProjectGoal(db, { ...base, actor: owner, reason: body.note }));
        default: return outcome(goals.patchProjectGoal(db, { ...body, ...base }));
      }
    }
    if (action === "columns") {
      const body = parse(columnsSchema, input.body); if (isError(body)) return body;
      if (body.expectedRevision !== settings!.revision) return { status: 409, body: { error: "changed", settings } };
      const ids = body.columns.map(column => column.id ?? randomUUID());
      if (new Set(ids).size !== ids.length || ids.some(value => canonicalColumns.some(column => column.id === value))) return error(400, "Column ids must be distinct custom ids.");
      for (let i = 0; i < body.columns.length; i++) {
        const held = db.prepare("SELECT state FROM project_board_columns WHERE group_id=? AND id=?").get(groupId, ids[i]!);
        if (held && held.state !== body.columns[i]!.state) return refused("A column's state cannot change.");
      }
      db.prepare("DELETE FROM project_board_columns WHERE group_id=?").run(groupId);
      for (let i = 0; i < body.columns.length; i++) {
        const column = body.columns[i]!;
        db.prepare("INSERT INTO project_board_columns (group_id,id,title,state,position) VALUES (?,?,?,?,?)").run(groupId, ids[i]!, column.title, column.state, column.position);
      }
      db.prepare("UPDATE project_work_items SET column_id=NULL, revision=revision+1, updated_at=? WHERE group_id=? AND column_id IS NOT NULL AND column_id NOT IN (SELECT id FROM project_board_columns WHERE group_id=?)").run(now, groupId, groupId);
      db.prepare("UPDATE project_settings SET revision=revision+1, updated_at=? WHERE group_id=?").run(now, groupId);
      records.insertProjectActivity(db, { groupId, kind: "settings", actor: "owner", at: now, detail: { columns: true } });
      return ok({ columns: records.projectBoardColumnsForGroup(db, groupId), columnsRevision: settings!.revision + 1 });
    }
    if (action === "card-create") {
      const body = parse(cardCreateSchema, input.body); if (isError(body)) return body;
      if (body.goalId && records.projectGoalById(db, body.goalId)?.groupId !== groupId) return error(400, "No such goal in this project.");
      return outcome(cards.createProjectCard(db, { ...body, createKey: `card:${groupId}:${body.clientId}`, groupId, memberIds, actor: owner, now }));
    }
    const body = parse(cardPatchSchema, input.body); if (isError(body)) return body;
    const card = records.projectCardById(db, recordId!);
    if (!card || card.groupId !== groupId) return error(404, "no such card");
    if (body.expectedRevision !== card.revision) return { status: 409, body: { error: "changed", card } };
    const base = { cardId: card.id, actor: owner, memberIds, now };
    switch (body.action) {
      case "move": case "reorder": return outcome(cards.moveProjectCard(db, { ...body, ...base }));
      case "reassign": return typeof body.assigneeBotId !== "string" ? error(400, "assigneeBotId is required.") : outcome(cards.reassignProjectCard(db, { ...base, assigneeBotId: body.assigneeBotId }));
      case "take_over": return outcome(cards.takeOverProjectCard(db, base));
      case "start": { const result = cards.enqueueCardRun(db, base); return result.ok ? ok({ card: records.projectCardById(db, card.id), requestId: result.requestId }) : outcome(result); }
      case "retry": return outcome(cards.retryProjectCard(db, base));
      case "done": return outcome(cards.finishProjectCardByOwner(db, { ...base, confirm: body.confirm, ...(card.waitingOn?.kind === "restart" ? {reason:"Skipped by you"} : {}) }));
      case "accept": return outcome(cards.acceptProjectCard(db, base));
      case "cancel": return outcome(cards.cancelProjectCard(db, base));
      case "restore": return outcome(cards.restoreProjectCard(db, base));
      case "reopen": return outcome(cards.reopenProjectCard(db, base));
      case "edit": return outcome(cards.editProjectCard(db, { ...body, ...base }));
      case "interrupt": {
        if (!card.requestId) return refused("This card has no current run.");
        const failed = cards.applyCardRunFailed(db, { cardId: card.id, requestId: card.requestId, reason: "Interrupted by you", interrupted: true, now });
        if (!failed.ok) return outcome(failed);
        db.prepare("UPDATE room_requests SET state='cancelled', finished_at=?, waiting_since=NULL WHERE (id=? OR parent_id=?) AND state IN ('queued','running','waiting_owner','waiting_bot')").run(now, card.requestId, card.requestId);
        return outcome(failed);
      }
    }
  }
}
function goalsForRead(db: DatabaseSync, groupId: string) {
  const active = records.activeProjectGoal(db, groupId);
  if (active) return active;
  const latest = db.prepare("SELECT id FROM project_goals WHERE group_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(groupId);
  return latest ? records.projectGoalById(db, String(latest.id)) : null;
}
const canonicalColumns = [
  { id: "todo", title: "To do", state: "todo", position: 0 },
  { id: "doing", title: "In progress", state: "doing", position: 1 },
  { id: "waiting", title: "Waiting", state: "waiting", position: 2 },
  { id: "review", title: "Review", state: "review", position: 3 },
  { id: "done", title: "Done", state: "done", position: 4 },
];

export function projectRouteMatch(method: string, path: string): { action: string; recordId?: string } | null {
  let match: RegExpMatchArray | null;
  let action: string | undefined;
  let recordId: string | undefined;
  match = path.match(/^\/api\/groups\/([\w-]+)\/usage$/);
  if (match && method === "GET") action = "usage";
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/budget$/);
  if (match && method === "POST") action = "budget-create";
  if (match && method === "PATCH") action = "budget-patch";
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/work-roots$/);
  if (match && method === "PUT") action = "work-roots";
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/work-profile$/);
  if (match && method === "PATCH") action = "work-profile";
  match = path.match(/^\/api\/groups\/([\w-]+)\/project$/);
  if (match && method === "GET") action = "project";
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/viewed$/);
  if (match && method === "POST") action = "viewed";
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/brief$/);
  if (match && method === "PATCH") action = "brief";
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/brief\/versions$/);
  if (match && method === "GET") action = "versions";
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/brief\/versions\/([0-9]+)$/);
  if (match && method === "GET") { action = "version"; recordId = match[2]; }
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/goals$/);
  if (match && method === "POST") action = "goal-create";
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/goals\/([\w-]+)$/);
  if (match && method === "PATCH") { action = "goal-patch"; recordId = match[2]; }
  match = path.match(/^\/api\/groups\/([\w-]+)\/project\/settings$/);
  if (match && method === "PATCH") action = "settings";
  match = path.match(/^\/api\/groups\/([\w-]+)\/board$/);
  if (match && method === "GET") action = "board";
  match = path.match(/^\/api\/groups\/([\w-]+)\/board\/cards$/);
  if (match && method === "POST") action = "card-create";
  match = path.match(/^\/api\/groups\/([\w-]+)\/board\/cards\/([\w-]+)$/);
  if (match && method === "PATCH") { action = "card-patch"; recordId = match[2]; }
  match = path.match(/^\/api\/groups\/([\w-]+)\/board\/columns$/);
  if (match && method === "PUT") action = "columns";
  match = path.match(/^\/api\/groups\/([\w-]+)\/activity$/);
  if (match && method === "GET") action = "activity";
  return action ? { action, recordId } : null;
}

/** The HTTP boundary stops the current engine before applying live-card actions.
 * A rolled-back preview validates every field and transition before that effect. */
export type ProjectInterruptTarget = Pick<records.ProjectCard, "id" | "assigneeBotId" | "deskThreadId"> & { requestId?: string | null; backoff?: boolean };

export interface PreparedProjectInterrupt { commit(): void; abort(): void }
export type ProjectInterrupt = ((target: ProjectInterruptTarget) => Promise<void | PreparedProjectInterrupt>) & {
  prepare?: (target: ProjectInterruptTarget) => PreparedProjectInterrupt | undefined;
};

export async function handleProjectRouteWithInterrupt(db: DatabaseSync, input: ProjectRouteInput, interrupt: ProjectInterrupt): Promise<ProjectRouteResult | null> {
  const route = projectRouteMatch(input.method, input.path);
  const end = input.method === "PATCH" && input.path === `/api/groups/${input.group?.id}` &&
    !!input.body && typeof input.body === "object" && "channelProject" in input.body && input.body.channelProject === null;
  const apply = (): ProjectRouteResult | null => {
    if (!end) return handleProjectRoute(db, input);
    if (!input.group || input.group.dm) return error(404, "not a project");
    return outcome(endProjectRows(db, { groupId: input.group.id, now: input.now }));
  };
  const goalPatch = route?.action === "goal-patch" ? goalPatchSchema.safeParse(input.body) : null;
  const stopping = end || (goalPatch?.success && goalPatch.data.action === "stop");
  let liveCard: records.ProjectCard | null = null;
  let cardAction = false;
  if (route?.action === "card-patch") {
    const parsed = cardPatchSchema.safeParse(input.body);
    const card = route.recordId ? records.projectCardById(db, route.recordId) : null;
    const effectiveAction = parsed.success && ["move", "reorder"].includes(parsed.data.action)
      ? parsed.data.toState === "cancelled" ? "cancel" : parsed.data.toState === "done" ? "done" : parsed.data.action
      : parsed.success ? parsed.data.action : undefined;
    cardAction = !!(parsed.success && card && card.groupId === input.group?.id && ["interrupt", "cancel", "reassign", "take_over", "done"].includes(effectiveAction!));
    if (cardAction && card?.requestId && ["doing", "waiting"].includes(card.state)) liveCard = card;
  }
  return applyProjectChangeWithInterrupt(db, apply, interrupt, { stopping: stopping || cardAction, liveCard, roomThreadId: input.group?.threadId });
}

export async function applyProjectChangeWithInterrupt<T extends { status: number } | null>(db: DatabaseSync, apply: () => T,
  interrupt: ProjectInterrupt, options: { stopping: boolean; liveCard?: ProjectInterruptTarget | null; roomThreadId?: string }): Promise<T> {
  const prepared: PreparedProjectInterrupt[] = [];
  let committed = false;
  try {
    const liveCard = options.liveCard;
    if (options.stopping) {
      const requests = db.prepare("SELECT * FROM room_requests WHERE state IN ('running','waiting_owner') OR (state='queued' AND dispatched_at IS NOT NULL)").all();
      const targets: ProjectInterruptTarget[] = [];
      const liveRevision = liveCard ? records.projectCardById(db, liveCard.id)?.revision : undefined;
      let liveChanged = false;
      // Preview every row effect, including descendant cancellations, then roll
      // back before touching engines. Failed validation never interrupts a run.
      db.exec("SAVEPOINT project_preview");
      let preview: T;
      try {
        preview = apply();
        if (preview && preview.status < 400) {
          liveChanged = !!liveCard && records.projectCardById(db, liveCard.id)?.revision !== liveRevision;
          for (const request of requests) {
            if (records.roomRequestById(db, String(request.id))?.state !== "cancelled") continue;
            const card = request.work_item_id ? records.projectCardById(db, String(request.work_item_id)) : null;
            targets.push({ id: card?.id ?? String(request.id), requestId: String(request.id), backoff: request.state === "queued", assigneeBotId: request.to_bot_id as string | null,
              deskThreadId: request.target_thread_id as string | null ?? (request.verb === "assign" ? card?.deskThreadId ?? null : null) ?? options.roomThreadId ?? null });
          }
        }
      } finally { db.exec("ROLLBACK TO project_preview; RELEASE project_preview"); }
      if (!preview || preview.status >= 400) return preview;
      if (liveChanged && liveCard && !targets.some(target => target.deskThreadId === liveCard!.deskThreadId && target.assigneeBotId === liveCard!.assigneeBotId)) {
        const request = liveCard.requestId ? records.roomRequestById(db, liveCard.requestId) : null;
        if (request) targets.push({ ...liveCard, backoff: request.state === "queued" && request.dispatched_at !== null });
      }
      // Acquire every dormant retry before the first engine await. Each route
      // owns its holds independently, including when another route aborts.
      for (const target of targets) if (target.backoff) {
        const pending = interrupt.prepare?.(target);
        if (pending) prepared.push(pending);
      }
      const stopped = new Set<string>();
      for (const target of targets) {
        const key = JSON.stringify([target.assigneeBotId, target.deskThreadId, target.requestId]);
        if (stopped.has(key)) continue;
        const pending = await interrupt(target);
        if (pending) prepared.push(pending);
        stopped.add(key);
      }
    }
    db.exec("SAVEPOINT project_interrupt_apply");
    try {
      const result = apply();
      if (result && result.status >= 400) db.exec("ROLLBACK TO project_interrupt_apply");
      db.exec("RELEASE project_interrupt_apply");
      committed = !!result && result.status < 400;
      return result;
    } catch (cause) {
      db.exec("ROLLBACK TO project_interrupt_apply; RELEASE project_interrupt_apply");
      throw cause;
    }
  } finally {
    for (const pending of prepared) { if (committed) pending.commit(); else pending.abort(); }
  }
}

function queuedCardReason(refusal: string): string {
  const reasons: Record<string, string> = {
    project_paused: "Paused", dependency: "Waiting for another card", writer_root_busy: "Waiting for the folder",
    project_card_cap: "Waiting for a free slot", install_card_cap: "Waiting for a free slot", stagger: "Starting soon",
    bot_card_in_project: "Waiting for this member's current card", thread_running: "Waiting for the current turn",
    bot_thread_ceiling: "Waiting for this member", speaking_in_room: "Waiting for this member to finish speaking",
    budget_reached: "Waiting for budget", autonomy_off: "Projects work on their own is off", restore_review: "Waiting for you to finish checking the restore",
    not_reachable: "This member cannot be reached", deadlock: "Waiting for a teammate's answer", root_cap: "Waiting for you to continue",
  };
  return reasons[refusal] ?? "Queued";
}

/** Owner goal transitions that issue a wake commit both effects together. */
export function handleProjectGoalRouteWithWake(db: DatabaseSync, input: ProjectRouteInput, wake: () => void): ProjectRouteResult | null {
  db.exec('SAVEPOINT project_goal_wake');
  try {
    const result = handleProjectRoute(db,input);
    if (result && result.status < 400) wake();
    db.exec('RELEASE project_goal_wake');
    return result;
  } catch (error) { db.exec('ROLLBACK TO project_goal_wake; RELEASE project_goal_wake'); throw error; }
}
