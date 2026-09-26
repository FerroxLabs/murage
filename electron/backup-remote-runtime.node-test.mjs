import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,realpathSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {remoteWorkDirectory} from "./backup-remote-runtime.mjs";
import {trustedBackupResticExecutable} from "./backup-restic-attestation.mjs";
// Remote backup storage fails closed without a POSIX owner uid (process.getuid is
// unavailable on Windows), so its success paths are POSIX-only; they run on the
// macOS and Ubuntu CI legs, and the refusal cases still run on Windows.
const POSIX_ONLY=process.platform==="win32"&&"remote backup owner and mode checks are POSIX-only";
test("remote work is private, revision-specific and rejects foreign links",{skip:POSIX_ONLY},t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-runtime-test-")));t.after(()=>safeWipeSync(root));const control=path.join(root,".murage-backup-control","installation");
 const one=remoteWorkDirectory(control,"remote-one",1),two=remoteWorkDirectory(control,"remote-one",2);assert.notEqual(one,two);assert.equal(remoteWorkDirectory(control,"remote-one",1),one);
 assert.throws(()=>remoteWorkDirectory(control,"../escape",1));const outside=path.join(root,"outside");mkdirSync(outside);symlinkSync(outside,path.join(control,"remote","foreign"));assert.throws(()=>remoteWorkDirectory(control,"foreign",1));
});
test("restic lookup requires exact pinned bytes and rejects links",t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-tool-test-")));t.after(()=>safeWipeSync(root));const file=path.join(root,"restic"),link=path.join(root,"link");writeFileSync(file,"fake tool bytes",{mode:0o700});
 assert.equal(trustedBackupResticExecutable(file),false);symlinkSync(file,link);assert.equal(trustedBackupResticExecutable(link),false);
});
test("actual main remote handlers enforce arity and retain operations until settlement",async()=>{
 const source=readFileSync(new URL("./main.mjs",import.meta.url),"utf8"),tree=ts.createSourceFile("main.mjs",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const loop=tree.statements.find(node=>ts.isForOfStatement(node)&&node.getText(tree).includes('`backup-remote:${action}`'));assert.ok(loop);
 const handlers=new Map(),operations=new Set();let finish;
 const context={ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},backupRemoteHost:{connect:()=>new Promise(resolve=>{finish=resolve;})},backupRemoteOperations:operations,desktopShutdownStarted:false,desktopRecoveryMode:false,backupMode:{isPreparing:()=>false},backupScheduleHost:{isPreparing:()=>false}};
 vm.runInNewContext(loop.getText(tree),context);assert.equal(handlers.size,16);assert.throws(()=>handlers.get("backup-remote:applyRetention")({},"ref",1,{keepLast:1}),/INPUT_INVALID/);assert.throws(()=>handlers.get("backup-remote:saveMaintenanceCredentials")({},"ref",1),/INPUT_INVALID/);assert.throws(()=>handlers.get("backup-remote:connect")({},"ref"),/INPUT_INVALID/);assert.throws(()=>handlers.get("backup-remote:reconcileLatest")({},"ref",1),/INPUT_INVALID/);assert.throws(()=>handlers.get("backup-remote:downloadBackup")({},"ref",1),/INPUT_INVALID/);assert.throws(()=>handlers.get("backup-remote:setAutomaticUpload")({},"ref",1),/INPUT_INVALID/);assert.equal(handlers.has("backup-remote:runAutomaticUpload"),false);
 const pending=handlers.get("backup-remote:connect")({},"ref",1);assert.equal(operations.size,1);await Promise.resolve();finish({connected:true});await pending;await Promise.resolve();assert.equal(operations.size,0);
 context.desktopShutdownStarted=true;assert.throws(()=>handlers.get("backup-remote:connect")({},"ref",1),/UNAVAILABLE/);
 assert.ok(source.indexOf('Promise.allSettled([...backupRemoteOperations])')<source.indexOf('desktopCleanupStage = "installation lease release"'));
 const preload=readFileSync(new URL("./preload.cjs",import.meta.url),"utf8");for(const action of ["status","save","testConnection","trustServer","remove","selectRepositoryPassword","connect","uploadLatest","saveMaintenanceCredentials","previewRetention","applyRetention","clearRetentionReview"])assert.ok(preload.includes(`backup-remote:${action}`));
});
test("actual automatic polling owns work, skips busy/recovery/shutdown and stops its single timer",async()=>{
 const source=readFileSync(new URL("./main.mjs",import.meta.url),"utf8"),tree=ts.createSourceFile("main.mjs",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const names=["pollAutomaticRemoteBackup","startAutomaticRemoteBackups","stopAutomaticRemoteBackups"];
 const functions=tree.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text));assert.equal(functions.length,3);
 let calls=0,finish,busy=false,created=0,cleared=0;
 const operations=new Set(),context={backupRemoteTimer:null,backupRemoteOperations:operations,backupRemoteHost:{isPending:()=>false,runAutomaticUpload:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}},desktopShutdownStarted:false,desktopRecoveryMode:false,backupMode:{isPreparing:()=>busy},backupScheduleHost:{isPreparing:()=>false},setInterval:(_callback,delay)=>{assert.equal(delay,60000);created++;return{unref(){}};},clearInterval:()=>{cleared++;}};
 vm.createContext(context);vm.runInContext(functions.map(node=>node.getText(tree)).join("\n"),context);
 vm.runInContext("startAutomaticRemoteBackups();pollAutomaticRemoteBackup()",context);assert.equal(operations.size,1);await Promise.resolve();assert.equal(calls,1);
 finish();await Promise.allSettled([...operations]);await Promise.resolve();assert.equal(operations.size,0);
 busy=true;vm.runInContext("pollAutomaticRemoteBackup()",context);assert.equal(operations.size,0);busy=false;
 vm.runInContext("pollAutomaticRemoteBackup()",context);context.desktopShutdownStarted=true;await Promise.allSettled([...operations]);await Promise.resolve();assert.equal(calls,1);
 vm.runInContext("stopAutomaticRemoteBackups();startAutomaticRemoteBackups()",context);assert.equal(created,1);assert.equal(cleared,1);
 context.desktopShutdownStarted=false;context.desktopRecoveryMode=true;vm.runInContext("startAutomaticRemoteBackups();pollAutomaticRemoteBackup()",context);assert.equal(created,1);assert.equal(operations.size,0);
 assert.ok(source.indexOf('stopAutomaticRemoteBackups();',source.indexOf('function cleanupDesktopForExit()'))<source.indexOf('Promise.allSettled([...backupRemoteOperations])'));
});
