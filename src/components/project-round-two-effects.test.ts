// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { readFileSync } from "node:fs";
import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import ProjectGoalView from "./ProjectGoalView";
import ProjectActivity from "./ProjectActivity";
import { projectClient } from "@/lib/use-project";
import { projectEvents } from "@/lib/project-events";
import type { ProjectRead, ProjectBoardRead, ProjectResult } from "@/lib/project-client";
import type { Group } from "@/state/store";
const fixture = vi.hoisted(() => ({ refs: [] as Array<{current:unknown}>, effects: [] as EffectCallback[], setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useRef: (initial:unknown) => { const ref={current:initial}; fixture.refs.push(ref); return ref; }, useEffect: (effect: EffectCallback) => fixture.effects.push(effect), useState: (initial: unknown) => { const set = vi.fn(); fixture.setters.push(set); return [typeof initial === "function" ? initial() : initial, set]; } }));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: { config: { features: {} }, groups: [], bots: [] }, dispatch: vi.fn() }) }));
vi.mock("@/lib/use-surface", () => ({ useDesktopSurface: () => true }));
const project: ProjectRead = { lifecycle: "open", settings: {groupId:"g",mode:"ongoing",leadBotId:null,parts:{},runState:"running",closedAt:null,endedAt:null,revision:1},goal:{id:"goal",title:"Launch",state:"working",revision:1},brief:null,budgets:[],strip:{line:"",needsYou:0,usage:{workMs:0,input:0,output:0,tokensReported:false,charge:null}},sinceYouLeft:{messages:0,cards:0,decisions:0},revision:1 };
const group = { id: "g" } as Group;
const board: ProjectBoardRead = { lifecycle:"open",columns:[],columnsRevision:1,cards:[] };
const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); fixture.refs.length = 0; fixture.effects.length = 0; fixture.setters.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); });
function mount(Component: typeof ProjectGoalView | typeof ProjectActivity) {
 renderToStaticMarkup(createElement(Component, {group,members:[],project}));
 const stop=fixture.effects[0](); if(typeof stop==="function")stops.push(stop);
}
it("goal plan and usage load independently and refetch on their frames and replay gaps",async()=>{
 vi.useFakeTimers();vi.spyOn(projectClient,"board").mockResolvedValue({ok:true,data:board});vi.spyOn(projectClient,"usage").mockResolvedValue({ok:true,data:{lifecycle:"open",totals:project.strip.usage,notReported:[],byBot:[],budgets:[]}});
 mount(ProjectGoalView);await vi.advanceTimersByTimeAsync(0);
 expect(projectClient.board).toHaveBeenCalledWith("g",{goal:"goal",archived:true});expect(projectClient.usage).toHaveBeenCalledWith("g",{goal:"goal"});
 projectEvents.frame({kind:"project.board",groupId:"g",cards:[],columnsRevision:2});await vi.advanceTimersByTimeAsync(250);
 expect(projectClient.board).toHaveBeenCalledTimes(2);expect(projectClient.usage).toHaveBeenCalledTimes(1);
 projectEvents.frame({kind:"project.strip",groupId:"g"});await vi.advanceTimersByTimeAsync(250);expect(projectClient.usage).toHaveBeenCalledTimes(2);
 projectEvents.replayGap();await vi.advanceTimersByTimeAsync(0);expect(projectClient.board).toHaveBeenCalledTimes(3);expect(projectClient.usage).toHaveBeenCalledTimes(3);
 stops.pop()!();projectEvents.replayGap();expect(projectClient.board).toHaveBeenCalledTimes(3);
});
it("Activity refetches on strip and gap, and refreshes card titles on board frames",async()=>{
 vi.useFakeTimers();vi.spyOn(projectClient,"board").mockResolvedValue({ok:true,data:board});vi.spyOn(projectClient,"activity").mockResolvedValue({ok:true,data:{lifecycle:"open",items:[]}});
 mount(ProjectActivity);await vi.advanceTimersByTimeAsync(0);expect(projectClient.activity).toHaveBeenCalledWith("g",{before:undefined,limit:30});
 projectEvents.frame({kind:"project.strip",groupId:"g"});await vi.advanceTimersByTimeAsync(250);expect(projectClient.activity).toHaveBeenCalledTimes(2);
 projectEvents.frame({kind:"project.board",groupId:"g",cards:[],columnsRevision:2});await vi.advanceTimersByTimeAsync(250);expect(projectClient.board).toHaveBeenCalledTimes(2);
 projectEvents.replayGap();await vi.advanceTimersByTimeAsync(0);expect(projectClient.activity).toHaveBeenCalledTimes(3);expect(projectClient.board).toHaveBeenCalledTimes(3);
 stops.pop()!();projectEvents.replayGap();expect(projectClient.activity).toHaveBeenCalledTimes(3);
});
it("a late plan response cannot overwrite a newer response or update after unmount",async()=>{
 let resolve!: (value:ProjectResult<ProjectBoardRead>)=>void;
 vi.spyOn(projectClient,"board").mockReturnValueOnce(new Promise(done=>{resolve=done;})).mockResolvedValue({ok:true,data:{...board,columnsRevision:2}});
 vi.spyOn(projectClient,"usage").mockResolvedValue({ok:true,data:{lifecycle:"open",totals:project.strip.usage,notReported:[],byBot:[],budgets:[]}});
 mount(ProjectGoalView);projectEvents.replayGap();await Promise.resolve();
 resolve({ok:true,data:board});await Promise.resolve();
 expect(fixture.setters[0]).toHaveBeenLastCalledWith({...board,columnsRevision:2});
 const count=fixture.setters[0].mock.calls.length;stops.pop()!();projectEvents.replayGap();await Promise.resolve();expect(fixture.setters[0]).toHaveBeenCalledTimes(count);
});

