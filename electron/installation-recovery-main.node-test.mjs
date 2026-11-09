import { settleDesktopStartup, terminalDesktopStartup } from './startup-settle.mjs';
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EventEmitter } from "node:events";
const rawSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const writerBarrier = '  await awaitOwnedWork(Promise.allSettled([...credentialWrites]), "Credential writes have not settled");';
const control = process.env.MURAGE_RECOVERY_CONTROL === "skip-writer-wait";
if (control) assert.ok(rawSource.includes(writerBarrier));
const source = control ? rawSource.replace(writerBarrier, "") : rawSource;
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = () => new Promise(resolve => setImmediate(resolve));

function encryptedSeparateFixture(change = () => {}) {
  const events = [], root = "/owned/original";
  const original = { utilityServerLeaseEnvironment: () => { if(state.originalLeaseFailed)throw Error("lost-original");events.push("check-original"); } };
  const target = { utilityServerLeaseEnvironment: () => { if(state.targetLeaseFailed)throw Error("lost-target");events.push("check-target"); }, release: () => events.push("release-target") };
  const state = { owner: original, root, shutdown: false, inode: 1 };
  const scope = {
    desktopRecoveryMode: true, desktopDataOwner: original, desktopDataDir: root, desktopShutdownStarted: false,
    fs: { lstatSync: () => ({ dev: 1, ino: state.inode, isDirectory: () => true, isSymbolicLink: () => false }), realpathSync: () => root },
    requireDesktopBackupTool: async () => {},
    allocateSeparateInstallation: plan => ({ ...plan, dataDirectory: "/owned/new" }),
    acquireDataDirLease: () => target,
    runDesktopRecovery: async () => { await change(state); events.push("worker-exited"); return { ok: true, archiveSha256: "a".repeat(64) }; },
    loadMemoryRestore: async () => ({ mergeOriginalMemoryDeletions: (from, to) => {
      assert.equal(from, root); assert.equal(to, "/owned/new"); events.push("merge");
      if (state.mergeError) throw new Error("merge-failed");
    } }),
    publishInstallationSelection: () => events.push("publish"),
  };
  const loader='await import(pathToFileURL(path.join(process.resourcesPath,"server","memory","restore.js")).href)';
  let body=between("async function runEncryptedSeparateDesktopRecovery(", "async function runDesktopRecovery(");
  assert.equal(body.split(loader).length,2);
  body=body.replace(loader,"await loadMemoryRestore()");
  const keys=Object.keys(scope).filter(k=>!["desktopDataOwner","desktopDataDir","desktopShutdownStarted"].includes(k));
  body=body.replaceAll("desktopDataOwner","state.owner").replaceAll("desktopDataDir","state.root").replaceAll("desktopShutdownStarted","state.shutdown");
  const run=new Function(...keys,"state","let retainedSeparateDirectory=null;"+body+";return runEncryptedSeparateDesktopRecovery;")(...keys.map(k=>scope[k]),state);
  return { events, run: (originalRoot=root) => run({}, {originalRoot}) };
}
test("encrypted separate restore merges current deletions after worker exit and before selection",async()=>{
  const f=encryptedSeparateFixture();await f.run();
  assert.ok(f.events.indexOf("worker-exited")<f.events.indexOf("merge"));
  assert.ok(f.events.indexOf("merge")<f.events.indexOf("publish"));
  assert.equal(f.events.at(-1),"release-target");
  assert.equal(f.events.filter(x=>x==="check-target").length,2);
});
test("encrypted separate restore cannot publish after failed merge or changed original ownership",async()=>{
  for(const change of [s=>{s.mergeError=true;},s=>{s.owner={};},s=>{s.root="/foreign";},s=>{s.shutdown=true;},s=>{s.inode=2;},s=>{s.originalLeaseFailed=true;},s=>{s.targetLeaseFailed=true;}]){
    const f=encryptedSeparateFixture(change);await assert.rejects(f.run());
    assert.equal(f.events.includes("publish"),false);assert.equal(f.events.at(-1),"release-target");
  }
  const f=encryptedSeparateFixture();await assert.rejects(f.run("/foreign"));
  assert.equal(f.events.includes("worker-exited"),false);
});
test("encrypted separate restore waits for actual worker completion before touching the ledger",async()=>{
  const stopped=deferred(),f=encryptedSeparateFixture(()=>stopped.promise),pending=f.run();
  await pause();assert.equal(f.events.includes("merge"),false);assert.equal(f.events.includes("publish"),false);
  stopped.resolve();await pending;assert.equal(f.events.filter(x=>x==="merge").length,1);
});

