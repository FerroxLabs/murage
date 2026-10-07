// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from "vitest";
import { newProjectBody, startProjectReason } from "./project-new";
it("preserves owner input and maps the four modes without requiring a goal", () => {
  for (const mode of ["goal","chat","ongoing","bots"] as const) {
    const result=newProjectBody({purpose:"Purpose",mode,members:["a"],leadBotId:"a",goalTitle:"",goalDescription:"",criteria:[],deadline:"",folder:""},"id");
    expect(result).toMatchObject({purpose:"Purpose",mode,members:["a"]});
    expect(result).not.toHaveProperty("goal");
    expect(result.leadBotId).toBe(mode==="bots"?null:"a");
  }
});
it("bounds criteria and goal text before creating", () => {
  const form={purpose:"Purpose",mode:"goal" as const,members:["a"],leadBotId:"a",goalTitle:"Goal",goalDescription:"",criteria:["Done"],deadline:"",folder:""};
  expect(newProjectBody(form,"id").goal).toEqual({title:"Goal",description:"",criteria:["Done"]});
  expect(()=>newProjectBody({...form,criteria:Array(6).fill("x")},"id")).toThrow();
  expect(()=>newProjectBody({...form,purpose:"x".repeat(2001)},"id")).toThrow();
});
it("explains Start restrictions for lead, board and each feature", () => {
  const settings={leadBotId:"a",parts:{board:true}};
  expect(startProjectReason(settings,{})).toBeNull();
  expect(startProjectReason({...settings,leadBotId:null},{})).toContain("lead");
  expect(startProjectReason({...settings,parts:{board:false}},{})).toContain("board");
  for(const flag of ["projectsGoals","projectsLead","projectsAutonomy"] as const) expect(startProjectReason(settings,{[flag]:false})).toBeTruthy();
});

it("P8 uses local end of day for the selected calendar date", () => {
  const form={purpose:"Report",mode:"goal" as const,members:["a"],leadBotId:"a",goalTitle:"Report",goalDescription:"",criteria:[],deadline:"2026-10-04",folder:""};
  const date=new Date(newProjectBody(form,"id").deadlineAt!);
  expect([date.getFullYear(),date.getMonth(),date.getDate(),date.getHours(),date.getMinutes(),date.getSeconds(),date.getMilliseconds()]).toEqual([2026,9,4,23,59,59,999]);
});

const ownerForm={purpose:"Purpose",mode:"goal" as const,members:["a"],leadBotId:"a",goalTitle:"Report",goalDescription:"Owner detail",criteria:[],deadline:"",folder:""};
const ownerProposal={members:["a"],leadBotId:"a",mode:"goal" as const,brief:{summary:"Summary",doneMeans:"Done",rules:"Owner rules"},budget:{minutes:45,tokens:12345},planOutline:["Edited step","Check result"]};
it("F2 persists edited First plan in the goal or brief for every mode",()=>{
  expect(newProjectBody(ownerForm,"id",ownerProposal).goal?.description).toBe("Owner detail\n\nFirst plan:\nEdited step\nCheck result");
  for(const mode of ["chat","ongoing","bots"] as const)expect(newProjectBody({...ownerForm,mode},"id",ownerProposal).brief?.rules).toBe("Owner rules\n\nFirst plan:\nEdited step\nCheck result");
  expect(newProjectBody(ownerForm,"id",{...ownerProposal,planOutline:[]}).goal?.description).toBe("Owner detail");
});
it("F2 refuses oversized combined text and plans without silently dropping owner text",()=>{
  for(const planOutline of [Array(9).fill("step"),["x".repeat(281)]])expect(()=>newProjectBody(ownerForm,"id",{...ownerProposal,planOutline})).toThrow();
  expect(()=>newProjectBody({...ownerForm,goalDescription:"x".repeat(2000)},"id",ownerProposal)).toThrow();
  expect(()=>newProjectBody({...ownerForm,goalTitle:""},"id",ownerProposal)).toThrow(/title/i);
  expect(()=>newProjectBody({...ownerForm,mode:"ongoing"},"id",{...ownerProposal,brief:{...ownerProposal.brief,rules:"x".repeat(12000)}})).toThrow();
});
it("F3 validates integer budget bounds for proposal and plain creation",()=>{
  expect(newProjectBody({...ownerForm,budgetMinutes:"45",budgetTokens:"12345"},"id").budget).toEqual(ownerProposal.budget);
  expect(newProjectBody({...ownerForm,budgetMinutes:"",budgetTokens:""},"id")).not.toHaveProperty("budget");
  expect(newProjectBody({...ownerForm,budgetMinutes:"45",budgetTokens:""},"id").budget).toEqual({minutes:45,tokens:3000000});
  for(const budget of [{minutes:0,tokens:1},{minutes:100001,tokens:1},{minutes:1.5,tokens:1},{minutes:1,tokens:0},{minutes:1,tokens:1.5},{minutes:1,tokens:Number.MAX_SAFE_INTEGER+1}])expect(()=>newProjectBody(ownerForm,"id",{...ownerProposal,budget})).toThrow();
  expect(newProjectBody(ownerForm,"id",{...ownerProposal,budget:{minutes:100000,tokens:Number.MAX_SAFE_INTEGER}}).budget).toEqual({minutes:100000,tokens:Number.MAX_SAFE_INTEGER});
});

it("C sends Start now only for a goal the owner named, and only while checked", () => {
  const form={purpose:"Purpose",mode:"goal" as const,members:["a"],leadBotId:"a",goalTitle:"Report",goalDescription:"",criteria:[],deadline:"",folder:"",startNow:true};
  expect(newProjectBody(form,"id")).toMatchObject({startGoal:true,goal:{title:"Report"}});
  expect(newProjectBody({...form,startNow:false},"id")).not.toHaveProperty("startGoal");
  expect(newProjectBody({...form,goalTitle:""},"id")).not.toHaveProperty("startGoal");
  for(const mode of ["chat","ongoing","bots"] as const)expect(newProjectBody({...form,mode},"id")).not.toHaveProperty("startGoal");
});

it("N2 the Chief's unread draft rides as the brief's rules, with the purpose as its summary", () => {
  const form={purpose:"Report ".repeat(40).trim(),mode:"chat" as const,members:["a"],leadBotId:"a",goalTitle:"",goalDescription:"",criteria:[],deadline:"",folder:"",brief:"The Chief wrote: Ada leads, Bex reviews."};
  expect(newProjectBody(form,"id").brief).toEqual({summary:form.purpose.slice(0,200),doneMeans:"",rules:"The Chief wrote: Ada leads, Bex reviews."});
  // an emptied brief sends nothing, as before
  expect(newProjectBody({...form,brief:"  "},"id")).not.toHaveProperty("brief");
  expect(()=>newProjectBody({...form,brief:"x".repeat(12001)},"id")).toThrow("12,000");
});
