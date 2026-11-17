// Late input/graph tests owner: win-sac-sign; production late-input plan owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { receiptFixture } from "./fixtures/windows-signing-receipt.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { peSha256 } from "./windows-pe-signing.mjs";
import { readWindowsBuildPlan, resolveWindowsBuildPlanStage } from "./windows-stage-receipts.mjs";
import { verifyWindowsSigningReceipt } from "./windows-signing-receipt.mjs";
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
async function fixture(){
  let data;
  const f=receiptFixture(roots,(configuration)=>{
    data={schema:3,...configuration.identity,outputs:[{path:"resources/backup-tools/x64/murage-backup-age.exe",component:"backup-transport",
      producer:"backup-transport-final",stage:"native-compiled",inputs:[{component:"age",fromEvent:{scope:"app",path:"Murage.exe",event:"freeze-input"}}],
      tools:[{component:"compiler",sha256:"e".repeat(64)}],transformations:["compile"],publishers:["Ferrox Labs, LLC"]}]};
    configuration.authority.buildPlanSha256=peSha256(JSON.stringify(data));
  });
  const file=path.join(f.root,"late-input.json");fs.writeFileSync(file,JSON.stringify(data));
  const plan=await readWindowsBuildPlan(file,peSha256(fs.readFileSync(file)),f.configuration.identity);
  return {...f,plan};
}
it("resolves a signed input before app freeze without allowing installer packaging early",async()=>{
  const f=await fixture();await f.prepare("gepa");
  await f.writer.package("app",async()=>{
    await f.produce("app");await f.sign("app");
    expect(()=>resolveWindowsBuildPlanStage(f.plan,f.plan.outputs[0].path,f.writer)).toThrow();
    await f.writer.freezeInput("app","Murage.exe",async()=>({"Murage.exe":f.records.get("app").finalSha256}));
    expect(resolveWindowsBuildPlanStage(f.plan,f.plan.outputs[0].path,f.writer).outputs[0].inputs).toEqual([{component:"age",sha256:f.records.get("app").finalSha256}]);
    await f.freeze("app");await f.prepare("uninstaller");await f.prepare("transient");
    await f.writer.package("installer",async()=>f.prepare("installer"));
  });
  await f.writer.packageComplete(async()=>{});await f.complete();
  expect(()=>verifyWindowsSigningReceipt(fs.readFileSync(f.receiptFile),f.configuration,f.coverage)).not.toThrow();
});
it.each(["unsigned","wrong scope","unknown path","duplicate","scope already frozen"])("rejects %s input freezes before work",async mode=>{
  const f=await fixture();await f.prepare("gepa");const work=vi.fn();
  await f.writer.package("app",async()=>{
    await f.produce("app");if(mode!=="unsigned")await f.sign("app");
    if(mode==="duplicate")await f.writer.freezeInput("app","Murage.exe",async()=>({"Murage.exe":f.records.get("app").finalSha256}));
    if(mode==="scope already frozen")await f.freeze("app");
    await expect(f.writer.freezeInput(mode==="wrong scope"?"uninstaller":"app",mode==="unknown path"?"unknown.exe":"Murage.exe",work)).rejects.toThrow();
  });expect(work).not.toHaveBeenCalled();
});
it("checks input freeze bytes and never substitutes it for an app freeze",async()=>{
  const f=await fixture();await f.prepare("gepa");const compile=vi.fn();
  await expect(f.writer.package("app",async()=>{
    await f.produce("app");await f.sign("app");
    await f.writer.freezeInput("app","Murage.exe",async()=>({"Murage.exe":f.records.get("app").finalSha256}));
    await f.prepare("uninstaller");await f.prepare("transient");await f.writer.package("installer",compile);
  })).rejects.toThrow();expect(compile).not.toHaveBeenCalled();
  const r=await fixture();await r.prepare("gepa");
  await r.writer.package("app",async()=>{
    await r.produce("app");await r.sign("app");
    await expect(r.writer.freezeInput("app","Murage.exe",async()=>({"Murage.exe":"f".repeat(64)}))).rejects.toThrow();
  });
  expect(()=>resolveWindowsBuildPlanStage(r.plan,r.plan.outputs[0].path,r.writer)).toThrow();
});
