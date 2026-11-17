// Extraction contract tests owner: win-sac-sign; actual VM/standard-user/SAC witness owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ZipFile } from "yazl";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { windowsExtractionFixture, windowsExtractionFixtureHelper } from "./fixtures/windows-extraction.mjs";
import { extractWindowsInstaller, materializeWindowsExtraction } from "./windows-extraction-contract.mjs";
import { peSha256 } from "./windows-pe-signing.mjs";
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"extraction-contract-"));roots.push(root);let control;
  const extractor=windowsExtractionFixture(root,value=>{control=value;}),installer=path.join(root,"installer.exe");
  fs.writeFileSync(installer,JSON.stringify({"Murage.exe":Buffer.from("fixture payload").toString("base64")}));
  const identity={repositoryId:"1",workflowSha:"a".repeat(40),sourceRevision:"b".repeat(40),version:"1.0.19",target:"win32-x64",runId:"2",runAttempt:"1"};
  const options={extractor,installer,installerSha256:peSha256(fs.readFileSync(installer)),output:path.join(root,"payload"),identity,publication:{runId:"3",runAttempt:"2"},
    allowedTransient:[{path:"artifacts/helper.exe",sha256:peSha256(windowsExtractionFixtureHelper())}]};
  const save=()=>{fs.writeFileSync(extractor.bundleFile,JSON.stringify(control.bundle));extractor.bundleSha256=peSha256(fs.readFileSync(extractor.bundleFile));};
  const resign=(file,payload,key=control.extractionKey,id="extraction")=>{
    const bytes=Buffer.from(JSON.stringify(payload));fs.writeFileSync(file,JSON.stringify({keyId:id,payload:bytes.toString("base64"),payloadSha256:peSha256(bytes),signature:sign(null,bytes,key.privateKey).toString("base64")}));
  };
  return {root,control,options,save,resign};
}
it("authenticates a complete bundle, distinct keys, nonce and build/publication identity before materializing the signed archive",async()=>{
  const f=fixture(),result=await extractWindowsInstaller(f.options);
  expect(result.files).toEqual([{path:"Murage.exe",sha256:peSha256("fixture payload")}]);
  expect(fs.readFileSync(path.join(f.options.output,"Murage.exe"),"utf8")).toBe("fixture payload");
});
it.each(["same key","same key ID","wrong key algorithm","same audience","same subject","changed client","extra bundle file","changed recipe","verifier substitution"])("rejects %s before starting the extraction client",async mode=>{
  const f=fixture(),{bundle,directory}=f.control;
  if(mode==="same key")bundle.controllerKeys.extractionResult.publicKey=bundle.controllerKeys.runAuthorization.publicKey;
  if(mode==="same key ID")bundle.controllerKeys.extractionResult.id=bundle.controllerKeys.runAuthorization.id;
  if(mode==="wrong key algorithm")bundle.controllerKeys.extractionResult.publicKey=generateKeyPairSync("ec",{namedCurve:"prime256v1"}).publicKey.export({type:"spki",format:"pem"}).toString();
  if(mode==="same audience")bundle.oidc.extractionAudience=bundle.oidc.vmControlAudience;
  if(mode==="same subject")bundle.oidc.extractionSubject=bundle.oidc.vmControlSubject;
  if(mode==="changed client")fs.appendFileSync(f.options.extractor.file,"changed");
  if(mode==="extra bundle file")fs.writeFileSync(path.join(directory,"extra.mjs"),"fixture");
  if(mode==="changed recipe")fs.appendFileSync(path.join(directory,"recipe.json")," ");
  if(mode==="verifier substitution"){
    fs.writeFileSync(path.join(directory,"verifier.mjs"),"fixture substituted verifier");bundle.files.find(row=>row.path==="verifier.mjs").sha256=peSha256("fixture substituted verifier");
  }
  f.save();const run=vi.fn();await expect(extractWindowsInstaller(f.options,{run})).rejects.toThrow();expect(run).not.toHaveBeenCalled();
});
it.each(["nonce","installer","build","publication","run key","not destroyed","admin","network","launch","archive"])("rejects a controller result with wrong %s before materialization",async mode=>{
  const f=fixture();
  const run=(command,args,options)=>{
    execFileSync(command,args,options);const resultFile=args[args.indexOf("--result")+1],value=JSON.parse(fs.readFileSync(resultFile)),result=JSON.parse(Buffer.from(value.payload,"base64"));
    if(mode==="nonce")result.nonce="f".repeat(64);
    if(mode==="installer")result.installerSha256="f".repeat(64);
    if(mode==="build")result.identity.runId="99";
    if(mode==="publication")result.publication.runId="99";
    if(mode==="not destroyed")result.vm.destroyed=false;
    if(mode==="admin")result.vm.standardUser=false;
    if(mode==="network")result.vm.generalGuestNetwork=true;
    if(mode==="launch")result.vm.launchAfterInstall=true;
    if(mode==="archive")fs.appendFileSync(args[args.indexOf("--archive")+1],"changed");
    f.resign(resultFile,result,mode==="run key"?f.control.runKey:f.control.extractionKey,mode==="run key"?"run":"extraction");
  };
  await expect(extractWindowsInstaller(f.options,{run})).rejects.toThrow();expect(fs.existsSync(f.options.output)).toBe(false);
});
it("rehashes the client bundle after execution and never accepts a materialized directory supplied by the client",async()=>{
  const f=fixture();
  await expect(extractWindowsInstaller(f.options,{run(command,args,options){execFileSync(command,args,options);fs.mkdirSync(f.options.output);}})).rejects.toThrow();
  const g=fixture();await expect(extractWindowsInstaller(g.options,{run(command,args,options){execFileSync(command,args,options);fs.appendFileSync(command," ");}})).rejects.toThrow();
});
it("refuses an oversized installer before reading its body or invoking the client",async()=>{
  const f=fixture();fs.truncateSync(f.options.installer,2*1024**3+1);const run=vi.fn();
  await expect(extractWindowsInstaller(f.options,{run})).rejects.toThrow();expect(run).not.toHaveBeenCalled();
});
it.each(["traversal","ADS","case collision","symlink"])("refuses an archive with %s",async mode=>{
  const f=fixture(),archive=path.join(f.root,"archive.zip"),zip=new ZipFile(),chunks=[],done=new Promise(resolve=>{zip.outputStream.on("data",chunk=>chunks.push(chunk));zip.outputStream.on("end",resolve);});
  zip.addBuffer(Buffer.from("fixture"),"file.exe",{mode:mode==="symlink"?0o120777:0o100644});zip.end();await done;fs.writeFileSync(archive,Buffer.concat(chunks));
  const files=mode==="traversal"?[{path:"../file.exe",sha256:peSha256("fixture")}]:mode==="ADS"?[{path:"file.exe:stream",sha256:peSha256("fixture")}]:
    mode==="case collision"?[{path:"file.exe",sha256:peSha256("fixture")},{path:"FILE.exe",sha256:peSha256("fixture")}]:[{path:"file.exe",sha256:peSha256("fixture")}];
  await expect(materializeWindowsExtraction(archive,f.options.output,files)).rejects.toThrow();
});
it.each(["directory casing","file ancestor","directory entry casing"])("refuses an archive with conflicting %s",async mode=>{
  const f=fixture(),archive=path.join(f.root,"archive.zip"),zip=new ZipFile(),chunks=[];
  const done=new Promise(resolve=>{zip.outputStream.on("data",chunk=>chunks.push(chunk));zip.outputStream.on("end",resolve);});
  const names=mode==="directory casing"?["Dir/a.exe","dir/b.dll"]:mode==="file ancestor"?["a.exe","A.EXE/b.dll"]:["dir/a.exe"];
  if(mode==="directory entry casing")zip.addEmptyDirectory("DIR");
  for(const name of names)zip.addBuffer(Buffer.from("fixture"),name);
  zip.end();await done;fs.writeFileSync(archive,Buffer.concat(chunks));
  await expect(materializeWindowsExtraction(archive,f.options.output,names.map(path=>({path,sha256:peSha256("fixture")})))).rejects.toThrow();
});
