// One-shot bootstrap and VM orchestration owner: win-sac-sign; OIDC verifier, cloud adapter and controller deployment owner: MAIN.
import { randomBytes } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { chmod, lstat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";
import { readWindowsExtractionContract, validateWindowsExtractionRequest, validateWindowsExtractionRecipe } from "./windows-extraction-contract.mjs";

const fail=()=>{throw Error("WINDOWS_EXTRACTION_CAPABILITY_REJECTED");};
const encode=value=>JSON.stringify(value,(_key,row)=>row&&typeof row==="object"&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>encode(a)===encode(b);

/** Dependencies are controller-installed code, never run-manifest modules.
 * Tokens and capabilities stay in this closure and never enter a guest. */
export function windowsExtractionCapability(expected,contract,{idToken,authorize,extract}) {
  const binding=structuredClone(expected),oidc=structuredClone(contract.oidc);let used=false;
  validateWindowsExtractionRequest(binding);
  Object.freeze(binding.identity);Object.freeze(binding.publication);Object.freeze(binding);
  if(!/^[a-f0-9]{64}$/.test(binding.installerSha256??"") || !/^[a-f0-9]{64}$/.test(binding.nonce??"")
    || oidc.extractionAudience===oidc.vmControlAudience || oidc.extractionSubject===oidc.vmControlSubject)fail();
  return Object.freeze({async consume(request,installer){
    if(used)fail();used=true;
    if(!Buffer.isBuffer(installer)||installer.length>2*1024**3)fail();
    installer=Buffer.from(installer);
    if(!same(request,binding)||peSha256(installer)!==binding.installerSha256)fail();
    let token,capability;
    try{
      token=await idToken(oidc.extractionAudience);
      capability=await authorize({token,audience:oidc.extractionAudience,subject:oidc.extractionSubject,...binding});
      if(typeof capability!=="string"||!capability||capability.length>8192)fail();
      const result=await extract({capability,request:binding,installer});
      if(!Buffer.isBuffer(result?.archive)||!Buffer.isBuffer(result?.envelope))fail();
      return {archive:result.archive,envelope:result.envelope};
    }finally{token=undefined;capability=undefined;}
  }});
}

/** A same-UID caller still cannot select a second installer. The socket carries
 * only the public request; the one-shot capability is never a socket response. */
export async function windowsExtractionSocket(socketFile,expected,installer,capability) {
  let connection,closed=false,accepted=false,ready=false;
  const server=createServer(socket=>{
    if(!ready||accepted){socket.destroy();return;}accepted=true;connection=socket;
    let input="",submitted=false;socket.on("error",()=>{});socket.setEncoding("utf8");socket.setTimeout(300_000,()=>socket.destroy());
    socket.on("data",chunk=>{
      if(submitted){socket.destroy();return;}
      input+=chunk;if(Buffer.byteLength(input)>16_384){socket.destroy();return;}
      if(!input.endsWith("\n"))return;
      const data=input;input="";submitted=true;
      Promise.resolve().then(()=>{
        const request=JSON.parse(data);
        if(!same(request,expected))fail();
        return capability.consume(request,installer);
      }).then(result=>{server.emit("extraction",result);socket.end("{\"ok\":true}\n");},()=>socket.end("{\"ok\":false}\n"));
    });
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(socketFile,resolve);});
  try{
    await chmod(socketFile,0o600);
    const stat=await lstat(socketFile);if(!stat.isSocket()||(stat.mode&0o777)!==0o600||stat.uid!==process.getuid())fail();
    ready=true;
    return {server,async close(){
      if(closed)return;closed=true;connection?.destroy();
      await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      try{const current=await lstat(socketFile);if(current.dev!==stat.dev||current.ino!==stat.ino||!current.isSocket())fail();await unlink(socketFile);}
      catch(error){if(error.code!=="ENOENT")throw error;}
    }};
  }catch(error){connection?.destroy();await new Promise(resolve=>server.close(resolve));throw error;}
}

export async function requestWindowsExtractionSocket(socketFile,request) {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(socketFile);let reply="";
    socket.setEncoding("utf8");socket.setTimeout(300_000,()=>socket.destroy(Error("WINDOWS_EXTRACTION_CAPABILITY_REJECTED")));
    socket.on("error",reject);socket.on("connect",()=>socket.write(JSON.stringify(request)+"\n"));
    socket.on("data",chunk=>{reply+=chunk;if(reply.length>1024)socket.destroy(Error("WINDOWS_EXTRACTION_CAPABILITY_REJECTED"));});
    socket.on("end",()=>{try{if(!same(JSON.parse(reply),{ok:true}))fail();resolve();}catch(error){reject(error);}finally{socket.destroy();}});
  });
}

