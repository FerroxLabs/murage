// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it,vi } from 'vitest';
import { fixture } from '../decision/fixture.ts';
import { RosterPostCommitError,Store } from '../store.ts';
import { RootRegistry } from './registry.ts';
import { installWipeRootWiring } from './root-wiring.ts';
function setup(){
 const f=fixture(),store=f.store,bot=store.createBot({name:'Root fixture'},{seedMessages:false});
 const template=bot.tasks![0]!;bot.tasks=Array.from({length:4},(_,i)=>({...template,threadId:'task-'+i,cwd:'/work/t'+i}));
 const registry=new RootRegistry({realpath:p=>p,isBlockDevice:()=>null});
 const remove=installWipeRootWiring({bots:()=>store.bots,groups:()=>[],groupRoots:()=>[],onChange:fn=>store.onChange(fn)},registry);registry.resetStats();
 return {f,store,bot,registry,done:()=>{remove();vi.restoreAllMocks();f.dispose();}};
}
it.each(['add','remove','change','cosmetic'] as const)('E1 E2 E3 E4 patchBot publishes only changed task roots: %s',mode=>{
 const x=setup();try{const tasks=x.bot.tasks!.map(t=>({...t,title:'Renamed'}));if(mode==='add')tasks.push({...tasks[0]!,threadId:'new',cwd:'/work/new'});if(mode==='remove')tasks.splice(3,1);if(mode==='change')tasks[2]!.cwd='/work/new';
 x.store.patchBot(x.bot.id,{tasks});expect(x.registry.stats.replaceCalls).toBe(mode==='cosmetic'?0:1);expect(x.registry.contains('/work/new')).toBe(mode==='add'||mode==='change');expect(x.registry.contains('/work/t3')).toBe(mode!=='remove');
 }finally{x.done();}
});
it('E5 bot cwd publishes independently',()=>{const x=setup();try{x.store.patchBot(x.bot.id,{cwd:'/work/new'});expect(x.registry.contains('/work/new')).toBe(true);}finally{x.done();}});
it.each([true,false])('E7 E8 postcommit errors publish the live normalized roots: %s',committed=>{
 const x=setup();try{const old=x.bot.tasks!.map(t=>({...t}));vi.spyOn(x.store as any,'saveBots').mockImplementation((() =>{const normalized=[{...x.bot,tasks:committed?old.map((t,i)=>i===1?{...t,cwd:'/work/normalized'}:t):old}];throw new RosterPostCommitError(Error('fixture'),normalized);}) as any);
 expect(()=>x.store.patchBot(x.bot.id,{tasks:old.map((t,i)=>i===1?{...t,cwd:'/work/attempted'}:t)})).toThrow();
 expect(x.registry.contains('/work/normalized')).toBe(committed);expect(x.registry.contains('/work/attempted')).toBe(false);expect(x.registry.contains('/work/t1')).toBe(!committed);expect(x.registry.stats.replaceCalls).toBe(committed?1:0);
 }finally{x.done();}
});
it('E9 deleteTask postcommit error removes the live root',()=>{const x=setup();try{
 vi.spyOn(x.store as any,'saveBots').mockImplementation((()=>{throw new RosterPostCommitError(Error('fixture'),[{...x.bot}]);}) as any);
 expect(()=>x.store.deleteTask(x.bot.id,'task-2')).toThrow();expect(x.store.bot(x.bot.id)?.tasks?.some(t=>t.threadId==='task-2')).toBe(false);expect(x.registry.contains('/work/t2')).toBe(false);
 }finally{x.done();}});
it.each([false,true])('E6 import publishes every live root even if later bookkeeping throws: %s',fault=>{
 const x=setup();try{
  const addition={...x.bot,id:'imported-fixture',threadId:'import-thread',cwd:'/work/imported',chiefOfStaff:undefined,chiefScope:undefined,autoApprove:false,fullAccess:false,noLimits:false,composio:false,browser:false,computer:'off' as const,resumeCursors:{},tasks:[{...x.bot.tasks![0]!,threadId:'import-thread',cwd:'/work/imported-task',resumeCursors:{}}]};
  const staged=x.store.preparePackageAddition([addition] as any,[]);
  if(fault)vi.spyOn(x.store as any,'refreshPendingThreads').mockImplementation(()=>{throw Error('fixture-publication');});
  if(fault)expect(()=>staged.publish()).toThrow('fixture-publication');else staged.publish();
  expect(x.store.bots.some(bot=>bot.id===addition.id)).toBe(true);expect(x.registry.contains('/work/imported')).toBe(true);expect(x.registry.contains('/work/imported-task')).toBe(true);
 }finally{x.done();}
});

it('E6 restore boot rebuilds all task roots from the persisted roster',()=>{
 const x=setup();let remove:(()=>void)|undefined,reloaded:Store|undefined;
 try{
  x.store.patchBot(x.bot.id,{cwd:'/work/restored',tasks:x.bot.tasks});
  reloaded=new Store();const registry=new RootRegistry({realpath:p=>p,isBlockDevice:()=>null});
  remove=installWipeRootWiring({bots:()=>reloaded!.bots,groups:()=>[],groupRoots:()=>[],onChange:fn=>reloaded!.onChange(fn)},registry);
  expect(registry.contains('/work/restored')).toBe(true);for(let i=0;i<4;i++)expect(registry.contains('/work/t'+i)).toBe(true);
 }finally{remove?.();reloaded?.stopSeqStamps();x.done();}
});
it('F6-boot physical lookup faults do not rebuild task history on admission',()=>{
 let reads=0;const registry=new RootRegistry({realpath(){throw Error('fixture-root');},isBlockDevice:()=>null});
 const port={bots:()=>{reads++;return [{id:'fixture',tasks:[{threadId:'task',cwd:'/work/boot'}]}];},groups:()=>[],groupRoots:()=>[],onChange:()=>()=>{}};
 let remove:(()=>void)|undefined;
 expect(()=>{remove=installWipeRootWiring(port,registry);}).not.toThrow();const boot=reads;
 for(let i=0;i<20;i++)expect(registry.contains('/work/boot')).toBe(true);expect(reads).toBe(boot);remove?.();
});
