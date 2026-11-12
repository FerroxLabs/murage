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

import { readFileSync } from "node:fs";
import * as safeReads from "../shared/connector-safe-reads.ts";
let routinesList: any[];
beforeEach(()=>{routinesList=[];});
// Execute the production monitor's scheduling block, with only routine and notification collaborators faked.
async function tick() {
  const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
  const start=source.indexOf("function scheduledToolkits(");
  const monitor=source.slice(source.indexOf("async function checkConnectorHealth()"),source.indexOf("let stopConnectorHealthMonitor:"));
  const helper=start<0 ? "" : source.slice(start,source.indexOf("/** The workspace owner",start));
  const {stripTypeScriptTypes}=await import("node:module");
  const js=stripTypeScriptTypes(helper+monitor,{mode:"strip"});
  const preflights: Array<readonly string[] | undefined> = [];
  await new Function("composio","cfg","connectorHealthStore","routines","store","PREFLIGHT_LOOKAHEAD_MS",js+"; return checkConnectorHealth();")(
    {...composio,checkIdleConnectorHealth:async(c: AppConfig,slugs?: readonly string[])=>{preflights.push(slugs);return composio.checkIdleConnectorHealth(c,slugs!);}},cfg,connectorHealthStore,{listRoutines:()=>routinesList},{workspaceChief:()=>undefined,bots:[]},(safeReads as any).PREFLIGHT_LOOKAHEAD_MS);
  expect(preflights.every(slugs => Boolean(slugs?.length))).toBe(true);
}
it("R4a three monitor ticks without routines only refresh inventory",async()=>{
  for(let n=0;n<3;n++){clock+=300_001;await tick();} expect(reads).toBe(3); expect(calls).toHaveLength(0);
});
it.each([[false,30],[true,61]])("R4b disabled=%s or outside lookahead=%s has no reads",async(enabled,minutes)=>{
  await dispatch(undefined,undefined,{scheduled:true,routineId:"routine",routineRevision:1}); calls=[]; clock+=4_000_000;
  routinesList=[{id:"routine",updatedAt:1,enabled,nextRunAt:clock+minutes*60_000}]; await tick(); expect(calls).toHaveLength(0);
});
it("R4c learned gmail due in 30 minutes reads each gmail account once, never slack",async()=>{
  accounts.gmail!.push({id:"B",status:"ACTIVE"}); accounts.slack=[{id:"S",status:"ACTIVE"}];
  await composio.connectedInventory(cfg,{force:true,fresh:true}); await dispatch(undefined,undefined,{scheduled:true,routineId:"routine",routineRevision:1}); calls=[]; clock+=4_000_000;
  routinesList=[{id:"routine",updatedAt:1,enabled:true,nextRunAt:clock+30*60_000}]; await tick(); clock+=300_001; await tick();
  expect(calls.map(c=>c.params.arguments.tools[0].account).sort()).toEqual(["A","B"]);
  expect(calls.every(c=>c.params.arguments.tools[0].tool_slug==="GMAIL_GET_PROFILE")).toBe(true);
});
it("R4d first scheduled dispatch preflights at runtime and learns toolkit",async()=>{
  await tick(); expect(calls).toHaveLength(0);
  await dispatch(undefined,undefined,{scheduled:true,routineId:"new-routine",routineRevision:1}); expect(calls).toHaveLength(2); expect(calls[0].params.arguments.tools[0].tool_slug).toBe("GMAIL_GET_PROFILE");
  expect((composio as any).scheduledConnectorToolkits).toBeTypeOf("function");
  expect((composio as any).scheduledConnectorToolkits(cfg,[{id:"new-routine",updatedAt:1,enabled:true,nextRunAt:clock}],clock)).toEqual(["gmail"]);
});

