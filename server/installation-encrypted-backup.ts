import { createHash } from "node:crypto";
import { constants, closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { ZipFile } from "yazl";
import { fidelityManifestSchema, type BackupSelection, type FidelityManifest } from "../shared/installation-backup.ts";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { InstallationSnapshotError, withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned, type StateSnapshotManifest } from "./installation-state-snapshot.ts";
import { inspectArchiveEntries, portableArchivePath, validateArchiveFileList, validateInstallationArchiveManifest, writeInstallationStageArchive, type ArchiveLimits } from "./installation-archive.ts";
import { inventoryFidelity, openFidelitySource } from "./installation-fidelity-snapshot.ts";
import { decryptBackupFile, encryptBackupStream, resolveWindowsBackupRuntime } from "./installation-backup-encryption.ts";
import { runWindowsBackupTransport } from "./installation-windows-backup-transport.ts";
import { restoreInstallation } from "./installation-restore.ts";

function fail(code:string):never{throw new InstallationSnapshotError(code);}
/** Where inside the capture a failure happened; read only by the redacted log record. */
type CaptureStep="private-stage"|"offline-open"|"stage"|"inventory"|"manifest"|"encrypt"|"readback"|"flush"|"publish";
function withCaptureStep<T>(error:T,step:CaptureStep):T{if(error&&typeof error==="object"&&!Object.hasOwn(error,"captureStep"))Object.defineProperty(error,"captureStep",{value:step,enumerable:false,configurable:true});return error;}
export interface EncryptedBackupOptions extends ArchiveLimits { ageExecutable:string; identity:string; timeoutMs?:number; closeTimeoutMs?:number }
function unconfirmedClose(error:unknown){return error instanceof InstallationSnapshotError&&error.code==="AGE_PROCESS_CLOSE_UNCONFIRMED";}
function retainFailure(error:unknown){return process.platform==="win32"||unconfirmedClose(error);}
/** A failed capture's staging folder sits in the backup folder, which may be
 * synced or shared, and holds a plaintext copy of the workspace. None of it is
 * kept. Only when an owned tool's exit is unconfirmed does its encrypted output
 * stay, since that process may still hold it. True when the folder is gone. */
function discardFailedStage(scratch:string,keepCiphertext:boolean):boolean{
  try{
    if(!keepCiphertext)rmSync(scratch,{recursive:true,force:true});
    else for(const name of readdirSync(scratch))if(name!=="backup.age")rmSync(join(scratch,name),{recursive:true,force:true});
  }catch{/* Whatever could not be removed is reported as retained. */}
  return !existsSync(scratch);
}
const nativeBudget=(maxBytes:number)=>Math.min(maxBytes,20*1024**3);
const combineSignal=(native:AbortSignal,caller?:AbortSignal)=>caller?AbortSignal.any([native,caller]):native;
async function settleWindowsWork(pending:Promise<unknown>|undefined,options:EncryptedBackupOptions){
  if(!pending)return;
  let settled=false,workError:unknown;let timer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([pending.then(()=>{settled=true;},error=>{settled=true;workError=error;}),new Promise<void>(resolve=>{timer=setTimeout(resolve,2*(options.closeTimeoutMs??5000));})]);
  if(timer)clearTimeout(timer);
  if(!settled||unconfirmedClose(workError))fail("AGE_PROCESS_CLOSE_UNCONFIRMED");
}
async function withWindowsPrivateStage<T>(parent:string,options:EncryptedBackupOptions,work:(directory:string,signal:AbortSignal)=>Promise<T>):Promise<{value:T;directory:string}>{
  const runtime=await resolveWindowsBackupRuntime(options.ageExecutable);
  let pending:Promise<T>|undefined,privateDirectory:string|undefined;
  try{
    const result=await runWindowsBackupTransport({operation:"private-stage",parentDirectory:parent,maxBytes:nativeBudget(budget(options).maxBytes),timeoutMs:options.timeoutMs,closeTimeoutMs:options.closeTimeoutMs,signal:options.signal,
      validate:async context=>{privateDirectory=context.directory;pending=Promise.resolve().then(()=>work(context.directory,combineSignal(context.signal,options.signal)));return{value:await pending};}},
    {verifyHelper:runtime.verifyHelper,spawn});
    return{value:result.value,directory:result.directory};
  }catch(error){
    // A helper failure aborts context.signal. Wait for the caller's bounded age
    // teardown too; never race the private worker's exit against an age writer.
    let reported=error;
    try{await settleWindowsWork(pending,options);}catch(unsettled){reported=unsettled;}
    if(privateDirectory&&reported&&typeof reported==="object")Object.assign(reported,{retainedDirectory:privateDirectory});
    throw reported;
  }
}
const budget=(options:ArchiveLimits)=>{
  const maxBytes=options.maxBytes??20*1024**3,maxFiles=options.maxFiles??100000;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>100000)fail("INVALID_BACKUP_LIMITS");
  return{maxBytes,maxFiles};
};
async function hashFile(path:string,signal?:AbortSignal){const hash=createHash("sha256");for await(const chunk of createReadStream(path,{signal}))hash.update(chunk);return hash.digest("hex");}
function parseFidelity(value:unknown,options:ArchiveLimits):FidelityManifest{
  const parsed=fidelityManifestSchema.safeParse(value);if(!parsed.success)fail("INVALID_FIDELITY_MANIFEST");
  const manifest=parsed.data;validateArchiveFileList(manifest,options);
  const recovery=validateInstallationArchiveManifest(manifest.recovery,options);
  const expected=new Set(recovery.files.flatMap(file=>[`raw/${file.path}`,`recovery/${file.path}`]));
  const rawChannel=(path:string)=>path.startsWith("raw/channels/");
  const rawOnly=(path:string)=>rawChannel(path)||path==="raw/startup-background.json"||path==="raw/memory-index.db";
  const declared=new Set(manifest.files.map(file=>file.path));
  if([...expected].some(path=>!declared.has(path))||manifest.files.some(file=>!expected.has(file.path)&&!rawOnly(file.path)))fail("FIDELITY_RECOVERY_MISMATCH");
  if(manifest.files.some(file=>rawChannel(file.path))&&!manifest.coverage.components.some(component=>component.path==="channels"&&component.status==="included"))fail("FIDELITY_RECOVERY_MISMATCH");
  if(declared.has("raw/memory-index.db")&&!manifest.coverage.components.some(component=>component.path==="memory-index.db"&&component.status==="included"))fail("FIDELITY_RECOVERY_MISMATCH");
  for(const file of recovery.files){const copy=manifest.files.find(candidate=>candidate.path===`recovery/${file.path}`);if(copy?.bytes!==file.bytes||copy.sha256!==file.sha256)fail("FIDELITY_RECOVERY_MISMATCH");}
  return manifest;
}