function fixture({ writes = [], stop = async () => {}, mode = true, owned = true, separateAvailable = false } = {}) {
  let forks = 0, releases = 0, captured;
  const scope = {
    desktopRecoveryMode: mode, desktopShutdownStarted: false, desktopDataDir: "/owned/installation",
    desktopDataOwner: owned ? { release: () => { releases++; }, utilityServerLeaseEnvironment: () => ({ MURAGE_INTERNAL_DATA_DIR_LEASE: "private-owned-capability" }) } : null,
    canRestoreSeparateInstallation: () => separateAvailable,
    desktopStartup: Promise.resolve(), ownedServerChildren: new Set([{ stop }]), credentialWrites: new Set(writes), companionStarts: new Set(),
    browserLifecycleCleanups: new Map(), browserSurface: null, browserHost: null, cuaReady: Promise.resolve(),
    awaitOwnedWork: promise => promise, stopDesktopCompanion: async () => {}, stopCua: async () => {},
    process: { resourcesPath: "/package", env: { PATH: "/runtime", HOME: "/fixture", FLUX_API_KEY: "private-provider-canary", MURAGE_INTERNAL_DATA_DIR_LEASE: "forged-ambient" } }, path,
    utilityProcess: { fork() {} }, trackOwnedServerChild() {},
    runInstallationRecoveryWorker: async options => { forks++; captured = options; return { ok: true }; },
  };
  const body = between("async function runDesktopRecovery(", "function initializeBackgroundLifecycle()");
  const run = new Function(...Object.keys(scope), "let serverProc = {}; " + body + "; return runDesktopRecovery;")(...Object.values(scope));
  return { run, forks: () => forks, releases: () => releases, captured: () => captured };
}
test("actual recovery supervisor waits for admitted writers and retains primary ownership", async () => {
  const child = deferred(), write = deferred();
  const f = fixture({ writes: [write.promise], stop: () => child.promise });
  const run = f.run("backup", { output: "/chosen/new.zip" });
  await pause(); assert.equal(f.forks(), 0);
  child.resolve(); await pause(); assert.equal(f.forks(), 0);
  write.resolve(); await run;
  assert.equal(f.forks(), 1); assert.equal(f.releases(), 0);
  assert.deepEqual(f.captured().args, ["backup", "--data-dir", "/owned/installation", "--output", "/chosen/new.zip"]);
  assert.equal(f.captured().env.FLUX_API_KEY, undefined);
  assert.equal(f.captured().env.MURAGE_INTERNAL_DATA_DIR_LEASE, "private-owned-capability");
});
test("foreign ownership permits only archive planning or a separately supplied owned target", async () => {
  const f = fixture({ owned: false, separateAvailable: true });
  await assert.rejects(f.run("backup", { output: "/chosen/new.zip" }));
  await f.run("plan-restore", { archive: "/chosen/backup.zip" });
  assert.equal(f.captured().env.MURAGE_INTERNAL_DATA_DIR_LEASE, undefined);
  await f.run("restore", { archive: "/chosen/backup.zip", sha256: "a".repeat(64) }, {
    dataDirectory: "/new-owned/data", owner: { utilityServerLeaseEnvironment: () => ({ MURAGE_INTERNAL_DATA_DIR_LEASE: "new-target-only" }) },
  });
  assert.deepEqual(f.captured().args, ["restore", "--data-dir", "/new-owned/data", "--archive", "/chosen/backup.zip", "--sha256", "a".repeat(64)]);
  assert.equal(f.captured().env.MURAGE_INTERNAL_DATA_DIR_LEASE, "new-target-only");
  assert.equal(f.captured().env.FLUX_API_KEY, undefined);
});
test("startup selects before leasing and excludes selected roots from legacy migration", () => {
  const body = between("function acquireDesktopDataOwner()", "function ownedDesktopDataDir()");
  const calls = [];
  const scope = { assertDesktopStartupActive() {}, app: { isPackaged: true, getPath: key => "/fixture/" + key }, process: { env: {} }, path,
    dataDirLeasePaths: value => ({ canonicalDataDir: value }), resolveInstallationSelection: (userData, requested) => { calls.push([userData, requested]); return { dataDirectory: "/new/data", selected: true }; },
    acquireDataDirLease: value => { calls.push(value); return {}; } };
  new Function(...Object.keys(scope), "let desktopDataOwner=null,desktopDataDir=null,desktopRequestedDataDir=null,desktopSelectionActive=false;" + body + ";acquireDesktopDataOwner();")(...Object.values(scope));
  assert.deepEqual(calls, [["/fixture/userData", path.join("/fixture/home", ".murage")], "/new/data"]);
  assert.ok(source.includes('enabled: process.env.MURAGE_DATA_DIR === undefined && !desktopSelectionActive'));
});
test("separate supervisor publishes only after worker completion and releases only its new lease", async () => {
  const child = deferred(), events = [], plan = { dataDirectory: "/new/data", originalRoot: "/foreign/original" }, result = { ok: true, operation: "restore" };
  const owner = { release: () => events.push("release-new"), utilityServerLeaseEnvironment: () => {} };
  const scope = { canRestoreSeparateInstallation: () => true, allocateSeparateInstallation: value => { assert.equal(value, plan); return value; },
    acquireDataDirLease: value => { assert.equal(value, "/new/data"); return owner; },
    runDesktopRecovery: async (operation, parameters, authority) => { assert.equal(operation, "restore"); assert.equal(authority.owner, owner); await child.promise; return result; },
    publishInstallationSelection: (allocated, completed) => { assert.equal(allocated, plan); assert.equal(completed, result); events.push("publish"); }, desktopShutdownStarted: false, desktopDataDir: "/foreign/original",
    loadMemoryRestore: async () => ({ mergeOriginalMemoryDeletions: (from, to) => { assert.equal(from, "/foreign/original"); assert.equal(to, "/new/data"); events.push("merge"); } }) };
  const body = between("async function runSeparateDesktopRecovery(", "async function runEncryptedSeparateDesktopRecovery(")
    .replace(/await import\(pathToFileURL\(path\.join\(process\.resourcesPath,\s*"server",\s*"memory",\s*"restore\.js"\)\)\.href\)/, "await loadMemoryRestore()");
  const run = new Function(...Object.keys(scope), "let retainedSeparateDirectory=null;" + body + ";return runSeparateDesktopRecovery;")(...Object.values(scope));
  const pending = run({ archive: "/chosen/backup.zip", sha256: "a".repeat(64) }, plan);
  await pause(); assert.deepEqual(events, []);
  child.resolve(); assert.equal((await pending).retainedOriginal, "/foreign/original");
  assert.deepEqual(events, ["merge", "publish", "release-new"]);
});
test("normal mode and incomplete writer cleanup cannot fork a recovery worker", async () => {
  const normal = fixture({ mode: false });
  await assert.rejects(normal.run("rollback", {})); assert.equal(normal.forks(), 0);
  const held = fixture({ stop: async () => { throw new Error("still live"); } });
  await assert.rejects(held.run("rollback", {}), /still live/);
  assert.equal(held.forks(), 0); assert.equal(held.releases(), 0);
});
test("actual failed-server branch returns before background account work", async () => {
  const body = between('  if (app.isPackaged && !serverReady) {', '  if (serverReady && companionEnabledAtRest())');
  const events = [];
  const run = new Function("app", "serverReady", "serverStartConflictOnly", "serverStartSlow", "memoryUpgradeBlocked", "showDesktopRecovery", "events", body + ';events.push("background");');
  run({ isPackaged: true }, false, false, false, null, reason => events.push(reason), events);
  assert.deepEqual(events, ["STARTUP_FAILED"]);
  // a child that stayed alive and silent to the limit has its own reason, and still returns before background work
  const slow = [];
  run({ isPackaged: true }, false, false, true, null, reason => slow.push(reason), slow);
  assert.deepEqual(slow, ["STARTUP_SLOW"]);
  // an upgrade that could not run gets its own recovery reason, not the generic one
  const blocked = [];
  run({ isPackaged: true }, false, false, false, { state: "blocked" }, reason => blocked.push(reason), blocked);
  assert.deepEqual(blocked, ["MEMORY_UPGRADE_BLOCKED"]);
});
test("actual packaged early startup rejection opens recovery without exposing private error text", async () => {
  const body = between("const startupSettleDeps = {", 'app.on("window-all-closed"').replace('void settleDesktopStartup(desktopStartup', 'return settleDesktopStartup(desktopStartup');
  const calls = [];
  const startup = Promise.reject(new Error("PRIVATE_CREDENTIAL_CANARY"));
  const scope = { desktopStartup: startup, desktopShutdownStarted: false, closedBackupRequested: false, app: { isPackaged: true, quit: () => calls.push("quit") }, slog: value => calls.push(value), dialog: { showErrorBox: () => calls.push("error-box") }, showDesktopRecovery: code => calls.push(code) };
  Object.assign(scope, { settleDesktopStartup, terminalDesktopStartup, shutdownCause: null,
    recordStartupRefusal: () => {}, closeStartupSplash: () => {}, cleanupDesktopForExit: async () => {} });
  await new Function(...Object.keys(scope), body)(...Object.values(scope));
  assert.equal(calls.includes("STARTUP_FAILED"), true);
  assert.equal(calls.includes("quit"), false);
  assert.equal(JSON.stringify(calls).includes("PRIVATE_CREDENTIAL_CANARY"), false);
});
test("actual startup catch forwards foreign ownership code without private error text", async () => {
  const body = between("const startupSettleDeps = {", 'app.on("window-all-closed"').replace('void settleDesktopStartup(desktopStartup', 'return settleDesktopStartup(desktopStartup');
  const calls = [];
  const startup = Promise.reject(Object.assign(new Error("PRIVATE_ERROR_CANARY"), { name: "DataDirLeaseError", code: "LEASE_FOREIGN_HOST" }));
  const scope = { desktopStartup: startup, desktopShutdownStarted: false, closedBackupRequested: false, app: { isPackaged: true, quit: () => calls.push("quit") }, slog: value => calls.push(value), dialog: { showErrorBox: () => calls.push("error-box") }, showDesktopRecovery: code => calls.push(code) };
  Object.assign(scope, { settleDesktopStartup, terminalDesktopStartup, shutdownCause: null,
    recordStartupRefusal: () => {}, closeStartupSplash: () => {}, cleanupDesktopForExit: async () => {} });
  await new Function(...Object.keys(scope), body)(...Object.values(scope));
  assert.equal(calls.includes("LEASE_FOREIGN_HOST"), true);
  assert.equal(calls.includes("STARTUP_FAILED"), false);
  assert.equal(calls.includes("quit"), false);
  assert.equal(JSON.stringify(calls).includes("PRIVATE_ERROR_CANARY"), false);
});
test("failed acquisition retains location for diagnostics without granting ownership", () => {
  const body = between("function acquireDesktopDataOwner()", "function ownedDesktopDataDir()");
  const scope = { assertDesktopStartupActive() {}, app: { isPackaged: true, getPath: () => "/fixture/home" }, process: { env: { MURAGE_DATA_DIR: "/chosen/data" } }, path,
    dataDirLeasePaths: () => ({ canonicalDataDir: "/canonical/data" }), resolveInstallationSelection: (_user, data) => ({ dataDirectory: data, selected: false }), acquireDataDirLease: () => { throw Object.assign(new Error("foreign"), { code: "LEASE_FOREIGN_HOST" }); } };
  const result = new Function(...Object.keys(scope), "let desktopDataDir=null,desktopDataOwner=null,desktopRequestedDataDir=null,desktopSelectionActive=false;" + body + ";try{acquireDesktopDataOwner();}catch{}return {desktopDataDir,desktopDataOwner};")(...Object.values(scope));
  assert.deepEqual(result, { desktopDataDir: "/canonical/data", desktopDataOwner: null });
});
test("actual snapshot supervisor owns only the capture clone and restores its validated archive", async () => {
  const events = [], app = new EventEmitter(), window = new EventEmitter(); app.getPath = () => "/desktop";
  const captureDirectory = path.join("/desktop", "recovery-capture-fixture");
  const plan = { id: "fixture", dataDirectory: "/desktop/new/data" };
  const scope = { canCaptureSeparateInstallation: () => true, app, recoveryWindow: window, AbortController, fs: { existsSync: () => false }, path,
    desktopRequestedDataDir: "/foreign/original", desktopDataDir: "/foreign/original", planSeparateInstallation: () => plan,
    dataDirLeasePaths: () => ({ leasePath: "/foreign/.murage-data-owner-source.lease" }), process: { resourcesPath: "/resources", env: { PATH: "/runtime", SECRET: "excluded" } }, spawn() {},
    captureRecoveryCopy: async options => { assert.equal(options.source, "/foreign/original"); assert.equal(options.env.SECRET, undefined); assert.equal(await options.confirm({ destination: options.destination }), true); events.push("capture"); return { directory: options.destination }; },
    acquireDataDirLease: value => { assert.equal(value, captureDirectory); events.push("lease-clone"); return { release: () => events.push("release-clone") }; },
    runDesktopRecovery: async (operation, parameters, authority) => { assert.equal(operation, "backup"); assert.equal(authority.dataDirectory, captureDirectory); assert.equal(parameters.output, `${captureDirectory}.zip`); events.push("archive"); return { sha256: "a".repeat(64) }; },
    runSeparateDesktopRecovery: async (parameters, chosen, signal) => { assert.equal(chosen, plan); assert.equal(parameters.sha256, "a".repeat(64)); assert.equal(signal.aborted, false); events.push("restore-select"); return { status: "restored-review-required" }; } };
  const body = between("async function runSnapshotDesktopRecovery(", "async function runSeparateDesktopRecovery(");
  const run = new Function(...Object.keys(scope), "let retainedSeparateDirectory=null;" + body + ";return runSnapshotDesktopRecovery;")(...Object.values(scope));
  await run(async preview => { assert.equal(preview.installation, plan.dataDirectory); events.push("confirm"); return true; });
  assert.deepEqual(events, ["confirm", "capture", "lease-clone", "archive", "release-clone", "restore-select"]);
});

