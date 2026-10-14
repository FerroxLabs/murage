// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement,Children,isValidElement,type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect,it,vi } from "vitest";
import { MemorySectionContent } from "./MemorySection";
import { learningStatusLine,requestLearningAction,type MemoryLearning } from "@/lib/memory-learning";
const learning:MemoryLearning={revision:4,settings:{version:2,automaticFacts:true,automaticProcedures:true,reviewMode:false,perCallOutputTokens:{extraction:2000,grounding:64,reflection:8000},dailyInputTokens:400000,dailyOutputTokens:60000,callsPerMinute:6,learnFrom:{chats:true,channels:true},botsPaused:[]},connection:{instanceId:"@murage/flux-fast",source:"default",label:"Flux Router · Fast"},allowance:{day:"2026-09-29",inputUsed:10,outputUsed:20,usedPercent:1},defaultOn:false};
const event={id:"event",kind:"activated",record_id:"fact",record_version:1,created_at:1,undone_at:null,kept_at:null,record:{id:"fact",version:1,state:"active",text:null},scopeLabel:"Workspace",source:{threadId:"thread",messageId:"message",botName:"Ember",roomName:null}};
const props=()=>({status:{mode:"active" as const,learning,configuration:{extractorInstanceId:null},extractors:[{instanceId:"@murage/flux-fast",label:"Flux Router · Fast",eligible:true},{instanceId:"native",label:"Native sign-in",eligible:false,reason:"This connection does not provide text-only learning."}]},bots:[{id:"bot",name:"Ember"}],events:[event],cursor:"next",filter:"",busy:false,historyBusy:false,refusals:{},onAction:vi.fn(),onFilter:vi.fn(),onMore:vi.fn(),onOpen:vi.fn(),onRefresh:vi.fn(),workspace:createElement("section",{"aria-label":"Workspace memory"},"Search memory")});
it("renders four ordered sections, labelled switches, allowance and disabled reasons",()=>{
 const html=renderToStaticMarkup(createElement(MemorySectionContent,props()));
 for(const label of ["Learning","Bots","What it learned","Workspace memory"])expect(html).toContain(label);
 expect(html.indexOf('aria-label="Learning"')).toBeLessThan(html.indexOf('aria-label="Bots"'));
 expect(html).toContain('role="switch"');expect(html).toContain('aria-checked="true"');expect(html).toContain('aria-label="Learning allowance"');expect(html).toContain("Today: 1% of the learning allowance used");expect(html).toContain("10 of 400,000 input tokens");expect(html).toContain("20 of 60,000 output tokens");expect(html).toContain("Input is estimated when the connection does not report usage.");
 expect(html).toContain('value="native" disabled=""');expect(html).toContain("Native sign-in: This connection does not provide text-only learning.");
 expect(html).toContain('aria-label="Learning history"');expect(html).toContain("Removed");expect(html).toContain("From your chat with Ember");expect(html).toContain("Show more");
});
it("renders room provenance and disables Undo with a server refusal",()=>{
 const p=props();const html=renderToStaticMarkup(createElement(MemorySectionContent,{...p,refusals:{event:"This memory changed since it was learned."},events:[{...event,source:{...event.source,roomName:"Launch room"}}]}));
 expect(html).toContain("From Launch room");expect(html).toContain("This memory changed since it was learned.");expect(html).toMatch(/disabled=""[^>]*>Undo/);
});
function nodes(node:ReactNode):Array<{[key:string]:unknown}>{return Children.toArray(node).flatMap(child=>isValidElement<{children?:ReactNode}>(child)?[child.props,...nodes(child.props.children)]:[]);}
it("wires the bot switch, Keep and Undo to revision-aware actions and opens source messages",()=>{
 const p=props(),tree=MemorySectionContent(p),all=nodes(tree);
 const click=(label:string)=>{const button=all.find(n=>n['aria-label']===label||n.children===label);expect(button).toBeTruthy();(button!.onClick as ()=>void)();};
 click("Learn from our chats with Ember");expect(p.onAction).toHaveBeenCalledWith({action:"learning-bot",botId:"bot",enabled:false,learningRevision:4});
 click("Keep");expect(p.onAction).toHaveBeenCalledWith({action:"learning-keep",eventId:"event"});click("Undo");expect(p.onAction).toHaveBeenCalledWith({action:"learning-undo",eventId:"event"});
 const link=all.find(n=>typeof n.href==='string');(link!.onClick as (e:{preventDefault():void})=>void)({preventDefault(){}});expect(p.onOpen).toHaveBeenCalledWith(event.source);
});
it("reports review defaults, unavailable connections and paused memory truthfully",()=>{
 expect(learningStatusLine("active",learning)).toBe("Learning is on. Memories that need your yes wait in Needs you.");expect(learningStatusLine("active",{...learning,defaultOn:true})).toBe("Learning is on. Uses Flux Fast.");
 expect(learningStatusLine("off",learning)).toContain("Learning is paused");expect(learningStatusLine("active",{...learning,connection:{instanceId:null,label:"No connection",source:"none"}})).toBe("Learning is paused: add your Flux key or choose a connection.");
 const reason="Learning is paused: the connection was refused. Check your key in Settings.";expect(learningStatusLine("active",{...learning,connection:{instanceId:null,label:"Flux",source:"none",reason}})).toBe(reason);
});
it("posts only the selected owner action and v2 settings",async()=>{
 const request=vi.fn().mockResolvedValue({ok:true});const action={action:"configure" as const,learning:{learnFrom:{chats:false,channels:true}},learningRevision:4};
 await requestLearningAction(request,action);expect(request).toHaveBeenCalledWith("/api/memory/action",{method:"POST",body:JSON.stringify(action)});
});

it.each([true,false])("shows one default Flux Fast choice with key available=%s",eligible=>{
 const p=props();p.status.extractors[0].eligible=eligible;
 const options=nodes(MemorySectionContent(p)).filter(n=>typeof n.children==="string"&&n.children.includes("Flux Fast"));
 expect(options).toHaveLength(1);expect(options[0].value).toBe("");expect(options[0].children).toBe(eligible?"Flux Fast (default)":"Flux Fast (default, add your key)");
});
