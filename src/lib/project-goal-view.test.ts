// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { describe, expect, it, vi } from "vitest";
import { goalActions, goalStateLabel, goalFormBody, goalActionBody, criterionTarget, goalBudgetLines, resolveCriterionTarget } from "./project-goal-view";
import type { GoalState, ProjectGoal, UsageRead } from "./project-client";
const goal: ProjectGoal = { id: "g", title: "Launch", state: "draft", revision: 7 };
describe("goal controls", () => {
  const states: Array<[GoalState, string[]]> = [["draft",["start"]],["planning",["pause","stop"]],["awaiting_plan_ok",["approve_plan","change_plan"]],["working",["pause","stop"]],["awaiting_signoff",["sign_off","send_back"]],["paused",["resume","stop"]],["done",[]],["stopped",[]],["failed",[]]];
  it.each(states)("offers only the specified actions in %s", (state, expected) => { expect(goalActions(state)).toEqual(expected); expect(goalStateLabel(state)).not.toContain("_"); });
  it("requires bounded notes and preserves the read revision", () => {
    expect(goalActionBody({...goal,state:"awaiting_signoff"}, "send_back", " ")).toEqual({error:"Write a note first."});
    expect(goalActionBody({...goal,state:"awaiting_signoff"}, "send_back", "x".repeat(501))).toHaveProperty("error");
    expect(goalActionBody({...goal,state:"awaiting_plan_ok"}, "change_plan", "Try again")).toEqual({expectedRevision:7,action:"change_plan",note:"Try again"});
    expect(goalActionBody(goal,"start")).toEqual({expectedRevision:7,action:"start"});
    expect(goalActionBody(goal,"sign_off")).toHaveProperty("error");
  });
  it("validates create limits and defaults and retains criterion ids on edits", () => {
    const form = { title:" Launch ",description:"",criteria:[{text:" Works "}],planFirst:false,review:true,deadline:"" };
    expect(goalFormBody(form)).toEqual({title:"Launch",description:"",criteria:["Works"],planFirst:false,review:true,deadlineAt:null});
    for(const change of [{title:" "},{title:"x".repeat(201)},{description:"x".repeat(2001)},{criteria:Array.from({length:11},()=>({text:"x"}))},{criteria:[{text:"x".repeat(301)}]},{deadline:"invalid"}]) expect(goalFormBody({...form,...change})).toHaveProperty("error");
    expect(goalFormBody({...form,criteria:[{id:"c",text:"Works"}]},goal)).toEqual({expectedRevision:7,criteria:[{id:"c",text:"Works"}]});
  });
});
it("resolves message/check evidence to the card desk, files to artifacts, missing desks to no link", () => {
  const card = {id:"c",title:"Card",state:"done" as const,revision:1,deskThreadId:"desk"};
  const evidence = {kind:"message" as const,ref:"message",workItemId:"c",attempt:1,at:1};
  expect(criterionTarget(evidence,[card])).toEqual({threadId:"desk",messageId:"message"});
  expect(criterionTarget({...evidence,kind:"check"},[card])).toEqual({threadId:"desk",messageId:"message"});
  expect(criterionTarget({...evidence,kind:"file",ref:"artifact"},[card])).toEqual({artifactId:"artifact",botId:undefined});
  expect(criterionTarget(evidence,[])).toBeNull();
});
it("formats goal-only usage, states, reported tokens and named missing engines without estimated charges", () => {
  const usage: UsageRead = {lifecycle:"open",totals:{workMs:7080000,input:2900000,output:0,tokensReported:true,charge:null},byBot:[],notReported:["a"],budgets:[]};
  const budget = {id:"b",goalId:"g",period:"goal" as const,state:"warned" as const,revision:1,maxWorkMinutes:120,maxTokens:3000000};
  const lines = goalBudgetLines(budget,usage,[{id:"a",name:"Jax"}]);
  expect(lines).toContain("1 h 58 min of 2 h"); expect(lines).toContain("2.9M of 3.0M tokens"); expect(lines).toContain("80% used"); expect(lines).toContain("tokens not reported by Jax's engine");
  expect(lines.join(" ")).not.toMatch(/cost|spend|charge|[$£€]/i);
  expect(goalBudgetLines({...budget,state:"paused"},usage,[])).toContain("Limit reached: stops starting new work at your limit");
  expect(goalBudgetLines(budget,{...usage,totals:{...usage.totals,tokensReported:false}},[]).join(" ")).not.toContain("2.9M");
});

