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
 const f=fixture(t),inside=path.join(f.installation,"password.txt"),link=path.join(f.root,"link.txt");writeFileSync(inside,"FAKE",{mode:0o600});symlinkSync(f.file,link);
 for(const file of [inside,link]){f.choose(file);await assert.rejects(f.store.select(),/PASSWORD_UNAVAILABLE/);}
 f.choose(f.file);chmodSync(f.file,0o644);await assert.rejects(f.store.select(),/PASSWORD_UNAVAILABLE/);chmodSync(f.file,0o600);
 for(const value of ["","two\nlines","bad\0value"]){writeFileSync(f.file,value);await assert.rejects(f.store.select(),/PASSWORD_UNAVAILABLE/);}assert.deepEqual(f.document(),{untouched:"preserve"});
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
