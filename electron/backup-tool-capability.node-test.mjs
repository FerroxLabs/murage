import test from "node:test";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createBackupToolCapability, createResticToolCapability, createToolRecheck } from "./backup-mode.mjs";
import { asyncBackupCodesign, BACKUP_CODESIGN_RETRY_MS } from "./backup-age-attestation.mjs";
import { EventEmitter } from "node:events";

async function fixture(work) {
  const root = mkdtempSync(path.join(tmpdir(), "murage-backup-capability-"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const state = { calls: 0, usable: true, fail: false, hold: null, wrong: false };
  const resources = path.join(root, "resources");
  mkdirSync(path.join(resources, "server"), { recursive: true });
  const key = `backupFixture${Date.now()}${Math.random()}`;
  globalThis[key] = state;
  writeFileSync(path.join(resources, "server", "windows-backup-resources.js"), `
    import path from 'node:path';
    export function createWindowsBackupResourceResolver(input) {
      return async () => {
        const state = globalThis[${JSON.stringify(key)}];
        state.calls++; state.input = input;
        await state.hold;
        if (state.fail) throw Error('AGE_TOOL_UNVERIFIED');
        return { executable: path.join(input.resourcesPath, 'backup-tools', 'x64', state.wrong ? 'other.exe' : 'murage-backup-age.exe') };
      };
    }
  `);
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  const executable = path.join(root, "Murage.exe");
  const capability = createBackupToolCapability({ resourcesPath: resources, currentExecutable: executable, isUsable: () => state.usable });
  try { await work({ capability, state, resources, executable }); }
  finally { Object.defineProperty(process, "platform", descriptor); delete globalThis[key]; safeWipeSync(root); }
}

test("Windows capability verifies fixed resources per operation, never during status reads", () => fixture(async ({ capability, state, resources, executable }) => {
  assert.equal(capability.currentTool(), null); assert.equal(capability.status().state, "pending");
  assert.equal(state.calls, 0);
  const expected = path.join(resources, "backup-tools", "x64", "age.exe");
  assert.equal(await capability.requireTool(), expected);
  assert.deepEqual(state.input, { resourcesPath: resources, currentExecutable: executable });
  assert.equal(capability.currentTool(), expected); capability.status(); assert.equal(state.calls, 1);
  assert.equal(await capability.requireTool(), expected); assert.equal(state.calls, 2);
  state.fail = true;
  await assert.rejects(capability.requireTool(), /AGE_TOOL_UNVERIFIED/);
  assert.equal(capability.currentTool(), null); assert.equal(capability.status().state, "failed");
  state.fail = false; assert.equal(await capability.requireTool(), expected);
}));

test("Windows verification coalesces and shutdown invalidates its pending result", () => fixture(async ({ capability, state }) => {
  let release; state.hold = new Promise(resolve => { release = resolve; });
  const first = capability.requireTool(), second = capability.requireTool();
  const results = Promise.allSettled([first, second]);
  while (!state.calls) await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls, 1); capability.invalidate(); state.usable = false;
  let drained = false; const drain = capability.settled().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(); const outcome = await results; await drain;
  assert.ok(outcome.every(value => value.status === "rejected")); assert.equal(capability.currentTool(), null);
}));

test("Windows capability refuses a wrong helper identity or lost host before readiness", () => fixture(async ({ capability, state }) => {
  state.wrong = true; await assert.rejects(capability.requireTool(), /BACKUP_UNAVAILABLE/);
  assert.equal(capability.currentTool(), null); state.wrong = false; state.usable = false;
  await assert.rejects(capability.requireTool(), /BACKUP_UNAVAILABLE/); assert.equal(state.calls, 1);
}));

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
function mainFunction(name, end) {
  const start = main.indexOf(`async function ${name}(`);
  assert.ok(start >= 0); const stop = main.indexOf(end, start); assert.ok(stop > start);
  return main.slice(start, stop);
}
test("actual desktop verifier wrapper refuses owner changes after await", async () => {
  let release;
  const context = { desktopDataOwner: {}, desktopDataDir: "fixture", desktopShutdownStarted: false,
    desktopBackupTool: { requireTool: () => new Promise(resolve => { release = resolve; }) } };
  const run = vm.runInNewContext(`(${mainFunction("requireDesktopBackupTool", "\nconst backupMode")})`, context);
  const pending = run(); context.desktopDataOwner = {}; release("fixed-age.exe");
  await assert.rejects(pending, error => error.code === "BACKUP_UNAVAILABLE");
});

test("actual desktop recovery rejects failed verification before identity or worker dispatch", async () => {
  let calls = 0;
  const context = { desktopDataOwner: {}, desktopDataDir: "fixture", desktopRecoveryMode: true, desktopShutdownStarted: false,
    requireDesktopBackupTool: async () => { throw Object.assign(Error("unverified"), { code: "AGE_TOOL_UNVERIFIED" }); },
    canRestoreSeparateInstallation: () => false, runInstallationRecoveryWorker: () => { calls++; } };
  const run = vm.runInNewContext(`(${mainFunction("runDesktopRecovery", "\nfunction ")})`, context);
  const readIdentity = () => { calls++; return "synthetic"; };
  await assert.rejects(run("backup-encrypted", { readIdentity }), error => error.code === "AGE_TOOL_UNVERIFIED");
  assert.equal(calls, 0);
});

test("actual desktop recovery retains ordinary Windows failure paths without changing POSIX policy", async () => {
  for (const platform of ["win32", "darwin"]) {
    const failure = Object.assign(Error("worker failed"), { code: "AGE_PROCESS_FAILED", retainedDirectory: "private-stage" });
    const context = { desktopDataOwner: { utilityServerLeaseEnvironment: () => ({}) }, desktopDataDir: "fixture",
      desktopRecoveryMode: true, desktopShutdownStarted: false, retainedSeparateDirectory: null,
      requireDesktopBackupTool: async () => "fixed-age.exe", canRestoreSeparateInstallation: () => false,
      awaitOwnedWork: async promise => promise, desktopStartup: Promise.resolve(), ownedServerChildren: new Set(),
      serverProc: null, credentialWrites: new Set(), companionStarts: new Set(), browserLifecycleCleanups: new Map(),
      stopDesktopCompanion: async () => {}, browserSurface: null, browserHost: null, cuaReady: Promise.resolve(), stopCua: async () => {},
      process: { platform, env: {}, resourcesPath: "resources" }, path, trackOwnedServerChild: () => {},
      runInstallationRecoveryWorker: async () => { throw failure; } };
    const run = vm.runInNewContext(`(${mainFunction("runDesktopRecovery", "\nfunction ")})`, context);
    await assert.rejects(run("inspect-encrypted", { archive: "fixture.age", readIdentity: async () => "synthetic" }), error => error === failure);
    assert.equal(context.retainedSeparateDirectory, platform === "win32" ? "private-stage" : null);
  }
});

async function macFixture(work,recheckOptions={delays:[5,10,20]}){
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),"murage-backup-mac-capability-"))),app=path.join(root,"Murage.app"),resources=path.join(app,"Contents/Resources"),executable=path.join(app,"Contents/MacOS/Murage"),file=path.join(resources,"backup-tools",process.arch,"age");
 mkdirSync(path.dirname(file),{recursive:true});mkdirSync(path.dirname(executable),{recursive:true});writeFileSync(file,"fixture tool");writeFileSync(executable,"fixture executable");
 const descriptor=Object.getOwnPropertyDescriptor(process,"platform");Object.defineProperty(process,"platform",{...descriptor,value:"darwin"});
 const state={calls:0,usable:true,hold:null,fail:false,options:[],during:null};
 const capability=createBackupToolCapability({resourcesPath:resources,currentExecutable:executable,isUsable:()=>state.usable,recheckOptions,verifyMacTool:async(_file,options)=>{state.calls++;state.options.push(options);await state.hold;state.during?.();state.during=null;return !state.fail&&!options.signal.aborted;}});
 try{await work({state,capability,file,executable,app});}finally{capability.invalidate();await capability.settled();Object.defineProperty(process,"platform",descriptor);safeWipeSync(root);}
}
/** What macOS does to a freshly installed app a moment after its first
 * launch: it writes com.apple.macl onto Murage.app, which moves the bundle
 * folder's ctime. Here a folder entry made and removed moves it the same way. */
