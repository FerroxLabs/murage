// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import ProjectBoard from "./ProjectBoard";
import ProjectGoalView from "./ProjectGoalView";
import ProjectActivity, { ProjectActivityItem } from "./ProjectActivity";
import ProjectSinceYouLeft from "./ProjectSinceYouLeft";
import { MurageMessageRow } from "./MurageMessageRow";
import { groupActivityRuns } from "@/lib/activity-runs";
import { ProjectCardSheet } from "./ProjectCardSheet";
import type { ProjectRead, ProjectBoardRead, RoomRequest, UsageRead } from "@/lib/project-client";
import type { Group, Bot, Message } from "@/state/store";
vi.mock("@/state/store", () => ({useStore:()=>({state:{config:{features:{}},groups:[],bots:[]},dispatch:vi.fn()}),api:vi.fn()}));
vi.mock("@/lib/use-surface",()=>({useDesktopSurface:()=>true}));
const group = {id:"g",threadId:"room",memberIds:["a"]} as Group;
const members = [{id:"a",name:"Jax"}] as Bot[];
const project:ProjectRead = {lifecycle:"open",settings:{groupId:"g",mode:"ongoing",leadBotId:"a",parts:{board:true,digest:false},runState:"running",closedAt:null,endedAt:null,revision:3},goal:{id:"goal",title:"Launch",state:"awaiting_signoff",revision:7,description:"A plain description",deadlineAt:1,criteria:[{id:"crit",text:"Result checked",setBy:"lead",proposed:true,met:true,metBy:"a",evidence:{kind:"message",ref:"message",workItemId:"card",attempt:1,at:1}}]},brief:null,budgets:[{id:"budget",goalId:"goal",period:"goal",revision:1,state:"paused",maxWorkMinutes:120,maxTokens:3000000}],strip:{line:"",needsYou:0,usage:{workMs:7080000,input:2900000,output:0,tokensReported:true,charge:null}},sinceYouLeft:{messages:4,cards:2,decisions:1},revision:3};
const board:ProjectBoardRead = {lifecycle:"open",columns:[],columnsRevision:3,cards:[{id:"card",title:"Deliver result",number:12,state:"done",revision:1,goalId:"goal",deskThreadId:"desk",assigneeBotId:"a"}]};
const usage:UsageRead={lifecycle:"open",totals:project.strip.usage,byBot:[],notReported:[],budgets:project.budgets};
it("renders the goal criteria, evidence, plan, deadline, budget and sign-off controls",()=>{
 const html=renderToStaticMarkup(createElement(ProjectGoalView,{group,members,project,initialBoard:board,initialUsage:usage}));
 for(const text of ["Launch","Ready for your sign-off","Result checked","Proposed by the lead","Met by Jax","Open evidence","Deliver result","past due","1 h 58 min of 2 h","2.9M of 3.0M tokens","Limit reached: stops starting new work at your limit","Sign off","Send back"]) expect(html).toContain(text);
 expect(html).not.toMatch(/cost|spend|[$£€]/i);
});
it("offers a bounded Set a goal form with the requested defaults, hidden when goals are off",()=>{
 const props={group,members,project:{...project,goal:null}};
 const html=renderToStaticMarkup(createElement(ProjectGoalView,props));
 for(const text of ["Set a goal","Show me the plan first","Another member reviews each card",'maxLength="200"','maxLength="2000"','maxLength="300"']) expect(html).toContain(text);
 expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
 expect(renderToStaticMarkup(createElement(ProjectGoalView,{...props,goalsEnabled:false}))).not.toContain("Set a goal");
});
it.each(["closed","ended"] as const)("makes the goal read-only when %s",lifecycle=>{
 const html=renderToStaticMarkup(createElement(ProjectGoalView,{group,members,project:{...project,lifecycle},initialBoard:board,initialUsage:usage}));
 expect(html).toContain(lifecycle==="closed"?"This project is closed":"This is a channel now");expect(html).not.toContain(">Sign off<");expect(html).not.toContain(">Send back<");
});
it("renders an unknown Activity kind, exact and relative time, and flag-gated digest switch",()=>{
 const html=renderToStaticMarkup(createElement(ProjectActivityItem,{row:{id:"a",kind:"future",at:1000,actor:"owner",workItemId:null,goalId:null,requestId:null,detail:{}},cards:[],goal:null,members,now:121000}));
 for(const text of ["Project updated","You","2 min ago","title=","dateTime="]) expect(html).toContain(text);
 const props={group,members,project};
 expect(renderToStaticMarkup(createElement(ProjectActivity,props))).toContain('role="switch"');
 expect(renderToStaticMarkup(createElement(ProjectActivity,{...props,digestEnabled:false}))).not.toContain("Daily digest");
});
it("renders since-you-left counts and accessible actions, with nothing for zeros",()=>{
 const props={counts:project.sinceYouLeft,onBoard:vi.fn()};
 const html=renderToStaticMarkup(createElement(ProjectSinceYouLeft,props));
 for(const text of ["Since you left: 4 messages, 2 cards changed, 1 decision","Show board","Dismiss"]) expect(html).toContain(text);
 expect(renderToStaticMarkup(createElement(ProjectSinceYouLeft,{...props,counts:{messages:0,cards:0,decisions:0}}))).toBe("");
});
it("renders a digest-shaped activity message as Murage with no bot or tool UI",()=>{
 const message={id:"digest",role:"bot",kind:"activity",actorKind:"murage",from:{botId:"a",name:"BOT_CANARY",color:"orange"},murage:{kind:"status",digestDay:"2026-09-29"},tool:{name:"Daily digest for 29 Sep: nothing changed since yesterday.",ok:true},at:1} as Message;
 expect(groupActivityRuns([message, {...message,id:"next-digest"}]).map(item=>item.kind)).toEqual(["message","message"]);
 const html=renderToStaticMarkup(createElement(MurageMessageRow,{message,group,members}));
 expect(html).toContain(">Murage<");expect(html).toContain("Daily digest for 29 Sep");expect(html).not.toContain("BOT_CANARY");expect(html).not.toContain("room-speaker");expect(html).not.toContain("Retry");
});
it.each([undefined,"steer","queue"])("renders current run state without steering controls (%s)",steeringMode=>{
 const requests=[{id:"r",verb:"assign",state:"running",workItemId:"card",toBotId:"a",fromKind:"owner",refusalLine:null,createdAt:1,outcomeNote:null,steeringMode}] as RoomRequest[];
 const html=renderToStaticMarkup(createElement(ProjectCardSheet,{groupId:"g",card:board.cards[0],board,project,members,requests,readOnly:true,busy:false,onClose:vi.fn(),onAction:vi.fn(),onMove:vi.fn(),onGoal:vi.fn(),notice:"",refusal:""}));
 expect(html).toContain("Current run");expect(html).toContain("Card for Jax: in progress");expect(html).not.toContain("Ask now");expect(html).not.toContain("Send after this step");
});

