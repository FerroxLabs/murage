import {randomUUID} from "node:crypto";
import {z} from "zod";
import {backupReceiptSchema,type BackupReceipt} from "../shared/backup-schedule.ts";
import {resticS3TargetSchema,resticS3CredentialsSchema,resticSftpTargetSchema,resticSftpCredentialsSchema,sftpHostSchema,sftpUserSchema,sftpPortSchema,sftpFolderSchema,type ResticS3Target,type ResticS3Credentials,type ResticSftpTarget,type ResticSftpCredentials} from "./backup-restic-target.ts";
import {createSshKeyPair,checkedHostKey,sshFingerprint} from "./backup-sftp.ts";

export const BACKUP_REMOTE_BINDING_KEY="backupRemoteBinding";
const reference=z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const revision=z.number().int().nonnegative();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const label=z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/);
const inputSchema=resticS3TargetSchema.omit({kind:true,remoteRef:true,revision:true,credentialRef:true}).extend({
 label,credentials:resticS3CredentialsSchema,
}).strict();
/** SFTP carries no secret in: Murage makes the key itself, in main. */
const sftpInputSchema=z.object({kind:z.literal("sftp"),label,host:sftpHostSchema,port:sftpPortSchema,user:sftpUserSchema,folder:sftpFolderSchema}).strict();
const automaticSchema=z.object({revision,after:z.number().int().nonnegative(),jobId:hash.optional(),paused:z.boolean()}).strict();
const s3BindingSchema=z.object({version:z.literal(1),label,target:resticS3TargetSchema,credentials:resticS3CredentialsSchema,passwordRef:reference.optional(),automatic:automaticSchema.optional(),maintenanceCredentials:resticS3CredentialsSchema.optional()}).strict();
const sftpBindingSchema=z.object({version:z.literal(1),label,target:resticSftpTargetSchema,credentials:resticSftpCredentialsSchema,passwordRef:reference.optional(),automatic:automaticSchema.optional()}).strict();
const bindingSchema=z.union([s3BindingSchema,sftpBindingSchema]);
type Binding=z.infer<typeof bindingSchema>;
type Document=Record<string,unknown>;
interface RemoteAdapter {
 listBackups?():Promise<{repositoryId:string;backups:{snapshotId:string;jobId:string;createdAt:number;verified:false}[];ignored:number}>;
 downloadBackup?(snapshotId:string):Promise<{state:"downloaded-verified";snapshotId:string;repositoryId:string;archivePath:string;receiptPath:string;receipt:BackupReceipt}>;
 reconcile?(receipt:BackupReceipt):Promise<{state:string;jobId:string;snapshotId?:string}>;
 storedBackupStatus?(receipt:BackupReceipt):{state:"not-uploaded"|"needs-review"|"verified";jobId:string;snapshotId?:string;lockRelease?:"unconfirmed"};
 connectionStatus():{state:string;repositoryId?:string;serverCheck?:string};
 prepareRepository?():Promise<{connected:boolean;created:boolean;remoteRef:string;revision:number;repositoryId:string}>;
 scanServerIdentity?():Promise<{type:string;key:string;fingerprint:string}>;
 connect():Promise<{connected:boolean;remoteRef:string;revision:number;repositoryId:string}>;
 store(archivePath:string,receipt:BackupReceipt):Promise<{state:string;snapshotId?:string;error?:string;lockRelease?:string}>;
 retentionStatus?():{state:string;removed?:number;error?:string;lockRelease?:string;previewId?:string};
 previewRetention?(policy:unknown,input:{installationRef:string;protectedJobId:string}):Promise<{previewId:string;repositoryId:string;remove:string[];keep:number;lockRelease?:string}>;
 applyRetention?(policy:unknown,input:{installationRef:string;protectedJobId:string},previewId:string):Promise<{state:string;previewId:string;removed:number;error?:string;lockRelease?:string}>;
 clearRetentionReview?(previewId:string):unknown;
}
export interface BackupRemoteHostOptions {
 supported:()=>boolean;
 readProtected:()=>Promise<Document>;
 /** Must serialize derivation and durable OS-encrypted persistence. */
 updateProtected:(derive:(current:Document)=>Document)=>Promise<unknown>;
 selectPassword:()=>Promise<{passwordRef:string}|null>;
 createAdapter:(binding:Readonly<{target:ResticS3Target;credentials:ResticS3Credentials;passwordRef:string;maintenanceCredentials?:ResticS3Credentials}|{target:ResticSftpTarget;credentials:ResticSftpCredentials;passwordRef:string}>)=>RemoteAdapter;
 /** Removes the destination's private work folder (journals, pinned-identity
  * checks, leftover run folders). Called after its binding is gone. */
 forgetLocalState?:(remoteRef:string)=>Promise<void>|void;
 createSshKey?:()=>ResticSftpCredentials;
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
 kind?:"s3"|"sftp";
 /** Public details only. The private key never leaves main. */
 sftp?:{host:string;port:number;user:string;folder:string;publicKey:string;fingerprint?:string};
 /** The last SFTP run was refused: the pinned identity changed, or the key was not accepted. */
 serverCheck?:"host-key-changed"|"key-refused";
 lastUpload?:{state:"not-uploaded"|"needs-review"|"verified";jobId:string;lockRelease?:"unconfirmed"};
 automaticUpload?:{enabled:boolean;state:"disabled"|"enabled"|"needs-review"};
 maintenanceSelected?:boolean;
 retention?:{state:"forgetting"|"pruning"|"complete"|"needs-review";removed?:number;previewId?:string;error?:"repository-locked"|"forget-failed"|"prune-failed"|"operation-failed";lockRelease?:"unconfirmed"};
}
function readBinding(document:Document):Binding|null{
 const raw=document[BACKUP_REMOTE_BINDING_KEY];if(raw===undefined)return null;
 try{if(typeof raw!=="string"||Buffer.byteLength(raw)>32768)throw Error();return bindingSchema.parse(JSON.parse(raw));}catch{return refuse();}
}
const safeErrors=new Set(["BACKUP_REMOTE_UNAVAILABLE","BACKUP_REMOTE_CHANGED","BACKUP_REMOTE_PASSWORD_REQUIRED","BACKUP_REMOTE_JOB_CHANGED","BACKUP_REMOTE_BUSY","BACKUP_REMOTE_INPUT_INVALID","BACKUP_REMOTE_REVIEW_REQUIRED","BACKUP_REMOTE_MAINTENANCE_REQUIRED","BACKUP_REMOTE_RETENTION_CHANGED",
 "BACKUP_REMOTE_HOST_KEY_CHANGED","BACKUP_REMOTE_KEY_REFUSED","BACKUP_REMOTE_SERVER_UNREACHABLE","BACKUP_REMOTE_SFTP_UNAVAILABLE","BACKUP_REMOTE_FOLDER_NOT_WRITABLE","BACKUP_REMOTE_FOLDER_NOT_EMPTY","BACKUP_REMOTE_FOLDER_INVALID","BACKUP_REMOTE_WRONG_PASSWORD","BACKUP_REMOTE_SSH_MISSING","BACKUP_REMOTE_SSH_MISSING_WINDOWS","BACKUP_REMOTE_REPOSITORY_CHANGED","BACKUP_REMOTE_TRUST_CHANGED"]);
