import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { gepaCallNotStarted, isGepaCallNotStarted, runGepaWorker, type GepaCallLedger, type GepaWorkerOptions, type GepaEvaluateFrame } from "./gepa-worker.ts";
import type { GepaEvaluation, GepaJson, GepaStart } from "./gepa-protocol.ts";

const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});vi.unstubAllEnvs();});
function ledger():GepaCallLedger {
  const records=new Map<string,{hash:string;value?:GepaJson}>();
  return {lookupOrReserve(id,inputHash){const row=records.get(id);if(row){if(row.hash!==inputHash)throw Error("GEPA_CALL_CONFLICT");if(row.value===undefined)throw Error("GEPA_CALL_UNCERTAIN");return {state:"complete",value:row.value};}records.set(id,{hash:inputHash});return {state:"new"};},complete(id,inputHash,value){const row=records.get(id);if(!row||row.hash!==inputHash)throw Error("GEPA_CALL_CONFLICT");row.value=structuredClone(value);},releaseNotStarted(id,inputHash){const row=records.get(id);if(!row||row.hash!==inputHash||row.value!==undefined)throw Error("GEPA_CALL_CONFLICT");records.delete(id);}};
}
function fixture(mode="baseline"):GepaWorkerOptions {
  const cwd=mkdtempSync(join(tmpdir(),"murage-gepa-transport-"));directories.push(cwd);
  const job:GepaStart={v:1,type:"start",jobId:"fixture",candidate:{instruction:"seed"},trainIds:["train-1","train-2"],validationIds:["val-1","val-2"],limits:{maxMetricCalls:24,maxReflections:2,wallMs:3000},randomSeed:0};
  return {command:{executable:process.execPath,args:[resolve("server/testing/fake-gepa-worker.mjs"),mode],cwd,expectedPythonVersion:"3.13.13",runAsNode:true},job,ledger:ledger(),signal:new AbortController().signal,
    handlers:{evaluate:vi.fn(async(frame:GepaEvaluateFrame)=>({outputs:frame.caseIds.map(()=>"synthetic"),scores:frame.caseIds.map(()=>frame.candidate.instruction==="seed"?0.5:1),trajectories:frame.captureTraces?frame.caseIds.map(()=>({diagnostic:"synthetic feedback"})):null})),reflect:vi.fn(async()=>"```\nImproved instruction with nested example:\n```text\nexample\n```\n```")}};
}
it("requires matching runtime and a complete zero-exit result",async()=>{
  const input=fixture();const output=await runGepaWorker(input);expect(output.result).toMatchObject({bestCandidate:{instruction:"seed"},metricCalls:2,reflectionCalls:0});expect(input.handlers.evaluate).toHaveBeenCalledTimes(1);
});
it.each([["wrong-ready","GEPA_READY_INVALID"],["wrong-job","GEPA_JOB_INVALID"],["forged-case","GEPA_CASE_INVALID"],["oversize","GEPA_FRAME_LIMIT"],["exit-empty","GEPA_RESULT_INCOMPLETE"],["nonzero","GEPA_EXIT_NONZERO"],["forged-result","GEPA_RESULT_ACCOUNTING_INVALID"],["after-result","GEPA_FRAME_AFTER_RESULT"],["overlap","GEPA_RPC_OVERLAP"]])("rejects %s",async(mode,code)=>{
  const input=fixture(mode);
  if(mode==="overlap")input.handlers.evaluate=async(_frame,signal)=>await new Promise<GepaEvaluation>((_resolve,reject)=>signal.addEventListener("abort",()=>reject(Error("GEPA_CANCELLED")),{once:true}));
  await expect(runGepaWorker(input)).rejects.toThrow(code);
});
it("uses validated cached evaluation replies without invoking the evaluator again",async()=>{
  const input=fixture();await runGepaWorker(input);await runGepaWorker(input);expect(input.handlers.evaluate).toHaveBeenCalledTimes(1);
});
it("refuses uncertain ledger entries before calling an external handler",async()=>{
  const input=fixture();input.ledger.lookupOrReserve=()=>{throw Error("GEPA_CALL_UNCERTAIN");};await expect(runGepaWorker(input)).rejects.toThrow("GEPA_CALL_UNCERTAIN");expect(input.handlers.evaluate).not.toHaveBeenCalled();
});
it("releases only a branded pre-call quota refusal and reuses completed replies on explicit resume",async()=>{
  const input=fixture("reflect");let quotaBlocked=true,externalCalls=0;
  input.handlers.reflect=vi.fn(async()=>{if(quotaBlocked)throw gepaCallNotStarted();externalCalls++;return "```\nEvaluated improvement.\n```";});
  const stopped=await runGepaWorker(input).catch(error=>error);expect(isGepaCallNotStarted(stopped)).toBe(true);expect(stopped.message).toBe("GEPA_CALL_NOT_STARTED");expect(externalCalls).toBe(0);
  quotaBlocked=false;await runGepaWorker(input);expect(externalCalls).toBe(1);expect(input.handlers.evaluate).toHaveBeenCalledTimes(4);expect(input.handlers.reflect).toHaveBeenCalledTimes(2);
});
it("does not release or brand an error string pretending the external call never started",async()=>{
  const input=fixture("reflect");input.handlers.reflect=vi.fn(async()=>{throw Error("GEPA_CALL_NOT_STARTED");});
  const error=await runGepaWorker(input).catch(value=>value);expect(isGepaCallNotStarted(error)).toBe(false);expect(error.message).toBe("GEPA_RPC_FAILED");
  await expect(runGepaWorker(input)).rejects.toThrow("GEPA_CALL_UNCERTAIN");expect(input.handlers.reflect).toHaveBeenCalledTimes(1);
});
it("bounds a handler wait by cancellation and preserves the unfinished reservation",async()=>{
  const input=fixture(),controller=new AbortController();input.signal=controller.signal;
  let entered!:()=>void;const called=new Promise<void>(done=>{entered=done;});
  input.handlers.evaluate=vi.fn(async(_frame:GepaEvaluateFrame,signal:AbortSignal)=>{entered();return await new Promise<GepaEvaluation>((_resolve,reject)=>signal.addEventListener("abort",()=>reject(Error("GEPA_CANCELLED")),{once:true}));});
  const result=runGepaWorker(input);await called;controller.abort();await expect(result).rejects.toThrow("GEPA_CANCELLED");
  input.signal=new AbortController().signal;await expect(runGepaWorker(input)).rejects.toThrow("GEPA_CALL_UNCERTAIN");expect(input.handlers.evaluate).toHaveBeenCalledTimes(1);
});
it("bounds a silent child with the independent parent deadline",async()=>{
  const input=fixture("stall");input.job.limits.wallMs=500;await expect(runGepaWorker(input)).rejects.toThrow("GEPA_WALL_LIMIT");
});
it("isolates profile variables and omits credentials and Python import overrides",async()=>{
  vi.stubEnv("OPENAI_API_KEY","synthetic-do-not-pass");vi.stubEnv("PYTHONPATH","synthetic-do-not-pass");await expect(runGepaWorker(fixture("env"))).resolves.toMatchObject({pythonVersion:"3.13.13"});
});
it("validates nested-fence reflection, actual RPC scores and accepted pool lineage",async()=>{
  const input=fixture("reflect"),result=await runGepaWorker(input);expect(result.result.bestCandidate.instruction).toContain("```text\nexample\n```");expect(result.result.decisionEvents.map(event=>event.type)).toEqual(["proposal","accepted"]);
  await runGepaWorker(input);expect(input.handlers.reflect).toHaveBeenCalledTimes(1);expect(input.handlers.evaluate).toHaveBeenCalledTimes(4);
});
// Explicit opt-in only. A skipped case is not actual optimizer qualification.
it.skipIf(!process.env.MURAGE_GEPA_TEST_PYTHON)("runs the actual pinned GEPA Python worker with scripted reflection",async()=>{
  const input=fixture();input.command={executable:process.env.MURAGE_GEPA_TEST_PYTHON!,args:["-I",resolve("native/gepa/gepa-worker.py")],cwd:input.command.cwd,expectedPythonVersion:"3.13.13"};input.job.limits.wallMs=30000;
  let reflection=0;input.handlers.reflect=async()=>`\`\`\`\n${++reflection===1?"bad":"good"}\n\`\`\``;
  input.handlers.evaluate=async frame=>({outputs:frame.caseIds.map(()=>frame.candidate.instruction),scores:frame.caseIds.map(()=>frame.candidate.instruction==="seed"?0.5:frame.candidate.instruction==="bad"?0.25:1),trajectories:frame.captureTraces?frame.caseIds.map(()=>({feedback:"synthetic independently scored outcome"})):null});
  const result=await runGepaWorker(input);expect(result.result.bestCandidate).toEqual({instruction:"good"});expect(result.result.reflectionCalls).toBe(2);expect(result.result.decisionEvents.map(event=>event.type)).toEqual(["proposal","rejected","proposal","accepted"]);
},35000);
it.skipIf(!process.env.MURAGE_GEPA_TEST_PYTHON)("retains the seed after actual GEPA evaluates and rejects two unchanged reflections",async()=>{
  const input=fixture();input.command={executable:process.env.MURAGE_GEPA_TEST_PYTHON!,args:["-I",resolve("native/gepa/gepa-worker.py")],cwd:input.command.cwd,expectedPythonVersion:"3.13.13"};input.job.limits.wallMs=30000;
  input.handlers.reflect=async()=>"```\nseed\n```";
  input.handlers.evaluate=async frame=>({outputs:frame.caseIds.map(()=>"same observed outcome"),scores:frame.caseIds.map(()=>0.5),trajectories:frame.captureTraces?frame.caseIds.map(()=>({feedback:"unchanged observed outcome"})):null});
  const result=await runGepaWorker(input);expect(result.result).toMatchObject({bestCandidate:{instruction:"seed"},bestIndex:0,candidates:[{instruction:"seed"}],validationScores:[0.5],metricCalls:10,reflectionCalls:2});
  expect(result.result.decisionEvents.map(event=>event.type)).toEqual(["proposal","rejected","proposal","rejected"]);
},35000);