import vm from "node:vm";
import {createReturnAuthority} from "./backup-offline-return.mjs";
import {updateRecoveryCopy} from "./update-recovery-copy.mjs";
test("BF-3 T15 T25 actual failure and reopen functions retain the latest descriptor after writer shutdown",()=>{
  const events=[],authority=createReturnAuthority();let progress={destroy:()=>events.push("destroy")},descriptor;
  const scope={presentedCleanupFailures:new WeakSet(),returnAuthority:authority,desktopShutdownStarted:true,desktopCleanupStage:"owned harness",updateRequester:false,updateRecoveryDescriptor:null,recoveryWindow:null,
    takeBackupProgress:()=>{const p=progress;progress=null;return p;},
    showDesktopRecovery:(code,detail)=>{descriptor={reasonCode:code,...detail};scope.updateRecoveryDescriptor=descriptor;events.push("page");}};
  vm.createContext(scope);
  const failure=between("function cleanupFailed(","const returnToWorkspaceAfterBackup=");
  const pause=between("function pauseForReview(","function startUpdateGate(");
  const reopen=between("function reopenUpdateRecoveryIfNeeded(","let backupToolSettleUntil");
  vm.runInContext(failure+pause+reopen,scope);
  vm.runInContext('cleanupFailed(new Error("writer rejected"))',scope);
  assert.deepEqual(events,["destroy","page"]);assert.equal(progress,null);assert.equal(descriptor.cleanupFailure,true);assert.match(descriptor.detail,/writer rejected/);
  const saved={...descriptor};events.length=0;
  scope.recoveryWindow={isDestroyed:()=>false,focus:()=>events.push("focus")};vm.runInContext("reopenUpdateRecoveryIfNeeded()",scope);assert.deepEqual(events,["focus"]);scope.recoveryWindow=null;events.length=0;
  vm.runInContext("reopenUpdateRecoveryIfNeeded()",scope);assert.deepEqual(descriptor,saved);assert.deepEqual(events,["page"]);
  authority.userQuitRequested=true;events.length=0;vm.runInContext("reopenUpdateRecoveryIfNeeded()",scope);assert.deepEqual(events,[]);
  vm.runInContext('cleanupFailed(new Error("retry rejected"))',scope);assert.deepEqual(events,["page"]);assert.equal(descriptor.returnRevoked,true);
  const second=between('app.on("second-instance"','// Packaged: the harness');assert.ok(second.includes("reopenUpdateRecoveryIfNeeded()"));
  const recovery=between("function showDesktopRecovery(","function canRestoreSeparateInstallation(");assert.ok(recovery.includes("reopenUpdateRecoveryIfNeeded()"));
});
test("T1 T3 actual watchdog recovery ignores writer shutdown and respects explicit Quit",async()=>{
 const {createBackupReturn}=await import("./backup-offline-return.mjs");
 const callback=/recover:(async\(\)=>\{if\(returnAuthority.userQuitRequested\)[\s\S]*?return returnToWorkspaceAfterBackup\(\);\})/.exec(source);assert.ok(callback);
 for(const quit of [false,true]){
  const authority=createReturnAuthority();authority.userQuitRequested=quit;let relaunches=0,failures=0;
  const returnToWorkspaceAfterBackup=createBackupReturn({app:{quit(){},exit(){}},authority,cleanup:async()=>{},relaunch:()=>{relaunches++;},takeProgress:()=>null,setTimer:()=>{}});
  const recover=vm.runInNewContext('('+callback[1]+')',{returnAuthority:authority,desktopShutdownStarted:true,cuaCleanedUp:true,cleanupFailed:()=>{failures++;},returnToWorkspaceAfterBackup,refusal:code=>Error(code)});
  await recover();assert.equal(relaunches,quit?0:1);assert.equal(failures,0);
 }
});

