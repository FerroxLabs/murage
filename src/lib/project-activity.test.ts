// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it } from "vitest";
import { activityLine, activityActor, activityTime, mergeActivity, sinceYouLeftLine, nextActivityPage } from "./project-activity";
import type { ProjectActivityRow } from "./project-client";
const row = (kind:string,detail:Record<string,unknown>={}):ProjectActivityRow=>({id:kind,kind,detail,at:1000,actor:"owner",workItemId:"c",goalId:null,requestId:null});
const cards = [{id:"c",number:12,title:"Title",state:"doing" as const,revision:1}];
const cases = {
  card_created:"Card 12 'Title' was added",card_moved:"Card 12 moved from In progress to Waiting",card_reassigned:"Card 12 was reassigned",card_took_over:"Card 12 was taken over by you",card_failed:"Card 12 failed",card_result:"Card 12 has a result",brief_version:"The brief changed (version 4)",goal_state:"The goal is now Working",criteria:"A done criterion changed",decision_opened:"A decision needs you",decision_closed:"A decision was resolved",budget_warned:"Usage reached the warning level",budget_paused:"Limit reached: new work is paused",budget_raised:"The usage limit was raised",member_error:"A teammate could not continue",routine_run:"A routine ran",settings:"Project settings changed",work_roots:"Work folders changed",restore:"The project was restored",close:"The project was closed",reopen:"The project was reopened",deadline:"The deadline was reached",future_kind:"Project updated"
};
it.each(Object.entries(cases))("renders %s using only structured fields and current titles", (kind,line)=> {
  expect(activityLine(row(kind,{from:"doing",to:kind==="goal_state"?"working":"waiting",version:4,text:"MODEL_CANARY"}),cards,null)).toBe(line);
});
it("does not echo unknown state values or arbitrary detail text",()=>{
  expect(activityLine(row("goal_state",{to:"MODEL_CANARY"}),[],null)).toBe("The goal changed");
  expect(activityLine(row("constructor"),[],null)).toBe("Project updated");
  expect(activityLine(row("goal_state",{to:"constructor"}),[],null)).toBe("The goal changed");
  expect(activityLine(row("card_created"),[],null)).toBe("A card was added");
  expect(activityActor("owner",[])).toBe("You");expect(activityActor("server",[])).toBe("Murage");expect(activityActor("a",[{id:"a",name:"Jax"}])).toBe("Jax");expect(activityActor("missing",[])).toBe("A teammate");
  expect(activityTime(1000,121000)).toBe("2 min ago");
});
it("merges paging without duplicates and captures only nonzero count words",()=>{
  expect(mergeActivity([row("a"),row("b")],[row("b"),row("c")]).map(r=>r.id)).toEqual(["a","b","c"]);
  expect(sinceYouLeftLine({messages:4,cards:2,decisions:1})).toBe("Since you left: 4 messages, 2 cards changed, 1 decision");
  expect(sinceYouLeftLine({messages:0,cards:0,decisions:0})).toBe("");
  expect(sinceYouLeftLine({messages:1,cards:1,decisions:0})).toBe("Since you left: 1 message, 1 card changed");
});

it("pages inclusively at the last millisecond and expands a tied page without skipping",()=>{
 const page=Array.from({length:30},(_,i)=>({...row(String(i)),at:i<29?2000:1000}));
 expect(nextActivityPage(page,30)).toEqual({before:1001,limit:30,blocked:false});
 const tied=page.map(r=>({...r,at:1000}));
 expect(nextActivityPage(tied,30)).toEqual({before:1001,limit:60,blocked:false});
 expect(nextActivityPage(Array.from({length:100},(_,i)=>({...row(String(i)),at:1000})),100)).toEqual({blocked:true});
 expect(nextActivityPage([],30)).toBeNull();
 expect(mergeActivity(page,[page[29],{...row("boundary-extra"),at:1000},{...row("older"),at:999}]).map(r=>r.id).slice(-3)).toEqual(["29","boundary-extra","older"]);
});
