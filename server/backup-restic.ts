import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, writeFileSync, writeSync, type BigIntStats } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { backupReceiptSchema, type BackupReceipt } from "../shared/backup-schedule.ts";
import { acquireDataDirLeaseForProcess } from "./data-dir-lease.ts";
import { writeFileAtomic } from "./atomic.ts";
import { resticChildEnvironment,resticS3CredentialsSchema,resticS3Repository,resticS3TargetSchema,type ResticS3Credentials,type ResticS3Run,type ResticS3Target } from "./backup-restic-target.ts";
import {trustedBackupResticExecutable} from "../electron/backup-restic-attestation.mjs";
export type { ResticS3Credentials,ResticS3Target } from "./backup-restic-target.ts";

export {RESTIC_ORIGINAL_SHA256} from "../shared/backup-restic-pin.mjs";
const digest=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
/** Hash only the admitted restored bytes, keeping one bounded buffer and fd. */
function restoredArchiveDigest(path:string,expectedBytes:number):string {
  const before=lstatSync(path,{bigint:true});
  const valid=(stat:BigIntStats)=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&stat.size===BigInt(expectedBytes);
  const same=(stat:BigIntStats)=>valid(stat)&&(["dev","ino","mode","size","nlink","mtimeNs","ctimeNs"] as const).every(key=>stat[key]===before[key]);
  if(!valid(before))throw new Error("RESTIC_ARCHIVE_CHANGED");
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    if(!same(fstatSync(fd,{bigint:true})))throw new Error("RESTIC_ARCHIVE_CHANGED");
    const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let count=0;
    while(count<expectedBytes){
      const length=readSync(fd,buffer,0,Math.min(buffer.length,expectedBytes-count),count);
      if(length<=0)throw new Error("RESTIC_ARCHIVE_CHANGED");
      count+=length;hash.update(buffer.subarray(0,length));
    }
    if(!same(fstatSync(fd,{bigint:true}))||!same(lstatSync(path,{bigint:true})))throw new Error("RESTIC_ARCHIVE_CHANGED");
    return hash.digest("hex");
  }finally{closeSync(fd);}
}
const snapshotId=z.string().regex(/^[a-f0-9]{64}$/);
const remoteSnapshotSchema=z.object({id:snapshotId,hostname:z.literal("murage"),time:z.string().max(100),tags:z.array(z.string().max(200)).max(32),paths:z.array(z.string().max(8192)).length(2)});
const repositoryBindingSchema=z.object({kind:z.literal("s3"),remoteRef:z.string().max(120),revision:z.number().int().nonnegative(),targetHash:snapshotId,repositoryId:snapshotId}).strict();
const targetStateSchema=z.object({version:z.literal(1),remoteRef:z.string().max(120),revision:z.number().int().nonnegative(),targetHash:snapshotId,state:z.enum(["initializing","needs-review","connected"]),repositoryId:snapshotId.optional()}).strict();
const journalSchema=z.object({version:z.literal(1),jobId:snapshotId,input:backupReceiptSchema,stage:z.string(),repository:repositoryBindingSchema.optional(),state:z.enum(["uploading","needs-review","verified"]),snapshotId:snapshotId.optional(),error:z.enum(["incomplete","repository-locked","wrong-password","operation-failed","upload-uncertain","snapshot-mismatch","restore-mismatch"]).optional()}).strict();
export interface ResticRun { args:string[]; cwd:string; password:Uint8Array; timeoutMs:number;s3?:ResticS3Run }
export interface ResticResult { code:number|null; stdout:string; uncertain?:boolean }
export type ResticRunner=(input:ResticRun)=>Promise<ResticResult>;
export interface BackupResticOptions { executable:string; repository:string|ResticS3Target; workDirectory:string; password:()=>Promise<Uint8Array>; runner?:ResticRunner; timeoutMs?:number; maxBytes?:number;credentials?:(target:Readonly<ResticS3Target>)=>Promise<ResticS3Credentials>;authorizeInitialization?:(input:{target:Readonly<ResticS3Target>;credentials:Readonly<ResticS3Credentials>})=>Promise<void> }