/** The controller hashes and forwards blobs. Only the enrolled guest collector
 * inspects installed files; Linux subsequently parses the authenticated ZIP. */
export function windowsInstallVmController(contract,{cloud,signResult}) {
  const recipe=Object.freeze(structuredClone(contract.recipe)),oidc=Object.freeze(structuredClone(contract.oidc));
  validateWindowsExtractionRecipe(recipe);
  if(oidc.extractionAudience===oidc.vmControlAudience || oidc.extractionSubject===oidc.vmControlSubject)fail();
  return async(request,installer,{signal}={})=>{
    if(!Buffer.isBuffer(installer)||installer.length>2*1024**3)fail();
    request=structuredClone(request);installer=Buffer.from(installer);
    validateWindowsExtractionRequest(request);
    if(peSha256(installer)!==request.installerSha256)fail();
    const id=randomBytes(32).toString("hex"),expiresAt=Date.now()+300_000;
    const deadline=AbortSignal.timeout(300_000),operation=signal?AbortSignal.any([signal,deadline]):deadline;let collected;
    try{
      operation.throwIfAborted();
      const admission=await cloud.create({id,recipe,oidcAudience:oidc.vmControlAudience,oidcSubject:oidc.vmControlSubject,
        customData:false,extensions:false,runCommand:false,winrm:false,expiresAt,signal:operation});
      if(!same(admission,{id,...recipe,expiresAt}))fail();operation.throwIfAborted();
      await cloud.deliverInstaller(id,installer,request.installerSha256,{signal:operation});operation.throwIfAborted();
      await cloud.install(id,{directory:recipe.installDirectory,args:["/S","/currentuser",`/D=${recipe.installDirectory}`],standardUser:true,launchAfterInstall:false,signal:operation});
      operation.throwIfAborted();
      collected=await cloud.collect(id,{directory:recipe.installDirectory,channel:"controller",includeInstalledUninstaller:true,includeTransientImages:true,maxBytes:2*1024**3,signal:operation});
      if(!Buffer.isBuffer(collected?.archive)||collected.archive.length>2*1024**3||!Array.isArray(collected.files)||!collected.files.length||!Array.isArray(collected.transientFiles)||!collected.transientFiles.length)fail();
      collected={archive:Buffer.from(collected.archive),files:structuredClone(collected.files),transientFiles:structuredClone(collected.transientFiles)};
    }finally{await cloud.destroy(id);}
    operation.throwIfAborted();
    const result={...request,archiveSha256:peSha256(collected.archive),files:collected.files,transientFiles:collected.transientFiles,vm:{...recipe,destroyed:true}};
    const envelope=await signResult(result);
    operation.throwIfAborted();if(!Buffer.isBuffer(envelope))fail();
    return {archive:collected.archive,envelope};
  };
}

/** Controller HTTP handlers use these methods after their bounded body reader.
 * verifyOidc authenticates issuer/JWKS and protected publication/build identity;
 * a decoded JWT or a guest's own admission claim is not that implementation. */
export function windowsExtractionController(contract,{verifyOidc,cloud,signResult,now=Date.now}) {
  const oidc=structuredClone(contract.oidc),capabilities=new Map(),issued=new Set(),active=new Set(),install=windowsInstallVmController(contract,{cloud,signResult});let revoked=false;
  return Object.freeze({
    async authorize({token,audience,subject,request}) {
      validateWindowsExtractionRequest(request);
      if(revoked||audience!==oidc.extractionAudience||subject!==oidc.extractionSubject||typeof token!=="string"||!token)fail();
      const binding=structuredClone(request);
      Object.freeze(binding.identity);Object.freeze(binding.publication);Object.freeze(binding);
      const nonce=`${binding.identity.repositoryId}/${binding.publication.runId}/${binding.publication.runAttempt}/${binding.nonce}`;
      if(issued.has(nonce)||await verifyOidc(token,{audience,subject,...binding})!==true||revoked||issued.has(nonce))fail();
      issued.add(nonce);
      const capability=randomBytes(32).toString("hex");
      capabilities.set(capability,{request:binding,expiresAt:now()+300_000});
      return capability;
    },
    async extract({capability,request,installer}) {
      const selected=capabilities.get(capability);capabilities.delete(capability);
      if(revoked||!selected||selected.expiresAt<=now()||!same(selected.request,request)||peSha256(installer)!==request.installerSha256)fail();
      const cancellation=new AbortController();active.add(cancellation);
      try{return await install(request,installer,{signal:cancellation.signal});}finally{active.delete(cancellation);}
    },
    revoke(){revoked=true;capabilities.clear();issued.clear();for(const operation of active)operation.abort();},
  });
}

