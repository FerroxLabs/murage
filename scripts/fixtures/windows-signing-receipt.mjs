// Synthetic producer/builder fixture owner: win-sac-sign; real Windows witness owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { peSha256, signPinnedWindowsPe, verifyFrozenWindowsPe } from "../windows-pe-signing.mjs";
import { windowsSigningReceipt } from "../windows-signing-receipt.mjs";
import { fixturePeSource } from "./windows-pe-provenance.mjs";
import { unsignedPeFixture, appendPeFixtureCertificate } from "./windows-pe-signing.mjs";
export function receiptFixture(roots,configure=()=>{}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"signing-events-"));roots.push(root);
  const configuration={identity:{repositoryId:"1",workflowSha:"a".repeat(40),sourceRevision:"b".repeat(40),version:"1.0.19",target:"win32-x64",runId:"2",runAttempt:"1"},
    authority:Object.fromEntries(["staticLaunchSha256","runAuthorizationSha256","inputArtifactDigest","buildPlanSha256","checkerSha256","providerReceiptSha256","builderTreeSha256"].map(key=>[key,"c".repeat(64)]))};
  configuration.authority.inputArtifactId="3";
  const coverage=[{scope:"gepa",path:"resources/gepa-worker/gepa-worker.exe",producerRequired:false},
    {scope:"app",path:"Murage.exe",producerRequired:true},{scope:"uninstaller",path:"artifacts/Uninstall Murage.exe",producerRequired:true},
    {scope:"transient",path:"artifacts/helper.exe",producerRequired:false},{scope:"installer",path:"artifacts/Murage-1.0.19-setup.exe",producerRequired:true}];
  configure(configuration,coverage);
  const writer=windowsSigningReceipt(configuration,coverage),calls=[],records=new Map(),details=new Map(),pins=new Map();
  const file=scope=>path.join(root,coverage.find(row=>row.scope===scope).path);
  const trust={authenticode:async file=>fs.readFileSync(file).readUInt32LE(232)?{status:"Valid",embedded:true,publisher:"Ferrox Labs, LLC",timestamp:true,leafCertificateSha256:"e".repeat(64)}:{status:"NotSigned"}};
  const produce=async scope=>{
    const row=coverage.find(row=>row.scope===scope),target=file(scope);fs.mkdirSync(path.dirname(target),{recursive:true});
    const bytes=scope==="transient"?appendPeFixtureCertificate(unsignedPeFixture()):unsignedPeFixture();fs.writeFileSync(target,bytes);
    pins.set(scope,fixturePeSource(row.path,bytes));
    if(row.producerRequired)await writer.producer(scope,row.path,async()=>{calls.push(`produce:${scope}`);return {inputDigests:{tool:"d".repeat(64)},outputDigests:{[row.path]:peSha256(bytes)}};});
  };
  const sign=async scope=>{
    const row=coverage.find(row=>row.scope===scope);
    details.set(scope,await writer.sign(scope,row.path,pins.get(scope).sourceSha256,async()=>{
      calls.push(`sign:${scope}`);const record=await signPinnedWindowsPe(file(scope),pins.get(scope),trust,async target=>{calls.push(`provider:${scope}`);fs.writeFileSync(target,appendPeFixtureCertificate(fs.readFileSync(target)));return true;});
      records.set(scope,record);return record;
    }));
  };
  const freeze=async scope=>writer.freeze(scope,async()=>{
    calls.push(`freeze:${scope}`);await verifyFrozenWindowsPe(file(scope),pins.get(scope),records.get(scope),trust);
    return {[records.get(scope).path]:records.get(scope).finalSha256};
  });
  const prepare=async scope=>{await produce(scope);await sign(scope);await freeze(scope);};
  const build=async()=>{
    await prepare("gepa");
    await writer.package("app",async()=>{calls.push("package:app");await prepare("app");await prepare("uninstaller");await prepare("transient");
      await writer.package("installer",async()=>{calls.push("package:installer");await prepare("installer");});});
    await writer.packageComplete(async()=>{calls.push("package:complete");});
  };
  const result=()=>({gepaProjectionSha256:"f".repeat(64),appManifestSha256:"a".repeat(64),installerName:"Murage-1.0.19-setup.exe",
    installerSha256:records.get("installer").finalSha256,uninstallerRecordSha256:details.get("uninstaller").recordSha256,zipSha256:"b".repeat(64),extractionResultSha256:"c".repeat(64)});
  const receiptFile=path.join(root,"receipt.json");
  const complete=()=>writer.complete(receiptFile,result(),async()=>{calls.push("verify:final");for(const [scope,record]of records)await verifyFrozenWindowsPe(file(scope),pins.get(scope),record,trust);});
  return {root,configuration,coverage,writer,calls,records,details,pins,trust,file,produce,sign,freeze,prepare,build,result,receiptFile,complete};
}
