import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { BackupCoordinator, type BackupCaptureRequest } from "./backup-coordinator.ts";
import { backupScheduleSchema, latestBackupOccurrence } from "../shared/backup-schedule.ts";
import { canonicalUpdateDescriptor, type UpdateCandidate } from "../shared/update-candidate.mjs";
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))safeWipeSync(root);vi.useRealTimers();});
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