/** Authenticated decryption finishes before any archive entry is inspected. */
export async function inspectEncryptedInstallationBackup(archive:string,outputParent:string,options:EncryptedBackupOptions){
  const limits=budget(options),source=lstatSync(archive);
  if(!source.isFile()||source.isSymbolicLink()||source.nlink!==1)fail("UNSAFE_ARCHIVE_FILE");
  if(source.size>limits.maxBytes+64*1024**2)fail("BACKUP_LIMIT_EXCEEDED");
  if(process.platform==="win32"){
    const runtime=await resolveWindowsBackupRuntime(options.ageExecutable);
    let privateDirectory:string|undefined;
    let pending:Promise<{value:{directory:string;stateDirectory:string;manifest:FidelityManifest;sha256:string};ciphertextSha256:string}>|undefined;
    try{
    const result=await runWindowsBackupTransport({operation:"decrypt",parentDirectory:dataDirLeasePaths(outputParent).canonicalDataDir,ciphertext:archive,identity:options.identity,
      maxBytes:nativeBudget(limits.maxBytes+64*1024**2),signal:options.signal,timeoutMs:options.timeoutMs,closeTimeoutMs:options.closeTimeoutMs,
      validate:context=>{privateDirectory=context.directory;pending=(async()=>{
        if(!context.plaintext)fail("AGE_PROCESS_FAILED");
        const signal=combineSignal(context.signal,options.signal);
        const inspected=await inspectArchiveEntries(context.plaintext,context.directory,value=>parseFidelity(value,options),{...options,signal});
        const after=lstatSync(archive);
        if(source.dev!==after.dev||source.ino!==after.ino||source.size!==after.size||source.mtimeMs!==after.mtimeMs)fail("ARCHIVE_CHANGED");
        const sha256=await hashFile(archive,signal);
        return{value:{directory:context.directory,stateDirectory:join(inspected.directory,"state"),manifest:inspected.manifest,sha256},ciphertextSha256:sha256};
      })();return pending;}},{verifyHelper:runtime.verifyHelper,spawn});
    return result.value;
    }catch(error){
      let reported=error;
      try{await settleWindowsWork(pending,options);}catch(unsettled){reported=unsettled;}
      if(privateDirectory&&reported&&typeof reported==="object")Object.assign(reported,{retainedDirectory:privateDirectory});
      throw reported;
    }
  }
  const directory=mkdtempSync(join(dataDirLeasePaths(outputParent).canonicalDataDir,".murage-encrypted-inspection-"));
  const plaintext=join(directory,"authenticated.zip");let success=false,retain=false;
  try{
    await decryptBackupFile(options.ageExecutable,options.identity,archive,plaintext,{maxBytes:limits.maxBytes+64*1024**2,signal:options.signal,timeoutMs:options.timeoutMs,closeTimeoutMs:options.closeTimeoutMs});
    const inspected=await inspectArchiveEntries(plaintext,directory,value=>parseFidelity(value,options),options);
    const after=lstatSync(archive);
    if(source.dev!==after.dev||source.ino!==after.ino||source.size!==after.size||source.mtimeMs!==after.mtimeMs)fail("ARCHIVE_CHANGED");
    const sha256=await hashFile(archive);
    success=true;return{directory,stateDirectory:join(inspected.directory,"state"),manifest:inspected.manifest,sha256};
  }catch(error){retain=unconfirmedClose(error);if(retain)Object.assign(error as Error,{retainedDirectory:directory});throw error;}
  finally{if(!success&&!retain)rmSync(directory,{recursive:true,force:true});}
}

