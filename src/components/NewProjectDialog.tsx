// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { type RefObject, useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { newProjectBody, startProjectReason, type NewProjectForm, type ProjectProposal } from "@/lib/project-new";
import { projectClient } from "@/lib/use-project";
import type { ProjectRead } from "@/lib/project-client";
import { BOARD_BUTTON, BOARD_INPUT, ProjectBoardDialog } from "./ProjectBoardDialog";
import "./project-board.css";
export default function NewProjectDialog({onClose,returnFocusRef}:{onClose:()=>void;returnFocusRef?:RefObject<HTMLElement|null>}) {
  const {state,dispatch}=useStore();
  const [clientId]=useState(()=>crypto.randomUUID());
  const [form,setForm]=useState<NewProjectForm>({purpose:"",mode:"goal",members:[],leadBotId:"",goalTitle:"",goalDescription:"",criteria:[],deadline:"",folder:"",startNow:true});
  const [options,setOptions]=useState<{members:Array<{id:string;name:string}>;chief?:{id:string;name:string}}|null>(null);
  const [proposal,setProposal]=useState<ProjectProposal|null>(null),[plain,setPlain]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[note,setNote]=useState("");
  const [created,setCreated]=useState<{id:string;project:ProjectRead|null;startReason?:string}|null>(null);
  useEffect(()=>{let live=true;api("/api/projects/new-options").then(value=>{if(live)setOptions(value as NonNullable<typeof options>);}).catch(()=>{if(live)setError(t("projects.new.membersLoadError"));});return()=>{live=false;};},[]);
  function field<K extends keyof NewProjectForm>(key:K,value:NewProjectForm[K]){setForm(current=>({...current,[key]:value}));}
  async function propose(){
    if(busy||!form.purpose.trim())return;setBusy(true);setError("");
    try {
      const body=newProjectBody({...form,members:form.members.length?form.members:[options!.chief!.id],leadBotId:"",mode:"goal"},clientId);
      const result=await api("/api/projects/proposal",{method:"POST",body:JSON.stringify({purpose:body.purpose,goal:body.goal,deadlineAt:body.deadlineAt,folder:body.folder})}) as {proposal?:ProjectProposal;reason?:string;note?:string;draft?:string};
      if(result.proposal){const next=result.proposal;setProposal(next);setForm(current=>({...current,members:next.members,leadBotId:next.leadBotId??"",mode:next.mode,brief:undefined}));setNote(result.note??t("projects.new.reviewNote"));}
      else{const draft=typeof result.draft==="string"?result.draft.slice(0,12000):undefined;setProposal(null);setForm(current=>({...current,brief:draft}));setNote(result.reason??t("projects.new.fillBelow"));}
      setPlain(true);
    }catch{setProposal(null);setForm(current=>({...current,brief:undefined}));setNote(t("projects.new.chiefFailed"));setPlain(true);}finally{setBusy(false);}
  }
  async function create(){
    if(busy)return;setBusy(true);setError("");
    try{const body=newProjectBody(form,clientId,proposal);const result=await api("/api/projects",{method:"POST",body:JSON.stringify(body)}) as {group:{id:string};startReason?:string};
      const read=await projectClient.project(result.group.id);setCreated({id:result.group.id,project:read.ok?read.data:null,...(result.startReason?{startReason:result.startReason}:{})});
    }catch(cause){setError(cause instanceof Error?cause.message:t("projects.new.createFailed"));}finally{setBusy(false);}
  }
  function open(){if(created){dispatch({type:"select",id:created.id});onClose();}}
  if(created){
    const reason=created.project?startProjectReason(created.project.settings,state.config?.features??{}):t("projects.new.openToCheck");
    const goal=created.project?.goal;
    return <ProjectBoardDialog title={t("projects.new.createdTitle")} onClose={onClose} returnFocusRef={returnFocusRef}><p>{t("projects.new.ready")}</p>{goal?.state==="planning"&&<p>{t("projects.new.goalStarted")}</p>}{goal?.state==="draft" && <>{created.startReason&&<p>{created.startReason}</p>}{reason?<p>{reason}</p>:<button className={BOARD_BUTTON} disabled={busy} onClick={async()=>{setBusy(true);const result=await projectClient.goal(created.id,goal.id,{expectedRevision:goal.revision,action:"start"});if(result.ok)open();else setError(result.reason);setBusy(false);}}>{t("projects.new.startGoal")}</button>}</>}{error&&<p role="alert">{error}</p>}<button className={BOARD_BUTTON} onClick={open}>{t("projects.new.openProject")}</button></ProjectBoardDialog>;
  }
  const showForm=plain||!options?.chief;
  const startNow=form.mode==="goal"&&<label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={form.startNow===true} aria-describedby="start-now-hint" onChange={e=>field("startNow",e.target.checked)} />{t("projects.new.startNow")}</label>;
  const startNowHint=form.mode==="goal"&&<p id="start-now-hint">{t("projects.new.startNowHint")}</p>;
  return <ProjectBoardDialog title={t("projects.new.title")} onClose={onClose} returnFocusRef={returnFocusRef}>
    <form className="space-y-4" onSubmit={e=>{e.preventDefault();void create();}}>
      <label className="block">{t("projects.new.purpose")}<textarea required maxLength={2000} rows={3} className={BOARD_INPUT} value={form.purpose} onChange={e=>field("purpose",e.target.value)} /></label>
      <label className="block">{t("projects.common.deadlineOptional")}<input type="date" className={BOARD_INPUT} value={form.deadline} onChange={e=>field("deadline",e.target.value)} /></label>
      <label className="block">{t("projects.new.folder")}<input className={BOARD_INPUT} maxLength={4096} value={form.folder} onChange={e=>field("folder",e.target.value)} /></label>
      {options?.chief && <div className="flex flex-wrap gap-2"><button type="button" className={BOARD_BUTTON} disabled={busy||!form.purpose.trim()} onClick={()=>void propose()}>{t("projects.new.askPropose",{name:options.chief.name})}</button>{!plain&&<button type="button" className={BOARD_BUTTON} onClick={()=>setPlain(true)}>{t("projects.new.fillMyself")}</button>}</div>}
      {note&&<p role="status">{note}</p>}
      {showForm&&<>
        <label className="block">{t("projects.new.usage")}<select className={BOARD_INPUT} value={form.mode} onChange={e=>field("mode",e.target.value as NewProjectForm["mode"])}><option value="goal">{t("projects.new.mode.goal")}</option><option value="chat">{t("projects.new.mode.chat")}</option><option value="ongoing">{t("projects.new.mode.ongoing")}</option><option value="bots">{t("projects.new.mode.bots")}</option></select></label>
        {form.mode==="goal"&&<fieldset className="space-y-3"><legend>{t("projects.new.goalLegend")}</legend><label className="block">{t("projects.new.goalTitle")}<input maxLength={200} className={BOARD_INPUT} value={form.goalTitle} onChange={e=>field("goalTitle",e.target.value)} /></label><label className="block">{t("projects.new.goalDescription")}<textarea maxLength={2000} className={BOARD_INPUT} value={form.goalDescription} onChange={e=>field("goalDescription",e.target.value)} /></label>{form.criteria.map((text,index)=><label key={index} className="block">{t("projects.new.criterion",{number:index+1})}<input maxLength={300} className={BOARD_INPUT} value={text} onChange={e=>field("criteria",form.criteria.map((c,i)=>i===index?e.target.value:c))} /></label>)}<button type="button" className={BOARD_BUTTON} disabled={form.criteria.length>=5} onClick={()=>field("criteria",[...form.criteria,""])}>{t("projects.new.addCriterion")}</button></fieldset>}
        <fieldset><legend>{t("projects.new.members")}</legend>{!options&&<p>{t("projects.new.loadingMembers")}</p>}{options?.members.map(member=><label key={member.id} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={form.members.includes(member.id)} onChange={e=>{const members=e.target.checked?[...form.members,member.id]:form.members.filter(id=>id!==member.id);setForm({...form,members,leadBotId:members.includes(form.leadBotId)?form.leadBotId:""});}} />{member.name}</label>)}</fieldset>
        {form.mode!=="bots"&&<label className="block">{t("projects.new.lead")}<select className={BOARD_INPUT} value={form.leadBotId} onChange={e=>field("leadBotId",e.target.value)}><option value="">{t("projects.new.noLead")}</option>{options?.members.filter(m=>form.members.includes(m.id)).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
        {proposal&&<fieldset className="space-y-3"><legend>{t("projects.new.proposedLegend")}</legend>{(["summary","doneMeans","rules"] as const).map(key=><label key={key} className="block">{key==="summary"?t("projects.new.summary"):key==="doneMeans"?t("projects.new.doneMeans"):t("projects.new.rules")}<textarea className={BOARD_INPUT} maxLength={key==="summary"?200:key==="doneMeans"?4000:12000} value={proposal.brief[key]} onChange={e=>setProposal({...proposal,brief:{...proposal.brief,[key]:e.target.value}})} /></label>)}{(["minutes","tokens"] as const).map(key=><label key={key} className="block">{key==="minutes"?t("projects.common.workMinutes"):t("projects.common.tokens")}<input type="number" step={1} min={1} max={key==="minutes"?100000:Number.MAX_SAFE_INTEGER} required className={BOARD_INPUT} value={proposal.budget[key]} onChange={e=>setProposal({...proposal,budget:{...proposal.budget,[key]:Number(e.target.value)}})} /></label>)}<label className="block">{t("projects.new.firstPlan")}<textarea className={BOARD_INPUT} rows={4} maxLength={2247} aria-describedby="first-plan-hint" value={proposal.planOutline.join("\n")} onChange={e=>setProposal({...proposal,planOutline:e.target.value.split("\n")})} /></label><p id="first-plan-hint">{t("projects.new.firstPlanHint")}</p>{startNow}{startNowHint}</fieldset>}
        {!proposal&&form.brief!==undefined&&<label className="block">{t("projects.new.chiefBrief")}<textarea className={BOARD_INPUT} rows={6} maxLength={12000} value={form.brief} onChange={e=>field("brief",e.target.value)} /></label>}
        {!proposal&&<fieldset className="space-y-3"><legend>{t("projects.new.budgetLegend")}</legend>{(["budgetMinutes","budgetTokens"] as const).map(key=><label key={key} className="block">{key==="budgetMinutes"?t("projects.common.workMinutes"):t("projects.common.tokens")}<input type="number" min={1} max={key==="budgetMinutes"?100000:Number.MAX_SAFE_INTEGER} step={1} className={BOARD_INPUT} value={form[key]??(key==="budgetMinutes"?"120":"3000000")} onChange={e=>field(key,e.target.value)} /></label>)}{startNow}{startNowHint}</fieldset>}
        <button className={BOARD_BUTTON} disabled={busy||!options||!form.members.length}>{t("projects.new.create")}</button>
      </>}{error&&<p role="alert">{error}</p>}
    </form>
  </ProjectBoardDialog>;
}