/** Adapter codes a person can act on, renamed for the window. Everything else stays "needs review". */
const connectionErrors:Record<string,string>={RESTIC_SFTP_HOST_KEY_CHANGED:"BACKUP_REMOTE_HOST_KEY_CHANGED",RESTIC_SFTP_KEY_REFUSED:"BACKUP_REMOTE_KEY_REFUSED",RESTIC_SFTP_UNREACHABLE:"BACKUP_REMOTE_SERVER_UNREACHABLE",RESTIC_SFTP_UNAVAILABLE:"BACKUP_REMOTE_SFTP_UNAVAILABLE",
 RESTIC_SFTP_FOLDER_NOT_WRITABLE:"BACKUP_REMOTE_FOLDER_NOT_WRITABLE",RESTIC_SFTP_FOLDER_NOT_EMPTY:"BACKUP_REMOTE_FOLDER_NOT_EMPTY",RESTIC_SFTP_FOLDER_INVALID:"BACKUP_REMOTE_FOLDER_INVALID",RESTIC_WRONG_PASSWORD:"BACKUP_REMOTE_WRONG_PASSWORD",
 RESTIC_SFTP_SSH_MISSING:"BACKUP_REMOTE_SSH_MISSING",RESTIC_SFTP_SSH_MISSING_WINDOWS:"BACKUP_REMOTE_SSH_MISSING_WINDOWS",RESTIC_REPOSITORY_CHANGED:"BACKUP_REMOTE_REPOSITORY_CHANGED"};
