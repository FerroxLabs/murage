import assert from 'node:assert/strict';
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import test from 'node:test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { backupFixture, testAgeKeys } from '../server/testing/backup-fixture.ts';
import { verifiedBackupTool } from '../electron/backup-mode.mjs';
import { acquireDataDirLease } from '../electron/data-dir-lease.mjs';

// B20 Linux qualification fixture only: synthetic installation and generated key.
test('Linux fixed resource and built private worker capture inspect paused restore', {timeout:90000}, async()=>{
  assert.equal(process.platform,'linux'); assert.equal(process.arch,'x64');
  const f=backupFixture(), keys=testAgeKeys(); f.db.close();
  let lease;
  const diagnostics=[];
  try {
    const resources=join(f.parent,'Resources'), tool=join(resources,'backup-tools','x64','age');
    mkdirSync(dirname(tool),{recursive:true}); copyFileSync(keys.ageExecutable,tool);
    assert.equal(verifiedBackupTool(resources),tool);
    assert.ok(statSync(tool).mode & 0o111);
    assert.equal(createHash('sha256').update(readFileSync(tool)).digest('hex'),'eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c');
    const original=readFileSync(join(f.data,'config.json'));
    const keyFile=join(f.parent,'independent-recovery-key'); writeFileSync(keyFile,keys.identity,{mode:0o600});
    const run=async(args,delegated=false)=>{
      const identity=readFileSync(keyFile,'utf8');
      assert.equal(JSON.stringify(args).includes('AGE-SECRET'),false);
      const entry=pathToFileURL(resolve('dist-server/installation-recovery-worker.js')).href;
      const code=`import {parentPort} from 'node:worker_threads';const listeners=new Map();process.parentPort={on(name,fn){const wrap=data=>fn({data});listeners.set(fn,wrap);parentPort.on(name,wrap);},removeListener(name,fn){parentPort.removeListener(name,listeners.get(fn));},postMessage:value=>parentPort.postMessage(value)};process.argv=[process.execPath,'worker',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`;
      const env={PATH:dirname(process.execPath),HOME:f.parent,USERPROFILE:f.parent,...(delegated?lease.utilityServerLeaseEnvironment():{})};
      assert.equal(JSON.stringify(env).includes('AGE-SECRET'),false);
      const child=new Worker(new URL('data:text/javascript,'+encodeURIComponent(code)),{stdout:true,stderr:true,env});
      let result,inputs=0,logs='';
      child.stdout.on('data',c=>{logs+=c;}); child.stderr.on('data',c=>{logs+=c;});
      child.on('message',m=>{if(m.type==='murage:recovery-input-ready'){inputs++;child.postMessage({type:'murage:recovery-input',nonce:m.nonce,identity});}if(m.type==='murage:recovery-result'){result=m.result;child.postMessage({type:'murage:recovery-result-ack',nonce:m.nonce});}});
      const exit=await new Promise((res,rej)=>{const timer=setTimeout(()=>void child.terminate().then(()=>rej(Error('owned worker timeout'))),25000);child.once('error',e=>{clearTimeout(timer);rej(e);});child.once('exit',n=>{clearTimeout(timer);res(n);});});
      assert.equal(logs.includes('AGE-SECRET'),false);assert.equal(logs.includes('FAKE-CREDENTIAL-CANARY'),false);
      diagnostics.push({operation:args[0],exit,inputs,ok:result?.ok,error:result?.error});
      assert.equal(exit,0,JSON.stringify(diagnostics));assert.equal(inputs,1);assert.equal(result?.ok,true);
      return result;
    };
    lease=acquireDataDirLease(f.data);assert.throws(()=>acquireDataDirLease(f.data));
    const archive=join(f.parent,'backup.age');
    const saved=await run(['backup-encrypted','--data-dir',f.data,'--output',archive,'--age-tool',tool,'--recipient',keys.recipient,'--credential-policy','preserve-in-encrypted-fidelity'],true);
    assert.throws(()=>acquireDataDirLease(f.data));lease.release();lease=undefined;
    const inspected=await run(['inspect-encrypted','--archive',archive,'--age-tool',tool]);
    assert.equal(saved.sha256,inspected.sha256);assert.equal(inspected.activationAvailable,false);
    const target=join(f.parent,'restored');
    const restored=await run(['restore-encrypted-new','--data-dir',target,'--archive',archive,'--sha256',saved.sha256,'--age-tool',tool]);
    assert.equal(restored.activationAvailable,false);assert.equal(readFileSync(join(f.data,'config.json')).equals(original),true);
    assert.equal(readFileSync(join(target,'config.json'),'utf8').includes('FAKE-CREDENTIAL-CANARY'),false);
    assert.equal(existsSync(join(target,'startup-background.json')),false);
    const db=new DatabaseSync(join(target,'messages.db'),{readOnly:true});
    try {assert.equal(db.prepare('SELECT mode FROM memory_meta').get().mode,'paused');assert.equal(db.prepare('SELECT target_id FROM memory_tombstones').get().target_id,'forgotten');assert.match(db.prepare('SELECT json FROM messages').get().json,/WAL-visible transcript/);} finally {db.close();}
  } finally {lease?.release(); console.log('B20 Linux worker receipt:',JSON.stringify(diagnostics));safeWipeSync(f.parent);}
});
