// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const harness=vi.hoisted(()=>({values:[] as any[],cursor:0,dispatch:vi.fn(),api:vi.fn(),project:vi.fn()}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),useEffect:()=>{},useState:(initial:unknown)=>{const i=harness.cursor++;if(!(i in harness.values))harness.values[i]=typeof initial==="function"?(initial as ()=>unknown)():initial;return[harness.values[i],(value:unknown)=>{harness.values[i]=typeof value==="function"?(value as (v:unknown)=>unknown)(harness.values[i]):value;}];}}));
vi.mock("@/state/store",()=>({api:harness.api,useStore:()=>({state:{config:{features:{}}},dispatch:harness.dispatch})}));
vi.mock("@/lib/use-project",()=>({projectClient:{project:harness.project}}));
import NewProjectDialog from "./NewProjectDialog";
function nodes(n:unknown):ReactElement<Record<string,any>>[]{if(!n||typeof n!=="object")return[];if(Array.isArray(n))return n.flatMap(nodes);const e=n as ReactElement<Record<string,any>>;return[e,...nodes(e.props?.children)];}
function render(){harness.cursor=0;return nodes(NewProjectDialog({onClose:vi.fn()}));}
const form={purpose:"Owner purpose",mode:"goal",members:[],leadBotId:"",goalTitle:"Report",goalDescription:"",criteria:["Published"],deadline:"",folder:""};
beforeEach(()=>{vi.clearAllMocks();harness.values=["creation-id",{...form},{members:[{id:"chief",name:"Chief"},{id:"worker",name:"Worker"}],chief:{id:"chief",name:"Chief"}},null,false,false,"","",null];});
it("proposes, lets the owner edit, then creates only on submission",async()=>{
  const proposal={members:["chief","worker"],leadBotId:"chief",mode:"goal",brief:{summary:"Proposal",doneMeans:"Published",rules:"Brief"},budget:{minutes:120,tokens:3000000},planOutline:["Write"]};
  harness.api.mockResolvedValueOnce({proposal});
  render().find(n=>n.type==="button"&&n.props.children==="Ask Chief to propose")!.props.onClick();
  await vi.waitFor(()=>expect(harness.values[3]).toEqual(proposal));
  expect(harness.api).toHaveBeenCalledTimes(1);expect(harness.api.mock.calls[0][0]).toBe("/api/projects/proposal");
  const edited=render();const summary=edited.find(n=>n.type==="textarea"&&n.props.value==="Proposal")!;
  summary.props.onChange({target:{value:"Owner revision"}});
  harness.api.mockResolvedValueOnce({group:{id:"created"}});harness.project.mockResolvedValueOnce({ok:false});
  render().find(n=>n.type==="form")!.props.onSubmit({preventDefault:()=>{}});
  await vi.waitFor(()=>expect(harness.api).toHaveBeenCalledTimes(2));
  expect(harness.api.mock.calls[1][0]).toBe("/api/projects");
  expect(JSON.parse(harness.api.mock.calls[1][1].body)).toMatchObject({purpose:"Owner purpose",brief:{summary:"Owner revision"},members:["chief","worker"],goal:{title:"Report"}});
});
it("keeps owner input and makes the plain form reachable after a failed proposal",async()=>{
  harness.api.mockResolvedValueOnce({reason:"The Chief took too long. Fill in the project below."});
  render().find(n=>n.type==="button"&&n.props.children==="Ask Chief to propose")!.props.onClick();
  await vi.waitFor(()=>expect(harness.values[4]).toBe(true));
  expect(harness.values[1].purpose).toBe("Owner purpose");
  expect(render().some(n=>n.type==="button"&&n.props.children==="Create project")).toBe(true);
});
it("always offers the plain form without a Chief",()=>{
  delete harness.values[2].chief;
  const tree=render();expect(tree.some(n=>n.type==="button"&&n.props.children==="Create project")).toBe(true);
  expect(harness.api).not.toHaveBeenCalled();
});

