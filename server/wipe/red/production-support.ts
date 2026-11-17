// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixture } from '../../decision/fixture.ts';
import { DATA_DIR } from '../../config.ts';
/** The actual Store event path, usable on C1 without importing new module APIs. */
export function productionTurnCounters(install:(port:any,registry:any)=>any,registry:any,count:number,reset:()=>void,realpaths:()=>number) {
 const f=fixture(),store=f.store,bot=store.createBot({name:'Root event fixture'},{seedMessages:false});
 const originalTasks=bot.tasks;const template=bot.tasks![0]!;bot.tasks=Array.from({length:count},(_,i)=>({...template,threadId:'task-'+i,cwd:'/work/t'+i}));
 const group=store.createGroup('Root event room',[bot.id]);let reads=0,replaces=0;
 const wrapped={replace(owner:string,paths:string[]){replaces++;return registry.replace(owner,paths);},dropBot:(id:string)=>registry.dropBot?.(id),clear:()=>registry.clear(),lazyBuild:(fn:()=>void)=>{wrapped.build=fn;},ensureBuilt:()=>wrapped.build?.(),build:undefined as (()=>void)|undefined};
 const port={bots:()=>{reads++;return store.bots;},groups:()=>{reads++;return store.groups;},groupRoots:()=>{reads++;return [];},onChange:(fn:any)=>store.onChange(fn),store:{get bots(){reads++;return store.bots;},get groups(){reads++;return store.groups;},bot:(id:string)=>{reads++;return store.bot(id);},group:(id:string)=>{reads++;return store.group(id);},onChange:(fn:any)=>store.onChange(fn)},dataDir:DATA_DIR};
 const remove=install(port,wrapped);reads=replaces=0;reset();
 for(let i=0;i<20;i++){store.patchGroup(group.id,{busyBotId:null,unread:true});store.setActivity(bot.id,'idle');store.patchBot(bot.id,{unread:true});store.patchTask(bot.id,'task-17',{unread:true});}
 const result={reads,replaces,realpathCalls:realpaths()};if(typeof remove==='function')remove();store.deleteGroup(group.id);bot.tasks=originalTasks;store.deleteBot(bot.id);f.dispose();return result;
}
