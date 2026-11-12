// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { spawnCli, awaitCliTreeStopped } from "../procs.ts";
import * as reaper from "../memory/pip-reaper.ts";
import { httpTextOnlyTurn } from "./http-text-only.ts";
import { claudeTextOnlyTurn, headlessTextOnlyTurn, runHeadlessCli, sumUsageReports } from "./headless-text-only.ts";
import { createTempRoot, fixedPrompt, headlessUsageReport, type TransportHooks } from "../memory/pip-transport.ts";
import { captureMemoryUsage, clearUnseenExcess, unseenExcessCalls, type MemoryUsageReport } from "../memory/extract.ts";
import { withRetryReservation } from "../testing/retry-reservation.ts";
import { learningGate, sampleLearningFence } from "../memory/learning-send.ts";
import { learningCeilingStatus } from "../memory/settings.ts";
import { learningSpendLedgerId, learningSpendMonth } from "../../shared/memory-learning-contract.ts";
import { readMemoryLearning, updateMemoryLearning } from "../memory/learning-policy.ts";
vi.mock("../local-address-guard.ts", () => ({ checkLocalServerUrl: async () => ({ ok: true }) }));
vi.mock("../procs.ts",async original=>({...await original<typeof import("../procs.ts")>(),spawnCli:vi.fn(),awaitCliTreeStopped:vi.fn()}));
const schema={type:"object",required:["ok"],properties:{ok:{type:"boolean"}}};
const system="SYS",text="USER";
const init=JSON.stringify({type:"system",subtype:"init",tools:[],mcp_servers:[]})+"\n";
const result=(usage:unknown,answer="not JSON")=>JSON.stringify({type:"result",subtype:"success",is_error:false,result:answer,...(usage===undefined?{}:{usage})})+"\n";
let other:DatabaseSync,roots:string[],stdout:string[],controller:AbortController;
let held: { input: number; output: number };
const monthId=()=>learningSpendLedgerId(learningSpendMonth());
const row=()=>JSON.parse(String(other.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(monthId())!.intent));
beforeEach(()=>{
  closeDatabase();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});
  updateMemoryLearning(database(),{callsPerMinute:60},readMemoryLearning(database()).revision);
  other=new DatabaseSync(join(DATA_DIR,"messages.db"));roots=[];stdout=[];controller=new AbortController();
  // Spy after module loading: importOriginal(pip-reaper) cycles through pip-transport → grok → headless,
  // which otherwise binds the adapter to the real registration function and rejects our synthetic pid.
  vi.spyOn(reaper,"registerChild").mockImplementation(async pid=>({pid:pid!,startTime:"fixture",registeredAt:Date.now()}));
  vi.mocked(awaitCliTreeStopped).mockImplementation(async child=>{queueMicrotask(()=>child.emit("close",0));return true;});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();other.close();});
