import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { BackupCoordinator, type BackupCaptureRequest } from "./backup-coordinator.ts";
import { backupScheduleSchema, latestBackupOccurrence } from "../shared/backup-schedule.ts";
import { canonicalUpdateDescriptor, type UpdateCandidate } from "../shared/update-candidate.mjs";
import { removeTempDirSync } from "./testing/cleanup.ts";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))removeTempDirSync(root);vi.useRealTimers();});
const choices={enabled:true,installationRef:"installation-one",destinationRef:"destination-one",recoveryRef:"recovery-one",timezone:"Asia/Bangkok",time:"09:00",catchupMs:3*86400000,maxBytes:100000,maxDurationMs:1000,selection:{scope:"application-data" as const,credentialPolicy:"preserve-in-encrypted-fidelity" as const},preUpgrade:false};
const selectionHash=createHash("sha256").update(JSON.stringify(choices.selection)).digest("hex");
function fixture(){const stateDirectory=mkdtempSync(join(tmpdir(),"murage-backup-coordinator-"));roots.push(stateDirectory);let now=Date.parse("2026-09-13T01:00:00Z");
 const receipt=(request:BackupCaptureRequest)=>({jobId:request.jobId,installationRef:request.installationRef,destinationRef:request.destinationRef,selectionHash:request.selectionHash,snapshotId:randomUUID(),artifactRef:"verified-artifact",sha256:"a".repeat(64),bytes:200,verifiedAt:now});
 const captureOffline=vi.fn(async(request:BackupCaptureRequest,_signal:AbortSignal)=>receipt(request));const release=vi.fn(async()=>{});const claimIdle=vi.fn(async()=>({state:"claimed" as const,release}));
 const options={stateDirectory,now:()=>now,captureOffline,claimIdle};const coordinator=new BackupCoordinator(options);
 return {stateDirectory,options,coordinator,captureOffline,claimIdle,release,receipt,setNow:(at:string)=>{now=Date.parse(at);},advance:(ms:number)=>{now+=ms;}};
}
it("restart transfer CAS survives armed handoff but requires exact binding and receipt",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");const due=await c.tick();const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 c.prepareHandoff(due.job!.id,intent);expect(()=>c.armHandoff(randomUUID())).toThrow("CHANGED");c.armHandoff(intent.id);expect((await c.tick()).phase).toBe("handoff-armed");
 expect(()=>c.claimHandoff(intent.id,"d".repeat(64),intent.installationIdentity)).toThrow("REJECTED");c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity);expect(()=>c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity)).toThrow("CHANGED");c.beginHandoffCapture(intent.id);
 const receipt={jobId:due.job!.id,installationRef:choices.installationRef,destinationRef:choices.destinationRef,selectionHash,snapshotId:randomUUID(),artifactRef:due.job!.id,sha256:"a".repeat(64),bytes:200,verifiedAt:f.options.now()};expect(()=>c.completeHandoff(intent.id,{...receipt,jobId:"e".repeat(64)})).toThrow("MISMATCH");c.completeHandoff(intent.id,receipt);expect((await c.tick()).phase).toBe("return-pending");c.completeReturn(intent.id);expect((await c.tick()).phase).toBe("returned");expect(c.status().lastVerified).toEqual(receipt);
});
it("handoff expiry and revision disable reject new worker authority without erasing evidence",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");const due=await c.tick(),intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+1000};c.prepareHandoff(due.job!.id,intent);c.armHandoff(intent.id);f.advance(1001);expect(()=>c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity)).toThrow("REJECTED");expect(()=>c.configure(1,{...choices,destinationRef:"different"})).toThrow("REVIEW");c.configure(1,{...choices,enabled:false});expect(c.status().job?.handoff).toEqual(intent);expect(()=>c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity)).toThrow("REJECTED");
});
it("starts disabled without any invented destination and requires explicit revisioned choices",async()=>{
 const f=fixture();expect(f.coordinator.status()).toMatchObject({enabled:false,revision:0,phase:"idle",schedule:{enabled:false}});await f.coordinator.tick();expect(f.claimIdle).not.toHaveBeenCalled();
 expect(()=>f.coordinator.configure(0,{enabled:true})).toThrow();expect(()=>backupScheduleSchema.parse({...choices,destinationRef:"/private/path"})).toThrow();expect(()=>backupScheduleSchema.parse({...choices,timezone:"Invalid/Zone"})).toThrow();
 f.coordinator.configure(0,choices);expect(()=>f.coordinator.configure(0,choices)).toThrow("BACKUP_SCHEDULE_CHANGED");
});
it("uses selected timezone and coalesces repeated DST hours by day identity",()=>{
 const schedule=backupScheduleSchema.parse({...choices,timezone:"America/New_York",time:"01:30"});
 const first=latestBackupOccurrence(schedule,Date.parse("2026-11-01T05:40:00Z"))!,second=latestBackupOccurrence(schedule,Date.parse("2026-11-01T06:40:00Z"))!;
 expect(first.day).toBe(second.day);expect(second.at-first.at).toBe(3600000);
 expect(latestBackupOccurrence(backupScheduleSchema.parse(choices),Date.parse("2026-09-13T02:01:00Z"))?.at).toBe(Date.parse("2026-09-13T02:00:00Z"));
});
it("records one identity-bound verified capture and never repeats its occurrence",async()=>{
 const f=fixture();f.coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");const completed=await f.coordinator.tick();expect(completed.phase).toBe("local-verified");expect(completed.lastVerified).toMatchObject({installationRef:choices.installationRef,destinationRef:choices.destinationRef,sha256:"a".repeat(64)});
 await f.coordinator.tick();await new BackupCoordinator(f.options).tick();expect(f.captureOffline).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledTimes(1);
});
it("without real lifecycle hooks truthfully waits for Backup mode",async()=>{
 const f=fixture(),coordinator=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");expect(await coordinator.tick()).toMatchObject({phase:"waiting-backup-mode",message:"Due, waiting for Backup mode"});expect(f.captureOffline).not.toHaveBeenCalled();
});
it("busy defers without stopping work and coalesces missed days to one latest job",async()=>{
 const f=fixture();f.coordinator.configure(0,choices);f.claimIdle.mockResolvedValueOnce({state:"busy"} as never);f.setNow("2026-09-13T03:00:00Z");const first=await f.coordinator.tick();expect(first.phase).toBe("waiting-idle");expect(f.captureOffline).not.toHaveBeenCalled();f.setNow("2026-09-16T03:00:00Z");const next=await f.coordinator.tick();expect(next.job?.scheduledAt).toBe(Date.parse("2026-09-16T02:00:00Z"));expect(next.job?.id).not.toBe(first.job?.id);expect(f.captureOffline).toHaveBeenCalledTimes(1);
});
it("expired catchup does not capture an old deferred occurrence",async()=>{
 const f=fixture();f.coordinator.configure(0,{...choices,catchupMs:3600000});f.claimIdle.mockResolvedValueOnce({state:"busy"} as never);f.setNow("2026-09-13T02:30:00Z");await f.coordinator.tick();f.setNow("2026-09-13T04:00:00Z");expect((await f.coordinator.tick()).phase).toBe("skipped");expect(f.captureOffline).not.toHaveBeenCalled();
});
it("one executor lease blocks another coordinator while capturing",async()=>{
 const f=fixture();f.coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");let finish!:(value:any)=>void;let request!:BackupCaptureRequest;
 f.captureOffline.mockImplementationOnce(async input=>{request=input;return new Promise(resolve=>{finish=resolve;});});const running=f.coordinator.tick();await vi.waitFor(()=>expect(f.captureOffline).toHaveBeenCalled());
 await expect(new BackupCoordinator(f.options).tick()).rejects.toThrow("BACKUP_COORDINATOR_BUSY");expect(f.coordinator.tick()).toBe(running);finish(f.receipt(request));await running;
});
it("persisted interrupted capture needs review and cannot be erased by re-enabling",async()=>{
 const f=fixture();f.coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");await f.coordinator.tick();const path=join(f.stateDirectory,"backup-coordinator.json"),state=JSON.parse(readFileSync(path,"utf8"));state.job.phase="capturing";delete state.job.receipt;writeFileSync(path,JSON.stringify(state));
 const restarted=new BackupCoordinator(f.options);expect(await restarted.tick()).toMatchObject({phase:"needs-review",job:{error:"interrupted"}});await restarted.tick();expect(f.captureOffline).toHaveBeenCalledTimes(1);expect(()=>restarted.configure(1,choices)).toThrow("BACKUP_REVIEW_REQUIRED");expect(()=>restarted.configure(1,{...choices,enabled:false,destinationRef:"different"})).toThrow("BACKUP_REVIEW_REQUIRED");expect(restarted.configure(1,{...choices,enabled:false})).toMatchObject({enabled:false,phase:"needs-review",schedule:{destinationRef:choices.destinationRef}});
});
it("rejects mismatched receipt and keeps unknown capture from auto replay",async()=>{
 const f=fixture();f.coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");f.captureOffline.mockImplementationOnce(async request=>({...f.receipt(request),destinationRef:"other"}));expect(await f.coordinator.tick()).toMatchObject({phase:"needs-review",job:{error:"receipt-mismatch"}});await f.coordinator.tick();expect(f.captureOffline).toHaveBeenCalledTimes(1);
});
it("pre-upgrade is opt-in and dedupes the exact upgrade identity",async()=>{
 const f=fixture();f.coordinator.configure(0,{...choices,preUpgrade:true});await f.coordinator.tick("upgrade-one");await f.coordinator.tick("upgrade-one");expect(f.captureOffline).toHaveBeenCalledTimes(1);expect(f.coordinator.status().job?.occurrence).toContain("upgrade:upgrade-one");
});
it("capture failure preserves prior verified receipt and never triggers pruning",async()=>{
 const f=fixture();f.coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");const prior=(await f.coordinator.tick()).lastVerified;f.setNow("2026-09-14T03:00:00Z");f.captureOffline.mockRejectedValueOnce(new Error("private internal diagnostic"));expect(await f.coordinator.tick()).toMatchObject({phase:"needs-review",lastVerified:prior,job:{error:"capture-unconfirmed"}});expect(JSON.stringify(f.coordinator.status())).not.toContain("private internal");
});
it("stop requests cancellation but retains ownership until capture callback settles",async()=>{
 const f=fixture();f.coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");let finish!:(value:any)=>void;let request!:BackupCaptureRequest;f.captureOffline.mockImplementationOnce(async input=>{request=input;return new Promise(resolve=>{finish=resolve;});});const running=f.coordinator.tick();await vi.waitFor(()=>expect(f.captureOffline).toHaveBeenCalled());const stopping=f.coordinator.stop();await expect(new BackupCoordinator(f.options).tick()).rejects.toThrow("BACKUP_COORDINATOR_BUSY");finish(f.receipt(request));await stopping;expect((await running).phase).toBe("needs-review");
});
it("failed idle release preserves verified evidence but blocks another capture",async()=>{
 const f=fixture();f.coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");f.release.mockRejectedValueOnce(new Error("unconfirmed release"));await expect(f.coordinator.tick()).rejects.toThrow("BACKUP_IDLE_RELEASE_UNCONFIRMED");expect(f.coordinator.status()).toMatchObject({phase:"needs-review",lastVerified:{artifactRef:"verified-artifact"},job:{error:"idle-release-unconfirmed"}});await f.coordinator.tick();expect(f.captureOffline).toHaveBeenCalledTimes(1);
});
it("duration cancellation remains unconfirmed until its capture callback settles",async()=>{
 vi.useFakeTimers();const f=fixture();f.coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");f.captureOffline.mockImplementationOnce(async(_request,signal)=>new Promise((_resolve,reject)=>{signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true});}));const running=f.coordinator.tick();await Promise.resolve();await vi.advanceTimersByTimeAsync(1001);expect(await running).toMatchObject({phase:"needs-review",job:{error:"duration-exceeded"}});expect(f.release).toHaveBeenCalledTimes(1);
});
function candidate():UpdateCandidate {
 const sha512=Buffer.alloc(64,1).toString("base64");const c:UpdateCandidate={schemaVersion:1,candidateId:"update-"+"0".repeat(64),version:"9.0.0",platform:"darwin",arch:"arm64",artifacts:[{kind:"primary",sha512}],manifestDigests:[sha512]};
 return {...c,candidateId:"update-"+createHash("sha256").update(canonicalUpdateDescriptor(c)).digest("hex")};
}
it("dedicated upgrade admission rejects daily jobs and forged identity before persistence",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,{...choices,preUpgrade:true});
 const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 expect(()=>c.prepareUpgrade({...candidate(),candidateId:"update-"+"0".repeat(64)},intent)).toThrow("CANDIDATE_INVALID");expect(c.status().job).toBeUndefined();
 f.setNow("2026-09-13T03:00:00Z");const daily=await c.tick();expect(daily.phase).toBe("waiting-backup-mode");
 expect(()=>c.prepareUpgrade(candidate(),{...intent,expiresAt:f.options.now()+60000})).toThrow("REVIEW_REQUIRED");expect(c.status().job!.id).toBe(daily.job!.id);
});
it("upgrade receipt candidate and durable CAS are mandatory across coordinator instances",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,{...choices,preUpgrade:true});const update=candidate();
 const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 const prepared=c.prepareUpgrade(update,intent),jobId=prepared.job!.id;c.armHandoff(intent.id);c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity);c.beginHandoffCapture(intent.id);
 const receipt={jobId,installationRef:choices.installationRef,destinationRef:choices.destinationRef,selectionHash,snapshotId:randomUUID(),artifactRef:jobId,sha256:"a".repeat(64),bytes:200,verifiedAt:f.options.now()};
 expect(()=>c.completeHandoff(intent.id,receipt)).toThrow("MISMATCH");c.completeHandoff(intent.id,{...receipt,candidateId:update.candidateId});expect(()=>c.completeReturn(intent.id)).toThrow("UPGRADE_PENDING");
 const next=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});
 expect(()=>next.requestUpgradeInstall(intent.id,update,"d".repeat(64),intent.installationIdentity)).toThrow("REJECTED");
 next.requestUpgradeInstall(intent.id,update,intent.bindingRevision,intent.installationIdentity);expect((await next.tick()).phase).toBe("install-requested");
 expect(()=>c.requestUpgradeInstall(intent.id,update,intent.bindingRevision,intent.installationIdentity)).toThrow("CHANGED");expect(()=>c.cancelUpgrade(intent.id)).toThrow("CHANGED");
 expect(()=>next.completeUpgrade(intent.id,"8.0.0",update,intent.bindingRevision,intent.installationIdentity)).toThrow("VERSION_MISMATCH");
 next.completeUpgrade(intent.id,update.version,update,intent.bindingRevision,intent.installationIdentity);expect(next.status().phase).toBe("upgrade-complete");
});
it("persisted upgrade candidate hash mismatch refuses offline authority before capture",()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,{...choices,preUpgrade:true});
 const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};c.prepareUpgrade(candidate(),intent);c.armHandoff(intent.id);
 const file=join(f.stateDirectory,"backup-coordinator.json"),state=JSON.parse(readFileSync(file,"utf8"));state.job.handoff.upgrade.version="9.0.1";writeFileSync(file,JSON.stringify(state));
 const restarted=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});expect(()=>restarted.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity)).toThrow("CANDIDATE_INVALID");expect(restarted.status().phase).toBe("handoff-armed");expect(f.captureOffline).not.toHaveBeenCalled();
});
it("closed eligibility is read-only, legacy-disabled, and shares daily catchup identity",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});
 c.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");expect(c.closedEligibility()).toEqual({status:"disabled"});
 c.configure(1,{...choices,closedApp:true});expect(c.closedEligibility()).toEqual({status:"not-due"});
 f.setNow("2026-09-14T03:00:00Z");const file=join(f.stateDirectory,"backup-coordinator.json"),before=readFileSync(file,"utf8");
 expect(c.closedEligibility()).toEqual({status:"due"});expect(readFileSync(file,"utf8")).toBe(before);expect(f.captureOffline).not.toHaveBeenCalled();
 const due=await c.tick();expect(due.phase).toBe("waiting-backup-mode");expect(c.closedEligibility()).toEqual({status:"due"});
 f.advance(choices.catchupMs+1);expect(c.closedEligibility()).toEqual({status:"due"}); // latest eligible daily occurrence replaces old wait
});
it("closed eligibility holds pending upgrades and preserves durable bounded outcomes",()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,{...choices,preUpgrade:true,closedApp:true});
 const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 c.prepareUpgrade(candidate(),intent);expect(c.closedEligibility()).toEqual({status:"needs-review"});
 const result=c.recordClosedResult({status:"needs-review",reason:"pending-work"});
 expect(new BackupCoordinator({stateDirectory:f.stateDirectory}).status().lastClosedResult).toEqual(result);
 expect(()=>c.recordClosedResult({status:"unavailable",reason:"raw private path"} as never)).toThrow();
 expect(c.status().lastClosedResult).toEqual(result);expect(c.status().phase).toBe("handoff-prepared");
});
it("a manual request needs the current revision and a complete schedule, and runs once through the handoff",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});
 expect(()=>c.requestManual(0,"manual-one")).toThrow("BACKUP_SCHEDULE_CONSENT_REQUIRED");
 c.configure(0,{enabled:false,installationRef:"installation-one"});expect(()=>c.requestManual(1,"manual-one")).toThrow("BACKUP_SCHEDULE_CONSENT_REQUIRED");
 c.configure(1,{...choices,enabled:false});expect(()=>c.requestManual(1,"manual-one")).toThrow("BACKUP_SCHEDULE_CHANGED");expect(()=>c.requestManual(2,"/not/a/reference")).toThrow("BACKUP_HANDOFF_REJECTED");
 const due=c.requestManual(2,"manual-one");expect(due).toMatchObject({enabled:false,phase:"due",job:{occurrence:"2:manual:manual-one",revision:2}});
 const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 c.prepareHandoff(due.job!.id,intent);c.armHandoff(intent.id);c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity);c.beginHandoffCapture(intent.id);
 const receipt={jobId:due.job!.id,installationRef:choices.installationRef,destinationRef:choices.destinationRef,selectionHash,snapshotId:randomUUID(),artifactRef:due.job!.id,sha256:"a".repeat(64),bytes:200,verifiedAt:f.options.now()};
 c.completeHandoff(intent.id,receipt);c.completeReturn(intent.id);expect(c.status()).toMatchObject({phase:"returned",lastVerified:receipt});
 expect(()=>c.requestManual(2,"manual-one")).toThrow("BACKUP_HANDOFF_CHANGED");
});
it("a manual request never starts unattended and never duplicates a waiting daily job",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,{...choices,closedApp:true});
 const manual=c.requestManual(1,"manual-two");expect(manual.phase).toBe("due");expect(c.closedEligibility().status).toBe("not-due");
 // An abandoned manual request is not work the daily tick may pick up.
 expect((await f.coordinator.tick()).phase).toBe("skipped");expect(f.claimIdle).not.toHaveBeenCalled();
 f.setNow("2026-09-13T03:00:00Z");const daily=await c.tick();expect(daily.phase).toBe("waiting-backup-mode");expect(daily.job!.occurrence).toContain(":daily:");
 const again=c.requestManual(1,"manual-three");expect(again.job!.id).toBe(daily.job!.id);expect(again.job!.occurrence).toContain(":daily:");
 const armed={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 c.prepareHandoff(daily.job!.id,armed);expect(()=>c.requestManual(1,"manual-four")).toThrow("BACKUP_REVIEW_REQUIRED");c.armHandoff(armed.id);expect(()=>c.requestManual(1,"manual-four")).toThrow("BACKUP_BUSY");
});
it("a disabled schedule admits only the manual job it created to the handoff",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");const daily=await c.tick();
 c.configure(1,{...choices,enabled:false});const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 const file=join(f.stateDirectory,"backup-coordinator.json"),saved=JSON.parse(readFileSync(file,"utf8"));saved.job={...daily.job,revision:2};writeFileSync(file,JSON.stringify(saved));
 expect(()=>c.prepareHandoff(daily.job!.id,intent)).toThrow("BACKUP_HANDOFF_REJECTED");
 const manual=c.requestManual(2,"manual-five");expect(manual.job!.occurrence).toBe("2:manual:manual-five");c.prepareHandoff(manual.job!.id,intent);c.armHandoff(intent.id);
 const armed=JSON.parse(readFileSync(file,"utf8"));armed.schedule={enabled:false,installationRef:"installation-one"};writeFileSync(file,JSON.stringify(armed));
 expect(()=>c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity)).toThrow("BACKUP_HANDOFF_REJECTED");
});
it("a backup that stopped unconfirmed can be cleared by the person, and only then runs again",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,choices);
 const manual=c.requestManual(1,"manual-one");const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 c.prepareHandoff(manual.job!.id,intent);c.armHandoff(intent.id);
 expect(c.failHandoff(intent.id)).toMatchObject({phase:"needs-review",reviewReason:"capture-unconfirmed"});
 // Stuck: nothing else may start or change the schedule while it waits for review.
 expect(()=>c.requestManual(1,"manual-two")).toThrow("BACKUP_REVIEW_REQUIRED");
 expect(()=>c.configure(1,choices)).toThrow("BACKUP_REVIEW_REQUIRED");
 expect(()=>c.clearReview(0)).toThrow("BACKUP_SCHEDULE_CHANGED");
 const cleared=c.clearReview(1);expect(cleared).toMatchObject({phase:"idle"});expect(cleared.reviewReason).toBeUndefined();
 expect(()=>c.clearReview(1)).toThrow("BACKUP_HANDOFF_CHANGED");
 // The stopped run is not repeated; a new request is a fresh job.
 expect(()=>c.requestManual(1,"manual-one")).toThrow("BACKUP_HANDOFF_CHANGED");
 expect(c.requestManual(1,"manual-two")).toMatchObject({phase:"due",job:{occurrence:"1:manual:manual-two"}});
});
// Settings L5: a receipt proves a backup of one folder with one key. Pointing
// the schedule at a new folder or key starts it unverified; turning backups
// off keeps the same refs, and the receipt with them.
it("a reconfigured folder or key never inherits the old receipt",async()=>{
 const f=fixture();f.coordinator.configure(0,choices);f.setNow("2026-09-13T03:00:00Z");
 const done=await f.coordinator.tick();expect(done.lastVerified).toBeDefined();
 const off=f.coordinator.configure(done.revision,{...choices,enabled:false});expect(off.lastVerified).toEqual(done.lastVerified);
 const moved=f.coordinator.configure(off.revision,{...choices,destinationRef:"destination-two",recoveryRef:"recovery-two"});expect(moved.lastVerified).toBeUndefined();
 const f2=fixture();f2.coordinator.configure(0,choices);f2.setNow("2026-09-13T03:00:00Z");const d2=await f2.coordinator.tick();
 expect(f2.coordinator.configure(d2.revision,{...choices,recoveryRef:"recovery-two"}).lastVerified).toBeUndefined();
});
it("the first run's ending is recorded once and stands",()=>{
 const f=fixture();expect(f.coordinator.firstRunRecord()).toBeUndefined();
 expect(f.coordinator.recordFirstRun({state:"off"})).toMatchObject({version:1,state:"off"});
 expect(f.coordinator.recordFirstRun({state:"verified",jobId:"a".repeat(64),sha256:"b".repeat(64),installationRef:"installation-one",destinationRef:"destination-one",recoveryRef:"recovery-one"}).state).toBe("off");
 writeFileSync(join(f.stateDirectory,"backup-first-run.json"),"{");expect(()=>f.coordinator.firstRunRecord()).toThrow("BACKUP_FIRST_RUN_STATE_INVALID");
});

