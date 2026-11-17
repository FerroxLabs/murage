// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StoreChange } from '../store.ts';
import { RootRegistry, registeredWipeProjects } from './registry.ts';
type TaskRoot={threadId:string;cwd?:string|null};
type BotRoot={id:string;cwd?:string|null;tasks?:readonly TaskRoot[]};
export interface WipeRootPort {
 bots():readonly BotRoot[];
 groups():readonly {id:string}[];
 groupRoots(id:string):readonly string[];
 onChange(listener:(change:StoreChange)=>void):()=>void;
}
export function installWipeRootWiring(port:WipeRootPort,registry:RootRegistry=registeredWipeProjects):()=>void {
 const replace=(owner:string,paths:readonly string[])=>{try{registry.replace(owner,paths);}catch{/* Registry keeps lexical roots when optional physical resolution fails. */}};
 const build=()=>{
  registry.clear();
  for(const bot of port.bots()){
   replace(`bot:${bot.id}:cwd`,bot.cwd?[bot.cwd]:[]);
   for(const task of bot.tasks??[])replace(`task:${bot.id}:${task.threadId}:cwd`,task.cwd?[task.cwd]:[]);
  }
  for(const group of port.groups())replace(`group:${group.id}`,port.groupRoots(group.id));
 };
 registry.lazyBuild(build);
 const remove=port.onChange(change=>{
  if(change.type==='workroot'||change.type==='workroot-reset')registry.retryBuild();
  if(change.type==='workroot-reset'){build();return;}
  if(change.type!=='workroot')return;
  if(change.owner===`bot:${change.botId}:*`&&change.paths===null){registry.dropBot(change.botId!);return;}
  registry.replace(change.owner,change.paths??[]);
 });
 registry.ensureBuilt();return remove;
}
