// SPDX-License-Identifier: AGPL-3.0-or-later
// OWNER completion/admission producer: wipe-v3. OWNER equal-work consumer: wipe-v3-tests.
// MAIN RULING R7: P-7 store visits are reported; this lane gates wipe-owned work.
import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import * as wipeContexts from './context.ts';
import {fixture,d} from '../decision/fixture.ts';
import {autoVerdict} from '../auto-approve.ts';
import {RootRegistry} from './registry.ts';
import {installWipeRootWiring} from './root-wiring.ts';
import {installWipeContextReader,makeWipeContextReader} from './context.ts';
import {corpusContext,fixturePathPort,type CorpusRow} from './corpus/v3-context.fixture.ts';
import type {PathPort} from './types.ts';
const corpus=JSON.parse(readFileSync(new URL('./corpus/wipe-corpus-v3.json',import.meta.url),'utf8')) as CorpusRow[];
const commands=[
 'rm -rf /','rm -rf /home','rm -rf /etc','mkfs.ext4 /dev/sda1',
 'rm -rf /tmp/foo','rm -rf /tmp/*','rm -rf ./build','rm -rf node_modules',
 'rm -rf ~/.*','rm -rf ~/Downloads/old','rm -rf $HOME/tmp','rm foo.txt',
 'find . -delete',String.raw`find . -exec rm {} \;`,"find . -name '*.tmp' -delete",
 'git status','git reset --hard','npm run build','mv old.txt new.txt','rm -rf .git',
];
function measure(count:50|5000){
 const f=fixture(),store=f.store;
 const bot=store.createBot({name:'Equal work fixture'},{seedMessages:false});
 store.patchBot(bot.id,{cwd:'/work/project'});
 const originalTasks=bot.tasks,template=originalTasks![0]!;
 bot.tasks=Array.from({length:count},(_,i)=>({...template,threadId:'task-'+i,cwd:'/work/t'+i}));
 const group=store.createGroup('Equal work room',[bot.id]);
 const probes={realpath:0,lstat:0,stat:0,statfs:0,isBlockDevice:0,mountConfirms:0};
 const port:PathPort & {confirmMount(p:string):boolean}={
  realpath:p=>{probes.realpath++;return fixturePathPort.realpath(p);},
  lstat:p=>{probes.lstat++;return fixturePathPort.lstat!(p);},
  stat:p=>{probes.stat++;return fixturePathPort.stat!(p);},
  statfs:p=>{probes.statfs++;return fixturePathPort.statfs!(p);},
  isBlockDevice:p=>{probes.isBlockDevice++;return fixturePathPort.isBlockDevice(p);},
  confirmMount:()=>{probes.mountConfirms++;return false;},
 };
 const registry=new RootRegistry(port);
 let enumerations=0;
 const remove=installWipeRootWiring({bots:()=>{enumerations++;return store.bots;},groups:()=>[],groupRoots:()=>[],onChange:fn=>store.onChange(fn)},registry);
 const reader=makeWipeContextReader({registry,turnCwds:new Map([['t','/work/project/pkg']]),botForThread:()=>bot.id,home:'/home/u',dataDir:'/home/u/.murage',platform:'linux'});
 const context=()=>({...corpusContext({platform:'linux',dialect:'sh',cwd:'/work/project/pkg'}),...reader('t',bot.id),registry,pathPort:port});
 const undo=installWipeContextReader(context);
 let contextCalls=0;const originalContextFor=wipeContexts.wipeContextFor;
 const contextSpy=vi.spyOn(wipeContexts,'wipeContextFor').mockImplementation((...args)=>{contextCalls++;return originalContextFor(...args);});
 d.installDecisionHost({store,view:()=>({title:'Fixture',subtitle:'Equal work'}),executionContext:context});
 const visits={wipe:0,store:0,other:0};
 const wrap=(tasks:NonNullable<typeof bot.tasks>)=>new Proxy(tasks,{get(target,key,receiver){
  if(typeof key==='string'&&/^\d+$/.test(key)){
   const frames=new Error().stack?.split('\n').slice(2)??[];
   const owner=frames.find(line=>/server\/(?:store\.ts|wipe\/|wipe-breaker\.ts|decision\/)/.test(line))??'';
   if(owner.includes('store.ts'))visits.store++;
   else if(/wipe\/|wipe-breaker|decision\//.test(owner))visits.wipe++;
   else visits.other++;
  }
  return Reflect.get(target,key,receiver);
 }});
 let tasks=wrap(bot.tasks!);Object.defineProperty(bot,'tasks',{configurable:true,enumerable:true,get:()=>tasks,set:next=>{tasks=wrap(next);}});
 try{return commands.map((command,i)=>{
  const row=corpus.find(r=>r.cmd===command&&r.tier==='gating'&&r.platform==='linux');
  expect(row,'performance command must be a real corpus row: '+command).toBeDefined();
  registry.resetStats();reader.stats.calls=0;contextCalls=0;enumerations=0;
  for(const key of Object.keys(probes) as (keyof typeof probes)[])probes[key]=0;
  visits.wipe=visits.store=visits.other=0;
  // Actual production completion writes; no stubbed Store or synthetic history loop.
  store.patchGroup(group.id,{busyBotId:null,unread:true});store.setActivity(bot.id,'idle');
  store.patchBot(bot.id,{unread:true});store.patchTask(bot.id,'task-17',{unread:true});
  const request=f.open('equal-'+i,{command,cwd:'/work/project/pkg'},{executionCwd:'/work/project/pkg'});
  const outcome=d.decide(request,()=>autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',command,{
   fullAccessOrigin:'owner',ownerStarted:true,commandText:command,commandCwd:'/work/project/pkg',wipeThreadId:'t',wipeBotId:bot.id,
  }));
  expect.soft(outcome.kind,command).toBe(row!.expect);
  return {id:row!.id,command,work:{registry:{...registry.stats},...probes,wipeContextFor:contextCalls,contextReader:reader.stats.calls,enumerations,wipeTaskVisits:visits.wipe},storeVisits:visits.store,otherVisits:visits.other};
 });}finally{
  contextSpy.mockRestore();undo();remove();Object.defineProperty(bot,'tasks',{configurable:true,enumerable:true,writable:true,value:originalTasks});
  store.deleteGroup(group.id);store.deleteBot(bot.id);f.dispose();
 }
}
it('V3-P1 exact 50-vs-5000 work for 20 corpus admissions and real completions',()=>{
 expect(commands).toHaveLength(20);expect(new Set(commands).size).toBe(20);
 const small=measure(50),large=measure(5000);
 expect(small).toHaveLength(20);expect(large).toHaveLength(20);
 for(let i=0;i<20;i++){
  expect.soft(small[i]!.work.wipeTaskVisits,small[i]!.command).toBe(0);
  expect.soft(large[i]!.work.wipeTaskVisits,large[i]!.command).toBe(0);
  expect.soft(large[i]!.work,large[i]!.command).toEqual(small[i]!.work);
  expect.soft(small[i]!.work.wipeContextFor).toBeGreaterThan(0);
 }
 console.log('V3-P1 exact work; P-7 informational store visits',JSON.stringify({small,large}));
},120000);