import {runStartGate} from "./update-start-gate.mjs";
for(const kind of ["cancel","landed","installing","review","candidate","invalid","invalid-candidate","non-mac"])test(`T10 actual pending startup branch ${kind} keeps writers behind settlement`,async()=>{
 const calls=[],authority=createReturnAuthority(),candidate={version:["candidate","invalid-candidate"].includes(kind)?"1.0.0":"2.0.0"};
 const branch=between("  const upgrade=backupScheduleHost?.pendingUpgrade();",'  if(!process.argv.includes(BACKUP_MODE_ARGUMENT))');
 const start=between("function startUpdateGate(){","function reopenUpdateRecoveryIfNeeded(");
 const scope={returnAuthority:authority,runStartGate,backupScheduleHost:{pendingUpgrade:()=>({phase:"install-requested",candidate,...(["invalid","invalid-candidate"].includes(kind)?{hopsInvalid:true}:{})}),completeUpgrade:async()=>calls.push("complete")},
  app:{getVersion:()=>"1.0.0",getLocale:()=>"en"},process:{platform:kind==="non-mac"?"win32":"darwin"},backupToolCheck:Promise.resolve(),ensureDesktopUpdater:checks=>{assert.equal(checks,false);return {};},
  desktopRecoveryMode:false,startupDecisionPending:false,startupSplash:{set:()=>calls.push("splash-wait")},updateRecoveryWords:()=>({"installer-wait":"wait"}),desktopStartup:Promise.resolve(),
  settleUpdate:()=>{calls.push("probe");return {kind};},returnToWorkspaceAfterBackup:()=>{calls.push("return");return Promise.resolve();},prepareUpdateReturn:()=>({kind:"normal"}),pauseForReview:code=>calls.push(code),showDesktopRecovery:()=>calls.push("ordinary-recovery"),dialog:{showErrorBox:()=>calls.push("ordinary-copy")}};
 vm.createContext(scope);vm.runInContext(start,scope);await vm.runInContext('(async()=>{'+branch+'})()',scope);await Promise.resolve();
 authority.cancelGate?.();
 if(kind==="candidate")assert.deepEqual(calls,["complete"]);
 else if(["invalid","invalid-candidate"].includes(kind))assert.deepEqual(calls,["BACKUP_UPGRADE_REVIEW_REQUIRED"]);
 else if(kind==="non-mac")assert.deepEqual(calls,["splash-wait","ordinary-recovery","ordinary-copy"]);
 else {assert.equal(calls[0],"splash-wait");assert.equal(calls[1],"probe");if(kind==="review")assert.equal(calls[2],"BACKUP_UPGRADE_REVIEW_REQUIRED");if(["cancel","landed"].includes(kind))assert.equal(calls[2],"return");}
});

