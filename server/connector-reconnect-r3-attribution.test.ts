import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as composio from "./composio.ts";
import { connectorHealthStore } from "./connected-app-health.ts";
import type { AppConfig } from "./config.ts";
const cfg = {} as AppConfig;
let accounts: Record<string, Array<{id: string; alias?: string; status: string}>>;
let calls: any[], reads: number, completed: number, inventoryFailure: boolean;
let probe: string, reply: any, afterProbe: (() => void) | undefined, holdInventory: Promise<void> | undefined;
let clock = 10_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(async () => {
  composio.resetManagedBrokerState(); connectorHealthStore().clearAll();
  clock += 4_000_000; vi.spyOn(Date, "now").mockImplementation(() => clock);
  accounts = { gmail: [{id:"A", alias:"work", status:"ACTIVE"}] };
  calls = []; reads = 0; completed = 0; inventoryFailure = false; probe = "ok"; reply = undefined; afterProbe = undefined; holdInventory = undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return json({ready:true});
    if (url.endsWith("/connected")) {
      reads++; await holdInventory; completed++;
      return inventoryFailure ? json({error:"fixture unavailable"}, 502) : json({services: Object.fromEntries(Object.entries(accounts).map(([slug, accounts]) => [slug, {connected:true,status:"ACTIVE",accounts}]))});
    }
    const body = JSON.parse(String(init?.body)); calls.push(body); afterProbe?.();
    if (probe === "transport") throw new Error("fixture transport failure");
    if (probe === "timeout") throw new DOMException("fixture deadline", "TimeoutError");
    if (probe === "http") return json({error:"fixture unavailable"}, 502);
    const value = reply ?? (probe === "brokerAuth" ? {kind:"auth",status:401} : probe === "upstreamAuth" ? {status:401} : probe === "toolError" ? {successful:false,error:"fixture tool failure"} : {successful:true});
    return json({jsonrpc:"2.0",id:body.id,result:{isError:probe !== "ok",content:[{type:"text",text:JSON.stringify(value)}]}});
  }));
  composio.applyManagedBrokerMessage({type:"murage:managed-composio",access:null,fluxBrokerUrl:"http://127.0.0.1:49321/composio",fluxAccess:{url:"http://127.0.0.1:49321/composio",token:"c".repeat(64)},legacyUntil:"",legacyClaim:{state:"none"},accountKind:null,tokenError:null});
  await composio.primeBrokerReadiness(); await composio.connectedInventory(cfg,{force:true,fresh:true});
  reads = 0; completed = 0;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); composio.resetManagedBrokerState(); });
let id = 0;
const payload = (name: string, args: any) => ({jsonrpc:"2.0",id:++id,method:"tools/call",params:{name,arguments:args}});
const dispatch = (name = "GMAIL_FETCH_EMAILS", args: any = {account:"A"}, options: any = {}) => composio.relayConnectedAppCall(cfg,payload(name,args),undefined,undefined,{botId:"r3-fixture",...options});