it("Activity refresh resets rows and cursor together after more than one new page",async()=>{
 vi.spyOn(projectClient,"board").mockResolvedValue({ok:true,data:board});
 const rows=Array.from({length:70},(_,i)=>({id:String(100-i),at:100-i,kind:"settings",actor:"owner",workItemId:null,goalId:null,requestId:null,detail:{}}));
 vi.spyOn(projectClient,"activity").mockResolvedValueOnce({ok:true,data:{lifecycle:"open",items:rows.slice(40)}}).mockResolvedValue({ok:true,data:{lifecycle:"open",items:rows.slice(0,30)}});
 mount(ProjectActivity);await Promise.resolve();projectEvents.replayGap();await Promise.resolve();
 const update=fixture.setters[0].mock.calls.at(-1)![0];
 expect(typeof update === "function" ? update(rows.slice(40)) : update).toEqual(rows.slice(0,30));
 expect(fixture.setters[2]).toHaveBeenLastCalledWith(true);
 // The cursor must now lead into the intervening 10 rows, not the old tail.
 expect(fixture.refs.some(ref => (ref.current as {before?:number})?.before === 72)).toBe(true);
});

it("a room evidence jump reveals Chat before focusing the exact message",()=>{
 const source=readFileSync(new URL("./GroupView.tsx",import.meta.url),"utf8");
 const effect=source.match(/useEffect\(\(\) => \{\n    const focus = state.focusMessage;([\s\S]*?)\n  \}, \[/)![1];
 const choose=vi.fn(),window=vi.fn();
 const invoke=new Function("focus","group","appliedFocus","focusWindowRange","setBottomFollow","setTranscriptWindow","transcriptKey","asLiveTail","chooseProjectTab","revealedFocus","roomMessages",effect);
 invoke({threadId:"room",messageId:"evidence",nonce:1,consumed:false},{threadId:"room",messages:[{id:"evidence"}]},{current:null},()=>({start:0}),vi.fn(),window,"room",(range:unknown)=>range,choose,{current:null},[{id:"evidence"}]);
 expect(choose).toHaveBeenCalledWith("chat");expect(window).toHaveBeenCalled();
});

it("an overlapping Activity refresh keeps older rows and their paging cursor",async()=>{
 vi.spyOn(projectClient,"board").mockResolvedValue({ok:true,data:board});
 const rows=Array.from({length:70},(_,i)=>({id:String(100-i),at:100-i,kind:"settings",actor:"owner",workItemId:null,goalId:null,requestId:null,detail:{}}));
 const held=rows.slice(20,50);
 vi.spyOn(projectClient,"activity").mockResolvedValueOnce({ok:true,data:{lifecycle:"open",items:held}}).mockResolvedValue({ok:true,data:{lifecycle:"open",items:rows.slice(0,30)}});
 mount(ProjectActivity);await Promise.resolve();
 const cursor=fixture.refs.find(ref=>(ref.current as {before?:number})?.before===52)!;
 expect(cursor).toBeDefined();const previous=cursor.current;
 projectEvents.replayGap();await Promise.resolve();
 const update=fixture.setters[0].mock.calls.at(-1)![0];
 expect(typeof update === "function" ? update(held) : update).toEqual(rows.slice(0,50));
 expect(cursor.current).toBe(previous);
 expect(fixture.setters[2]).toHaveBeenLastCalledWith(true);
});
it("a pending evidence focus reveals Chat only once per nonce across message updates",()=>{
 const source=readFileSync(new URL("./GroupView.tsx",import.meta.url),"utf8");
 const effect=source.match(/useEffect\(\(\) => \{\n    const focus = state.focusMessage;([\s\S]*?)\n  \}, \[/)![1];
 const choose=vi.fn(),window=vi.fn(),applied={current:null},revealed={current:null};
 const invoke=new Function("focus","group","appliedFocus","focusWindowRange","setBottomFollow","setTranscriptWindow","transcriptKey","asLiveTail","chooseProjectTab","revealedFocus","roomMessages",effect);
 const run=(nonce:number,messages:Array<{id:string}>)=>invoke({threadId:"room",messageId:"evidence",nonce,consumed:false},{threadId:"room",messages},applied,()=>({start:0}),vi.fn(),window,"room",(range:unknown)=>range,choose,revealed,messages);
 run(1,[]);expect(choose).toHaveBeenCalledTimes(1);expect(window).not.toHaveBeenCalled();
 // The owner returns to Board while the evidence message is still loading.
 run(1,[{id:"other"}]);expect(choose).toHaveBeenCalledTimes(1);
 run(1,[{id:"evidence"}]);expect(choose).toHaveBeenCalledTimes(1);expect(window).toHaveBeenCalledTimes(1);
 run(2,[]);expect(choose).toHaveBeenCalledTimes(2);
});
