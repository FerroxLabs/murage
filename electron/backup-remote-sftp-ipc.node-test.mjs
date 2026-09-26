// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The window's off-site calls go through the REAL preload.cjs and the REAL
// backup-remote:* handler loop from main.mjs, into the real remote host from
// dist-server. A mocked bridge hid a "Turn on backups" bug once (preload sent
// [undefined], main refused it), so nothing between the button and the host is
// replaced here; only the storage adapter behind the host is a fixture.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync,realpathSync,symlinkSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {createBackupRemoteHost} from "../dist-server/backup-remote-host.js";
import {forgetRemoteWorkDirectory,remoteWorkDirectory} from "./backup-remote-runtime.mjs";

const POSIX_ONLY=process.platform==="win32"&&"remote backup owner and mode checks are POSIX-only";
const ORIGIN="http://127.0.0.1:47321";
const blob=fill=>{const name=Buffer.from("ssh-ed25519"),length=Buffer.alloc(4);length.writeUInt32BE(name.length);const body=Buffer.alloc(36,fill);body.writeUInt32BE(32);return Buffer.concat([length,name,body]).toString("base64");};
const receipt={jobId:"a".repeat(64),installationRef:"install",destinationRef:"local",selectionHash:"b".repeat(64),snapshotId:"97d4fa8e-2c50-4cba-a66f-a7bb84b13d42",artifactRef:"artifact",sha256:"c".repeat(64),bytes:10,verifiedAt:1};

/** main.mjs's own handler loop, run against a fake ipcMain. */
function mainHandlers(context){
 const source=readFileSync(new URL("./main.mjs",import.meta.url),"utf8"),tree=ts.createSourceFile("main.mjs",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const loop=tree.statements.find(node=>ts.isForOfStatement(node)&&node.getText(tree).includes("`backup-remote:${action}`"));assert.ok(loop,"main.mjs backup-remote loop");
 const handlers=new Map();vm.runInNewContext(loop.getText(tree),{...context,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)}});
 return handlers;
}
/** preload.cjs as Electron loads it, with ipcRenderer.invoke carried to main's handlers. */
function preloadBridge(handlers,crossings){
 const exposed={};
 const invoke=async(channel,...args)=>{
  crossings.push({channel,args:structuredClone(args),count:args.length});
  const handler=handlers.get(channel);if(!handler)throw Error(`No handler registered for '${channel}'`);
  try{const value=await handler({senderFrame:{url:ORIGIN}},...structuredClone(args));const copy=value===undefined?undefined:structuredClone(value);crossings.push({channel,result:copy});return copy;}
  catch(error){throw Error(`Error invoking remote method '${channel}': Error: ${error.message}`);}
 };
 const electron={contextBridge:{exposeInMainWorld:(name,api)=>{exposed[name]=api;}},ipcRenderer:{invoke,on:()=>{},once:()=>{},send:()=>{},removeListener:()=>{},removeAllListeners:()=>{}},webUtils:{getPathForFile:()=>""}};
 const source=readFileSync(new URL("./preload.cjs",import.meta.url),"utf8");
 const context={require:name=>{if(name==="electron")return electron;throw Error("preload may not require "+name);},process:{argv:[`--murage-renderer-origin=${ORIGIN}`],platform:process.platform,env:{}},location:{origin:ORIGIN},console,setTimeout,clearTimeout,URL,module:{exports:{}},exports:{}};
 context.globalThis=context;vm.runInNewContext(source,context);assert.ok(exposed.muragebox?.backupRemote,"preload exposed backupRemote");
 return exposed.muragebox.backupRemote;
}