it("omits unchanged fields and leaves proposed criteria untouched on title edits", () => {
 const criteria=[{id:"a",text:"Works",setBy:"lead" as const,proposed:true,met:false},{id:"b",text:"Ships",setBy:"owner" as const,proposed:false,met:false}];
 const held={...goal,description:"Body",criteria};
 const form={title:"Renamed",description:"Body",criteria,planFirst:false,review:true,deadline:""};
 expect(goalFormBody(form,held)).toEqual({expectedRevision:7,title:"Renamed"});
 expect(goalFormBody({...form,title:held.title,description:"New"},held)).toEqual({expectedRevision:7,description:"New"});
 for(const changed of [[criteria[1],criteria[0]],[{...criteria[0],text:"Updated"},criteria[1]],[{text:"Works"},criteria[1]]]) expect(goalFormBody({...form,criteria:changed},held)).toHaveProperty("criteria");
});
it("a date-only deadline ends on that local calendar day", () => {
 const body=goalFormBody({title:"Goal",description:"",criteria:[],planFirst:false,review:true,deadline:"2026-09-29"});
 expect(body).toHaveProperty("deadlineAt",new Date(2026,8,29,23,59,59,999).getTime());
});
it("formats real reported charges like the strip", () => {
 expect(goalBudgetLines(undefined,{lifecycle:"open",totals:{workMs:0,input:0,output:0,tokensReported:false,charge:0.123456},byBot:[],notReported:[],budgets:[]},[])).toContain("Reported charge: $0.1235");
});

it("resolves check evidence from the room when it is absent from the desk",async()=>{
 const evidence={kind:"check" as const,ref:"check-message",workItemId:"c",attempt:1,at:1};
 const cards=[{id:"c",title:"Work",state:"done" as const,revision:1,deskThreadId:"desk"}];
 const read=vi.fn().mockResolvedValueOnce({messages:[]}).mockResolvedValueOnce({messages:[{id:"check-message"}]});
 expect(await resolveCriterionTarget(evidence,cards,"room",read)).toEqual({threadId:"room",messageId:"check-message"});
 expect(read.mock.calls.map(args=>args[0])).toEqual(["/api/threads/desk/messages?around=check-message&limit=1","/api/threads/room/messages?around=check-message&limit=1"]);
 read.mockReset().mockResolvedValue({messages:[{id:"check-message"}]});
 expect(await resolveCriterionTarget(evidence,cards,"room",read)).toEqual({threadId:"desk",messageId:"check-message"});expect(read).toHaveBeenCalledTimes(1);
 read.mockReset().mockResolvedValue({messages:[]});expect(await resolveCriterionTarget(evidence,cards,"room",read)).toBeNull();
});

it.each(["desk", "reviewer", "room"])("finds persisted evidence in the producing %s thread",async(thread)=>{
 const evidence={kind:"message" as const,ref:"result",workItemId:"c",attempt:1,at:1};
 const cards=[{id:"c",title:"Work",state:"done" as const,revision:1,deskThreadId:"desk",reviewRequestId:"review"}];
 const read=vi.fn(async(path:string)=>({messages:path.includes(`/threads/${thread}/`)?[{id:"result"}]:[]}));
 const requests=vi.fn().mockResolvedValue([{id:"review",verb:"review",state:"done",workItemId:"c",threadId:"reviewer"}]);
 expect(await resolveCriterionTarget(evidence,cards,"room",read,requests)).toEqual({threadId:thread,messageId:"result"});
});

it.each(["desk", "room"])("falls back to the %s when request history fails",async(thread)=>{
 const evidence={kind:"message" as const,ref:"result",workItemId:"c",attempt:1,at:1};
 const cards=[{id:"c",title:"Work",state:"done" as const,revision:1,deskThreadId:"desk"}];
 const read=vi.fn(async(path:string)=>({messages:path.includes(`/threads/${thread}/`)?[{id:"result"}]:[]}));
 const requests=vi.fn().mockRejectedValue(new Error("Request history unavailable"));
 expect(await resolveCriterionTarget(evidence,cards,"room",read,requests)).toEqual({threadId:thread,messageId:"result"});
 expect(requests).toHaveBeenCalledOnce();
 expect(read.mock.calls.map(([path])=>path)).toEqual((thread==="desk"?["desk"]:["desk","room"]).map(id=>`/api/threads/${id}/messages?around=result&limit=1`));
});
