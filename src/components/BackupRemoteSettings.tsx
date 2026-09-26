import {useEffect,useRef,useState} from "react";
import {resticS3TargetSchema,resticS3CredentialsSchema,sftpFolderSchema,sftpHostSchema,sftpPortSchema,sftpUserSchema} from "../../server/backup-restic-target";
import type {BackupRemoteStatus} from "../../server/backup-remote-host";
type RetentionPolicy={keepLast?:number;keepDaily?:number;keepWeekly?:number;keepMonthly?:number};
// Retention methods are optional: an older desktop bridge simply does not offer removal.
type RemoteBridge=NonNullable<NonNullable<Window["muragebox"]>["backupRemote"]>&{
 saveMaintenanceCredentials?(remoteRef:string,revision:number,credentials:{accessKeyId:string;secretAccessKey:string}):Promise<{saved:boolean}>;
 previewRetention?(remoteRef:string,revision:number,policy:RetentionPolicy):Promise<unknown>;
 applyRetention?(remoteRef:string,revision:number,policy:RetentionPolicy,previewId:string):Promise<{state:string;previewId:string;removed:number}>;
 clearRetentionReview?(remoteRef:string,revision:number,previewId:string):Promise<unknown>;
};
export interface RemoteDraft {label:string;endpoint:string;bucket:string;prefix:string;region:string;accessKeyId:string;secretAccessKey:string;sessionToken:string;bucketLookup:"auto"|"path"|"dns"}
const empty:RemoteDraft={label:"Off-site copy",endpoint:"",bucket:"",prefix:"murage",region:"",accessKeyId:"",secretAccessKey:"",sessionToken:"",bucketLookup:"auto"};
export function remoteBackupInput(draft:RemoteDraft){
 const target=resticS3TargetSchema.safeParse({kind:"s3",remoteRef:"draft",credentialRef:"draft",revision:0,endpoint:draft.endpoint.trim(),bucket:draft.bucket.trim(),prefix:draft.prefix.trim(),region:draft.region.trim(),bucketLookup:draft.bucketLookup});
 const credentials=resticS3CredentialsSchema.safeParse({accessKeyId:draft.accessKeyId,secretAccessKey:draft.secretAccessKey,...(draft.sessionToken?{sessionToken:draft.sessionToken}:{})});
 const label=draft.label.trim();if(!target.success||!credentials.success||!label||label.length>80||/[\x00-\x1f\x7f]/.test(label))return null;
 return{label,endpoint:target.data.endpoint,bucket:target.data.bucket,prefix:target.data.prefix,region:target.data.region,bucketLookup:target.data.bucketLookup,credentials:credentials.data};
}
/** SFTP destination fields. There is no secret here: Murage makes the key in main. */
export interface SftpDraft {label:string;host:string;port:string;user:string;folder:string}
const emptySftp:SftpDraft={label:"Off-site copy",host:"",port:"22",user:"",folder:"murage-backups"};
export function remoteSftpInput(draft:SftpDraft){
 const label=draft.label.trim(),rawHost=draft.host.trim(),host=/^\[[0-9A-Fa-f:.]+\]$/.test(rawHost)?rawHost.slice(1,-1):rawHost;
 const folder=draft.folder.trim().replace(/(.)\/+$/,"$1"),portText=draft.port.trim();
 if(!/^[0-9]{1,5}$/.test(portText)||!label||label.length>80||/[\x00-\x1f\x7f]/.test(label))return null;
 const port=sftpPortSchema.safeParse(Number(portText)),parsedHost=sftpHostSchema.safeParse(host),user=sftpUserSchema.safeParse(draft.user.trim()),parsedFolder=sftpFolderSchema.safeParse(folder);
 if(!port.success||!parsedHost.success||!user.success||!parsedFolder.success)return null;
 return{kind:"sftp" as const,label,host:parsedHost.data,port:port.data,user:user.data,folder:parsedFolder.data};
}
export type DestinationKind="s3"|"sftp";
/** Shown while Murage checks its backup tool after starting, most visibly on
 * the first launch after an install or update. */