/** Same offline epoch for original fidelity bytes and the safe recovery projection. */
export async function writeEncryptedInstallationBackup(dataDir:string,destination:string,options:EncryptedBackupOptions&{recipient:string;selection:BackupSelection}){
  const limits=budget(options);
  if(!portableArchivePath(basename(destination)))fail("INVALID_DESTINATION");
  const parent=dataDirLeasePaths(dirname(destination)).canonicalDataDir,target=join(parent,basename(destination));
  const sourceRoot=dataDirLeasePaths(dataDir).canonicalDataDir;
  if(parent===sourceRoot||parent.startsWith(sourceRoot+sep))fail("DESTINATION_INSIDE_INSTALLATION");
  try{lstatSync(target);fail("DESTINATION_EXISTS");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const execute=async(scratch:string,options:EncryptedBackupOptions&{recipient:string;selection:BackupSelection})=>{
  const ciphertext=join(scratch,"backup.age");
  let retain=false,step:CaptureStep="offline-open";
  try{
    const manifest=await withOfflineInstallation(dataDir,async installation=>{
      if(parent===installation.dataDir||parent.startsWith(installation.dataDir+sep))fail("DESTINATION_INSIDE_INSTALLATION");
      step="stage";
      const stage=await stageInstallationStateWhileOwned(installation,scratch,options);
      const streams=new Set<Readable>();let writer:ZipFile|undefined;
      try{
        stage.assertSourceUnchanged();
        step="inventory";
        const fidelity=await inventoryFidelity(installation,stage,options.selection,options);
        step="manifest";
        const recovery=validateInstallationArchiveManifest({...stage.manifest,format:"murage.installation",files:stage.manifest.files.map(file=>({...file,path:file.path.replaceAll("\\","/")}))},options);
        const files=[...fidelity.sources.map(file=>({path:`raw/${file.path}`,bytes:file.bytes,sha256:file.sha256})),...recovery.files.map(file=>({...file,path:`recovery/${file.path}`}))];
        const manifest=parseFidelity({format:"murage.installation-fidelity",version:1,snapshotId:recovery.snapshotId,createdAt:recovery.createdAt,sourceInstallation:installation.dataDir,restorePolicy:"paused-review-required",database:{status:"absent"},files,coverage:fidelity.coverage,recovery},options);
        writer=new ZipFile();
        const manifestBytes=Buffer.from(JSON.stringify(manifest)+"\n");
        if(manifestBytes.length>32*1024**2)fail("ARCHIVE_LIMIT_EXCEEDED");
        writer.addBuffer(manifestBytes,"manifest.json",{compress:false,mode:0o100600});
        for(const file of fidelity.sources)writer.addReadStreamLazy(`state/raw/${file.path}`,{size:file.bytes,compress:false,mode:0o100600},callback=>{
          try{const stream=openFidelitySource(file);streams.add(stream);stream.once("close",()=>streams.delete(stream));callback(null,stream);}catch(error){callback(error,Readable.from([]));}
        });
        for(const file of recovery.files)writer.addReadStreamLazy(`state/recovery/${file.path}`,{size:file.bytes,compress:false,mode:0o100600},callback=>{
          try{const path=join(stage.directory,"state",...file.path.split("/"));const fd=openSync(path,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));const stream=createReadStream(path,{fd,autoClose:true});streams.add(stream);stream.once("close",()=>streams.delete(stream));callback(null,stream);}catch(error){callback(error,Readable.from([]));}
        });
        writer.once("error",error=>(writer!.outputStream as Readable).destroy(error));
        writer.end();
        step="encrypt";
        await encryptBackupStream(options.ageExecutable,options.recipient,writer.outputStream as Readable,ciphertext,{maxBytes:limits.maxBytes+64*1024**2,signal:options.signal,timeoutMs:options.timeoutMs,closeTimeoutMs:options.closeTimeoutMs});
        fidelity.assertUnchanged();
        stage.assertSourceUnchanged();
        return manifest;
      }catch(error){retain=retainFailure(error);throw error;}
      finally{for(const stream of streams)stream.destroy();(writer?.outputStream as Readable|undefined)?.destroy();if(!retain)rmSync(stage.directory,{recursive:true,force:true});}
    });
    step="readback";
    const inspection=await inspectEncryptedInstallationBackup(ciphertext,scratch,options);
    if(inspection.manifest.snapshotId!==manifest.snapshotId)fail("FIDELITY_READBACK_MISMATCH");
    const sha256=inspection.sha256;rmSync(inspection.directory,{recursive:true,force:true});
    step="flush";
    const fd=openSync(ciphertext,"r+");try{fsyncSync(fd);}finally{closeSync(fd);}
    step="publish";
    if(process.platform!=="win32")linkSync(ciphertext,target);
    return{path:target,sha256,snapshotId:manifest.snapshotId,coverage:manifest.coverage,restorePolicy:manifest.restorePolicy};
  }catch(error){retain=retainFailure(error);const reported=error instanceof InstallationSnapshotError?error:new InstallationSnapshotError((error as NodeJS.ErrnoException).code==="EEXIST"?"DESTINATION_EXISTS":"ENCRYPTED_BACKUP_FAILED",{cause:error});withCaptureStep(reported,step);if(retain)Object.assign(reported,{retainedDirectory:scratch});throw reported;}
  finally{if(process.platform!=="win32"){if(!retain)rmSync(scratch,{recursive:true,force:true});else discardFailedStage(scratch,true);}}
  };
  if(process.platform!=="win32")return execute(mkdtempSync(join(parent,".murage-encrypted-write-")),options);
  let scratch:string|undefined,success=false;
  try{
    const result=await withWindowsPrivateStage(parent,options,async(directory,signal)=>{scratch=directory;return execute(directory,{...options,signal});});
    // Publish only after the native private-stage lease and all age writers close.
    try{linkSync(join(result.directory,"backup.age"),target);}
    catch(error){throw withCaptureStep(new InstallationSnapshotError((error as NodeJS.ErrnoException).code==="EEXIST"?"DESTINATION_EXISTS":"ENCRYPTED_BACKUP_FAILED",{cause:error}),"publish");}
    success=true;return result.value;
  }catch(error){
    if(error&&typeof error==="object"&&!(error as {captureStep?:string}).captureStep)withCaptureStep(error,"private-stage");
    // The private stage and its age writers have closed unless their exit is unconfirmed.
    if(scratch&&error&&typeof error==="object"){
      const unconfirmed=unconfirmedClose(error)||(error as {helperClosed?:boolean}).helperClosed===false;
      if(discardFailedStage(scratch,unconfirmed))delete (error as {retainedDirectory?:string}).retainedDirectory;
      else Object.assign(error,{retainedDirectory:scratch});
    }
    throw error;
  }
  finally{if(success&&scratch)rmSync(scratch,{recursive:true,force:true});}
}

