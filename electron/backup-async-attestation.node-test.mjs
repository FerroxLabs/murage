import test from 'node:test';
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {createHash} from 'node:crypto';
import {signedAgeOwnedByCurrentAppAsync,AGE_ORIGINAL_SHA256,asyncBackupCodesign} from './backup-age-attestation.mjs';
import {signedResticOwnedByCurrentAppAsync} from './backup-restic-attestation.mjs';
import {RESTIC_ORIGINAL_SHA256} from '../shared/backup-restic-pin.mjs';
for(const [name,verify,pin] of [['age',signedAgeOwnedByCurrentAppAsync,AGE_ORIGINAL_SHA256,asyncBackupCodesign],['restic',signedResticOwnedByCurrentAppAsync,RESTIC_ORIGINAL_SHA256]]){
 test(`${name} async trust preserves actual payload and all signing decisions; await replacements and abort refuse`,async()=>{
  const bytes=readFileSync(new URL(`../dist-native/backup-${name}/arm64/${name}`,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),pin,'Actual pinned asset precondition');
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'murage-async-attestation-'))),app=path.join(root,'Murage.app'),file=path.join(app,'Contents/Resources/backup-tools/arm64',name),currentExecutable=path.join(app,'Contents/MacOS/Murage');mkdirSync(path.dirname(file),{recursive:true});mkdirSync(path.dirname(currentExecutable),{recursive:true});writeFileSync(file,bytes);writeFileSync(currentExecutable,'synthetic main');
  try{
   const calls=[];const run=async args=>{calls.push(args);await new Promise(r=>setTimeout(r,1));return {status:0,stderr:'TeamIdentifier=ABCDEFGHIJ\n'};};
   assert.equal(await verify(file,bytes,{currentExecutable,run}),true);assert.equal(calls.length,4);assert.deepEqual(calls[0],['--verify','--strict','-R','=anchor apple generic',app]);assert(calls[3][3].includes('certificate leaf[subject.OU] = "ABCDEFGHIJ"'));
   for(const result of [{status:1},{status:null,error:Error('timeout')},{status:0,error:Error('command error')}])assert.equal(await verify(file,bytes,{currentExecutable,run:async()=>result}),false);
   assert.equal(await verify(file,bytes,{currentExecutable,run:async args=>({status:0,stderr:args.at(-1)===file?'TeamIdentifier=OTHERTEAM1\n':'TeamIdentifier=ABCDEFGHIJ\n'})}),false);
   assert.equal(await verify(file,bytes,{currentExecutable:process.execPath,run}),false);
   const corrupt=Buffer.from(bytes);corrupt[4096]^=1;assert.equal(await verify(file,corrupt,{currentExecutable,run}),false);assert.equal(await verify(file,Buffer.alloc(0),{currentExecutable,run}),false);
   const link=path.join(root,'link');symlinkSync(file,link);assert.equal(await verify(link,bytes,{currentExecutable,run}),false);
   let heartbeat=false;const held=verify(file,bytes,{currentExecutable,run:async()=>{await new Promise(r=>setTimeout(r,5));assert(heartbeat);writeFileSync(currentExecutable,'replacement main');return{status:0,stderr:'TeamIdentifier=ABCDEFGHIJ\n'};}});setTimeout(()=>{heartbeat=true;},0);assert.equal(await held,false);
   const controller=new AbortController();assert.equal(await verify(file,bytes,{currentExecutable,signal:controller.signal,run:async()=>{controller.abort();return{status:0,stderr:'TeamIdentifier=ABCDEFGHIJ\n'};}}),false);
  }finally{safeWipeSync(root);}
 });
}

test('async command cancellation/output cap waits for actual child close',async()=>{
 for(const cause of ['abort','overflow']){
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:signal=>{assert.equal(signal,'SIGKILL');}}),controller=new AbortController();
  let settled=false;const result=asyncBackupCodesign(['--verify'],{signal:controller.signal,spawnCommand:(file,args,options)=>{assert.equal(file,'/usr/bin/codesign');assert.deepEqual(args,['--verify']);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);return child;}}).then(value=>{settled=true;return value;});
  if(cause==='abort')controller.abort();else child.stdout.write(Buffer.alloc(65537));await new Promise(r=>setImmediate(r));assert.equal(settled,false);child.emit('close',null);assert((await result).error);
 }
});