async function httpBytes(response,limit) {
  if(!response.ok)fail();const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)fail();chunks.push(chunk);}
  return Buffer.concat(chunks);
}

/** The installed bootstrap has only an extraction-scoped OIDC token. VM-control
 * OIDC and controller keys remain behind the controller's HTTP boundary. */
export async function runWindowsExtractionBootstrap(args,{env=process.env,fetchImpl=fetch,clientFile=process.argv[1]}={}) {
  if(Object.entries(env).some(([key,value])=>/^(?:AZURE_|RELEASES_PAT$|(?:WIN_)?CSC_|NODE_OPTIONS$)/i.test(key)&&value))fail();
  const names=["--installer","--output","--request","--result","--archive","--contract","--contract-sha256"];
  // argv includes the seven named pairs; unknown/duplicate switches are errors.
  if(args.length!==names.length*2)fail();
  const values=new Map();for(let index=0;index<args.length;index+=2){if(!names.includes(args[index])||values.has(args[index]))fail();values.set(args[index],args[index+1]);}
  const file=path.resolve(clientFile),bundleFile=values.get("--contract"),bundleSha256=values.get("--contract-sha256");
  const extractor={file,sha256:peSha256((await readWindowsPeSnapshot(file)).bytes),bundleFile,bundleSha256};
  const contract=await readWindowsExtractionContract(extractor),output=values.get("--output"),installerFile=values.get("--installer");
  if(!path.isAbsolute(output??"")||!path.isAbsolute(installerFile??"")||values.get("--request")!==`${output}.request.json`
    ||values.get("--result")!==`${output}.result.json`||values.get("--archive")!==`${output}.zip`)fail();
  const request=JSON.parse((await readWindowsPeSnapshot(values.get("--request"))).bytes);validateWindowsExtractionRequest(request);
  const installer=(await readWindowsPeSnapshot(installerFile)).bytes;if(peSha256(installer)!==request.installerSha256)fail();
  const endpoint=new URL(contract.controller?.endpoint),tokenUrl=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||tokenUrl.origin!==contract.controller?.oidcRequestOrigin
    ||tokenUrl.protocol!=="https:"||!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)fail();
  const capability=windowsExtractionCapability(request,contract,{
    async idToken(audience){
      tokenUrl.searchParams.set("audience",audience);
      const body=JSON.parse(await httpBytes(await fetchImpl(tokenUrl,{headers:{Authorization:`Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`},redirect:"error",signal:AbortSignal.timeout(30_000)}),16_384));
      if(typeof body.value!=="string"||!body.value)fail();return body.value;
    },
    async authorize({token,...binding}){
      const {audience,subject,...request}=binding;
      const body=JSON.parse(await httpBytes(await fetchImpl(new URL("capabilities",endpoint),{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
        body:JSON.stringify({audience,subject,request}),redirect:"error",signal:AbortSignal.timeout(30_000)}),16_384));
      return body.capability;
    },
    async extract({capability,request,installer}){
      const body=JSON.parse(await httpBytes(await fetchImpl(new URL("extract",endpoint),{method:"POST",headers:{Authorization:`Bearer ${capability}`,"Content-Type":"application/octet-stream",
        "X-Murage-Extraction-Request":Buffer.from(JSON.stringify(request)).toString("base64")},body:installer,redirect:"error",signal:AbortSignal.timeout(300_000)}),3*1024**3));
      if(typeof body.archive!=="string"||typeof body.envelope!=="string")fail();
      const archive=Buffer.from(body.archive,"base64"),envelope=Buffer.from(body.envelope,"base64");
      if(archive.toString("base64")!==body.archive||envelope.toString("base64")!==body.envelope)fail();return {archive,envelope};
    },
  });
  const socketFile=`${output}.sock`,socket=await windowsExtractionSocket(socketFile,request,installer,capability);
  try{
    const result=new Promise(resolve=>socket.server.once("extraction",resolve));
    await requestWindowsExtractionSocket(socketFile,request);const {archive,envelope}=await result;
    await writeFile(values.get("--archive"),archive,{flag:"wx",mode:0o600});await writeFile(values.get("--result"),envelope,{flag:"wx",mode:0o600});
  }finally{await socket.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await runWindowsExtractionBootstrap(process.argv.slice(2));}
  catch{process.stderr.write("WINDOWS_EXTRACTION_BOOTSTRAP_FAILED\n");process.exitCode=1;}
}
