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
      reads++; const snapshot=structuredClone(accounts); await holdInventory; completed++;
      return inventoryFailure ? json({error:"fixture unavailable"}, 502) : json({services: Object.fromEntries(Object.entries(snapshot).map(([slug, accounts]) => [slug, {connected:true,status:"ACTIVE",accounts}]))});
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); composio.resetManagedBrokerState(); });
let id = 0;
const payload = (name: string, args: any) => ({jsonrpc:"2.0",id:++id,method:"tools/call",params:{name,arguments:args}});
const dispatch = (name = "GMAIL_FETCH_EMAILS", args: any = {account:"A"}, options: any = {}) => composio.relayConnectedAppCall(cfg,payload(name,args),undefined,undefined,{botId:"r3-fixture",...options});

import { readFileSync } from "node:fs";
const check = () => composio.checkIdleConnectorHealth(cfg,["gmail"]);
const card = async () => (await composio.connectedServices(cfg)).gmail!.accounts[0] as any;
async function incident() { probe="upstreamAuth"; await dispatch(); probe="ok"; reads=0; completed=0; }
it.each([["R1a","transport"],["R1b","http"]])("%s failed probe still awaits EXPIRED inventory", async (_row, mode) => {
  probe=mode!; afterProbe=()=>{accounts.gmail![0]!.status="EXPIRED";}; await check();
  expect(composio.appsNeedingReconnect(cfg)[0]?.accounts).toEqual([{id:"A",alias:"work"}]); expect(reads).toBe(1);
});
it.each([["R1c","timeout"],["R1d","toolError"]])("%s ACTIVE uncertainty is unverified", async (_row,mode) => {
  probe=mode!; await check(); expect((await card()).checkState).toBe("unverified"); expect(composio.appsNeedingReconnect(cfg)).toEqual([]); expect(reads).toBe(1);
});
it("R1e success re-reads ACTIVE, clears only that account and its unverified state", async()=>{
  await incident(); await check(); expect(reads).toBe(1); expect(composio.appsNeedingReconnect(cfg)).toEqual([]); expect((await card()).checkState).toBeUndefined();
});
it("R1f failed inventory retains incident and renders unverified copy", async()=>{
  await incident(); const before=composio.reconnectIncidents(cfg)[0]!.incidentId;
  afterProbe=()=>{inventoryFailure=true;}; await check();
  expect((await card()).checkState).toBe("unverified"); expect(composio.reconnectIncidents(cfg)[0]?.incidentId).toBe(before);
  const panel=readFileSync(new URL("../src/components/PluginsPanel.tsx",import.meta.url),"utf8");
  expect(panel).toContain('t("connectorHealth.unverified", { app: card.label })');
  expect(panel).toContain('!unverified && <Check');
  const en=JSON.parse(readFileSync(new URL("../src/locales/en.json",import.meta.url),"utf8"));
  expect(en["connectorHealth.unverified"]).toBe("Murage could not check {app} just now. It will try again.");
});
it("R1g Flux kind=auth is an outage and still re-reads inventory",async()=>{
  probe="brokerAuth"; await check(); expect(composio.appsNeedingReconnect(cfg)).toEqual([]); expect(reads).toBe(1); expect(completed).toBe(1);
});
it.each(["transport","http","brokerAuth","upstreamAuth","toolError","ok"])("R1h exactly one awaited inventory GET after %s",async mode=>{
  probe=mode; let release!:()=>void; let resolved=false;
  afterProbe=()=>{holdInventory=new Promise<void>(resolve=>{release=resolve;});};
  const checking=check().then(()=>{resolved=true;});
  try { await vi.waitFor(()=>expect(reads).toBe(1)); expect(completed).toBe(0); expect(resolved).toBe(false); }
  finally { release?.(); await checking; }
  expect(completed).toBe(1); expect(reads).toBe(1);
});
it("R1 unknown keeps an existing incident; alias change preserves unverified",async()=>{
  await incident(); probe="toolError"; await check(); expect(composio.appsNeedingReconnect(cfg)).toHaveLength(1); expect((await card()).checkState).toBe("unverified");
  accounts.gmail![0]!.alias="changed"; await composio.connectedInventory(cfg,{force:true,fresh:true}); expect((await card()).checkState).toBe("unverified");
});

it("R1 removal between probe and refresh blocks that ID on scheduled dispatch",async()=>{
  accounts.gmail!.push({id:"B",status:"ACTIVE"}); await composio.connectedInventory(cfg,{force:true,fresh:true});
  afterProbe=()=>{accounts.gmail=accounts.gmail!.filter(a=>a.id!=="A");}; await check(); afterProbe=undefined;
  expect(composio.appsNeedingReconnect(cfg)[0]?.accounts.map(a=>a.id)).toEqual(["A"]);
  const count=calls.length; await dispatch(undefined,{account:"A"},{scheduled:true}); expect(calls).toHaveLength(count);
  await dispatch(undefined,{account:"B"},{scheduled:true}); expect(calls.length).toBeGreaterThan(count);
});
it.each([false,true])("R1h held pre-probe ACTIVE fetch (fresh=%s) cannot replace post-probe EXPIRED inventory",async fresh=>{
  let release!:()=>void; holdInventory=new Promise<void>(r=>{release=r;});
  const old=composio.connectedInventory(cfg,{force:true,fresh}).catch(()=>undefined);
  await vi.waitFor(()=>expect(reads).toBe(1));
  probe="transport"; afterProbe=()=>{accounts.gmail![0]!.status="EXPIRED";holdInventory=undefined;};
  // Cached inventory lets the probe start while the older fetch remains pending.
  const checking=check();
  try { await vi.waitFor(()=>expect(reads).toBe(2)); await checking; } finally { release(); await old; await checking; }
  expect(composio.appsNeedingReconnect(cfg)[0]?.accounts.map(a=>a.id)).toEqual(["A"]);
});
it("R3d preflight response.error.status 403 with ACTIVE creates an incident",async()=>{
  reply={results:[{index:0,tool_slug:"GMAIL_GET_PROFILE",response:{error:{status:"403"}}}]}; await check();
  expect(composio.appsNeedingReconnect(cfg)[0]?.accounts.map(a=>a.id)).toEqual(["A"]);
});
it("R3e row-level Flux auth never creates an incident",async()=>{
  reply={data:{results:[{index:0,tool_slug:"GMAIL_GET_PROFILE",successful:false,kind:"auth",status:401}]}}; await check();
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]); expect(reads).toBe(1);
});

