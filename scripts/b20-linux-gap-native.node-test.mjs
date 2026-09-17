import assert from 'node:assert/strict';
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import test from 'node:test';
import { Readable } from 'node:stream';
import { copyFileSync, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { backupFixture, testAgeKeys } from '../server/testing/backup-fixture.ts';
import { verifiedBackupTool } from '../electron/backup-mode.mjs';
import { inspectEncryptedInstallationBackup, writeEncryptedInstallationBackup } from '../server/installation-encrypted-backup.ts';

// B20 Linux gap qualification only. The production APIs and the pinned age
// executable are used; every path/key/data directory is a synthetic fixture.
const selection={scope:'application-data',credentialPolicy:'preserve-in-encrypted-fidelity'};
const code=async promise=>{
  try { await promise; assert.fail('expected refusal'); }
  catch (error) { return error?.code; }
};

test('Linux age refuses held archive input aliases before decryption', { timeout: 90000 }, async () => {
  assert.equal(process.platform,'linux'); assert.equal(process.arch,'x64');
  const f=backupFixture(), keys=testAgeKeys(); f.db.close();
  try {
    const resources=join(f.parent,'Resources'), tool=join(resources,'backup-tools','x64','age');
    mkdirSync(dirname(tool),{recursive:true}); copyFileSync(keys.ageExecutable,tool);
    assert.equal(verifiedBackupTool(resources),tool);
    assert.ok(statSync(tool).mode&0o111);
    assert.equal(createHash('sha256').update(readFileSync(tool)).digest('hex'),'eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c');
    const archive=join(f.parent,'backup.age');
    await writeEncryptedInstallationBackup(f.data,archive,{...keys,ageExecutable:tool,selection});
    const link=join(f.parent,'archive-link.age'), hardlink=join(f.parent,'archive-hardlink.age');
    symlinkSync(archive,link); linkSync(archive,hardlink);
    assert.equal(await code(inspectEncryptedInstallationBackup(link,f.parent,{...keys,ageExecutable:tool})),'UNSAFE_ARCHIVE_FILE');
    assert.equal(await code(inspectEncryptedInstallationBackup(hardlink,f.parent,{...keys,ageExecutable:tool})),'UNSAFE_ARCHIVE_FILE');
    // Remove the alias before proving the original, single-link descriptor is
    // still admitted through the real age /dev/fd input path.
    rmSync(link); rmSync(hardlink);
    const inspected=await inspectEncryptedInstallationBackup(archive,f.parent,{...keys,ageExecutable:tool});
    try { assert.match(inspected.sha256,/^[a-f0-9]{64}$/); }
    finally { safeWipeSync(inspected.directory); }
  } finally { safeWipeSync(f.parent); }
});

test('Linux age decrypts only the descriptor held before synthetic pathname replacement', { timeout: 30000 }, async () => {
  assert.equal(process.platform,'linux');
  const f=backupFixture(), keys=testAgeKeys(); f.db.close();
  const originalSpawn=childProcess.spawn;
  try {
    const resources=join(f.parent,'Resources'), tool=join(resources,'backup-tools','x64','age');
    mkdirSync(dirname(tool),{recursive:true}); copyFileSync(keys.ageExecutable,tool);
    const archive=join(f.parent,'held.age'), replacement=join(f.parent,'replacement.age'), output=join(f.parent,'plain.txt');
    const original=Buffer.from('synthetic original ciphertext input');
    const substitute=Buffer.from('synthetic replacement ciphertext input');
    writeFileSync(archive,execFileSync(tool,['--encrypt','--recipient',keys.recipient,'--output','-'],{input:original,env:{PATH:''},maxBuffer:4096}));
    const replacementCiphertext=execFileSync(tool,['--encrypt','--recipient',keys.recipient,'--output','-'],{input:substitute,env:{PATH:''},maxBuffer:4096});
    writeFileSync(replacement,replacementCiphertext);
    const held=statSync(archive); let replaced=false;
    childProcess.spawn=(executable,args,options)=>{
      if(executable===tool&&Array.isArray(args)&&args.includes('--decrypt')&&args.includes('/dev/fd/3')){
        assert.equal(typeof options?.stdio?.[3],'number');
        const descriptor=fstatSync(options.stdio[3]);
        assert.equal(descriptor.dev,held.dev); assert.equal(descriptor.ino,held.ino);
        renameSync(replacement,archive); replaced=true;
      }
      return originalSpawn(executable,args,options);
    };
    syncBuiltinESMExports();
    const { decryptBackupFile }=await import(`../server/installation-backup-encryption.ts?held-input=${Date.now()}`);
    await decryptBackupFile(tool,keys.identity,archive,output,{maxBytes:4096});
    assert.equal(replaced,true); assert.deepEqual(readFileSync(output),original);
    assert.deepEqual(readFileSync(archive),replacementCiphertext);
  } finally { childProcess.spawn=originalSpawn; syncBuiltinESMExports(); safeWipeSync(f.parent); }
});

test('Linux age cancellation aborts an in-flight pinned child and removes output', { timeout: 30000 }, async () => {
  assert.equal(process.platform,'linux');
  const keys=testAgeKeys(), controller=new AbortController();
  const root=mkdtempSync(join(process.env.TMPDIR||'/tmp','murage-b20-cancel-'));
  const output=join(root,'backup.age'), originalSpawn=childProcess.spawn;
  let sent=false, child, childClosed, resolveOutput, confirmed=false;
  const stdoutStarted=new Promise(resolve=>{resolveOutput=resolve;});
  const input=new Readable({read(){
    if(!sent){sent=true;this.push(Buffer.alloc(64*1024,0x5a));}
    // Deliberately omit EOF: age remains in-flight after its first output.
  }});
  try {
    childProcess.spawn=(executable,args,options)=>{
      const started=originalSpawn(executable,args,options);
      if(executable===keys.ageExecutable&&Array.isArray(args)&&args.includes('--encrypt')){
        child=started;
        childClosed=new Promise(resolve=>started.once('close',(exit,signal)=>resolve({exit,signal})));
        started.stdout?.once('data',chunk=>resolveOutput({pid:started.pid,bytes:chunk.length}));
      }
      return started;
    };
    syncBuiltinESMExports();
    const { encryptBackupStream }=await import(`../server/installation-backup-encryption.ts?inflight-cancel=${Date.now()}`);
    const running=encryptBackupStream(keys.ageExecutable,keys.recipient,input,output,{maxBytes:8*1024**2,signal:controller.signal,closeTimeoutMs:5000});
    const started=await Promise.race([stdoutStarted,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('age produced no in-flight stdout')),5000))]);
    assert.equal(typeof started.pid,'number'); assert.ok(started.bytes>0); assert.ok(child);
    controller.abort(new Error('synthetic cancellation after age stdin began'));
    assert.equal(await code(running),'SNAPSHOT_CANCELLED');
    await Promise.race([childClosed,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('age child close unconfirmed')),5000))]);
    confirmed=true;
    assert.equal(existsSync(output),false);
  } finally {
    input.destroy(); childProcess.spawn=originalSpawn; syncBuiltinESMExports();
    if(confirmed)safeWipeSync(root);else console.error(`B20 retained cancellation fixture: ${root}`);
  }
});
