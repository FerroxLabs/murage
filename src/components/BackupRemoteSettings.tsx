import {useEffect,useRef,useState} from "react";
import {resticS3TargetSchema,resticS3CredentialsSchema} from "../../server/backup-restic-target";
import type {BackupRemoteStatus} from "../../server/backup-remote-host";
type RemoteBridge=NonNullable<NonNullable<Window["muragebox"]>["backupRemote"]>;
export interface RemoteDraft {label:string;endpoint:string;bucket:string;prefix:string;region:string;accessKeyId:string;secretAccessKey:string;sessionToken:string;bucketLookup:"auto"|"path"|"dns"}
const empty:RemoteDraft={label:"Remote backup",endpoint:"",bucket:"",prefix:"murage",region:"",accessKeyId:"",secretAccessKey:"",sessionToken:"",bucketLookup:"auto"};
export function remoteBackupInput(draft:RemoteDraft){
 const target=resticS3TargetSchema.safeParse({kind:"s3",remoteRef:"draft",credentialRef:"draft",revision:0,endpoint:draft.endpoint.trim(),bucket:draft.bucket.trim(),prefix:draft.prefix.trim(),region:draft.region.trim(),bucketLookup:draft.bucketLookup});
 const credentials=resticS3CredentialsSchema.safeParse({accessKeyId:draft.accessKeyId,secretAccessKey:draft.secretAccessKey,...(draft.sessionToken?{sessionToken:draft.sessionToken}:{})});
 const label=draft.label.trim();if(!target.success||!credentials.success||!label||label.length>80||/[\x00-\x1f\x7f]/.test(label))return null;
 return{label,endpoint:target.data.endpoint,bucket:target.data.bucket,prefix:target.data.prefix,region:target.data.region,bucketLookup:target.data.bucketLookup,credentials:credentials.data};
}
const labels:Record<string,string>={unconfigured:"No remote destination saved","password-required":"Choose the repository password",disconnected:"Destination saved, not connected",connected:"Repository connection confirmed",initializing:"Repository setup needs review","needs-review":"Remote backup needs review",unavailable:"Remote backup unavailable in this app"};
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
 if(Number.isSafeInteger(v.revision)&&Number(v.revision)>=0)result.revision=Number(v.revision);
  if(v.configured){result.remoteRef=String(v.remoteRef);if(typeof v.label==="string"&&v.label.length<=80)result.label=v.label;result.passwordSelected=v.passwordSelected===true;}
 const upload=v.lastUpload as Record<string,unknown>|undefined;
 if(upload){if(!["not-uploaded","needs-review","verified"].includes(String(upload.state))||typeof upload.jobId!=="string"||!/^[a-f0-9]{64}$/.test(upload.jobId))throw Error("Invalid upload status");result.lastUpload={state:upload.state as "not-uploaded"|"needs-review"|"verified",jobId:upload.jobId};}
 const automatic=v.automaticUpload as Record<string,unknown>|undefined;
 if(automatic!==undefined){if(!automatic||typeof automatic.enabled!=="boolean"||!(automatic.enabled?["enabled","needs-review"]:["disabled"]).includes(String(automatic.state)))throw Error("Invalid automatic upload policy");result.automaticUpload={enabled:automatic.enabled,state:automatic.state as "disabled"|"enabled"|"needs-review"};}
 return result;
}
export function remoteBackupError(cause:unknown){
 const code=cause instanceof Error?cause.message:"";
 if(code.includes("BACKUP_REMOTE_CHANGED"))return "The saved destination changed. Refresh status and review it before trying again.";
 if(code.includes("PASSWORD_REQUIRED"))return "Choose your independently saved repository-password file first.";
 if(code.includes("JOB_CHANGED"))return "The latest local backup changed. Refresh and review the backup before uploading.";
 if(code.includes("BUSY"))return "A backup operation is already running. Wait for it to finish, then refresh.";
 return "This step could not be confirmed. Refresh status before trying again. Your local backup is unchanged; no automatic retry will run.";
}
const inputClass="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50";
const buttonClass="min-h-11 rounded-lg border border-hairline/40 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
export function BackupRemoteSettings(){
 const bridge=typeof window!=="undefined"?window.muragebox?.backupRemote:undefined;
 const [status,setStatus]=useState<BackupRemoteStatus|null>(null),[latest,setLatest]=useState<{jobId:string;bytes:number;verifiedAt:number}|null>(null);
 const [draft,setDraft]=useState<RemoteDraft>(empty),[editing,setEditing]=useState(false),[uploadConsent,setUploadConsent]=useState(false);
 const [busy,setBusy]=useState<string|null>(null),[stale,setStale]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null);
 const [catalogue,setCatalogue]=useState<(ReturnType<typeof remoteBackupCatalogue>&{ref:string;revision:number})|null>(null),[selectedBackup,setSelectedBackup]=useState("");
 const [downloaded,setDownloaded]=useState<string|null>(null);
 const mounted=useRef(true),gate=useRef(false),version=useRef(0);
 async function refresh(expected:number){
  if(!bridge)return;
  const [remote,schedule]=await Promise.all([bridge.status(),window.muragebox?.backupSchedule?.status().catch(()=>null)]);
  const next=remoteBackupStatus(remote);if(!mounted.current||version.current!==expected)return;
  setStatus(next);setStale(false);const receipt=schedule?.lastVerified;
  setLatest(receipt&&/^[a-f0-9]{64}$/.test(receipt.jobId)&&Number.isSafeInteger(receipt.bytes)&&receipt.bytes>0&&Number.isFinite(receipt.verifiedAt)?{jobId:receipt.jobId,bytes:receipt.bytes,verifiedAt:receipt.verifiedAt}:null);
  setUploadConsent(false);
 }
 async function run(action:string,work:(api:RemoteBridge,expected:number)=>Promise<void>){
  if(gate.current||!bridge)return;gate.current=true;const expected=++version.current;setBusy(action);setError(null);setNotice(null);
  try{await work(bridge,expected);}catch(cause){if(mounted.current&&version.current===expected){setError(remoteBackupError(cause));setStale(true);setUploadConsent(false);}}
  finally{gate.current=false;if(mounted.current)setBusy(null);}
 }
 useEffect(()=>{mounted.current=true;void run("refresh",async(_api,expected)=>refresh(expected));return()=>{mounted.current=false;version.current++;};},[]);
 const locked=!bridge||!status?.supported||status.pending||!!busy||stale;
 const payload=remoteBackupInput(draft),configured=status?.configured===true;
 const binding=typeof status?.remoteRef==="string"&&Number.isSafeInteger(status.revision)?{ref:status.remoteRef,revision:status.revision!}:null;
 const available=catalogue&&binding&&catalogue.ref===binding.ref&&catalogue.revision===binding.revision?catalogue:null;
 const change=(key:keyof RemoteDraft,value:string)=>{setDraft(current=>({...current,[key]:value}));setUploadConsent(false);};
 return <section aria-labelledby="remote-backup-title" className="min-w-0 space-y-3 rounded-xl border border-hairline/40 bg-card p-4">
  <h3 id="remote-backup-title" className="text-[15px] font-medium text-ink">Remote backup (optional)</h3>
  <p className="text-[13px] text-ink-secondary">Keep a copy of a verified local backup in your existing S3-compatible repository. Saving settings does not connect or upload. Your storage provider may charge for transfers and storage.</p>
  <p role="status" className="text-[13px] font-medium text-ink">{status?labels[status.state]:bridge?"Checking remote backup…":"Remote backup unavailable in this window"}</p>
  {bridge&&<button className={buttonClass} type="button" disabled={!!busy} onClick={()=>void run("refresh",async(_api,expected)=>refresh(expected))}>Refresh remote backup status</button>}
  {status?.supported&&<>
   {configured&&<div className="space-y-2"><p className="break-words text-[13px] text-ink-secondary">Saved destination: {status.label??"Remote backup"}</p><button className={buttonClass} type="button" disabled={locked} onClick={()=>{setEditing(value=>!value);setDraft(empty);}}>{editing?"Cancel destination changes":"Change destination or access keys"}</button></div>}
   {(!configured||editing)&&<form className="space-y-3" onSubmit={event=>{event.preventDefault();if(locked||!payload)return;void run("save",async(api,expected)=>{
    try{await api.save(status.revision??0,payload);}finally{setDraft(current=>({...current,accessKeyId:"",secretAccessKey:"",sessionToken:""}));}
    await refresh(expected);if(mounted.current){setEditing(false);setNotice("Destination saved securely. Nothing has been connected or uploaded.");}
   });}}>
    <p className="text-[13px] text-ink-secondary">Use the endpoint, bucket, region and access keys from your storage provider. The bucket and Restic repository must already exist.</p>
    <fieldset disabled={locked} className="min-w-0 space-y-3"><legend className="text-[13px] font-medium text-ink">Destination details</legend>
    {([['label','Destination name',80],['endpoint','S3 endpoint (HTTPS)',2048],['bucket','Bucket name',63],['prefix','Repository folder',512],['region','Region',64]]as const).map(([key,label,maxLength])=><label key={key} className="block text-[13px] text-ink-secondary">{label}<input className={inputClass} value={draft[key]} maxLength={maxLength} autoComplete="off" spellCheck={false} onChange={event=>change(key,event.target.value)} required/></label>)}
    <details><summary className="min-h-11 cursor-pointer py-3 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Advanced connection option</summary><label className="block text-[13px] text-ink-secondary">Bucket addressing<select className={inputClass} value={draft.bucketLookup} onChange={event=>change("bucketLookup",event.target.value)}><option value="auto">Automatic</option><option value="path">Path</option><option value="dns">DNS</option></select></label></details>
    {([['accessKeyId','Access key ID'],['secretAccessKey','Secret access key'],['sessionToken','Session token (optional)']]as const).map(([key,label])=><label key={key} className="block text-[13px] text-ink-secondary">{label}<input className={inputClass} type="password" value={draft[key]} maxLength={4096} autoComplete="off" spellCheck={false} onChange={event=>change(key,event.target.value)} required={key!=="sessionToken"}/></label>)}
    <p className="text-[12px] text-ink-secondary">Access keys are saved in the operating system’s encrypted store and cleared from this form after saving. Changing a destination requires entering its complete details and keys.</p>
    </fieldset><button className={buttonClass} type="submit" disabled={locked||!payload}>{busy==="save"?"Saving destination…":"Save remote destination"}</button>
   </form>}
   {configured&&!editing&&<div className="space-y-3">
    <p className="text-[13px] text-ink-secondary">Repository password: {status.passwordSelected?"independent file selected":"not selected"}. This is separate from your age recovery key and storage access keys.</p>
    <button className={buttonClass} type="button" disabled={locked||!binding} onClick={()=>void run("password",async(api,expected)=>{if(!binding)return;const result=await api.selectRepositoryPassword(binding.ref,binding.revision);await refresh(expected);if(mounted.current)setNotice(result.cancelled?"Password selection cancelled. Saved settings are unchanged.":"Repository-password reference saved. Nothing has been connected or uploaded.");})}>Choose repository-password file</button>
    <button className={buttonClass} type="button" disabled={locked||!binding||!status.passwordSelected||status.state==="needs-review"||status.state==="initializing"} onClick={()=>void run("connect",async(api,expected)=>{if(!binding)return;await api.connect(binding.ref,binding.revision);await refresh(expected);if(mounted.current)setNotice("Existing repository connection confirmed. No backup was uploaded.");})}>{busy==="connect"?"Connecting…":"Connect existing repository"}</button>
    {latest?<p className="text-[13px] text-ink-secondary">Latest verified local backup: {new Date(latest.verifiedAt).toLocaleString()} · {latest.bytes.toLocaleString()} bytes.</p>:<p className="text-[13px] text-ink-secondary">Complete a scheduled local backup first. Only a locally verified backup can be uploaded here.</p>}
    {status.lastUpload&&<p role="status" className="text-[13px] text-ink-secondary">Recorded remote result for the latest backup: {status.lastUpload.state==="verified"?"copy verified by readback":status.lastUpload.state==="needs-review"?"needs review; no automatic retry":"not uploaded"}. This is saved evidence, not a live storage check.</p>}
    {status.lastUpload?.state==="needs-review"&&<div className="space-y-2"><p className="text-[12px] text-ink-secondary">Check whether the original upload finished. This downloads and verifies the existing encrypted copy; it does not upload again. Provider transfer charges may apply.</p><button className={buttonClass} type="button" disabled={locked||!binding||!latest||!bridge?.reconcileLatest} onClick={()=>void run("reconcile",async(api,expected)=>{if(!binding||!latest)return;const result=await api.reconcileLatest(binding.ref,binding.revision,latest.jobId);await refresh(expected);if(mounted.current)setNotice(result.state==="verified"?"Existing remote copy verified. Nothing was uploaded again.":"The existing remote copy could not be verified. Review is still required; nothing was uploaded again.");})}>{busy==="reconcile"?"Checking existing copy…":"Check existing remote copy"}</button></div>}
    <label className="flex min-h-11 items-start gap-3 py-2 text-[13px] text-ink"><input type="checkbox" checked={uploadConsent} disabled={locked||status.state!=="connected"||!latest} onChange={event=>setUploadConsent(event.target.checked)} className="mt-1 size-4 shrink-0 accent-accent focus-visible:ring-2 focus-visible:ring-accent-border"/><span>Upload this encrypted backup to my saved remote storage. Provider charges may apply.</span></label>
    <button className={buttonClass} type="button" disabled={locked||!binding||status.state!=="connected"||!latest||!uploadConsent} onClick={()=>void run("upload",async(api,expected)=>{if(!binding||!latest)return;const result=await api.uploadLatest(binding.ref,binding.revision,latest.jobId);await refresh(expected);if(mounted.current)setNotice(result.state==="verified"?"Remote copy uploaded and verified by readback. Your local backup is unchanged.":"Upload needs review. Your local backup is unchanged; nothing will be retried automatically.");})}>{busy==="upload"?"Uploading and verifying…":"Upload latest verified backup"}</button>
    <div className="space-y-3 border-t border-hairline/40 pt-3">
     <h4 className="text-[13px] font-medium text-ink">Automatic remote uploads</h4>
     <p className="text-[13px] text-ink-secondary">When enabled, future locally verified backups are uploaded to this saved destination while Murage is open. Existing backups are not uploaded. Your provider may charge for transfers and storage.</p>
     <p role="status" className="text-[13px] text-ink">{status.automaticUpload?.state==="needs-review"?"Automatic uploads paused for review.":status.automaticUpload?.enabled?"Automatic uploads enabled while Murage is open.":"Automatic uploads are off."}</p>
     {status.automaticUpload?.state==="needs-review"&&<p className="text-[13px] text-ink-secondary">Review the uncertain upload first. To allow future backups afterward, disable automatic uploads and enable them again. This does not retry the same backup.</p>}
     <p className="text-[12px] text-ink-secondary">Changing the destination, access keys or repository-password file turns automatic uploads off and requires your permission again.</p>
     <button className={buttonClass} type="button" disabled={locked||!binding||!bridge?.setAutomaticUpload||(!status.automaticUpload?.enabled&&(status.state!=="connected"||!status.passwordSelected))} onClick={()=>void run("automatic",async(api,expected)=>{if(!binding||!api.setAutomaticUpload)return;const enabled=!status.automaticUpload?.enabled;await api.setAutomaticUpload(binding.ref,binding.revision,enabled);await refresh(expected);if(mounted.current)setNotice(enabled?"Automatic uploads enabled for future verified backups. Existing backups were not uploaded.":"Automatic uploads disabled. A running upload is not cancelled.");})}>{busy==="automatic"?"Saving automatic upload setting…":status.automaticUpload?.enabled?"Disable automatic uploads":"Enable automatic uploads"}</button>
     {!bridge?.setAutomaticUpload&&<p className="text-[12px] text-ink-secondary">Automatic uploads require an updated desktop app.</p>}
    </div>
    <div className="space-y-3 border-t border-hairline/40 pt-3">
     <h4 className="text-[13px] font-medium text-ink">Recover a remote backup</h4>
     <p className="text-[13px] text-ink-secondary">You can recover a remote copy even if the original local backup is gone. Finding and downloading use your storage connection; provider charges may apply. Your current installation stays unchanged.</p>
     <button className={buttonClass} type="button" disabled={locked||!binding||status.state!=="connected"||!bridge?.listBackups} onClick={()=>void run("list",async(api,expected)=>{if(!binding)return;const value=remoteBackupCatalogue(await api.listBackups(binding.ref,binding.revision));if(mounted.current&&version.current===expected){setCatalogue({...value,...binding});setSelectedBackup("");setDownloaded(null);}})}>{busy==="list"?"Finding backups…":"Find remote backups"}</button>
     {available&&<>
      {available.ignored>0&&<p className="text-[12px] text-warning">Some repository entries could not be identified as eligible Murage backups and are not shown.</p>}
      {available.backups.length===0?<p role="status" className="text-[13px] text-ink-secondary">No eligible Murage backups were found in this repository.</p>:<>
       <label className="block text-[13px] text-ink-secondary">Backup to recover<select className={inputClass} disabled={locked} value={selectedBackup} onChange={event=>{setSelectedBackup(event.target.value);setDownloaded(null);}}><option value="">Choose a backup</option>{available.backups.map(item=><option key={item.snapshotId} value={item.snapshotId}>{new Date(item.createdAt).toLocaleString()} · {item.snapshotId.slice(0,12)}</option>)}</select></label>
       <p className="text-[12px] text-ink-secondary">Listed copies are not verified yet. Download checks the selected copy and saves it in a new private folder.</p>
       <button className={buttonClass} type="button" disabled={locked||!binding||!available.backups.some(item=>item.snapshotId===selectedBackup)||!bridge?.downloadBackup} onClick={()=>void run("download",async(api,expected)=>{if(!binding)return;const result=await api.downloadBackup(binding.ref,binding.revision,selectedBackup);if(!mounted.current||version.current!==expected)return;if(result.cancelled){setNotice("Download cancelled. Your current installation is unchanged.");return;}if(result.saved!==true||typeof result.archivePath!=="string"||!result.archivePath||result.archivePath.length>8192)throw Error("Unconfirmed download");setDownloaded(result.archivePath);setNotice("Encrypted backup downloaded and verified. Nothing has been restored or restarted.");})}>{busy==="download"?"Downloading and verifying…":"Download verified copy"}</button>
      </>}
     </>}
     {downloaded&&<div className="space-y-2"><p className="break-all text-[13px] text-ink-secondary">Saved backup: {downloaded}</p><p className="text-[13px] text-ink-secondary">Finish current work, then open Backup mode. Choose this backup.age file and your independent age recovery key. Restore into a new installation for review; the current installation is retained.</p><button className={buttonClass} type="button" disabled={locked||!window.muragebox?.backup} onClick={()=>void run("restore",async()=>{const result=await window.muragebox!.backup!.restart();if(mounted.current&&result.restarting===false)setNotice("Backup mode was not opened. The downloaded copy is still saved.");})}>Open Backup mode to restore</button></div>}
    </div>
   </div>}
  </>}
  {status&&!status.supported&&<p className="text-[13px] text-ink-secondary">A supported desktop build with its verified Restic tool is required. Local backups remain separate.</p>}
  {status?.pending&&<p role="status" className="text-[13px] text-ink-secondary">Remote backup work is in progress. Refresh after it finishes.</p>}
  {stale&&<p role="alert" className="text-[13px] text-warning">Status needs a refresh. Connection and upload actions are locked.</p>}
  {error&&<p role="alert" className="text-[13px] text-danger">{error}</p>}
  {notice&&<p role="status" className="text-[13px] text-ink-secondary">{notice}</p>}
 </section>;
}