export const REMOTE_CHECKING="Getting ready. Murage checks its backup tool after it starts.";
const labels:Record<string,string>={unconfigured:"No off-site destination saved","password-required":"Choose the off-site password file",disconnected:"Destination saved, not connected",connected:"Off-site storage connected",blocked:"Off-site copies are off",initializing:"Off-site setup needs review","needs-review":"Off-site copy needs review",unavailable:"Off-site copies are unavailable in this app"};
export interface RetentionDraft {keepLast:string;keepDaily:string;keepWeekly:string;keepMonthly:string}
const retentionFields=[["keepLast","Keep latest copies"],["keepDaily","Keep daily copies"],["keepWeekly","Keep weekly copies"],["keepMonthly","Keep monthly copies"]] as const;
const retentionIssues:Record<string,string>={"repository-locked":"the repository stayed locked","forget-failed":"the provider did not confirm removal","prune-failed":"unused storage was not fully reclaimed","operation-failed":"the result could not be confirmed"};
/** Explicit whole-number counts only; an empty form is not a policy. */
export function remoteRetentionPolicy(draft:RetentionDraft):RetentionPolicy|null{
 const policy:RetentionPolicy={};
 for(const [key] of retentionFields){const raw=draft[key].trim();if(!raw)continue;if(!/^[1-9][0-9]{0,3}$/.test(raw)||Number(raw)>1000)return null;policy[key]=Number(raw);}
 return Object.keys(policy).length?policy:null;
}
export function remoteRetentionPreview(value:unknown){
 if(!value||typeof value!=="object")throw Error("Invalid preview");const v=value as Record<string,unknown>;
 if(typeof v.previewId!=="string"||!/^[a-f0-9]{64}$/.test(v.previewId)||!Array.isArray(v.remove)||v.remove.length>1000||v.remove.some(id=>typeof id!=="string"||!/^[a-f0-9]{64}$/.test(id))||!Number.isSafeInteger(v.keep)||Number(v.keep)<1)throw Error("Invalid preview");
 return{previewId:v.previewId,remove:v.remove as string[],keep:Number(v.keep),lockRelease:v.lockRelease==="unconfirmed"};
}
export function remoteBackupCatalogue(value:unknown){
 if(!value||typeof value!=="object")throw Error("Invalid catalogue");const v=value as Record<string,unknown>;
 if(!Array.isArray(v.backups)||v.backups.length>1000||!Number.isSafeInteger(v.ignored)||Number(v.ignored)<0)throw Error("Invalid catalogue");
 const seen=new Set<string>();const backups=v.backups.map((row:unknown)=>{if(!row||typeof row!=="object")throw Error("Invalid backup");const item=row as Record<string,unknown>;if(typeof item.snapshotId!=="string"||!/^[a-f0-9]{64}$/.test(item.snapshotId)||seen.has(item.snapshotId)||!Number.isSafeInteger(item.createdAt)||Number(item.createdAt)<0||Number(item.createdAt)>8640000000000000||item.verified!==false)throw Error("Invalid backup");seen.add(item.snapshotId);return{snapshotId:item.snapshotId,createdAt:Number(item.createdAt)};});
 return{backups,ignored:Number(v.ignored)};
}
export function remoteBackupStatus(value:unknown):BackupRemoteStatus{
 if(!value||typeof value!=="object")throw Error("Invalid status");const v=value as Record<string,unknown>;
 if(typeof v.supported!=="boolean"||typeof v.pending!=="boolean"||typeof v.configured!=="boolean"||typeof v.state!=="string"||!Object.hasOwn(labels,v.state))throw Error("Invalid status");
 if(v.configured&&(!Number.isSafeInteger(v.revision)||Number(v.revision)<1||typeof v.remoteRef!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(v.remoteRef)))throw Error("Invalid binding");
 const result:BackupRemoteStatus={supported:v.supported,pending:v.pending,configured:v.configured,state:v.state};
 if(v.supported===false&&v.checking===true)result.checking=true;
 if(Number.isSafeInteger(v.revision)&&Number(v.revision)>=0)result.revision=Number(v.revision);
  if(v.configured){result.remoteRef=String(v.remoteRef);if(typeof v.label==="string"&&v.label.length<=80)result.label=v.label;result.passwordSelected=v.passwordSelected===true;result.maintenanceSelected=v.maintenanceSelected===true;
  result.kind=v.kind==="sftp"?"sftp":"s3";
  if(result.kind==="sftp"){
   const d=v.sftp as Record<string,unknown>|undefined;
   if(!d||typeof d.host!=="string"||!sftpHostSchema.safeParse(d.host).success||!Number.isSafeInteger(d.port)||!sftpPortSchema.safeParse(d.port).success||typeof d.user!=="string"||!sftpUserSchema.safeParse(d.user).success||typeof d.folder!=="string"||!sftpFolderSchema.safeParse(d.folder).success||typeof d.publicKey!=="string"||!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} murage-backup$/.test(d.publicKey)||(d.fingerprint!==undefined&&(typeof d.fingerprint!=="string"||!/^SHA256:[A-Za-z0-9+/]{43}$/.test(d.fingerprint))))throw Error("Invalid SFTP destination");
   result.sftp={host:d.host,port:Number(d.port),user:d.user,folder:d.folder,publicKey:d.publicKey,...(typeof d.fingerprint==="string"?{fingerprint:d.fingerprint}:{})};
  }
  if(v.serverCheck==="host-key-changed"||v.serverCheck==="key-refused")result.serverCheck=v.serverCheck;
 }
 const blocked=v.blocked as Record<string,unknown>|undefined;
 if(blocked!==undefined){if(!blocked||blocked.reason!=="data-folder-shared"||typeof blocked.folder!=="string"||!blocked.folder.startsWith("/")||blocked.folder.length>4096||/[\x00-\x1f]/.test(blocked.folder))throw Error("Invalid blocked status");result.blocked={reason:"data-folder-shared",folder:blocked.folder};}
 const upload=v.lastUpload as Record<string,unknown>|undefined;
 if(upload){if(!["not-uploaded","needs-review","verified"].includes(String(upload.state))||typeof upload.jobId!=="string"||!/^[a-f0-9]{64}$/.test(upload.jobId))throw Error("Invalid upload status");result.lastUpload={state:upload.state as "not-uploaded"|"needs-review"|"verified",jobId:upload.jobId,...(upload.lockRelease==="unconfirmed"?{lockRelease:"unconfirmed" as const}:{})};}
 const automatic=v.automaticUpload as Record<string,unknown>|undefined;
 if(automatic!==undefined){if(!automatic||typeof automatic.enabled!=="boolean"||!(automatic.enabled?["enabled","needs-review"]:["disabled"]).includes(String(automatic.state)))throw Error("Invalid automatic upload policy");result.automaticUpload={enabled:automatic.enabled,state:automatic.state as "disabled"|"enabled"|"needs-review"};}
 const retention=v.retention as Record<string,unknown>|null|undefined;
 if(retention!==undefined){
  if(!retention||!["forgetting","pruning","complete","needs-review"].includes(String(retention.state))||(retention.removed!==undefined&&(!Number.isSafeInteger(retention.removed)||Number(retention.removed)<0))||(retention.error!==undefined&&!Object.hasOwn(retentionIssues,String(retention.error)))||(retention.previewId!==undefined&&(typeof retention.previewId!=="string"||!/^[a-f0-9]{64}$/.test(retention.previewId))))throw Error("Invalid retention status");
  result.retention={state:retention.state as "forgetting"|"pruning"|"complete"|"needs-review",...(retention.removed!==undefined?{removed:Number(retention.removed)}:{}),...(retention.error!==undefined?{error:retention.error as "repository-locked"|"forget-failed"|"prune-failed"|"operation-failed"}:{}),...(typeof retention.previewId==="string"?{previewId:retention.previewId}:{}),...(retention.lockRelease==="unconfirmed"?{lockRelease:"unconfirmed" as const}:{})};
 }
 return result;
}
const DATA_FOLDER_SHARED_TEXT="Other accounts on this computer can change the folder that holds Murage's data folder, so Murage does not keep off-site keys there. Remove their write access to that folder, then refresh.";
export function remoteBackupError(cause:unknown){
 const code=cause instanceof Error?cause.message:"";
 if(code.includes("DOWNLOAD_FOLDER_SHARED"))return "Other accounts on this computer can change the folder you chose, so Murage didn't save the backup there. Download again and choose your home folder, or a folder only you can change.";
 if(code.includes("DATA_FOLDER_SHARED"))return DATA_FOLDER_SHARED_TEXT;
 if(code.includes("HOST_KEY_CHANGED"))return "The server's identity is not the one you trusted, so Murage did not connect. If the server was not reinstalled or replaced, ask whoever runs it before going further. If it was, choose Change destination and save it again to check the new fingerprint.";
 if(code.includes("TRUST_CHANGED"))return "The server showed a different fingerprint when Murage checked again, so nothing was trusted. Test the connection again and compare the new fingerprint.";
 if(code.includes("KEY_REFUSED"))return "The server did not accept Murage's key. Add the key shown above to the server's authorized keys for this user name, then test the connection again.";
 if(code.includes("SSH_MISSING_WINDOWS"))return "This computer has no OpenSSH client. Open Settings, then System, then Optional features, add OpenSSH Client, and try again.";
 if(code.includes("SSH_MISSING"))return "This computer has no OpenSSH client (the ssh command). Install it and try again.";
 if(code.includes("SFTP_UNAVAILABLE"))return "The server accepted the key but did not offer SFTP. Switch on SFTP on the server (on a NAS, in its file services settings) and try again.";
 if(code.includes("SERVER_UNREACHABLE"))return "Murage could not reach the SFTP server. Check the server name and port, and that the server is on and reachable from this computer.";
 if(code.includes("FOLDER_NOT_EMPTY"))return "That folder already has other files in it, so Murage did not create a backup repository there. Choose an empty folder or a new folder name.";
 if(code.includes("FOLDER_NOT_WRITABLE"))return "Murage connected but could not write to that folder. Choose a folder this user can write to, such as one inside the user's home folder.";
 if(code.includes("FOLDER_INVALID"))return "That path on the server is a file, not a folder. Choose a folder instead.";
 if(code.includes("WRONG_PASSWORD"))return "The off-site password file does not open the backup repository in this folder. Choose the password file you used when this repository was created.";
 if(code.includes("STORAGE_UNREACHABLE"))return "Murage could not open the backup storage. Check the destination details, that the access keys or SSH key are accepted, and that this computer is online, then test the connection again.";
 if(code.includes("CREATE_FAILED"))return "Murage reached the destination but could not create the backup repository there. Check that the access keys may write to this bucket, or that the user may write to this folder, then test the connection again.";
 if(code.includes("PASSWORD_FILE_UNREADABLE"))return "Murage could not read the off-site password file. It may have been moved, renamed or changed. Put it back, or choose it again.";
 if(code.includes("CONTROL_UNAVAILABLE"))return "Murage couldn't prepare its private off-site folder beside its data folder, so it didn't create or choose a password file. Check that you can create folders in the folder that holds Murage's data, then try again.";
 if(code.includes("PASSWORD_FILE_PLACE"))return "That file is inside Murage's own folders or your backup folder. Keep the off-site password somewhere else, such as Documents, then choose it again.";
 if(code.includes("PASSWORD_FILE_KIND"))return "That isn't a plain password file. Choose a small text file (under 4 KB) that is not a shortcut or link.";
 if(code.includes("PASSWORD_FILE_SHARED"))return "Other accounts on this computer can read that file. Make it readable only by you, then choose it again.";
 if(code.includes("PASSWORD_FILE_FORMAT"))return "That file doesn't hold a single-line password. Choose a file with the password on one line and nothing else.";
 if(code.includes("PASSWORD_NOT_CREATED"))return "Murage could not create the off-site password file. Check that your Documents or home folder can be written to, then try again.";
 if(code.includes("PASSWORD_COPY_FAILED"))return "The copy was not saved. Choose a folder outside Murage's own folders and your backup folder, with no file of that name yet.";
 if(code.includes("TOOL_UNVERIFIED"))return "The backup tool that comes with Murage could not be checked. Reinstall Murage, then try again.";
 if(code.includes("KEYS_UNREADABLE"))return "Murage could not read the saved access details for this destination. Choose Change destination and save it again.";
 if(code.includes("NOT_A_REPOSITORY"))return "The destination holds something that is not a Murage backup repository. Choose an empty folder or prefix.";
 if(code.includes("SETUP_INTERRUPTED"))return "An earlier setup of this destination did not finish. Choose Change destination and save it again, then test the connection.";
 if(code.includes("REPOSITORY_CHANGED"))return "The repository at this destination is not the one Murage connected to before. Nothing was uploaded. Review the destination before continuing.";
 if(code.includes("MAINTENANCE_REQUIRED"))return "Save a separate maintenance access key before previewing removals.";
 if(code.includes("RETENTION_CHANGED"))return "The repository changed since the preview. Nothing was removed. Preview again before removing copies.";
 if(code.includes("BACKUP_REMOTE_CHANGED"))return "The saved destination changed. Refresh status and review it before trying again.";
 if(code.includes("PASSWORD_REQUIRED"))return "Choose your off-site password file first.";
 if(code.includes("JOB_CHANGED"))return "The latest local backup changed. Refresh and review the backup before uploading.";
 if(code.includes("BUSY"))return "A backup operation is already running. Wait for it to finish, then refresh.";
 // Anything not named above. The log (server.log) carries the redacted cause.
 return "Murage couldn't finish this step and didn't change anything. Refresh status, then try again. If it happens again, the reason is in Murage's log.";
}
const inputClass="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50";
const buttonClass="min-h-11 rounded-lg border border-hairline/40 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
/** Where the last action's result is shown: next to the control that ran it. */
export type RemoteArea="offsite"|"cleanup"|"restore";
const areaOf=(action:string):RemoteArea=>["maintenance","preview","retention","clear"].includes(action)?"cleanup":["list","download","restore"].includes(action)?"restore":"offsite";
/** Off-site state and actions. The panels below are views over this; the
 * calls, revision checks, consent resets and credential clearing are the
 * same ones the single off-site panel always made. */
