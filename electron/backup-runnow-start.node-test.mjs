// 1.0.20 (Mac, backupmac): Back up now -> Continue left no trace when the
// start never settled, and the daily switch must stay on across a restart.
// Neither path takes anything from Sentinel: these hosts have no Sentinel hook.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackupCoordinator } from "../server/backup-coordinator.ts";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { createBackupScheduleHost } from "./backup-schedule-host.mjs";

const digest=value=>createHash("sha256").update(value).digest("hex");
const fakeKey="# public key: age1"+"q".repeat(58)+"\nAGE-SECRET-KEY-1"+"A".repeat(60)+"\n";
const choices={enabled:true,timezone:"UTC",time:"09:00",catchupMs:86400000,maxBytes:100000000,maxDurationMs:60000,selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"},preUpgrade:false};

function fixture(overrides={}){
  const root=mkdtempSync(path.join(tmpdir(),"murage-runnow-start-")),installation=path.join(root,"installation"),destination=path.join(root,"archives"),keyFile=path.join(root,"independent-key.txt");
  mkdirSync(installation);mkdirSync(destination);writeFileSync(keyFile,fakeKey,{mode:0o600});
  let now=Date.parse("2026-11-19T08:00:00Z"),binding;
  const calls=[],logs=[];
  const coordinator=()=>new BackupCoordinator({stateDirectory:path.join(root,"control"),now:()=>now});
  // No publishCommitted, noteBudget or any other Sentinel hook: 1.0.20 retired the Mac launch agent.
  const host={installation:()=>installation,now:()=>now,supported:()=>true,readProtected:async()=>binding,writeProtected:async(_key,value)=>{binding=value;},
    chooseDestination:async()=>destination,chooseKey:async()=>keyFile,confirmReferences:async()=>true,reportOutcome:line=>logs.push(line),
    prepare:async()=>{calls.push("prepare");return async()=>calls.push("release");},cleanupIdle:async()=>calls.push("cleanup"),relaunch:async mode=>calls.push(mode),
    capture:async request=>{calls.push("capture");await request.readIdentity();const bytes=Buffer.from("fictional encrypted artifact");writeFileSync(request.output,bytes,{flag:"wx",mode:0o600});return{ok:true,operation:"backup-encrypted",path:request.output,sha256:digest(bytes),snapshotId:randomUUID(),coverage:{scope:"application-data",fullInstallation:false,credentialPolicy:"preserve-in-encrypted-fidelity"}};},
    ...overrides};
  const hosts=[];
  const create=(extra={})=>{const h=createBackupScheduleHost({...host,coordinator:coordinator(),...extra});hosts.push(h);return h;};
  const controller=create();
  return{root,calls,logs,controller,coordinator,create,setNow:value=>{now=value;},
    async enable(){const status=await controller.selectReferences();const on=await controller.configure(status.revision,{...choices,...Object.fromEntries(["installationRef","destinationRef","recoveryRef"].map(key=>[key,status.refs[key]])),allowIdleRestart:true});controller.stopPolling();for(let i=0;i<100&&controller.isPreparing();i++)await new Promise(resolve=>setImmediate(resolve));return on;},
    cleanup(){for(const h of hosts)h.stopPolling();safeWipeSync(root);}};
}
const within=(promise,ms,label)=>Promise.race([promise,new Promise((_resolve,reject)=>{const t=setTimeout(()=>reject(Error(`${label}: no answer within ${ms} ms`)),ms);t.unref?.();})]);

test("back up now whose start never settles answers BACKUP_START_STALLED, logs each step, and never starts twice",async()=>{
  let release;const stuck=new Promise(resolve=>{release=resolve;});
  const f=fixture({runNowStartMs:200,prepare:async()=>{f.calls.push("prepare");await stuck;return async()=>f.calls.push("release");}});
  try{
    const on=await f.enable();
    await assert.rejects(within(f.controller.runNow(on.revision),5000,"runNow"),/BACKUP_START_STALLED/);
    assert.ok(f.logs.includes("backup run-now requested"),f.logs.join("\n"));
    assert.ok(f.logs.includes("backup run-now step prepare"),f.logs.join("\n"));
    assert.ok(f.logs.includes('backup run-now stalled {"step":"prepare"}'),f.logs.join("\n"));
    assert.ok(f.logs.includes('backup run-now refused {"code":"BACKUP_START_STALLED"}'),f.logs.join("\n"));
    assert.equal((await f.controller.status()).error,"BACKUP_START_STALLED");
    // The stalled start still holds the host: a second press is refused, not a second backup.
    await assert.rejects(f.controller.runNow(on.revision),/BACKUP_BUSY/);
    // When the stuck step returns, the cancelled start retires: nothing closes, nothing is armed.
    release();for(let i=0;i<200&&f.controller.isPreparing();i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.controller.isPreparing(),false);
    assert.deepEqual(f.calls,["prepare","release"]);
    assert.notEqual(f.coordinator().status().phase,"handoff-armed");
  }finally{f.cleanup();}
});

test("back up now with the daily schedule off and no Sentinel hook reaches the restart and writes a verified receipt",async()=>{
  const f=fixture();try{
    const on=await f.enable();
    const off=await f.controller.configure(on.revision,{...on.schedule,enabled:false});f.controller.stopPolling();assert.equal(off.enabled,false);
    const armed=await within(f.controller.runNow(off.revision),5000,"runNow");
    assert.equal(armed.phase,"handoff-armed");assert.deepEqual(f.calls,["prepare","cleanup","backup"]);
    assert.deepEqual(f.logs.slice(0,4),["backup run-now requested","backup run-now step references","backup run-now step prepare","backup run-now step restart"]);
    const resumed=f.create();await resumed.resumeOffline();resumed.completeReturn();
    const s=f.coordinator().status();assert.equal(s.phase,"returned");assert.equal(s.lastVerified.jobId,s.job.id);
  }finally{f.cleanup();}
});

test("daily backups turned on stay on after a restart and the next host takes the due backup",async()=>{
  const f=fixture();try{
    const on=await f.enable();assert.equal(on.enabled,true);
    const restarted=f.create();restarted.stopPolling();
    const after=await restarted.status();assert.equal(after.enabled,true);assert.equal(after.schedule.time,"09:00");assert.equal(after.revision,on.revision);
    f.setNow(Date.parse("2026-11-19T09:01:00Z"));await restarted.tick();
    assert.equal(f.coordinator().status().phase,"handoff-armed");assert.deepEqual(f.calls,["prepare","cleanup","backup"]);
  }finally{f.cleanup();}
});