function fixture(){
 let document={},count=0,scanned=blob(1);const connected=new Set(),crossings=[],forgotten=[],downloads=[];
 const host=createBackupRemoteHost({supported:()=>true,readProtected:async()=>structuredClone(document),updateProtected:async derive=>{document=derive(structuredClone(document));},
  selectPassword:async()=>({passwordRef:"independent-password"}),latestVerified:async()=>({archivePath:"/host/verified.age",receipt}),latestReceipt:()=>receipt,now:()=>10,createId:()=>`ref-${++count}`,
  chooseDownloadFolder:async()=>"/chosen",exportDownloaded:async copy=>{downloads.push(copy.snapshotId);return{saved:true,archivePath:"/chosen/Murage-backup-x/backup.age",directory:"/chosen/Murage-backup-x"};},
  forgetLocalState:ref=>{forgotten.push(ref);},
  createAdapter:binding=>{const id=`${binding.target.remoteRef}:${binding.target.revision}`;return{
   connectionStatus:()=>({state:connected.has(id)?"connected":"disconnected",repositoryId:"d".repeat(64)}),
   connect:async()=>({connected:true,remoteRef:binding.target.remoteRef,revision:binding.target.revision,repositoryId:"d".repeat(64)}),
   scanServerIdentity:async()=>{assert.equal(binding.credentials.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"),true);return{type:"ssh-ed25519",key:scanned,fingerprint:"SHA256:"+createHash("sha256").update(Buffer.from(scanned,"base64")).digest("base64").replace(/=+$/,"")};},
   prepareRepository:async()=>{assert.ok(binding.target.hostKey,"never prepared without a pinned identity");connected.add(id);return{connected:true,created:true,remoteRef:binding.target.remoteRef,revision:binding.target.revision,repositoryId:"d".repeat(64)};},
   store:async()=>({state:"verified",snapshotId:"e".repeat(64)}),
   listBackups:async()=>({repositoryId:"d".repeat(64),backups:[{snapshotId:"e".repeat(64),jobId:receipt.jobId,createdAt:5,verified:false}],ignored:0}),
   downloadBackup:async snapshotId=>({state:"downloaded-verified",snapshotId,repositoryId:"d".repeat(64),archivePath:"/private/backup.age",receiptPath:"/private/receipt.json",receipt}),
  };}});
 const operations=new Set();
 const handlers=mainHandlers({backupRemoteHost:host,backupRemoteOperations:operations,desktopShutdownStarted:false,desktopRecoveryMode:false,backupMode:{isPreparing:()=>false},backupScheduleHost:{isPreparing:()=>false}});
 return{bridge:preloadBridge(handlers,crossings),handlers,crossings,forgotten,downloads,document:()=>document,setScanned:key=>{scanned=key;}};
}

test("SFTP set-up, trust, connect, upload, recover and remove through the real preload and main handlers",async()=>{
 const f=fixture(),api=f.bridge;
 for(const name of ["testConnection","trustServer","remove"])assert.equal(typeof api[name],"function",`preload offers ${name}`);
 assert.deepEqual(await api.save(0,{kind:"sftp",label:"Home NAS",host:"nas.example.com",port:22,user:"backup",folder:"murage-backups"}),{saved:true});
 let status=await api.status();assert.equal(status.kind,"sftp");assert.match(status.sftp.publicKey,/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ murage-backup$/);
 const ref=status.remoteRef;await api.selectRepositoryPassword(ref,1);
 const first=await api.testConnection(ref,2);assert.equal(first.state,"trust-required");assert.match(first.fingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);
 assert.deepEqual(await api.trustServer(ref,2,first.fingerprint),{trusted:true,fingerprint:first.fingerprint});
 const connected=await api.testConnection(ref,3);assert.deepEqual(connected,{state:"connected",created:true,remoteRef:ref,revision:3,repositoryId:"d".repeat(64)});
 status=await api.status();assert.equal(status.state,"connected");assert.equal(status.sftp.fingerprint,first.fingerprint);
 assert.equal((await api.uploadLatest(ref,3,receipt.jobId)).state,"verified");
 const catalogue=await api.listBackups(ref,3);assert.equal(catalogue.backups.length,1);
 assert.deepEqual(await api.downloadBackup(ref,3,catalogue.backups[0].snapshotId),{saved:true,archivePath:"/chosen/Murage-backup-x/backup.age",directory:"/chosen/Murage-backup-x"});assert.deepEqual(f.downloads,["e".repeat(64)]);
 assert.deepEqual(await api.remove(ref,3),{removed:true});assert.deepEqual(f.forgotten,[ref]);
 assert.equal((await api.status()).configured,false);
 // Every call the bridge made carried exactly main's arity, and no value in
 // either direction ever held the private key.
 const arity={status:0,save:2,testConnection:2,trustServer:3,remove:2,selectRepositoryPassword:2,uploadLatest:3,listBackups:2,downloadBackup:3};
 for(const crossing of f.crossings.filter(item=>"count" in item))assert.equal(crossing.count,arity[crossing.channel.slice("backup-remote:".length)],crossing.channel);
 const everything=JSON.stringify(f.crossings);assert.equal(everything.includes("PRIVATE KEY"),false);assert.equal(everything.includes("privateKey"),false);
 assert.equal(JSON.stringify(f.document()).includes("PRIVATE KEY"),false);
});

test("the handlers refuse wrong arity, a changed server and option-shaped fields",async()=>{
 const f=fixture(),api=f.bridge;
 assert.throws(()=>f.handlers.get("backup-remote:testConnection")({},"ref"),/INPUT_INVALID/);
 assert.throws(()=>f.handlers.get("backup-remote:trustServer")({},"ref",1),/INPUT_INVALID/);
 assert.throws(()=>f.handlers.get("backup-remote:remove")({},"ref",1,"extra"),/INPUT_INVALID/);
 await assert.rejects(api.save(0,{kind:"sftp",label:"x",host:"-oProxyCommand=touch /tmp/pwned",port:22,user:"backup",folder:"f"}),/BACKUP_REMOTE_INPUT_INVALID/);
 await assert.rejects(api.save(0,{kind:"sftp",label:"x",host:"nas",port:22,user:"backup",folder:"f",privateKey:"-----BEGIN OPENSSH PRIVATE KEY-----"}),/BACKUP_REMOTE_INPUT_INVALID/);
 await api.save(0,{kind:"sftp",label:"x",host:"nas",port:22,user:"backup",folder:"f"});const ref=(await api.status()).remoteRef;await api.selectRepositoryPassword(ref,1);
 const shown=await api.testConnection(ref,2);f.setScanned(blob(9));
 await assert.rejects(api.trustServer(ref,2,shown.fingerprint),/BACKUP_REMOTE_TRUST_CHANGED/);assert.equal((await api.status()).sftp.fingerprint,undefined);
});

test("forgetting a destination removes only its own work folder",{skip:POSIX_ONLY},t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-forget-test-")));t.after(()=>safeWipeSync(root));
 const control=path.join(root,".murage-backup-control","installation");
 const mine=remoteWorkDirectory(control,"remote-one",3),other=remoteWorkDirectory(control,"remote-two",1);
 mkdirSync(path.join(mine,"ssh-abc123"));writeFileSync(path.join(mine,"ssh-abc123","key"),"leftover",{mode:0o600});writeFileSync(path.join(other,"keep.json"),"{}");
 assert.equal(forgetRemoteWorkDirectory(control,"remote-one"),true);assert.equal(existsSync(path.join(control,"remote","remote-one")),false);
 assert.deepEqual(readdirSync(other),["keep.json"]);assert.equal(forgetRemoteWorkDirectory(control,"remote-one"),false);
 for(const bad of ["../escape","",".","remote/two","-x"])assert.throws(()=>forgetRemoteWorkDirectory(control,bad),/REVIEW_REQUIRED/);
 const outside=path.join(root,"outside");mkdirSync(outside);writeFileSync(path.join(outside,"precious"),"x");symlinkSync(outside,path.join(control,"remote","linked"));
 assert.throws(()=>forgetRemoteWorkDirectory(control,"linked"),/REVIEW_REQUIRED/);assert.equal(existsSync(path.join(outside,"precious")),true);
});
