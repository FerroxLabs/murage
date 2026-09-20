import { expect,it } from "vitest";
import { DEFAULT_BACKUP_TIME,enabledSchedule,scheduleCardNotice,scheduleDraft,scheduleError,scheduleNeedsReview,schedulePhase,closedJobLabel,closedResultLabel } from "./backup-schedule-ui";
const state:BackupScheduleStatus={supported:true,pending:false,enabled:false,revision:4,phase:"idle",schedule:{enabled:false,preUpgrade:false},refs:{installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",destinationLabel:"Backup",recoveryLabel:"Recovery.age"}};
const draft={time:"23:45",timezone:"Asia/Bangkok",catchup:"2",size:"1",duration:"10",preUpgrade:false,closedApp:false};
it("requires explicit consent and complete host bindings; emits exact scope and units",()=>{
  expect(enabledSchedule(draft,state,false)).toBeNull();expect(enabledSchedule(draft,{...state,refs:undefined},true)).toBeNull();
  expect(enabledSchedule(draft,state,true)).toEqual({enabled:true,preUpgrade:false,installationRef:"fixture_install",destinationRef:"fixture_dest",recoveryRef:"fixture_key",time:"23:45",timezone:"Asia/Bangkok",catchupMs:7200000,maxBytes:1073741824,maxDurationMs:600000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"}});
});
it("rejects missing/malformed/out-of-bound choices without rounding",()=>{
  for(const change of [{time:"24:00"},{timezone:"not/a-zone"},{catchup:""},{catchup:"169"},{catchup:"0.0001"},{size:"0"},{size:"1025"},{size:"NaN"},{duration:"31"},{duration:"0.00001"},{size:"1e-20"}])expect(enabledSchedule({...draft,...change},state,true)).toBeNull();
  expect(enabledSchedule({...draft,catchup:"168",size:"1024",duration:"30"},state,true)).not.toBeNull();
});
// M57: the time is no longer left empty. An empty field is one more thing to
// work out before backups can be turned on, and the whole point of the new
// setup is that nothing on the ordinary road needs working out.
it("preserves saved exact integers, fills first-setup limits and fills the time in",()=>{
  const saved={...state,schedule:{...state.schedule,time:"01:30",timezone:"UTC",catchupMs:60001,maxBytes:1001,maxDurationMs:1001}};
  expect(enabledSchedule(scheduleDraft(saved.schedule),saved,true)).toMatchObject({catchupMs:60001,maxBytes:1001,maxDurationMs:1001});
  // Was: first setup left the limits empty ({catchup:"",size:"",duration:""}).
  const first=scheduleDraft(state.schedule);
  expect(first).toMatchObject({time:DEFAULT_BACKUP_TIME,catchup:"12",size:"50",duration:"30"});
  expect(enabledSchedule({...first,time:"03:00",timezone:"UTC"},state,true)).toMatchObject({catchupMs:12*3600000,maxBytes:50*1024**3,maxDurationMs:30*60000});
});
it("locks active, review, unknown, enabled and unsupported routes",()=>{
  for(const phase of ["claiming","capturing","needs-review","handoff-prepared","handoff-armed","offline-claimed","return-pending","unknown"]){expect(scheduleNeedsReview(phase)).toBe(true);expect(enabledSchedule(draft,{...state,phase},true)).toBeNull();}
  for(const change of [{pending:true},{supported:false},{enabled:true},{schedule:{...state.schedule,preUpgrade:true}}])expect(enabledSchedule(draft,{...state,...change},true)).toBeNull();
});
it("never reflects raw host exceptions or turns unknown phases into success",()=>{
  expect(scheduleError(Error("PRIVATE_KEY_CANARY"))).not.toContain("PRIVATE_KEY_CANARY");
  expect(scheduleError(Error("IPC BACKUP_SCHEDULE_CHANGED PRIVATE_PATH"))).toContain("Settings changed");
  expect(scheduleError("BACKUP_IDENTITY_HEADER_REQUIRED")).toContain("independently saved age");
  expect(schedulePhase("needs-review")).toContain("paused");expect(schedulePhase("unknown")).toContain("review");
});
it("pre-upgrade opt-in needs actual capability and retains saved selections without silent changes",()=>{
 const selected={...draft,preUpgrade:true};for(const preUpgradeSupported of [undefined,false])expect(enabledSchedule(selected,{...state,preUpgradeSupported},true)).toBeNull();
 const supported={...state,preUpgradeSupported:true};expect(enabledSchedule(selected,supported,false)).toBeNull();expect(enabledSchedule(selected,supported,true)).toMatchObject({enabled:true,preUpgrade:true,time:draft.time,timezone:draft.timezone,maxBytes:1073741824});
 const saved={...supported,schedule:{...state.schedule,preUpgrade:true,time:draft.time,timezone:draft.timezone,catchupMs:60001,maxBytes:1001,maxDurationMs:1001}};const restored=scheduleDraft(saved.schedule);expect(restored.preUpgrade).toBe(true);expect(enabledSchedule(restored,saved,true)).toMatchObject({preUpgrade:true,catchupMs:60001,maxBytes:1001,maxDurationMs:1001});expect(enabledSchedule({...restored,preUpgrade:false},saved,true)).toMatchObject({preUpgrade:false});expect(enabledSchedule(restored,{...saved,preUpgradeSupported:false},true)).toBeNull();
});
it("maps pre-upgrade lifecycle without treating installation request as completion",()=>{
 expect(scheduleNeedsReview("install-requested")).toBe(true);expect(schedulePhase("install-requested")).toBe("Update installation requested");
 expect(scheduleNeedsReview("upgrade-complete")).toBe(false);expect(schedulePhase("upgrade-complete")).toBe("Update completed after backup");expect(scheduleNeedsReview("upgrade-cancelled")).toBe(false);expect(schedulePhase("upgrade-cancelled")).toBe("Update cancelled");
});
it("preserves closed-app permission but requires current capability and renewed consent",()=>{
 const selected={...draft,closedApp:true};
 for(const closedAppSupported of [undefined,false])expect(enabledSchedule(selected,{...state,closedAppSupported},true)).toBeNull();
 const supported={...state,closedAppSupported:true};
 expect(enabledSchedule(selected,supported,false)).toBeNull();
 expect(enabledSchedule(selected,supported,true)).toMatchObject({closedApp:true,enabled:true});
 const saved={...supported,schedule:{...state.schedule,closedApp:true}};
 expect(scheduleDraft(saved.schedule).closedApp).toBe(true);
 expect(enabledSchedule({...selected,closedApp:false},saved,true)).toMatchObject({closedApp:false});
});
it("distinguishes prepared registration from enabled backups and rejects private result fields",()=>{
 expect(closedJobLabel("staged")).toBe("Job prepared, not registered");
 expect(closedJobLabel("installed")).toBe("Job registration confirmed");
 expect(closedJobLabel("disabled-removal-pending")).toContain("pending");
 expect(closedResultLabel({status:"verified",at:1,revision:1,privateKey:"SECRET_CANARY"})).toBeNull();
 expect(closedResultLabel({status:"verified",at:1,revision:1})).toEqual({label:"Backup verified",at:1});
});
it("does not print the page's attention message a second time inside the schedule card",()=>{
  // The Windows elevation refusal: it reached the page as a status error, and
  // both the "Needs attention" list and the schedule card printed it, in the
  // same words, one above the other.
  const elevated=scheduleError("BACKUP_ELEVATED");
  expect(elevated).toContain("running as administrator");
  expect(scheduleCardNotice(null,"BACKUP_ELEVATED",[elevated])).toBeNull();
  // The same is true of an error the page carried from an action.
  expect(scheduleCardNotice(elevated,undefined,[elevated])).toBeNull();
  // An error the summary does NOT carry still appears beside the controls.
  expect(scheduleCardNotice(null,"BACKUP_ELEVATED",[])).toBe(elevated);
  expect(scheduleCardNotice(null,"BACKUP_ELEVATED",["Off-site status needs a refresh."])).toBe(elevated);
  expect(scheduleCardNotice("Something else entirely.",undefined,[elevated])).toBe("Something else entirely.");
  // Nothing to say stays nothing.
  expect(scheduleCardNotice(null,undefined,[])).toBeNull();
  expect(scheduleCardNotice(null,null,[elevated])).toBeNull();
});