export function useBackupRemote(){
 const bridge=typeof window!=="undefined"?window.muragebox?.backupRemote as RemoteBridge|undefined:undefined;
 const [status,setStatus]=useState<BackupRemoteStatus|null>(null),[latest,setLatest]=useState<{jobId:string;bytes:number;verifiedAt:number}|null>(null);
 const [draft,setDraft]=useState<RemoteDraft>(empty),[editing,setEditing]=useState(false),[uploadConsent,setUploadConsent]=useState(false);
 const [kind,setKind]=useState<DestinationKind>("s3"),[sftpDraft,setSftpDraft]=useState<SftpDraft>(emptySftp);
 const [trust,setTrust]=useState<{ref:string;revision:number;fingerprint:string;keyType:string}|null>(null),[removing,setRemoving]=useState(false),[copied,setCopied]=useState(false);
 const [busy,setBusy]=useState<string|null>(null),[stale,setStale]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[area,setArea]=useState<RemoteArea>("offsite");
 const [catalogue,setCatalogue]=useState<(ReturnType<typeof remoteBackupCatalogue>&{ref:string;revision:number})|null>(null),[selectedBackup,setSelectedBackup]=useState("");
 const [downloaded,setDownloaded]=useState<string|null>(null);
 const [maintenance,setMaintenance]=useState({accessKeyId:"",secretAccessKey:""}),[retentionDraft,setRetentionDraft]=useState<RetentionDraft>({keepLast:"",keepDaily:"",keepWeekly:"",keepMonthly:""});
 const [preview,setPreview]=useState<(ReturnType<typeof remoteRetentionPreview>&{ref:string;revision:number;policy:string})|null>(null),[removalConsent,setRemovalConsent]=useState(false);
 const mounted=useRef(true),gate=useRef(false),version=useRef(0);
 async function refresh(expected:number){
  if(!bridge)return;
  const [remote,schedule]=await Promise.all([bridge.status(),window.muragebox?.backupSchedule?.status().catch(()=>null)]);
  const next=remoteBackupStatus(remote);if(!mounted.current||version.current!==expected)return;
  setStatus(next);setStale(false);const receipt=schedule?.lastVerified;
  setLatest(receipt&&/^[a-f0-9]{64}$/.test(receipt.jobId)&&Number.isSafeInteger(receipt.bytes)&&receipt.bytes>0&&Number.isFinite(receipt.verifiedAt)?{jobId:receipt.jobId,bytes:receipt.bytes,verifiedAt:receipt.verifiedAt}:null);
  setUploadConsent(false);setPreview(null);setRemovalConsent(false);setTrust(null);setRemoving(false);
 }
 async function run(action:string,work:(api:RemoteBridge,expected:number)=>Promise<void>){
  if(gate.current||!bridge)return;gate.current=true;const expected=++version.current;setBusy(action);setError(null);setNotice(null);setArea(areaOf(action));
  try{await work(bridge,expected);}catch(cause){if(mounted.current&&version.current===expected){setError(remoteBackupError(cause));setStale(true);setUploadConsent(false);}}
  finally{gate.current=false;if(mounted.current)setBusy(null);}
 }
 useEffect(()=>{mounted.current=true;void run("refresh",async(_api,expected)=>refresh(expected));return()=>{mounted.current=false;version.current++;};},[]);
 // While the backup tool is still being checked, look again until it is ready.
 useEffect(()=>{
  if(!status||status.supported||!status.checking||!bridge)return;
  const timer=window.setInterval(()=>{if(!gate.current)void run("refresh",async(_api,expected)=>refresh(expected));},2000);
  return()=>window.clearInterval(timer);
 },[status?.supported,status?.checking,bridge]);
 const locked=!bridge||!status?.supported||status.pending||!!busy||stale;
 const payload=remoteBackupInput(draft),configured=status?.configured===true;
 const binding=typeof status?.remoteRef==="string"&&Number.isSafeInteger(status.revision)?{ref:status.remoteRef,revision:status.revision!}:null;
 const available=catalogue&&binding&&catalogue.ref===binding.ref&&catalogue.revision===binding.revision?catalogue:null;
 const retentionPolicy=remoteRetentionPolicy(retentionDraft);
 const currentPreview=preview&&binding&&retentionPolicy&&preview.ref===binding.ref&&preview.revision===binding.revision&&preview.policy===JSON.stringify(retentionPolicy)?preview:null;
 const change=(key:keyof RemoteDraft,value:string)=>{setDraft(current=>({...current,[key]:value}));setUploadConsent(false);};
 const changeSftp=(key:keyof SftpDraft,value:string)=>{setSftpDraft(current=>({...current,[key]:value}));setUploadConsent(false);};
 const sftpPayload=remoteSftpInput(sftpDraft);
 const refreshNow=()=>void run("refresh",async(_api,expected)=>refresh(expected));
 return{kind,setKind,sftpDraft,setSftpDraft,changeSftp,sftpPayload,trust,setTrust,removing,setRemoving,copied,setCopied,bridge,status,latest,draft,setDraft,editing,setEditing,uploadConsent,setUploadConsent,busy,stale,error,notice,area,setNotice,setDownloaded,catalogue,setCatalogue,selectedBackup,setSelectedBackup,downloaded,maintenance,setMaintenance,retentionDraft,setRetentionDraft,setPreview,removalConsent,setRemovalConsent,mounted,version,refresh,run,locked,payload,configured,binding,available,retentionPolicy,currentPreview,change,refreshNow};
}
export type RemoteController=ReturnType<typeof useBackupRemote>;