it("R4 retention unions real dispatches, reloads, scopes owner and revision, deletes stale learning",async()=>{
  const {ConnectorHealthStore}=await import("./connector-health-store.ts");
  const {DATA_DIR}=await import("./config.ts"); const {join}=await import("node:path");
  accounts.slack=[{id:"S",status:"ACTIVE"}]; await composio.connectedInventory(cfg,{force:true,fresh:true});
  await dispatch(undefined,undefined,{scheduled:true,routineId:"routine",routineRevision:1});
  await dispatch("SLACK_TEST_AUTH",{account:"S"},{scheduled:true,routineId:"routine",routineRevision:1});
  const ledger=new ConnectorHealthStore(join(DATA_DIR,"connector-health.json"));
  expect((ledger as any).routineToolkits).toBeDefined();
  const record=Object.values((ledger as any).routineToolkits)[0] as any;
  expect(record.slugs).toEqual(["gmail","slack"]);
  expect(ledger.claimProbe(record.owner,"gmail","A",clock+300_000)).toBe(false);
  routinesList=[{id:"routine",updatedAt:1,enabled:true,nextRunAt:clock+30*60_000}];
  expect((ledger as any).scheduledToolkits(record.owner,routinesList,clock)).toEqual(["gmail","slack"]);
  expect((ledger as any).scheduledToolkits("different-owner",routinesList,clock)).toEqual([]);
  expect((ledger as any).scheduledToolkits(record.owner,[{...routinesList[0],updatedAt:2}],clock)).toEqual([]);
  expect(Object.keys((ledger as any).routineToolkits)).toHaveLength(0);
  ledger.learnRoutine(record.owner,"deleted",1,["gmail"]);
  expect(ledger.scheduledToolkits(record.owner,[],clock)).toEqual([]);
  expect(Object.keys(new ConnectorHealthStore(join(DATA_DIR,"connector-health.json")).routineToolkits)).toHaveLength(0);
  const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
  expect(source).toContain("const connectorRun = routines.routineRunForThread(internalClaim.threadId, true)");
});
it("R4 bounded best effort: tick phase, restart budget, newly enabled and overdue runs",async()=>{
  await dispatch(undefined,undefined,{scheduled:true,routineId:"routine",routineRevision:1}); calls=[];
  const runAt=clock+61*60_000;
  routinesList=[{id:"routine",updatedAt:1,enabled:true,nextRunAt:runAt}];
  for(let minutes=1;minutes<=56;minutes+=5){clock=runAt-(61-minutes)*60_000;await tick();}
  expect(calls).toHaveLength(0); // Budget resumes at T-1, after the last tick.
  clock=runAt; probe="upstreamAuth"; await dispatch(undefined,undefined,{scheduled:true,routineId:"routine",routineRevision:1});
  expect(composio.appsNeedingReconnect(cfg)).toHaveLength(1);
  calls=[]; clock+=4_000_000; routinesList[0].enabled=false;await tick();expect(calls).toHaveLength(0);
  routinesList[0].enabled=true;await tick();expect(calls).toHaveLength(1); // overdue is still eligible
});

it("R4d control: dispatch preflights even without any learned routine",async()=>{
  await dispatch(undefined,undefined,{scheduled:true});
  expect(calls).toHaveLength(2); expect(calls[0].params.arguments.tools[0].tool_slug).toBe("GMAIL_GET_PROFILE");
});

it("R4 dispatch uses reactive failure when an earlier successful probe still consumes the budget",async()=>{
  await dispatch(undefined,undefined,{scheduled:true,routineId:"routine",routineRevision:1}); calls=[];
  clock+=30*60_000;probe="upstreamAuth";
  await dispatch(undefined,undefined,{scheduled:true,routineId:"routine",routineRevision:1});
  expect(calls).toHaveLength(1);expect(calls[0].params.name).toBe("GMAIL_FETCH_EMAILS");
  expect(composio.appsNeedingReconnect(cfg)[0]?.accounts.map(a=>a.id)).toEqual(["A"]);
});


it.each([false, true])("R4 B3 dispatch resolves run metadata once without derived health (scheduled=%s)", async scheduled => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("        // Actions get an operation identity");
  const end = source.indexOf("        authorize();", start);
  expect(start).toBeGreaterThan(0);
  const { stripTypeScriptTypes } = await import("node:module");
  const js = stripTypeScriptTypes(source.slice(start, end), { mode: "strip" });
  let runLookups = 0, healthDerivations = 0;
  const revision = 37;
  const routineRun = scheduled ? { routineId: "execution-routine", updatedAt: revision, triggerSource: "schedule" } : null;
  const manager = {
    activeRunOrigin: () => ({ triggerSource: scheduled ? "schedule" : "manual" }),
    routineRunForThread: (thread: string) => { expect(thread).toBe("execution-thread"); runLookups++; return routineRun; },
    listRoutines: () => Array.from({ length: 100 }, (_, i) => {
      healthDerivations++;
      return { id: i === 99 ? "execution-routine" : `unrelated-${i}`, updatedAt: revision };
    }),
  };
  let options: any;
  await new Function("composio", "cfg", "routines", "req", "internalClaim", "authorize", "CONNECTED_APP_WAIT_HEADER", "body", "internalCapabilities",
    `return (async () => { ${js} })();`)(
    { relayConnectedAppCall: async (...args: any[]) => { options = args[4]; } }, cfg, manager,
    { headers: {} }, { threadId: "execution-thread", botId: "r3-fixture" }, () => {}, "x-fixture-wait", {}, { providerTurnOf: () => "fixture-turn" });
  expect(options.scheduled).toBe(scheduled);
  expect(options.routineId).toBe(scheduled ? "execution-routine" : undefined);
  expect(options.routineRevision).toBe(scheduled ? revision : undefined);
  expect(healthDerivations).toBe(0);
  expect(runLookups).toBeLessThanOrEqual(1);
});


