// One-shot/VM orchestration witness owner: win-sac-sign; actual controller/Windows execution owner: MAIN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sign } from "node:crypto";
import { ZipFile } from "yazl";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import { windowsExtractionFixture, windowsExtractionFixtureHelper } from "./fixtures/windows-extraction.mjs";
import { readWindowsExtractionContract, extractWindowsInstaller } from "./windows-extraction-contract.mjs";
import { peSha256 } from "./windows-pe-signing.mjs";
import { windowsExtractionCapability, windowsExtractionController, windowsExtractionSocket, requestWindowsExtractionSocket, runWindowsExtractionBootstrap } from "./windows-extraction-bootstrap.mjs";
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);});
async function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"extraction-capability-"));roots.push(root);
  let control;const extractor=windowsExtractionFixture(root,value=>{control=value;});
  control.bundle.controller={endpoint:"https://controller.example.invalid/extraction/",oidcRequestOrigin:"https://oidc.example.invalid"};
  fs.writeFileSync(extractor.bundleFile,JSON.stringify(control.bundle));extractor.bundleSha256=peSha256(fs.readFileSync(extractor.bundleFile));
  const contract=await readWindowsExtractionContract(extractor);
  const installer=Buffer.from("fixture installer"),request={schema:1,kind:"windows-install-extraction",nonce:"c".repeat(64),installerSha256:peSha256(installer),
    identity:{repositoryId:"1",workflowSha:"a".repeat(40),sourceRevision:"b".repeat(40),version:"1.0.19",target:"win32-x64",runId:"2",runAttempt:"1"},publication:{runId:"3",runAttempt:"1"}};
  const cloud={create:vi.fn(async({id,recipe,expiresAt})=>({id,...recipe,expiresAt})),deliverInstaller:vi.fn(async()=>{}),install:vi.fn(async()=>{}),
    collect:vi.fn(async()=>({archive:Buffer.from("fixture archive"),files:[{path:"Murage.exe",sha256:"d".repeat(64)}],
      transientFiles:[{path:"artifacts/helper.exe",sha256:peSha256(windowsExtractionFixtureHelper())}]})),destroy:vi.fn(async()=>{})};
  const signResult=vi.fn(async result=>{
    const bytes=Buffer.from(JSON.stringify(result));return Buffer.from(JSON.stringify({keyId:"extraction",payload:bytes.toString("base64"),payloadSha256:peSha256(bytes),
      signature:sign(null,bytes,control.extractionKey.privateKey).toString("base64")}));
  }),verifyOidc=vi.fn(async()=>true);
  const controller=windowsExtractionController(contract,{verifyOidc,cloud,signResult});
  return {root,contract,extractor,installer,request,cloud,controller,verifyOidc,signResult};
}
it("uses separate extraction and VM-control audiences, destroys the guest before signing, and never puts a capability in the guest",async()=>{
  const f=await fixture(),idToken=vi.fn(async()=>"fixture-oidc"),authorize=vi.fn(({token,audience,subject,...request})=>f.controller.authorize({token,audience,subject,request}));
  const capability=windowsExtractionCapability(f.request,f.contract,{idToken,authorize,extract:args=>f.controller.extract(args)});
  const result=await capability.consume(f.request,f.installer);
  expect(idToken).toHaveBeenCalledWith(f.contract.oidc.extractionAudience);expect(f.cloud.create.mock.calls[0][0].oidcAudience).toBe(f.contract.oidc.vmControlAudience);
  expect(f.verifyOidc.mock.calls[0][1].installerSha256).toBe(f.request.installerSha256);
  expect(f.cloud.install.mock.calls[0][1]).toMatchObject({standardUser:true,launchAfterInstall:false,args:["/S","/currentuser",`/D=${f.contract.recipe.installDirectory}`]});
  expect(f.cloud.destroy.mock.invocationCallOrder[0]).toBeLessThan(f.signResult.mock.invocationCallOrder[0]);
  expect(JSON.stringify(f.cloud.create.mock.calls)).not.toContain("fixture-oidc");expect(Object.keys(result).sort()).toEqual(["archive","envelope"]);
  await expect(capability.consume(f.request,f.installer)).rejects.toThrow();expect(f.cloud.create).toHaveBeenCalledOnce();
});
it.each(["hash","nonce","publication","concurrent replay","expired","OIDC refusal"])("refuses %s without a second VM",async mode=>{
  const f=await fixture(),authorization={token:"fixture-oidc",audience:f.contract.oidc.extractionAudience,subject:f.contract.oidc.extractionSubject,request:f.request};
  if(mode==="OIDC refusal"){f.verifyOidc.mockResolvedValue(false);await expect(f.controller.authorize(authorization)).rejects.toThrow();expect(f.cloud.create).not.toHaveBeenCalled();return;}
  let controller=f.controller;
  if(mode==="expired"){
    let now=0;controller=windowsExtractionController(f.contract,{verifyOidc:f.verifyOidc,cloud:f.cloud,signResult:f.signResult,now:()=>now});
    const cap=await controller.authorize(authorization);now=300_001;
    await expect(controller.extract({capability:cap,request:f.request,installer:f.installer})).rejects.toThrow();expect(f.cloud.create).not.toHaveBeenCalled();return;
  }
  const cap=await controller.authorize(authorization),request=structuredClone(f.request);
  if(mode==="hash")request.installerSha256="f".repeat(64);
  if(mode==="nonce")request.nonce="f".repeat(64);
  if(mode==="publication")request.publication.runId="99";
  if(mode==="concurrent replay"){
    const first=controller.extract({capability:cap,request,installer:f.installer});
    await expect(controller.extract({capability:cap,request,installer:f.installer})).rejects.toThrow();await first;expect(f.cloud.create).toHaveBeenCalledOnce();return;
  }
  await expect(controller.extract({capability:cap,request,installer:f.installer})).rejects.toThrow();
  await expect(controller.extract({capability:cap,request:f.request,installer:f.installer})).rejects.toThrow();expect(f.cloud.create).not.toHaveBeenCalled();
});
it.each(["provision","install","collection","cleanup"])("does not sign a result after %s failure and always attempts VM destruction",async mode=>{
  const f=await fixture();
  if(mode==="provision")f.cloud.create.mockRejectedValue(Error("fixture provision stopped"));
  if(mode==="install")f.cloud.install.mockRejectedValue(Error("fixture install stopped"));
  if(mode==="collection")f.cloud.collect.mockRejectedValue(Error("fixture collector stopped"));
  if(mode==="cleanup")f.cloud.destroy.mockRejectedValue(Error("fixture destruction stopped"));
  const cap=await f.controller.authorize({token:"fixture",audience:f.contract.oidc.extractionAudience,subject:f.contract.oidc.extractionSubject,request:f.request});
  await expect(f.controller.extract({capability:cap,request:f.request,installer:f.installer})).rejects.toThrow();expect(f.cloud.destroy).toHaveBeenCalledOnce();expect(f.signResult).not.toHaveBeenCalled();
});
it("creates a 0600 same-user socket and refuses a same-UID request for a different installer before authorization",async()=>{
  const f=await fixture(),consume=vi.fn(),socketFile=path.join(f.root,"capability.sock");
  const socket=await windowsExtractionSocket(socketFile,f.request,f.installer,{consume});
  try{
    expect(fs.lstatSync(socketFile).mode&0o777).toBe(0o600);
    await expect(requestWindowsExtractionSocket(socketFile,{...f.request,installerSha256:"f".repeat(64)})).rejects.toThrow();expect(consume).not.toHaveBeenCalled();
  }finally{await socket.close();}
  expect(fs.existsSync(socketFile)).toBe(false);
});
it("refuses duplicate authorization and rejects a different installer digest at the OIDC/admission boundary",async()=>{
  const f=await fixture(),authorization={token:"fixture",audience:f.contract.oidc.extractionAudience,subject:f.contract.oidc.extractionSubject,request:f.request};
  await f.controller.authorize(authorization);await expect(f.controller.authorize(authorization)).rejects.toThrow();
  f.verifyOidc.mockImplementation(async(_token,binding)=>binding.installerSha256===f.request.installerSha256);
  await expect(f.controller.authorize({...authorization,request:{...f.request,nonce:"f".repeat(64),installerSha256:"f".repeat(64)}})).rejects.toThrow();
  expect(f.cloud.create).not.toHaveBeenCalled();
});
it("cancellation aborts the in-flight installation, destroys its VM and refuses further authorization",async()=>{
  const f=await fixture();let ready;const installing=new Promise(resolve=>{ready=resolve;});
  f.cloud.install.mockImplementation(async(_id,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener("abort",()=>reject(Error("fixture cancellation")),{once:true});ready();}));
  const authorization={token:"fixture",audience:f.contract.oidc.extractionAudience,subject:f.contract.oidc.extractionSubject,request:f.request};
  const capability=await f.controller.authorize(authorization),pending=f.controller.extract({capability,request:f.request,installer:f.installer});
  const failure=expect(pending).rejects.toThrow("fixture cancellation");await installing;f.controller.revoke();await failure;
  expect(f.cloud.destroy).toHaveBeenCalledOnce();expect(f.signResult).not.toHaveBeenCalled();await expect(f.controller.authorize(authorization)).rejects.toThrow();
});
it("holds installer and archive snapshots across asynchronous provisioning and destruction",async()=>{
  const f=await fixture(),original=Buffer.from(f.installer),archive=Buffer.from("fixture archive");
  let provision,ready;const created=new Promise(resolve=>{ready=resolve;});
  f.cloud.create.mockImplementation(options=>new Promise(resolve=>{provision=()=>resolve({id:options.id,...options.recipe,expiresAt:options.expiresAt});ready();}));
  f.cloud.collect.mockResolvedValue({archive,files:[{path:"Murage.exe",sha256:"d".repeat(64)}],transientFiles:[{path:"artifacts/helper.exe",sha256:peSha256(windowsExtractionFixtureHelper())}]});
  f.cloud.destroy.mockImplementation(async()=>{archive.fill(0);});
  const capability=await f.controller.authorize({token:"fixture",audience:f.contract.oidc.extractionAudience,subject:f.contract.oidc.extractionSubject,request:f.request});
  const pending=f.controller.extract({capability,request:f.request,installer:f.installer});await created;f.installer.fill(0);provision();
  const result=await pending;expect(f.cloud.deliverInstaller.mock.calls[0][1]).toEqual(original);expect(result.archive).toEqual(Buffer.from("fixture archive"));
});
it("runs the actual client, one-shot socket, bootstrap HTTP adapter and VM orchestration with only native/cloud boundaries faked",async()=>{
  const f=await fixture(),zip=new ZipFile(),chunks=[],done=new Promise(resolve=>{zip.outputStream.on("data",chunk=>chunks.push(chunk));zip.outputStream.on("end",resolve);});
  zip.addBuffer(Buffer.from("fixture payload"),"installed/Murage.exe");zip.addBuffer(windowsExtractionFixtureHelper(),"transient/artifacts/helper.exe");zip.end();await done;
  const transientFiles=[{path:"artifacts/helper.exe",sha256:peSha256(windowsExtractionFixtureHelper())}];
  f.cloud.collect.mockResolvedValue({archive:Buffer.concat(chunks),files:[{path:"Murage.exe",sha256:peSha256("fixture payload")}],transientFiles});
  const fetchImpl=vi.fn(async(url,options)=>{
    url=new URL(url);
    if(url.origin==="https://oidc.example.invalid"){
      expect(url.searchParams.get("audience")).toBe(f.contract.oidc.extractionAudience);
      expect(options.headers.Authorization).toBe("Bearer fixture-request-token");return new Response(JSON.stringify({value:"fixture-id-token"}));
    }
    expect(url.origin).toBe("https://controller.example.invalid");
    if(url.pathname.endsWith("/capabilities")){
      expect(options.headers.Authorization).toBe("Bearer fixture-id-token");
      const capability=await f.controller.authorize({token:"fixture-id-token",...JSON.parse(options.body)});
      return new Response(JSON.stringify({capability}));
    }
    const result=await f.controller.extract({capability:options.headers.Authorization.slice(7),
      request:JSON.parse(Buffer.from(options.headers["X-Murage-Extraction-Request"],"base64")),installer:options.body});
    return new Response(JSON.stringify({archive:result.archive.toString("base64"),envelope:result.envelope.toString("base64")}));
  });
  const installer=path.join(f.root,"installer.exe");fs.writeFileSync(installer,f.installer);
  const output=path.join(f.root,"payload");
  const result=await extractWindowsInstaller({extractor:f.extractor,installer,installerSha256:peSha256(f.installer),output,identity:f.request.identity,publication:f.request.publication,allowedTransient:transientFiles},{
    run:(_command,args,options)=>runWindowsExtractionBootstrap(args,{clientFile:f.extractor.file,fetchImpl,env:{...options.env,
      ACTIONS_ID_TOKEN_REQUEST_URL:"https://oidc.example.invalid/token",ACTIONS_ID_TOKEN_REQUEST_TOKEN:"fixture-request-token"}}),
  });
  expect(result.files).toHaveLength(1);expect(fs.readFileSync(path.join(output,"Murage.exe"),"utf8")).toBe("fixture payload");
  expect(f.cloud.create).toHaveBeenCalledOnce();expect(f.cloud.destroy).toHaveBeenCalledOnce();expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(`${output}.sock`)).toBe(false);
});
