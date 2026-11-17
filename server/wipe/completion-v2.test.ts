// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { fixture } from '../decision/fixture.ts';
import { RootRegistry } from './registry.ts';
import { installWipeRootWiring } from './root-wiring.ts';
import { installWipeContextReader,makeWipeContextReader,wipeContextFor } from './context.ts';
import { wipeBreaker } from '../wipe-breaker.ts';
export function completionWork(count:number){
 const f=fixture(),store=f.store,bot=store.createBot({name:'Completion fixture'},{seedMessages:false});
 const originalTasks=bot.tasks;const template=bot.tasks![0]!;bot.tasks=Array.from({length:count},(_,i)=>({...template,threadId:'task-'+i,cwd:'/work/t'+i}));
 const group=store.createGroup('Completion room',[bot.id]);
 const registry=new RootRegistry({realpath:p=>p,isBlockDevice:()=>null});
 const remove=installWipeRootWiring({bots:()=>store.bots,groups:()=>[],groupRoots:()=>[],onChange:fn=>store.onChange(fn)},registry);
 const reader=makeWipeContextReader({registry,turnCwds:new Map(),botForThread:()=>bot.id,home:'/home/u',dataDir:'/home/u/.murage'});
 const undo=installWipeContextReader(reader);
 const visits={store:0,wipe:0,other:0};
 const wrap=(tasks:NonNullable<typeof bot.tasks>)=>new Proxy(tasks,{get(target,key,receiver){
  if(typeof key==='string'&&/^\d+$/.test(key)){
   const frames=new Error().stack?.split('\n').slice(2)??[];const owner=frames.find(line=>/server\/(?:store\.ts|wipe\/|wipe-breaker\.ts|decision\/)/.test(line))??'';
   if(owner.includes('store.ts'))visits.store++;else if(/wipe\/|wipe-breaker|decision\//.test(owner))visits.wipe++;else visits.other++;
  }
  return Reflect.get(target,key,receiver);
 }});
 let tasks=wrap(bot.tasks!);Object.defineProperty(bot,'tasks',{configurable:true,enumerable:true,get:()=>tasks,set:next=>{tasks=wrap(next);}});
 registry.resetStats();
 try{
 for(let i=0;i<20;i++){
  store.patchGroup(group.id,{busyBotId:null,unread:true});store.setActivity(bot.id,'idle');store.patchBot(bot.id,{unread:true});store.patchTask(bot.id,'task-17',{unread:true});
  const ctx={...wipeContextFor('task-17',bot.id),registry,pathPort:{realpath:(p:string)=>p,isBlockDevice:()=>null}};
  expect(wipeBreaker('rm -rf /tmp/x',ctx)).toBeNull();expect(wipeBreaker('rm -rf /work/t17',ctx)).toBeTruthy();
 }
 return {visits:{...visits},context:{...reader.stats},registry:{...registry.stats}};
 }finally{remove();undo();Object.defineProperty(bot,'tasks',{configurable:true,enumerable:true,writable:true,value:originalTasks});store.deleteGroup(group.id);store.deleteBot(bot.id);f.dispose();}
}
it('P-7 H7 combined completion and admission task visits are independent of history',()=>{
 const small=completionWork(50),large=completionWork(5000);console.log('P-7 completion counters',JSON.stringify({small,large}));
 expect(small.visits.wipe).toBe(0);expect(large.visits.wipe).toBe(0);expect(small.context).toEqual(large.context);expect(small.registry).toEqual(large.registry);
 expect(large.visits.store).toBeLessThanOrEqual(small.visits.store+20);
},120000);