test("F2 hop reservation errors become terminal coded refusals",async()=>{
 const {createReturnAuthority,createBackupReturn}=await import("./backup-offline-return.mjs");
 const {refusal,runStartGate}=await import("./update-start-gate.mjs");
 for(const explicit of [false,true])for(const message of ["BACKUP_BUSY","CHANGED","disk full","exhausted"]){
  const pages=[],authority=createReturnAuthority();let cleanups=0;
  const scope={returnAuthority:authority,updateRequester:false,refusal,randomUUID:()=>"action",backupScheduleHost:{pendingUpgrade:()=>({phase:"install-requested"}),spendLandedHop:()=>{throw Error(message);}},settleUpdate:()=>({kind:"landed"}),runStartGate,pauseForReview:code=>pages.push(code)};
  scope.returnToWorkspaceAfterBackup=createBackupReturn({authority,app:{},cleanup:()=>{cleanups++;},relaunch:()=>assert.fail("no relaunch")});
  const body=between("function prepareUpdateReturn(","function pauseForReview(")+between("function startUpdateGate(","function reopenUpdateRecoveryIfNeeded(");
  const f=new Function(...Object.keys(scope),body+";return {prepareUpdateReturn,startUpdateGate};")(...Object.values(scope));
  const code=message==="BACKUP_BUSY"?"BACKUP_BUSY":"BACKUP_UPGRADE_REVIEW_REQUIRED";
  if(explicit)await assert.rejects(scope.returnToWorkspaceAfterBackup({prepare:()=>f.prepareUpdateReturn(true)}),e=>e.code===code);
  else{f.startUpdateGate();await pause();assert.deepEqual(pages,[code]);}
  assert.equal(cleanups,0);
 }
});

