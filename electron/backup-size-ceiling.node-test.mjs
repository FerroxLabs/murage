// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit storage A4 (missed twice): a remote backup between 1 GiB and the
// schedule's size cap was "verified off-site" but Download could not write it
// out, because the export had its own 1 GiB default. One ceiling now.
import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {closeSync,existsSync,mkdirSync,mkdtempSync,openSync,readFileSync,readSync,readdirSync,realpathSync,statSync,truncateSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {safeWipeSync} from "../server/testing/safe-wipe.mjs";
import {exportRemoteBackup} from "./backup-remote-export.mjs";
import {MAX_BACKUP_BYTES} from "../shared/backup-max-bytes.mjs";
const POSIX_ONLY=process.platform==="win32"&&"remote backup owner and mode checks are POSIX-only";
const TWO_GIB=2*1024**3;
function sparseCopy(t,bytes){
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),"murage-size-ceiling-")));t.after(()=>safeWipeSync(root));
  const sourceRoot=path.join(root,"private"),restore=path.join(sourceRoot,"restore-abc123"),destination=path.join(root,"downloads");
  for(const dir of [sourceRoot,restore,destination])mkdirSync(dir,{mode:0o700});
  const archivePath=path.join(restore,"backup.age"),receiptPath=path.join(restore,"receipt.json");
  writeFileSync(archivePath,"",{mode:0o600});truncateSync(archivePath,bytes); // sparse: a fake 2 GiB, no disk used
  const hash=createHash("sha256"),fd=openSync(archivePath,"r"),buf=Buffer.alloc(1<<20);let at=0;
  while(at<bytes){const n=readSync(fd,buf,0,Math.min(buf.length,bytes-at),at);hash.update(buf.subarray(0,n));at+=n;}closeSync(fd);
  const receipt={bytes,sha256:hash.digest("hex")};writeFileSync(receiptPath,JSON.stringify(receipt),{mode:0o600});
  const copy={state:"downloaded-verified",snapshotId:"a".repeat(64),archivePath,receiptPath,receipt};
  return{root,sourceRoot,restore,destination,copy,options:{sourceRoot,excludedRoots:[sourceRoot]}};
}
test("a 2 GiB backup exports with the default ceiling, which is the one schedule/restore ceiling",{skip:POSIX_ONLY},t=>{
  assert.ok(MAX_BACKUP_BYTES>=50*1000**3&&TWO_GIB<MAX_BACKUP_BYTES);
  const f=sparseCopy(t,TWO_GIB),result=exportRemoteBackup(f.copy,f.destination,f.options);
  assert.equal(result.saved,true);assert.equal(statSync(result.archivePath).size,TWO_GIB);
});
test("a failed export removes the restore-* copy; a refused one too",{skip:POSIX_ONLY},t=>{
  const f=sparseCopy(t,4096);
  assert.throws(()=>exportRemoteBackup({...f.copy,receipt:{...f.copy.receipt,sha256:"0".repeat(64)}},f.destination,f.options),/UNCONFIRMED/);
  assert.equal(existsSync(f.restore),false);assert.deepEqual(readdirSync(f.destination),[]);
  const g=sparseCopy(t,4096);assert.throws(()=>exportRemoteBackup(g.copy,g.destination,{...g.options,maxBytes:100}),/UNCONFIRMED/);
  assert.equal(existsSync(g.restore),false);
});
test("a failed export leaves a non-restore source alone",{skip:POSIX_ONLY},t=>{
  const f=sparseCopy(t,4096);
  assert.throws(()=>exportRemoteBackup({...f.copy,receipt:{...f.copy.receipt,sha256:"0".repeat(64)}},f.destination,{...f.options,sourceRoot:f.restore}),/UNCONFIRMED/);
  assert.equal(existsSync(f.restore),true);
});
test("no backup code keeps its own size literal: everything uses MAX_BACKUP_BYTES",()=>{
  const root=path.resolve(import.meta.dirname,"..");
  const files=execFileSync("git",["ls-files","electron","server","shared"],{cwd:root,encoding:"utf8"}).split("\n")
    .filter(f=>/backup|installation-(archive|activation|fidelity|state|recovery)/i.test(f)&&/\.(mjs|ts|cjs)$/.test(f)&&!/test|\.d\.mts$/.test(f));
  assert.ok(files.length>20);
  // Platform/staging limits that are not the backup size ceiling.
  const allowed=new Map([["server/installation-encrypted-backup.ts","Windows 20 GiB staging cap"],["server/installation-activation.ts","restore headroom added to the ceiling"],["shared/backup-max-bytes.mjs","the definition"]]);
  const literal=/1024 ?\*\* ?[34]|1024 ?\* ?1024 ?\* ?1024|\b1073741824\b|\b1099511627776\b|\b53687091200\b|maxBytes ?= ?\d/;
  const found=files.filter(f=>!allowed.has(f)&&literal.test(readFileSync(path.join(root,f),"utf8")));
  assert.deepEqual(found,[]);
  const main=readFileSync(path.join(root,"electron/main.mjs"),"utf8");
  assert.ok(!/maxBytes>1024\*\*/.test(main)&&/maxBytes>MAX_BACKUP_BYTES/.test(main));
});
