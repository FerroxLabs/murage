// Observer/test consumer owner: skills lane; queue/selector hook owner: decision lane.
// The fixture observer never receives an owner capability.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
assert(process.env.MURAGE_SWITCH_COUNTS_FIXTURE==='1'&&process.env.MURAGE_DATA_DIR);
const log=join(process.env.MURAGE_DATA_DIR,'fixture-switch-counts.jsonl'),append=fs.appendFileSync;
const scope=new AsyncLocalStorage();let serial=0,phase=0;const descriptors=new Map();
function emit(event){const current=scope.getStore();if(current)scope.exit(()=>append(log,JSON.stringify({...current,...event})+'\n'));}
export function fixtureSkillEvent(kind){emit({kind});}
export function fixtureSkillSelection(rows){scope.exit(()=>append(log,JSON.stringify({kind:'selection',count:rows.length})+'\n'));return rows;}
export function fixtureSkillPopulation(count){scope.exit(()=>append(log,JSON.stringify({kind:'population',count})+'\n'));}
export function fixtureSkillRetired(botId){scope.exit(()=>append(log,JSON.stringify({kind:'retirement',botId})+'\n'));}
export function fixtureSkillPhase(label,work){if(label==='validation'&&scope.getStore()?.label==='final')return work();return scope.run({phase:++phase,label},()=>{emit({kind:'phase'});return work();});}
const open=fs.openSync,read=fs.readSync,readFile=fs.readFileSync,write=fs.writeFileSync;
fs.openSync=function(path,...args){const fd=open(path,...args);descriptors.set(fd,{path:String(path),open:++serial});return fd;};
fs.readSync=function(fd,...args){const bytes=read(fd,...args);emit({kind:'read',...descriptors.get(fd),bytes});return bytes;};
fs.readFileSync=function(path,...args){const result=readFile(path,...args);emit({kind:'read',...(typeof path==='number'?descriptors.get(path):{path:String(path),open:++serial}),bytes:Buffer.byteLength(result)});return result;};
fs.writeFileSync=function(path,data,...args){const result=write(path,data,...args);emit({kind:'write',...(typeof path==='number'?descriptors.get(path):{path:String(path)}),bytes:Buffer.byteLength(data)});return result;};
const raw=globalThis[Symbol.for('murage.io.raw-fs')];
if(raw){
  const rawWrite=raw.writeFileSync,rawWriteSync=raw.writeSync;
  raw.writeFileSync=function(path,data,...args){const result=rawWrite(path,data,...args);emit({kind:'write',...(typeof path==='number'?descriptors.get(path):{path:String(path)}),bytes:Buffer.byteLength(data)});return result;};
  raw.writeSync=function(fd,...args){const bytes=rawWriteSync(fd,...args);emit({kind:'write',...descriptors.get(fd),bytes});return bytes;};
}
for(const name of ['readdirSync','opendirSync']){const original=fs[name];fs[name]=function(path,...args){emit({kind:name,path:String(path)});return original(path,...args);};}
const createHash=crypto.createHash;
crypto.createHash=function(...args){
  const hash=createHash(...args),digest=hash.digest.bind(hash);
  hash.digest=function(...format){const result=digest(...format);emit({kind:'hash',digest:Buffer.isBuffer(result)?result.toString('hex'):format[0]==='hex'?result:undefined});return result;};
  return hash;
};
syncBuiltinESMExports();

function crashEntry(path,data){
  if(!String(path).endsWith('/decision-queues/skill.json'))return;
  return scope.exit(()=>{
    const marker=join(process.env.MURAGE_DATA_DIR,'fixture-crash-point.json');if(!fs.existsSync(marker))return;
    const point=JSON.parse(readFile(marker,'utf8')),saved=data===undefined?JSON.parse(readFile(path,'utf8')):JSON.parse(String(data));
    const entry=saved.entries.find(row=>(row.item.call.input?.botId??row.item.call.approval?.action?.skillRequest?.botId)===point.botId);return entry&&{...point,state:entry.state,version:entry.version};
  });
}
export function fixtureBeforeAtomic(path,data){const entry=crashEntry(path,data);if(entry?.state!=='accepted')return;if(['C02','C05'].includes(entry.point))process.exit(72);if(entry.point==='C03')throw new Error('fixture receipt unavailable');}
export function fixtureAfterAtomic(path,data){const entry=crashEntry(path,data);if(entry?.version===2)return;if(entry?.point==='C01'&&entry.state==='pending')process.exit(71);if(entry?.point==='C04'&&entry.state==='accepted')process.exit(74);}
export function fixtureAfterBarrier(path){const entry=crashEntry(path);if(entry?.version!==2)return;if(entry.point==='C01'&&entry.state==='effect-started')process.exit(71);if(entry.point==='C04'&&entry.state==='accepted')process.exit(74);}
