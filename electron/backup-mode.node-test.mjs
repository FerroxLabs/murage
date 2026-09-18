import assert from "node:assert/strict";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import test from "node:test";
import { copyFileSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { BACKUP_MODE_ARGUMENT,BACKUP_AGE_SHA256,backupActivityBusy,createBackupModeController,prepareBackupRestart,readBackupIdentity,verifiedBackupTool } from "./backup-mode.mjs";
import { createBackupRestartAdmission } from "../server/backup-restart-admission.ts";
import { BACKUP_AGE_PIN } from "../shared/backup-age-pin.ts";
test("explicit idle confirmation is required before restart, with a second activity check",async()=>{
  const calls=[];const host={supported:()=>true,readActivity:async()=>{calls.push("activity");return{bots:[{busy:false}],groups:[]};},confirm:async()=>{calls.push("confirm");return true;},prepare:async()=>{calls.push("prepare");return async()=>{};},restart:async()=>calls.push("restart")};
  assert.deepEqual(await createBackupModeController(host).restart(),{restarting:true});
  assert.deepEqual(calls,["activity","confirm","activity","prepare","restart"]);
});
test("lost prepare acknowledgement releases the known token; failed cleanup releases its reservation",async()=>{
  let released=0;const gate=createBackupRestartAdmission({isBusy:()=>false,onRelease:()=>released++});
  await assert.rejects(prepareBackupRestart(async(action,token)=>{if(action==="prepare"){gate.prepare(token);throw Error("lost acknowledgement");}return gate.cancel(token);}));
  assert.equal(gate.held(),false);assert.equal(released,1);
  const controller=createBackupModeController({supported:()=>true,readActivity:async()=>({bots:[],groups:[]}),confirm:async()=>true,prepare:()=>prepareBackupRestart(async(action,token)=>gate[action](token)),restart:async()=>{throw Error("cleanup failed");}});
  await assert.rejects(controller.restart(),/cleanup failed/);assert.equal(gate.held(),false);assert.equal(released,2);
});
test("busy, cancelled, unsupported, changed and unknown activity never restarts",async()=>{
  for(const mode of ["busy","cancel","unsupported","changed","unknown"]){
    let count=0,restarted=false;
    const controller=createBackupModeController({supported:()=>mode!=="unsupported",readActivity:async()=>mode==="unknown"?{}:{bots:[{busy:mode==="busy"||(mode==="changed"&&++count===2)}],groups:[]},confirm:async()=>mode!=="cancel",restart:async()=>{restarted=true;}});
    if(mode==="cancel")assert.deepEqual(await controller.restart(),{restarting:false});else await assert.rejects(controller.restart());
    assert.equal(restarted,false);
  }
  assert.equal(backupActivityBusy({bots:[{busy:false,tasks:[{busy:true}]}],groups:[]}),true);
  assert.equal(backupActivityBusy({bots:[],groups:[{working:true}]}),true);
  assert.throws(()=>backupActivityBusy({bots:[{}],groups:[]}));
});
test("private key files must be independent, bounded and do not supply arbitrary commands",()=>{
  const root=mkdtempSync(path.join(tmpdir(),"murage-backup-key-test-"));
  try{
    const data=path.join(root,"data");mkdirSync(data);
    const key="# public key: age1"+"q".repeat(58)+"\nAGE-SECRET-KEY-1"+"A".repeat(60)+"\n";
    writeFileSync(path.join(root,"key.txt"),key);writeFileSync(path.join(data,"key.txt"),key);
    const value=readBackupIdentity(path.join(root,"key.txt"),data);assert.ok(value.identity===key);assert.ok(value.recipient.startsWith("age1"));
    assert.throws(()=>readBackupIdentity(path.join(data,"key.txt"),data),/INDEPENDENT/);
    writeFileSync(path.join(root,"large"),"X".repeat(4097));assert.throws(()=>readBackupIdentity(path.join(root,"large"),data));
  }finally{safeWipeSync(root);}
});
test("actual staged binary matches the packaged lookup and unsupported targets need no executable",()=>{
  const root=mkdtempSync(path.join(tmpdir(),"murage-backup-resources-test-"));
  try{
    const target=path.join(root,"backup-tools","arm64");mkdirSync(target,{recursive:true});
    copyFileSync(new URL("../dist-native/backup-age/arm64/age",import.meta.url),path.join(target,"age"));
    assert.equal(verifiedBackupTool(root),process.platform==="darwin"&&process.arch==="arm64"?path.join(target,"age"):null);
    // Extra caller arguments cannot replace the actual runtime platform.
    assert.equal(verifiedBackupTool(root,"linux","x64"),verifiedBackupTool(root));
    writeFileSync(path.join(target,"age"),"wrong binary");assert.equal(verifiedBackupTool(root),null);
    assert.equal(BACKUP_AGE_SHA256,BACKUP_AGE_PIN.executableSha256);
    const manifest=parse(readFileSync(new URL("../electron-builder.yml",import.meta.url),"utf8"));
    const resource=manifest.mac.extraResources.find(entry=>entry.to==="backup-tools");
    assert.deepEqual(resource,{from:"dist-native/backup-age",to:"backup-tools",filter:["${arch}/age","LICENSE"]});
    assert.deepEqual(manifest.linux.extraResources.find(entry=>entry.to==="backup-tools"),{from:"dist-native/backup-age-linux",to:"backup-tools",filter:["${arch}/age","LICENSE"]});
    for(const section of [manifest,manifest.win])assert.equal(section.extraResources.some(entry=>entry.to==="backup-tools"),false);
    assert.ok(manifest.files.includes("shared/backup-age-pins.mjs"));
    // `files` is an allow-list, so every shared module electron/ imports has
    // to be named here or the packaged app throws on import at startup.
    assert.ok(manifest.files.includes("shared/path-identity.mjs"));
    const scripts=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).scripts;
    assert.ok(scripts["package:prepare"].startsWith("node scripts/prepare-backup-age.mjs && "));
    for(const name of ["package:linux","package:linux:offline","package:linux:dir"])assert.ok(scripts[name].startsWith("pnpm prepare:backup-age:linux && "));
  }finally{safeWipeSync(root);}
});
test("intentional backup mode is routed before harness and native writers start",()=>{
  const source=readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
  const start=source.indexOf("const desktopStartup = app.whenReady()");
  const body=source.slice(start);
  assert.ok(body.indexOf('process.argv.includes(BACKUP_MODE_ARGUMENT)')<body.indexOf('startCua()'));
  assert.ok(body.indexOf('showDesktopRecovery("BACKUP_REQUESTED")')<body.indexOf('await startServerPackaged()'));
  assert.ok(source.includes('process.argv.slice(1).filter(arg=>arg!==BACKUP_MODE_ARGUMENT)'));
  assert.equal(BACKUP_MODE_ARGUMENT,"--murage-backup-mode");
  assert.ok(source.includes('if(speechActive()||recorderActive())throw new Error("BACKUP_WORK_ACTIVE")'));
  assert.equal((source.match(/if\(backupMode\.isPreparing\(\)\|\|backupScheduleHost\?\.isPreparing\(\)\)throw new Error\("BACKUP_RESTART_PENDING"\)/g)||[]).length,2);
});