function stub(outputs:(string|null)[],options:{overflow?:boolean;tail?:string;inspect?:()=>void;cancel?:boolean}={}){
  let calls=0;
  vi.mocked(spawnCli).mockImplementation((_cli,_args,opts)=>{
    const n=calls++;if (roots.length === 0) { const saved = other.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(monthId()); if (saved) { const spend = JSON.parse(String(saved.intent)); held = { input: spend.input, output: spend.output }; } }options.inspect?.();const root=String(opts?.env?.HOME);roots.push(root);
    const child=Object.assign(new EventEmitter(),{pid:800000+n,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
    queueMicrotask(()=>{
      const output=outputs[n%outputs.length];
      if(output===null){controller.abort();child.emit("close",0);return;}
      stdout.push(output);child.stdout.write(output);
      if(options.tail)child.stdout.write(options.tail);
      if(options.overflow)child.stdout.write("x".repeat(13000));
      if(options.cancel)controller.abort();
      child.emit("close",0);
    });
    return child as never;
  });
}
async function turn(hooks?:TransportHooks,scoped=true,flux=true){
  const gate=learningGate("continuity",sampleLearningFence());
  const call=()=>headlessTextOnlyTurn({cwd:DATA_DIR,system:fixedPrompt(system),text,model:"m",signal:controller.signal,outputSchema:schema,maxOutputBytes:12000,maxOutputTokens:3000,context:{botId:"fixture",runId:"r",family:"lived",attempt:1},transport:{gate,hooks},...(flux?{}:{providerRoute:{connectionId:"fixture",preset:"openai",protocol:"openai" as const,baseUrl:"https://fixture.invalid/v1",apiKey:"fixture",model:"m",revision:"r1"}})},
    {engine:"fuigo",cli:"fixture",fluxKey:"fixture",tmpBase:join(DATA_DIR,"tmp"),preflight:{platform:"linux",home:DATA_DIR,etcRoot:join(DATA_DIR,"etc"),mdmDir:null,claudeManagedPath:join(DATA_DIR,"absent")}});
  return scoped?withRetryReservation(call):call();
}
it.each([undefined,{input_tokens:0,output_tokens:0}])("29: ten Flux tokenless double misses retain reservations and pause until accepted (%j)",async usage=>{
  const output=init+result(usage);stub([output]);
  for(let i=1;i<=10;i++){
    held = { input: 0, output: 0 };
    const before = i === 1 ? { input: 0, output: 0 } : row();
    roots = []; await turn();const spend=row();
    expect(spend.input).toBe(held.input);expect(spend.output).toBe(held.output);
    expect(spend.input).toBeGreaterThan(before.input); expect(spend.output - before.output).toBe(3000);
    expect(spend.estimatedRuns).toBe(i*2);expect(unseenExcessCalls(spend)).toEqual({inFlight:0,settled:2});
    expect(learningCeilingStatus(database(),readMemoryLearning(database()).ceiling).paused).toBe(true);
    const day=JSON.parse(String(other.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='continuity-budget'").get()!.intent));expect(day.input).toBe(spend.input);expect(day.output).toBe(spend.output);
    expect(roots).toHaveLength(2);expect(roots.every(root=>!existsSync(root))).toBe(true);
    clearUnseenExcess(database());
  }

});
it("4, 29: the spawn reads committed estimated evidence on an independent connection",async()=>{
  stub([init+result(undefined)],{inspect:()=>{if(roots.length===1){const records=Object.values(row().retryRecords);expect(records).toHaveLength(1);expect(records[0]).toMatchObject({estimated:true,usage:{}});expect(existsSync(roots[0])).toBe(false);}}});
  await turn();
});
it("29: real tokens form the floor when the Flux retry has unknown usage",async()=>{
  stub([init+result({input_tokens:9000,output_tokens:5000}),init+result(undefined)]);await turn();
  expect(row()).toMatchObject({input:9000,output:5000,estimatedRuns:1,unmetered:1});
});
it("29: a fully reported retry has no estimate marker",async()=>{
  stub([init+result({input_tokens:9,output_tokens:5})]);await turn();expect(row()).toMatchObject({input:18,output:10});expect(row().estimatedRuns).toBeUndefined();
});
it("16, 29: unknown Flux run plus released Stop keeps the reservation and counts both once",async()=>{
  stub([init+result(undefined),null]);const reports:MemoryUsageReport[]=[];
  await expect(captureMemoryUsage(u=>reports.push(u),()=>turn())).rejects.toMatchObject({name:"cancelled"});
  expect(reports).toHaveLength(1);expect(reports[0]).toMatchObject({estimatedRuns:2,extraUnseen:2});
  expect(reports[0].knownFloor).toBeUndefined();
  expect(row()).toMatchObject({...held,unmetered:2,estimatedRuns:2});
});
it("29: Stop before retry release retains the reservation and counts only the first unknown Flux run",async()=>{
  stub([init+result(undefined)]);await turn({onUsage:()=>controller.abort()});
  expect(roots).toHaveLength(1);expect(row()).toMatchObject({...held,estimatedRuns:1,unmetered:1});
});
it("a prompt without a send gate is refused before writing or spawning",async()=>{
  const temp=createTempRoot(join(DATA_DIR,"tmp"),"ungated",1,"");
  const before=vi.mocked(spawnCli).mock.calls.length;
  let promptAtCleanup: string | undefined;
  const cleanup=vi.fn(()=>{promptAtCleanup=readFileSync(temp.promptFile,"utf8");});
  await expect(runHeadlessCli({engine:"fuigo",cli:"fixture",args:[],cwd:temp.work,env:{HOME:temp.root},temp,tmpBase:join(DATA_DIR,"tmp"),outputSchema:schema,signal:controller.signal,context:{runId:"ungated",family:"lived",attempt:1},promptText:"private words",cleanup})).rejects.toThrow("HEADLESS_PROMPT_REQUIRES_GATE");
  expect(cleanup).toHaveBeenCalledOnce();expect(promptAtCleanup).toBe("");expect(vi.mocked(spawnCli).mock.calls).toHaveLength(before);expect(existsSync(temp.root)).toBe(false);
});
it.each(["fuigo","grok","claude"] as const)("29: single off-Flux %s tokenless run uses its own bytes",async engine=>{
  const output=init+result({input_tokens:0,output_tokens:0},'{"ok":true}');stub([output]);
  const temp=createTempRoot(join(DATA_DIR,"tmp"),"single",1,"");if(engine==="claude")writeFileSync(temp.debugFile,"");
  await withRetryReservation(()=>runHeadlessCli({engine,cli:"fixture",args:[],cwd:temp.work,env:{HOME:temp.root},temp,tmpBase:join(DATA_DIR,"tmp"),outputSchema:schema,signal:controller.signal,context:{runId:"single",family:"lived",attempt:1},requestBytes:35,gate:learningGate("continuity",sampleLearningFence()),promptText:"x".repeat(35)}));
  expect(row()).toMatchObject({input:10,output:Math.ceil(Buffer.byteLength(output)/3.5),estimatedRuns:1});expect(row().unmetered).toBeUndefined();
});
it.each(["empty","partial","silent"])("29: single run %s preserves the existing accounting",async mode=>{
  const output=mode==="silent"?null:init+result(mode==="partial"?{input_tokens:7}:{input_tokens:0,output_tokens:0},"");stub([output]);
  const temp=createTempRoot(join(DATA_DIR,"tmp"),"single",1,"");
  const call=withRetryReservation(()=>runHeadlessCli({engine:"fuigo",cli:"fixture",args:[],cwd:temp.work,env:{HOME:temp.root},temp,tmpBase:join(DATA_DIR,"tmp"),outputSchema:schema,signal:controller.signal,context:{runId:"single",family:"lived",attempt:1},requestBytes:35,gate:learningGate("continuity",sampleLearningFence()),promptText:"x"}));
  if(mode==="silent")await expect(call).rejects.toMatchObject({name:"cancelled"});else await call;
  expect(row().estimatedRuns).toBeUndefined();expect(row().unmetered).toBeUndefined();
  if(mode==="empty")expect(row()).toMatchObject({input:0,output:0});else if(mode==="partial")expect(row()).toMatchObject({input:7,output:3000});else expect(row().output).toBe(3000);
});
it("29: result evidence survives stdout overflow; onUsage throwing twice settles once",async()=>{
  stub([init+result({input_tokens:0,output_tokens:0})],{overflow:true});const hook=vi.fn(()=>{throw new Error("hook fixture");});
  await expect(turn({onUsage:hook})).rejects.toThrow("hook fixture");
  expect(hook).toHaveBeenCalledTimes(2);expect(row().estimatedRuns).toBe(1);expect(row()).toMatchObject({...held,unmetered:1});
});
it("29: trace and reported over-limit still use the engine's values",async()=>{
  stub([init+result({input_tokens:0,output_tokens:0})]);const hook=vi.fn();const got=await turn({onUsage:hook});
  expect(got.usage).toEqual({inputTokens:0,outputTokens:0});expect(got.reportedOverLimit).toBeUndefined();expect(hook).toHaveBeenCalledWith({inputTokens:0,outputTokens:0});expect(row().estimatedRuns).toBe(2);
});
it.each(["no-scope","outer","write","cap"])("12: journal %s refusal returns first without a second spawn",async mode=>{
  stub([init+result({input_tokens:9,output_tokens:5})]);let held=false;
  const hooks:TransportHooks={onUsage:()=>{
    if(mode==="outer"){database().exec("BEGIN IMMEDIATE");held=true;}
    if(mode==="write")database().exec("CREATE TRIGGER fail_journal BEFORE UPDATE ON memory_scope_bindings WHEN new.subject_id='learning-spend' BEGIN SELECT RAISE(ABORT,'disk fixture'); END");
    if(mode==="cap"){const spend=row();spend.retryRecords={a:{},b:{}};database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(spend),monthId());}
  }};
  const invoke=async()=>{try{return await turn(hooks,false);}finally{if(held)database().exec("ROLLBACK");if(mode==="write")database().exec("DROP TRIGGER fail_journal");}};
  const got=mode==="no-scope"?await invoke():await withRetryReservation(invoke);
  expect(got.verdict).toMatchObject({state:"refused",detail:"no-structured-output"});expect(roots).toHaveLength(1);
  if(mode!=="no-scope")expect(row()).toMatchObject({input:9,output:5});
});
it.each([true,false].flatMap(registered=>[true,false].map(stopped=>({registered,stopped}))))("21: real gate COMMIT failure owns its child (registered=$registered, stopped=$stopped)",async({registered,stopped})=>{
  stub([init+result({input_tokens:9,output_tokens:5})]);if(!registered)vi.mocked(reaper.registerChild).mockResolvedValue(null);
  if(!stopped)vi.mocked(awaitCliTreeStopped).mockResolvedValue(false);
  const db=database(),exec=db.exec.bind(db);let sent=false;
  const spawn=vi.mocked(spawnCli).getMockImplementation()!;vi.mocked(spawnCli).mockImplementation((...args)=>{const child=spawn(...args);sent=true;return child;});
  vi.spyOn(db,"exec").mockImplementation(sql=>{if(sql==="COMMIT"&&sent){sent=false;throw new Error("commit fixture");}return exec(sql);});
  await expect(turn()).rejects.toMatchObject({name:"memory-send-commit-failed"});expect(awaitCliTreeStopped).toHaveBeenCalled();expect(roots.every(root=>!existsSync(root))).toBe(stopped);
});
it("21: failed COMMIT and unconfirmed stop retain the credential root",async()=>{
  stub([init+result({input_tokens:9,output_tokens:5})]);vi.mocked(awaitCliTreeStopped).mockResolvedValue(false);
  const db=database(),exec=db.exec.bind(db);let once=true;
  vi.spyOn(db,"exec").mockImplementation(sql=>{if(sql==="COMMIT"&&roots.length&&once){once=false;throw new Error("commit fixture");}return exec(sql);});
  await expect(turn()).rejects.toMatchObject({name:"memory-send-commit-failed"});expect(existsSync(roots[0])).toBe(true);
});
it("29: estimatedRuns sums independently of missing token totals",()=>{
  const report=sumUsageReports([headlessUsageReport(undefined,true,35000,17500,1),{engineRun:true}]);
  expect(report).toMatchObject({estimatedRuns:1,knownFloor:{prompt_tokens:10000,completion_tokens:5000}});expect(report.prompt_tokens).toBeUndefined();
});

it.each([
  [{input_tokens:9000}, {output_tokens:5000},2],
  [{input_tokens:9000}, undefined,2],
  [undefined, {input_tokens:9000},2],
] as const)("27, 29: mixed sides (%j, %j) count each incomplete released run once",async(first,second,unseen)=>{
  stub([init+result(first),init+result(second)]);const reports:MemoryUsageReport[]=[];
  await captureMemoryUsage(u=>reports.push(u),()=>turn());expect(reports).toHaveLength(1);expect(reports[0].extraUnseen).toBe(unseen);expect(row().unmetered).toBe(unseen);
  expect(row().estimatedRuns??0).toBe(first===undefined||second===undefined?1:0);
  expect(reports[0].knownFloor).toEqual({prompt_tokens:9000,...(first && second ? {completion_tokens:5000} : {})});
});
it("29: unknown Flux result plus a released absent result retain the reservation",async()=>{
  stub([init+result(undefined),init]);const reports:MemoryUsageReport[]=[];await captureMemoryUsage(u=>reports.push(u),()=>turn());
  expect(reports[0]).toMatchObject({estimatedRuns:2,extraUnseen:2});expect(reports[0].knownFloor).toBeUndefined();expect(row()).toMatchObject({...held,unmetered:2});
});

it("5: after retry spawn, rollback and reopen retain the independently committed journal",async()=>{
  vi.useFakeTimers();stub([init+result({input_tokens:9000,output_tokens:5000})]);
  const db=database(),exec=db.exec.bind(db),prepare=db.prepare.bind(db);let crashed=false;
  const execution=vi.spyOn(db,"exec").mockImplementation(sql=>{
    if(sql==="COMMIT"&&roots.length===2&&!crashed){exec("ROLLBACK");crashed=true;throw new Error("parent crash after spawn");}return exec(sql);
  });
  const statements=vi.spyOn(db,"prepare").mockImplementation(((sql:string)=>{
    if(crashed&&sql==="UPDATE memory_scope_bindings SET intent=? WHERE id=?")throw Object.assign(new Error("database is locked"),{code:"SQLITE_BUSY"});return prepare(sql);
  }) as typeof db.prepare);
  await expect(turn()).rejects.toMatchObject({name:"memory-send-commit-failed"});
  const saved=row();expect(Object.values(saved.retryRecords)).toHaveLength(1);expect(Object.values(saved.retryRecords)[0]).toMatchObject({usage:{prompt_tokens:9000,completion_tokens:5000}});
  execution.mockRestore();statements.mockRestore();vi.clearAllTimers();closeDatabase();database();expect(row()).toEqual(saved);
  const record=Object.values(saved.retryRecords)[0] as import("../memory/extract.ts").RetryRecord;
  saved.open={dead:1};record.boot="dead";
  const {transaction}=await import("../database.ts"),{reconcileDeadRetries}=await import("../memory/extract.ts");
  transaction(db=>{reconcileDeadRetries(db,saved);db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(saved),monthId());});
  expect(row().input).toBe(Math.max(record.tokens.input,9000));expect(row().output).toBe(5000);expect(unseenExcessCalls(row())).toEqual({inFlight:0,settled:1});
});

it.each(["one chunk", "separate chunks", "cap crossed in chunk", "cancel after result"] as const)("D1: Flux keeps real usage before empty usage (%s)", async mode => {
  const real = init + result({input_tokens:9000,output_tokens:5000});
  const empty = result({});
  stub([mode === "separate chunks" ? real : real + empty + (mode === "cap crossed in chunk" ? "x".repeat(13000) : "")], {
    ...(mode === "separate chunks" ? {tail: empty} : {}),
    cancel: mode === "cancel after result",
  });
  const call = turn();
  if (mode === "cancel after result") await expect(call).rejects.toMatchObject({name:"cancelled"});
  else await call;
  expect(roots).toHaveLength(1);
  expect(row()).toMatchObject({input:9000,output:5000});
  expect(row().estimatedRuns).toBeUndefined();
  expect(unseenExcessCalls(row())).toEqual({inFlight:0,settled:0});
  const day=JSON.parse(String(other.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='continuity-budget'").get()!.intent));
  expect(day).toMatchObject({input:9000,output:5000});
});
it("D2: the first result arrives in the chunk that crosses the stdout cap", async () => {
  const output=init+result({input_tokens:0,output_tokens:0})+"x".repeat(13000);
  stub([output]);
  await turn();
  expect(roots).toHaveLength(1);
  expect(row()).toMatchObject({...held,estimatedRuns:1,unmetered:1});
});
it.each(["input", "output"] as const)("F: released incomplete retry preserves a known %s floor above reservation on both ledgers", async side => {
  stub([init+result(side==="input"?{input_tokens:900000}:{output_tokens:900000}),null]);
  await expect(turn()).rejects.toMatchObject({name:"cancelled"});
  expect(row()[side]).toBe(900000);
  const day=JSON.parse(String(other.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='continuity-budget'").get()!.intent));
  expect(day[side]).toBe(900000);
  expect(row().unmetered).toBe(2);
});

// These are adapter-boundary fixtures, not provider calls: the CLI reports a result
// for Responses, while HTTP receives the chat-completions envelope of that usage.
// A cancelled Messages stream has message_start only, with no final message_delta.
const messageStart = { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } };
it.each(["http", "headless"] as const)("A messages-cancelled: %s Flux retains reservation, marker and exactly one unseen", async driver => {
  if (driver === "headless") {
    stub([init + JSON.stringify(messageStart) + "\n"], { cancel: true });
    await expect(turn()).rejects.toMatchObject({ name: "cancelled" });
    expect(roots).toHaveLength(1);
  } else {
    await expect(httpUsageTurn(true, "messages-cancelled")).rejects.toMatchObject({ name: "cancelled" });
  }
  assertUnknownFluxSettlement();
});
it.each(["http", "headless"] as const)("A responses-zero: %s Flux retains reservation, marker and exactly one unseen", async driver => {
  if (driver === "headless") {
    stub([init + result({ input_tokens: 0, output_tokens: 0 }, '{"ok":true}')]);
    await turn(); expect(roots).toHaveLength(1);
  } else await httpUsageTurn(true, "responses-zero");
  assertUnknownFluxSettlement();
});
it.each(["http", "headless"] as const)("A finished-missing: %s Flux retains reservation, marker and exactly one unseen", async driver => {
  if (driver === "headless") {
    stub([init + result(undefined, '{"ok":true}')]);
    await turn(); expect(roots).toHaveLength(1);
  } else await httpUsageTurn(true, "finished-missing");
  assertUnknownFluxSettlement();
});
it("A HTTP off-Flux 0/0 control still settles at zero without a marker or unseen", async () => {
  await httpUsageTurn(false, "responses-zero");
  expect(row()).toMatchObject({ input: 0, output: 0 });
  expect(row().estimatedRuns).toBeUndefined();
  expect(unseenExcessCalls(row())).toEqual({ inFlight: 0, settled: 0 });
});
function assertUnknownFluxSettlement() {
  expect(row()).toMatchObject({ ...held, estimatedRuns: 1 });
  expect(held.input).toBeGreaterThan(0); expect(held.output).toBe(3000);
  expect(unseenExcessCalls(row())).toEqual({ inFlight: 0, settled: 1 });
  const day = JSON.parse(String(other.prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='continuity-budget'").get()!.intent));
  expect(day).toMatchObject(held);
}
async function httpUsageTurn(flux: boolean, mode: "messages-cancelled" | "responses-zero" | "finished-missing") {
  return withRetryReservation(() => httpTextOnlyTurn({
    system: fixedPrompt(system), text, model: "m", signal: controller.signal,
    outputSchema: schema, maxOutputBytes: 12000, maxOutputTokens: 3000,
    context: { botId: "fixture", runId: "r", family: "lived", attempt: 1 },
    transport: { gate: learningGate("continuity", sampleLearningFence()) },
  }, {
    baseUrl: flux ? "https://api.fluxrouter.ai/v1" : "https://fixture.invalid/v1",
    apiKey: "fixture", buildBody: (model, messages) => ({ model, messages }),
    fetchImpl: async () => {
      held = { input: row().input, output: row().output };
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({ pull(c) {
        if (sent) {
          if (mode === "messages-cancelled") { controller.abort(); c.error(new Error("cancelled stream")); }
          else c.close();
          return;
        }
        sent = true;
        const body = mode === "messages-cancelled" ? `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`
          : JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
            ...(mode === "responses-zero" ? { usage: { prompt_tokens: 0, completion_tokens: 0 } } : {}) });
        c.enqueue(new TextEncoder().encode(body));
      } }));
    },
  }));
}

it("A headless silent cancellation retains reservation, marker and exactly one unseen", async () => {
  stub([null]); await expect(turn()).rejects.toMatchObject({ name: "cancelled" });
  assertUnknownFluxSettlement();
});
it("A headless empty 0/0 result is unknown on Flux", async () => {
  stub([init + result({ input_tokens: 0, output_tokens: 0 }, "")]);
  await turn({ onUsage: () => controller.abort() });
  expect(roots).toHaveLength(1); assertUnknownFluxSettlement();
});

it.each([false, true])("B: prompt write and spawn stay inside the gate (refuse=%s)", async refuse => {
  const tmpBase = join(DATA_DIR, "tmp"), temp = createTempRoot(tmpBase, "prepared", 1, "");
  const promptText = "private prompt\n".repeat(1000);
  let prepared = false;
  stub([init + result({ input_tokens: 9, output_tokens: 5 }, '{"ok":true}')], {
    inspect: () => {
      expect(prepared).toBe(true);
      expect(database().isTransaction).toBe(true);
      expect(readFileSync(temp.promptFile, "utf8")).toBe(promptText);
    },
  });
  const gate = learningGate("continuity", sampleLearningFence());
  const send = gate.send.bind(gate);
  vi.spyOn(gate, "send").mockImplementation(release => {
    expect(database().isTransaction).toBe(false);
    expect(readFileSync(temp.promptFile, "utf8")).toBe("");
    expect(roots).toHaveLength(0);
    prepared = true;
    if (refuse) throw new Error("gate refused fixture");
    return send(() => {
      expect(database().isTransaction).toBe(true);
      expect(readFileSync(temp.promptFile, "utf8")).toBe("");
      return release();
    });
  });
  const call = withRetryReservation(() => runHeadlessCli({
    engine: "fuigo", cli: "fixture", args: [], cwd: temp.work, env: { HOME: temp.root },
    temp, tmpBase, outputSchema: schema, signal: controller.signal,
    context: { runId: "prepared", family: "lived", attempt: 1 }, gate, promptText,
  }));
  if (refuse) await expect(call).rejects.toThrow("gate refused fixture"); else await call;
  expect(prepared).toBe(true);
  expect(roots).toHaveLength(refuse ? 0 : 1);
  expect(existsSync(temp.root)).toBe(false);
});

it("A headless off-Flux 0/0 empty control through route selection still settles at zero", async () => {
  stub([init + result({ input_tokens: 0, output_tokens: 0 }, "")]);
  await turn(undefined, true, false);
  expect(roots).toHaveLength(1);
  expect(row()).toMatchObject({ input: 0, output: 0 });
  expect(row().estimatedRuns).toBeUndefined();
  expect(unseenExcessCalls(row())).toEqual({ inFlight: 0, settled: 0 });
});

it.each((["messages-cancelled", "responses-zero", "finished-missing", "off-flux-zero"] as const)
  .flatMap(mode => [false, true].map(mismatchedRoute => ({ mode, mismatchedRoute }))))("A Claude route: $mode uses the configured URL (mismatched route=$mismatchedRoute)", async ({ mode, mismatchedRoute }) => {
  const cancelling = mode === "messages-cancelled", flux = mode !== "off-flux-zero";
  const baseUrl = flux ? "https://api.fluxrouter.ai" : "https://fixture.invalid";
  const routeFlux = mismatchedRoute ? !flux : flux;
  stub([cancelling ? init + JSON.stringify(messageStart) + "\n"
    : init + result(mode === "finished-missing" ? undefined : { input_tokens: 0, output_tokens: 0 }, "")], { cancel: cancelling });
  const call = withRetryReservation(() => claudeTextOnlyTurn({
    cwd: DATA_DIR, system: fixedPrompt(system), text, model: "m", signal: controller.signal,
    outputSchema: schema, maxOutputBytes: 12000, maxOutputTokens: 3000,
    context: { botId: "fixture", runId: "claude", family: "lived", attempt: 1 },
    providerRoute: { connectionId: "fixture", preset: routeFlux ? "flux" : "openai", protocol: "anthropic",
      baseUrl: routeFlux ? "https://api.fluxrouter.ai" : "https://fixture.invalid", apiKey: "fixture", model: "m", revision: "r1" },
    transport: { gate: learningGate("continuity", sampleLearningFence()), hooks: {
      onIntent: intent => { writeFileSync(join(intent.tempRoot, "debug.log"), ""); },
    } },
  }, {
    cli: "fixture", tmpBase: join(DATA_DIR, "tmp"), env: { ANTHROPIC_BASE_URL: baseUrl }, platform: "linux",
    preflight: { platform: "linux", home: DATA_DIR, etcRoot: join(DATA_DIR, "etc"), mdmDir: null, claudeManagedPath: join(DATA_DIR, "absent") },
  }));
  if (cancelling) await expect(call).rejects.toMatchObject({ name: "cancelled" }); else await call;
  expect(roots).toHaveLength(1);
  expect(vi.mocked(spawnCli).mock.calls.at(-1)?.[2]?.env?.ANTHROPIC_BASE_URL).toBe(baseUrl);
  if (flux) assertUnknownFluxSettlement();
  else {
    expect(row()).toMatchObject({ input: 0, output: 0 });
    expect(row().estimatedRuns).toBeUndefined();
    expect(unseenExcessCalls(row())).toEqual({ inFlight: 0, settled: 0 });
  }
});
