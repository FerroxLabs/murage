// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "./i18n";
export type ProjectLifecycle = "open" | "closed" | "ended";
export type GoalState = "draft" | "planning" | "awaiting_plan_ok" | "working" | "awaiting_signoff" | "paused" | "done" | "stopped" | "failed";
export interface ProjectSettings {
  groupId: string;
  mode: "conversation" | "ongoing";
  leadBotId: string | null;
  parts: { board?: boolean; review?: boolean; digest?: boolean };
  runState: "running" | "paused";
  runStateReason?: string | null;
  closedAt: number | null;
  endedAt: number | null;
  revision: number;
  workRoots?: Array<{path:string;label:string}>;
  parallelCards?: number;
  workProfile?: "ask" | "auto-in-roots";
  effectiveProfiles?: Record<string,"ask"|"engine"|"auto-in-roots">;
}
export interface ProjectGoalEvidence { kind: "message" | "file" | "check"; ref: string; workItemId: string; attempt: number; at: number }
export interface ProjectGoalCriterion { id: string; text: string; setBy: "owner" | "lead"; proposed: boolean; met: boolean; metBy?: string; evidence?: ProjectGoalEvidence }
export interface ProjectGoal { id: string; title: string; state: GoalState; stateReason?: string | null; revision: number; description?: string; criteria?: ProjectGoalCriterion[]; planFirst?: boolean; review?: boolean; deadlineAt?: number | null }
export type ProjectGoalAction = "start" | "approve_plan" | "change_plan" | "sign_off" | "send_back" | "pause" | "resume" | "stop";
export interface ProjectGoalCreate { title: string; description?: string; criteria?: string[]; planFirst?: boolean; review?: boolean; deadlineAt?: number | null }
export interface ProjectGoalPatch { expectedRevision: number; action?: ProjectGoalAction; note?: string; title?: string; description?: string; criteria?: Array<{ id?: string; text: string }> }
export interface UsageTotals { interrupted?: boolean; workMs: number; input: number; output: number; tokensReported: boolean; charge: number | null }
export interface ProjectBudget {
  id: string;
  state: "ok" | "warned" | "paused";
  revision: number;
  maxWorkMinutes?: number;
  maxTokens?: number | null;
  goalId?: string | null;
  period?: "goal"|"day"|"week"|"month";
  tz?: string;
}
export interface ProjectRead {
  closing?: boolean;
  closeStep?: number | null;
  lifecycle: ProjectLifecycle;
  settings: ProjectSettings;
  brief: { version: number; summary: string; doneMeans?: string; rules?: string; whereWorkIs?: Array<{ text: string; path?: string; by: string; at: number; sourceMessageIds?: string[]; stale?: true }> } | null;
  goal: ProjectGoal | null;
  budgets: ProjectBudget[];
  strip: { line: string; needsYou: number; usage: UsageTotals };
  sinceYouLeft: { messages: number; cards: number; decisions: number };
  revision: number;
}
export interface RoomRequest {
  id: string;
  verb: "owner_send" | "room_turn" | "ask" | "message" | "assign" | "review" | "wake" | "routine";
  state: "queued" | "running" | "waiting_owner" | "waiting_bot" | "done" | "failed" | "cancelled" | "expired" | "unknown";
  fromKind: string;
  toBotId: string | null;
  refusalLine: string | null;
  createdAt: number;
  workItemId: string | null;
  outcomeNote: string | null;
  threadId?: string | null;
  targetThreadId?: string | null;
  steeringMode?: string;
  payloadText?: string;
}
export interface UsageRead {
  interrupted?: boolean;
  lifecycle: ProjectLifecycle;
  totals: UsageTotals;
  byBot: Array<UsageTotals & { botId: string }>;
  notReported: string[];
  budgets: ProjectBudget[];
}
export interface ProjectCard {
  id: string;
  title: string;
  state: "todo" | "doing" | "waiting" | "review" | "done" | "failed" | "cancelled";
  revision: number;
  assigneeBotId?: string | null;
  number?: number;
  description?: string;
  goalId?: string | null;
  ownerTookOver?: boolean;
  columnId?: string | null;
  position?: number;
  waitingOn?: { kind: string; detail?: string; requestId?: string } | null;
  reason?: string | null;
  dependsOn?: string[];
  writes?: boolean;
  workRootIndex?: number | null;
  requestId?: string | null;
  reviewRequestId?: string | null;
  deskThreadId?: string | null;
  resultMessageId?: string | null;
  dueAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number | null;
  usage?: { workMs: number; tokens: number; tokensReported: boolean };
}
export interface ProjectBoardRead {
  lifecycle: ProjectLifecycle;
  columns: Array<{ id: string; title: string; state: string; position: number }>;
  columnsRevision: number;
  cards: ProjectCard[];
}
export type ProjectColumn = ProjectBoardRead["columns"][number];
export interface ProjectCardAction {
  expectedRevision: number;
  action: "move" | "reorder" | "reassign" | "take_over" | "start" | "retry" | "interrupt" | "done" | "accept" | "cancel" | "restore" | "reopen" | "edit";
  toState?: ProjectCard["state"];
  columnId?: string | null;
  beforeCardId?: string;
  afterCardId?: string;
  assigneeBotId?: string;
  confirm?: boolean;
  title?: string;
  description?: string;
  dueAt?: number | null;
  writes?: boolean;
  workRoot?: number | null;
}
export interface ProjectCardCreate {
  clientId: string; title: string; description?: string; assigneeBotId?: string;
  goalId?: string; columnId?: string; dueAt?: number; writes?: boolean; workRoot?: number;
}
export interface ProjectActivityRow {
  id: string; at: number; kind: string; actor: string; workItemId: string | null;
  goalId: string | null; requestId: string | null; detail: Record<string, unknown>;
}
export type ProjectErrorBody = { error: "changed"; [current: string]: unknown } | { error: "not_allowed"; reason: string } | { error: string };
export type ProjectResult<T> = { ok: true; data: T } | { ok: false; unavailable: boolean; status?: number; reason: string; body?: ProjectErrorBody };
export interface ProjectFeatures {
  features?: { projectsLead?: boolean; projectsGoals?: boolean; projectsBoard?: boolean; projectsDigest?: boolean; projectsAutonomy?: boolean; roomsQueue?: boolean };
}
/** Missing flags mean an older server. Autonomy off still exposes owner controls. */
export function projectSurfaceEnabled(config: ProjectFeatures | null | undefined): boolean {
  return typeof config?.features?.projectsLead === "boolean" && config.features.roomsQueue === true;
}
/** The English line. Screens read it through projectUnavailable(). */
export const PROJECT_UNAVAILABLE = "Project details are not available yet";
export const projectUnavailable = (): string => t("projects.client.unavailable");
export function projectWriteReason(project: ProjectRead | null): string | null {
  if (!project) return projectUnavailable();
  if (project.lifecycle === "ended" || project.settings.endedAt != null) return t("projects.common.nowChannel");
  if (project.lifecycle === "closed" || project.settings.closedAt != null) return t("projects.common.closedNote");
  if (project.closing) return t("projects.client.closing");
  return null;
}
type Send = (path: string, init?: RequestInit) => Promise<unknown>;
export function createProjectClient(send: Send) {
  async function read<T>(path: string, body?: unknown, method = "POST"): Promise<ProjectResult<T>> {
    try {
      const data = await send(path, body === undefined ? undefined : { method, body: JSON.stringify(body) });
      return { ok: true, data: data as T };
    } catch (error) {
      const failure = error as { status?: number; body?: ProjectErrorBody; message?: string };
      const status = failure.status;
      const unavailable = status === undefined || status === 404 || status >= 500;
      const detail = failure.body;
      const reason = unavailable ? projectUnavailable()
        : detail?.error === "changed" ? t("projects.client.changed")
        : detail && "reason" in detail && typeof detail.reason === "string" ? detail.reason
        : status === 403 ? t("projects.work.needsApp")
        : failure.message || t("projects.client.couldNot");
      return { ok: false, unavailable, status, reason, ...(detail ? { body: detail } : {}) };
    }
  }
  const group = (id: string) => `/api/groups/${encodeURIComponent(id)}`;
  const query = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
    return params.size ? `?${params}` : "";
  };
  return {
    close: (id:string,stopGoal=false) => read<{summaryRequestId:string|null}>(`${group(id)}/project/close`,stopGoal ? {stopGoal:true} : {}),
    reopen: (id:string) => read<{settings:ProjectSettings;pausedRoutines:string[];resumeHint:string}>(`${group(id)}/project/reopen`,{}),
    end: (id:string) => read<unknown>(group(id),{channelProject:null},"PATCH"),
    exportBrief: (id:string,workRootIndex:number) => read<{path:string}>(`${group(id)}/project/export-brief`,{workRootIndex}),
    createGoal: (id: string, body: ProjectGoalCreate) => read<{ goal: ProjectGoal }>(`${group(id)}/project/goals`, body),
    goal: (id: string, goalId: string, body: ProjectGoalPatch) => read<{ goal: ProjectGoal }>(`${group(id)}/project/goals/${encodeURIComponent(goalId)}`, body, "PATCH"),
    settings: (id: string, body: { expectedRevision: number; parts: ProjectSettings["parts"] }) => read<{ settings: ProjectSettings }>(`${group(id)}/project/settings`, body, "PATCH"),
    parallelCards: (id:string,expectedRevision:number,parallelCards:number)=>read<{settings:ProjectSettings}>(`${group(id)}/project/settings`,{expectedRevision,parallelCards},"PATCH"),
    budget: (id:string,body:{budgetId:string;expectedRevision:number;maxWorkMinutes?:number;maxTokens?:number;tz?:string})=>read<{budget:ProjectBudget}>(`${group(id)}/project/budget`,body,"PATCH"),
    roots: (id:string,expectedRevision:number,roots:Array<{path:string;label?:string}>)=>read<{settings:ProjectSettings}>(`${group(id)}/project/work-roots`,{expectedRevision,roots},"PUT"),
    profile: (id:string,expectedRevision:number,workProfile:"ask"|"auto-in-roots")=>read<{settings:ProjectSettings}>(`${group(id)}/project/work-profile`,{expectedRevision,workProfile},"PATCH"),
    board: (id: string, options: { archived?: boolean; goal?: string; bot?: string } = {}) => read<ProjectBoardRead>(`${group(id)}/board${query({ archived: options.archived ? 1 : undefined, goal: options.goal, bot: options.bot })}`),
    createCard: (id: string, body: ProjectCardCreate) => read<{ card: ProjectCard }>(`${group(id)}/board/cards`, body),
    columns: (id: string, body: { expectedRevision: number; columns: ProjectColumn[] }) => read<{ columns: ProjectColumn[]; columnsRevision: number }>(`${group(id)}/board/columns`, body, "PUT"),
    activity: (id: string, options: { card?: string; before?: number; limit?: number } = {}) => read<{ lifecycle: ProjectLifecycle; items: ProjectActivityRow[] }>(`${group(id)}/activity${query(options)}`),
    card: (id: string, cardId: string, action: ProjectCardAction) => read<{ card: ProjectCard }>(`${group(id)}/board/cards/${encodeURIComponent(cardId)}`, action, "PATCH"),
    project: (id: string) => read<ProjectRead>(`${group(id)}/project`),
    viewed: (id: string) => read<{ ok: true }>(`${group(id)}/project/viewed`, {}),
    control: <A extends "pause" | "resume" | "stop">(id: string, action: A) =>
      read<A extends "stop" ? { stopped: { requests: number; turns: number } } : { goal?: ProjectGoal; settings: ProjectSettings }>(`${group(id)}/project/control/${action}`, {}),
    redirect: (id: string, note: { clientId: string; text: string }) => read<{ requestId: string }>(`${group(id)}/project/control/redirect`, note),
    requests: (id: string, options: { open?: boolean; before?: string; limit?: number } = {}) => read<{ lifecycle: ProjectLifecycle; requests: RoomRequest[] }>(`${group(id)}/requests${query({ open: options.open ? 1 : undefined, before: options.before, limit: options.limit === undefined ? undefined : Math.min(100, Math.max(1, options.limit)) })}`),
    cancel: (id: string, requestId: string) => read<{ request: RoomRequest }>(`${group(id)}/requests/${encodeURIComponent(requestId)}/cancel`, {}),
    retry: (id: string, requestId: string, assigneeBotId?: string) => read<{ request: RoomRequest }>(`${group(id)}/requests/${encodeURIComponent(requestId)}/retry`, assigneeBotId ? { assigneeBotId } : {}),
    usage: (id: string, options: { goal?: string; period?: string } = {}) => read<UsageRead>(`${group(id)}/usage${query(options)}`),
  };
}