import * as callsModule from "../shared/connected-app-calls.ts";
beforeEach(async()=>{accounts.gmail!.push({id:"B",alias:"home",status:"ACTIVE"}); await composio.connectedInventory(cfg,{force:true,fresh:true}); reads=0;});
const marked = () => composio.appsNeedingReconnect(cfg).flatMap(a=>a.accounts.map(a=>a.id));
it("R2a wrapped multi attributes A failure and B success separately",async()=>{
  reply={data:{results:[{index:0,tool_slug:"GMAIL_FETCH_EMAILS",status_code:401},{index:1,tool_slug:"GMAIL_FETCH_EMAILS",successful:true}]}};
  await dispatch("USE_TOOL",{tool_name:"COMPOSIO_MULTI_EXECUTE_TOOL",tool_input:{tools:[{tool_slug:"GMAIL_FETCH_EMAILS",account:"A"},{tool_slug:"GMAIL_FETCH_EMAILS",account:"B"}]}});
  expect(marked()).toEqual(["A"]); reply={successful:true}; await dispatch(undefined,{account:"B"}); expect(calls).toHaveLength(2); expect(marked()).toEqual(["A"]);
});
it("R2b direct provider preserves B account for attribution and guard",async()=>{
  probe="upstreamAuth"; await dispatch(undefined,{account:"B"}); expect(marked()).toEqual(["B"]);
  await dispatch(undefined,{account:"B"}); expect(calls).toHaveLength(1);
  probe="ok"; await dispatch(undefined,{account:"A"}); expect(calls).toHaveLength(2); expect(marked()).toEqual(["B"]);
});
it.each([["R2c",{}],["R2d",{account:"Z"}]])("%s unknown account never creates or blocks an incident",async(_row,args)=>{
  probe="upstreamAuth"; await dispatch(undefined,args); expect(marked()).toEqual([]); expect(composio.appsNeedingReconnect(cfg)).toEqual([]); expect(reads).toBe(1);
  probe="ok"; await dispatch(undefined,{account:"A"}); await dispatch(undefined,{account:"B"}); expect(calls).toHaveLength(3);
});
it("R2e six call shapes use the same normalized rows in requirements, attribution and guard",async()=>{
  const normalize=(callsModule as any).normalizedCallRows; expect(normalize).toBeTypeOf("function");
  for(const [name,args] of [
    ["GMAIL_FETCH_EMAILS",{account:"B"}], ["USE_TOOL",{toolName:"GMAIL_FETCH_EMAILS",toolInput:{account:"B"}}],
    ["COMPOSIO_MULTI_EXECUTE_TOOL",{tools:[{tool_slug:"GMAIL_FETCH_EMAILS",account:"B"}]}],
    ["USE_TOOL",{tool_name:"COMPOSIO_MULTI_EXECUTE_TOOL",tool_input:{tools:[{tool_slug:"GMAIL_FETCH_EMAILS",account:"B"}]}}],
    ["COMPOSIO_MULTI_EXECUTE_TOOL",{tools:[{toolSlug:"GMAIL_FETCH_EMAILS",account:"B"}]}],
    ["USE_TOOL",{toolName:"COMPOSIO_MULTI_EXECUTE_TOOL",toolInput:{tools:[{toolSlug:"GMAIL_FETCH_EMAILS",account:"B"}]}}],
  ] as Array<[string,any]>) {
    connectorHealthStore().clearAll(); probe="upstreamAuth"; reply={data:{results:[{index:0,tool_slug:"GMAIL_FETCH_EMAILS",status:401}]}};
    expect(normalize(name,args).rows).toEqual([{index:0,tool:"GMAIL_FETCH_EMAILS",account:"B"}]);
    expect(callsModule.connectedAppRequirements(args,name)).toEqual([{tool:"GMAIL_FETCH_EMAILS",account:"B"}]);
    const before=calls.length; await dispatch(name,args); expect(marked()).toEqual(["B"]); await dispatch(name,args); expect(calls).toHaveLength(before+1);
  }
});
it.each([false,true])("R2 duplicate account failure wins regardless of row order %s",async reverse=>{
  const args={tools:[{tool_slug:"GMAIL_FETCH_EMAILS",account:"A"},{tool_slug:"GMAIL_FETCH_EMAILS",account:"A"}]};
  const results=[{tool_slug:"GMAIL_FETCH_EMAILS",status:401},{tool_slug:"GMAIL_FETCH_EMAILS",successful:true}];
  if(reverse) results.reverse();
  reply={data:{results:results.map((r,index)=>({...r,index}))}};
  await dispatch("COMPOSIO_MULTI_EXECUTE_TOOL",args); expect(marked()).toEqual(["A"]);
});
it.each(["same","mixed","missing-index","malformed"])("R2 unattributed batch %s creates no incident",async mode=>{
  accounts.slack=[{id:"S",status:"ACTIVE"}]; await composio.connectedInventory(cfg,{force:true,fresh:true}); reads=0;
  const tools=[{tool_slug:"GMAIL_FETCH_EMAILS",account:"A"},{tool_slug:mode==="mixed"?"SLACK_TEST_AUTH":"GMAIL_FETCH_EMAILS",account:mode==="mixed"?"S":"B"}];
  probe="upstreamAuth"; reply=mode==="missing-index" ? {results:[{tool_slug:"GMAIL_FETCH_EMAILS",status:401}]} : mode==="malformed" ? {results:[{index:0,tool_slug:"GMAIL_FETCH_EMAILS",status:401}]} : {status:401};
  await dispatch(mode==="malformed"?"USE_TOOL":"COMPOSIO_MULTI_EXECUTE_TOOL",mode==="malformed"?{tool_name:"COMPOSIO_MULTI_EXECUTE_TOOL",tool_input:{tools},extra:true}:{tools});
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]); expect(reads).toBe(1);
});