const translate=(error:unknown):never=>{const code=error instanceof Error?connectionErrors[error.message]:undefined;if(code)throw Error(code);throw error;};
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
  if(binding.target.kind==="sftp")return options.createAdapter({target:binding.target,credentials:binding.credentials as ResticSftpCredentials,passwordRef:binding.passwordRef});
  const s3=binding as z.infer<typeof s3BindingSchema>;
  return options.createAdapter({target:s3.target,credentials:s3.credentials,passwordRef:s3.passwordRef!,...(s3.maintenanceCredentials?{maintenanceCredentials:s3.maintenanceCredentials}:{})});
 }
 const publicDetails=(binding:Binding)=>binding.target.kind==="sftp"?{kind:"sftp" as const,sftp:{host:binding.target.host,port:binding.target.port,user:binding.target.user,folder:binding.target.folder,publicKey:(binding.credentials as ResticSftpCredentials).publicKey,...(binding.target.hostKey?{fingerprint:sshFingerprint(binding.target.hostKey.key)}:{})}}:{kind:"s3" as const};
 async function status():Promise<BackupRemoteStatus>{
  const supported=options.supported();if(!supported)return{supported:false,pending,configured:false,state:"unavailable"};
  try{
   const binding=readBinding(await options.readProtected());if(!binding)return{supported:true,pending,configured:false,revision:0,state:"unconfigured"};
   const automaticUpload:NonNullable<BackupRemoteStatus["automaticUpload"]>=!binding.automatic?{enabled:false,state:"disabled"}:{enabled:true,state:binding.automatic.paused||binding.automatic.revision!==binding.target.revision?"needs-review":"enabled"};
   const common={supported:true,pending,configured:true,label:binding.label,remoteRef:binding.target.remoteRef,revision:binding.target.revision,passwordSelected:!!binding.passwordRef,maintenanceSelected:"maintenanceCredentials" in binding&&!!binding.maintenanceCredentials,automaticUpload,...publicDetails(binding)};
   if(!binding.passwordRef)return{...common,state:"password-required"};
   const storage=adapter(binding),saved=storage.connectionStatus();
   if(!["disconnected","initializing","needs-review","connected"].includes(saved.state))refuse();
   if(saved.state==="connected"&&!hash.safeParse(saved.repositoryId).success)refuse();
   let lastUpload:BackupRemoteStatus["lastUpload"];
   const receipt=options.latestReceipt?.();
   if(!pending&&saved.state==="connected"&&receipt&&storage.storedBackupStatus){
    const checked=backupReceiptSchema.parse(receipt);try{const result=storage.storedBackupStatus(checked);if(result.jobId!==checked.jobId||!["not-uploaded","needs-review","verified"].includes(result.state))refuse();lastUpload={state:result.state,jobId:result.jobId,...(result.lockRelease==="unconfirmed"?{lockRelease:"unconfirmed" as const}:{})};}catch{lastUpload={state:"needs-review",jobId:checked.jobId};}
   }
   let retention:BackupRemoteStatus["retention"];
   if(storage.retentionStatus){
    try{
     const value=storage.retentionStatus(),state=(["forgetting","pruning","complete","needs-review"] as const).find(item=>item===value.state),error=(["repository-locked","forget-failed","prune-failed","operation-failed"] as const).find(item=>item===value.error);
     if(state)retention={state,...(Number.isSafeInteger(value.removed)?{removed:value.removed}:{}),...(hash.safeParse(value.previewId).success?{previewId:value.previewId}:{}),...(error?{error}:{}),...(value.lockRelease==="unconfirmed"?{lockRelease:"unconfirmed" as const}:{})};
    }catch{retention={state:"needs-review"};}
   }
   const serverCheck=(["host-key-changed","key-refused"] as const).find(item=>item===saved.serverCheck);
   return{...common,state:saved.state,...(saved.state==="connected"?{repositoryId:saved.repositoryId}:{}),...(lastUpload?{lastUpload}:{}),...(retention?{retention}:{}),...(serverCheck?{serverCheck}:{})};
  }catch{return{supported:true,pending,configured:false,state:"needs-review"};}
 }
 async function save(expectedRevision:unknown,input:unknown){return exclusive(async()=>{
  const sftp=input!==null&&typeof input==="object"&&(input as {kind?:unknown}).kind==="sftp";
  if(sftp){
   const parsed=sftpInputSchema.safeParse(input);if(!parsed.success)refuse("BACKUP_REMOTE_INPUT_INVALID");
   // A new key only for a new SFTP destination: changing the folder or name of
   // one keeps the key already added to the server. The pinned identity is
   // never carried over, so a changed server is always shown and asked again.
   let fresh:ResticSftpCredentials|undefined;
   await options.updateProtected(current=>{
    const prior=readBinding(current);check(prior,expectedRevision);
    const {label,kind:_kind,...target}=parsed.data;
    const credentials=prior?.target.kind==="sftp"?prior.credentials as ResticSftpCredentials:(fresh??=resticSftpCredentialsSchema.parse((options.createSshKey??createSshKeyPair)()));
    const next=bindingSchema.parse({version:1,label,credentials,target:{...target,kind:"sftp",remoteRef:prior?.target.remoteRef??id(),credentialRef:id(),revision:(prior?.target.revision??0)+1},...(prior?.passwordRef?{passwordRef:prior.passwordRef}:{})});
    return{...current,[BACKUP_REMOTE_BINDING_KEY]:JSON.stringify(next)};
   });
   return{saved:true};
  }
  const parsed=inputSchema.safeParse(input&&typeof input==="object"&&(input as {kind?:unknown}).kind==="s3"?(({kind:_kind,...rest})=>rest)(input as Record<string,unknown>):input);if(!parsed.success)refuse("BACKUP_REMOTE_INPUT_INVALID");
  await options.updateProtected(current=>{
   const prior=readBinding(current);check(prior,expectedRevision);
   const {label,credentials,...target}=parsed.data;
   const next=bindingSchema.parse({version:1,label,credentials,target:{...target,kind:"s3",remoteRef:prior?.target.remoteRef??id(),credentialRef:id(),revision:(prior?.target.revision??0)+1},...(prior?.passwordRef?{passwordRef:prior.passwordRef}:{})});
   return{...current,[BACKUP_REMOTE_BINDING_KEY]:JSON.stringify(next)};
  });
  return{saved:true};
 });}
 /** "Test connection". SFTP without a pinned server identity returns its
  * fingerprint for the owner to confirm and connects nowhere else. Otherwise
  * opens the repository, or creates it when the destination has none. */
 async function testConnection(remoteRef:unknown,expectedRevision:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();
  const storage=adapter(binding);
  try{
   if(binding.target.kind==="sftp"&&!binding.target.hostKey){
    if(!storage.scanServerIdentity)refuse();
    const scanned=await storage.scanServerIdentity(),key=checkedHostKey({type:scanned.type,key:scanned.key}),fingerprint=sshFingerprint(key.key);
    if(scanned.fingerprint!==fingerprint)refuse();
    return{state:"trust-required" as const,fingerprint,keyType:key.type};
   }
   if(!storage.prepareRepository)refuse();
   const result=await storage.prepareRepository();
   if(result.connected!==true||result.remoteRef!==binding.target.remoteRef||result.revision!==binding.target.revision||!hash.safeParse(result.repositoryId).success)refuse();
   return{state:"connected" as const,created:result.created===true,remoteRef:result.remoteRef,revision:result.revision,repositoryId:result.repositoryId};
  }catch(error){return translate(error);}
 });}
 /** Pins the identity the owner was shown. The server is read again and must
  * still present that exact key; anything else pins nothing. */
 async function trustServer(remoteRef:unknown,expectedRevision:unknown,fingerprint:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  if(typeof fingerprint!=="string"||!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint))refuse("BACKUP_REMOTE_INPUT_INVALID");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding||binding.target.kind!=="sftp")refuse("BACKUP_REMOTE_INPUT_INVALID");
  if(binding.target.hostKey)refuse("BACKUP_REMOTE_CHANGED");
  const storage=adapter(binding);if(!storage.scanServerIdentity)refuse();
  let scanned:{type:string;key:string};try{scanned=await storage.scanServerIdentity();}catch(error){return translate(error);}
  const key=checkedHostKey({type:scanned.type,key:scanned.key});if(sshFingerprint(key.key)!==fingerprint)refuse("BACKUP_REMOTE_TRUST_CHANGED");
  await options.updateProtected(current=>{
   const next=readBinding(current);check(next,expectedRevision,remoteRef);if(!next||next.target.kind!=="sftp"||next.target.hostKey)refuse("BACKUP_REMOTE_CHANGED");
   const {automatic:_automatic,...rest}=next;
   return{...current,[BACKUP_REMOTE_BINDING_KEY]:JSON.stringify(bindingSchema.parse({...rest,target:{...next.target,hostKey:key,revision:next.target.revision+1}}))};
  });
  return{trusted:true,fingerprint};
 });}
 /** Forgets the destination: its settings, access keys or SSH key, and the
  * pinned server identity. Copies already stored there are not touched. */
 async function remove(remoteRef:unknown,expectedRevision:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();
  await options.updateProtected(current=>{
   const next=readBinding(current);check(next,expectedRevision,remoteRef);if(!next)refuse();
   const {[BACKUP_REMOTE_BINDING_KEY]:_removed,...rest}=current;return rest;
  });
  try{await options.forgetLocalState?.(binding.target.remoteRef);}catch{/* the settings are already gone; leftovers hold no key */}
  return{removed:true};
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
  let result:Awaited<ReturnType<RemoteAdapter["connect"]>>;try{result=await adapter(binding).connect();}catch(error){return translate(error);}
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
  let result:Awaited<ReturnType<RemoteAdapter["store"]>>;try{result=await adapter(binding).store(selected.archivePath,receipt.data);}catch(error){return translate(error);}
  if(!["verified","needs-review"].includes(result.state))refuse();
  if(result.state==="verified"&&!hash.safeParse(result.snapshotId).success)refuse();
  return{state:result.state,jobId:receipt.data.jobId,remoteRef:binding.target.remoteRef,revision:binding.target.revision,...(hash.safeParse(result.snapshotId).success?{snapshotId:result.snapshotId}:{}),...(result.lockRelease==="unconfirmed"?{lockRelease:"unconfirmed" as const}:{})};
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
  return{state:result.state,jobId:checked.data.jobId,...(result.lockRelease==="unconfirmed"?{lockRelease:"unconfirmed" as const}:{})};
 });}
 async function reconcileLatest(remoteRef:unknown,expectedRevision:unknown,jobId:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();
  const receipt=backupReceiptSchema.safeParse(options.latestReceipt?.());if(!receipt.success||receipt.data.jobId!==jobId)refuse("BACKUP_REMOTE_JOB_CHANGED");
  const storage=adapter(binding);if(!storage.reconcile)refuse();let result:Awaited<ReturnType<NonNullable<RemoteAdapter["reconcile"]>>>;try{result=await storage.reconcile(receipt.data);}catch(error){return translate(error);}
  if(result.jobId!==jobId||!["needs-review","verified"].includes(result.state)||(result.state==="verified"&&!hash.safeParse(result.snapshotId).success))refuse();
  return{state:result.state,jobId:receipt.data.jobId,...(result.state==="verified"?{snapshotId:result.snapshotId}:{})};
 });}
 async function listBackups(remoteRef:unknown,expectedRevision:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();const storage=adapter(binding);if(!storage.listBackups)refuse();
  let result:Awaited<ReturnType<NonNullable<RemoteAdapter["listBackups"]>>>;try{result=await storage.listBackups();}catch(error){return translate(error);}
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
 async function saveMaintenanceCredentials(remoteRef:unknown,expectedRevision:unknown,credentials:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  const parsed=resticS3CredentialsSchema.safeParse(credentials);if(!parsed.success)refuse("BACKUP_REMOTE_INPUT_INVALID");
  await options.updateProtected(current=>{
   const binding=readBinding(current);check(binding,expectedRevision,remoteRef);if(!binding)refuse();
   if(binding.target.kind!=="s3")refuse("BACKUP_REMOTE_INPUT_INVALID");
   // Maintenance authority must be a different access key from the routine writer.
   if(parsed.data.accessKeyId===(binding.credentials as ResticS3Credentials).accessKeyId)refuse("BACKUP_REMOTE_INPUT_INVALID");
   return{...current,[BACKUP_REMOTE_BINDING_KEY]:JSON.stringify({...binding,maintenanceCredentials:parsed.data})};
  });
  return{saved:true};
 });}
 async function retentionContext(remoteRef:unknown,expectedRevision:unknown){
  if(!reference.safeParse(remoteRef).success)refuse("BACKUP_REMOTE_CHANGED");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();
  if(binding.target.kind==="s3"&&!("maintenanceCredentials" in binding&&binding.maintenanceCredentials))refuse("BACKUP_REMOTE_MAINTENANCE_REQUIRED");
  if(binding.automatic?.paused)refuse();
  const receipt=backupReceiptSchema.safeParse(options.latestReceipt?.());if(!receipt.success)refuse("BACKUP_REMOTE_JOB_CHANGED");
  return{storage:adapter(binding),input:{installationRef:receipt.data.installationRef,protectedJobId:receipt.data.jobId}};
 }
 async function previewRetention(remoteRef:unknown,expectedRevision:unknown,policy:unknown){return exclusive(async()=>{
  const {storage,input}=await retentionContext(remoteRef,expectedRevision);if(!storage.previewRetention)refuse("BACKUP_REMOTE_UNAVAILABLE");
  const result=await storage.previewRetention(policy,input);
  const checked=z.object({previewId:hash,repositoryId:hash,remove:z.array(hash).max(1000),keep:z.number().int().nonnegative()}).parse(result);
  return{previewId:checked.previewId,remove:checked.remove,keep:checked.keep,...(result.lockRelease==="unconfirmed"?{lockRelease:"unconfirmed" as const}:{})};
 });}
 async function applyRetention(remoteRef:unknown,expectedRevision:unknown,policy:unknown,previewId:unknown){return exclusive(async()=>{
  if(!hash.safeParse(previewId).success)refuse("BACKUP_REMOTE_RETENTION_CHANGED");
  const {storage,input}=await retentionContext(remoteRef,expectedRevision);if(!storage.applyRetention)refuse("BACKUP_REMOTE_UNAVAILABLE");
  let result:Awaited<ReturnType<NonNullable<RemoteAdapter["applyRetention"]>>>;
  try{result=await storage.applyRetention(policy,input,previewId as string);}
  catch(error){if(error instanceof Error&&error.message==="RESTIC_RETENTION_PREVIEW_CHANGED")refuse("BACKUP_REMOTE_RETENTION_CHANGED");throw error;}
  if(!["nothing-to-remove","complete","needs-review"].includes(result.state)||result.previewId!==previewId||!Number.isSafeInteger(result.removed))refuse();
  const error=(["repository-locked","forget-failed","prune-failed","operation-failed"] as const).find(item=>item===result.error);
  return{state:result.state,previewId:result.previewId,removed:result.removed,...(error?{error}:{}),...(result.lockRelease==="unconfirmed"?{lockRelease:"unconfirmed" as const}:{})};
 });}
 async function clearRetentionReview(remoteRef:unknown,expectedRevision:unknown,previewId:unknown){return exclusive(async()=>{
  if(!reference.safeParse(remoteRef).success||!hash.safeParse(previewId).success)refuse("BACKUP_REMOTE_CHANGED");
  const binding=readBinding(await options.readProtected());check(binding,expectedRevision,remoteRef);if(!binding)refuse();
  const storage=adapter(binding);if(!storage.clearRetentionReview)refuse();
  storage.clearRetentionReview(previewId as string);return{cleared:true};
 });}
 return{status,save,testConnection,trustServer,remove,selectRepositoryPassword,saveMaintenanceCredentials,connect,uploadLatest,setAutomaticUpload,runAutomaticUpload,reconcileLatest,listBackups,downloadBackup,previewRetention,applyRetention,clearRetentionReview,isPending:()=>pending};
}
