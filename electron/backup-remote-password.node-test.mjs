import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,chmodSync,realpathSync,statSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {createRemotePasswordStore,BACKUP_REMOTE_PASSWORDS_KEY} from "./backup-remote-password.mjs";
// Remote backup storage fails closed without a POSIX owner uid (process.getuid is
// unavailable on Windows), so its success paths are POSIX-only; they run on the
// macOS and Ubuntu CI legs, and the refusal cases still run on Windows.
const POSIX_ONLY=process.platform==="win32"&&"remote backup owner and mode checks are POSIX-only";
function fixture(t){
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-password-test-")));t.after(()=>safeWipeSync(root));
 const installation=path.join(root,"installation"),file=path.join(root,"password.txt");mkdirSync(installation,{mode:0o700});writeFileSync(file,"FAKE_PASSWORD_CANARY\n",{mode:0o600});
 let document={untouched:"preserve"},chosen=file;
 const store=createRemotePasswordStore({chooseFile:async()=>chosen,excludedRoots:()=>[installation],readProtected:async()=>document,updateProtected:async derive=>{document=derive(document);},createId:()=>"password-one"});
 return{root,file,installation,store,document:()=>document,choose:value=>{chosen=value;},corrupt:()=>{document={[BACKUP_REMOTE_PASSWORDS_KEY]:"INVALID_PRIVATE_CANARY"};}};
}
test("independent password reference persists metadata only and returns bytes only to host",{skip:POSIX_ONLY},async t=>{
 const f=fixture(t),selected=await f.store.select();assert.deepEqual(selected,{passwordRef:"password-one"});assert.equal(JSON.stringify(f.document()).includes("FAKE_PASSWORD_CANARY"),false);assert.equal(f.document().untouched,"preserve");
 const bytes=await f.store.read(selected.passwordRef);assert.equal(bytes.toString(),"FAKE_PASSWORD_CANARY");bytes.fill(0);assert.equal(readFileSync(f.file,"utf8"),"FAKE_PASSWORD_CANARY\n");
});
test("cancel does not update and corrupted storage or unknown reference fails safely",async t=>{
 const f=fixture(t);f.choose(null);assert.equal(await f.store.select(),null);assert.deepEqual(f.document(),{untouched:"preserve"});await assert.rejects(f.store.read("unknown"),/^Error: BACKUP_REMOTE_PASSWORD_UNAVAILABLE$/);f.corrupt();await assert.rejects(f.store.read("password-one"),/^Error: BACKUP_REMOTE_PASSWORD_UNAVAILABLE$/);
});
test("rejects installation-contained, symlinked, public and multiline password files",async t=>{
 const f=fixture(t),inside=path.join(f.installation,"password.txt"),link=path.join(f.root,"link.txt");writeFileSync(inside,"FAKE",{mode:0o600});
 // A standard Windows user may not create file symlinks (no Developer Mode): that step needs the privilege.
 let linked=true;try{symlinkSync(f.file,link);}catch(error){if(process.platform!=="win32"||error.code!=="EPERM")throw error;linked=false;}
 // Each refusal is named for what the person can fix (W-D2), not one bare "unavailable".
 f.choose(inside);await assert.rejects(f.store.select(),/^Error: BACKUP_REMOTE_PASSWORD_FILE_PLACE$/);
 if(linked){f.choose(link);await assert.rejects(f.store.select(),/^Error: BACKUP_REMOTE_PASSWORD_FILE_KIND$/);}
 f.choose(path.join(f.root,"missing.txt"));await assert.rejects(f.store.select(),/^Error: BACKUP_REMOTE_PASSWORD_FILE_UNREADABLE$/);
 f.choose(f.file);if(process.platform!=="win32"){chmodSync(f.file,0o644);await assert.rejects(f.store.select(),/^Error: BACKUP_REMOTE_PASSWORD_FILE_SHARED$/);chmodSync(f.file,0o600);}
 writeFileSync(f.file,"");await assert.rejects(f.store.select(),/^Error: BACKUP_REMOTE_PASSWORD_FILE_KIND$/);
 for(const value of ["two\nlines","bad\0value"]){writeFileSync(f.file,value);await assert.rejects(f.store.select(),/^Error: BACKUP_REMOTE_PASSWORD_FILE_FORMAT$/);}assert.deepEqual(f.document(),{untouched:"preserve"});
});
test("changed file requires explicit reselection and does not reveal new content",{skip:POSIX_ONLY},async t=>{
 const f=fixture(t);await f.store.select();writeFileSync(f.file,"ROTATED_PRIVATE_CANARY");await assert.rejects(f.store.read("password-one"),/^Error: BACKUP_REMOTE_PASSWORD_UNAVAILABLE$/);
});
test("Murage creates the off-site password itself: owner-only file outside every excluded folder, never replaced, read back through the store",{skip:POSIX_ONLY},async t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-password-create-")));t.after(()=>safeWipeSync(root));
 const installation=path.join(root,"installation"),backups=path.join(root,"backups"),keys=path.join(root,"keys"),copies=path.join(root,"usb");
 for(const dir of [installation,backups,keys,copies])mkdirSync(dir,{mode:0o700});
 let document={},count=0,copyTarget=path.join(copies,"offsite-copy.txt");
 const store=createRemotePasswordStore({chooseFile:async()=>null,excludedRoots:()=>[installation],readProtected:async()=>document,updateProtected:async derive=>{document=derive(document);},createId:()=>`password-${++count}`,
  // The remembered key folder is inside the backup folder here, so it is skipped for the next one.
  createFolders:()=>[path.join(backups),installation,keys],createExcludedRoots:async()=>[backups],chooseCopyFile:async()=>copyTarget});
 const first=await store.create();assert.equal(first.passwordRef,"password-1");assert.equal(first.path,path.join(keys,"murage-offsite-password.txt"));
 const text=readFileSync(first.path,"utf8");assert.match(text,/^[A-Za-z0-9_-]{43}\n$/);assert.equal(statSync(first.path).mode&0o777,0o600);
 assert.equal(JSON.stringify(document).includes(text.trim()),false);assert.deepEqual(readdirSync(backups),[]);assert.deepEqual(readdirSync(installation),[]);
 assert.equal(Buffer.from(await store.read(first.passwordRef)).toString(),text.trim());
 const second=await store.create();assert.equal(second.path,path.join(keys,"murage-offsite-password-2.txt"));assert.equal(readFileSync(first.path,"utf8"),text);
 assert.notEqual(readFileSync(second.path,"utf8"),text);
 assert.deepEqual(await store.saveCopy(first.passwordRef),{saved:true,path:copyTarget});assert.equal(readFileSync(copyTarget,"utf8"),text);assert.equal(statSync(copyTarget).mode&0o777,0o600);
 await assert.rejects(store.saveCopy(first.passwordRef),/PASSWORD_UNAVAILABLE/);
 for(const refused of [path.join(installation,"x.txt"),path.join(backups,"x.txt"),"relative.txt"]){copyTarget=refused;await assert.rejects(store.saveCopy(first.passwordRef),/PASSWORD_UNAVAILABLE/);}
 copyTarget=null;assert.deepEqual(await store.saveCopy(first.passwordRef),{cancelled:true});
 const nowhere=createRemotePasswordStore({chooseFile:async()=>null,excludedRoots:()=>[installation],readProtected:async()=>document,updateProtected:async derive=>{document=derive(document);},createFolders:()=>[installation,path.join(root,"missing")]});
 await assert.rejects(nowhere.create(),/PASSWORD_UNAVAILABLE/);
});

