// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useId, useState } from "react";
import type { ProjectRead, ProjectResult } from "@/lib/project-client";
import { projectClient, refreshProject } from "@/lib/use-project";
import { useStore } from "@/state/store";
const button="min-h-11 rounded-lg border border-hairline px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const field=button+" w-full bg-app";
export default function ProjectWorkSettings({groupId,project}:{groupId:string;project:ProjectRead}) {
  const {state}=useStore();
  const profileId=useId(); const parallelId=useId();
  const [busy,setBusy]=useState(false);const [notice,setNotice]=useState<string|null>(null);
  const [minutes,setMinutes]=useState<Record<string,string>>({});const [tokens,setTokens]=useState<Record<string,string>>({});
  const desktop=Boolean(window.muragebox?.pickFolder);
  const roots=(project.settings.workRoots??[]).map(({path,label})=>({path,label}));
  const readOnly=project.lifecycle!=="open";
  async function act(action:()=>Promise<ProjectResult<unknown>>) {
    if(busy||readOnly)return;setBusy(true);setNotice(null);
    try{const result=await action();if(!result.ok)setNotice(result.reason);await refreshProject(groupId);}finally{setBusy(false);}
  }
  const memberIds=state.groups.find(group=>group.id===groupId)?.memberIds??[];
  return <section aria-label={t("projects.work.aria")} className="space-y-4 border-t border-hairline pt-3">
    <h3 className="font-medium">{t("projects.work.budgetTitle")}</h3>
    <p>{t("projects.work.budgetHint")}</p>
    {!desktop&&<p>{t("projects.work.needsApp")}</p>}
    {notice&&<p role="status">{notice}</p>}
    {project.budgets.map(budget=><form key={budget.id} className="space-y-2" onSubmit={event=>{event.preventDefault();void act(()=>projectClient.budget(groupId,{budgetId:budget.id,expectedRevision:budget.revision,maxWorkMinutes:Number(minutes[budget.id]??budget.maxWorkMinutes),...(budget.maxTokens!=null?{maxTokens:Number(tokens[budget.id]??budget.maxTokens)}:{})}));}}>
      <p>{budget.maxTokens!=null?t("projects.work.budgetLineTokens",{label:budget.goalId?t("projects.work.goalBudget"):t("projects.work.periodBudget"),minutes:budget.maxWorkMinutes ?? "",tokens:budget.maxTokens.toLocaleString()}):t("projects.work.budgetLine",{label:budget.goalId?t("projects.work.goalBudget"):t("projects.work.periodBudget"),minutes:budget.maxWorkMinutes ?? ""})}</p>
      <label className="block">{t("projects.common.workMinutes")}<input className={field} type="number" min="1" max="100000" required disabled={busy||readOnly||!desktop} value={minutes[budget.id]??String(budget.maxWorkMinutes??"")} onChange={event=>setMinutes({...minutes,[budget.id]:event.target.value})}/></label>
      {budget.maxTokens!=null&&<label className="block">{t("projects.common.tokens")}<input className={field} type="number" min="1" required disabled={busy||readOnly||!desktop} value={tokens[budget.id]??String(budget.maxTokens)} onChange={event=>setTokens({...tokens,[budget.id]:event.target.value})}/></label>}
      <button className={button} disabled={busy||readOnly||!desktop} type="submit">{t("projects.work.saveBudget")}</button>
    </form>)}
    {!project.closing&&(project.settings.runState==="paused"||project.goal?.state==="paused")&&<button className={button} disabled={busy||readOnly||project.budgets.some(b=>b.state==="paused"&&(!b.goalId||b.goalId===project.goal?.id))} onClick={()=>void act(()=>projectClient.control(groupId,"resume"))}>{t("projects.work.resume")}</button>}
    <label htmlFor={parallelId} className="block">{t("projects.work.cardsAtOnce")}</label>
    <select id={parallelId} className={field} disabled={busy||readOnly||!desktop} value={project.settings.parallelCards??3} onChange={event=>void act(()=>projectClient.parallelCards(groupId,project.settings.revision,Number(event.target.value)))}>{[1,2,3,4,5].map(count=><option key={count} value={count}>{count}</option>)}</select>
    <p>{t("projects.work.cardsHint")}</p>
    <h3 className="font-medium">{t("projects.work.foldersTitle")}</h3>
    <p>{t("projects.work.foldersHint")}</p>
    <ul className="space-y-2">{roots.map((root,index)=><li key={root.path} className="space-y-1"><p className="break-all">{root.label}: {root.path}</p><button className={button} disabled={busy||readOnly||!desktop} onClick={()=>void act(()=>projectClient.roots(groupId,project.settings.revision,roots.filter((_,i)=>i!==index)))}>{t("projects.work.remove",{label:root.label})}</button></li>)}</ul>
    <button className={button} disabled={busy||readOnly||!desktop||roots.length>=8} onClick={()=>void (async()=>{const path=await window.muragebox?.pickFolder?.();if(path)await act(()=>projectClient.roots(groupId,project.settings.revision,[...roots,{path,label:path.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0,60)??"Work folder"}]));})()}>{t("projects.work.chooseFolder")}</button>
    <label htmlFor={profileId} className="block">{t("projects.work.fileApprovals")}</label><select id={profileId} className={field} disabled={busy||readOnly||!desktop} value={project.settings.workProfile??"ask"} onChange={event=>void act(()=>projectClient.profile(groupId,project.settings.revision,event.target.value as "ask"|"auto-in-roots"))}><option value="ask">{t("projects.work.ask")}</option><option value="auto-in-roots">{t("projects.work.autoInRoots")}</option></select>
    <ul>{memberIds.map(id=>{const name=state.bots.find(bot=>bot.id===id)?.name??t("projects.common.thisMember");const profile=project.settings.effectiveProfiles?.[id];return <li key={id}>{profile==="auto-in-roots"?t("projects.work.asksOutside",{name}):profile==="ask"?t("projects.work.usesApprovals",{name}):t("projects.work.usesEngine",{name})}</li>;})}</ul>
  </section>;
}