/** Never activates raw fidelity/session/credential bytes; only the verified projection. */
export async function restoreEncryptedInstallationNew(dataDir:string,archive:string,expectedSha256:string,options:EncryptedBackupOptions){
  if(!/^[a-f0-9]{64}$/.test(expectedSha256))fail("ARCHIVE_HASH_REQUIRED");
  const parent=dataDirLeasePaths(dirname(dataDir)).canonicalDataDir;
  const inspected=await inspectEncryptedInstallationBackup(archive,parent,options);
  let restoredSuccessfully=false;
  try{
    if(inspected.sha256!==expectedSha256)fail("ARCHIVE_HASH_CHANGED");
    const target=dataDirLeasePaths(dataDir).canonicalDataDir;
    if(target===inspected.manifest.sourceInstallation||target.startsWith(inspected.manifest.sourceInstallation+sep))fail("RESTORE_SOURCE_TARGET_REFUSED");
    const recovery=validateInstallationArchiveManifest(inspected.manifest.recovery,options);
    const stage=mkdtempSync(join(inspected.directory,".recovery-"));
    for(const file of recovery.files){const to=join(stage,"state",...file.path.split("/"));mkdirSync(dirname(to),{recursive:true,mode:0o700});copyFileSync(join(inspected.stateDirectory,"recovery",...file.path.split("/")),to,constants.COPYFILE_EXCL);}
    const recoveryArchive=await writeInstallationStageArchive({directory:stage,manifest:{...recovery,format:"murage.installation-stage"} as StateSnapshotManifest},join(inspected.directory,"recovery.zip"),options);
    const restored=await restoreInstallation(target,recoveryArchive.path,recoveryArchive.sha256,{requireNew:true,...(process.platform==="win32"?{preparationParent:inspected.directory}:{})});
    restoredSuccessfully=true;
    return{...restored,encryptedSha256:inspected.sha256,coverage:inspected.manifest.coverage,rawFidelityActivated:false as const};
  }catch(error){if(process.platform==="win32"&&error&&typeof error==="object")Object.assign(error,{retainedDirectory:inspected.directory});throw error;}
  finally{if(process.platform!=="win32"||restoredSuccessfully)rmSync(inspected.directory,{recursive:true,force:true});}
}