/** Password uses restic's documented-source non-TTY stdin branch. */
export function resticRunner(executable:string):ResticRunner {
  return input=>new Promise((resolveResult,reject)=>{
    try {
      if(!trustedBackupResticExecutable(executable))throw Error();
    }catch{reject(new Error("RESTIC_TOOL_UNVERIFIED"));return;}
    let env:Record<string,string>;try{env=resticChildEnvironment(input.cwd,input.s3);}catch{reject(Error("RESTIC_S3_CREDENTIALS_INVALID"));return;}
    const child=spawn(executable,input.args,{cwd:input.cwd,env,stdio:["pipe","pipe","pipe"],windowsHide:true});
    let stdout="",overflow=false,timedOut=false,closed=false;let escalation:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{child.kill("SIGTERM");escalation=setTimeout(()=>{if(!closed)child.kill("SIGKILL");},1000);};
    const timer=setTimeout(()=>{timedOut=true;stop();},input.timeoutMs);
    child.stdout.on("data",chunk=>{if(stdout.length+chunk.length>2*1024*1024){if(!overflow){overflow=true;stop();}}else stdout+=chunk;});
    child.stderr.resume();child.stdin.on("error",()=>{});
    child.once("error",()=>{closed=true;clearTimeout(timer);if(escalation)clearTimeout(escalation);reject(new Error("RESTIC_PROCESS_FAILED"));});
    child.once("close",code=>{closed=true;clearTimeout(timer);if(escalation)clearTimeout(escalation);resolveResult({code,stdout:overflow?"":stdout,uncertain:timedOut||overflow});});
    child.stdin.end(Buffer.concat([input.password,Buffer.from("\n")]));
  });
}

