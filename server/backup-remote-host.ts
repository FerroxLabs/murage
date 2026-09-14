import {randomUUID} from "node:crypto";
import {z} from "zod";
import {backupReceiptSchema,type BackupReceipt} from "../shared/backup-schedule.ts";
import {resticS3TargetSchema,resticS3CredentialsSchema,type ResticS3Target,type ResticS3Credentials} from "./backup-restic-target.ts";

export const BACKUP_REMOTE_BINDING_KEY="backupRemoteBinding";
const reference=z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const revision=z.number().int().nonnegative();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema=resticS3TargetSchema.omit({kind:true,remoteRef:true,revision:true,credentialRef:true}).extend({
 label:z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/),credentials:resticS3CredentialsSchema,
}).strict();
const automaticSchema=z.object({revision,after:z.number().int().nonnegative(),jobId:hash.optional(),paused:z.boolean()}).strict();
const bindingSchema=z.object({version:z.literal(1),label:inputSchema.shape.label,target:resticS3TargetSchema,credentials:resticS3CredentialsSchema,passwordRef:reference.optional(),automatic:automaticSchema.optional()}).strict();
type Binding=z.infer<typeof bindingSchema>;
type Document=Record<string,unknown>;
interface RemoteAdapter {
 listBackups?():Promise<{repositoryId:string;backups:{snapshotId:string;jobId:string;createdAt:number;verified:false}[];ignored:number}>;
 downloadBackup?(snapshotId:string):Promise<{state:"downloaded-verified";snapshotId:string;repositoryId:string;archivePath:string;receiptPath:string;receipt:BackupReceipt}>;
 reconcile?(receipt:BackupReceipt):Promise<{state:string;jobId:string;snapshotId?:string}>;
 storedBackupStatus?(receipt:BackupReceipt):{state:"not-uploaded"|"needs-review"|"verified";jobId:string;snapshotId?:string};
 connectionStatus():{state:string;repositoryId?:string};
 connect():Promise<{connected:boolean;remoteRef:string;revision:number;repositoryId:string}>;
 store(archivePath:string,receipt:BackupReceipt):Promise<{state:string;snapshotId?:string;error?:string}>;
}
export interface BackupRemoteHostOptions {
 supported:()=>boolean;
 readProtected:()=>Promise<Document>;
 /** Must serialize derivation and durable OS-encrypted persistence. */
 updateProtected:(derive:(current:Document)=>Document)=>Promise<unknown>;
 selectPassword:()=>Promise<{passwordRef:string}|null>;
 createAdapter:(binding:Readonly<{target:ResticS3Target;credentials:ResticS3Credentials;passwordRef:string}>)=>RemoteAdapter;
 /** Resolve only current host-owned verified receipt and its bound destination. */
 latestVerified:()=>Promise<{archivePath:string;receipt:BackupReceipt}|null>;
 latestReceipt?:()=>BackupReceipt|undefined;
 chooseDownloadFolder?:()=>Promise<string|null>;
 exportDownloaded?:(copy:{state:"downloaded-verified";snapshotId:string;repositoryId:string;archivePath:string;receiptPath:string;receipt:BackupReceipt},folder:string)=>Promise<{saved:boolean;archivePath:string;directory:string}>;
 createId?:()=>string;
 now?:()=>number;
}
function refuse(code="BACKUP_REMOTE_REVIEW_REQUIRED"):never{throw Error(code);}
export interface BackupRemoteStatus {
 supported:boolean;pending:boolean;configured:boolean;state:string;
 revision?:number;remoteRef?:string;label?:string;passwordSelected?:boolean;repositoryId?:string;
 lastUpload?:{state:"not-uploaded"|"needs-review"|"verified";jobId:string};
 automaticUpload?:{enabled:boolean;state:"disabled"|"enabled"|"needs-review"};
}
function readBinding(document:Document):Binding|null{
 const raw=document[BACKUP_REMOTE_BINDING_KEY];if(raw===undefined)return null;
 try{if(typeof raw!=="string"||Buffer.byteLength(raw)>32768)throw Error();return bindingSchema.parse(JSON.parse(raw));}catch{return refuse();}
}
const safeErrors=new Set(["BACKUP_REMOTE_UNAVAILABLE","BACKUP_REMOTE_CHANGED","BACKUP_REMOTE_PASSWORD_REQUIRED","BACKUP_REMOTE_JOB_CHANGED","BACKUP_REMOTE_BUSY","BACKUP_REMOTE_INPUT_INVALID","BACKUP_REMOTE_REVIEW_REQUIRED"]);
/** Main-only orchestration: no arbitrary paths/commands or implicit connection. */
export function createBackupRemoteHost(options:BackupRemoteHostOptions){
 let pending=false;
 const id=()=>reference.parse((options.createId??randomUUID)());
 async function exclusive<T>(work:()=>Promise<T>):Promise<T>{
  if(pending)refuse("BACKUP_REMOTE_BUSY");pending=true;
  try{if(!options.supported())refuse("BACKUP_REMOTE_UNAVAILABLE");return await work();}
  catch(error){if(error instanceof Error&&safeErrors.has(error.message))throw error;return refuse();}
  finally{pending=false;}
 }
 function check(binding:Binding|null,expected:unknown,remoteRef?:unknown){
  if(!revision.safeParse(expected).success||(binding?.target.revision??0)!==expected||(remoteRef!==undefined&&binding?.target.remoteRef!==remoteRef))refuse("BACKUP_REMOTE_CHANGED");
 }
 function adapter(binding:Binding){
  if(!binding.passwordRef)refuse("BACKUP_REMOTE_PASSWORD_REQUIRED");
  return options.createAdapter({target:binding.target,credentials:binding.credentials,passwordRef:binding.passwordRef});
 }
 async function status():Promise<BackupRemoteStatus>{
  const supported=options.supported();if(!supported)return{supported:false,pending,configured:false,state:"unavailable"};
  try{
   const binding=readBinding(await options.readProtected());if(!binding)return{supported:true,pending,configured:false,revision:0,state:"unconfigured"};
   const automaticUpload:NonNullable<BackupRemoteStatus["automaticUpload"]>=!binding.automatic?{enabled:false,state:"disabled"}:{enabled:true,state:binding.automatic.paused||binding.automatic.revision!==binding.target.revision?"needs-review":"enabled"};
   const common={supported:true,pending,configured:true,label:binding.label,remoteRef:binding.target.remoteRef,revision:binding.target.revision,passwordSelected:!!binding.passwordRef,automaticUpload};
   if(!binding.passwordRef)return{...common,state:"password-required"};
   const storage=adapter(binding),saved=storage.connectionStatus();
   if(!["disconnected","initializing","needs-review","connected"].includes(saved.state))refuse();
   if(saved.state==="connected"&&!hash.safeParse(saved.repositoryId).success)refuse();
   let lastUpload:BackupRemoteStatus["lastUpload"];
   const receipt=options.latestReceipt?.();
   if(!pending&&saved.state==="connected"&&receipt&&storage.storedBackupStatus){
    const checked=backupReceiptSchema.parse(receipt);try{const result=storage.storedBackupStatus(checked);if(result.jobId!==checked.jobId||!["not-uploaded","needs-review","verified"].includes(result.state))refuse();lastUpload={state:result.state,jobId:result.jobId};}catch{lastUpload={state:"needs-review",jobId:checked.jobId};}
   }
   return{...common,state:saved.state,...(saved.state==="connected"?{repositoryId:saved.repositoryId}:{}),...(lastUpload?{lastUpload}:{})};
  }catch{return{supported:true,pending,configured:false,state:"needs-review"};}
 }
 async function save(expectedRevision:unknown,input:unknown){return exclusive(async()=>{
  const parsed=inputSchema.safeParse(input);if(!parsed.success)refuse("BACKUP_REMOTE_INPUT_INVALID");
  await options.updateProtected(current=>{
   const prior=readBinding(current);check(prior,expectedRevision);
   const {label,credentials,...target}=parsed.data;
   const next=bindingSchema.parse({version:1,label,credentials,target:{...target,kind:"s3",remoteRef:prior?.target.remoteRef??id(),credentialRef:id(),revision:(prior?.target.revision??0)+1},...(prior?.passwordRef?{passwordRef:prior.passwordRef}:{})});
   return{...current,[BACKUP_REMOTE_BINDING_KEY]:JSON.stringify(next)};
  });
  return{saved:true};
 });}
 async function selectRepositoryPassword(remoteRef:unknown,expectedRevision:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  const prior=readBinding(await options.readProtected());check(prior,expectedRevision,remoteRef);if(!prior)refuse();
  const selection=await options.selectPassword();if(!selection)return{cancelled:true};
  const passwordRef=reference.safeParse(selection.passwordRef);if(!passwordRef.success)refuse();
  await options.updateProtected(current=>{const binding=readBinding(current);check(binding,expectedRevision,remoteRef);if(!binding)refuse();const {automatic:_automatic,...rest}=binding;return{...current,[BACKUP_REMOTE_BINDING_KEY]:JSON.stringify({...rest,passwordRef:passwordRef.data,target:{...binding.target,revision:binding.target.revision+1}})};});
  return{selected:true};
 });}
 async function connect(remoteRef:unknown,expectedRevision:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();
  const result=await adapter(binding).connect();
  if(result.connected!==true||result.remoteRef!==binding.target.remoteRef||result.revision!==binding.target.revision||!hash.safeParse(result.repositoryId).success)refuse();
  return{connected:true,remoteRef:result.remoteRef,revision:result.revision,repositoryId:result.repositoryId};
 });}
 async function uploadLatest(remoteRef:unknown,expectedRevision:unknown,jobId:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  if(!hash.safeParse(jobId).success)refuse("BACKUP_REMOTE_JOB_CHANGED");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();
  const selected=await options.latestVerified();const receipt=backupReceiptSchema.safeParse(selected?.receipt);
  if(!selected||!receipt.success||receipt.data.jobId!==jobId)refuse("BACKUP_REMOTE_JOB_CHANGED");
  // Paths originate only in the host resolver. BackupRestic validates bytes and
  // repository identity, then verifies the uploaded snapshot by restoring it.
  const result=await adapter(binding).store(selected.archivePath,receipt.data);
  if(!["verified","needs-review"].includes(result.state))refuse();
  if(result.state==="verified"&&!hash.safeParse(result.snapshotId).success)refuse();
  return{state:result.state,jobId:receipt.data.jobId,remoteRef:binding.target.remoteRef,revision:binding.target.revision,...(hash.safeParse(result.snapshotId).success?{snapshotId:result.snapshotId}:{})};
 });}
 async function setAutomaticUpload(remoteRef:unknown,expectedRevision:unknown,enabled:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  if(typeof enabled!=="boolean")refuse("BACKUP_REMOTE_INPUT_INVALID");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();
  if(enabled&&binding.automatic)return{saved:true};
  let automatic:Binding["automatic"];
  if(enabled){
   const connected=adapter(binding).connectionStatus();if(connected.state!=="connected"||!hash.safeParse(connected.repositoryId).success)refuse();
   if(!options.latestReceipt)refuse();
   const latest=options.latestReceipt(),receipt=latest===undefined?undefined:backupReceiptSchema.parse(latest);
   const now=z.number().int().nonnegative().parse((options.now??Date.now)());
   automatic={revision:binding.target.revision,after:Math.max(now,receipt?.verifiedAt??0),...(receipt?{jobId:receipt.jobId}:{}),paused:false};
  }
  await options.updateProtected(current=>{const next=readBinding(current);check(next,expectedRevision,remoteRef);if(!next)refuse();const {automatic:_automatic,...rest}=next;return{...current,[BACKUP_REMOTE_BINDING_KEY]:JSON.stringify({...rest,...(automatic?{automatic}:{})})};});
  return{saved:true};
 });}
 /** Main-only polling entry. No implicit connection or retry after an uncertain store. */
 async function runAutomaticUpload(){return exclusive(async()=>{
  const binding=readBinding(await options.readProtected()),policy=binding?.automatic;
  if(!binding||!policy)return{state:"disabled"};
  if(policy.paused||policy.revision!==binding.target.revision)return{state:"needs-review"};
  const storage=adapter(binding),connected=storage.connectionStatus();
  if(connected.state!=="connected"||!hash.safeParse(connected.repositoryId).success)return{state:"needs-review"};
  const current=options.latestReceipt?.();if(!current)return{state:"not-due"};
  const candidate=backupReceiptSchema.parse(current);
  if(candidate.verifiedAt<=policy.after||candidate.jobId===policy.jobId)return{state:"not-due"};
  const selected=await options.latestVerified(),checked=backupReceiptSchema.safeParse(selected?.receipt);
  if(!selected||!checked.success||JSON.stringify(checked.data)!==JSON.stringify(candidate))refuse("BACKUP_REMOTE_JOB_CHANGED");
  // Durable pause precedes store: process loss or provider uncertainty cannot replay.
  const paused={...policy,paused:true};
  await options.updateProtected(document=>{const next=readBinding(document);check(next,binding.target.revision,binding.target.remoteRef);if(!next||JSON.stringify(next.automatic)!==JSON.stringify(policy))refuse();return{...document,[BACKUP_REMOTE_BINDING_KEY]:JSON.stringify({...next,automatic:paused})};});
  const result=await storage.store(selected.archivePath,checked.data);
  if(!["verified","needs-review"].includes(result.state)||(result.state==="verified"&&!hash.safeParse(result.snapshotId).success))refuse();
  if(result.state==="verified")await options.updateProtected(document=>{const next=readBinding(document);check(next,binding.target.revision,binding.target.remoteRef);if(!next||JSON.stringify(next.automatic)!==JSON.stringify(paused))refuse();return{...document,[BACKUP_REMOTE_BINDING_KEY]:JSON.stringify({...next,automatic:{...policy,after:checked.data.verifiedAt,jobId:checked.data.jobId,paused:false}})};});
  return{state:result.state,jobId:checked.data.jobId};
 });}
 async function reconcileLatest(remoteRef:unknown,expectedRevision:unknown,jobId:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();
  const receipt=backupReceiptSchema.safeParse(options.latestReceipt?.());if(!receipt.success||receipt.data.jobId!==jobId)refuse("BACKUP_REMOTE_JOB_CHANGED");
  const storage=adapter(binding);if(!storage.reconcile)refuse();const result=await storage.reconcile(receipt.data);
  if(result.jobId!==jobId||!["needs-review","verified"].includes(result.state)||(result.state==="verified"&&!hash.safeParse(result.snapshotId).success))refuse();
  return{state:result.state,jobId:receipt.data.jobId,...(result.state==="verified"?{snapshotId:result.snapshotId}:{})};
 });}
 async function listBackups(remoteRef:unknown,expectedRevision:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();const storage=adapter(binding);if(!storage.listBackups)refuse();
  const result=await storage.listBackups();
  return z.object({repositoryId:hash,backups:z.array(z.object({snapshotId:hash,jobId:hash,createdAt:z.number().int().nonnegative(),verified:z.literal(false)}).strict()).max(1000),ignored:z.number().int().nonnegative()}).strict().parse(result);
 });}
 async function downloadBackup(remoteRef:unknown,expectedRevision:unknown,snapshotId:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success||!hash.safeParse(snapshotId).success)refuse("BACKUP_REMOTE_CHANGED");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding||!options.chooseDownloadFolder||!options.exportDownloaded)refuse();
  const folder=await options.chooseDownloadFolder();if(!folder)return{cancelled:true as const};
  const current=readBinding(await options.readProtected());check(current,expectedRevision,remoteRef);if(!current)refuse();const storage=adapter(current);if(!storage.downloadBackup)refuse();
  const copy=await storage.downloadBackup(snapshotId as string);backupReceiptSchema.parse(copy.receipt);
  if(copy.state!=="downloaded-verified"||copy.snapshotId!==snapshotId||!hash.safeParse(copy.repositoryId).success)refuse();const saved=await options.exportDownloaded(copy,folder);if(saved.saved!==true)refuse();
  return{saved:true as const,archivePath:saved.archivePath,directory:saved.directory};
 });}
 return{status,save,selectRepositoryPassword,connect,uploadLatest,setAutomaticUpload,runAutomaticUpload,reconcileLatest,listBackups,downloadBackup,isPending:()=>pending};
}
