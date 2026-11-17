// Final package/driver receipt producer owner: win-sac-sign; extractor enrollment and authenticated output collection owner: MAIN.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { peSha256, readWindowsPeSnapshot, verifyFrozenWindowsPe } from "./windows-pe-signing.mjs";
import { verifyWindowsPeRecords } from "./windows-sac-inventory.mjs";
import { windowsPackageTree, verifyNoPackedWindowsPe } from "./windows-package-tree.mjs";
import { extractWindowsInstaller, materializeWindowsExtraction, windowsSigningExtraction } from "./windows-extraction-contract.mjs";
const fail=()=>{throw Error("WINDOWS_BUILD_FINALIZATION_REJECTED");};
const encode=value=>JSON.stringify(value,(_key,row)=>row&&typeof row==="object"&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);

export async function finalizeWindowsBuild({session,artifacts,launch,receiptFile},{extract=extractWindowsInstaller}={}) {
  const {state,adapters,graph}=session;
  if(!state?.frozen||!Array.isArray(state.tree)||!session.gepa||!Array.isArray(artifacts)||!path.isAbsolute(receiptFile??""))fail();
  const installers=artifacts.filter(file=>file.endsWith("-setup.exe")),zips=artifacts.filter(file=>file.endsWith(".zip"));
  const uninstaller=adapters.retained.get("uninstaller"),transient=adapters.retained.get("transient");
  const transientImages=[...adapters.transientImages.values()];
  if(installers.length!==1||zips.length!==1||!uninstaller||!transient)fail();
  const installer=installers[0],installerRecord=state.artifactRecords.find(row=>row.path===`artifacts/${path.basename(installer)}`);
  const installerSource=state.artifactSources.find(row=>row.path===installerRecord?.path);
  if(!installerRecord||!installerSource)fail();
  const extractor=await windowsSigningExtraction(launch);
  const scratch=await mkdtemp(path.join(path.dirname(receiptFile),"verify-package-"));
  const hashFile=async file=>peSha256((await readWindowsPeSnapshot(file)).bytes);
  const verify=async()=>{
    if(encode(await windowsPackageTree(state.appOutDir))!==encode(state.tree))fail();
    await verifyWindowsPeRecords(state.appOutDir,state.sources,state.records,state.trust);
    for(const selected of adapters.retained.values())await verifyFrozenWindowsPe(selected.file,selected.pin,selected.record,state.trust);
    for(const selected of transientImages)await verifyFrozenWindowsPe(selected.file,selected.pin,selected.record,state.trust);
    await verifyFrozenWindowsPe(installer,installerSource,installerRecord,state.trust);
    verifyNoPackedWindowsPe(path.join(state.appOutDir,"resources/app.asar"));
  };
  try{
    await graph.packageComplete(verify);
    const zipSha256=await hashFile(zips[0]);
    await materializeWindowsExtraction(zips[0],path.join(scratch,"zip"),state.tree);
    const identity=Object.fromEntries(["repositoryId","workflowSha","sourceRevision","version","target","runId","runAttempt"].map(key=>[key,launch.runAuthorization[key]]));
    const allowedTransient=[...state.records,...state.artifactRecords,...transientImages.map(row=>row.record)].map(row=>({path:row.path,sha256:row.finalSha256}));
    const extraction=await extract({extractor,installer,installerSha256:installerRecord.finalSha256,output:path.join(scratch,"installed"),identity,allowedTransient});
    if(!Array.isArray(extraction.transientFiles)||!extraction.transientFiles.length
      ||new Set(extraction.transientFiles.map(row=>row.path)).size!==extraction.transientFiles.length
      ||extraction.transientFiles.some(row=>!allowedTransient.some(pin=>pin.path===row.path&&pin.sha256===row.sha256)))fail();
    const installed=[...state.tree,{path:"Uninstall Murage.exe",sha256:uninstaller.record.finalSha256}].sort((a,b)=>a.path.localeCompare(b.path));
    if(encode([...extraction.files].sort((a,b)=>a.path.localeCompare(b.path)))!==encode(installed))fail();
    const projection=JSON.stringify(session.gepa,null,2)+"\n";
    const records={schema:2,target:state.target,sourceRevision:state.sourceRevision,sources:[...state.sources,...state.artifactSources,...transientImages.map(row=>row.pin)],
      files:[...state.records,...state.artifactRecords,...transientImages.map(row=>row.record)]};
    await writeFile(path.join(path.dirname(receiptFile),"gepa-projection.json"),projection,{flag:"wx",mode:0o600});
    await writeFile(path.join(path.dirname(receiptFile),"gepa-package-metadata.json"),JSON.stringify({extraMetadata:session.metadata})+"\n",{flag:"wx",mode:0o600});
    await writeFile(path.join(path.dirname(receiptFile),"records.json"),JSON.stringify(records)+"\n",{flag:"wx",mode:0o600});
    return await graph.complete(receiptFile,{gepaProjectionSha256:peSha256(projection),appManifestSha256:state.manifestSha256,
      installerName:path.basename(installer),installerSha256:installerRecord.finalSha256,uninstallerRecordSha256:peSha256(encode(uninstaller.record)),zipSha256,
      extractionResultSha256:extraction.sha256},async()=>{
      await verify();if(await hashFile(zips[0])!==zipSha256)fail();
      if(encode([...await windowsPackageTree(path.join(scratch,"installed"))].sort((a,b)=>a.path.localeCompare(b.path)))!==encode(installed))fail();
      if(encode([...await windowsPackageTree(path.join(scratch,"installed.transients"))].sort((a,b)=>a.path.localeCompare(b.path)))
        !==encode([...extraction.transientFiles].sort((a,b)=>a.path.localeCompare(b.path))))fail();
    });
  }finally{await rm(scratch,{recursive:true,force:true});}
}
