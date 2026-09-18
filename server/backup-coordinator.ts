import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { acquireDataDirLeaseForProcess } from "./data-dir-lease.ts";
import { writeFileAtomic } from "./atomic.ts";
import { canonicalUpdateDescriptor, parseUpdateCandidate, type UpdateCandidate } from "../shared/update-candidate.mjs";
import { backupScheduleSchema, backupReceiptSchema, backupReferenceSchema, backupHandoffSchema, backupClosedResultSchema, latestBackupOccurrence, type BackupClosedResult, type BackupHandoff, type BackupSchedule, type BackupReceipt } from "../shared/backup-schedule.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jobSchema = z.object({ id:z.string().regex(/^[a-f0-9]{64}$/), occurrence:z.string().max(200), revision:z.number().int().nonnegative(), scheduledAt:z.number().int().nonnegative(),
  phase:z.enum(["due","waiting-idle","waiting-backup-mode","claiming","capturing","local-verified","skipped","needs-review","handoff-prepared","handoff-armed","offline-claimed","return-pending","returned","install-requested","upgrade-complete","upgrade-cancelled"]),
  handoff:backupHandoffSchema.optional(),
  attemptAt:z.number().int().nonnegative().optional(), error:z.enum(["interrupted","capture-unconfirmed","receipt-mismatch","cancelled","duration-exceeded","catchup-expired","idle-release-unconfirmed"]).optional(), receipt:backupReceiptSchema.optional(),
}).strict();
const stateSchema = z.object({ version:z.literal(1),revision:z.number().int().nonnegative(),configuredAt:z.number().int().nonnegative(),schedule:backupScheduleSchema,
  job:jobSchema.optional(),seen:z.array(z.string().max(200)).max(256),watermark:z.number().int().nonnegative(),lastVerified:backupReceiptSchema.optional(),lastClosedResult:backupClosedResultSchema.optional(),
}).strict();
type State = z.infer<typeof stateSchema>;
type Job = z.infer<typeof jobSchema>;
const waitingPhases:Job["phase"][]=["due","waiting-idle","waiting-backup-mode"];
const settledPhases:Job["phase"][]=["local-verified","skipped","returned","upgrade-complete","upgrade-cancelled"];
/** A user-requested backup is named by its revision, so a changed schedule
 * never inherits one. It is only ever started by the request that made it. */
const manualJob=(s:State,job=s.job)=>Boolean(job&&job.revision===s.revision&&job.occurrence.startsWith(`${s.revision}:manual:`));
/** Manual runs do not need the daily time, but they need every reference and
 * budget an enabled schedule must name. */
