// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: registry authority — wipe-fable / wg-final; publisher — pi-roots.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {RootRegistry} from './wipe/registry.ts';
import type {StoreChange} from './store.ts';
import {removeTempDirSync} from './testing/cleanup.ts';
let dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'pi-publish-'));});
afterEach(()=>{vi.useRealTimers();removeTempDirSync(dir);});
async function fixture(count=1,opts:Record<string,unknown>={}){
 const {installPiRootInventoryWiring}=await import('./pi-root-inventory.ts');
 const registry=new RootRegistry({realpath:p=>p,isBlockDevice:()=>false,stat:()=>null});
 let listener:(change:StoreChange)=>void=()=>{};
 let fail=false;
 const bots=[{id:'fixture',cwd:'/fixture/bot',tasks:Array.from({length:count},(_,i)=>({threadId:String(i),cwd:'/fixture/task/'+i}))}];
 const path=join(dir,'roots');
 const wiring=installPiRootInventoryWiring({bots:()=>{if(fail)throw Error('fixture build fault');return bots;},groups:()=>[{id:'fixture-group'}],groupRoots:()=>['/fixture/group'],onChange:fn=>{listener=fn;return()=>{};}},registry,{path,...opts});
 const read=()=>{const [header,...body]=readFileSync(path,'utf8').split('\n');return {header,roots:JSON.parse(body.join('\n')) as string[]};};
 return {registry,bots,path,read,wiring,emit:(c:StoreChange)=>listener(c),fail:(value:boolean)=>{fail=value;}};
}
it('initial build publishes the complete bot, task and group inventory once',async()=>{
 const f=await fixture(4);expect(f.read().roots.sort()).toEqual(f.registry.snapshot().slice().sort());expect(f.wiring.stats.publications).toBe(1);
});
const paths:[string,StoreChange][]=[
 ['bot creation',{type:'workroot',owner:'bot:created:cwd',botId:'created',paths:['/fixture/created']}],
 ['bot task roots',{type:'workroot',owner:'task:created:first:cwd',botId:'created',paths:['/fixture/created-task']}],
 ['bot cwd change',{type:'workroot',owner:'bot:fixture:cwd',botId:'fixture',paths:['/fixture/moved']}],
 ['replacement task list',{type:'workroot',owner:'task:fixture:0:cwd',botId:'fixture',paths:['/fixture/replaced']}],
 ['task pin',{type:'workroot',owner:'task:fixture:0:cwd',botId:'fixture',paths:['/fixture/pinned']}],
 ['task clear',{type:'workroot',owner:'task:fixture:0:cwd',botId:'fixture',paths:null}],
 ['task cwd patch',{type:'workroot',owner:'task:fixture:0:cwd',botId:'fixture',paths:['/fixture/patched']}],
 ['task committed-error reconciliation',{type:'workroot',owner:'task:fixture:0:cwd',botId:'fixture',paths:['/fixture/committed']}],
 ['task creation',{type:'workroot',owner:'task:fixture:new:cwd',botId:'fixture',paths:['/fixture/new']}],
 ['task deletion',{type:'workroot',owner:'task:fixture:0:cwd',botId:'fixture',paths:null}],
 ['task deletion error reconciliation',{type:'workroot',owner:'task:fixture:0:cwd',botId:'fixture',paths:null}],
 ['bot deletion',{type:'workroot',owner:'bot:fixture:*',botId:'fixture',paths:null}],
 ['project root add',{type:'workroot',owner:'group:new',paths:['/fixture/project']}],
 ['project root change',{type:'workroot',owner:'group:fixture-group',paths:['/fixture/project-moved']}],
 ['project root remove',{type:'workroot',owner:'group:fixture-group',paths:[]}],
 ['group deletion',{type:'workroot',owner:'group:fixture-group',paths:null}],
];
it.each(paths)('%s publishes once with exact authority roots',async(_name,change)=>{
 const f=await fixture(3);const before=f.wiring.stats.publications;f.emit(change);
 expect(f.wiring.stats.publications-before).toBe(1);expect(f.read().roots.sort()).toEqual(f.registry.snapshot().slice().sort());
});
it('package reset is one transaction, never a ready empty or partial inventory',async()=>{
 const seen:string[][]=[];const f=await fixture(3,{observeReady:(roots:string[])=>seen.push([...roots])});
 f.bots[0]!.tasks.push({threadId:'new',cwd:'/fixture/added'});f.emit({type:'workroot-reset'});
 expect(seen).toHaveLength(2);expect(seen[1]!.length).toBe(6);expect(f.read().roots).toContain('/fixture/added');
});
it.each(['explicit','timer'] as const)('failed build %s retry never publishes partial roots',async kind=>{
 vi.useFakeTimers();let attempts=0;const seen:string[][]=[];
 const {installPiRootInventoryWiring}=await import('./pi-root-inventory.ts');const registry=new RootRegistry({realpath:p=>p,isBlockDevice:()=>false});const path=join(dir,'retry');
 installPiRootInventoryWiring({bots:()=>{if(++attempts===1)throw Error('fixture build fault');return [{id:'fixture',cwd:'/fixture/retried'}];},groups:()=>[],groupRoots:()=>[],onChange:()=>()=>{}},registry,{path,observeReady:roots=>seen.push([...roots])});
 expect(readFileSync(path,'utf8').split('\n')[0]).toContain(' P ');expect(seen).toHaveLength(0);
 if(kind==='timer')await vi.advanceTimersByTimeAsync(60_000);else registry.retryBuild();
 expect(seen).toEqual([['/fixture/retried']]);expect(readFileSync(path,'utf8').split('\n')[0]).toContain(' R ');
});
it('unchanged turns at 50 and 5000 tasks perform equal host inventory operations',async()=>{
 const costs=[];
 for(const count of [50,5000]){
  const f=await fixture(count);const before={...f.wiring.stats};const snapshot=vi.spyOn(f.registry,'snapshot');
  for(let turn=0;turn<20;turn++)expect(f.wiring.inventoryPath()).toBe(f.path);
  costs.push({snapshots:snapshot.mock.calls.length,roots:f.wiring.stats.rootsVisited-before.rootsVisited,bytes:f.wiring.stats.serializedBytes-before.serializedBytes,publications:f.wiring.stats.publications-before.publications});
 }
 console.info('pi-roots per-turn operations',JSON.stringify(costs));expect(costs[0]).toEqual(costs[1]);expect(costs[0]).toEqual({snapshots:0,roots:0,bytes:0,publications:0});
 const source=readFileSync(new URL('./drivers/pi.ts',import.meta.url),'utf8');expect(source).not.toContain('registeredWipeProjects.snapshot()');expect(source).toContain('inventoryPath()');
});
it('publication of 5000 roots completes within the binding 15ms budget',async()=>{
 // MAIN RULING 1114-MEASURED-THRESHOLDS point 1: 15ms; publication only on changes.
 const f=await fixture(4998);expect(f.registry.snapshot()).toHaveLength(5000);
 const start=performance.now();f.emit({type:'workroot',owner:'task:fixture:0:cwd',botId:'fixture',paths:['/fixture/moved']});const ms=performance.now()-start;
 console.info('pi-roots publish 5000 roots ms',ms);expect(ms).toBeLessThanOrEqual(15);
});
it('non-registry Store events never publish or enumerate',async()=>{const f=await fixture();const before={...f.wiring.stats};f.emit({type:'bot',botId:'fixture'});expect(f.wiring.stats).toEqual(before);});
it('a failed ready write leaves pending, and invalidation failure prevents authority mutation',async()=>{
 const {writeFileAtomic}=await import('./atomic.ts');let fail=false;
 const f=await fixture(1,{write:(path:string,data:string)=>{if(fail&&data.includes(' R '))throw Error('fixture write fault');writeFileAtomic(path,data,{mode:0o600});}});
 fail=true;expect(()=>f.emit({type:'workroot',owner:'bot:fixture:cwd',paths:['/fixture/changed']})).toThrow();expect(readFileSync(f.path,'utf8').split('\n')[0]).toContain(' P ');
 mkdirSync(join(dir,'blocked'));let reject=false;
 const g=await fixture(1,{path:join(dir,'blocked','roots'),write:(path:string,data:string)=>{if(reject)throw Error('fixture invalidation fault');writeFileAtomic(path,data,{mode:0o600});}});reject=true;
 expect(()=>g.emit({type:'workroot',owner:'bot:fixture:cwd',paths:['/fixture/never']})).toThrow();expect(g.registry.rootForOwner('bot:fixture:cwd')).toBe('/fixture/bot');
});
it('startup invalidates stale artifacts before rebuilding and never exposes partial ready data',async()=>{
 const {writeFileAtomic}=await import('./atomic.ts');const {installPiRootInventoryWiring}=await import('./pi-root-inventory.ts');
 const path=join(dir,'restart');writeFileAtomic(path,'MURAGE-PI-ROOTS 1 R 00000000-0000-4000-8000-000000000001\n["/fixture/stale"]');
 const registry=new RootRegistry({realpath:p=>p,isBlockDevice:()=>false});const records:string[]=[];
 installPiRootInventoryWiring({bots:()=>{expect(readFileSync(path,'utf8')).toContain(' P ');return[{id:'fixture',cwd:'/fixture/fresh',tasks:[{threadId:'t',cwd:'/fixture/task'}]}];},groups:()=>[],groupRoots:()=>[],onChange:()=>()=>{}},registry,{path,write:(file,data)=>{writeFileAtomic(file,data,{mode:0o600});records.push(data);}});
 expect(records).toHaveLength(2);expect(records[0]).toContain(' P ');expect(JSON.parse(records[1]!.split('\n').slice(1).join('\n'))).toEqual(['/fixture/fresh','/fixture/task']);
});
it.each(['after pending','after ready'] as const)('a failure %s replacement leaves only a safe complete state',async fault=>{
 const {writeFileAtomic}=await import('./atomic.ts');let failing=false;
 const f=await fixture(2,{write:(path:string,data:string)=>{writeFileAtomic(path,data,{mode:0o600});if(failing&&data.includes(fault==='after pending'?' P ':' R '))throw Error('fixture after replacement');}});failing=true;
 expect(()=>f.emit({type:'workroot',owner:'bot:fixture:cwd',paths:['/fixture/changed']})).toThrow();
 if(fault==='after pending'){expect(readFileSync(f.path,'utf8')).toContain(' P ');expect(f.registry.rootForOwner('bot:fixture:cwd')).toBe('/fixture/bot');}
 else expect(f.read().roots.slice().sort()).toEqual(f.registry.snapshot().slice().sort());
});
it('production authority mutations remain confined to root wiring and its publisher',async()=>{
 const {readdirSync}=await import('node:fs');const {fileURLToPath}=await import('node:url');const root=fileURLToPath(new URL('.',import.meta.url));
 const visit=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?visit(join(dir,entry.name)):entry.name.endsWith('.ts')&&!entry.name.includes('.test.')?[join(dir,entry.name)]:[]);
 const callers=visit(root).filter(file=>!file.includes('/wipe/')&&!file.includes('/testing/')).filter(file=>/registeredWipeProjects\s*\.\s*(?:replace|drop|dropBot|clear|lazyBuild)\s*\(/.test(readFileSync(file,'utf8')));
 expect(callers).toEqual([]);
});