test("F5 unreadable coordinator cannot suppress cleanup failure presentation",()=>{
 const body=between('  let captureFailure = null, backupError = null','  const recovery = openInstallationRecoveryWindow(');
 const scope={backupScheduleHost:{internalStatus(){throw Error("unreadable");}},updateRecoveryWords:()=>updateRecoveryCopy,app:{getLocale:()=>"en"},descriptor:{updatePause:true,cleanupFailure:true,detail:"cleanup rejected"},reasonCode:"BACKUP_UPGRADE_CLEANUP_FAILED"};
 const reason=new Function(...Object.keys(scope),body+';return reason;')(...Object.values(scope));
 assert.match(reason,/cleanup rejected/);
});

test("F6 ordinary Retry prepares only inside the shared attempt",async()=>{
 const {createBackupReturn}=await import('./backup-offline-return.mjs');
 const {explicitBackupReturn}=await import('./backup-startup.mjs');
 const authority=createReturnAuthority(),held=deferred();let prepares=0,cancels=0;
 const returnToWorkspaceAfterBackup=createBackupReturn({authority,app:{quit(){},exit(){}},cleanup:()=>held.promise,relaunch(){},setTimer(){}});
 const scope={returnAuthority:authority,descriptor:{updatePause:false},updateRequester:false,backupScheduleHost:{prepareWorkspaceReturn(){prepares++;},pendingUpgrade:()=>({}),returnUpgradeToWorkspace(){cancels++;}},returnToWorkspaceAfterBackup,explicitBackupReturn,refusal:code=>Object.assign(Error(code),{code})};
 const callback=between('    retry: async () => {','    openDiagnostics:');
 const retry=new Function(...Object.keys(scope),'return ({'+callback+'}).retry;')(...Object.values(scope));
 const first=retry(),second=retry();assert.equal(prepares,1);assert.equal(cancels,1);held.resolve();await Promise.all([first,second]);
});