// Runs the real module as if on Windows: mode bits and uid mean nothing
// there, so what counts is the ACL (W-A5) and how the file is born (K-10).
function asWindows(t){
 const platform=Object.getOwnPropertyDescriptor(process,"platform");
 Object.defineProperty(process,"platform",{...platform,value:"win32"});
 t.after(()=>Object.defineProperty(process,"platform",platform));
}
const ME="S-1-12-1-2743382473-1146318542-2395616179-3871231519";
const allow=(sid,mask=0x1f01ff,inherited=true)=>({allow:true,sid,mask,inherited});
const DOCUMENTS_ACL={owner:ME,protected:false,rules:[allow("S-1-5-18"),allow("S-1-5-32-544"),allow(ME)]};
const PUBLIC_ACL={owner:ME,protected:false,rules:[...DOCUMENTS_ACL.rules,allow("S-1-5-4",0x1200a9),allow("S-1-5-32-545",0x1200a9)]};
async function windowsSelect(t,acl){
 const {aclIsPrivateToOwner}=await import("./backup-windows-acl.mjs");
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-password-win-")));t.after(()=>safeWipeSync(root));
 const file=path.join(root,"shared-password.txt");writeFileSync(file,"correct horse battery staple\n");chmodSync(file,0o644);
 let document={};const checked=[];
 asWindows(t);
 const store=createRemotePasswordStore({chooseFile:async()=>file,excludedRoots:()=>[],readProtected:async()=>document,updateProtected:async derive=>{document=derive(document);},createId:()=>"ref1",
  checkPrivate:target=>{checked.push(target);if(acl instanceof Error)throw acl;if(!aclIsPrivateToOwner(acl,ME))throw Error("BACKUP_WINDOWS_ACL_SHARED");}});
 return{store,checked,file,document:()=>document};
}
test("Windows: a chosen password file other accounts can open is refused by name (W-A5)",async t=>{
 const f=await windowsSelect(t,PUBLIC_ACL);
 await assert.rejects(f.store.select(),/^Error: BACKUP_REMOTE_PASSWORD_FILE_SHARED_WINDOWS$/);
 assert.deepEqual(f.checked,[f.file]);assert.deepEqual(f.document(),{});
});
test("Windows: a chosen password file only its owner (and the machine's administrators) can open is accepted (W-A5)",async t=>{
 const f=await windowsSelect(t,DOCUMENTS_ACL);
 assert.deepEqual(await f.store.select(),{passwordRef:"ref1"});
 // Every later read checks again: a file shared afterwards stops working.
 const bytes=await f.store.read("ref1");assert.equal(bytes.toString(),"correct horse battery staple");bytes.fill(0);
 assert.equal(f.checked.length,2);
});
test("Windows: when the ACL can't be read, the file is refused, never trusted (W-A5)",async t=>{
 const f=await windowsSelect(t,Error("BACKUP_WINDOWS_ACL_FAILED"));
 await assert.rejects(f.store.select(),/^Error: BACKUP_REMOTE_PASSWORD_FILE_UNREADABLE$/);
});
test("Windows: the new password file is owner-only before any byte is written, and never replaces a file (K-10)",async t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-password-born-")));t.after(()=>safeWipeSync(root));
 const documents=path.join(root,"Documents");mkdirSync(documents);writeFileSync(path.join(documents,"murage-offsite-password.txt"),"someone else's file\n");
 const events=[],restricted=new Set();
 asWindows(t);
 const store=createRemotePasswordStore({excludedRoots:()=>[],readProtected:async()=>({}),updateProtected:async derive=>derive({}),createFolders:()=>[documents],createId:()=>"ref1",stageId:()=>"stage-1",
  restrictDirectory:directory=>{events.push(["directory",path.relative(root,directory),readdirSync(directory).length]);restricted.add(directory);},
  restrict:file=>{assert.ok(restricted.has(path.dirname(file)),"file is born inside the restricted folder");events.push(["file",path.relative(root,file),statSync(file).size]);},
  checkPrivate:()=>{}});
 const created=await store.create();
 assert.equal(created.path,path.join(documents,"murage-offsite-password-2.txt"));
 // The private folder was restricted while empty; the file was written inside it, then restricted.
 assert.deepEqual(events,[["directory",path.join("Documents",".murage-offsite-stage-1"),0],["file",path.join("Documents",".murage-offsite-stage-1","password"),44]]);
 assert.equal(readFileSync(path.join(documents,"murage-offsite-password.txt"),"utf8"),"someone else's file\n");
 assert.equal(statSync(created.path).nlink,1);
 assert.deepEqual(readdirSync(documents).sort(),["murage-offsite-password-2.txt","murage-offsite-password.txt"]);
});
test("Windows: a failed lock-down leaves no password file and no staging folder behind (K-10)",async t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-password-fail-")));t.after(()=>safeWipeSync(root));
 asWindows(t);
 const store=createRemotePasswordStore({excludedRoots:()=>[],readProtected:async()=>({}),updateProtected:async derive=>derive({}),createFolders:()=>[root],
  restrictDirectory:()=>{},restrict:()=>{throw Error("BACKUP_WINDOWS_ACL_FAILED");},checkPrivate:()=>{}});
 await assert.rejects(store.create(),/^Error: BACKUP_REMOTE_PASSWORD_UNAVAILABLE$/);
 assert.deepEqual(readdirSync(root),[]);
});
test("Windows: a saved copy is born owner-only the same way and refuses an existing name (K-10)",async t=>{
 const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-password-copy-")));t.after(()=>safeWipeSync(root));
 const source=path.join(root,"password.txt"),usb=path.join(root,"usb"),usbFat=path.join(root,"usb-fat");writeFileSync(source,"FAKE_COPY_CANARY\n",{mode:0o600});mkdirSync(usb);mkdirSync(usbFat);
 let document={};const events=[];let target=path.join(usb,"copy.txt");
 asWindows(t);
 const store=createRemotePasswordStore({chooseFile:async()=>source,excludedRoots:()=>[],readProtected:async()=>document,updateProtected:async derive=>{document=derive(document);},createId:()=>"ref1",chooseCopyFile:async()=>target,
  restrictDirectory:directory=>events.push(["directory",readdirSync(directory).length]),restrict:file=>events.push(["file",statSync(file).size]),checkPrivate:()=>{},keepsAcls:folder=>folder!==usbFat});
 await store.select();
 assert.deepEqual(await store.saveCopy("ref1"),{saved:true,path:target});
 assert.deepEqual(events,[["directory",0],["file",17]]);assert.equal(readFileSync(target,"utf8"),"FAKE_COPY_CANARY\n");assert.deepEqual(readdirSync(usb),["copy.txt"]);
 await assert.rejects(store.saveCopy("ref1"),/^Error: BACKUP_REMOTE_PASSWORD_UNAVAILABLE$/);
 assert.equal(readFileSync(target,"utf8"),"FAKE_COPY_CANARY\n");assert.deepEqual(readdirSync(usb),["copy.txt"]);
 // A FAT32 or exFAT stick has no ACLs: written plainly, still never over a file.
 target=path.join(usbFat,"copy.txt");events.length=0;
 assert.deepEqual(await store.saveCopy("ref1"),{saved:true,path:target});assert.deepEqual(events,[]);assert.equal(readFileSync(target,"utf8"),"FAKE_COPY_CANARY\n");
 await assert.rejects(store.saveCopy("ref1"),/^Error: BACKUP_REMOTE_PASSWORD_UNAVAILABLE$/);
});