function touchBundle(app){const probe=path.join(app,".macl-probe");mkdirSync(probe);rmdirSync(probe);}
const until=async(predicate,ms=2000)=>{const end=Date.now()+ms;while(!predicate()){if(Date.now()>end)throw Error("timed out");await new Promise(r=>setTimeout(r,5));}};
test("macOS observational status never verifies; actions refresh and replacement invalidates",()=>macFixture(async({state,capability,file})=>{
 for(let i=0;i<20;i++){capability.currentTool();capability.status();}assert.equal(state.calls,0);assert.equal(await capability.requireTool(),file);
 for(let i=0;i<20;i++){assert.equal(capability.currentTool(),file);capability.status();}assert.equal(state.calls,1);await capability.requireTool();assert.equal(state.calls,2);
 state.fail=true;writeFileSync(file,"replacement bytes");assert.equal(capability.currentTool(),null);assert.equal(capability.status().state,"pending");assert.equal(capability.status().checking,true);
 await assert.rejects(capability.requireTool());assert.equal(capability.currentTool(),null);
}));
// Mac customer re-test 2 (2026-09-26): on each first launch after an install
// or update, backups and off-site copies stayed "Needs a supported desktop
// app" until Murage was restarted.
test("macOS: the bundle changing under a ready tool re-attests it instead of disabling backups until a restart",()=>macFixture(async({state,capability,file,app})=>{
 assert.equal(await capability.requireTool(),file);assert.equal(state.calls,1);
 touchBundle(app);
 assert.equal(capability.currentTool(),null);assert.deepEqual(capability.status(),{state:"pending",checking:true});
 await until(()=>capability.currentTool()===file);
 assert.equal(state.calls,2,"re-attested in full, not trusted by identity alone");
 assert.equal(state.options[1].timeoutMs,BACKUP_CODESIGN_RETRY_MS,"a background re-check allows a slow first launch");
 assert.deepEqual(capability.status(),{state:"ready",checking:false});
}));
test("macOS: the bundle changing during the startup attestation is retried until it holds still",()=>macFixture(async({state,capability,file,app})=>{
 state.during=()=>touchBundle(app);
 await assert.rejects(capability.requireTool(),/BACKUP_UNAVAILABLE/);
 assert.equal(capability.status().checking,true);
 await until(()=>capability.currentTool()===file);assert.equal(state.calls,2);
}));
test("macOS: a failed first check (a codesign run that timed out) keeps retrying with growing delays",()=>macFixture(async({state,capability,file})=>{
 state.fail=true;await assert.rejects(capability.requireTool());
 await until(()=>state.calls>=3);assert.equal(capability.currentTool(),null);assert.equal(capability.status().checking,true);
 state.fail=false;await until(()=>capability.currentTool()===file,3000);
 const calls=state.calls;await new Promise(r=>setTimeout(r,60));assert.equal(state.calls,calls,"no more checks once ready");
}));
test("macOS: shutdown stops re-checks",()=>macFixture(async({state,capability})=>{
 state.fail=true;await assert.rejects(capability.requireTool());capability.invalidate();
 const calls=state.calls;await new Promise(r=>setTimeout(r,80));assert.equal(state.calls,calls);assert.equal(capability.status().checking,false);
}));
test("macOS: a backup relaunch waits for a slow tool check instead of failing its capture",()=>macFixture(async({state,capability,file})=>{
 state.fail=true;setTimeout(()=>{state.fail=false;},40);
 assert.equal(await capability.waitReady(5000),file);
 state.fail=true;capability.invalidate();await assert.rejects(capability.waitReady(50));
}));
test("off-site restic: the same re-attestation after the bundle changes",async()=>{
 const root=realpathSync(mkdtempSync(path.join(tmpdir(),"murage-restic-capability-"))),app=path.join(root,"Murage.app"),file=path.join(app,"Contents/Resources/backup-tools",process.arch,"restic"),executable=path.join(app,"Contents/MacOS/Murage");
 mkdirSync(path.dirname(file),{recursive:true});mkdirSync(path.dirname(executable),{recursive:true});writeFileSync(file,"restic");writeFileSync(executable,"exe");
 let calls=0,fail=false;const options=[];
 const capability=createResticToolCapability({resourcesPath:path.join(app,"Contents/Resources"),currentExecutable:executable,isUsable:()=>true,locate:()=>file,verify:async(_f,o)=>{calls++;options.push(o);return !fail;},recheckOptions:{delays:[5,10]}});
 try{
  fail=true;await assert.rejects(capability.requireTool());assert.equal(capability.status().checking,true);fail=false;
  await until(()=>capability.currentTool()===file);assert.equal(options.at(-1).timeoutMs,BACKUP_CODESIGN_RETRY_MS);
  touchBundle(app);assert.equal(capability.currentTool(),null);await until(()=>capability.currentTool()===file);
  const missing=createResticToolCapability({resourcesPath:root,currentExecutable:executable,isUsable:()=>true,locate:()=>null,verify:async()=>true,recheckOptions:{delays:[5]}});
  await assert.rejects(missing.requireTool());assert.equal(missing.status().checking,false,"a build without restic is not retried");
 }finally{capability.invalidate();await capability.settled();safeWipeSync(root);}
});
test("re-check scheduler: one timer at a time, growing delays, stopped for good",async()=>{
 const timers=[];const recheck=createToolRecheck({run:()=>{},isUsable:()=>true,delays:[1,2,3],setTimer:(fn,ms)=>{timers.push(ms);return {fn};},clearTimer:()=>{}});
 recheck.schedule();recheck.schedule();assert.deepEqual(timers,[1]);assert.equal(recheck.scheduled(),true);
 recheck.stop();recheck.schedule();assert.deepEqual(timers,[1]);assert.equal(recheck.scheduled(),false);
});
test("codesign runner honours a longer bound for background re-checks",async()=>{
 const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill(){setImmediate(()=>child.emit("close",null));}});
 const started=Date.now();const result=await asyncBackupCodesign(["--verify"],{timeoutMs:30,spawnCommand:()=>child});
 assert.match(String(result.error),/timeout/);assert.ok(Date.now()-started<2000);
});
test("macOS verifier yields to heartbeat, coalesces and rejects resource replacement during await",()=>macFixture(async({state,capability,executable})=>{
 let release;state.hold=new Promise(r=>{release=r;});const first=capability.requireTool(),second=capability.requireTool(),results=Promise.allSettled([first,second]);let heartbeat=false;await new Promise(r=>setTimeout(()=>{heartbeat=true;r();},5));assert(heartbeat);assert.equal(state.calls,1);writeFileSync(executable,"replaced executable");release();assert((await results).every(r=>r.status==="rejected"));assert.equal(capability.currentTool(),null);
}));
test("macOS shutdown discards pending attestation and waits for settlement",()=>macFixture(async({state,capability})=>{
 let release;state.hold=new Promise(r=>{release=r;});const pending=capability.requireTool();const result=assert.rejects(pending);capability.invalidate();state.usable=false;let done=false;const drain=capability.settled().then(()=>{done=true;});await new Promise(r=>setImmediate(r));assert.equal(done,false);release();await result;await drain;assert.equal(capability.currentTool(),null);
}));
