import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach,expect,it,vi } from "vitest";
import { DiagnosticDetails,incidentSelection } from "./DiagnosticDetails";
import { ProviderErrorCard } from "./ProviderErrorCard";
import { RuntimeErrorCard } from "./RuntimeErrorCard";
const turnId="00000000-0000-4000-8000-000000000001";
const minimal={version:1,diagnosticId:"ev-fixture-1",turnId};
const full={...minimal,processGeneration:"00000000-0000-4000-8000-000000000002",rpcId:0,method:"session/prompt",rpcCode:-32603,httpStatus:402,terminalKind:"api",observedKind:"http"};
const render=(diagnostic:unknown,expectedTurn:string|undefined=turnId)=>renderToStaticMarkup(createElement(DiagnosticDetails,{diagnostic,turnId:expectedTurn}));
afterEach(()=>vi.unstubAllGlobals());
it("renders only supplied allowlisted facts with terminal and observed labels separate",()=>{
 const html=render(full);for(const text of ["ev-fixture-1",turnId,"RPC request ID","session/prompt","-32603","402","Terminal error kind","Observed error kind (not terminal)","Copy diagnostic ID"])expect(html).toContain(text);
 const basic=render(minimal);expect(basic).toContain("ev-fixture-1");for(const text of ["Process generation","RPC method","HTTP status","Terminal error kind","Observed error kind"])expect(basic).not.toContain(text);
});
it("drops malformed, private, oversized and mismatched data without inventing identity",()=>{
 for(const bad of [undefined,null,{},"PRIVATE_CANARY",{...full,raw:"PRIVATE_CANARY"},{...full,diagnosticId:"PRIVATE_CANARY"},{...full,method:"private/method"},{...full,observedKind:"PRIVATE_CANARY"},{...full,rpcId:-1},{...full,httpStatus:"402"},{...full,private:"x".repeat(2000)}])expect(render(bad)).toBe("");
 expect(render(full,"00000000-0000-4000-8000-000000000003")).toBe("");expect(renderToStaticMarkup(createElement(DiagnosticDetails,{diagnostic:full}))).toBe("");
});
it("both existing cards show bound diagnostics while their legacy markup stays unchanged",()=>{
 const provider=(diagnostic?:unknown)=>renderToStaticMarkup(createElement(ProviderErrorCard,{info:{kind:"payment",httpStatus:402},diagnostic,turnId,onRetry:()=>{},onOpenProviderSettings:()=>{}}));
 const runtime=(diagnostic?:unknown,message="Internal error")=>renderToStaticMarkup(createElement(RuntimeErrorCard,{message,diagnostic,turnId,onRetry:()=>{},onOpenProviderSettings:()=>{}}));
 for(const card of [provider,runtime]){expect(card(full)).toContain("Copy diagnostic ID");expect(card()).not.toContain("Copy diagnostic ID");expect(card({...full,raw:"PRIVATE_CANARY"})).toBe(card());}
 const busy="Another thread is using this computer. Wait for it to finish.";expect(runtime(undefined,busy)).toContain("Wait for the other thread");expect(runtime(undefined,busy)).not.toContain("Diagnostic");expect(runtime({...full,raw:"PRIVATE_CANARY"},busy)).toBe(runtime(undefined,busy));
});
it("incident export selection contains only validated saved opaque IDs",()=>{
 const incident={threadId:"thread-fixture",messageId:"message-fixture"};expect(incidentSelection(full,turnId,incident)).toEqual({...incident,diagnosticId:"ev-fixture-1"});
 for(const bad of [undefined,{threadId:"",messageId:"message-fixture"},{threadId:"../PRIVATE_PATH",messageId:"message-fixture"},{threadId:"thread-fixture",messageId:"x".repeat(129)}])expect(incidentSelection(full,turnId,bad)).toBeUndefined();
 expect(incidentSelection({...full,raw:"PRIVATE_CANARY"},turnId,incident)).toBeUndefined();expect(incidentSelection(full,undefined,incident)).toBeUndefined();
});
it("export affordance requires valid saved identity plus native bridge and never calls it at render",()=>{
 const exportDiagnostics=vi.fn();const incident={threadId:"thread-fixture",messageId:"message-fixture"};
 const markup=(selection:typeof incident|undefined=incident)=>renderToStaticMarkup(createElement(DiagnosticDetails,{diagnostic:full,turnId,incident:selection}));
 vi.stubGlobal("window",{});expect(markup()).not.toContain("Export this incident");vi.stubGlobal("window",{muragebox:{exportDiagnostics}});expect(markup()).toContain("Export this incident");expect(render(full)).not.toContain("Export this incident");expect(markup({threadId:"../private",messageId:"message-fixture"})).not.toContain("Export this incident");expect(exportDiagnostics).not.toHaveBeenCalled();expect(render(full)).toContain("Copy diagnostic ID");
});
