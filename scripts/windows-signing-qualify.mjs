// Qualification validator owner: win-sac-sign; controller output envelope and enrollment owner: MAIN.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lstat, readdir } from "node:fs/promises";
import { peSha256, readWindowsPeSnapshot } from "./windows-pe-signing.mjs";
import { signingRelativePath, verifyWindowsSigningAuthority, verifyWindowsControllerEnvelope } from "./windows-signing-authority.mjs";
import { verifyWindowsSigningReceipt } from "./windows-signing-receipt.mjs";
const fail=()=>{throw Error("WINDOWS_SIGNING_QUALIFICATION_REJECTED");};
const encode=value=>JSON.stringify(value,(_key,row)=>row&&typeof row==="object"&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>encode(a)===encode(b);

/** The controller signs its own collected output hashes. Downloaded output
 * cannot select the controller key, lock digest or expected build identity. */
export async function qualifyWindowsSigning({root,lockSha256,identity}) {
  if(!path.isAbsolute(root??""))fail();
  const read=async name=>(await readWindowsPeSnapshot(path.join(root,signingRelativePath(name)))).bytes;
  const lock=verifyWindowsSigningAuthority(await read("signing/authority.json"),lockSha256);
  const {payload}=verifyWindowsControllerEnvelope(await read("signing/output.json"),lock.controllerKeys.runAuthorization);
  if(payload.schema!==1 || payload.kind!=="windows-signing-output" || !same(payload.identity,identity)
    || !payload.receipt || !Array.isArray(payload.files) || !payload.files.length)fail();
  const files=new Map();
  for(const row of payload.files){
    signingRelativePath(row.path);
    if(!/^(release|signing)\//.test(row.path) || ["signing/authority.json","signing/output.json"].includes(row.path)
      || files.has(row.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(row.sha256??""))fail();
    files.set(row.path.toLowerCase(),row);
    if(peSha256(await read(row.path))!==row.sha256)fail();
  }
  const actual=[];
  const walk=async name=>{
    const file=path.join(root,name),stat=await lstat(file);if(stat.isSymbolicLink())fail();
    if(stat.isDirectory()){for(const entry of await readdir(file))await walk(`${name}/${entry}`);}
    else if(stat.isFile() && stat.nlink===1)actual.push(name);else fail();
  };
  await walk("release");await walk("signing");
  if(!same(actual.filter(name=>!["signing/authority.json","signing/output.json"].includes(name)).sort(),payload.files.map(row=>row.path).sort()))fail();
  const selected=name=>{const row=files.get(name.toLowerCase());if(row?.path!==name)fail();return row;};
  const receipt=payload.receipt;
  if(selected(receipt.file).sha256!==receipt.sha256)fail();
  const driver=verifyWindowsSigningReceipt(await read(receipt.file),receipt.configuration,receipt.coverage);
  if(!same(driver.identity,identity) || driver.authority.staticLaunchSha256!==lock.launchSha256
    || selected(`release/${driver.result.installerName}`).sha256!==driver.result.installerSha256
    || selected("signing/gepa-projection.json").sha256!==driver.result.gepaProjectionSha256)fail();
  const zips=payload.files.filter(row=>/^release\/[^/]+\.zip$/.test(row.path));
  if(zips.length!==1 || zips[0].sha256!==driver.result.zipSha256)fail();
  const metadata=JSON.parse(await read("signing/windows-sac-release.json"));
  if(metadata.manifestSha256!==driver.result.appManifestSha256 || metadata.sourceRevision!==identity.sourceRevision || metadata.target!==identity.target
    || selected("release/win-unpacked/resources/windows-sac-signing.json").sha256!==driver.result.appManifestSha256)fail();
  for(const event of driver.events.filter(row=>row.event==="freeze"))for(const [name,sha256]of Object.entries(event.outputDigests)){
    const file=["app","gepa"].includes(event.scope)?`release/win-unpacked/${name}`:event.scope==="installer"?`release/${path.posix.basename(name)}`:`signing/retained/${name}`;
    if(selected(file).sha256!==sha256)fail();
  }
  return {driver,gepaSha256:selected("signing/gepa-projection.json").sha256};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const mode=process.argv[2];if(!["sign","freeze","package","gepa-sha256"].includes(mode))fail();
    const identity={repositoryId:process.env.GITHUB_REPOSITORY_ID,workflowSha:process.env.GITHUB_WORKFLOW_SHA,
      sourceRevision:process.env.MURAGE_BUILD_COMMIT,version:process.env.VERSION,target:"win32-x64",runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT};
    const result=await qualifyWindowsSigning({root:process.cwd(),lockSha256:process.env.MURAGE_WINDOWS_SIGNING_AUTHORITY_SHA256,identity});
    process.stdout.write(mode==="gepa-sha256"?`${result.gepaSha256}\n`:"WINDOWS_SIGNING_QUALIFIED\n");
  }catch{process.stderr.write("WINDOWS_SIGNING_QUALIFICATION_REJECTED\n");process.exitCode=1;}
}
