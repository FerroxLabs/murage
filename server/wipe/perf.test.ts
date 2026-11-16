// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect,it } from 'vitest';
import { fixture } from '../decision/fixture.ts';
import { wipeBreaker } from '../wipe-breaker.ts';
import type { PathPort } from './types.ts';
async function scenario(count:number) {
 const {RootRegistry}=await import(/* @vite-ignore */ './registry.ts');const {installWipeRootWiring}=await import('./root-wiring.ts');
 const f=fixture(),store=f.store;
 const bot=store.createBot({name:'Root fixture'},{seedMessages:false});
 const originalTasks=bot.tasks;const template=bot.tasks![0]!;
 bot.tasks=Array.from({length:count},(_,i)=>({...template,threadId:'task-'+i,cwd:'/work/t'+i}));
 const group=store.createGroup('Root room',[bot.id]);
 let reads=0,realpaths=0;
 const pathPort:PathPort={realpath(p){realpaths++;return p;},isBlockDevice(){return null;}};
 const registry=new RootRegistry(pathPort);
 const remove=installWipeRootWiring({bots:()=>{reads++;return store.bots;},groups:()=>{reads++;return store.groups;},groupRoots:()=>{reads++;return [];},onChange:fn=>store.onChange(fn)},registry);
 const boot={...registry.stats};
 registry.resetStats();reads=realpaths=0;
 const scan=(text:string)=>{const before=registry.stats.trieNodesTouched;const hit=wipeBreaker(text,{cwd:'/work/project',project:'/work/project',home:'/home/u',dataDir:'/home/u/.murage',registry,pathPort});expect(registry.stats.trieNodesTouched-before).toBeLessThanOrEqual(3);return hit;};
 const times:number[]=[];
 for(let i=0;i<20;i++){
  // Exact production room-turn completion sequence, followed by a cosmetic task write.
  store.patchGroup(group.id,{busyBotId:null,unread:true});
  store.setActivity(bot.id,'idle');
  store.patchBot(bot.id,{unread:true});
  store.patchTask(bot.id,'task-17',{unread:true});
  const start=performance.now();expect(scan('rm -rf /tmp/x')).toBeNull();expect(scan('rm -rf /work/t17')).toBeTruthy();times.push(performance.now()-start);
 }
 const turn={...registry.stats,reads,realpaths};
 registry.resetStats();reads=realpaths=0;
 store.patchTask(bot.id,'task-17',{cwd:'/work/changed'});
 const changed={...registry.stats,reads,realpaths};
 expect(scan('rm -rf /work/changed')).toBeTruthy();expect(scan('rm -rf /work/t17')).toBeNull();
 times.sort((a,b)=>a-b);
 remove();store.deleteGroup(group.id);bot.tasks=originalTasks;store.deleteBot(bot.id);f.dispose();
 return {turn,changed,boot,median:times[10]!};
}
it('P-1 R2-H3 production room completion costs are independent of history',async()=>{
 if(process.env.WIPE_RED_COMMIT==='c1'){
  // Historical adapter invokes the original listener and real Store methods.
  const {productionCounters}=await import('../wipe-acceptance-adapter.ts');const small=await productionCounters(50),large=await productionCounters(5000);expect(small).toEqual({reads:0,replaces:0,realpathCalls:0});expect(large).toEqual(small);return;
 }
 const small=await scenario(50),large=await scenario(5000);
 expect(small.turn).toEqual(large.turn);
 expect(large.turn.replaceCalls).toBe(0);expect(large.turn.reads).toBe(0);// MAIN RULING binding v2 DELTA7: indexed lexical roots need no realpath.
 expect(large.turn.realpaths).toBe(20);
 expect(large.turn.trieNodesTouched).toBe(80);
 console.log('P-5 informational admission median',JSON.stringify({small:small.median,large:large.median,bound:1.5*small.median+0.2}));
},120000);
it('P-2 one changed root has constant cost; P-4 boot is the only full enumeration',async()=>{
 const small=await scenario(50),large=await scenario(5000);
 expect(small.changed).toEqual(large.changed);expect(large.changed.replaceCalls).toBe(1);expect(large.changed.realpaths).toBeLessThanOrEqual(2);expect(large.changed.reads).toBe(0);
 expect(small.boot.replaceCalls).toBe(52);expect(large.boot.replaceCalls).toBe(5002);
},120000);
it('P-3 one million owners query only target components',async()=>{
 const {RootRegistry}=await import(/* @vite-ignore */ './registry.ts');
 const registry=new RootRegistry({realpath:p=>p,isBlockDevice:()=>null});
 for(let i=0;i<1000000;i++)registry.replace('owner-'+i,['/a/b/c/'+i]);
 registry.resetStats();expect(registry.contains('/a/b/c')).toBe(true);expect(registry.stats.trieNodesTouched).toBeLessThanOrEqual(4);
 registry.resetStats();expect(registry.contains('/missing/path')).toBe(false);expect(registry.stats.trieNodesTouched).toBeLessThanOrEqual(3);
 registry.clear();
},120000);
