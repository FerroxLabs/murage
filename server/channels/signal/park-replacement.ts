// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parkReason, ParkFs, isAtomicTemp, equalManifest, refuse } from './park-fs.ts';
import { assertSignalQuiescent } from './park-fence.ts';
import { connectionSnapshot, parkSchema, controlSchema, excludeBundle, installationBinding, pathsFor, readConnection, readControl, writeControl, type ParkJournal, type Replacement } from './park-control.ts';
import { reconcileSignalParkAfterAuthority, assertSignalServiceAllowed, barrierSignalRecoveryParents, enumerateSignalBundles, reserveBundleName, saveJournal, type ParkOptions, type ParkVerdict } from './park.ts';
export interface SignalLocalAuthority {
  /** Must inventory all local Signal bindings (including inactive) and unfinished runs. */
  inventory(): { connectionIds:string[];runIds:string[] };
  revoke(connectionIds:readonly string[],runIds:readonly string[]):Promise<void>;
  verify(connectionIds:readonly string[],runIds:readonly string[]):boolean;
  /** Normal authoritative store flush/checkpoint plus checked directory barriers. */
  flush():Promise<void>;
  fence():void;
}
const locks=new Map<string,Promise<unknown>>();
export async function withSignalMutation<T>(root:string,work:()=>Promise<T>):Promise<T>{
 const previous=locks.get(root)??Promise.resolve();
 const next=previous.catch(()=>{}).then(work);locks.set(root,next);
 try{return await next;}finally{if(locks.get(root)===next)locks.delete(root);}
}
function inventory(authority:SignalLocalAuthority,liveId?:string){
 const all=authority.inventory();const connectionIds=[...new Set([...all.connectionIds,...(liveId?[liveId]:[])])],runIds=[...new Set(all.runIds)];
 if(connectionIds.length>4096||runIds.length>20_000)refuse('bound');return{connectionIds,runIds};
}
async function revoke(io:ParkFs,tx:Replacement,authority:SignalLocalAuthority){
 await authority.revoke(tx.connectionIds,tx.runIds);
 if(!authority.verify(tx.connectionIds,tx.runIds))refuse('conflict');
 await authority.flush();
 // A normal store's promise is insufficient without a checked directory barrier.
 io.barrier(io.root,true);
 if(!authority.verify(tx.connectionIds,tx.runIds))refuse('conflict');
}
function liveManifest(io:ParkFs,control:ReturnType<typeof readControl>):ParkJournal|null{
 const p=pathsFor(io.root),auth=io.fingerprint(p.signal,true),channel=io.fingerprint(p.channel);
 if(!auth.present&&!channel.present)return null;
 let connection:ParkJournal['connection']=null;
 if(channel.present){try{connection=connectionSnapshot(readConnection(io,p.channel));}catch{/* Opaque safe bytes have no synthetic restore binding. */}}
 const name=reserveBundleName(io,control,connection?.connectionId??randomUUID(),connection?.generation??0);
 return{version:3,runId:randomUUID(),bundleName:name,seq:0,state:'held',next:null,held:{reason:'conflict',at:Date.now(),by:'owner'},
 ...installationBinding(io),connection,components:{auth,channel},parkedBy:'1.0.19',parkedAt:Date.now()};
}
function setAsideLive(io:ParkFs,control:ReturnType<typeof readControl>,tx:Replacement){
 const j=tx.live;if(!j)return;
 const p=pathsFor(io.root),dir=join(p.bundles,j.bundleName);
 excludeBundle(io,control,j.bundleName,'conflict',undefined,true);
 io.mkdir(dir);
 let readable=true;const file=join(dir,'park.json');
 if(io.checked(file)){
  const bytes=io.read(file);let old:ParkJournal|undefined;
  try{old=parkSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{readable=false;}
  if(old&&(old.runId!==j.runId||old.bundleName!==j.bundleName||old.state!=='held'||JSON.stringify(old.components)!==JSON.stringify(j.components)))refuse('conflict');
 }
 const intent=()=>{const stored=control.replacements.find(t=>t.id===tx.id);if(!stored)refuse('conflict');stored.live=j;writeControl(io,control,true);if(readable)saveJournal(io,j);};
 intent();
 for(const key of ['channel','auth'] as const){
  const from=key==='auth'?p.signal:p.channel,to=join(dir,key==='auth'?'signal':'channels-signal');
  const a=io.checked(from),b=io.checked(to),expected=j.components[key];
  if(!expected.present){if(a||b)refuse('conflict');continue;}
  if(!!a===!!b)refuse('conflict');
  if(!equalManifest(io.fingerprint(a?from:to,key==='auth'),expected))refuse('changed');
  if(a){j.next={component:key,direction:'park'};intent();io.move(from,to,expected,key==='auth');j.next=null;intent();}
  else{io.barrier(dir,true);io.barrier(key==='auth'?io.root:join(io.root,'channels'),true);}
 }
}
async function finish(io:ParkFs,tx:Replacement,authority:SignalLocalAuthority){
 const control=readControl(io),p=pathsFor(io.root);
 for(const name of tx.oldBundles)excludeBundle(io,control,name,'conflict',undefined,true);
 if(tx.phase==='intent'){tx.phase='excluded';Object.assign(control.replacements.find(t=>t.id===tx.id)!,tx);writeControl(io,control,true);}
 // Every prior transaction remains a replay obligation, including ready ones.
 for(const prior of control.replacements)await revoke(io,prior,authority);
 if(tx.phase!=='ready'){
  if(tx.phase==='excluded'){tx.phase='revoked';Object.assign(control.replacements.find(t=>t.id===tx.id)!,tx);writeControl(io,control,true);}
  tx.phase='moving';Object.assign(control.replacements.find(t=>t.id===tx.id)!,tx);writeControl(io,control,true);
  setAsideLive(io,control,tx);
  if(io.checked(p.signal)||io.checked(p.channel))refuse('conflict');
  if(io.durabilityLimited)refuse('durability');
  if(enumerateSignalBundles(io).some(name=>!control.decisions[name]))refuse('conflict');
  tx.phase='ready';Object.assign(control.replacements.find(t=>t.id===tx.id)!,tx);writeControl(io,control,true);
 }
 const live=io.checked(p.channel);
 if(live && io.checked(join(p.channel,'connection.json'))){
  const record=readConnection(io,p.channel);
  // A ready transaction may be followed by a newer legitimate owner link.
  // Its old manifest never permits overwriting any live ID.
  if(tx.connectionIds.includes(record.connectionId))refuse('conflict');
  return;
 }
 if(io.checked(p.signal))refuse('conflict');
 if(live){for(const name of io.list(p.channel,1024)){if(!isAtomicTemp(name,'connection.json')||!io.checked(join(p.channel,name),true)?.isFile())refuse('conflict');}}
 io.mkdir(p.channel);
 io.write(join(p.channel,'connection.json'),{version:1,connectionId:tx.freshId,generation:1,enabled:false,paused:true,revoking:false,binding:null,account:null,removeDeviceOnPhone:true},64*1024,true);
}
/** Invoked only by the authenticated explicit owner action. */
export function keepBothAndLinkAgain(root:string,authority:SignalLocalAuthority,options:ParkOptions={}):Promise<ParkVerdict>{
 return withSignalMutation(root,async()=>{
  authority.fence();const io=new ParkFs(root,options),control=readControl(io);
  assertSignalQuiescent(io,control,options.fence,false);
  const names=enumerateSignalBundles(io);barrierSignalRecoveryParents(io,names);if(control.replacements.length>=64)refuse('bound');
  const pending=control.replacements.find(t=>t.phase!=='ready');
  if(pending){await finish(io,pending,authority);assertSignalServiceAllowed(root,options);return{state:'ready',kept:{kind:'earlier',folder:pathsFor(root).bundles}};}
  installationBinding(io);
  const live=liveManifest(io,control),all=inventory(authority,live?.connection?.connectionId);
  const tx:Replacement={id:randomUUID(),phase:'intent',oldBundles:names,...all,freshId:randomUUID(),live};
  const pendingControl=controlSchema.parse({...control,replacements:[...control.replacements,tx]});
  if(Buffer.byteLength(JSON.stringify(pendingControl))+4096>1024*1024)refuse('bound');
  // All safety, capacity, authority inventory checks precede feature writes.
  assertSignalQuiescent(io,control,options.fence);
  control.replacements.push(tx);writeControl(io,control,true);
  await finish(io,tx,authority);assertSignalServiceAllowed(root,options);
  return{state:'ready',kept:{kind:'earlier',folder:pathsFor(root).bundles}};
 });
}
/** Startup store phase: filesystem auto-restore remains suppressed throughout. */
export function replaySignalReplacements(root:string,authority:SignalLocalAuthority,options:ParkOptions={}):Promise<ParkVerdict>{
 return withSignalMutation(root,async()=>{
  authority.fence();const io=new ParkFs(root,options),control=readControl(io);assertSignalQuiescent(io,control,options.fence,false);barrierSignalRecoveryParents(io);assertSignalQuiescent(io,control,options.fence);
  for(const tx of control.replacements)await revoke(io,tx,authority);
  if(control.replacements.every(tx=>tx.phase==='ready')&&enumerateSignalBundles(io).some(name=>!control.decisions[name]))reconcileSignalParkAfterAuthority(io,options);
  const latest=control.replacements.at(-1);if(latest)await finish(io,latest,authority);
  assertSignalServiceAllowed(root,options);
  return{state:'ready',kept:{kind:'earlier',folder:pathsFor(root).bundles}};
 });
}

/** Owner copy describes persisted unfinished work, never a refused preflight. */
export function signalReplacementInProgress(root:string,options:ParkOptions={}):boolean {
 try{
  const io=new ParkFs(root,options),tx=readControl(io).replacements.at(-1);
  if(!tx)return false;if(tx.phase!=='ready')return true;
  const p=pathsFor(root);if(!io.checked(join(p.channel,'connection.json')))return true;
  return tx.connectionIds.includes(readConnection(io,p.channel).connectionId);
 }catch{return false;}
}

export function signalReplacementHold(root:string,error:unknown,options:ParkOptions={}):Extract<ParkVerdict,{state:'held'}>{
 return{state:'held',reason:parkReason(error),folder:pathsFor(root).bundles,dualCopy:false,canKeepBoth:false,pendingReplacement:signalReplacementInProgress(root,options)};
}
