import { createHash } from "node:crypto";
import { constants, closeSync, createReadStream, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { MAX_BACKUP_BYTES, MAX_BACKUP_FILES } from "../shared/backup-limits.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { publishNoReplace } from "./publish-file.ts";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { ZipFile } from "yazl";
import { fidelityManifestSchema, type BackupSelection, type FidelityManifest } from "../shared/installation-backup.ts";
import { dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { InstallationSnapshotError, withOfflineInstallation, type OfflineInstallation } from "./installation-database-snapshot.ts";
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
/** A plain filesystem failure inside the capture, named by what the person can
 * do about it. Anything unrecognised stays ENCRYPTED_BACKUP_FAILED; the
 * redacted log record (describeCaptureError) keeps the errno either way. */
function capturedFilesystemError(error:unknown):InstallationSnapshotError{
  const raw=error as {code?:unknown;name?:unknown;ioCause?:{errno?:string}}|undefined;
  const leaseCode=raw?.name==="DataDirLeaseError"&&typeof raw.code==="string"?raw.code:undefined;
  const errno=typeof raw?.ioCause?.errno==="string"?raw.ioCause.errno:!leaseCode&&typeof raw?.code==="string"?raw.code:undefined;
  const code=errno==="EEXIST"&&!leaseCode?"DESTINATION_EXISTS"
    :errno==="ENOSPC"?"BACKUP_DISK_FULL"
    :errno==="EACCES"||errno==="EPERM"?"BACKUP_FOLDER_NOT_WRITABLE"
    :errno==="EBUSY"?"BACKUP_FILE_IN_USE"
    :leaseCode==="LEASE_BUSY"||leaseCode==="LEASE_CHILD_BUSY"?"RECOVERY_OWNERSHIP_REQUIRED"
    :"ENCRYPTED_BACKUP_FAILED";
  return new InstallationSnapshotError(code,{cause:error});
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
  // Defaults are the largest limit a backup may be made at, so inspection and
  // restore accept everything a backup verified (shared/backup-limits.ts).
  const maxBytes=options.maxBytes??MAX_BACKUP_BYTES,maxFiles=options.maxFiles??MAX_BACKUP_FILES;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_BACKUP_BYTES||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>MAX_BACKUP_FILES)fail("INVALID_BACKUP_LIMITS");
  return{maxBytes,maxFiles};
};
async function hashFile(path:string,signal?:AbortSignal){const hash=createHash("sha256");for await(const chunk of createReadStream(path,{signal}))hash.update(chunk);return hash.digest("hex");}
/** Raw copies a version 2 backup keeps beside the recovery copy: Murage's
 * own records (their recovery copy is projected) and the encrypted-only items. */
function rawRecord(path:string){return !path.includes("/")&&path!=="messages.db"&&classifyDataDirEntry(path)?.backup==="record";}
function parseFidelity(value:unknown,options:ArchiveLimits):FidelityManifest{
  const parsed=fidelityManifestSchema.safeParse(value);if(!parsed.success)fail("INVALID_FIDELITY_MANIFEST");
  const manifest=parsed.data;const maxFiles=budget(options).maxFiles;
  // Raw and recovery copies together: up to twice the item limit.
  validateArchiveFileList(manifest,{...options,maxEntries:2*maxFiles});
  const recovery=validateInstallationArchiveManifest(manifest.recovery,options);
  const rawChannel=(path:string)=>path.startsWith("raw/channels/");
  const rawOnly=(path:string)=>rawChannel(path)||path==="raw/startup-background.json"||path==="raw/memory-index.db";
  // Version 1 stored every file twice (raw/ and recovery/); version 2 keeps a
  // raw copy only of the records. Both still read.
  const expected=new Set(recovery.files.flatMap(file=>manifest.version===1||rawRecord(file.path)?[`raw/${file.path}`,`recovery/${file.path}`]:[`recovery/${file.path}`]));
  const declared=new Set(manifest.files.map(file=>file.path));
  if([...expected].some(path=>!declared.has(path))||manifest.files.some(file=>!expected.has(file.path)&&!rawOnly(file.path)))fail("FIDELITY_RECOVERY_MISMATCH");
  if(manifest.files.some(file=>rawChannel(file.path))&&!manifest.coverage.components.some(component=>component.path==="channels"&&component.status==="included"))fail("FIDELITY_RECOVERY_MISMATCH");
  if(declared.has("raw/memory-index.db")&&!manifest.coverage.components.some(component=>component.path==="memory-index.db"&&component.status==="included"))fail("FIDELITY_RECOVERY_MISMATCH");
  const byPath=new Map(manifest.files.map(file=>[file.path,file]));
  for(const file of recovery.files){const copy=byPath.get(`recovery/${file.path}`);if(copy?.bytes!==file.bytes||copy.sha256!==file.sha256)fail("FIDELITY_RECOVERY_MISMATCH");}
  return manifest;
}

/** Bot names by id from a staged roster, to say whose folder an item was in. */
function botNames(file:string):Record<string,string>{
  try{
    const roster=JSON.parse(readFileSync(file,"utf8"));if(!Array.isArray(roster))return{};
    return Object.fromEntries(roster.filter(bot=>bot&&typeof bot.id==="string"&&typeof bot.name==="string"&&bot.name.trim()).map(bot=>[bot.id,bot.name.trim().slice(0,80)]));
  }catch{return{};}
}
/** What a backup left out, for the page that reports it: at most 50 items,
 * each a path inside the data folder with its reason, and the names of the
 * bots whose folders they were in. */
export function skippedSummary(recovery:Pick<StateSnapshotManifest,"skipped"|"skippedCount">,bots:Record<string,string>={}){
  const count=recovery.skippedCount??0;if(!count)return{};
  const items=(recovery.skipped??[]).slice(0,50);
  const ids=new Set(items.map(item=>/^workspaces\/([^/]+)\//.exec(item.path)?.[1]).filter((id):id is string=>!!id&&Object.hasOwn(bots,id)));
  return{skipped:{count,items,bots:Object.fromEntries([...ids].map(id=>[id,bots[id]]))}};
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
        const inspected=await inspectArchiveEntries(context.plaintext,context.directory,value=>parseFidelity(value,options),{...options,signal,maxEntries:2*limits.maxFiles});
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
    const inspected=await inspectArchiveEntries(plaintext,directory,value=>parseFidelity(value,options),{...options,maxEntries:2*limits.maxFiles});
    // Every entry is checked and extracted; the decrypted copy of the whole
    // archive is no longer needed and would double the space a restore takes.
    rmSync(plaintext,{force:true});
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
  const execute=async(scratch:string,options:EncryptedBackupOptions&{recipient:string;selection:BackupSelection},held?:OfflineInstallation)=>{
  const ciphertext=join(scratch,"backup.age");
  let retain=false,step:CaptureStep="offline-open";
  let bots:Record<string,string>={};
  try{
    const offline=<T,>(work:(installation:OfflineInstallation)=>Promise<T>)=>held?work(held):withOfflineInstallation(dataDir,work);
    const manifest=await offline(async installation=>{
      if(parent===installation.dataDir||parent.startsWith(installation.dataDir+sep))fail("DESTINATION_INSIDE_INSTALLATION");
      step="stage";
      const stage=await stageInstallationStateWhileOwned(installation,scratch,options);
      if(stage.manifest.skippedCount)bots=botNames(join(stage.directory,"state","bots.json"));
      const streams=new Set<Readable>();let writer:ZipFile|undefined;
      try{
        stage.assertSourceUnchanged();
        step="inventory";
        const fidelity=await inventoryFidelity(installation,stage,options.selection,options);
        step="manifest";
        const recovery=validateInstallationArchiveManifest({...stage.manifest,format:"murage.installation",files:stage.manifest.files.map(file=>({...file,path:file.path.replaceAll("\\","/")}))},options);
        const files=[...fidelity.sources.map(file=>({path:`raw/${file.path}`,bytes:file.bytes,sha256:file.sha256})),...recovery.files.map(file=>({...file,path:`recovery/${file.path}`}))];
        const manifest=parseFidelity({format:"murage.installation-fidelity",version:2,snapshotId:recovery.snapshotId,createdAt:recovery.createdAt,sourceInstallation:installation.dataDir,restorePolicy:"paused-review-required",database:{status:"absent"},files,coverage:fidelity.coverage,recovery},options);
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
    const inspection=await inspectEncryptedInstallationBackup(ciphertext,scratch,{...options,durable:false});
    if(inspection.manifest.snapshotId!==manifest.snapshotId)fail("FIDELITY_READBACK_MISMATCH");
    const sha256=inspection.sha256;rmSync(inspection.directory,{recursive:true,force:true});
    step="flush";
    const fd=openSync(ciphertext,"r+");try{fsyncSync(fd);}finally{closeSync(fd);}
    step="publish";
    if(process.platform!=="win32")publishNoReplace(ciphertext,target);
    return{path:target,sha256,snapshotId:manifest.snapshotId,coverage:manifest.coverage,restorePolicy:manifest.restorePolicy,...skippedSummary(manifest.recovery as StateSnapshotManifest,bots)};
  }catch(error){retain=retainFailure(error);const reported=error instanceof InstallationSnapshotError?error:capturedFilesystemError(error);withCaptureStep(reported,step);if(retain)Object.assign(reported,{retainedDirectory:scratch});throw reported;}
  finally{if(process.platform!=="win32"){if(!retain)rmSync(scratch,{recursive:true,force:true});else discardFailedStage(scratch,true);}}
  };
  if(process.platform!=="win32")return execute(mkdtempSync(join(parent,".murage-encrypted-write-")),options);
  let scratch:string|undefined,success=false;
  try{
    // The data-folder lease is taken before the native helper starts and let
    // go only after it has closed. The helper pins every folder above the
    // backup folder against change (share-read only), and the lease records
    // are published by hard link into the folder that holds the data folder:
    // by default the same C:\Users\<name> that sits above "Murage Backups".
    // Taken the other way round, that link failed with EBUSY and every
    // Windows backup stopped with ENCRYPTED_BACKUP_FAILED.
    let result:{value:Awaited<ReturnType<typeof execute>>;directory:string};
    try{
      result=await withOfflineInstallation(dataDir,installation=>withWindowsPrivateStage(parent,options,async(directory,signal)=>{scratch=directory;return execute(directory,{...options,signal},installation);}));
    }catch(error){
      if(error instanceof InstallationSnapshotError)throw error;
      throw withCaptureStep(capturedFilesystemError(error),(error as {name?:string}|undefined)?.name==="DataDirLeaseError"?"offline-open":"private-stage");
    }
    // Publish only after the native private-stage lease and all age writers close.
    try{linkSync(join(result.directory,"backup.age"),target);}
    catch(error){throw withCaptureStep(capturedFilesystemError(error),"publish");}
    success=true;return result.value;
  }catch(caught){
    let error=caught;
    if(error&&typeof error==="object"&&!(error as {captureStep?:string}).captureStep)withCaptureStep(error,"private-stage");
    // The helper refused before it had a private folder to offer: it could
    // not create or pin one inside the backup folder (not writable by this
    // account, not an NTFS folder on this computer's own drive, or a link).
    // That is about the folder, never the recovery key, which is only read
    // later to check the finished file.
    const tool=(error as {toolDiagnostic?:{tool?:string;toolStep?:string}}|undefined)?.toolDiagnostic;
    if(error instanceof InstallationSnapshotError&&error.code==="AGE_PROCESS_FAILED"&&(error as {captureStep?:string}).captureStep==="private-stage"&&tool?.tool==="murage-backup-age"&&(tool.toolStep==="request"||tool.toolStep==="prepare")){
      const {toolDiagnostic,retainedDirectory,helperClosed}=error as unknown as {toolDiagnostic:object;retainedDirectory?:string;helperClosed?:boolean};
      error=withCaptureStep(Object.assign(new InstallationSnapshotError("BACKUP_FOLDER_UNUSABLE",{cause:error}),{toolDiagnostic,...(retainedDirectory?{retainedDirectory}:{}),...(helperClosed===undefined?{}:{helperClosed})}),"private-stage");
    }
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
  // An intermediate copy: the restore proper re-extracts (and flushes) it.
  const inspected=await inspectEncryptedInstallationBackup(archive,parent,{...options,durable:false});
  let restoredSuccessfully=false;
  try{
    if(inspected.sha256!==expectedSha256)fail("ARCHIVE_HASH_CHANGED");
    const target=dataDirLeasePaths(dataDir).canonicalDataDir;
    if(target===inspected.manifest.sourceInstallation||target.startsWith(inspected.manifest.sourceInstallation+sep))fail("RESTORE_SOURCE_TARGET_REFUSED");
    const recovery=validateInstallationArchiveManifest(inspected.manifest.recovery,options);
    // Move (not copy) the checked recovery files into the stage the restore
    // archive is made from, and drop the raw copies first: a restore needs no
    // more free space than necessary.
    rmSync(join(inspected.stateDirectory,"raw"),{recursive:true,force:true});
    const stage=mkdtempSync(join(inspected.directory,".recovery-"));
    if(recovery.files.length)renameSync(join(inspected.stateDirectory,"recovery"),join(stage,"state"));
    else mkdirSync(join(stage,"state"),{mode:0o700});
    const recoveryArchive=await writeInstallationStageArchive({directory:stage,manifest:{...recovery,format:"murage.installation-stage"} as StateSnapshotManifest},join(inspected.directory,"recovery.zip"),options);
    const restored=await restoreInstallation(target,recoveryArchive.path,recoveryArchive.sha256,{requireNew:true,...(process.platform==="win32"?{preparationParent:inspected.directory}:{})});
    restoredSuccessfully=true;
    return{...restored,encryptedSha256:inspected.sha256,coverage:inspected.manifest.coverage,rawFidelityActivated:false as const};
  }catch(error){if(process.platform==="win32"&&error&&typeof error==="object")Object.assign(error,{retainedDirectory:inspected.directory});throw error;}
  finally{if(process.platform!=="win32"||restoredSuccessfully)rmSync(inspected.directory,{recursive:true,force:true});}
}
