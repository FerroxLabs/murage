// W-D2 (0.1.60 Windows customer re-test 2): on Windows the off-site password
// could be neither created nor chosen, so no off-site copy could ever be set
// up. The desktop passes its canonical data-folder path, which on Windows is
// case-folded (c:\users\sam lee\.murage). The remote control-folder check
// demanded realpathSync.native(folder) === folder, and the native realpath
// answers in the filesystem's own casing (C:\Users\Sam Lee). Every create and
// choose goes through that check first, so both always failed.
import assert from "node:assert/strict";
import test from "node:test";
import fs, {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {ensureRemoteControlDirectory,remoteWorkDirectory,remoteSshDirectory} from "./backup-remote-runtime.mjs";
import {createRemotePasswordStore} from "./backup-remote-password.mjs";
import {closedControlDirectory} from "./backup-closed-controller.mjs";

/** The native realpath of a Windows filesystem: same folder, its own casing. */
function nativeCasing(t){
 const original=fs.realpathSync.native;
 const native=(value,...rest)=>{const real=original(value,...rest);return real.replace(/[^/\\]+/g,part=>part[0].toUpperCase()+part.slice(1));};
 fs.realpathSync.native=native;syncBuiltinESMExports();
 const platform=Object.getOwnPropertyDescriptor(process,"platform");
 Object.defineProperty(process,"platform",{...platform,value:"win32"});
 t.after(()=>{Object.defineProperty(process,"platform",platform);fs.realpathSync.native=original;syncBuiltinESMExports();});
}

test("the off-site control folder accepts the case-folded data-folder spelling Windows hands it (W-D2)",{skip:process.platform!=="darwin"&&"needs a case-insensitive scratch volume to simulate NTFS"},t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-spelling-")));t.after(()=>safeWipeSync(root));
 const home=path.join(root,"sam lee");mkdirSync(path.join(home,".murage"),{recursive:true,mode:0o700});
 nativeCasing(t);
 const installation=path.join(home,".murage").toLowerCase(),control=closedControlDirectory(installation);
 assert.equal(ensureRemoteControlDirectory(control),control);
 // The same spelling drives the whole create flow the Backups page uses.
 const documents=path.join(home,"Documents");mkdirSync(documents);
 const store=createRemotePasswordStore({excludedRoots:()=>[installation,ensureRemoteControlDirectory(control)],readProtected:async()=>({}),updateProtected:async derive=>derive({}),
  createFolders:()=>[documents],createExcludedRoots:async()=>[],restrict:()=>{},uid:1});
 return store.create().then(created=>{assert.match(path.basename(created.path),/^murage-offsite-password\.txt$/i);});
});

test("a refused control folder is named as such, not as a bad password file (W-D2)",async t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-control-refused-")));t.after(()=>safeWipeSync(root));
 const file=path.join(root,"password.txt");writeFileSync(file,"FAKE_PASSWORD\n",{mode:0o600});
 const refusing=()=>{throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");};
 const store=createRemotePasswordStore({chooseFile:async()=>file,excludedRoots:refusing,readProtected:async()=>({}),updateProtected:async derive=>derive({}),createFolders:()=>[root]});
 await assert.rejects(store.create(),/^Error: BACKUP_REMOTE_CONTROL_UNAVAILABLE$/);
 await assert.rejects(store.select(),/^Error: BACKUP_REMOTE_CONTROL_UNAVAILABLE$/);
 assert.equal(readFileSync(file,"utf8"),"FAKE_PASSWORD\n");
});

test("real Windows: control folder, work tree and password file work through the case-folded spelling, owner-only (W-D2)",{skip:process.platform!=="win32"&&"real NTFS and icacls only"},async t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"Murage Remote Win-")));t.after(()=>safeWipeSync(root));
 const home=path.join(root,"Sam Lee");mkdirSync(path.join(home,".murage"),{recursive:true});
 const installation=path.join(home,".murage").toLowerCase(),control=closedControlDirectory(installation);
 assert.equal(ensureRemoteControlDirectory(control),control);
 const work=remoteWorkDirectory(control,"remote-one",0);
 assert.equal(fs.statSync(work).isDirectory(),true);
 // SSH material sits one level above every work tree, owner-only, far shorter.
 const ssh=remoteSshDirectory(control);
 assert.equal(path.dirname(path.dirname(work)).toLowerCase(),ssh.toLowerCase());assert.ok(ssh.length<work.length-30);
 const documents=path.join(home,"Documents");mkdirSync(documents);
 const store=createRemotePasswordStore({excludedRoots:()=>[installation,ensureRemoteControlDirectory(control)],readProtected:async()=>({}),updateProtected:async derive=>derive({}),createFolders:()=>[documents]});
 const created=await store.create();
 assert.equal(path.dirname(created.path).toLowerCase(),documents.toLowerCase());
});
