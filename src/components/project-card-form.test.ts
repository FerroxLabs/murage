// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { type ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectCardForm } from "./ProjectBoardForms";
import type { ProjectRead } from "@/lib/project-client";
const hooks=vi.hoisted(()=>({values:[] as unknown[],cursor:0}));
vi.mock("react",async original=>({...await original<typeof import("react")>(),useRef:(value:unknown)=>({current:value}),useState:(initial:unknown)=>{const index=hooks.cursor++;if(!(index in hooks.values))hooks.values[index]=typeof initial==="function"?initial():initial;return [hooks.values[index],(value:unknown)=>{hooks.values[index]=value;}];}}));
vi.mock("@/state/store",()=>({api:vi.fn()}));
beforeEach(()=>vi.stubEnv("TZ","Asia/Bangkok"));
afterEach(()=>{hooks.values=[];hooks.cursor=0;vi.unstubAllEnvs();});
type Element=ReactElement<{children?: Element | Element[];type?:string;value?:string;onChange?:(e:{target:{value:string}})=>void;onSubmit?:(e:{preventDefault:()=>void})=>void}>;
function elements(node:Element):Element[]{return [node,...[node.props.children].flat().filter((child):child is Element=>!!child&&typeof child==="object"&&"props" in child).flatMap(elements)];}
function fixture(){
 const dueAt=new Date(2026,8,30,0,30).getTime();
 const onEdit=vi.fn().mockResolvedValue(true);
 const props={groupId:"g",project:{settings:{parts:{}}} as ProjectRead,board:{lifecycle:"open" as const,columns:[],columnsRevision:1,cards:[]},members:[],card:{id:"c",title:"Work",state:"todo" as const,revision:1,dueAt},onEdit,onClose:vi.fn(),onSaved:vi.fn(),onNotice:vi.fn()};
 const render=()=>{hooks.cursor=0;return elements(ProjectCardForm(props) as Element);};
 return {dueAt,onEdit,render};
}
it("initializes the due date from the local calendar across a UTC day boundary",()=>{
 const f=fixture();expect(new Date(f.dueAt).toISOString().slice(0,10)).toBe("2026-09-29");
 expect(f.render().find(e=>e.props.type==="date")?.props.value).toBe("2026-09-30");
});
it("a title-only save omits dueAt and preserves the existing timestamp",async()=>{
 const f=fixture();f.render().find(e=>e.type==="input"&&e.props.value==="Work")!.props.onChange!({target:{value:"Renamed"}});
 f.render().find(e=>e.type==="form")!.props.onSubmit!({preventDefault:vi.fn()});await Promise.resolve();
 expect(f.onEdit).toHaveBeenCalledWith(expect.objectContaining({title:"Renamed"}));expect(f.onEdit.mock.calls[0][0]).not.toHaveProperty("dueAt");
});
it.each(["2026-10-01", ""])("saves a changed due date %s as local noon or clears it",async(value)=>{
 const f=fixture();f.render().find(e=>e.props.type==="date")!.props.onChange!({target:{value}});
 f.render().find(e=>e.type==="form")!.props.onSubmit!({preventDefault:vi.fn()});await Promise.resolve();
 expect(f.onEdit.mock.calls[0][0].dueAt).toBe(value?new Date(2026,9,1,12).getTime():null);
});