it("a stalled install is abandoned only from install-requested, only while the old version runs, and keeps its receipt",async()=>{
 const f=fixture(),c=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});c.configure(0,{...choices,preUpgrade:true});const update=candidate();
 const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 const jobId=c.prepareUpgrade(update,intent).job!.id;c.armHandoff(intent.id);c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity);c.beginHandoffCapture(intent.id);
 c.completeHandoff(intent.id,{jobId,installationRef:choices.installationRef,destinationRef:choices.destinationRef,selectionHash,snapshotId:randomUUID(),artifactRef:jobId,sha256:"a".repeat(64),bytes:200,verifiedAt:f.options.now(),candidateId:update.candidateId});
 expect(()=>c.abandonUpgradeInstall(intent.id,"8.0.0")).toThrow("CHANGED");expect(c.status().phase).toBe("return-pending");
 c.requestUpgradeInstall(intent.id,update,intent.bindingRevision,intent.installationIdentity);const receipt=c.status().job!.receipt;
 expect(()=>c.cancelUpgrade(intent.id)).toThrow("CHANGED");
 expect(()=>c.abandonUpgradeInstall(randomUUID(),"8.0.0")).toThrow("CHANGED");
 expect(()=>c.abandonUpgradeInstall(intent.id,update.version)).toThrow("BACKUP_UPGRADE_INSTALLED");expect(c.status().phase).toBe("install-requested");
 const held=(c as unknown as {lease:()=>{release:()=>void}}).lease();
 try{expect(()=>new BackupCoordinator({stateDirectory:f.stateDirectory}).abandonUpgradeInstall(intent.id,"8.0.0")).toThrow("BACKUP_COORDINATOR_BUSY");}finally{held.release();}
 const next=new BackupCoordinator({stateDirectory:f.stateDirectory,now:f.options.now});next.abandonUpgradeInstall(intent.id,"8.0.0");
 expect(next.status().phase).toBe("upgrade-cancelled");expect(next.status().job!.receipt).toEqual(receipt);
 expect(()=>next.abandonUpgradeInstall(intent.id,"8.0.0")).toThrow("CHANGED");
 expect(()=>next.completeUpgrade(intent.id,update.version,update,intent.bindingRevision,intent.installationIdentity)).toThrow("CHANGED");
});

