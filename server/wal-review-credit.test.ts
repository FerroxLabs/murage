// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
const fakeState=vi.hoisted(()=>{vi.resetModules();return {constructors:0};});
// Run the exact worker program against fake SQLite passes and a sparse WAL.
// This covers publication AND owner admission without allocating/copying 3 GiB.
vi.mock('node:worker_threads',()=>({isMainThread:true,Worker:class extends EventEmitter{
 handler: (message:unknown)=>void=()=>{};
 constructor(source:string,options:{workerData:Record<string,unknown>}){super();fakeState.constructors++;const self=this;
  class FakeSQLite {exec(){} close(){} prepare(sql:string){return{all:()=>sql.includes('checkpoint')?[{busy:0,log:800000,checkpointed:800000}]:[{data_version:1,n:0}]};}}
  runInNewContext(source,{require:(name:string)=>name==='node:worker_threads'?{workerData:options.workerData,parentPort:{on:(_name:string,handler:(m:unknown)=>void)=>{self.handler=handler;},postMessage:(m:unknown)=>queueMicrotask(()=>self.emit('message',m)),close:()=>queueMicrotask(()=>self.emit('exit',0))}}:name==='node:sqlite'?{DatabaseSync:FakeSQLite}:name==='node:fs'?{...fs,statfsSync:()=>({bavail:1e9,bsize:4096})}:name==='node:child_process'?{spawn:()=>({})}:requireMissing(name),process,Buffer,performance,setImmediate,setInterval:()=>({unref(){}}),clearInterval(){}});
 }
 unref(){} postMessage(message:unknown){this.handler(message);} async terminate(){this.emit('exit',0);return 0;}
}}));
function requireMissing(name:string):never{throw Error('unexpected fake dependency '+name);}
import * as wal from './wal-maintenance.ts';
import { removeTempDirSync } from "./testing/cleanup.ts";
let dir='';
afterEach(async()=>{await wal.stopWalMaintenance(10,10);if(dir)removeTempDirSync(dir);});
it('R4: a fully copied WAL above 2 GiB regains owner admission; growth removes credit',async()=>{
 dir=fs.mkdtempSync(join(tmpdir(),'murage-wal-credit-'));const file=join(dir,'messages.db');fs.writeFileSync(file,'');
 const size=32+800000*4120,head=Buffer.alloc(32);head.writeUInt32BE(0x377f0682,0);head.writeUInt32BE(4096,8);head.writeUInt32BE(7,16);head.writeUInt32BE(9,20);
 fs.writeFileSync(file+'-wal',head);fs.truncateSync(file+'-wal',size);
 wal.startWalMaintenance(file,{nudge:async()=>false,setAutocheckpoint:()=>{}});
 await new Promise(r=>setTimeout(r,10));expect(fakeState.constructors).toBe(1);expect(wal.walMaintenanceReady()).toBe(true);
 expect(()=>wal.assertWalWriteAdmission(file)).toThrow(/Busy/);
 const result=await wal.checkpointPassive();expect(result).toEqual({busy:0,log:800000,checkpointed:800000});
 expect(()=>wal.assertWalWriteAdmission(file)).not.toThrow();
 fs.truncateSync(file+'-wal',size+4120);expect(()=>wal.assertWalWriteAdmission(file)).toThrow(/Busy/);
});