test("F7 ordinary restore retires armed handoff inside shared normal Return",async()=>{
 const {createBackupReturn}=await import('./backup-offline-return.mjs');
 const authority=createReturnAuthority(),held=deferred();let prepares=0;
 const returnToWorkspaceAfterBackup=createBackupReturn({authority,app:{quit(){},exit(){}},cleanup:()=>held.promise,relaunch:destination=>assert.equal(destination.kind,'normal'),setTimer(){}});
 const callback=between('    relaunchAfterRestore:','    context:');
 const restore=new Function('returnToWorkspaceAfterBackup','backupScheduleHost','return ({'+callback+'}).relaunchAfterRestore;')(returnToWorkspaceAfterBackup,{prepareWorkspaceReturn(){prepares++;},pendingUpgrade(){assert.fail('no settlement');}});
 const first=restore(),second=restore();assert.equal(first,second);assert.equal(prepares,1);held.resolve();await first;
});

test('F3 failed normal prelaunch cleanup leaves explicit Return available',async()=>{
 // Mutant: remove releasePendingInstall() from ensureDesktopUpdater's normal cleanup callback.
 const callbacks=[...source.matchAll(/cleanup:(\(\)=>\{(?:updateRequester=true;)?serverStopReason.note\("update"\);return cleanupDesktopForExit\("internal"\).catch\(error=>\{(?:returnAuthority.releasePendingInstall\(\);)?cleanupFailed\(error\);throw refusal\("BACKUP_UPGRADE_CLEANUP_FAILED"\);\}\);\})/g)];
 assert.equal(callbacks.length,1,'expected exactly one normal-update cleanup callback');
 const callback=callbacks[0];
 const scope={updateRequester:true,returnAuthority:{releasePendingInstall(){scope.updateRequester=false;}},serverStopReason:{note(){}},cleanupDesktopForExit:()=>Promise.reject(Error('cleanup rejected')),cleanupFailed(){assert.equal(scope.updateRequester,false);},refusal:code=>Object.assign(Error(code),{code})};vm.createContext(scope);
 const cleanup=vm.runInContext('('+callback[1]+')',scope);await assert.rejects(cleanup(),e=>e.code==='BACKUP_UPGRADE_CLEANUP_FAILED');assert.equal(scope.updateRequester,false);
});