it("R1f late timed-out inventory cannot clear or create incidents",async()=>{
  await incident(); const before=composio.reconnectIncidents(cfg)[0]!.incidentId;
  let release!:()=>void;
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  afterProbe=()=>{accounts.gmail![0]!.status="EXPIRED";holdInventory=new Promise<void>(r=>{release=r;});};
  const checking=check(); await vi.advanceTimersByTimeAsync(0);
  expect(reads).toBe(1); await vi.advanceTimersByTimeAsync(5_001); await checking;
  expect((await card()).checkState).toBe("unverified");
  expect(composio.reconnectIncidents(cfg)[0]?.incidentId).toBe(before);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect((await card()).status).toBe("ACTIVE"); expect((await card()).checkState).toBe("unverified");
  expect(composio.reconnectIncidents(cfg)[0]?.incidentId).toBe(before);
});
it("R1 durable unknown survives reopening and a status change clears it",async()=>{
  probe="toolError"; await check();
  const {ConnectorHealthStore}=await import("./connector-health-store.ts"); const {DATA_DIR}=await import("./config.ts");
  const reopened=new ConnectorHealthStore(`${DATA_DIR}/connector-health.json`);
  expect(reopened.unverified).toBeDefined(); expect(Object.keys(reopened.unverified)).toHaveLength(1);
  accounts.gmail![0]!.status="EXPIRED"; await composio.connectedInventory(cfg,{force:true,fresh:true});
  expect((await card()).checkState).toBeUndefined(); expect((await card()).needsReconnect).toBe(true);
});

it("R1e healthy recovery clears a durable unknown check",async()=>{
  probe="toolError";await check();expect((await card()).checkState).toBe("unverified");
  clock+=4_000_000;probe="ok";await check();expect((await card()).checkState).toBeUndefined();
});
it.each(["kind","response-kind","error-kind","response-error-kind"])("R3e broker auth row envelope %s is an outage",async mode=>{
  const inner={kind:"auth",status:401};
  const row=mode==="kind"?inner:mode==="response-kind"?{response:inner}:mode==="error-kind"?{error:inner}:{response:{error:inner}};
  reply={data:{results:[{index:0,tool_slug:"GMAIL_GET_PROFILE",successful:false,...row}]}};await check();
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]);expect(reads).toBe(1);
});

it("R3 broker diagnostic in a failed row only suppresses reconnect",async()=>{
  reply={results:[{index:0,tool_slug:"GMAIL_GET_PROFILE",successful:false,status:401,error:"Connected-apps provider rejected FluxRouter's credentials"}]};await check();
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]);expect(reads).toBe(1);
});

// Fix-round regressions from BLOCK 1 and 2. All broker replies remain synthetic.
it.each(["kind", "response", "error", "response.error"])("R3e B1 array broker auth at %s is an outage", async envelope => {
  const auth = { kind: "auth", status: 401 };
  const fields = envelope === "kind" ? auth : envelope === "response.error"
    ? { response: { error: auth } } : { [envelope]: auth };
  reply = [{ index: 0, tool_slug: "GMAIL_GET_PROFILE", ...fields }];
  await check();
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]);
  expect(reads).toBe(1);
});

it.each([
  ["empty array", []],
  ["empty results", { successful: true, results: [] }],
  ["empty data results", { successful: true, data: { results: [] } }],
  ["foreign array", [{ index: 0, tool_slug: "SLACK_TEST_AUTH", successful: true }]],
  ["foreign results", { successful: true, results: [{ index: 0, tool_slug: "SLACK_TEST_AUTH", successful: true }] }],
  ["foreign direct row", { index: 0, tool_slug: "SLACK_TEST_AUTH", successful: true }],
])("R1e B2 %s cannot recover a confirmed incident", async (_shape, value) => {
  await incident();
  const before = composio.reconnectIncidents(cfg)[0]!.incidentId;
  reply = value;
  await check();
  expect(composio.reconnectIncidents(cfg)[0]?.incidentId).toBe(before);
  expect((await card()).checkState).toBe("unverified");
  expect(reads).toBe(1);
  // A later matching, successful result is the evidence that permits recovery.
  clock += 4_000_000;
  reply = [{ index: 0, tool_slug: "GMAIL_GET_PROFILE", successful: true }];
  await check();
  expect(composio.appsNeedingReconnect(cfg)).toEqual([]);
  expect((await card()).checkState).toBeUndefined();
});