function requestedFixture(){
 const f=fixture(),c=f.coordinator,update=candidate();c.configure(0,{...choices,preUpgrade:true});
 const admit=()=>{const intent={version:1 as const,id:randomUUID(),bindingRevision:"b".repeat(64),installationIdentity:"c".repeat(64),expiresAt:f.options.now()+60000};
 const jobId=c.prepareUpgrade(update,intent).job!.id;c.armHandoff(intent.id);c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity);c.beginHandoffCapture(intent.id);
 c.completeHandoff(intent.id,{jobId,installationRef:choices.installationRef,destinationRef:choices.destinationRef,selectionHash,snapshotId:randomUUID(),artifactRef:jobId,sha256:"a".repeat(64),bytes:200,verifiedAt:f.options.now(),candidateId:update.candidateId});
 c.requestUpgradeInstall(intent.id,update,intent.bindingRevision,intent.installationIdentity);return intent;};
 return {...f,c,update,admit,intent:admit(),file:join(f.stateDirectory,"backup-coordinator.json")};
}
it("request persists offer and hop budget in the same committed state",()=>{
 const f=requestedFixture(),s=JSON.parse(readFileSync(f.file,"utf8"));
 expect(s.job.phase).toBe("install-requested");expect(s.installerOffer).toMatchObject({handoffId:f.intent.id,candidateId:f.update.candidateId,version:f.update.version});
 expect(s.landedHops[f.update.candidateId]).toEqual({version:f.update.version,automaticSpent:false,explicitCount:0,explicitActionIds:[]});
 expect(f.c.spendLandedHop(f.intent.id,f.update.candidateId,"automatic")).toBe(true);
 const fresh=new BackupCoordinator(f.options);expect(fresh.spendLandedHop(f.intent.id,f.update.candidateId,"automatic")).toBe(false);
 const action=randomUUID();expect(fresh.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",action)).toBe(true);
 expect(new BackupCoordinator(f.options).spendLandedHop(f.intent.id,f.update.candidateId,"explicit",action)).toBe(false);
 const offer=fresh.peekInstallerOffer()!;expect(fresh.acknowledgeInstallerOffer({...offer,at:offer.at+1})).toBe(false);
 expect(fresh.acknowledgeInstallerOffer(offer)).toBe(true);expect(fresh.status().landedHops![f.update.candidateId].automaticSpent).toBe(true);
});
it.each(["hops","offer","both"])("invalid %s preserves core and pauses without mutation",kind=>{
 const f=requestedFixture(),raw=JSON.parse(readFileSync(f.file,"utf8"));
 if(kind!=="offer")raw.landedHops[f.update.candidateId].explicitCount=-1;
 if(kind!=="hops")raw.installerOffer.at=-1;
 writeFileSync(f.file,JSON.stringify(raw));const before=readFileSync(f.file,"utf8");
 for(let restart=0;restart<2;restart++){
 const c=new BackupCoordinator(f.options),status=c.status();expect(status.job).toEqual(raw.job);expect(status.lastVerified).toEqual(raw.lastVerified);expect(status.schedule).toEqual(raw.schedule);
 expect(status.hopsInvalid).toBe(kind!=="offer"?true:undefined);expect(status.offerInvalid).toBe(kind!=="hops"?true:undefined);
 expect(status.installerOffer).toEqual(kind==="hops"?raw.installerOffer:undefined);expect(status.landedHops).toEqual(kind==="offer"?raw.landedHops:undefined);
 for(const operation of [()=>c.configure(1,{...choices,preUpgrade:true,enabled:false}),()=>c.acknowledgeInstallerOffer(raw.installerOffer),()=>c.ensureRequestedInstallMetadata(f.intent.id,f.update.candidateId),()=>c.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",randomUUID()),()=>c.abandonUpgradeInstall(f.intent.id,"8.0.0"),()=>c.completeUpgrade(f.intent.id,f.update.version,f.update,f.intent.bindingRevision,f.intent.installationIdentity)])expect(operation).toThrow("REVIEW_REQUIRED");
 expect(readFileSync(f.file,"utf8")).toBe(before);
 }
});
it("legacy absence initializes conservatively while invalid core and JSON still throw",()=>{
 const f=requestedFixture(),raw=JSON.parse(readFileSync(f.file,"utf8"));delete raw.installerOffer;delete raw.landedHops;writeFileSync(f.file,JSON.stringify(raw));
 f.c.ensureRequestedInstallMetadata(f.intent.id,f.update.candidateId);expect(f.c.status().landedHops![f.update.candidateId]).toEqual({version:f.update.version,automaticSpent:true,explicitCount:0,explicitActionIds:[]});
 expect(f.c.spendLandedHop(f.intent.id,f.update.candidateId,"automatic")).toBe(false);expect(f.c.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",randomUUID())).toBe(true);
 writeFileSync(f.file,JSON.stringify({...raw,revision:-1}));expect(()=>f.c.status()).toThrow("STATE_INVALID");writeFileSync(f.file,"{");expect(()=>f.c.status()).toThrow("STATE_INVALID");
});
it("verified completion starts a fresh hop lifecycle on later admission",()=>{
 const f=requestedFixture();f.c.spendLandedHop(f.intent.id,f.update.candidateId,"automatic");f.c.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",randomUUID());
 const before=readFileSync(f.file,"utf8");expect(()=>f.c.completeUpgrade(f.intent.id,"8.0.0",f.update,f.intent.bindingRevision,f.intent.installationIdentity)).toThrow("VERSION_MISMATCH");expect(readFileSync(f.file,"utf8")).toBe(before);
 f.c.completeUpgrade(f.intent.id,f.update.version,f.update,f.intent.bindingRevision,f.intent.installationIdentity);
 expect(new BackupCoordinator(f.options).status()).toMatchObject({phase:"upgrade-complete",landedHops:{}});
 expect(f.c.status().landedHops![f.update.candidateId]).toBeUndefined();const next=f.admit();
 expect(f.c.status().landedHops![f.update.candidateId]).toEqual({version:f.update.version,automaticSpent:false,explicitCount:0,explicitActionIds:[]});
 expect(f.c.spendLandedHop(next.id,f.update.candidateId,"automatic")).toBe(true);expect(new BackupCoordinator(f.options).spendLandedHop(next.id,f.update.candidateId,"automatic")).toBe(false);
});
it("no-claim work releases its lease before any microtask",async()=>{
 const f=fixture(),release=vi.fn(),c=new BackupCoordinator({...f.options,acquire:()=>({release})});
 const done=c.tick();expect(release).toHaveBeenCalledTimes(1);expect(f.release).not.toHaveBeenCalled();await done;
});
it("a trusted explicit action cannot spend twice after a different action and restart",()=>{
 const f=requestedFixture(),first=randomUUID(),second=randomUUID();
 expect(f.c.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",first)).toBe(true);
 expect(f.c.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",second)).toBe(true);
 const restarted=new BackupCoordinator(f.options),before=readFileSync(f.file,"utf8");
 expect(restarted.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",first)).toBe(false);
 expect(restarted.status().landedHops![f.update.candidateId].explicitCount).toBe(2);
 expect(readFileSync(f.file,"utf8")).toBe(before);
});

it("ADDENDUM-1 refuses mismatched history and size exhaustion without changing bytes",()=>{
 const f=requestedFixture(),raw=JSON.parse(readFileSync(f.file,"utf8")),hop=raw.landedHops[f.update.candidateId];
 hop.explicitCount=1;writeFileSync(f.file,JSON.stringify(raw));
 expect(new BackupCoordinator(f.options).status().hopsInvalid).toBe(true);
 const invalid=readFileSync(f.file,"utf8");expect(()=>f.c.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",randomUUID())).toThrow("REVIEW_REQUIRED");expect(readFileSync(f.file,"utf8")).toBe(invalid);
 hop.explicitCount=0;
 while(Buffer.byteLength(JSON.stringify(raw))+39<=128*1024){hop.explicitActionIds.push(randomUUID());hop.explicitCount++;}
 writeFileSync(f.file,JSON.stringify(raw));const before=readFileSync(f.file,"utf8");
 expect(f.c.status().hopsInvalid).toBeUndefined();
 expect(()=>f.c.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",randomUUID())).toThrow("REVIEW_REQUIRED");
 expect(readFileSync(f.file,"utf8")).toBe(before);
});

it("T6d process crash after durable spend cannot restore automatic allowance",async()=>{
 const {spawnSync}=await import("node:child_process");const {pathToFileURL}=await import("node:url");
 const f=requestedFixture();
 const code=`import {BackupCoordinator} from ${JSON.stringify(pathToFileURL(join(process.cwd(),"server/backup-coordinator.ts")).href)};const c=new BackupCoordinator(${JSON.stringify({stateDirectory:f.stateDirectory})});if(!c.spendLandedHop(${JSON.stringify(f.intent.id)},${JSON.stringify(f.update.candidateId)},"automatic"))process.exit(2);process.exit(0);`;
 const child=spawnSync(process.execPath,["--input-type=module","-e",code],{encoding:"utf8"});expect(child.status,child.stderr).toBe(0);
 expect(new BackupCoordinator(f.options).spendLandedHop(f.intent.id,f.update.candidateId,"automatic")).toBe(false);
});
it("T6b unresolved budget survives configure, cancellation and same-candidate readmission",()=>{
 const f=requestedFixture();f.c.spendLandedHop(f.intent.id,f.update.candidateId,"automatic");f.c.spendLandedHop(f.intent.id,f.update.candidateId,"explicit",randomUUID());
 const hop=f.c.status().landedHops![f.update.candidateId],offer=f.c.peekInstallerOffer();
 f.c.abandonUpgradeInstall(f.intent.id,"8.0.0");
 f.c.configure(f.c.status().revision,{...choices,preUpgrade:true,enabled:false});
 expect(f.c.status().landedHops![f.update.candidateId]).toEqual(hop);expect(f.c.peekInstallerOffer()).toEqual(offer);
 f.c.configure(f.c.status().revision,{...choices,preUpgrade:true});const next=f.admit();
 expect(f.c.status().landedHops![f.update.candidateId]).toEqual(hop);expect(f.c.spendLandedHop(next.id,f.update.candidateId,"automatic")).toBe(false);
});

import {atomicWriteCount, syncParentDirectory} from './atomic.ts';
import * as atomic from './atomic.ts';
import {mkdirSync, symlinkSync, rmSync} from 'node:fs';
import {backupOutcome} from './health/backup-status.ts';
const busyWait={cause:'busy' as const,code:'BACKUP_FILE_IN_USE',drive:null};
const spaceWait={cause:'space' as const,code:'BACKUP_DISK_FULL',drive:'backup' as const};
function waitFixture(enabled=false){
 const f=fixture();const options={stateDirectory:f.stateDirectory,now:f.options.now};
 const c=new BackupCoordinator(options);c.configure(0,{...choices,enabled,closedApp:true});
 c.requestManual(1,randomUUID());
 const intent=()=>({version:1 as const,id:randomUUID(),bindingRevision:'b'.repeat(64),installationIdentity:'c'.repeat(64),expiresAt:f.options.now()+60000});
 const room={destinationRef:choices.destinationRef,at:f.options.now(),layout:'split' as const,mode:'pinned' as const,floors:{backup:500}};
 const file=join(f.stateDirectory,'backup-coordinator.json'),side=join(f.stateDirectory,'backup-wait.json');
 return {...f,options,c,intent,room,file,side,fresh:()=>new BackupCoordinator(options)};
}
it.each(['handoff-prepared','offline-claimed','capturing'] as const)('merged interruptIncomplete preserves an applicable wait over torn %s',phase=>{
 const f=waitFixture(),intent=f.intent();
 f.c.prepareHandoff(f.c.status().job!.id,intent);
 const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.job.phase=phase;writeFileSync(f.file,JSON.stringify(raw));
 const crash=new BackupCoordinator({...f.options,onSideWritten(){throw Error('simulated death');}});
 expect(()=>crash.waitHandoff(raw.job.id,spaceWait,f.room)).toThrow('simulated death');
 const before=readFileSync(f.file,'utf8'),side=readFileSync(f.side,'utf8');
 expect(f.fresh().interruptIncomplete().phase).toBe('waiting');
 expect(readFileSync(f.file,'utf8')).toBe(before);expect(readFileSync(f.side,'utf8')).toBe(side);
 expect(f.fresh().reconcileStartup()).toMatchObject({blocked:false,phase:'waiting'});
 expect(f.fresh().status().waiting).toMatchObject({jobId:raw.job.id,cause:'space'});
});
it('T-backoff T-delay-contract: history survives fresh retry IDs without room and duplicate stops are idempotent',()=>{
 const f=waitFixture();let c=f.c;const since=f.options.now();
 c.waitJob(c.status().job!.id,busyWait);expect(c.status().waiting).toMatchObject({since,attempts:0,nextAt:since+900000});
 for(const stops of [1,2,3]){
  const old=c.status().job!.id,intent=f.intent();const ready=c.prepareHandoff(old,intent);
  expect(ready.job!.id).not.toBe(old);expect(ready.job!.occurrence).toMatch(new RegExp(`:retry:${stops}$`));
  c=f.fresh();c.armHandoff(intent.id);c.claimHandoff(intent.id,intent.bindingRevision,intent.installationIdentity);c.beginHandoffCapture(intent.id);
  f.advance(1000);const id=c.status().job!.id;c.waitHandoff(id,busyWait);
  const saved=readFileSync(f.side,'utf8');c.waitHandoff(id,busyWait);
  expect(readFileSync(f.side,'utf8')).toBe(saved);
  expect(c.status().waiting).toMatchObject({since,attempts:stops,nextAt:f.options.now()+(stops===1?900000:3600000)});
  expect(JSON.parse(saved).room).toBeUndefined();c=f.fresh();
 }
});
it.each(['due','waiting-idle','waiting-backup-mode'] as const)('T-torn-prerun T-tear: %s side commit survives before main settle',phase=>{
 const f=waitFixture();const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.job.phase=phase;writeFileSync(f.file,JSON.stringify(raw));
 const crash=new BackupCoordinator({...f.options,onSideWritten(){throw Error('simulated death');}});
 expect(()=>crash.waitJob(raw.job.id,spaceWait)).toThrow('simulated death');
 expect(JSON.parse(readFileSync(f.file,'utf8')).job.phase).toBe(phase);
 const fresh=f.fresh();expect(fresh.status().phase).toBe('waiting');
 const before=readFileSync(f.side,'utf8');expect(fresh.reconcileStartup()).toMatchObject({phase:'waiting',blocked:false});
 expect(readFileSync(f.side,'utf8')).toBe(before);expect(fresh.committedState().job).toMatchObject({phase:'skipped',error:'catchup-expired'});
 expect(backupOutcome(fresh.committedState())).toEqual({result:'failed',code:'deadline-passed'});
 raw.job.phase='needs-review';writeFileSync(f.file,JSON.stringify(raw));expect(fresh.status().phase).toBe('needs-review');
 raw.job.phase=phase;raw.revision++;writeFileSync(f.file,JSON.stringify(raw));expect(fresh.status().phase).toBe(phase);
});
it('T-raw-state T-cadence-open: unchanged polls freeze deadlines and closed result persists strictly',async()=>{
 const f=waitFixture();const published:unknown[]=[];const c=new BackupCoordinator({...f.options,onCommitted:s=>published.push(s)});
 c.waitJob(c.status().job!.id,spaceWait);const start=c.status().waiting,side=readFileSync(f.side,'utf8'),writes=atomicWriteCount(f.side);
 for(let minute=0;minute<180;minute++){f.advance(60000);await c.tick();c.waitJob(c.status().job!.id,spaceWait);}
 expect(c.status().waiting).toEqual(start);expect(readFileSync(f.side,'utf8')).toBe(side);expect(atomicWriteCount(f.side)).toBe(writes);
 c.recordClosedResult({status:'not-due'});expect(f.fresh().committedState().lastClosedResult?.status).toBe('not-due');
 for(const state of published){expect(JSON.stringify(state)).not.toMatch(/"waiting"|"history"|"room"/);}
 c.waitJob(c.status().job!.id,{cause:'drive',code:'BACKUP_FOLDER_MISSING',drive:'backup'});
 expect(c.status().waiting).toMatchObject({since:start!.since,nextAt:start!.nextAt,attempts:0,cause:'drive'});
});
it.each([0,1,2,3])('T-closed-cadence T-delay-contract: claim at %i stops renews once, across processes',stops=>{
 const f=waitFixture();let c=f.c;c.waitJob(c.status().job!.id,busyWait);
 for(let n=0;n<stops;n++){const i=f.intent();c.prepareHandoff(c.status().job!.id,i);c.waitHandoff(c.status().job!.id,busyWait);c=f.fresh();}
 const old=c.status().waiting!;f.advance(old.nextAt-f.options.now());
 const writes=atomicWriteCount(f.side);const token=c.claimClosedCheck(c.status().job!.id,old.nextAt);
 expect(token.previousNextAt).toBe(old.nextAt);expect(atomicWriteCount(f.side)).toBe(writes+1);
 expect(()=>f.fresh().claimClosedCheck(c.status().job!.id,old.nextAt)).toThrow('CHANGED');
 expect(c.status().waiting).toMatchObject({since:old.since,attempts:stops,nextAt:f.options.now()+(stops<=1?900000:3600000)});
 c.waitJob(c.status().job!.id,busyWait);expect(atomicWriteCount(f.side)).toBe(writes+1);
});
it.each(['waitJob','waitHandoff','claimClosedCheck'] as const)('T-side-sync: %s retains renamed record through persistent sync failure and fresh recovery',method=>{
 const f=waitFixture();let fail=false;
 const sync=(file:string)=>{if(fail)throw Object.assign(Error('sync'),{code:'EIO'});syncParentDirectory(file);};
 const c=new BackupCoordinator({...f.options,sideSync:sync});
 if(method==='waitHandoff')c.prepareHandoff(c.status().job!.id,f.intent());
 if(method==='claimClosedCheck'){c.waitJob(c.status().job!.id,spaceWait);f.advance(900000);}
 fail=true;
 // For a new wait there is no live side file to synchronize at entry.
 // A closed claim starts with a synchronized record, then fails after its rename.
 let syncCalls=0;const writer=new BackupCoordinator({...f.options,sideSync:file=>{syncCalls++;if(method==='claimClosedCheck'&&syncCalls===1)return syncParentDirectory(file);return sync(file);}});
 const result=method==='claimClosedCheck'?writer.claimClosedCheck(c.status().job!.id,c.status().waiting!.nextAt):method==='waitJob'?writer.waitJob(c.status().job!.id,spaceWait):writer.waitHandoff(c.status().job!.id,spaceWait,f.room);
 expect(result.outcome).toBe('replaced-sync-pending');const saved=readFileSync(f.side,'utf8');
 expect(new BackupCoordinator({...f.options,sideSync:sync}).reconcileStartup().blocked).toBe(true);
 expect(readFileSync(f.side,'utf8')).toBe(saved);
 fail=false;expect(new BackupCoordinator({...f.options,sideSync:sync}).reconcileStartup()).toMatchObject({phase:'waiting',blocked:false});expect(readFileSync(f.side,'utf8')).toBe(saved);
});
it('T-side-sync: before-rename failure is not-replaced; settle-only failure keeps complete wait',()=>{
 const f=waitFixture(),raw=readFileSync(f.file,'utf8');
 const broken=new BackupCoordinator({...f.options,sideWrite(){throw Error('write refused');}});
 expect(()=>broken.waitJob(f.c.status().job!.id,spaceWait)).toThrow('NOT_REPLACED');expect(readFileSync(f.file,'utf8')).toBe(raw);
 const write=atomic.writeFileAtomic;const spy=vi.spyOn(atomic,'writeFileAtomic').mockImplementation((file,...args)=>{if(file===f.file)throw Error('settle');return write(file,...args);});
 try{expect(f.c.waitJob(f.c.status().job!.id,spaceWait).committed).toBe(true);expect(readFileSync(f.file,'utf8')).toBe(raw);expect(f.fresh().status().phase).toBe('waiting');}finally{spy.mockRestore();}
 expect(f.fresh().reconcileStartup().phase).toBe('waiting');
});
it.each(['malformed','inconsistent','oversized','symlink','directory','unsupported'] as const)('T-side-read: %s blocks all coordinator entry points without changing evidence',kind=>{
 const f=waitFixture();const raw=readFileSync(f.file,'utf8');
 const value=kind==='malformed'?'{':kind==='inconsistent'?JSON.stringify({version:2,wait:{jobId:f.c.status().job!.id,base:'x',...spaceWait,nextAt:0}}):kind==='oversized'?' '.repeat(128*1024+1):JSON.stringify({version:99});
 if(kind==='symlink')symlinkSync(f.file,f.side);else if(kind==='directory')mkdirSync(f.side);else writeFileSync(f.side,value);
 const c=f.fresh();expect(c.reconcileStartup().blocked).toBe(true);
 expect(()=>c.requestManual(1,randomUUID())).toThrow('STATE_UNAVAILABLE');expect(()=>c.closedEligibility()).toThrow('STATE_UNAVAILABLE');expect(()=>c.prepareHandoff(JSON.parse(raw).job.id,f.intent())).toThrow('STATE_UNAVAILABLE');
 expect(readFileSync(f.file,'utf8')).toBe(raw);if(kind!=='symlink'&&kind!=='directory')expect(readFileSync(f.side,'utf8')).toBe(value);
 rmSync(f.side,{recursive:kind==='directory'});expect(c.status().phase).toBe('due');
});
it.each(['claiming','handoff-prepared','offline-claimed','capturing','handoff-armed'] as const)('T-startup-manual BF-2 BF-4: %s reconciles without daily scheduling',phase=>{
 const f=waitFixture();const i=f.intent();if(phase!=='claiming')f.c.prepareHandoff(f.c.status().job!.id,i);
 const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.job.phase=phase;writeFileSync(f.file,JSON.stringify(raw));
 if(phase==='handoff-armed')f.c.recordHandoffFailure({job:raw.job.id,handoff:i.id,stage:'capture',code:'BACKUP_DISK_FULL'});
 const c=f.fresh(),result=c.reconcileStartup();expect(result).toMatchObject({phase:'needs-review',consumedNonUpgradeHandoff:true});
 expect(c.status().reviewReason).toBe(phase==='handoff-armed'?'capture-unconfirmed':'interrupted');
 expect(f.fresh().reconcileStartup().consumedNonUpgradeHandoff).toBe(true);
 expect(c.clearReview(1).phase).toBe('idle');
});
it('T-supersede: daily replacement atomically retains seen and watermark and cannot run twice',async()=>{
 const f=waitFixture(true);f.c.waitJob(f.c.status().job!.id,spaceWait);
 f.setNow('2026-09-14T03:00:00Z');const s=await f.c.tick();expect(s.phase).toBe('waiting-backup-mode');
 const raw=f.c.committedState();expect(raw.seen).toContain(s.job!.occurrence);expect(raw.watermark).toBe(s.job!.scheduledAt);
 f.c.failWaiting(s.job!.id);f.c.clearReview(1);await f.c.tick();await f.fresh().tick();expect(f.c.status().phase).toBe('idle');
 f.setNow('2026-09-15T03:00:00Z');expect((await f.fresh().tick()).job!.id).not.toBe(s.job!.id);
});
it('T-configure T-expire BF-1: replacement cancels only its own manual, retains room and seen, and never revives old wait',()=>{
 const f=waitFixture();const i=f.intent();f.c.prepareHandoff(f.c.status().job!.id,i);f.c.waitHandoff(f.c.status().job!.id,spaceWait,f.room);
 const old=f.c.status().job!.id,seen=f.c.committedState().seen;
 const replacement=f.c.requestManual(1,randomUUID(),{jobId:old});expect(replacement.job!.id).not.toBe(old);
 expect(()=>f.c.cancelManual(old)).toThrow('CHANGED');f.c.cancelManual(replacement.job!.id);
 expect(f.c.status().phase).toBe('skipped');expect(f.c.status().waiting).toBeUndefined();expect(f.c.status().room).toEqual(f.room);expect(f.c.committedState().seen).toEqual(expect.arrayContaining(seen));
 f.c.configure(1,{...choices,enabled:false});expect(f.c.status().room).toEqual(f.room);
 f.c.configure(2,{...choices,enabled:false,destinationRef:'different'});expect(f.c.status().room).toBeUndefined();
});

it('T-tear T-expire: main-first retry preserves wait before commit and receipt expires learned room',()=>{
 const f=waitFixture(),i=f.intent();f.c.prepareHandoff(f.c.status().job!.id,i);f.c.waitHandoff(f.c.status().job!.id,spaceWait,f.room);
 const before=readFileSync(f.file,'utf8'),side=readFileSync(f.side,'utf8'),id=f.c.status().job!.id;
 const writer=atomic.writeFileAtomic;const spy=vi.spyOn(atomic,'writeFileAtomic').mockImplementation((file,...args)=>{if(file===f.file)throw Error('main commit refused');return writer(file,...args);});
 try{expect(()=>f.c.prepareHandoff(id,f.intent())).toThrow('refused');expect(readFileSync(f.file,'utf8')).toBe(before);expect(readFileSync(f.side,'utf8')).toBe(side);expect(f.fresh().status().phase).toBe('waiting');}finally{spy.mockRestore();}
 const next=f.intent();const ready=f.c.prepareHandoff(id,next);f.c.armHandoff(next.id);f.c.claimHandoff(next.id,next.bindingRevision,next.installationIdentity);f.c.beginHandoffCapture(next.id);
 const receipt={jobId:ready.job!.id,installationRef:choices.installationRef,destinationRef:choices.destinationRef,selectionHash,snapshotId:randomUUID(),artifactRef:ready.job!.id,sha256:'a'.repeat(64),bytes:200,verifiedAt:f.options.now()};
 expect(f.c.status().room).toEqual(f.room);f.c.completeHandoff(next.id,receipt);expect(f.fresh().status().room).toBeUndefined();expect(readFileSync(f.side,'utf8')).toBe(side);
 f.c.completeReturn(next.id);f.c.requestManual(1,randomUUID());f.c.waitJob(f.c.status().job!.id,busyWait);expect(f.c.status().waiting?.attempts).toBe(0);
});
it('T-concurrent: stale retry preparation and revision changes cannot replace the winning owner',()=>{
 const f=waitFixture();f.c.waitJob(f.c.status().job!.id,spaceWait);const id=f.c.status().job!.id;
 const winner=f.c.prepareHandoff(id,f.intent());expect(()=>f.fresh().prepareHandoff(id,f.intent())).toThrow('REJECTED');expect(f.c.status().job!.id).toBe(winner.job!.id);
});
it('T-upgrade: waiting is replaceable, without carrying its history to an upgrade',()=>{
 const f=waitFixture(true);f.c.configure(1,{...choices,preUpgrade:true});f.c.requestManual(2,randomUUID());f.c.waitJob(f.c.status().job!.id,spaceWait);
 const ready=f.c.prepareUpgrade(candidate(),f.intent());expect(ready.phase).toBe('handoff-prepared');expect(ready.waiting).toBeUndefined();
 expect(()=>f.c.waitHandoff(ready.job!.id,spaceWait)).toThrow('REJECTED');
});
it('T-side-read: recognized historical version is ignored, unknown and inconsistent sections are blocked',()=>{
 const f=waitFixture();writeFileSync(f.side,JSON.stringify({version:1,jobId:f.c.status().job!.id,waiting:true,wait:{cause:'busy',code:'BACKUP_FILE_IN_USE',since:0,nextAt:1,attempts:0}}));expect(f.c.status().phase).toBe('due');
 writeFileSync(f.side,JSON.stringify({version:2,history:{installationRef:choices.installationRef,revision:1,base:'x',since:-1,stops:0}}));expect(f.c.reconcileStartup().blocked).toBe(true);
});
it('T-startup: marker-free armed remains resumable; a lease refusal leaves raw evidence unchanged',()=>{
 const f=waitFixture();const i=f.intent();f.c.prepareHandoff(f.c.status().job!.id,i);f.c.armHandoff(i.id);const raw=readFileSync(f.file,'utf8');
 expect(f.fresh().reconcileStartup()).toMatchObject({phase:'handoff-armed',consumedNonUpgradeHandoff:false});
 const blocked=new BackupCoordinator({...f.options,acquire(){throw Error('busy');}});expect(blocked.reconcileStartup().blocked).toBe(true);expect(readFileSync(f.file,'utf8')).toBe(raw);
});

import {createRequire,syncBuiltinESMExports,stripTypeScriptTypes} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
it.each((['waitJob','waitHandoff','claimClosedCheck'] as const).flatMap(method=>(['open','fsync'] as const).map(failure=>({method,failure}))))('T-side-sync: actual directory $failure EIO after $method rename retains the installed record',({method,failure})=>{
 const f=waitFixture();const fs=createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
 if(method==='waitHandoff')f.c.prepareHandoff(f.c.status().job!.id,f.intent());
 if(method==='claimClosedCheck'){f.c.waitJob(f.c.status().job!.id,spaceWait);f.advance(900000);}
 const id=f.c.status().job!.id,nextAt=f.c.status().waiting?.nextAt;
 const originalOpen=fs.openSync,originalSync=fs.fsyncSync,originalClose=fs.closeSync;let directoryFd=-1,directoryOpens=0;
 const failing=()=>method!=='claimClosedCheck'||directoryOpens>1;
 fs.openSync=((file,...args)=>{if(String(file)===f.stateDirectory){directoryOpens++;if(failure==='open'&&failing())throw Object.assign(Error('directory open'),{code:'EIO'});directoryFd=originalOpen(file,...args);return directoryFd;}return originalOpen(file,...args);}) as typeof fs.openSync;
 fs.closeSync=(fd:number)=>{if(fd===directoryFd)directoryFd=-1;originalClose(fd);};
 fs.fsyncSync=(fd:number)=>{if(fd===directoryFd&&failure==='fsync'&&failing())throw Object.assign(Error('directory fsync'),{code:'EIO'});return originalSync(fd);};syncBuiltinESMExports();
 try{const result=method==='claimClosedCheck'?f.c.claimClosedCheck(id,nextAt!):method==='waitHandoff'?f.c.waitHandoff(id,spaceWait,f.room):f.c.waitJob(id,spaceWait);expect(result.outcome).toBe('replaced-sync-pending');expect(f.c.status().phase).toBe('waiting');expect(f.fresh().reconcileStartup().blocked).toBe(true);}
 finally{fs.openSync=originalOpen;fs.fsyncSync=originalSync;fs.closeSync=originalClose;syncBuiltinESMExports();}
 expect(f.fresh().reconcileStartup().phase).toBe('waiting');
});
it.each(['EACCES','EIO'])('T-side-read: %s is unavailable, not missing, including a second lease read',code=>{
 const f=waitFixture();f.c.waitJob(f.c.status().job!.id,spaceWait);const main=readFileSync(f.file,'utf8'),side=readFileSync(f.side,'utf8');
 const fs=createRequire(import.meta.url)('node:fs') as typeof import('node:fs'),original=fs.readFileSync;let reads=0;
 fs.readFileSync=((file,...args)=>{if(String(file)===f.side&&++reads>=2)throw Object.assign(Error('unavailable'),{code});return original(file,...args);}) as typeof fs.readFileSync;syncBuiltinESMExports();
 try{expect(f.c.status().phase).toBe('waiting');expect(()=>f.c.requestManual(1,randomUUID())).toThrow('STATE_UNAVAILABLE');expect(f.fresh().reconcileStartup().blocked).toBe(true);}
 finally{fs.readFileSync=original;syncBuiltinESMExports();}
 expect(readFileSync(f.file,'utf8')).toBe(main);expect(readFileSync(f.side,'utf8')).toBe(side);
});
it('T-downgrade: BASE18 reads settled main without side parsing and does not repeat the occurrence',async()=>{
 const f=waitFixture(true);f.setNow('2026-09-13T03:00:00Z');await f.c.tick();f.c.waitJob(f.c.status().job!.id,spaceWait);
 const require=createRequire(import.meta.url);
 let source=readFileSync(new URL('./testing/fixtures/backup-base-1.0.18/server/backup-coordinator.ts.txt',import.meta.url),'utf8');
 source=source.replace(/from "(\.\.?\/[^\"]+)"/g,(_all,relative:string)=>`from "${pathToFileURL(resolve('server',relative)).href}"`).replace('from "zod"',`from "${pathToFileURL(require.resolve('zod')).href}"`);
 const js=stripTypeScriptTypes(source);const file=join(f.stateDirectory,'base-coordinator.mjs');writeFileSync(file,js);
 // Run the historical module through Node's TypeScript loader, outside Vitest's transformer.
 const result=execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {BackupCoordinator}=await import(${JSON.stringify(pathToFileURL(file).href)});const c=new BackupCoordinator({stateDirectory:${JSON.stringify(f.stateDirectory)},now:()=>${f.options.now()}});const before=c.status();const after=await c.tick();console.log(JSON.stringify({before:before.job,after:after.job}));`],{encoding:'utf8'});
 const parsed=JSON.parse(result);expect(parsed.before.phase).toBe('skipped');expect(parsed.after).toEqual(parsed.before);
});

it('T-supersede: an unseen daily earlier than a waiting manual does not replace it',async()=>{
 const f=waitFixture(true);f.setNow('2026-09-13T03:00:00Z');f.c.requestManual(1,randomUUID());const id=f.c.status().job!.id;f.c.waitJob(id,spaceWait);
 expect((await f.c.tick()).job!.id).toBe(id);expect((await f.fresh().tick()).phase).toBe('waiting');
});

it.each((['manual','daily'] as const).flatMap(kind=>(['verified','review'] as const).map(terminal=>({kind,terminal}))))('T-supersede: $kind to $terminal commits bounded bookkeeping and cannot capture twice',async({kind,terminal})=>{
 const f=waitFixture(true);if(kind==='daily'){f.setNow('2026-09-13T03:00:00Z');await f.c.tick();}
 const initial=f.c.status().job!,intent=f.intent();f.c.prepareHandoff(initial.id,intent);f.c.waitHandoff(initial.id,spaceWait,f.room);
 const raw=JSON.parse(readFileSync(f.file,'utf8'));raw.seen=[...Array.from({length:255},(_,n)=>`earlier:${n}`),initial.occurrence];writeFileSync(f.file,JSON.stringify(raw));
 f.setNow('2026-09-14T03:00:00Z');const next=await f.c.tick(),committed=f.c.committedState();
 expect(committed.seen).toHaveLength(256);expect(committed.seen).toEqual([...raw.seen,next.job!.occurrence].slice(-256));expect(committed.watermark).toBe(next.job!.scheduledAt);expect(next.room).toEqual(f.room);expect(next.waiting).toBeUndefined();
 const concurrent=await f.fresh().tick();expect(concurrent.job!.id).toBe(next.job!.id);
 if(terminal==='verified'){
  const c=new BackupCoordinator({...f.options,claimIdle:f.claimIdle,captureOffline:f.captureOffline});expect((await c.tick()).phase).toBe('local-verified');expect(f.captureOffline).toHaveBeenCalledTimes(1);
 }else f.c.failWaiting(next.job!.id);
 const settled=f.c.status().job;await f.c.tick();await f.fresh().tick();expect(f.c.status().job).toEqual(settled);expect(f.captureOffline).toHaveBeenCalledTimes(terminal==='verified'?1:0);
 if(terminal==='review')f.c.clearReview(1);
 f.setNow('2026-09-15T03:00:00Z');const tomorrow=await f.fresh().tick();expect(tomorrow.job!.id).not.toBe(next.job!.id);expect((await f.fresh().tick()).job!.id).toBe(tomorrow.job!.id);
});
it('T-side-sync: explicitly unsupported directory sync is durable, unlike EIO',()=>{
 const f=waitFixture(),fs=createRequire(import.meta.url)('node:fs') as typeof import('node:fs'),open=fs.openSync;
 fs.openSync=((file,...args)=>{if(String(file)===f.stateDirectory)throw Object.assign(Error('unsupported'),{code:'ENOTSUP'});return open(file,...args);}) as typeof fs.openSync;syncBuiltinESMExports();
 try{expect(f.c.waitJob(f.c.status().job!.id,spaceWait).outcome).toBe('durable');expect(f.fresh().reconcileStartup()).toMatchObject({phase:'waiting',blocked:false});}
 finally{fs.openSync=open;syncBuiltinESMExports();}
});

it.each(['needs-review','installation','revision'])('T-torn-prerun: %s mismatch cannot borrow an old wait',kind=>{
 const f=waitFixture();f.c.waitJob(f.c.status().job!.id,spaceWait);const side=readFileSync(f.side,'utf8'),raw=JSON.parse(readFileSync(f.file,'utf8'));
 if(kind==='needs-review'){raw.job.phase='needs-review';raw.job.error='interrupted';}
 else if(kind==='installation')raw.schedule.installationRef='another-installation';else raw.revision++;
 writeFileSync(f.file,JSON.stringify(raw));expect(f.fresh().status().waiting).toBeUndefined();expect(f.fresh().reconcileStartup().phase).not.toBe('waiting');expect(readFileSync(f.side,'utf8')).toBe(side);
});
it('T-expire: an older or different-destination receipt cannot clear the learned room',()=>{
 const f=waitFixture(),i=f.intent();f.c.prepareHandoff(f.c.status().job!.id,i);f.c.waitHandoff(f.c.status().job!.id,spaceWait,f.room);
 const raw=JSON.parse(readFileSync(f.file,'utf8')),receipt={jobId:raw.job.id,installationRef:choices.installationRef,destinationRef:choices.destinationRef,selectionHash,snapshotId:randomUUID(),artifactRef:raw.job.id,sha256:'a'.repeat(64),bytes:200,verifiedAt:f.room.at-1};
 raw.lastVerified=receipt;writeFileSync(f.file,JSON.stringify(raw));expect(f.fresh().status().room).toEqual(f.room);
 raw.lastVerified={...receipt,destinationRef:'older-destination',verifiedAt:f.room.at+1};writeFileSync(f.file,JSON.stringify(raw));expect(f.fresh().status().room).toEqual(f.room);
 raw.lastVerified={...receipt,verifiedAt:f.room.at};writeFileSync(f.file,JSON.stringify(raw));expect(f.fresh().status().room).toBeUndefined();
});
it.each(['before','after'])('T-supersede: death %s the main commit leaves one complete bookkeeping image',async boundary=>{
 const f=waitFixture(true);f.c.waitJob(f.c.status().job!.id,spaceWait);const before=readFileSync(f.file,'utf8');f.setNow('2026-09-14T03:00:00Z');
 const write=atomic.writeFileAtomic;const spy=vi.spyOn(atomic,'writeFileAtomic').mockImplementation((file,...args)=>{if(file===f.file){if(boundary==='after')write(file,...args);throw Error('process death');}return write(file,...args);});
 try{await expect(f.c.tick()).rejects.toThrow('process death');}finally{spy.mockRestore();}
 if(boundary==='before')expect(readFileSync(f.file,'utf8')).toBe(before);
 else {const state=f.fresh().committedState();expect(state.seen).toContain(state.job!.occurrence);expect(state.watermark).toBe(state.job!.scheduledAt);expect(state.job!.id).not.toBe(JSON.parse(before).job.id);}
 const next=await f.fresh().tick();expect((await f.fresh().tick()).job!.id).toBe(next.job!.id);expect(f.fresh().committedState().seen.filter(value=>value===next.job!.occurrence)).toHaveLength(1);
});

it.each([{version:1},{version:1,jobId:'bad',waiting:true,wait:{}},{version:1,jobId:'a'.repeat(64),waiting:true,wait:{cause:'busy',code:'BACKUP_FILE_IN_USE',since:0,nextAt:1,attempts:-1}}])('T-historical-invalid: malformed historical content blocks admission %j',value=>{
 const f=waitFixture(),raw=readFileSync(f.file,'utf8'),side=JSON.stringify(value);writeFileSync(f.side,side);
 expect(f.fresh().reconcileStartup().blocked).toBe(true);
 expect(()=>f.c.requestManual(1,randomUUID())).toThrow('STATE_UNAVAILABLE');
 expect(readFileSync(f.file,'utf8')).toBe(raw);expect(readFileSync(f.side,'utf8')).toBe(side);
});

it('T-armed-replacement: manual replacement after armed settle failure uses the effective wait',()=>{
 const f=waitFixture(),i=f.intent();f.c.prepareHandoff(f.c.status().job!.id,i);f.c.armHandoff(i.id);
 const old=f.c.status().job!.id,write=atomic.writeFileAtomic;
 const spy=vi.spyOn(atomic,'writeFileAtomic').mockImplementation((file,...args)=>{if(file===f.file)throw Error('settle');return write(file,...args);});
 try{f.c.waitHandoff(old,busyWait);}finally{spy.mockRestore();}
 expect(f.c.committedState().job!.phase).toBe('handoff-armed');expect(f.c.status().phase).toBe('waiting');
 const next=f.fresh().requestManual(1,randomUUID(),{jobId:old});expect(next.phase).toBe('due');expect(next.job!.id).not.toBe(old);
 expect(next.waiting).toBeUndefined();
});
it('BF-4: a durable interrupted upgrade claiming review never consumes backup-mode argv',()=>{
 const f=waitFixture(),raw=JSON.parse(readFileSync(f.file,'utf8'));
 raw.job.occurrence='1:upgrade:fixture';raw.job.phase='claiming';writeFileSync(f.file,JSON.stringify(raw));
 expect(f.fresh().reconcileStartup()).toMatchObject({phase:'needs-review',consumedNonUpgradeHandoff:false});
 expect(f.fresh().reconcileStartup()).toMatchObject({phase:'needs-review',consumedNonUpgradeHandoff:false});
});