/** Verified ciphertext storage; S3 requires explicit host-owned connection. */
export class BackupRestic {
  private options:BackupResticOptions;
  private run:ResticRunner;
  private target?:Readonly<ResticS3Target>;
  constructor(options:BackupResticOptions){
    if(!isAbsolute(options.workDirectory)||options.workDirectory.startsWith("\\\\"))throw new Error("RESTIC_LOCAL_PATH_REQUIRED");
    if(typeof options.repository==="string"){
      if(!isAbsolute(options.repository)||options.repository.startsWith("\\\\"))throw new Error("RESTIC_LOCAL_PATH_REQUIRED");
      if(resolve(options.repository)===resolve(options.workDirectory))throw new Error("RESTIC_SEPARATE_DIRECTORIES_REQUIRED");
    }else{try{this.target=Object.freeze(resticS3TargetSchema.parse(options.repository));}catch{throw Error("RESTIC_S3_TARGET_INVALID");}}
    this.options={...options,repository:this.target??options.repository};this.run=options.runner??resticRunner(options.executable);
  }
  private async resolveCredentials(){try{if(!this.target||typeof this.options.credentials!=="function")throw Error();return Object.freeze(resticS3CredentialsSchema.parse(await this.options.credentials(this.target)));}catch{throw Error("RESTIC_S3_CREDENTIALS_UNAVAILABLE");}}
  private async readPassword(){try{return Buffer.from(await this.options.password());}catch(error){if(this.target)throw Error("RESTIC_PASSWORD_UNAVAILABLE");throw error;}}
  private async execute(args:string[],cwd:string,preparedCredentials?:Readonly<ResticS3Credentials>){
    const s3=this.target?{repository:resticS3Repository(this.target),region:this.target.region,bucketLookup:this.target.bucketLookup,credentials:preparedCredentials??await this.resolveCredentials()}:undefined;
    const password=await this.readPassword();
    try{
      if(!password.length||password.length>4096||password.includes(10)||password.includes(13)||password.includes(0))throw new Error("RESTIC_PASSWORD_INVALID");
      const result=await this.run({args:s3?["--json","--no-cache","-o",`s3.bucket-lookup=${s3.bucketLookup}`,...args]:["--repo",this.options.repository as string,"--json","--no-cache",...args],cwd,password,timeoutMs:this.options.timeoutMs??60000,...(s3?{s3}:{})});
      if(s3&&(typeof result.stdout!=="string"||Buffer.byteLength(result.stdout)>2*1024*1024))throw Error("RESTIC_RESULT_INVALID");return result;
    }catch(error){if(s3)throw Error("RESTIC_REMOTE_OPERATION_FAILED");throw error;
    }finally{password.fill(0);}
  }
  private lock(){mkdirSync(this.options.workDirectory,{recursive:true,mode:0o700});return acquireDataDirLeaseForProcess(this.options.workDirectory);}
  private targetIdentity(){if(!this.target)throw Error("RESTIC_S3_TARGET_REQUIRED");return{remoteRef:this.target.remoteRef,revision:this.target.revision,targetHash:digest(JSON.stringify(this.target))};}
  private targetFile(){return join(this.options.workDirectory,"restic-target.json");}
  private readTarget(){
    try{const stat=lstatSync(this.targetFile());if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>32768)throw Error();const value=targetStateSchema.parse(JSON.parse(readFileSync(this.targetFile(),"utf8"))),identity=this.targetIdentity();if(value.remoteRef!==identity.remoteRef||value.revision!==identity.revision||value.targetHash!==identity.targetHash)throw Error();return value;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw Error("RESTIC_TARGET_REVIEW_REQUIRED");}
  }
  private saveTarget(value:z.infer<typeof targetStateSchema>){writeFileAtomic(this.targetFile(),JSON.stringify(targetStateSchema.parse(value)),{mode:0o600});}
  /** Read saved connection evidence only. Never opens credentials or a process. */
  connectionStatus(){
    if(!this.target)throw Error("RESTIC_S3_TARGET_REQUIRED");
    const state=this.readTarget();
    return {remoteRef:this.target.remoteRef,revision:this.target.revision,state:state?.state??"disconnected",...(state?.state==="connected"&&state.repositoryId?{repositoryId:state.repositoryId}:{})};
  }
  private readStoredJournal(rawReceipt:BackupReceipt){
    const receipt=backupReceiptSchema.parse(rawReceipt),file=join(this.options.workDirectory,receipt.jobId+".json");
    let fd:number|undefined;
    try{
      const before=lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>32768n)throw Error();
      const same=(s:BigIntStats)=>(["dev","ino","size","mode","mtimeNs","ctimeNs","nlink"]as const).every(key=>s[key]===before[key]);
      fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);if(!same(fstatSync(fd,{bigint:true})))throw Error();const bytes=Buffer.alloc(Number(before.size));let offset=0;
      while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw Error();offset+=n;}
      if(!same(fstatSync(fd,{bigint:true}))||!same(lstatSync(file,{bigint:true})))throw Error();
      const prior=journalSchema.parse(JSON.parse(bytes.toString("utf8"))),target=this.readTarget();
      if(!target||target.state!=="connected"||!target.repositoryId||JSON.stringify(prior.input)!==JSON.stringify(receipt)||JSON.stringify(prior.repository)!==JSON.stringify(repositoryBindingSchema.parse({kind:"s3",...this.targetIdentity(),repositoryId:target.repositoryId})))throw Error();
      if(prior.state==="verified"&&!prior.snapshotId)throw Error();
      return prior;
    }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw Error("RESTIC_JOB_REVIEW_REQUIRED");}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  storedBackupStatus(rawReceipt:BackupReceipt):{state:"not-uploaded"|"needs-review"|"verified";jobId:string;snapshotId?:string}{
    const receipt=backupReceiptSchema.parse(rawReceipt),prior=this.readStoredJournal(receipt);
    return{state:!prior?"not-uploaded":prior.state==="verified"?"verified":"needs-review",jobId:receipt.jobId,...(prior?.snapshotId?{snapshotId:prior.snapshotId}:{})};
  }
  private async verifySnapshot(id:string,receipt:BackupReceipt,stage:string,options?:{expectedPaths?:string[];onVerified?:(directory:string)=>void}):Promise<"snapshot-mismatch"|"restore-mismatch"|undefined>{
    const listed=await this.execute(["snapshots",id],stage);if(listed.code!==0||listed.uncertain)return "snapshot-mismatch";
    const snapshots=JSON.parse(listed.stdout),expectedPaths=[...(options?.expectedPaths??[join(stage,"backup.age"),join(stage,"receipt.json")])].sort();
    if(!Array.isArray(snapshots)||snapshots.length!==1||snapshots[0].id!==id||!snapshots[0].tags?.includes(`murage-job:${receipt.jobId}`)||JSON.stringify([...snapshots[0].paths].sort())!==JSON.stringify(expectedPaths))return "snapshot-mismatch";
    const restore=mkdtempSync(join(this.options.workDirectory,"restore-"));
    const restored=await this.execute(["restore",id,"--target",restore,"--verify"],stage);if(restored.code!==0||restored.uncertain)return "restore-mismatch";
    if(JSON.stringify(readdirSync(restore).sort())!==JSON.stringify(["backup.age","receipt.json"]))return "restore-mismatch";
    const receiptText=JSON.stringify(receipt);
    const restoredPath=(name:"backup.age"|"receipt.json",bytes:number)=>{const path=join(restore,name),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==bytes)throw Error();return path;};
    if(restoredArchiveDigest(restoredPath("backup.age",receipt.bytes),receipt.bytes)!==receipt.sha256||readFileSync(restoredPath("receipt.json",Buffer.byteLength(receiptText)),"utf8")!==receiptText)return "restore-mismatch";
    options?.onVerified?.(restore);
  }
  async reconcile(rawReceipt:BackupReceipt){
    const receipt=backupReceiptSchema.parse(rawReceipt),lease=this.lock();
    try{
      const repository=await this.connectedRepository(),prior=this.readStoredJournal(receipt);
      if(!prior||JSON.stringify(prior.repository)!==JSON.stringify(repository))throw Error("RESTIC_JOB_REVIEW_REQUIRED");
      if(prior.state==="verified")return{state:"verified",jobId:receipt.jobId,snapshotId:prior.snapshotId};
      const file=join(this.options.workDirectory,receipt.jobId+".json");
      const save=()=>writeFileAtomic(file,JSON.stringify(journalSchema.parse(prior)),{mode:0o600});
      const failed=()=>{prior.state="needs-review";prior.error="snapshot-mismatch";save();return{state:"needs-review",jobId:receipt.jobId};};
      // Stage is private host state, never a caller-supplied working directory.
      if(!isAbsolute(prior.stage)||!prior.stage.startsWith(realpathSync.native(this.options.workDirectory)+"/")||realpathSync.native(prior.stage)!==prior.stage||!lstatSync(prior.stage).isDirectory())throw Error("RESTIC_JOB_REVIEW_REQUIRED");
      try{
        const listed=await this.execute(["snapshots","--tag",`murage-job:${receipt.jobId}`],prior.stage);
        if(listed.code!==0||listed.uncertain)return failed();const rows=JSON.parse(listed.stdout);
        if(!Array.isArray(rows)||rows.length!==1||!snapshotId.safeParse(rows[0]?.id).success||!rows[0]?.tags?.includes(`murage-job:${receipt.jobId}`))return failed();
        const id=rows[0].id as string;
        if(prior.snapshotId&&prior.snapshotId!==id)return failed();
        if(await this.verifySnapshot(id,receipt,prior.stage)||await this.repositoryId()!==repository.repositoryId)return failed();
        prior.state="verified";prior.snapshotId=id;delete prior.error;save();return{state:"verified",jobId:receipt.jobId,snapshotId:id};
      }catch{return failed();}
    }finally{lease.release();}
  }
  private async repositoryId(credentials?:Readonly<ResticS3Credentials>){
    const result=await this.execute(["--no-lock","cat","config"],this.options.workDirectory,credentials);
    if(result.uncertain)throw Error("RESTIC_CONNECT_UNCONFIRMED");if(result.code===10)throw Error("RESTIC_REPOSITORY_MISSING");if(result.code===12)throw Error("RESTIC_WRONG_PASSWORD");if(result.code!==0)throw Error("RESTIC_CONNECT_UNCONFIRMED");
    try{const value=JSON.parse(result.stdout);if(!value||![1,2].includes(value.version))throw Error();return snapshotId.parse(value.id);}catch{throw Error("RESTIC_REPOSITORY_ID_INVALID");}
  }
  private async connectedRepository(){
    const state=this.readTarget();if(!state||state.state!=="connected"||!state.repositoryId)throw Error("RESTIC_CONNECTION_REQUIRED");if(await this.repositoryId()!==state.repositoryId)throw Error("RESTIC_REPOSITORY_CHANGED");return repositoryBindingSchema.parse({kind:"s3",...this.targetIdentity(),repositoryId:state.repositoryId});
  }
  async connect(){
    if(!this.target)throw Error("RESTIC_S3_TARGET_REQUIRED");const lease=this.lock();try{const prior=this.readTarget(),repositoryId=await this.repositoryId();if(prior?.repositoryId&&prior.repositoryId!==repositoryId)throw Error("RESTIC_REPOSITORY_CHANGED");this.saveTarget({version:1,...this.targetIdentity(),state:"connected",repositoryId});return{connected:true,remoteRef:this.target.remoteRef,revision:this.target.revision,repositoryId};}finally{lease.release();}
  }
  async listBackups(){
    const lease=this.lock();try{
      const repository=await this.connectedRepository();
      const result=await this.execute(["snapshots","--host","murage"],this.options.workDirectory);
      if(result.code!==0||result.uncertain)throw Error("RESTIC_CATALOG_UNCONFIRMED");
      let rows:unknown;try{rows=JSON.parse(result.stdout);}catch{throw Error("RESTIC_CATALOG_INVALID");}
      if(!Array.isArray(rows)||rows.length>1000)throw Error("RESTIC_CATALOG_INVALID");
      const backups:{snapshotId:string;jobId:string;createdAt:number;verified:false}[]=[],seen=new Set<string>();let ignored=0;
      for(const row of rows){
        const parsed=remoteSnapshotSchema.safeParse(row);if(!parsed.success){ignored++;continue;}const value=parsed.data;
        const tags=value.tags.filter(tag=>/^murage-job:[a-f0-9]{64}$/.test(tag));const createdAt=Date.parse(value.time);
        if(tags.length!==1||!Number.isFinite(createdAt)||createdAt<0||JSON.stringify(value.paths.map(file=>basename(file)).sort())!==JSON.stringify(["backup.age","receipt.json"])){ignored++;continue;}
        if(seen.has(value.id))throw Error("RESTIC_CATALOG_INVALID");seen.add(value.id);
        backups.push({snapshotId:value.id,jobId:tags[0].slice("murage-job:".length),createdAt,verified:false});
      }
      if(await this.repositoryId()!==repository.repositoryId)throw Error("RESTIC_REPOSITORY_CHANGED");
      backups.sort((a,b)=>b.createdAt-a.createdAt||a.snapshotId.localeCompare(b.snapshotId));
      return{repositoryId:repository.repositoryId,backups,ignored};
    }finally{lease.release();}
  }
  async downloadBackup(requestedId:string){
    const id=snapshotId.parse(requestedId),lease=this.lock();
    try{
      const repository=await this.connectedRepository();
      const listed=await this.execute(["snapshots",id],this.options.workDirectory);
      if(listed.code!==0||listed.uncertain)throw Error("RESTIC_DOWNLOAD_UNCONFIRMED");
      const rows=JSON.parse(listed.stdout);if(!Array.isArray(rows)||rows.length!==1)throw Error("RESTIC_DOWNLOAD_UNCONFIRMED");
      const summary=remoteSnapshotSchema.parse(rows[0]),tags=summary.tags.filter(tag=>/^murage-job:[a-f0-9]{64}$/.test(tag));
      if(summary.id!==id||tags.length!==1||JSON.stringify(summary.paths.map(file=>basename(file)).sort())!==JSON.stringify(["backup.age","receipt.json"]))throw Error("RESTIC_DOWNLOAD_UNCONFIRMED");
      const dumped=await this.execute(["dump",id,"/receipt.json"],this.options.workDirectory);
      if(dumped.code!==0||dumped.uncertain||Buffer.byteLength(dumped.stdout)>32768)throw Error("RESTIC_DOWNLOAD_UNCONFIRMED");
      const receipt=backupReceiptSchema.parse(JSON.parse(dumped.stdout));
      if(tags[0]!==`murage-job:${receipt.jobId}`||receipt.bytes>(this.options.maxBytes??1024**3))throw Error("RESTIC_DOWNLOAD_UNCONFIRMED");
      let directory:string|undefined;
      const mismatch=await this.verifySnapshot(id,receipt,this.options.workDirectory,{expectedPaths:summary.paths,onVerified:value=>{directory=value;}});
      if(mismatch||!directory||await this.repositoryId()!==repository.repositoryId)throw Error("RESTIC_DOWNLOAD_UNCONFIRMED");
      return{state:"downloaded-verified" as const,snapshotId:id,repositoryId:repository.repositoryId,archivePath:join(directory,"backup.age"),receiptPath:join(directory,"receipt.json"),receipt};
    }catch{throw Error("RESTIC_DOWNLOAD_UNCONFIRMED");}finally{lease.release();}
  }
  async initialize(){const lease=this.lock();try{
    if(!this.target){try{lstatSync(this.options.repository as string);throw new Error("RESTIC_REPOSITORY_EXISTS");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}const result=await this.execute(["init","--repository-version","2"],this.options.workDirectory);if(result.code!==0||result.uncertain)throw new Error("RESTIC_INIT_UNCONFIRMED");return {initialized:true};}
    if(typeof this.options.authorizeInitialization!=="function")throw Error("RESTIC_INITIALIZATION_GUARD_REQUIRED");
    if(this.readTarget())throw Error("RESTIC_TARGET_REVIEW_REQUIRED");const credentials=await this.resolveCredentials();
    // This host function must establish existing bucket/restricted credentials.
    // Its availability is not evidence that a real provider guard is deployed.
    try{await this.options.authorizeInitialization({target:this.target,credentials});}catch{throw Error("RESTIC_INITIALIZATION_REFUSED");}
    try{await this.repositoryId(credentials);throw Error("RESTIC_REPOSITORY_EXISTS");}catch(error){if(!(error instanceof Error)||error.message!=="RESTIC_REPOSITORY_MISSING")throw error;}
    const state:z.infer<typeof targetStateSchema>={version:1,...this.targetIdentity(),state:"initializing"};this.saveTarget(state);
    try{const result=await this.execute(["init","--repository-version","2"],this.options.workDirectory,credentials);if(result.code!==0||result.uncertain)throw Error();const repositoryId=await this.repositoryId(credentials);this.saveTarget({...state,state:"connected",repositoryId});return{initialized:true,remoteRef:this.target.remoteRef,revision:this.target.revision,repositoryId};}catch{this.saveTarget({...state,state:"needs-review"});throw Error("RESTIC_INIT_UNCONFIRMED");}
  }finally{lease.release();}}
  async store(archivePath:string,rawReceipt:BackupReceipt){
    const receipt=backupReceiptSchema.parse(rawReceipt),lease=this.lock();
    const journal=join(this.options.workDirectory,receipt.jobId+".json");
    try{
      const repository=this.target?await this.connectedRepository():undefined;
      const publicIdentity=repository?{remoteRef:repository.remoteRef,revision:repository.revision,repositoryId:repository.repositoryId,jobId:receipt.jobId,archiveSha256:receipt.sha256}:{};
      try{
        const stat=lstatSync(journal);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)throw Error();
        const prior=journalSchema.parse(JSON.parse(readFileSync(journal,"utf8")));if(JSON.stringify(prior.input)!==JSON.stringify(receipt)||JSON.stringify(prior.repository)!==JSON.stringify(repository))throw Error();
        if(prior.state==="uploading"){prior.state="needs-review";prior.error="upload-uncertain";writeFileAtomic(journal,JSON.stringify(prior),{mode:0o600});}
        return {state:prior.state,snapshotId:prior.snapshotId,error:prior.error,...publicIdentity};
      }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("RESTIC_JOB_REVIEW_REQUIRED");}
      if(!isAbsolute(archivePath)||!basename(archivePath).endsWith(".age"))throw new Error("RESTIC_VERIFIED_ARCHIVE_REQUIRED");
      const before=lstatSync(archivePath);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==receipt.bytes||before.size>(this.options.maxBytes??1024**3))throw new Error("RESTIC_VERIFIED_ARCHIVE_REQUIRED");
      const fd=openSync(archivePath,constants.O_RDONLY|constants.O_NOFOLLOW);
      // restic/Go resolves cwd physically; compare its snapshot paths to the
      // same identity, including macOS /var -> /private/var aliases.
      const stage=realpathSync.native(mkdtempSync(join(this.options.workDirectory,"capture-")));const archive=join(stage,"backup.age"),receiptPath=join(stage,"receipt.json");
      const out=openSync(archive,"wx",0o600),hash=createHash("sha256");
      try{
        const opened=fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)throw Error();
        const buffer=Buffer.alloc(65536);let count=0;
        for(;;){const length=readSync(fd,buffer,0,buffer.length,null);if(!length)break;count+=length;if(count>receipt.bytes)throw Error();hash.update(buffer.subarray(0,length));let offset=0;while(offset<length)offset+=writeSync(out,buffer,offset,length-offset);}
        if(count!==receipt.bytes||hash.digest("hex")!==receipt.sha256)throw Error();
      }catch{throw new Error("RESTIC_ARCHIVE_CHANGED");}finally{closeSync(fd);closeSync(out);}
      const receiptText=JSON.stringify(receipt);writeFileSync(receiptPath,receiptText,{flag:"wx",mode:0o600});
      const state:z.infer<typeof journalSchema>={version:1,jobId:receipt.jobId,input:receipt,stage,state:"uploading",...(repository?{repository}:{})};
      const save=()=>writeFileAtomic(journal,JSON.stringify(journalSchema.parse(state)),{mode:0o600});save();
      const fail=(error:NonNullable<typeof state.error>)=>{state.state="needs-review";state.error=error;save();return {state:state.state,snapshotId:state.snapshotId,error,...publicIdentity};};
      try{
        const uploaded=await this.execute(["backup","--host","murage","--tag",`murage-job:${receipt.jobId}`,"backup.age","receipt.json"],stage);
        if(uploaded.code!==0||uploaded.uncertain)return fail(uploaded.code===3?"incomplete":uploaded.code===11?"repository-locked":uploaded.code===12?"wrong-password":"upload-uncertain");
        const summaries=uploaded.stdout.trim().split("\n").flatMap(line=>{try{const row=JSON.parse(line);return row.message_type==="summary"?[row]:[];}catch{return [];}});
        const id=snapshotId.safeParse(summaries.at(-1)?.snapshot_id);if(!id.success)return fail("upload-uncertain");state.snapshotId=id.data;save();
        const mismatch=await this.verifySnapshot(id.data,receipt,stage);if(mismatch)return fail(mismatch);
        if(repository&&await this.repositoryId()!==repository.repositoryId)return fail("snapshot-mismatch");
        state.state="verified";save();return {state:state.state,snapshotId:id.data,...publicIdentity};
      }catch{return fail("operation-failed");}
    }finally{lease.release();}
  }
}
