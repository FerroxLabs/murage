// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PathPort, PathStat, RegistryStats } from './types.ts';
import { mountedRoots } from './mounts.ts';
import { canonicalPath, physicalPath, systemPathPort } from './roots.ts';
type Trie={count:number;subtreeCount:number;children:Map<string,Trie>};
const node=():Trie=>({count:0,subtreeCount:0,children:new Map()});
export class RootRegistry {
 private tree=node();
 private owners=new Map<string,Map<string,Set<string>>>();
 private botOwners=new Map<string,Set<string>>();
 private faults=new Set<string>();
 private children=new Map<string,Map<string,number>>();
 private ownerIdentities=new Map<string,Map<string,string>>();
 private identities=new Map<string,number>();
 private initializer:(()=>void)|undefined;
 private ready=true;
 private buildFault=false;
 private retry:ReturnType<typeof setTimeout>|undefined;
 readonly stats:RegistryStats;
 private port:PathPort;
 constructor(port:PathPort=systemPathPort,mountStats:{mountRefreshes:number}=mountedRoots.stats){
  this.port=port;let baseline=mountStats.mountRefreshes;
  this.stats={replaceCalls:0,trieNodesTouched:0,realpathCalls:0,queries:0,get mountRefreshes(){return mountStats.mountRefreshes-baseline;},set mountRefreshes(value:number){baseline=mountStats.mountRefreshes-value;}};
 }
 lazyBuild(build:()=>void):void {this.initializer=build;this.ready=false;}
 ensureBuilt():void {if(!this.ready){this.ready=true;this.buildFault=false;try{this.initializer?.();}catch{this.buildFault=true;this.retry=setTimeout(()=>this.retryBuild(),60000);this.retry.unref();}}}
 retryBuild():void {if(this.buildFault){clearTimeout(this.retry);this.ready=false;this.ensureBuilt();}}
 private adjust(path:string,delta:number):void {
  let current=this.tree;current.subtreeCount+=delta;
  for(const part of path.split('/').filter(Boolean)){
   let child=current.children.get(part);if(!child){child=node();current.children.set(part,child);}
   child.subtreeCount+=delta;if(child.subtreeCount===0)current.children.delete(part);current=child;
  }
  current.count+=delta;
 }
 replace(owner:string,paths:readonly string[]):void {
  this.stats.replaceCalls++;
  const previous=this.owners.get(owner)??new Map<string,Set<string>>(),next=new Map<string,Set<string>>();
  let faulted=false;
  for(const path of paths){
   const lexical=canonicalPath(path);if(next.has(lexical))continue;
   let forms=this.faults.has(owner)?undefined:previous.get(lexical);
   if(!forms){
    forms=new Set([lexical]);this.stats.realpathCalls++;
    // An unavailable referent never removes the owner's lexical root or aborts boot.
    try{const physical=physicalPath(this.port,path);if(physical)forms.add(canonicalPath(physical));}catch{faulted=true;}
   }
   next.set(lexical,forms);
  }
  if(/^(?:bot|room|group):/.test(owner)){
   const old=new Set([...previous.values()].flatMap(forms=>[...forms])),fresh=new Set([...next.values()].flatMap(forms=>[...forms]));
   const adjustChild=(path:string,delta:number)=>{const parent=path.slice(0,path.lastIndexOf('/'));let children=this.children.get(parent);if(!children){children=new Map();this.children.set(parent,children);}const count=(children.get(path)??0)+delta;if(count>0)children.set(path,count);else children.delete(path);if(!children.size)this.children.delete(parent);};
   for(const path of old)if(!fresh.has(path))adjustChild(path,-1);for(const path of fresh)if(!old.has(path))adjustChild(path,1);
  }
  if(this.port.stat){
   const prior=this.ownerIdentities.get(owner)??new Map<string,string>(),ids=new Map<string,string>();
   for(const path of next.keys()){
    let id=prior.get(path);if(!id)try{const stat=this.port.stat(path);if(stat)id=String(stat.dev)+':'+String(stat.ino);}catch{}
    if(id)ids.set(path,id);
   }
   for(const id of prior.values()){const count=(this.identities.get(id)??1)-1;if(count)this.identities.set(id,count);else this.identities.delete(id);}
   for(const id of ids.values())this.identities.set(id,(this.identities.get(id)??0)+1);
   if(ids.size)this.ownerIdentities.set(owner,ids);else this.ownerIdentities.delete(owner);
  }
  if(faulted)this.faults.add(owner);else this.faults.delete(owner);
  for(const [path,forms]of previous)for(const form of forms)if(!next.get(path)?.has(form))this.adjust(form,-1);
  for(const [path,forms]of next)for(const form of forms)if(!previous.get(path)?.has(form))this.adjust(form,1);
  const bot=/^(?:bot|task):([^:]+):/.exec(owner)?.[1];
  if(next.size){this.owners.set(owner,next);if(bot){let index=this.botOwners.get(bot);if(!index){index=new Set();this.botOwners.set(bot,index);}index.add(owner);}}
  else{this.owners.delete(owner);if(bot){const index=this.botOwners.get(bot);index?.delete(owner);if(!index?.size)this.botOwners.delete(bot);}}
 }
 drop(owner:string):void {this.replace(owner,[]);}
 dropBot(botId:string):void {for(const owner of this.botOwners.get(botId)??[])this.drop(owner);this.botOwners.delete(botId);}
 /** Immediate trie edges include intermediate ancestors and never truncate protected targets. */
 protectedSubtreeChildren(dir:string):string[] {
  this.ensureBuilt();let current=this.tree;
  for(const part of canonicalPath(dir).split('/').filter(Boolean)){
   const child=current.children.get(part);if(!child)return [];current=child;
  }
  const prefix=dir==='/'?'/':dir+'/';
  return Array.from(current.children.keys(),part=>prefix+part);
 }
 protectedChildren(dir:string):string[] {this.ensureBuilt();const roots:string[]=[];for(const path of this.children.get(dir)?.keys()??[]){roots.push(path);if(roots.length===256)break;}return roots;}
 contains(canonical:string):boolean {
  this.ensureBuilt();this.stats.queries++;let current=this.tree;this.stats.trieNodesTouched++;
  for(const part of canonical.split('/').filter(Boolean)){const child=current.children.get(part);if(!child)return false;current=child;this.stats.trieNodesTouched++;}
  return current.subtreeCount>0;
 }
 containsIdentity(stat:PathStat):boolean {this.ensureBuilt();return this.identities.has(String(stat.dev)+':'+String(stat.ino));}
 /** Integration inventory handoff: include every indexed lexical/physical root. */
 snapshot():readonly string[] {this.ensureBuilt();if(this.buildFault)throw Error('wipe-root-inventory-unavailable');return [...new Set([...this.owners.values()].flatMap(paths=>[...paths.values()].flatMap(forms=>[...forms])))];}
 rootForOwner(owner:string):string|undefined {this.ensureBuilt();return this.owners.get(owner)?.keys().next().value;}
 containsRoot(path:string):boolean {return this.contains(canonicalPath(path));}
 clear():void {this.children.clear();this.tree=node();this.owners.clear();this.botOwners.clear();this.faults.clear();this.ownerIdentities.clear();this.identities.clear();}
 resetStats():void {for(const key of Object.keys(this.stats) as (keyof RegistryStats)[])this.stats[key]=0;}
}
export const registeredWipeProjects=new RootRegistry();
