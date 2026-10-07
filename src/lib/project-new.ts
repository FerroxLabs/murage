// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "./i18n";
import type { ProjectFeatures, ProjectSettings } from "./project-client";
export type NewProjectMode = "goal" | "chat" | "ongoing" | "bots";
export interface NewProjectForm { purpose:string; mode:NewProjectMode; members:string[]; leadBotId:string; goalTitle:string; goalDescription:string; criteria:string[]; deadline:string; folder:string; budgetMinutes?:string; budgetTokens?:string;
  /** "Start now": Create also starts the goal. Sent only with a named goal. */
  startNow?:boolean;
  /** What the Chief wrote when its proposal could not be read (lane N2): the
   * owner's to edit, sent as the brief's rules. Absent: no brief field. */
  brief?:string }
export interface ProjectProposal { members:string[]; leadBotId:string|null; mode:NewProjectMode; brief:{summary:string;doneMeans:string;rules:string}; budget:{minutes:number;tokens:number}; planOutline:string[] }
export function newProjectBody(form:NewProjectForm,clientId:string,proposal?:ProjectProposal|null) {
  const purpose=form.purpose.trim();
  if (!purpose || purpose.length>2000 || form.goalTitle.length>200 || form.goalDescription.length>2000 || form.criteria.length>5 || form.criteria.some(c=>c.length>300)) throw new Error(t("projects.newErr.lengths"));
  if (!form.members.length) throw new Error(t("projects.newErr.members"));
  const leadBotId=form.mode==="bots" ? null : form.leadBotId || null;
  if (leadBotId && !form.members.includes(leadBotId)) throw new Error(t("projects.newErr.lead"));
  if (form.mode==="chat" && !leadBotId) throw new Error(t("projects.newErr.chatLead"));
  const lines=proposal?.planOutline ?? [];
  if(lines.length>8 || lines.some(line=>line.length>280))throw new Error(t("projects.newErr.planLines"));
  const plan=lines.filter(line=>line.trim()).join("\n");
  const appendPlan=(text:string)=>plan ? `${text}${text ? "\n\n" : ""}First plan:\n${plan}` : text;
  const description=form.mode==="goal" ? appendPlan(form.goalDescription) : form.goalDescription;
  if(form.mode==="goal" && plan && !form.goalTitle.trim())throw new Error(t("projects.newErr.planNeedsTitle"));
  if(description.length>2000)throw new Error(t("projects.newErr.descLong"));
  const draft=form.brief?.trim();
  const brief=proposal ? {...proposal.brief,rules:form.mode==="goal" ? proposal.brief.rules : appendPlan(proposal.brief.rules)} : draft ? {summary:purpose.slice(0,200),doneMeans:"",rules:draft} : undefined;
  if(brief && brief.rules.length>12000)throw new Error(proposal ? t("projects.newErr.rulesLong") : t("projects.newErr.briefLong"));
  const minutes=form.budgetMinutes ?? "120",tokens=form.budgetTokens ?? "3000000";
  const budget=proposal?.budget ?? (minutes || tokens ? {minutes:Number(minutes || 120),tokens:Number(tokens || 3000000)} : undefined);
  if(budget && (!Number.isInteger(budget.minutes)||budget.minutes<1||budget.minutes>100000||!Number.isSafeInteger(budget.tokens)||budget.tokens<1))throw new Error(t("projects.newErr.budget"));
  return {...(brief?{brief}:{}),...(budget?{budget}:{}),clientId,purpose,mode:form.mode,members:form.members,leadBotId,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(form.mode==="goal" && form.goalTitle.trim() ? {goal:{title:form.goalTitle.trim(),description,criteria:form.criteria.map(c=>c.trim()).filter(Boolean)},...(form.startNow===true?{startGoal:true as const}:{})} : {}),
    ...(form.deadline ? {deadlineAt:localProjectDeadline(form.deadline)} : {}),...(form.folder.trim() ? {folder:form.folder.trim()} : {})};
}
export function startProjectReason(settings:Pick<ProjectSettings,"leadBotId"|"parts">,features:NonNullable<ProjectFeatures["features"]>):string|null {
  if(!settings.leadBotId || features.projectsLead===false)return t("projects.startErr.lead");
  if(settings.parts.board===false || features.projectsBoard===false)return t("projects.startErr.board");
  if(features.projectsGoals===false)return t("projects.startErr.goals");
  if(features.projectsAutonomy===false)return t("projects.startErr.work");
  return null;
}

export function localProjectDeadline(day: string): number {
  const [year,month,date] = day.split('-').map(Number);
  return new Date(year!,month!-1,date!,23,59,59,999).getTime();
}
