import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,realpathSync,symlinkSync,statSync,chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {downloadFolderShared,exportRemoteBackup} from "./backup-remote-export.mjs";
// Remote backup storage fails closed without a POSIX owner uid (process.getuid is
// unavailable on Windows), so its success paths are POSIX-only; they run on the
// macOS and Ubuntu CI legs, and the refusal cases still run on Windows.
const POSIX_ONLY=process.platform==="win32"&&"remote backup owner and mode checks are POSIX-only";
function fixture(t){const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-remote-export-test-")));t.after(()=>safeWipeSync(root));const sourceRoot=path.join(root,"private"),destination=path.join(root,"downloads"),installation=path.join(root,"installation");for(const dir of [sourceRoot,destination,installation])mkdirSync(dir,{mode:0o700});const bytes=Buffer.from("synthetic encrypted backup");const receipt={bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};const copy={state:"downloaded-verified",snapshotId:"a".repeat(64),archivePath:path.join(sourceRoot,"backup.age"),receiptPath:path.join(sourceRoot,"receipt.json"),receipt};writeFileSync(copy.archivePath,bytes,{mode:0o600});writeFileSync(copy.receiptPath,JSON.stringify(receipt),{mode:0o600});return{root,sourceRoot,destination,installation,bytes,copy,options:{sourceRoot,excludedRoots:[installation,sourceRoot]}};}
test("exports a verified copy to a private new folder without changing source",{skip:POSIX_ONLY},t=>{const f=fixture(t),result=exportRemoteBackup(f.copy,f.destination,f.options);assert.equal(result.saved,true);assert.deepEqual(readFileSync(result.archivePath),f.bytes);assert.deepEqual(readFileSync(f.copy.archivePath),f.bytes);assert.deepEqual(readdirSync(result.directory).sort(),["backup.age","receipt.json"]);assert.equal(statSync(result.directory).mode&0o077,0);assert.equal(statSync(result.archivePath).nlink,1);});
test("refuses installation overlap, source links and hash mismatch",t=>{const f=fixture(t);assert.throws(()=>exportRemoteBackup(f.copy,f.installation,f.options),/UNCONFIRMED/);const link=path.join(f.sourceRoot,"link.age");symlinkSync(f.copy.archivePath,link);assert.throws(()=>exportRemoteBackup({...f.copy,archivePath:link},f.destination,f.options),/UNCONFIRMED/);writeFileSync(f.copy.archivePath,Buffer.alloc(f.bytes.length));assert.throws(()=>exportRemoteBackup(f.copy,f.destination,f.options),/UNCONFIRMED/);for(const dir of readdirSync(f.destination))assert.equal(readdirSync(path.join(f.destination,dir)).includes("backup.age"),false);});
test("an existing export folder is never overwritten",{skip:POSIX_ONLY},t=>{const f=fixture(t),options={...f.options,createId:()=>"11111111-1111-1111-1111-111111111111"};const first=exportRemoteBackup(f.copy,f.destination,options);assert.throws(()=>exportRemoteBackup(f.copy,f.destination,options),/UNCONFIRMED/);assert.deepEqual(readFileSync(first.archivePath),f.bytes);});
// 0.1.60 Linux D8: Ubuntu's ~/Documents is 775, and a download there failed
// with only "This step could not be confirmed".
test("a folder other accounts can change is refused by name, with nothing written",{skip:POSIX_ONLY},t=>{
  const f=fixture(t);chmodSync(f.destination,0o775);
  assert.equal(downloadFolderShared(f.destination),true);
  assert.throws(()=>exportRemoteBackup(f.copy,f.destination,f.options),/BACKUP_REMOTE_DOWNLOAD_FOLDER_SHARED/);
  assert.deepEqual(readdirSync(f.destination),[]);
  for(const mode of [0o700,0o750,0o755]){chmodSync(f.destination,mode);assert.equal(downloadFolderShared(f.destination),false,mode.toString(8));}
  chmodSync(f.destination,0o757);assert.equal(downloadFolderShared(f.destination),true);
  chmodSync(f.destination,0o750);assert.equal(exportRemoteBackup(f.copy,f.destination,f.options).saved,true);
});
test("downloadFolderShared: another owner is shared, Windows never is, a missing folder is left to the export",()=>{
  const stat=(uid,mode)=>()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid,mode});
  assert.equal(downloadFolderShared("/x",{platform:"linux",uid:1000,stat:stat(0,0o40755)}),true);
  assert.equal(downloadFolderShared("/x",{platform:"linux",uid:1000,stat:stat(1000,0o40700)}),false);
  assert.equal(downloadFolderShared("C:\\x",{platform:"win32",uid:undefined,stat:stat(0,0o40777)}),false);
  assert.equal(downloadFolderShared("/missing",{platform:"linux",uid:1000,stat:()=>{throw Error("ENOENT");}}),false);
});
