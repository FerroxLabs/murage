// Qualification tests owner: win-sac-sign; enrolled controller transport and Windows collection owner: MAIN.
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { signingAuthorityFixture } from "./fixtures/windows-signing-authority.mjs";
import { receiptFixture } from "./fixtures/windows-signing-receipt.mjs";
import { peSha256 } from "./windows-pe-signing.mjs";
import { qualifyWindowsSigning } from "./windows-signing-qualify.mjs";
import { signingWorkflows } from "./fixtures/windows-signing-workflows.mjs";
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
async function fixture(){
  const authority=signingAuthorityFixture(),f=receiptFixture(roots,configuration=>{configuration.authority.staticLaunchSha256=authority.lock.launchSha256;});
  await f.build();
  const write=(name,bytes)=>{const file=path.join(f.root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return peSha256(bytes);};
  for(const row of f.coverage){
    const name=["gepa","app"].includes(row.scope)?`release/win-unpacked/${row.path}`:row.scope==="installer"?`release/${path.posix.basename(row.path)}`:`signing/retained/${row.path}`;
    write(name,fs.readFileSync(f.file(row.scope)));
  }
  const appManifestSha256=write("release/win-unpacked/resources/windows-sac-signing.json","fixture manifest\n");
  write("signing/windows-sac-release.json",JSON.stringify({schema:2,target:f.configuration.identity.target,sourceRevision:f.configuration.identity.sourceRevision,manifestSha256:appManifestSha256}));
  const gepaProjectionSha256=write("signing/gepa-projection.json","fixture projection\n"),zipSha256=write("release/Murage-1.0.19-win.zip","fixture zip\n");
  const result={...f.result(),appManifestSha256,gepaProjectionSha256,zipSha256};
  await f.writer.complete(f.receiptFile,result,async()=>{});
  write("signing/driver.json",fs.readFileSync(f.receiptFile));write("signing/authority.json",authority.bytes());
  const data={schema:1,kind:"windows-signing-output",identity:f.configuration.identity,
    receipt:{file:"signing/driver.json",sha256:peSha256(fs.readFileSync(f.receiptFile)),configuration:f.configuration,coverage:f.coverage},files:[]};
  const save=(pair)=>{
    data.files=[];
    const walk=name=>{for(const row of fs.readdirSync(path.join(f.root,name),{withFileTypes:true})){
      const file=`${name}/${row.name}`;
      if(row.isDirectory())walk(file);else if(!["signing/authority.json","signing/output.json"].includes(file))data.files.push({path:file,sha256:peSha256(fs.readFileSync(path.join(f.root,file)))});
    }};walk("release");walk("signing");
    write("signing/output.json",authority.envelope(data,pair));
  };
  save();return {...f,authority,data,save,write,options:{root:f.root,lockSha256:peSha256(authority.bytes()),identity:f.configuration.identity}};
}
it("qualifies the complete emitted graph and exact bytes only through the independent controller signature",async()=>{
  const f=await fixture(),result=await qualifyWindowsSigning(f.options);
  expect(result.driver.complete).toBe(true);expect(result.gepaSha256).toBe(f.data.files.find(row=>row.path==="signing/gepa-projection.json").sha256);
});
it.each(["changed bytes","extra DLL","omitted payload","wrong identity","wrong lock","extraction key","receipt mismatch"])("refuses qualification with %s",async mode=>{
  const f=await fixture();
  if(mode==="changed bytes")fs.appendFileSync(path.join(f.root,"release/Murage-1.0.19-setup.exe"),"changed");
  if(mode==="extra DLL")f.write("release/extra.dll","fixture");
  if(mode==="omitted payload")fs.unlinkSync(path.join(f.root,"release/win-unpacked/Murage.exe"));
  if(mode==="wrong identity")f.options.identity={...f.options.identity,runAttempt:"2"};
  if(mode==="wrong lock")f.options.lockSha256="0".repeat(64);
  if(mode==="extraction key")f.save(f.authority.extractionKey);
  if(mode==="receipt mismatch"){
    const receipt=JSON.parse(fs.readFileSync(path.join(f.root,"signing/driver.json")));receipt.complete=false;
    f.data.receipt.sha256=f.write("signing/driver.json",JSON.stringify(receipt));f.save();
  }
  await expect(qualifyWindowsSigning(f.options)).rejects.toThrow();
});
it("both workflows wait for protected signing and require enforcing SAC before release staging",()=>{
  const workflows=signingWorkflows(),release=workflows["release.yml"],pack=workflows["package-win.yml"];
  for(const [config,original]of [[release,"windows"],[pack,"package"]]){
    expect(config.jobs[original].needs).toContain("windows-signing");
    expect(config.jobs["windows-signing"].needs).toContain("windows-preparation");
    expect(config.jobs[original].steps.some(row=>row.run?.includes("windows-signing-qualify.mjs package"))).toBe(true);
    expect(config.jobs["windows-sac-qualification"].needs).toContain(original);
    expect(config.jobs["windows-sac-qualification"].steps.some(row=>row.run?.includes("--signing-output"))).toBe(true);
  }
  expect(release.jobs.stage.needs).toContain("windows-sac-qualification");
  expect(pack.jobs["windows-sac-qualification"].needs).toContain("stduser");
});
