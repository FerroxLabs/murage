// Extraction client/validator owner: win-sac-sign; bundle enrollment, two controller keys and disposable VM producer owner: MAIN.
import { createPublicKey, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";
import { signingRelativePath, verifyWindowsControllerEnvelope } from "./windows-signing-authority.mjs";

const fail=()=>{throw Error("WINDOWS_EXTRACTION_CONTRACT_REJECTED");};
const digest=value=>/^[a-f0-9]{64}$/.test(value??"");
const encode=value=>JSON.stringify(value,(_key,row)=>row&&typeof row==="object"&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>encode(a)===encode(b);
const relative=name=>{signingRelativePath(name);if(/[<>"|?*]/.test(name))fail();return name;};
const snapshot=async(file,expected)=>{if((await lstat(file)).size>2*1024**3)fail();const bytes=(await readWindowsPeSnapshot(file)).bytes;if(!digest(expected)||peSha256(bytes)!==expected)fail();return bytes;};

export function validateWindowsExtractionRequest(request) {
  if(!same(Object.keys(request??{}).sort(),["schema","kind","nonce","identity","publication","installerSha256"].sort())
    || request.schema!==1 || request.kind!=="windows-install-extraction" || !digest(request.nonce) || !digest(request.installerSha256))fail();
  const identity=request.identity;
  if(!same(Object.keys(identity??{}).sort(),["repositoryId","workflowSha","sourceRevision","version","target","runId","runAttempt"].sort())
    || ["repositoryId","runId","runAttempt"].some(key=>typeof identity[key]!=="string"||!/^[1-9][0-9]*$/.test(identity[key]??""))
    || ["workflowSha","sourceRevision"].some(key=>!/^[a-f0-9]{40}$/.test(identity[key]??""))
    || !/^\d+\.\d+\.\d+$/.test(identity.version??"") || identity.target!=="win32-x64"
    || !same(Object.keys(request.publication??{}).sort(),["runId","runAttempt"].sort())
    || Object.values(request.publication).some(value=>typeof value!=="string"||!/^[1-9][0-9]*$/.test(value)))fail();
}

export function validateWindowsExtractionRecipe(recipe) {
  if(!same(Object.keys(recipe??{}).sort(),["imageVersionResourceId","installDirectory","freshOsDisk","standardUser","perUser","launchAfterInstall","generalGuestNetwork"].sort())
    || !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft.Compute\/galleries\/[^/]+\/images\/[^/]+\/versions\/\d+\.\d+\.\d+$/.test(recipe?.imageVersionResourceId??"")
    || !path.win32.isAbsolute(recipe.installDirectory??"") || recipe.freshOsDisk!==true || recipe.standardUser!==true || recipe.perUser!==true
    || recipe.launchAfterInstall!==false || recipe.generalGuestNetwork!==false)fail();
}

export async function readWindowsExtractionContract(extractor) {
  if(!path.isAbsolute(extractor?.bundleFile??"") || !digest(extractor.bundleSha256))fail();
  const data=JSON.parse(await snapshot(extractor.bundleFile,extractor.bundleSha256));
  if(data.schema!==1 || data.kind!=="windows-install-vm" || typeof data.directory!=="string" || path.basename(data.directory)!==data.directory
    || !data.directory || data.directory==="." || data.directory===".." || !Array.isArray(data.files) || !data.files.length)fail();
  const root=path.join(path.dirname(extractor.bundleFile),data.directory),files=new Map();
  for(const row of data.files){
    relative(row.path);if(files.has(row.path.toLowerCase()))fail();files.set(row.path.toLowerCase(),row);
    await snapshot(path.join(root,row.path),row.sha256);
  }
  const actual=[];
  const walk=async(name="")=>{
    const file=path.join(root,name),stat=await lstat(file);if(stat.isSymbolicLink())fail();
    if(stat.isDirectory()){for(const entry of await readdir(file))await walk(name?`${name}/${entry}`:entry);}
    else if(stat.isFile()&&stat.nlink===1)actual.push(name);else fail();
  };await walk();
  if(!same(actual.sort(),data.files.map(row=>row.path).sort()))fail();
  for(const key of ["client","bootstrap","config","verifier"])if(!files.has(relative(data[key]).toLowerCase()))fail();
  if(new Set([data.client,data.bootstrap,data.config,data.verifier].map(value=>value.toLowerCase())).size!==4)fail();
  if(path.join(root,data.client)!==extractor.file || files.get(data.client.toLowerCase()).sha256!==extractor.sha256
    || files.get(data.verifier.toLowerCase()).sha256!==peSha256((await readWindowsPeSnapshot(fileURLToPath(import.meta.url))).bytes))fail();
  const keys=data.controllerKeys;
  if(!keys?.runAuthorization || !keys.extractionResult || keys.runAuthorization.id===keys.extractionResult.id
    || [keys.runAuthorization,keys.extractionResult].some(key=>createPublicKey(key.publicKey).asymmetricKeyType!=="ed25519")
    || createPublicKey(keys.runAuthorization.publicKey).export({type:"spki",format:"der"}).equals(createPublicKey(keys.extractionResult.publicKey).export({type:"spki",format:"der"})))fail();
  const oidc=data.oidc;
  if(!oidc || [oidc.extractionAudience,oidc.extractionSubject,oidc.vmControlAudience,oidc.vmControlSubject].some(value=>typeof value!=="string"||!value||value.includes("*"))
    || oidc.extractionAudience===oidc.vmControlAudience || oidc.extractionSubject===oidc.vmControlSubject)fail();
  const recipe=JSON.parse((await readWindowsPeSnapshot(path.join(root,data.config))).bytes);
  validateWindowsExtractionRecipe(recipe);
  return {...data,root,recipe};
}

/** A signing run cannot select its extractor executable or controller key. */
export async function windowsSigningExtraction(launch) {
  if(launch.schema!==2||launch.signingAuthority?.enrolled!==true)fail();
  const tree=launch.signingAuthority?.trees?.find(row=>row.component==="extractor");
  const pin=tree?.files?.find(row=>row.relativePath==="bundle.json");
  if(!tree||!pin||!path.isAbsolute(tree.root??""))fail();
  const bundleFile=path.join(tree.root,"bundle.json"),bundle=JSON.parse(await snapshot(bundleFile,pin.sha256));
  const client=bundle.files?.find(row=>row.path===bundle.client);
  if(!client)fail();
  const extractor={bundleFile,bundleSha256:pin.sha256,file:path.join(tree.root,bundle.directory,bundle.client),sha256:client.sha256};
  const contract=await readWindowsExtractionContract(extractor);
  if(!same(contract.controllerKeys,launch.signingAuthority.controllerKeys))fail();
  return extractor;
}

/** Parse only a controller-authenticated ZIP; never an NSIS image. */
export async function materializeWindowsExtraction(archive,output,expectedFiles) {
  const expected=new Map(),paths=new Map();
  const claim=(name,directory)=>{
    const parts=name.split("/");
    for(let index=1;index<=parts.length;index++){
      const prefix=parts.slice(0,index).join("/"),key=prefix.toLowerCase(),isDirectory=index<parts.length||directory,old=paths.get(key);
      if(old&&(old.name!==prefix||old.directory!==isDirectory))fail();
      paths.set(key,{name:prefix,directory:isDirectory});if(paths.size>100_000)fail();
    }
  };
  if(!Array.isArray(expectedFiles)||!expectedFiles.length||expectedFiles.length>100_000)fail();
  for(const row of expectedFiles){relative(row.path);claim(row.path,false);if(expected.has(row.path.toLowerCase())||!digest(row.sha256))fail();expected.set(row.path.toLowerCase(),row);}
  const stat=await lstat(archive);if(stat.size>2*1024**3)fail();
  const zip=await new Promise((resolve,reject)=>yauzl.open(archive,{lazyEntries:true,autoClose:false,strictFileNames:true,validateEntrySizes:true},(error,zip)=>error?reject(error):resolve(zip)));
  const seen=new Set();let total=0,inFlight;
  try{
    if(zip.entryCount>100_000)fail();await mkdir(output);
    await new Promise((resolve,reject)=>{
      zip.once("error",reject);zip.once("end",resolve);
      zip.on("entry",entry=>{
        inFlight=(async()=>{
          const directory=entry.fileName.endsWith("/"),name=relative(directory?entry.fileName.slice(0,-1):entry.fileName),mode=(entry.externalFileAttributes>>>16)&0o170000;
          claim(name,directory);
          if(entry.isEncrypted() || mode && mode!==(directory?0o040000:0o100000)
            || !Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||entry.uncompressedSize>2*1024**3||(total+=entry.uncompressedSize)>16*1024**3)fail();
          if(directory){if(entry.uncompressedSize)fail();zip.readEntry();return;}
          const selected=expected.get(name.toLowerCase());if(!selected||selected.path!==name||seen.has(name.toLowerCase()))fail();seen.add(name.toLowerCase());
          const file=path.join(output,name);await mkdir(path.dirname(file),{recursive:true});
          const input=await new Promise((resolve,reject)=>zip.openReadStream(entry,(error,stream)=>error?reject(error):resolve(stream)));
          let size=0;const bound=new Transform({transform(chunk,_encoding,done){size+=chunk.length;done(size>entry.uncompressedSize?Error("WINDOWS_EXTRACTION_CONTRACT_REJECTED"):null,chunk);}});
          await pipeline(input,bound,createWriteStream(file,{flags:"wx",mode:0o600}));
          if(size!==entry.uncompressedSize)fail();await snapshot(file,selected.sha256);zip.readEntry();
        })().catch(error=>{zip.close();reject(error);});
      });zip.readEntry();
    });
    if(seen.size!==expected.size)fail();
  }finally{zip.close();await inFlight?.catch(()=>{});}
}

export async function extractWindowsInstaller({extractor,installer,installerSha256,output,identity,allowedTransient,expectedTransient,
  publication= {runId:identity.runId,runAttempt:identity.runAttempt}, requestNonce},
  {run=promisify(execFile),env=process.env}={}) {
  extractor=structuredClone(extractor);identity=structuredClone(identity);publication=structuredClone(publication);
  allowedTransient=structuredClone(allowedTransient);expectedTransient=expectedTransient&&structuredClone(expectedTransient);
  if(!Array.isArray(allowedTransient)||!allowedTransient.length)fail();
  for(const row of allowedTransient){relative(row.path);if(!digest(row.sha256))fail();}
  if(expectedTransient && (!expectedTransient.length || expectedTransient.some(row=>!allowedTransient.some(pin=>pin.path===row.path&&pin.sha256===row.sha256))))fail();
  const contract=await readWindowsExtractionContract(extractor);
  await snapshot(installer,installerSha256);
  const nonce=requestNonce ?? randomBytes(32).toString("hex"),request={schema:1,kind:"windows-install-extraction",nonce,identity,publication,installerSha256};
  validateWindowsExtractionRequest(request);
  const requestFile=`${output}.request.json`,resultFile=`${output}.result.json`,archive=`${output}.zip`;
  await writeFile(requestFile,JSON.stringify(request),{flag:"wx",mode:0o600});
  const environment={PATH:"",NODE_OPTIONS:"",PSModulePath:""};
  for(const key of ["ACTIONS_ID_TOKEN_REQUEST_URL","ACTIONS_ID_TOKEN_REQUEST_TOKEN"])if(env[key])environment[key]=env[key];
  await run(extractor.file,["--installer",installer,"--output",output,"--request",requestFile,"--result",resultFile,"--archive",archive,
    "--contract",extractor.bundleFile,"--contract-sha256",extractor.bundleSha256],{shell:false,env:environment,windowsHide:true,timeout:300_000,maxBuffer:16_384});
  await readWindowsExtractionContract(extractor);
  const resultBytes=(await readWindowsPeSnapshot(resultFile)).bytes;
  const {payload:result,sha256}=verifyWindowsControllerEnvelope(resultBytes,contract.controllerKeys.extractionResult);
  if(result.schema!==1 || result.kind!==request.kind || result.nonce!==nonce || !same(result.identity,identity) || !same(result.publication,publication)
    || result.installerSha256!==installerSha256 || !same(result.vm,{...contract.recipe,destroyed:true}) || !digest(result.archiveSha256))fail();
  if(!Array.isArray(allowedTransient)||!Array.isArray(result.transientFiles)||!result.transientFiles.length)fail();
  const seen=new Set();
  for(const row of result.transientFiles){
    relative(row.path);if(!digest(row.sha256)||seen.has(row.path.toLowerCase())||!allowedTransient.some(pin=>pin.path===row.path&&pin.sha256===row.sha256))fail();
    seen.add(row.path.toLowerCase());
  }
  const sorted=rows=>[...rows].sort((a,b)=>a.path.localeCompare(b.path));
  if(expectedTransient&&!same(sorted(result.transientFiles),sorted(expectedTransient)))fail();
  await snapshot(archive,result.archiveSha256);
  try{await lstat(output);fail();}catch(error){if(error.code!=="ENOENT")throw error;}
  const bundled=`${output}.bundle`;
  await materializeWindowsExtraction(archive,bundled,[...result.files.map(row=>({path:`installed/${row.path}`,sha256:row.sha256})),
    ...result.transientFiles.map(row=>({path:`transient/${row.path}`,sha256:row.sha256}))]);
  await rename(path.join(bundled,"installed"),output);await rename(path.join(bundled,"transient"),`${output}.transients`);await rmdir(bundled);
  await snapshot(installer,installerSha256);await snapshot(archive,result.archiveSha256);await readWindowsExtractionContract(extractor);
  return {sha256,files:result.files,transientFiles:result.transientFiles};
}