test('F3 failed resumed prelaunch cleanup leaves explicit Return available',async()=>{
 // Mutant: remove releasePendingInstall() from resumeBackedUpInstall's cleanup callback.
 const callbacks=[...source.matchAll(/cleanup:(\(\)=>\{noteShutdownCause\("automatic"\);(?:updateRequester=true;)?serverStopReason.note\("update"\);return cleanupDesktopForExit\("internal"\).catch\(error=>\{(?:returnAuthority.releasePendingInstall\(\);)?cleanupFailed\(error\);throw refusal\("BACKUP_UPGRADE_CLEANUP_FAILED"\);\}\);\})/g)];
 assert.equal(callbacks.length,1,'expected exactly one resumed-update cleanup callback');
 const callback=callbacks[0];
 const scope={noteShutdownCause:cause=>assert.equal(cause,"automatic"),updateRequester:true,returnAuthority:{releasePendingInstall(){scope.updateRequester=false;}},serverStopReason:{note(){}},cleanupDesktopForExit:()=>Promise.reject(Error('cleanup rejected')),cleanupFailed(){assert.equal(scope.updateRequester,false);},refusal:code=>Object.assign(Error(code),{code})};vm.createContext(scope);
 const cleanup=vm.runInContext('('+callback[1]+')',scope);await assert.rejects(cleanup(),e=>e.code==='BACKUP_UPGRADE_CLEANUP_FAILED');assert.equal(scope.updateRequester,false);
});

test('F3 normal admission failure never claims launched requester authority',async()=>{
 const {prepareBackedUpInstall}=await import('./preupgrade-continuation.mjs');let options;
 const scope={process:{platform:'linux',env:{}},returnAuthority:createReturnAuthority(),backupScheduleHost:null,prepareBackedUpInstall,startUpdater:value=>{options=value;return {};},prepareUpdaterRestart:async()=>{throw Error('activity unavailable');}};
 const run=new Function(...Object.keys(scope),'let desktopUpdater,updateRequester=false;'+between('function ensureDesktopUpdater(','async function readBackupActivity(')+';ensureDesktopUpdater(false);return ()=>updateRequester;')(...Object.values(scope));
 await assert.rejects(options.beforeInstall({}),/activity unavailable/);assert.equal(run(),false);
});
