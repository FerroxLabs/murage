// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: registry authority — wipe-fable / wg-final; publisher and Pi reader — pi-roots.
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,mkdirSync,openSync,readSync,unlinkSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {DATA_DIR} from './config.ts';
import {writeFileAtomic} from './atomic.ts';
import {RootRegistry,registeredWipeProjects} from './wipe/registry.ts';
import {installWipeRootWiring,type WipeRootPort} from './wipe/root-wiring.ts';

const sharedPath=join(tmpdir(),'murage-pi-roots-'+createHash('sha256').update(homedir()+'\0'+DATA_DIR).digest('hex'),'inventory');
// Owners: publisher — pi-roots; execution consumers — PiDriver. Filesystem
// failure must also close the execution boundary: Store has already committed
// before notifying listeners, and can swallow their exceptions.
const unavailable=new Set<string>();
const consumers=new Map<string,Set<()=>void>>();
export function assertPiInventoryAvailable(path=sharedPath):void {
 if(unavailable.has(path))throw Error('wipe-root-inventory-unavailable');
}
export function registerPiInventoryConsumer(stop:()=>void,path=sharedPath):()=>void {
 assertPiInventoryAvailable(path);
 let entries=consumers.get(path);if(!entries){entries=new Set();consumers.set(path,entries);}
 entries.add(stop);
 return()=>{entries.delete(stop);if(!entries.size)consumers.delete(path);};
}
function revokeInventory(path:string,pendingHeader:string):void {
 unavailable.add(path); // fences launches even if removing the stale file fails
 let pending=false;
 try{
  const fd=openSync(path,'r');
  try{const bytes=Buffer.alloc(128);const count=readSync(fd,bytes,0,bytes.length,0);pending=bytes.subarray(0,count).toString('utf8').startsWith(pendingHeader);}
  finally{closeSync(fd);}
 }catch{/* A read failure cannot establish successful invalidation. */}
 // A directory-fsync error can arrive after the pending rename succeeded.
 // Preserve that safe state; otherwise remove stale readiness, never as part
 // of normal atomic replacement.
 if(!pending)try{unlinkSync(path);}catch{/* Execution revocation is independent of filesystem access. */}
 for(const stop of [...consumers.get(path)??[]])try{stop();}catch{/* Reach every owned consumer. */}
}
/** No I/O, roster access, lazy initialization or repair on the launch path. */
export function inventoryPath():string{return sharedPath;}
export interface InventoryOptions {
 path?:string;
 write?:(path:string,data:string)=>void;
 observeReady?:(roots:readonly string[])=>void;
}

/** All production registry mutations converge through the unchanged root wiring.
 * The proxy retains the actual authority, and wraps the initializer itself so
 * RootRegistry's private retry timer cannot escape a publication transaction. */
export function installPiRootInventoryWiring(port:WipeRootPort,registry:RootRegistry=registeredWipeProjects,options:InventoryOptions={}){
 const path=options.path??inventoryPath();
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const write=options.write??((file:string,data:string)=>writeFileAtomic(file,data,{mode:0o600,syncDir:true}));
 const stats={publications:0,rootsVisited:0,serializedBytes:0};
 let depth=0,failed=false,rebuildRequired=false,generation='';
 let initializer:(()=>void)|undefined;
 const transaction=<T>(action:()=>T):T=>{
  const outer=depth===0;
  if(outer){
   // Rejecting the authority mutation alone cannot undo Store's durable commit.
   generation=randomUUID();
   const pendingHeader=`MURAGE-PI-ROOTS 1 P ${generation}\n`;
   try{write(path,pendingHeader);}
   catch(error){rebuildRequired=true;revokeInventory(path,pendingHeader);throw error;}
   failed=false;
  }
  depth++;
  try{
   const value=action();
   if(outer&&!failed){
    // snapshot throws for a failed lazy build. Retain P until a complete retry.
    const roots=registry.snapshot();
    const data=`MURAGE-PI-ROOTS 1 R ${generation}\n`+JSON.stringify(roots);
    stats.rootsVisited+=roots.length;stats.serializedBytes+=Buffer.byteLength(data);
    write(path,data);stats.publications++;unavailable.delete(path);options.observeReady?.(roots);
   }
   return value;
  }
  catch(error){failed=true;rebuildRequired=true;throw error;}
  finally{
   depth--;
  }
 };
 const mutations=new Set(['clear','replace','drop','dropBot']);
 const adapter=new Proxy(registry,{
  get(target,key){
   if(key==='lazyBuild')return(build:()=>void)=>{
    initializer=()=>transaction(()=>{build();if(failed)throw Error('wipe-root-inventory-unavailable');rebuildRequired=false;});
    target.lazyBuild(initializer);
   };
   if(key==='retryBuild')return()=>{
    // A direct reset bypasses RootRegistry.ensureBuilt's build-fault latch.
    // Re-enter that boundary before accepting any subsequent delta. The real
    // registry then owns fault state and its timer until reconstruction succeeds.
    if(rebuildRequired&&initializer)target.lazyBuild(initializer);
    target.retryBuild();target.ensureBuilt();
   };
   const value=Reflect.get(target,key,target);
   if(typeof value!=='function')return value;
   if(typeof key==='string'&&mutations.has(key))return(...args:unknown[])=>transaction(()=>Reflect.apply(value,target,args));
   return value.bind(target);
  },
 });
 const remove=installWipeRootWiring({...port,onChange:listener=>port.onChange(change=>{
  if(change.type==='workroot'||change.type==='workroot-reset')transaction(()=>listener(change));
  else listener(change);
 })},adapter);
 return {inventoryPath:()=>path,stats,dispose:remove};
}
