// SPDX-License-Identifier: AGPL-3.0-or-later
import {homedir} from 'node:os';
import {registeredWipeProjects} from './registry.ts';
import type { WipeContext } from './types.ts';
let reader:((threadId:string,botId:string)=>WipeContext)|undefined;
export function installWipeContextReader(next:NonNullable<typeof reader>):()=>void {
 reader=next;return ()=>{if(reader===next)reader=undefined;};
}
/** O(1) host lookup. All three permission seams share this provider. */
export function degradedWipeContext(request:WipeContext={},botId=''):WipeContext {
 let project=request.project??request.workFolder;try{project??=registeredWipeProjects.rootForOwner(`bot:${botId}:cwd`);}catch{}
 const home=request.home??homedir();return {...request,cwd:request.cwd??project,project,home,dataDir:request.dataDir??process.env.MURAGE_DATA_DIR??home+'/.murage',degraded:true};
}
export function wipeContextFor(threadId='',botId='',request:WipeContext={}):WipeContext {try{return {...request,...reader?.(threadId,botId)};}catch{return degradedWipeContext(request,botId);}}

/** Exec environment fields overlay caller fields, including case-folded lookups. */
export function wipeEnvironment(caller:WipeContext['env'],engine:WipeContext['env'],absent:readonly string[]=[]):NonNullable<WipeContext['env']> {
 const env:Record<string,string|undefined>=Object.create(null);
 for(const source of [caller,engine])for(const [name,value]of Object.entries(source??{})){delete env[name];env[name]=value;}
 for(const name of absent){delete env[name];env[name]=undefined;}
 return env;
}

/** Production reader uses only the live turn map and root-owner index. */
export function makeWipeContextReader(options:{registry:{rootForOwner(owner:string):string|undefined};turnCwds:ReadonlyMap<string,string>;botForThread(threadId:string):string|undefined;home:string;dataDir:string;platform?:NodeJS.Platform}) {
 const stats={calls:0,taskIndexRebuilds:0};
 const read=(threadId:string,botId:string):WipeContext=>{
  stats.calls++;botId ||= options.botForThread(threadId)??'';
  const project=options.registry.rootForOwner(`bot:${botId}:cwd`);
  const cwd=options.turnCwds.get(threadId)??options.registry.rootForOwner(`task:${botId}:${threadId}:cwd`)??project;
  return {cwd,project:project??cwd,home:options.home,dataDir:options.dataDir,platform:options.platform};
 };
 return Object.assign(read,{stats});
}
