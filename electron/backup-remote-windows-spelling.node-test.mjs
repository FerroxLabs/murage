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
  createFolders:()=>[documents],createExcludedRoots:async()=>[],restrict:()=>{},restrictDirectory:()=>{},checkPrivate:()=>{},uid:1});
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
 assert.equal(path.dirname(path.dirname(work)).toLowerCase(),ssh.toLowerCase());assert.ok(ssh.length<work.length);
 const documents=path.join(home,"Documents");mkdirSync(documents);
 const store=createRemotePasswordStore({excludedRoots:()=>[installation,ensureRemoteControlDirectory(control)],readProtected:async()=>({}),updateProtected:async derive=>derive({}),createFolders:()=>[documents]});
 const created=await store.create();
 assert.equal(path.dirname(created.path).toLowerCase(),documents.toLowerCase());
});

test("Windows off-site state lives in a short folder under local app data, POSIX beside the data folder (W-D2, W-A4)",async()=>{
 const {remoteControlDirectory}=await import("./backup-remote-runtime.mjs");
 const digest="c9a82ed042c951deeb69a7b63e9ec69aed1bfc533b8ac2666f8c70dcb68da2b5";
 // A restored install's control folder, as it was on the VM.
 const restored=`c:\\users\\sam lee\\appdata\\roaming\\murage\\recovered-installations\\790e917b-f351-445f-8995-948856a70103\\.murage-backup-control\\${digest}`;
 const posix=`/home/sam/.murage-backup-control/${digest}`;
 assert.equal(remoteControlDirectory({control:posix,userData:"/home/sam/.config/murage",localAppData:null,platform:"linux"}),posix);
 const windows=remoteControlDirectory({control:restored,userData:"C:\\Users\\Sam Lee\\AppData\\Roaming\\murage",localAppData:"C:\\Users\\Sam Lee\\AppData\\Local",platform:"win32"});
 assert.equal(windows,`C:\\Users\\Sam Lee\\AppData\\Local\\murage\\offsite\\${digest.slice(0,16)}`);
 // remote\<uuid>\<revision>\ssh-XXXXXX\known_hosts, plus a mkdtemp name, stays well inside 248.
 const deepest=[windows,"remote","1932102c-386c-4e31-923b-bc7f5eabe20c","12345","restic-restore-XXXXXX","known_hosts"].join("\\");
 assert.ok(deepest.length<180,`${deepest.length}`);
 // Without usable local app data, a local userData still works.
 assert.equal(remoteControlDirectory({control:restored,userData:"C:\\Users\\Sam Lee\\AppData\\Roaming\\murage",localAppData:null,platform:"win32"}),`C:\\Users\\Sam Lee\\AppData\\Roaming\\murage\\offsite\\${digest.slice(0,16)}`);
 assert.throws(()=>remoteControlDirectory({control:"c:\\x\\not-a-digest",userData:"C:\\u",localAppData:"C:\\l",platform:"win32"}),/BACKUP_REMOTE_REVIEW_REQUIRED/);
});

// W-A4 (0.1.60 audit): with AppData\Roaming redirected to a network share
// (Folder Redirection in company estates) userData is a UNC path. icacls and
// ssh refuse it, so `<userData>\offsite` left off-site copies unavailable.
test("a redirected (UNC) AppData still gives a local off-site folder that icacls and ssh accept (W-A4)",async()=>{
 const {remoteControlDirectory}=await import("./backup-remote-runtime.mjs");
 const {ownerOnlyIcaclsArguments}=await import("./backup-windows-acl.mjs");
 const digest="a".repeat(64),control=`c:\\users\\sam lee\\.murage-backup-control\\${digest}`;
 const userData="\\\\fs01\\profiles$\\samlee\\AppData\\Roaming\\murage";
 const offsite=remoteControlDirectory({control,userData,localAppData:"C:\\Users\\samlee\\AppData\\Local",platform:"win32"});
 const remote=`${offsite}\\remote`;
 assert.doesNotThrow(()=>ownerOnlyIcaclsArguments(remote,"S-1-12-1-1-2-3-4",{directory:true}),remote);
 assert.ok(!remote.startsWith("\\\\"),`BackupRestic.sshScratch() refuses UNC: ${remote}`);
 // No usable local folder at all: refused up front, never a network path.
 assert.throws(()=>remoteControlDirectory({control,userData,localAppData:null,platform:"win32"}),/BACKUP_REMOTE_REVIEW_REQUIRED/);
 assert.throws(()=>remoteControlDirectory({control,userData,localAppData:"\\\\fs01\\local",platform:"win32"}),/BACKUP_REMOTE_REVIEW_REQUIRED/);
});
test("local app data is read from the environment in its real spelling, never as a network path (W-A4)",async()=>{
 const {localAppDataDirectory}=await import("./backup-remote-runtime.mjs");
 const realpath=value=>value.replace("SAMLEE~1","Sam Lee");
 assert.equal(localAppDataDirectory({LOCALAPPDATA:"C:\\Users\\SAMLEE~1\\AppData\\Local"},{realpath}),"C:\\Users\\Sam Lee\\AppData\\Local");
 for(const LOCALAPPDATA of [undefined,"","relative","\\\\fs01\\x","C:\\a\"b"])assert.equal(localAppDataDirectory({LOCALAPPDATA},{realpath}),null,String(LOCALAPPDATA));
 assert.equal(localAppDataDirectory({LOCALAPPDATA:"C:\\gone"},{realpath:()=>{throw Error("ENOENT");}}),null);
 assert.equal(localAppDataDirectory({LOCALAPPDATA:"H:\\x"},{realpath:()=>"\\\\?\\UNC\\fs01\\x"}),null);
});

test("real Windows: the off-site folder is created under local app data, owner-only below it (W-A4)",{skip:process.platform!=="win32"&&"real NTFS and icacls only"},async()=>{
 const {remoteControlDirectory,localAppDataDirectory,ensureRemoteControlDirectory,remoteSshDirectory}=await import("./backup-remote-runtime.mjs");
 const local=localAppDataDirectory();assert.ok(local);
 const control=remoteControlDirectory({control:`c:\\nowhere\\${"f".repeat(64)}`,userData:"\\\\fs01\\redirected",localAppData:local,platform:"win32"});
 assert.equal(ensureRemoteControlDirectory(control),control);
 const ssh=remoteSshDirectory(control);assert.ok(ssh.toLowerCase().startsWith(local.toLowerCase()));
 // Only the two empty folders this test made, one at a time, never recursively.
 fs.rmdirSync(ssh);fs.rmdirSync(control);
});