it.each(["card_created","card_moved","card_reassigned","card_took_over","card_failed","card_result","brief_version","goal_state","criteria","decision_opened","decision_closed","budget_warned","budget_paused","budget_raised","member_error","routine_run","settings","work_roots","restore","close","reopen","deadline"])("renders the %s Activity row as plain copy",kind=>{
 const html=renderToStaticMarkup(createElement(ProjectActivityItem,{row:{id:"row",kind,at:1000,actor:"server",workItemId:"card",goalId:"goal",requestId:null,detail:{from:"doing",to:"working",version:4,text:"MODEL_CANARY"}},cards:board.cards,goal:project.goal,members,now:121000}));
 expect(html).not.toContain("Project updated");expect(html).not.toContain("MODEL_CANARY");expect(html).toContain("Murage");expect(html).not.toMatch(/cost|spend|[$£€]/i);
});
it.each(["draft","planning","awaiting_plan_ok","working","awaiting_signoff","paused","done","stopped","failed"] as const)("renders the %s goal state",state=>{
 const html=renderToStaticMarkup(createElement(ProjectGoalView,{group,members,project:{...project,goal:{...project.goal!,state}},initialBoard:board,initialUsage:usage}));
 expect(html).not.toContain("awaiting_");expect(html).toContain("Launch");
 if(["done","stopped","failed"].includes(state)){expect(html).not.toContain(">Edit criteria<");expect(html).not.toContain(">Start<");}
});

it("opens an archived plan card in the board sheet with archived cards enabled",()=>{
 const archived={...board,cards:[{...board.cards[0],state:"cancelled" as const}]};
 const html=renderToStaticMarkup(createElement(ProjectBoard,{group,members,project,initialBoard:archived,initialSelectedCardId:"card"}));
 expect(html).toContain("Card 12: Deliver result");expect(html).toContain(">Restore<");expect(html).toContain('aria-label="Archived"');
});

it("keeps both card-sheet live regions mounted before a notice arrives",()=>{
 const html=renderToStaticMarkup(createElement(ProjectCardSheet,{groupId:"g",card:board.cards[0],board,project,members,requests:[],readOnly:true,busy:false,onClose:vi.fn(),onAction:vi.fn(),onMove:vi.fn(),onGoal:vi.fn(),notice:"",refusal:""}));
 expect(html).toMatch(/<p[^>]*role="status"[^>]*><\/p>/);expect(html).toMatch(/<p[^>]*role="alert"[^>]*><\/p>/);
});