// Exercise the real manager: counting a stubbed lookup cannot bound history visits.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineManager, type RoutineManagerOptions, type RoutineRun } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const historyDirs: string[] = [];
afterEach(() => { for (const dir of historyDirs.splice(0)) removeTempDirSync(dir); });
function historyFixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-connector-history-")); historyDirs.push(dir);
  const options: RoutineManagerOptions = { file: join(dir, "routines.json"), now: () => clock,
    botState: () => "ready", createTask: () => ({ threadId: "execution-thread" }), startTurn: async () => {} };
  const manager = new RoutineManager(options);
  const definition = manager.create({ name: "Fixture", prompt: "Fixture", botId: "r3-fixture", enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: clock }, permissionMode: "ask" });
  // List injection is the same watched boundary used by load/rollback. Every lookup below is production code.
  const state = manager as unknown as { runs: RoutineRun[]; routines: Array<typeof definition>; save(): void };
  const run = (id: string, status = "completed", threadId = `thread-${id}`) => ({ id, routineId: definition.id,
    botId: "r3-fixture", threadId, status, target: "bot", createdAt: clock, triggerSource: "schedule" } as RoutineRun);
  return { manager, definition, state, run, options };
}

it.each([0, 1, 100, 100_000].flatMap(count => [false, true].map(scheduled => ({ count, scheduled }))))(
  "R4 B3 real dispatch visits bounded records with $count retained runs (scheduled=$scheduled)", async ({ count, scheduled }) => {
  const { manager, definition, state, run } = historyFixture();
  let visits = 0;
  const visited = new Set<RoutineRun>();
  const measured = (row: RoutineRun) => new Proxy(row, { get(target, key, receiver) {
    visits++; visited.add(target);
    return Reflect.get(target, key, receiver);
  } });
  state.runs = Array.from({ length: count }, (_, n) => measured(run(`old-${n}`)));
  // Add a live run after the retained history, through the normal append boundary.
  state.runs.push(measured(run("live", "running", "execution-thread")));
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("        // Actions get an operation identity");
  const end = source.indexOf("        authorize();", start);
  const { stripTypeScriptTypes } = await import("node:module");
  const js = stripTypeScriptTypes(source.slice(start, end), { mode: "strip" });
  const list = vi.spyOn(manager, "listRoutines");
  const lookup = vi.spyOn(manager, "routineRunForThread");
  const threadId = scheduled ? "execution-thread" : "ordinary-thread";
  {
    visits = 0; visited.clear(); list.mockClear(); lookup.mockClear();
    let options: any;
    await new Function("composio", "cfg", "routines", "req", "internalClaim", "authorize", "CONNECTED_APP_WAIT_HEADER", "body", "internalCapabilities",
      `return (async () => { ${js} })();`)(
      { relayConnectedAppCall: async (...args: any[]) => { options = args[4]; } }, cfg, manager,
      { headers: {} }, { threadId, botId: "r3-fixture" }, () => {}, "x-fixture-wait", {}, { providerTurnOf: () => "fixture-turn" });
    expect(options.scheduled).toBe(threadId === "execution-thread");
    expect(options.routineId).toBe(threadId === "execution-thread" ? definition.id : undefined);
    expect(options.routineRevision).toBe(threadId === "execution-thread" ? definition.updatedAt : undefined);
    expect(list).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(visited.size).toBeLessThanOrEqual(1);
    expect(visits).toBeLessThanOrEqual(6);
  }
});