const manualReady=(schedule:BackupSchedule)=>backupScheduleSchema.safeParse({...schedule,enabled:true}).success;
export interface BackupCaptureRequest { jobId:string; installationRef:string; destinationRef:string; recoveryRef:string; selectionHash:string; selection:NonNullable<BackupSchedule["selection"]>; maxBytes:number; maxDurationMs:number }
interface Lease { release(): void }
interface Options {
  stateDirectory:string; now?:()=>number; acquire?:()=>Lease;
  claimIdle?:(request:BackupCaptureRequest,signal:AbortSignal)=>Promise<{state:"busy"|"backup-mode-required"}|{state:"claimed";release:()=>Promise<void>}>;
  captureOffline?:(request:BackupCaptureRequest,signal:AbortSignal)=>Promise<BackupReceipt>;
}
/** Local coordination only. No scheduling timer, OS task, restic or production idle gate. */
export class BackupCoordinator {
  private options:Options;
  private running?:Promise<ReturnType<BackupCoordinator["status"]>>;
  private controller?:AbortController;
  constructor(options:Options){this.options=options;}
  private now(){return this.options.now?.()??Date.now();}
  private file(){return join(this.options.stateDirectory,"backup-coordinator.json");}
  private read():State {
    try {
      const stat=lstatSync(this.file());if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>128*1024)throw Error();
      return stateSchema.parse(JSON.parse(readFileSync(this.file(),"utf8")));
    } catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {version:1,revision:0,configuredAt:0,schedule:backupScheduleSchema.parse({}),seen:[],watermark:0};throw new Error("BACKUP_COORDINATOR_STATE_INVALID");}
  }
  private save(state:State){const checked=stateSchema.parse(state);mkdirSync(this.options.stateDirectory,{recursive:true,mode:0o700});writeFileAtomic(this.file(),JSON.stringify(checked),{mode:0o600});}
  private lease(){mkdirSync(this.options.stateDirectory,{recursive:true,mode:0o700});try{return this.options.acquire?.()??acquireDataDirLeaseForProcess(this.options.stateDirectory);}catch{throw new Error("BACKUP_COORDINATOR_BUSY");}}
  private async releaseIdle(claimed:{release:()=>Promise<void>}|undefined){
    try{await claimed?.release();}catch{
      const s=this.read();if(s.job){s.job.phase="needs-review";s.job.error="idle-release-unconfirmed";this.save(s);}
      throw new Error("BACKUP_IDLE_RELEASE_UNCONFIRMED");
    }
  }
  status(){const s=this.read();return {enabled:s.schedule.enabled,revision:s.revision,schedule:s.schedule,phase:s.job?.phase??"idle",job:s.job,lastVerified:s.lastVerified,lastClosedResult:s.lastClosedResult,
    message:s.job?.phase==="waiting-backup-mode"?"Due, waiting for Backup mode":s.job?.phase==="waiting-idle"?"Due, waiting for idle":s.job?.phase==="needs-review"?"Interrupted backup needs review; it will not run again automatically":undefined};}
  configure(expectedRevision:number,input:unknown){
    const lease=this.lease();try{const s=this.read();if(s.revision!==expectedRevision)throw new Error("BACKUP_SCHEDULE_CHANGED");
      const schedule=backupScheduleSchema.parse(input);const unresolved=s.job&&["claiming","capturing","needs-review","handoff-prepared","handoff-armed","offline-claimed","return-pending","install-requested"].includes(s.job.phase);
      if(unresolved&&(schedule.enabled||hash({...schedule,enabled:false})!==hash({...s.schedule,enabled:false})))throw new Error("BACKUP_REVIEW_REQUIRED");
      this.save({...s,revision:s.revision+1,configuredAt:this.now(),schedule,job:unresolved?s.job:undefined});return this.status();
    }finally{lease.release();}
  }
  tick(upgradeId?:string){if(this.running)return this.running;this.running=this.work(upgradeId).finally(()=>{this.running=undefined;});return this.running;}
  /** Read-only wake eligibility. Final owner admission and due selection remain
   * mandatory after the GUI job acquires its installation lease. */
  closedEligibility():{status:"disabled"|"not-due"|"due"|"needs-review"}{
    const s=this.read(),job=manualJob(s)&&waitingPhases.includes(s.job!.phase)?undefined:s.job;
    if(!s.schedule.enabled||s.schedule.closedApp!==true)return {status:"disabled"};
    if(job&&!["due","waiting-idle","waiting-backup-mode","local-verified","skipped","returned","upgrade-complete","upgrade-cancelled"].includes(job.phase))return {status:"needs-review"};
    const latest=latestBackupOccurrence(s.schedule,this.now());
    if(job&&["due","waiting-idle","waiting-backup-mode"].includes(job.phase)){
      if(!job.occurrence.includes(":daily:"))return {status:"needs-review"};
      if(latest&&latest.at>job.scheduledAt&&!s.seen.includes(`${s.revision}:daily:${latest.day}`))return {status:"due"};
      return {status:this.now()-job.scheduledAt<=s.schedule.catchupMs!?"due":"not-due"};
    }
    return {status:latest&&latest.at>=s.configuredAt&&latest.at>s.watermark&&!s.seen.includes(`${s.revision}:daily:${latest.day}`)?"due":"not-due"};
  }
  recordClosedResult(input:Pick<BackupClosedResult,"status"|"reason">){
    const lease=this.lease();try{
      const s=this.read();s.lastClosedResult=backupClosedResultSchema.parse({...input,at:this.now(),revision:s.revision,...(s.job?{jobId:s.job.id}:{})});
      this.save(s);return s.lastClosedResult;
    }finally{lease.release();}
  }
  /** One immediate backup through the same prepared and armed handoff as a
   * daily run. A daily job already waiting is handed off instead of a second
   * one, so the two never both run. */
  requestManual(expectedRevision:number,requestId:string){
    const lease=this.lease();try{
      const s=this.read();if(s.revision!==expectedRevision)throw new Error("BACKUP_SCHEDULE_CHANGED");
      const request=backupReferenceSchema.safeParse(requestId);if(!request.success)throw new Error("BACKUP_HANDOFF_REJECTED");
      if(!manualReady(s.schedule))throw new Error("BACKUP_SCHEDULE_CONSENT_REQUIRED");
      const job=s.job;
      if(job&&waitingPhases.includes(job.phase)){
        if(s.schedule.enabled&&job.revision===s.revision&&job.occurrence.includes(":daily:")&&this.now()-job.scheduledAt<=s.schedule.catchupMs!)return this.status();
        if(!manualJob(s)&&!job.occurrence.includes(":daily:"))throw new Error("BACKUP_BUSY");
        job.phase="skipped";job.error=manualJob(s)?"cancelled":"catchup-expired";
      }else if(job&&["handoff-armed","return-pending","install-requested"].includes(job.phase))throw new Error("BACKUP_BUSY");
      else if(job&&!settledPhases.includes(job.phase))throw new Error("BACKUP_REVIEW_REQUIRED");
      const occurrence=`${s.revision}:manual:${request.data}`;
      if(s.seen.includes(occurrence))throw new Error("BACKUP_HANDOFF_CHANGED");
      s.job={id:hash([s.schedule.installationRef,occurrence]),occurrence,revision:s.revision,scheduledAt:this.now(),phase:"due"};
      s.seen=[...s.seen,occurrence].slice(-256);this.save(s);return this.status();
    }finally{lease.release();}
  }
  /** Withdraws a manual request that never reached the handoff. */
  cancelManual(jobId:string){
    const lease=this.lease();try{
      const s=this.read();if(s.job?.id!==jobId||!manualJob(s)||!waitingPhases.includes(s.job.phase))throw new Error("BACKUP_HANDOFF_CHANGED");
      s.job.phase="skipped";s.job.error="cancelled";this.save(s);return this.status();
    }finally{lease.release();}
  }
  private checkedCandidate(input:unknown){const candidate=parseUpdateCandidate(input);if(candidate.candidateId!=="update-"+createHash("sha256").update(canonicalUpdateDescriptor(candidate)).digest("hex"))throw Error("BACKUP_UPDATE_CANDIDATE_INVALID");return candidate;}
  prepareUpgrade(input:UpdateCandidate,intent:BackupHandoff){
    const lease=this.lease();try{
      const s=this.read(),candidate=this.checkedCandidate(input),handoff=backupHandoffSchema.parse({...intent,upgrade:candidate});
      if(!s.schedule.enabled||!s.schedule.preUpgrade||handoff.expiresAt<=this.now()||handoff.expiresAt>this.now()+30*60000)throw Error("BACKUP_HANDOFF_REJECTED");
      if(s.job&&!["local-verified","skipped","returned","upgrade-complete","upgrade-cancelled"].includes(s.job.phase))throw Error("BACKUP_REVIEW_REQUIRED");
      const occurrence=`${s.revision}:upgrade:${candidate.candidateId}:${handoff.id}`;
      if(s.seen.includes(occurrence))throw Error("BACKUP_HANDOFF_CHANGED");
      s.job={id:hash([s.schedule.installationRef,occurrence]),occurrence,revision:s.revision,scheduledAt:this.now(),phase:"handoff-prepared",handoff};
      s.seen=[...s.seen,occurrence].slice(-256);this.save(s);return this.status();
    }finally{lease.release();}
  }
  private checkUpgrade(s:State,id:string,input:UpdateCandidate,bindingRevision:string,installationIdentity:string){
    const candidate=this.checkedCandidate(input),job=s.job,intent=job?.handoff,r=job?.receipt;
    if(!job||intent?.id!==id||!intent.upgrade||this.checkedCandidate(intent.upgrade).candidateId!==candidate.candidateId
      ||canonicalUpdateDescriptor(intent.upgrade)!==canonicalUpdateDescriptor(candidate)
      ||!s.schedule.enabled||!s.schedule.preUpgrade||job.revision!==s.revision||intent.expiresAt<=this.now()
      ||intent.bindingRevision!==bindingRevision||intent.installationIdentity!==installationIdentity
      ||!r||r.candidateId!==candidate.candidateId||r.jobId!==job.id||r.artifactRef!==job.id
      ||r.installationRef!==s.schedule.installationRef||r.destinationRef!==s.schedule.destinationRef||r.selectionHash!==hash(s.schedule.selection)
      ||r.bytes>s.schedule.maxBytes!||job.attemptAt===undefined||r.verifiedAt<job.attemptAt||r.verifiedAt>this.now())throw Error("BACKUP_UPGRADE_REJECTED");
  }
  validateUpgrade(id:string,candidate:UpdateCandidate,bindingRevision:string,installationIdentity:string){
    const s=this.read();if(!["return-pending","install-requested"].includes(s.job?.phase??""))throw Error("BACKUP_UPGRADE_REJECTED");
    this.checkUpgrade(s,id,candidate,bindingRevision,installationIdentity);return this.status();
  }
  requestUpgradeInstall(id:string,candidate:UpdateCandidate,bindingRevision:string,installationIdentity:string){return this.transitionHandoff(id,"return-pending","install-requested",s=>this.checkUpgrade(s,id,candidate,bindingRevision,installationIdentity));}
  completeUpgrade(id:string,currentVersion:string,candidate:UpdateCandidate,bindingRevision:string,installationIdentity:string){return this.transitionHandoff(id,"install-requested","upgrade-complete",s=>{this.checkUpgrade(s,id,candidate,bindingRevision,installationIdentity);if(currentVersion!==candidate.version)throw Error("BACKUP_UPGRADE_VERSION_MISMATCH");});}
  cancelUpgrade(id:string){return this.transitionHandoff(id,"return-pending","upgrade-cancelled",s=>{if(!s.job!.handoff!.upgrade)throw Error("BACKUP_UPGRADE_REJECTED");});}
  prepareHandoff(jobId:string,input:BackupHandoff){const lease=this.lease();try{const s=this.read(),handoff=backupHandoffSchema.parse(input);if(!(s.schedule.enabled||(manualJob(s)&&manualReady(s.schedule)))||s.job?.id!==jobId||s.job.revision!==s.revision||!["due","waiting-idle","waiting-backup-mode"].includes(s.job.phase)||handoff.expiresAt<=this.now()||handoff.expiresAt>this.now()+30*60000)throw new Error("BACKUP_HANDOFF_REJECTED");s.job.phase="handoff-prepared";s.job.handoff=handoff;this.save(s);return this.status();}finally{lease.release();}}
  private transitionHandoff(id:string,from:string,to:z.infer<typeof jobSchema>["phase"],check?:(s:State)=>void){const lease=this.lease();try{const s=this.read();if(s.job?.handoff?.id!==id||s.job.phase!==from)throw new Error("BACKUP_HANDOFF_CHANGED");check?.(s);s.job.phase=to;this.save(s);return this.status();}finally{lease.release();}}
  armHandoff(id:string){return this.transitionHandoff(id,"handoff-prepared","handoff-armed");}
  claimHandoff(id:string,bindingRevision:string,installationIdentity:string){return this.transitionHandoff(id,"handoff-armed","offline-claimed",s=>{if(!(s.schedule.enabled||(manualJob(s)&&manualReady(s.schedule)))||s.job!.revision!==s.revision||s.job!.handoff!.expiresAt<=this.now()||s.job!.handoff!.bindingRevision!==bindingRevision||s.job!.handoff!.installationIdentity!==installationIdentity)throw new Error("BACKUP_HANDOFF_REJECTED");if(s.job!.handoff!.upgrade)this.checkedCandidate(s.job!.handoff!.upgrade);});}
  beginHandoffCapture(id:string){return this.transitionHandoff(id,"offline-claimed","capturing",s=>{s.job!.attemptAt=this.now();});}
  completeHandoff(id:string,input:BackupReceipt){return this.transitionHandoff(id,"capturing","return-pending",s=>{const r=backupReceiptSchema.parse(input),job=s.job!;if(r.jobId!==job.id||r.installationRef!==s.schedule.installationRef||r.destinationRef!==s.schedule.destinationRef||r.selectionHash!==hash(s.schedule.selection)||r.bytes>s.schedule.maxBytes!||r.verifiedAt<job.attemptAt!||r.verifiedAt>this.now()||r.candidateId!==job.handoff?.upgrade?.candidateId||(job.handoff?.upgrade&&r.artifactRef!==job.id))throw new Error("BACKUP_RECEIPT_MISMATCH");job.receipt=r;s.lastVerified=r;});}
  completeReturn(id:string){return this.transitionHandoff(id,"return-pending","returned",s=>{if(s.job!.handoff!.upgrade)throw Error("BACKUP_UPGRADE_PENDING");});}
  failHandoff(id:string){const lease=this.lease();try{const s=this.read();if(s.job?.handoff?.id!==id)throw new Error("BACKUP_HANDOFF_CHANGED");s.job.phase="needs-review";s.job.error="capture-unconfirmed";this.save(s);return this.status();}finally{lease.release();}}
  private async work(upgradeId?:string){
    const lease=this.lease();let claimed:{release:()=>Promise<void>}|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
    const controller=new AbortController();this.controller=controller;
    try{
      const s=this.read();
      if(s.job&&["claiming","capturing","handoff-prepared","offline-claimed"].includes(s.job.phase)){s.job.phase="needs-review";s.job.error="interrupted";this.save(s);return this.status();}
      if(s.job&&["handoff-armed","return-pending","install-requested"].includes(s.job.phase))return this.status();
      // Only the request that created a manual job hands it off; a leftover
      // one is withdrawn rather than run later without the user.
      if(manualJob(s)&&waitingPhases.includes(s.job!.phase)){s.job!.phase="skipped";s.job!.error="cancelled";this.save(s);}
      if(!s.schedule.enabled||s.job?.phase==="needs-review")return this.status();
      let job=s.job;
      if(job&&["due","waiting-idle","waiting-backup-mode"].includes(job.phase)&&job.occurrence.includes(":daily:")){
        const latest=latestBackupOccurrence(s.schedule,this.now());
        if(latest&&latest.at>job.scheduledAt&&!s.seen.includes(`${s.revision}:daily:${latest.day}`))job=undefined;
        else if(this.now()-job.scheduledAt>s.schedule.catchupMs!){job.phase="skipped";job.error="catchup-expired";this.save(s);return this.status();}
      }
      if(!job||job.phase==="local-verified"||job.phase==="skipped"||job.phase==="returned"||job.phase==="upgrade-complete"||job.phase==="upgrade-cancelled"){
        const daily=latestBackupOccurrence(s.schedule,this.now());
        const upgrade=upgradeId&&s.schedule.preUpgrade?backupReferenceSchema.parse(upgradeId):undefined;
        const occurrence=upgrade?`${s.revision}:upgrade:${upgrade}`:daily?`${s.revision}:daily:${daily.day}`:null;
        const at=upgrade?this.now():daily?.at;
        if(!occurrence||at===undefined||at<s.configuredAt||(!upgrade&&at<=s.watermark)||s.seen.includes(occurrence))return this.status();
        job={id:hash([s.schedule.installationRef,occurrence]),occurrence,revision:s.revision,scheduledAt:at,phase:"due"};s.job=job;
        s.seen=[...s.seen,occurrence].slice(-256);if(!upgrade)s.watermark=at;this.save(s);
      }
      if(!this.options.claimIdle||!this.options.captureOffline){job.phase="waiting-backup-mode";this.save(s);return this.status();}
      const request:BackupCaptureRequest={jobId:job.id,installationRef:s.schedule.installationRef!,destinationRef:s.schedule.destinationRef!,recoveryRef:s.schedule.recoveryRef!,selectionHash:hash(s.schedule.selection),selection:s.schedule.selection!,maxBytes:s.schedule.maxBytes!,maxDurationMs:s.schedule.maxDurationMs!};
      job.phase="claiming";job.attemptAt=this.now();this.save(s);
      const claim=await this.options.claimIdle(request,controller.signal);
      if(claim.state!=="claimed"){job.phase=claim.state==="busy"?"waiting-idle":"waiting-backup-mode";this.save(s);return this.status();}
      claimed=claim;
      if(controller.signal.aborted){job.phase="needs-review";job.error="cancelled";this.save(s);return this.status();}
      job.phase="capturing";this.save(s);
      timer=setTimeout(()=>controller.abort("duration-exceeded"),request.maxDurationMs);timer.unref?.();
      const receipt=backupReceiptSchema.parse(await this.options.captureOffline(request,controller.signal));
      if(controller.signal.aborted){job.phase="needs-review";job.error=controller.signal.reason==="duration-exceeded"?"duration-exceeded":"cancelled";this.save(s);return this.status();}
      if(receipt.jobId!==request.jobId||receipt.installationRef!==request.installationRef||receipt.destinationRef!==request.destinationRef||receipt.selectionHash!==request.selectionHash||receipt.bytes>request.maxBytes||receipt.verifiedAt<job.attemptAt!||receipt.verifiedAt>this.now()){
        job.phase="needs-review";job.error="receipt-mismatch";this.save(s);return this.status();
      }
      job.phase="local-verified";job.receipt=receipt;s.lastVerified=receipt;this.save(s);return this.status();
    }catch(error){
      const s=this.read();if(s.job&&["claiming","capturing"].includes(s.job.phase)){s.job.phase="needs-review";s.job.error=controller.signal.aborted?(controller.signal.reason==="duration-exceeded"?"duration-exceeded":"cancelled"):"capture-unconfirmed";this.save(s);return this.status();}throw error;
    }finally{
      if(timer)clearTimeout(timer);
      try{await this.releaseIdle(claimed);}finally{this.controller=undefined;lease.release();}
    }
  }
  /** Cancellation requests do not release executor ownership before callbacks settle. */
  async stop(){this.controller?.abort();await this.running;}
}