/** The last action's result, shown in the panel that ran it. */
export function RemoteMessages({r,area}:{r:RemoteController;area:RemoteArea}){
 if(r.area!==area)return null;
 return <>{r.error&&<p role="alert" className="text-[13px] text-danger">{r.error}</p>}{r.notice&&<p role="status" className="text-[13px] text-ink-secondary">{r.notice}</p>}</>;
}
/** Always visible above the collapsible off-site details: status, pending and
 * stale lines, so a locked or failing state is never folded away. */
export function OffsiteStatus({r}:{r:RemoteController}){
 const {status,bridge,stale}=r;
 return <>
  <p role="status" className="text-[13px] font-medium text-ink">{status?(status.checking?REMOTE_CHECKING:labels[status.state]):bridge?"Checking the off-site copy…":"Off-site copies are unavailable in this window"}</p>
  {status?.blocked&&<p role="alert" className="break-words text-[13px] text-warning">{DATA_FOLDER_SHARED_TEXT} Folder: {status.blocked.folder}. On Linux or macOS, for example: chmod go-w "{status.blocked.folder}"</p>}
  {status&&!status.supported&&<p className="text-[13px] text-ink-secondary">Off-site copies need a supported desktop build with its verified backup tool. Backups on this computer are separate.</p>}
  {status?.pending&&<p role="status" className="text-[13px] text-ink-secondary">Off-site work is in progress. Refresh after it finishes.</p>}
  {stale&&<p role="alert" className="text-[13px] text-warning">Status needs a refresh. Connection and upload actions are locked.</p>}
  <RemoteMessages r={r} area="offsite"/>
 </>;
}
/** Public key, setup steps and the trusted fingerprint for an SFTP destination. */
function SftpKeySteps({r}:{r:RemoteController}){
 const {status,copied,setCopied}=r;const sftp=status?.sftp;if(!sftp)return null;
 const copy=()=>{void navigator.clipboard?.writeText(sftp.publicKey).then(()=>{if(r.mounted.current)setCopied(true);},()=>{});};
 return <div className="space-y-2">
  <p className="break-words text-[13px] text-ink-secondary">Server: {sftp.user}@{sftp.host}, port {sftp.port}. Folder: {sftp.folder}</p>
  <h4 className="text-[13px] font-medium text-ink">Murage's key for this server</h4>
  <p className="text-[13px] text-ink-secondary">Murage made this key for this destination only. Add this key to the server's authorized keys for {sftp.user}. Murage never uses a password to sign in.</p>
  <pre aria-label="Public key" className="max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px] text-ink" data-testid="sftp-public-key">{sftp.publicKey}</pre>
  <button className={buttonClass} type="button" onClick={copy}>{copied?"Key copied":"Copy key"}</button>
  <ol className="list-decimal space-y-1 pl-5 text-[13px] text-ink-secondary">
   <li>On the server, add the key above as a new line in the file .ssh/authorized_keys in the home folder of {sftp.user}.</li>
   <li>Below, choose Create off-site password (or, on a new computer, the password file you kept).</li>
   <li>Choose Test connection. The first time, Murage shows the server's fingerprint and asks you to trust it.</li>
  </ol>
  <p className="text-[12px] text-ink-secondary">On a Synology, TrueNAS or similar NAS: switch on SFTP in its file services settings, enable the user home folder, then add the key for {sftp.user}. Some NAS apps have a place to paste an SSH public key for a user.</p>
  {sftp.fingerprint?<p className="break-all text-[13px] text-ink-secondary">Trusted server fingerprint: {sftp.fingerprint}</p>:<p className="text-[13px] text-ink-secondary">Server fingerprint: not trusted yet.</p>}
 </div>;
}
/** Destination, password file, connection, uploads and automatic uploads. */
export function OffsiteDetails({r}:{r:RemoteController}){
 const {bridge,status,latest,draft,editing,setEditing,setDraft,uploadConsent,setUploadConsent,busy,run,refresh,mounted,setNotice,locked,payload,configured,binding,change,kind,setKind,sftpDraft,setSftpDraft,changeSftp,sftpPayload,trust,setTrust,removing,setRemoving}=r;
 const sftp=status?.kind==="sftp";
 const connectDisabled=locked||!binding||!status?.passwordSelected||status.state==="needs-review"||status.state==="initializing";
 const testConnection=()=>void run("connect",async(api,expected)=>{
  if(!binding)return;
  if(!api.testConnection){await api.connect(binding.ref,binding.revision);await refresh(expected);if(mounted.current)setNotice("Existing repository connection confirmed. No backup was uploaded.");return;}
  const result=await api.testConnection(binding.ref,binding.revision);
  if(result.state==="trust-required"){if(mounted.current)setTrust({...binding,fingerprint:result.fingerprint,keyType:result.keyType});return;}
  await refresh(expected);if(mounted.current)setNotice(result.created?"Connected. Murage created the backup repository in this folder. Nothing has been uploaded yet.":"Connected to the existing backup repository. Nothing has been uploaded.");
 });
 const trustServer=()=>void run("trust",async(api,expected)=>{
  if(!trust||!api.trustServer||!api.testConnection)return;
  await api.trustServer(trust.ref,trust.revision,trust.fingerprint);if(mounted.current)setTrust(null);
  const next=remoteBackupStatus(await api.status());if(!next.remoteRef||!Number.isSafeInteger(next.revision))throw Error("BACKUP_REMOTE_CHANGED");
  const result=await api.testConnection(next.remoteRef,next.revision!);await refresh(expected);
  if(mounted.current)setNotice(result.state==="connected"?(result.created?"Server trusted and connected. Murage created the backup repository in this folder. Nothing has been uploaded yet.":"Server trusted and connected to the existing backup repository. Nothing has been uploaded."):"Server trusted. Test the connection again.");
 });
 return <div className="space-y-3">
  <p className="text-[13px] text-ink-secondary">Keep a second encrypted copy away from this computer: in S3-compatible storage (such as Amazon S3, Backblaze B2, Cloudflare R2 or MinIO), or on an SFTP server such as a NAS, a home server or a VPS. Saving settings doesn't connect or upload anything.</p>
  {status?.supported&&<>
   {configured&&<div className="space-y-2"><p className="break-words text-[13px] text-ink-secondary">Saved destination: {status.label??"Off-site copy"} ({sftp?"SFTP server":"S3-compatible storage"})</p><button className={buttonClass} type="button" disabled={locked} onClick={()=>{setEditing(value=>!value);setDraft(empty);setSftpDraft(sftp&&status.sftp?{label:status.label??"Off-site copy",host:status.sftp.host,port:String(status.sftp.port),user:status.sftp.user,folder:status.sftp.folder}:emptySftp);setKind(sftp?"sftp":"s3");setRemoving(false);}}>{editing?"Cancel destination changes":"Change destination"}</button></div>}
   {(!configured||editing)&&<div className="space-y-3">
    <fieldset disabled={locked} className="min-w-0 space-y-2"><legend className="text-[13px] font-medium text-ink">Where to keep the off-site copy</legend>
     {([["s3","S3-compatible storage"],["sftp","SFTP server (NAS, home server or VPS)"]] as const).map(([value,text])=><label key={value} className="flex min-h-11 items-center gap-3 text-[13px] text-ink"><input type="radio" name="offsite-kind" value={value} checked={kind===value} onChange={()=>{setKind(value);setUploadConsent(false);}} className="size-4 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent-border"/><span>{text}</span></label>)}
    </fieldset>
    {kind==="s3"?<form className="space-y-3" onSubmit={event=>{event.preventDefault();if(locked||!payload)return;void run("save",async(api,expected)=>{
     try{await api.save(status.revision??0,payload);}finally{setDraft(current=>({...current,accessKeyId:"",secretAccessKey:"",sessionToken:""}));}
     await refresh(expected);if(mounted.current){setEditing(false);setNotice("Destination saved securely. Nothing has been connected or uploaded.");}
    });}}>
     <p className="text-[13px] text-ink-secondary">Use the endpoint, bucket, region and access keys from your storage provider. The bucket must already exist. Murage creates the backup repository in it when you test the connection.</p>
     <fieldset disabled={locked} className="min-w-0 space-y-3"><legend className="text-[13px] font-medium text-ink">Destination details</legend>
     {([['label','Destination name',80],['endpoint','S3 endpoint (HTTPS)',2048],['bucket','Bucket name',63],['prefix','Repository folder',512],['region','Region',64]]as const).map(([key,label,maxLength])=><label key={key} className="block text-[13px] text-ink-secondary">{label}<input className={inputClass} value={draft[key]} maxLength={maxLength} autoComplete="off" spellCheck={false} onChange={event=>change(key,event.target.value)} required/></label>)}
     <details><summary className="min-h-11 cursor-pointer py-3 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Advanced connection option</summary><label className="block text-[13px] text-ink-secondary">Bucket addressing<select className={inputClass} value={draft.bucketLookup} onChange={event=>change("bucketLookup",event.target.value)}><option value="auto">Automatic</option><option value="path">Path</option><option value="dns">DNS</option></select></label></details>
     {([['accessKeyId','Access key ID'],['secretAccessKey','Secret access key'],['sessionToken','Session token (optional)']]as const).map(([key,label])=><label key={key} className="block text-[13px] text-ink-secondary">{label}<input className={inputClass} type="password" value={draft[key]} maxLength={4096} autoComplete="off" spellCheck={false} onChange={event=>change(key,event.target.value)} required={key!=="sessionToken"}/></label>)}
     <p className="text-[12px] text-ink-secondary">Access keys are saved in the operating system’s encrypted store and cleared from this form after saving. Changing a destination requires entering its complete details and keys.</p>
     </fieldset><button className={buttonClass} type="submit" disabled={locked||!payload}>{busy==="save"?"Saving destination…":"Save off-site destination"}</button>
    </form>:<form className="space-y-3" onSubmit={event=>{event.preventDefault();if(locked||!sftpPayload)return;void run("save",async(api,expected)=>{
     await api.save(status.revision??0,sftpPayload);
     await refresh(expected);if(mounted.current){setEditing(false);setNotice("Destination saved. Murage made an SSH key for it: add the key shown below to the server, then test the connection. Nothing has been connected or uploaded.");}
    });}}>
     <p className="text-[13px] text-ink-secondary">Murage makes its own SSH key for this destination and shows you the public half to add to the server. It never asks for the server password.</p>
     <fieldset disabled={locked} className="min-w-0 space-y-3"><legend className="text-[13px] font-medium text-ink">SFTP server details</legend>
     {([['label','Destination name',80,"Off-site copy"],['host','Server (name or IP address)',253,"nas.example.com"],['port','Port',5,"22"],['user','User name',64,"backup"],['folder','Folder on the server',512,"murage-backups"]]as const).map(([key,label,maxLength,placeholder])=><label key={key} className="block text-[13px] text-ink-secondary">{label}<input className={inputClass} value={sftpDraft[key]} maxLength={maxLength} placeholder={placeholder} inputMode={key==="port"?"numeric":undefined} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={event=>changeSftp(key,event.target.value)} required/></label>)}
     <p className="text-[12px] text-ink-secondary">A folder without a leading slash is inside the user's home folder on the server. Murage creates the folder if it is missing. Use letters, numbers, dots, dashes and underscores; spaces are not accepted.</p>
     </fieldset><button className={buttonClass} type="submit" disabled={locked||!sftpPayload}>{busy==="save"?"Saving destination…":"Save off-site destination"}</button>
    </form>}
   </div>}
   {configured&&!editing&&<div className="space-y-3">
    {sftp&&<SftpKeySteps r={r}/>}
    {status.serverCheck==="host-key-changed"&&<p role="alert" className="text-[13px] text-warning">The server's identity changed since you trusted it. Murage refuses to connect until you check it. If the server was not reinstalled or replaced, ask whoever runs it. If it was, choose Change destination and save it again to see the new fingerprint.</p>}
    {status.serverCheck==="key-refused"&&<p role="alert" className="text-[13px] text-warning">The server did not accept Murage's key the last time. Add the key shown above to the server's authorized keys, then test the connection again.</p>}
    <p className="text-[13px] text-ink-secondary">Off-site password: {status.passwordSelected?"ready":"not set up yet"}. It locks the off-site copy and is separate from your recovery key and {sftp?"the SSH key":"storage access keys"}.</p>
    {!status.passwordSelected&&<p className="text-[12px] text-ink-secondary">Setting up a new destination? Let Murage create the password. Restoring on a new computer? Choose the password file you kept.</p>}
    <div className="flex flex-wrap gap-2">
     {bridge?.createRepositoryPassword&&!status.passwordSelected&&<button className={buttonClass} type="button" disabled={locked||!binding} onClick={()=>void run("create-password",async(api,expected)=>{if(!binding||!api.createRepositoryPassword)return;const result=await api.createRepositoryPassword(binding.ref,binding.revision);await refresh(expected);if(mounted.current)setNotice(`Murage created your off-site password file: ${result.path}. Keep a copy away from this computer, as you do with your recovery key: you need both to restore the off-site copy on a new computer.`);})}>{busy==="create-password"?"Creating password…":"Create off-site password"}</button>}
     <button className={buttonClass} type="button" disabled={locked||!binding} onClick={()=>void run("password",async(api,expected)=>{if(!binding)return;const result=await api.selectRepositoryPassword(binding.ref,binding.revision);await refresh(expected);if(mounted.current)setNotice(result.cancelled?"Password selection cancelled. Saved settings are unchanged.":"Off-site password file chosen. Nothing has been connected or uploaded.");})}>{status.passwordSelected?"Choose a different password file":"Choose a password file I already have"}</button>
     {bridge?.saveRepositoryPasswordCopy&&status.passwordSelected&&<button className={buttonClass} type="button" disabled={locked||!binding} onClick={()=>void run("copy-password",async(api)=>{if(!binding||!api.saveRepositoryPasswordCopy)return;const result=await api.saveRepositoryPasswordCopy(binding.ref,binding.revision);if(mounted.current)setNotice(result.cancelled?"No copy was saved.":`Copy saved: ${result.path}`);})}>{busy==="copy-password"?"Saving copy…":"Save a copy of the off-site password…"}</button>}
    </div>
    <p className="text-[12px] text-ink-secondary">Test connection checks the {sftp?"server, the key and that the folder can be written to":"storage and your access keys"}, then opens the backup repository there, or creates it when there isn't one yet. Nothing is uploaded.</p>
    <button className={buttonClass} type="button" disabled={connectDisabled} onClick={testConnection}>{busy==="connect"?"Testing connection…":"Test connection"}</button>
    {trust&&binding&&trust.ref===binding.ref&&trust.revision===binding.revision&&<div role="group" aria-label="Trust this server" className="space-y-2 rounded-lg border border-hairline/40 p-3">
     <p className="text-[13px] font-medium text-ink">First connection to this server</p>
     <p className="text-[13px] text-ink-secondary">Its fingerprint is:</p>
     <p className="break-all font-mono text-[13px] text-ink" data-testid="sftp-fingerprint">{trust.fingerprint}</p>
     <p className="text-[12px] text-ink-secondary">Key type {trust.keyType}. If you can, compare it with the fingerprint the server itself shows (for example with ssh-keygen -lf on the server). Murage remembers it and refuses to connect if it ever changes.</p>
     <div className="flex flex-wrap gap-2"><button className={buttonClass} type="button" disabled={locked} onClick={trustServer}>{busy==="trust"?"Trusting and connecting…":"Trust this server"}</button><button className={buttonClass} type="button" disabled={!!busy} onClick={()=>setTrust(null)}>Cancel</button></div>
    </div>}
    {latest?<p className="text-[13px] text-ink-secondary">Latest verified local backup: {new Date(latest.verifiedAt).toLocaleString()} · {latest.bytes.toLocaleString()} bytes.</p>:<p className="text-[13px] text-ink-secondary">Complete a scheduled local backup first. Only a locally verified backup can be uploaded here.</p>}
    {status.lastUpload&&<p role="status" className="text-[13px] text-ink-secondary">Recorded off-site result for the latest backup: {status.lastUpload.state==="verified"?"copy verified by readback":status.lastUpload.state==="needs-review"?"needs review; no automatic retry":"not uploaded"}. This is saved evidence, not a live storage check.</p>}
    {status.lastUpload?.lockRelease==="unconfirmed"&&<p className="text-[12px] text-warning">The {sftp?"server":"storage provider"} did not confirm the repository lock was released after this upload. Later removal may be refused until the lock is cleared.</p>}
    {status.lastUpload?.state==="needs-review"&&<div className="space-y-2"><p className="text-[12px] text-ink-secondary">Check whether the original upload finished. This downloads and verifies the existing encrypted copy; it does not upload again.</p><button className={buttonClass} type="button" disabled={locked||!binding||!latest||!bridge?.reconcileLatest} onClick={()=>void run("reconcile",async(api,expected)=>{if(!binding||!latest)return;const result=await api.reconcileLatest(binding.ref,binding.revision,latest.jobId);await refresh(expected);if(mounted.current)setNotice(result.state==="verified"?"Existing off-site copy verified. Nothing was uploaded again.":"The existing off-site copy could not be verified. Review is still required; nothing was uploaded again.");})}>{busy==="reconcile"?"Checking existing copy…":"Check existing off-site copy"}</button></div>}
    <label className="flex min-h-11 items-start gap-3 py-2 text-[13px] text-ink"><input type="checkbox" checked={uploadConsent} disabled={locked||status.state!=="connected"||!latest} onChange={event=>setUploadConsent(event.target.checked)} className="mt-1 size-4 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent-border"/><span>{sftp?"Upload this encrypted backup to my SFTP server.":"Upload this encrypted backup to my off-site storage."}</span></label>
    <button className={buttonClass} type="button" disabled={locked||!binding||status.state!=="connected"||!latest||!uploadConsent} onClick={()=>void run("upload",async(api,expected)=>{if(!binding||!latest)return;const result=await api.uploadLatest(binding.ref,binding.revision,latest.jobId);await refresh(expected);if(mounted.current)setNotice((result.state==="verified"?"Off-site copy uploaded and verified by readback. Your local backup is unchanged.":"Upload needs review. Your local backup is unchanged; nothing will be retried automatically.")+((result as {lockRelease?:string}).lockRelease==="unconfirmed"?" The provider did not confirm the repository lock was released.":""));})}>{busy==="upload"?"Uploading and verifying…":"Upload latest verified backup"}</button>
    <div className="space-y-3 border-t border-hairline/40 pt-3">
     <h4 className="text-[13px] font-medium text-ink">Automatic off-site uploads</h4>
     <p className="text-[13px] text-ink-secondary">When enabled, future locally verified backups are uploaded to this saved destination while Murage is open. Existing backups are not uploaded.</p>
     <p role="status" className="text-[13px] text-ink">{status.automaticUpload?.state==="needs-review"?"Automatic uploads paused for review.":status.automaticUpload?.enabled?"Automatic uploads enabled while Murage is open.":"Automatic uploads are off."}</p>
     {status.automaticUpload?.state==="needs-review"&&<p className="text-[13px] text-ink-secondary">Review the uncertain upload first. To allow future backups afterward, disable automatic uploads and enable them again. This does not retry the same backup.</p>}
     <p className="text-[12px] text-ink-secondary">Changing the destination, {sftp?"trusting a server":"access keys"} or off-site password file turns automatic uploads off and requires your permission again.</p>
     <button className={buttonClass} type="button" disabled={locked||!binding||!bridge?.setAutomaticUpload||(!status.automaticUpload?.enabled&&(status.state!=="connected"||!status.passwordSelected))} onClick={()=>void run("automatic",async(api,expected)=>{if(!binding||!api.setAutomaticUpload)return;const enabled=!status.automaticUpload?.enabled;await api.setAutomaticUpload(binding.ref,binding.revision,enabled);await refresh(expected);if(mounted.current)setNotice(enabled?"Automatic uploads enabled for future verified backups. Existing backups were not uploaded.":"Automatic uploads disabled. A running upload is not cancelled.");})}>{busy==="automatic"?"Saving automatic upload setting…":status.automaticUpload?.enabled?"Disable automatic uploads":"Enable automatic uploads"}</button>
     {!bridge?.setAutomaticUpload&&<p className="text-[12px] text-ink-secondary">Automatic uploads require an updated desktop app.</p>}
    </div>
    {bridge?.remove&&<div className="space-y-2 border-t border-hairline/40 pt-3">
     {!removing?<button className={buttonClass} type="button" disabled={locked||!binding} onClick={()=>setRemoving(true)}>Remove this destination</button>:<>
      <p className="text-[13px] text-ink">Remove {status.label??"this destination"}? Murage forgets its settings{sftp?", its SSH key and the trusted server fingerprint":" and access keys"}. Backups already stored there are not deleted.{sftp?" You can remove Murage's key from the server's authorized keys afterwards.":""}</p>
      <div className="flex flex-wrap gap-2"><button className={buttonClass} type="button" disabled={locked||!binding} onClick={()=>void run("remove",async(api,expected)=>{if(!binding||!api.remove)return;await api.remove(binding.ref,binding.revision);await refresh(expected);if(mounted.current)setNotice("Destination removed. Copies already stored there were not deleted.");})}>{busy==="remove"?"Removing…":"Remove destination"}</button><button className={buttonClass} type="button" disabled={!!busy} onClick={()=>setRemoving(false)}>Keep destination</button></div>
     </>}
    </div>}
   </div>}
  </>}
 </div>;
}
/** Maintenance key and preview-before-remove retention ("Clean up old off-site copies"). */
export function OffsiteCleanup({r}:{r:RemoteController}){
 const {bridge,status,latest,busy,run,refresh,mounted,version,setNotice,locked,binding,maintenance,setMaintenance,retentionDraft,setRetentionDraft,setPreview,removalConsent,setRemovalConsent,retentionPolicy,currentPreview}=r;
 if(!status?.supported||status.configured!==true||r.editing||!bridge?.previewRetention||!bridge.applyRetention||!bridge.saveMaintenanceCredentials)return null;
 // One SFTP key both writes and removes; only S3 separates a maintenance key.
 const sftp=status.kind==="sftp",maintenanceReady=sftp||status.maintenanceSelected;
 return <div className="space-y-3 border-t border-hairline/40 pt-3">
  <h4 className="text-[13px] font-medium text-ink">Clean up old off-site copies</h4>
  <p className="text-[13px] text-ink-secondary">Remove older off-site copies of this installation only after you preview them. The latest verified copy is always kept. Other installations and older untagged copies are never removed. Removing copies cannot be undone.</p>
  {sftp?<p className="text-[13px] text-ink-secondary">Removals use this destination's SSH key.</p>:<>
  <p role="status" className="text-[13px] text-ink">Maintenance access key: {status.maintenanceSelected?"saved":"not saved"}. Use a separate key that may delete repository data; routine uploads never use it.</p>
  <form className="space-y-3" onSubmit={event=>{event.preventDefault();if(locked||!binding||!maintenance.accessKeyId||!maintenance.secretAccessKey)return;void run("maintenance",async(api,expected)=>{
   try{await api.saveMaintenanceCredentials!(binding.ref,binding.revision,{...maintenance});}finally{setMaintenance({accessKeyId:"",secretAccessKey:""});}
   await refresh(expected);if(mounted.current)setNotice("Maintenance access key saved securely. Nothing was removed.");
  });}}>
   <fieldset disabled={locked||!binding} className="min-w-0 space-y-3"><legend className="text-[13px] font-medium text-ink">Maintenance access key</legend>
    {([["accessKeyId","Maintenance access key ID"],["secretAccessKey","Maintenance secret access key"]]as const).map(([key,label])=><label key={key} className="block text-[13px] text-ink-secondary">{label}<input className={inputClass} type="password" value={maintenance[key]} maxLength={4096} autoComplete="off" spellCheck={false} onChange={event=>{const value=event.target.value;setMaintenance(current=>({...current,[key]:value}));}} required/></label>)}
   </fieldset>
   <button className={buttonClass} type="submit" disabled={locked||!binding||!maintenance.accessKeyId||!maintenance.secretAccessKey}>{busy==="maintenance"?"Saving maintenance key…":"Save maintenance access key"}</button>
  </form></>}
  <fieldset disabled={locked||!binding} className="grid min-w-0 gap-3 sm:grid-cols-2"><legend className="text-[13px] font-medium text-ink">Copies to keep for this installation</legend>
   {retentionFields.map(([key,label])=><label key={key} className="block text-[13px] text-ink-secondary">{label}<input className={inputClass} inputMode="numeric" value={retentionDraft[key]} maxLength={4} autoComplete="off" onChange={event=>{const value=event.target.value;setRetentionDraft(current=>({...current,[key]:value}));setPreview(null);setRemovalConsent(false);}}/></label>)}
  </fieldset>
  <p className="text-[12px] text-ink-secondary">Enter whole numbers from 1 to 1000 and leave unused fields empty. There is no default.</p>
  <button className={buttonClass} type="button" disabled={locked||!binding||status.state!=="connected"||!maintenanceReady||!retentionPolicy||!latest} onClick={()=>void run("preview",async(api,expected)=>{if(!binding||!retentionPolicy)return;const value=remoteRetentionPreview(await api.previewRetention!(binding.ref,binding.revision,retentionPolicy));if(mounted.current&&version.current===expected){setPreview({...value,...binding,policy:JSON.stringify(retentionPolicy)});setRemovalConsent(false);}})}>{busy==="preview"?"Previewing removals…":"Preview removals"}</button>
  {currentPreview&&<div className="space-y-2">
   <p role="status" className="text-[13px] text-ink">{currentPreview.remove.length===0?"Nothing would be removed.":currentPreview.remove.length===1?"1 off-site copy would be removed.":currentPreview.remove.length+" off-site copies would be removed."} {currentPreview.keep===1?"1 copy is kept.":currentPreview.keep+" copies are kept."}</p>
   {currentPreview.remove.length>0&&<>
    <ul className="list-disc pl-5 text-[12px] text-ink-secondary">{currentPreview.remove.slice(0,10).map(id=><li key={id} className="break-all">{id.slice(0,12)}</li>)}{currentPreview.remove.length>10&&<li>and {currentPreview.remove.length-10} more</li>}</ul>
    <label className="flex min-h-11 items-start gap-3 py-2 text-[13px] text-ink"><input type="checkbox" checked={removalConsent} disabled={locked} onChange={event=>setRemovalConsent(event.target.checked)} className="mt-1 size-4 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent-border"/><span>Permanently remove exactly these previewed copies and reclaim unused storage. This cannot be undone.</span></label>
    <button className={buttonClass} type="button" disabled={locked||!binding||!removalConsent||!retentionPolicy} onClick={()=>void run("retention",async(api,expected)=>{if(!binding||!retentionPolicy||!currentPreview)return;const result=await api.applyRetention!(binding.ref,binding.revision,retentionPolicy,currentPreview.previewId);await refresh(expected);if(mounted.current)setNotice(result.state==="complete"?(result.removed===1?"Removed 1 previewed copy and reclaimed unused storage.":"Removed "+result.removed+" previewed copies and reclaimed unused storage."):result.state==="nothing-to-remove"?"Nothing needed removing.":"Removal needs review. Nothing will be retried automatically.");})}>{busy==="retention"?"Removing previewed copies…":"Remove previewed copies"}</button>
   </>}
   {currentPreview.lockRelease&&<p className="text-[12px] text-warning">The provider did not confirm the repository lock was released. Removal may be refused until the lock is cleared at the provider.</p>}
  </div>}
  {status.retention&&<p role="status" className="text-[13px] text-ink-secondary">Last removal: {status.retention.state==="complete"?"completed":status.retention.state==="needs-review"?"needs review: "+(status.retention.error?retentionIssues[status.retention.error]:"the result could not be confirmed"):"not finished; needs review"}. This is saved evidence, not a live storage check.</p>}
  {status.retention&&["needs-review","forgetting","pruning"].includes(status.retention.state)&&status.retention.previewId&&<button className={buttonClass} type="button" disabled={locked||!binding||!bridge.clearRetentionReview} onClick={()=>void run("clear",async(api,expected)=>{const previewId=status.retention?.previewId;if(!binding||!previewId)return;await api.clearRetentionReview!(binding.ref,binding.revision,previewId);await refresh(expected);if(mounted.current)setNotice("Removal review cleared. Preview again before removing anything.");})}>{busy==="clear"?"Clearing review…":"Mark removal reviewed"}</button>}
  <RemoteMessages r={r} area="cleanup"/>
 </div>;
}
/** Find, download and open Backup mode for an off-site copy. */
export function OffsiteRecover({r}:{r:RemoteController}){
 const {bridge,status,busy,run,mounted,version,setNotice,locked,binding,available,setCatalogue,selectedBackup,setSelectedBackup,downloaded,setDownloaded}=r;
 if(!status?.supported||status.configured!==true||r.editing)return <p className="text-[13px] text-ink-secondary">Set up and connect an off-site copy to recover from it here.</p>;
 return <div className="space-y-3">
  <p className="text-[13px] text-ink-secondary">You can recover an off-site copy even if the original local backup is gone{status.kind==="sftp"?", or on a new computer: add the SFTP destination there, add its new key to the server, choose the same off-site password file and test the connection":""}. Finding and downloading use your {status.kind==="sftp"?"SFTP connection":"storage connection"}. Your current Murage data stays unchanged.</p>
  <button className={buttonClass} type="button" disabled={locked||!binding||status.state!=="connected"||!bridge?.listBackups} onClick={()=>void run("list",async(api,expected)=>{if(!binding)return;const value=remoteBackupCatalogue(await api.listBackups(binding.ref,binding.revision));if(mounted.current&&version.current===expected){setCatalogue({...value,...binding});setSelectedBackup("");setDownloaded(null);}})}>{busy==="list"?"Finding backups…":"Find off-site backups"}</button>
  {available&&<>
   {available.ignored>0&&<p className="text-[12px] text-warning">Some repository entries could not be identified as eligible Murage backups and are not shown.</p>}
   {available.backups.length===0?<p role="status" className="text-[13px] text-ink-secondary">No eligible Murage backups were found in this repository.</p>:<>
    <label className="block text-[13px] text-ink-secondary">Backup to recover<select className={inputClass} disabled={locked} value={selectedBackup} onChange={event=>{setSelectedBackup(event.target.value);setDownloaded(null);}}><option value="">Choose a backup</option>{available.backups.map(item=><option key={item.snapshotId} value={item.snapshotId}>{new Date(item.createdAt).toLocaleString()} · {item.snapshotId.slice(0,12)}</option>)}</select></label>
    <p className="text-[12px] text-ink-secondary">Listed copies are not verified yet. Download checks the selected copy and saves it in a new private folder.</p>
    <button className={buttonClass} type="button" disabled={locked||!binding||!available.backups.some(item=>item.snapshotId===selectedBackup)||!bridge?.downloadBackup} onClick={()=>void run("download",async(api,expected)=>{if(!binding)return;const result=await api.downloadBackup(binding.ref,binding.revision,selectedBackup);if(!mounted.current||version.current!==expected)return;if(result.cancelled){setNotice("Download cancelled. Your current installation is unchanged.");return;}if(result.saved!==true||typeof result.archivePath!=="string"||!result.archivePath||result.archivePath.length>8192)throw Error("Unconfirmed download");setDownloaded(result.archivePath);setNotice("Encrypted backup downloaded and verified. Nothing has been restored or restarted.");})}>{busy==="download"?"Downloading and verifying…":"Download verified copy"}</button>
   </>}
  </>}
  {downloaded&&<div className="space-y-2"><p className="break-all text-[13px] text-ink-secondary">Saved backup: {downloaded}</p><p className="text-[13px] text-ink-secondary">Finish current work, then open Backup mode. Choose this backup.age file and your recovery key. It is restored into a new folder for you to review, and your current data stays as it is.</p><button className={buttonClass} type="button" disabled={locked||!window.muragebox?.backup} onClick={()=>void run("restore",async()=>{const result=await window.muragebox!.backup!.restart();if(mounted.current&&result.restarting===false)setNotice("Backup mode was not opened. The downloaded copy is still saved.");})}>Open Backup mode to restore</button></div>}
  <RemoteMessages r={r} area="restore"/>
 </div>;
}
/** Manual status refresh, kept under Advanced. */
export function OffsiteRefresh({r}:{r:RemoteController}){
 return r.bridge?<button className={buttonClass} type="button" disabled={!!r.busy} onClick={r.refreshNow}>Refresh off-site status</button>:null;
}
