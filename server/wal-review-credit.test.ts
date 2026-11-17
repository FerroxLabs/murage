// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from './sqlite-open.ts';
import { afterEach, expect, it, vi } from 'vitest';
const fakeState=vi.hoisted(()=>{vi.resetModules();return {constructors:0};});
// This sparse-WAL VM models SQLite; native loading has separate real-worker witnesses.
vi.mock('./io-meter.ts',async importOriginal=>({...await importOriginal<typeof import('./io-meter.ts')>(),ioMeterNativePath:()=>undefined}));
// Run the exact worker program against fake SQLite passes and a sparse WAL.
// This covers publication AND owner admission without allocating/copying 3 GiB.
vi.mock('node:worker_threads',()=>({isMainThread:true,Worker:class extends EventEmitter{
 threadId=7;
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
let writer:DatabaseSync|undefined,reader:DatabaseSync|undefined;
afterEach(async()=>{await wal.stopWalMaintenance(10,10);reader?.close();writer?.close();reader=writer=undefined;if(dir)removeTempDirSync(dir);});
function realWal(prefix:string){
 dir=fs.mkdtempSync(join(tmpdir(),prefix));const file=join(dir,'messages.db');
 writer=new DatabaseSync(file);
 writer.exec('PRAGMA page_size=4096; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture(n); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO fixture VALUES(1)');
 reader=new DatabaseSync(file);reader.exec('BEGIN; SELECT * FROM fixture');
 return file;
}
it('R4: a fully copied WAL above 2 GiB regains owner admission; growth removes credit',async()=>{
 const file=realWal('murage-wal-credit-'),size=32+800000*4120;
 const current=fs.readFileSync(file+'-wal').subarray(32,56);
 fs.truncateSync(file+'-wal',size);
 const fd=fs.openSync(file+'-wal','r+');try{fs.writeSync(fd,current,0,24,size-4120);}finally{fs.closeSync(fd);}
 wal.startWalMaintenance(file,{nudge:async()=>false,setAutocheckpoint:()=>{}});
 await new Promise(r=>setTimeout(r,10));expect(fakeState.constructors).toBe(1);expect(wal.walMaintenanceReady()).toBe(true);
 expect(()=>wal.assertWalWriteAdmission(file)).toThrow(/Busy/);
 const result=await wal.checkpointPassive();expect(result).toEqual({busy:0,log:800000,checkpointed:800000});
 expect(()=>wal.assertWalWriteAdmission(file)).not.toThrow();
 fs.truncateSync(file+'-wal',size+4120);expect(()=>wal.assertWalWriteAdmission(file)).toThrow(/Busy/);
});
it('R5: a restarted WAL counts current-salt frames, not retained old-generation allocation',async()=>{
 const file=realWal('murage-wal-reused-'),frameBytes=4120,size=32+60000*frameBytes;
 const old=Buffer.from(fs.readFileSync(file+'-wal').subarray(32,56));old.writeUInt32BE((old.readUInt32BE(8)+1)>>>0,8);
 fs.truncateSync(file+'-wal',size);
 const fd=fs.openSync(file+'-wal','r+');try{fs.writeSync(fd,old,0,24,32+59999*frameBytes);}finally{fs.closeSync(fd);}
 wal.startWalMaintenance(file,{nudge:async()=>false,setAutocheckpoint:()=>{}});
 await vi.waitFor(()=>expect(wal.walMaintenanceReady()).toBe(true));
 const counters=wal.walMaintenanceCounters()!;
 expect(counters.maxWalFileKiB).toBeGreaterThan(200*1024);
 expect(counters.backlogKiB).toBe(Math.ceil((32+frameBytes)/1024));
 expect(counters.maxBacklogKiB).toBe(Math.ceil((32+frameBytes)/1024));
});
