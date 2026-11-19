// Late plans and compiler/NSIS adapters owner: win-sac-sign; authenticated controller handoff owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { peSha256 } from "./windows-pe-signing.mjs";
import { readWindowsBuildPlan, resolveWindowsBuildPlanStage, windowsStageReceiptConsumer } from "./windows-stage-receipts.mjs";
import { receiptFixture } from "./fixtures/windows-signing-receipt.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});

export async function latePlanFixture(){
  let data;
  const f=receiptFixture(roots,(configuration,coverage)=>{
    data={schema:3,...configuration.identity,outputs:[{path:"Murage.exe",component:"murage-app",stage:"resource-edited",producer:"builder-resource-editor",
      inputs:[{component:"electron",sha256:"d".repeat(64)},{component:"age",fromEvent:{scope:"gepa",path:coverage[0].path,event:"freeze"}}],
      tools:[{component:"resource-editor",sha256:"e".repeat(64)}],transformations:["resource-edit"],publishers:["Ferrox Labs, LLC"]}]};
    configuration.authority.buildPlanSha256=peSha256(JSON.stringify(data));
  }),identity=f.configuration.identity;
  const file=path.join(f.root,"late-plan.json");
  const load=async()=>{fs.writeFileSync(file,JSON.stringify(data));return readWindowsBuildPlan(file,peSha256(fs.readFileSync(file)),identity);};
  return {...f,data,load,plan:await load()};
}
it("resolves only already-frozen session events and preserves concrete receipt input equality",async()=>{
  const f=await latePlanFixture();await f.prepare("gepa");
  const resolved=resolveWindowsBuildPlanStage(f.plan,"Murage.exe",f.writer),output=resolved.outputs[0];
  expect(resolved.schema).toBe(2);expect(resolved.parentPlanSha256).toBe(f.plan.sha256);
  expect(output.inputs[0]).toEqual(f.data.outputs[0].inputs[0]);
  expect(output.inputs[1]).toEqual({component:"age",sha256:f.records.get("gepa").finalSha256});
  expect(resolved.predecessors[0].eventSha256).toMatch(/^[a-f0-9]{64}$/);
  const receipt={schema:2,...f.configuration.identity,planSha256:resolved.sha256,parentPlanSha256:resolved.parentPlanSha256,predecessors:resolved.predecessors,
    path:output.path,stage:output.stage,producer:output.producer,preSignSha256:"f".repeat(64),inputs:output.inputs,tools:output.tools,transformations:output.transformations};
  const receiptFile=path.join(f.root,"stage-receipt.json");
  const producer=vi.fn(async()=>{fs.writeFileSync(receiptFile,JSON.stringify(receipt));return {file:receiptFile,sha256:peSha256(fs.readFileSync(receiptFile))};});
  const consumer=windowsStageReceiptConsumer(f.plan,new Map([[output.producer,producer]]),f.writer);
  expect((await consumer.consume(output.path,output.stage)).inputs).toEqual(output.inputs);
  expect(producer).toHaveBeenCalledWith({path:output.path,stage:output.stage,planSha256:resolved.sha256});
  consumer.assertComplete();
});
export const lateInputViolations=[
  ["both hash and event",input=>{input.sha256="f".repeat(64);}],["signedHere resolution",input=>{input.fromEvent={signedHere:true};}],
  ["future sign event",input=>{input.fromEvent.event="sign";}],["self cycle",input=>{input.fromEvent.path="Murage.exe";}],
  ["unknown scope",input=>{input.fromEvent.scope="arbitrary";}],["traversal",input=>{input.fromEvent.path="../age.exe";}],
  ["unexpected authority field",input=>{input.fromEvent.pin="e".repeat(64);}],["missing component",input=>{delete input.component;}],
];
it.each(lateInputViolations)("rejects %s declarations before producer dispatch",async(_name,mutate)=>{
  const f=await latePlanFixture();mutate(f.data.outputs[0].inputs[1]);await expect(f.load()).rejects.toThrow();
});
it.each(["missing freeze","wrong path","wrong scope","other attempt","other run","fake session","poisoned session"])("rejects %s predecessors with zero producer calls",async mode=>{
  const f=await latePlanFixture();let session=f.writer;
  if(mode!=="missing freeze")await f.prepare("gepa");
  if(mode==="wrong path")f.data.outputs[0].inputs[1].fromEvent.path="resources/gepa-worker/other.exe";
  if(mode==="wrong scope")f.data.outputs[0].inputs[1].fromEvent.scope="app";
  if(mode==="other attempt"){f.data.runAttempt="2";f.configuration.identity.runAttempt="2";}
  if(mode==="other run"){f.data.runId="99";f.configuration.identity.runId="99";}
  if(mode==="fake session")session={frozenInput:()=>({sha256:"e".repeat(64)})};
  if(mode==="poisoned session")await expect(f.writer.sign("gepa","unknown.exe","d".repeat(64),vi.fn())).rejects.toThrow();
  const plan=await f.load(),producer=vi.fn(),consumer=windowsStageReceiptConsumer(plan,new Map([["builder-resource-editor",producer]]),session);
  await expect(consumer.consume("Murage.exe","resource-edited")).rejects.toThrow();expect(producer).not.toHaveBeenCalled();
});
it.each(["inputs","parent","predecessor","attempt"])("rejects changed resolved receipt %s with the same immutable parent plan",async mode=>{
  const f=await latePlanFixture();await f.prepare("gepa");const resolved=resolveWindowsBuildPlanStage(f.plan,"Murage.exe",f.writer),output=resolved.outputs[0];
  const receipt={schema:2,...f.configuration.identity,planSha256:resolved.sha256,parentPlanSha256:resolved.parentPlanSha256,predecessors:resolved.predecessors,
    path:output.path,stage:output.stage,producer:output.producer,preSignSha256:"f".repeat(64),inputs:structuredClone(output.inputs),tools:output.tools,transformations:output.transformations};
  if(mode==="inputs")receipt.inputs[1].sha256="a".repeat(64);
  if(mode==="parent")receipt.parentPlanSha256="a".repeat(64);
  if(mode==="predecessor")receipt.predecessors=[];
  if(mode==="attempt")receipt.runAttempt="2";
  const file=path.join(f.root,"bad-receipt.json");fs.writeFileSync(file,JSON.stringify(receipt));
  const consumer=windowsStageReceiptConsumer(f.plan,new Map([[output.producer,async()=>({file,sha256:peSha256(fs.readFileSync(file))})]]),f.writer);
  await expect(consumer.consume(output.path,output.stage)).rejects.toThrow("WINDOWS_BUILD_RECEIPT_IDENTITY_INVALID");
  expect(()=>consumer.assertComplete()).toThrow("WINDOWS_BUILD_RECEIPTS_INCOMPLETE");
});
it.each(["sourceRevision","runId","runAttempt"])("checks predecessor %s independently of its parent-plan digest",async key=>{
  const f=await latePlanFixture();await f.prepare("gepa");
  expect(()=>resolveWindowsBuildPlanStage({...f.plan,[key]:"different"},"Murage.exe",f.writer)).toThrow("WINDOWS_BUILD_PLAN_PREDECESSOR_IDENTITY_INVALID");
});
it("refuses frozen inputs from an unrelated parent plan even with the same run identity",async()=>{
  const f=await latePlanFixture();await f.prepare("gepa");
  expect(()=>resolveWindowsBuildPlanStage({...f.plan,sha256:"f".repeat(64)},"Murage.exe",f.writer)).toThrow("WINDOWS_BUILD_PLAN_PREDECESSOR_BINDING_INVALID");
});
it("keeps the authenticated plan and its concrete resolution immutable through producer dispatch",async()=>{
  const f=await latePlanFixture();await f.prepare("gepa");
  expect(()=>{f.plan.outputs[0].inputs[0].sha256="f".repeat(64);}).toThrow(TypeError);
  const resolved=resolveWindowsBuildPlanStage(f.plan,"Murage.exe",f.writer);
  expect(()=>{resolved.outputs[0].inputs[1].sha256="f".repeat(64);}).toThrow(TypeError);
  expect(()=>{resolved.predecessors.pop();}).toThrow(TypeError);
});
