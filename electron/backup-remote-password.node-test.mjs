import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,chmodSync,realpathSync} from "node:fs";
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