it("F2 F3 edits First plan and both budgets before submitting owner text",async()=>{
  harness.values[1]={...form,members:["worker"]};harness.values[3]={members:["worker"],leadBotId:null,mode:"goal",brief:{summary:"Summary",doneMeans:"",rules:""},budget:{minutes:120,tokens:3000000},planOutline:["Proposed step"]};harness.values[4]=true;
  render().find(n=>n.type==="textarea"&&n.props.value==="Proposed step")!.props.onChange({target:{value:"Owner step\nVerify"}});
  for(const [old,value] of [[120,"45"],[3000000,"12345"]])render().find(n=>n.type==="input"&&n.props.value===old)!.props.onChange({target:{value}});
  expect(harness.api).not.toHaveBeenCalled();harness.api.mockResolvedValueOnce({group:{id:"made"}});harness.project.mockResolvedValueOnce({ok:false});
  render().find(n=>n.type==="form")!.props.onSubmit({preventDefault:()=>{}});
  await vi.waitFor(()=>expect(harness.api).toHaveBeenCalledTimes(1));
  expect(JSON.parse(harness.api.mock.calls[0][1].body)).toMatchObject({goal:{description:"First plan:\nOwner step\nVerify"},budget:{minutes:45,tokens:12345}});
});
it("F3 plain form exposes optional default budgets and submits edits",async()=>{
  delete harness.values[2].chief;harness.values[1]={...form,members:["worker"]};
  const inputs=render().filter(n=>n.type==="input"&&n.props.type==="number");expect(inputs).toHaveLength(2);
  expect(inputs.map(n=>[n.props.value,n.props.min,n.props.max,n.props.step,!!n.props.required])).toEqual([["120",1,100000,1,false],["3000000",1,Number.MAX_SAFE_INTEGER,1,false]]);
  inputs[0]!.props.onChange({target:{value:"60"}});render().filter(n=>n.type==="input"&&n.props.type==="number")[1]!.props.onChange({target:{value:"50000"}});
  harness.api.mockResolvedValueOnce({group:{id:"made"}});harness.project.mockResolvedValueOnce({ok:false});render().find(n=>n.type==="form")!.props.onSubmit({preventDefault:()=>{}});
  await vi.waitFor(()=>expect(harness.api).toHaveBeenCalledTimes(1));expect(JSON.parse(harness.api.mock.calls[0][1].body).budget).toEqual({minutes:60,tokens:50000});
});