it("R4 B3 indexed identity follows mutations, list order, replacement and current definition metadata", () => {
  const { manager, definition, state, run } = historyFixture();
  state.runs = [run("first", "running", "shared"), run("second", "waiting", "shared")];
  const first = state.runs[0]!, second = state.runs[1]!;
  expect(manager.routineRunForThread("shared", true)).toMatchObject({ runId: "first", updatedAt: definition.updatedAt, triggerSource: "schedule" });
  // Remove and restore the older live run: array order, rather than activation order, still wins.
  first.status = "completed";
  expect(manager.routineRunForThread("shared")?.runId).toBe("second");
  first.status = "running";
  expect(manager.routineRunForThread("shared")?.runId).toBe("first");
  first.threadId = "moved";
  expect(manager.routineRunForThread("shared")?.runId).toBe("second");
  delete first.threadId;
  expect(manager.routineRunForThread("moved")).toBeNull();
  first.threadId = "moved";
  state.routines[0]!.updatedAt++;
  expect(manager.routineRunForThread("moved", true)?.updatedAt).toBe(definition.updatedAt + 1);
  expect(manager.routineRunForThread("moved")).not.toHaveProperty("updatedAt");
  second.triggerSource = "webhook";
  expect(manager.routineRunForThread("shared", true)).toBeNull();
  second.triggerSource = "manual";
  expect(manager.routineRunForThread("shared", true)?.triggerSource).toBe("manual");
  state.runs.splice(0, 1);
  expect(manager.routineRunForThread("moved")).toBeNull();
  expect(manager.routineRunForThread("shared")?.runId).toBe("second");
  state.runs.length = 0;
  expect(manager.routineRunForThread("shared")).toBeNull();
  state.runs = [run("replacement", "running", "replacement")];
  expect(manager.routineRunForThread("replacement")?.runId).toBe("replacement");
  // A reference held across load/rollback must never rejoin the new list's index.
  first.threadId = "stale";
  expect(manager.routineRunForThread("stale")).toBeNull();
});

it("R4 B3 indexed identity follows real dispatch, completion, cancellation and restart", async () => {
  const { manager, definition, options } = historyFixture();
  manager.runNow(definition.id);
  await manager.tick();
  expect(manager.routineRunForThread("execution-thread", true)).toMatchObject({ routineId: definition.id, triggerSource: "manual" });
  manager.handleRuntimeEvent({ type: "turn.completed", threadId: "execution-thread", ok: true } as never);
  expect(manager.routineRunForThread("execution-thread")).toBeNull();
  manager.runNow(definition.id); await manager.tick();
  const live = manager.routineRunForThread("execution-thread")!;
  expect(live).not.toBeNull();
  await manager.cancelRun(live.runId);
  expect(manager.routineRunForThread("execution-thread")).toBeNull();
  manager.runNow(definition.id); await manager.tick();
  expect(manager.routineRunForThread("execution-thread")).not.toBeNull();
  const reloaded = new RoutineManager(options);
  expect(reloaded.routineRunForThread("execution-thread")).toBeNull();
});

it("R4 B3 index restores rolled back runs and rebases after history trimming", async () => {
  const { manager, definition, state, run } = historyFixture();
  manager.runNow(definition.id); await manager.tick();
  const live = manager.routineRunForThread("execution-thread")!;
  expect(live).not.toBeNull();
  const save = vi.spyOn(state, "save").mockImplementationOnce(() => { throw new Error("fixture save failure"); });
  await expect(manager.cancelRun(live.runId)).rejects.toThrow("fixture save failure");
  save.mockRestore();
  expect(manager.routineRunForThread("execution-thread")?.runId).toBe(live.runId);
  state.runs = [...Array.from({ length: 2100 }, (_, n) => run(`old-${n}`)), run("kept", "running", "kept")];
  state.save(); // The history cap splices the raw list, bypassing its list watch.
  expect(state.runs.length).toBeLessThan(2101);
  expect(manager.routineRunForThread("kept")?.runId).toBe("kept");
  const kept = state.runs[state.runs.length - 1]!;
  state.runs.push(run("later", "running", "kept"));
  expect(manager.routineRunForThread("kept")?.runId).toBe("kept");
  kept.status = "completed";
  expect(manager.routineRunForThread("kept")?.runId).toBe("later");
  state.runs.pop();
  expect(manager.routineRunForThread("kept")).toBeNull();
});