const startNow=(tree:ReactElement<Record<string,any>>[])=>tree.find(n=>n.type==="label"&&nodes(n.props.children).some(c=>c.type==="input"&&c.props.type==="checkbox")&&JSON.stringify(n.props.children).includes("Start now"));
it("C Start now is checked by default next to the budget and sends startGoal",async()=>{
  harness.values=[];const fresh=render();
  const box=nodes(startNow(fresh)!.props.children).find(c=>c.type==="input")!;
  expect(box.props.checked).toBe(true);
  expect(fresh.find(n=>n.type==="fieldset"&&nodes(n.props.children).includes(startNow(fresh)!))).toBeTruthy();
  harness.values[1]={...harness.values[1],purpose:"Owner purpose",members:["worker"],leadBotId:"worker",goalTitle:"Report"};harness.values[2]={members:[{id:"worker",name:"Worker"}]};
  harness.api.mockResolvedValueOnce({group:{id:"made"}});harness.project.mockResolvedValueOnce({ok:false});
  render().find(n=>n.type==="form")!.props.onSubmit({preventDefault:()=>{}});
  await vi.waitFor(()=>expect(harness.api).toHaveBeenCalledTimes(1));
  expect(JSON.parse(harness.api.mock.calls[0][1].body)).toMatchObject({startGoal:true,goal:{title:"Report"}});
});
it("C unchecking Start now sends nothing, and the proposal form offers it too",async()=>{
  harness.values[1]={...form,members:["worker"],leadBotId:"worker",startNow:true};harness.values[3]={members:["worker"],leadBotId:"worker",mode:"goal",brief:{summary:"S",doneMeans:"",rules:""},budget:{minutes:120,tokens:3000000},planOutline:[]};harness.values[4]=true;
  const tree=render();const label=startNow(tree)!;
  expect(tree.find(n=>n.type==="fieldset"&&nodes(n.props.children).some(c=>c.type==="legend"&&c.props.children==="Proposed brief and budget")&&nodes(n.props.children).includes(label))).toBeTruthy();
  nodes(label.props.children).find(c=>c.type==="input")!.props.onChange({target:{checked:false}});
  expect(harness.values[1].startNow).toBe(false);
  harness.api.mockResolvedValueOnce({group:{id:"made"}});harness.project.mockResolvedValueOnce({ok:false});
  render().find(n=>n.type==="form")!.props.onSubmit({preventDefault:()=>{}});
  await vi.waitFor(()=>expect(harness.api).toHaveBeenCalledTimes(1));
  expect(JSON.parse(harness.api.mock.calls[0][1].body)).not.toHaveProperty("startGoal");
});
it("C the Start now hint names the unchecked choice: the goal stays a draft, and nothing asks for plan approval first",async()=>{
  harness.values=[];const tree=render();
  const hint=tree.find(n=>n.type==="p"&&n.props.id==="start-now-hint")!;
  expect(JSON.stringify(hint.props.children)).toContain("Unchecked, the goal stays a draft until you start it.");
  harness.values[1]={...harness.values[1],purpose:"Owner purpose",members:["worker"],leadBotId:"worker",goalTitle:"Report"};harness.values[2]={members:[{id:"worker",name:"Worker"}]};
  harness.api.mockResolvedValueOnce({group:{id:"made"}});harness.project.mockResolvedValueOnce({ok:false});
  render().find(n=>n.type==="form")!.props.onSubmit({preventDefault:()=>{}});
  await vi.waitFor(()=>expect(harness.api).toHaveBeenCalledTimes(1));
  const body=JSON.parse(harness.api.mock.calls[0][1].body);expect(body.goal).not.toHaveProperty("planFirst");expect(body).not.toHaveProperty("planFirst");
});
it("C the Created dialog shows why the goal did not start, beside Start",async()=>{
  harness.values[1]={...form,members:["worker"],leadBotId:"worker",startNow:true};harness.values[4]=true;delete harness.values[2].chief;
  harness.api.mockResolvedValueOnce({group:{id:"made"},startReason:"Projects work on their own is off."});
  harness.project.mockResolvedValueOnce({ok:true,data:{settings:{leadBotId:"worker",parts:{board:true}},goal:{id:"g",state:"draft",revision:1}}});
  render().find(n=>n.type==="form")!.props.onSubmit({preventDefault:()=>{}});
  await vi.waitFor(()=>expect(harness.values[8]).toMatchObject({id:"made",startReason:"Projects work on their own is off."}));
  const done=render();
  expect(done.some(n=>n.type==="p"&&n.props.children==="Projects work on their own is off.")).toBe(true);
  expect(done.some(n=>n.type==="button"&&n.props.children==="Start the goal")).toBe(true);
});
it("N2 a draft the server could not read opens the plain form with the Chief's words in the brief, and Create sends them",async()=>{
  harness.values[1]={...form,members:["worker"],leadBotId:"worker"};
  harness.api.mockResolvedValueOnce({reason:"The Chief's draft could not be read. What it wrote is in the brief below. Check it and fill in the project.",draft:"Ada leads the report."});
  render().find(n=>n.type==="button"&&n.props.children==="Ask Chief to propose")!.props.onClick();
  await vi.waitFor(()=>expect(harness.values[4]).toBe(true));
  expect(harness.values[3]).toBeNull();
  const tree=render();
  expect(tree.some(n=>n.type==="p"&&n.props.role==="status"&&n.props.children==="The Chief's draft could not be read. What it wrote is in the brief below. Check it and fill in the project.")).toBe(true);
  const brief=tree.find(n=>n.type==="textarea"&&n.props.value==="Ada leads the report.")!;
  expect(brief.props.maxLength).toBe(12000);
  brief.props.onChange({target:{value:"Ada leads the report. Owner edit."}});
  harness.api.mockResolvedValueOnce({group:{id:"made"}});harness.project.mockResolvedValueOnce({ok:false});
  render().find(n=>n.type==="form")!.props.onSubmit({preventDefault:()=>{}});
  await vi.waitFor(()=>expect(harness.api).toHaveBeenCalledTimes(2));
  expect(JSON.parse(harness.api.mock.calls[1][1].body)).toMatchObject({purpose:"Owner purpose",brief:{summary:"Owner purpose",doneMeans:"",rules:"Ada leads the report. Owner edit."}});
});
it("N2 the plain form shows no brief field until the Chief left a draft",()=>{
  delete harness.values[2].chief;
  expect(render().some(n=>n.type==="label"&&JSON.stringify(n.props.children).includes("Brief from the Chief"))).toBe(false);
});
