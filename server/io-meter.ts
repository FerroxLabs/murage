// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed process counters. This leaf may be imported by workers and atomic saves;
// it must never import io-budget, config, observe, or any application writer.
import {sentinelIoCovered} from "./sentinel-io-coverage.ts";
import {ownedChildIoKnown,childIoMeterInstalled} from "./sentinel/io-child-receipts.ts";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { setWrittenMeter } from "./io-written.ts";
import { loadIoMeterAddon, type ExclusionAddon } from "./engine-exclusion.ts";
let bootstrap:DatabaseSync|undefined, addon:ExclusionAddon|undefined, attempted=false;
let highest=0, uncertain=false;
let nativeMeterPath:string|undefined;
/** Coverage is closed by writer class. Runtime failures (including a missing
 * final child receipt) still fail closed independently of this static census. */
export const IO_METER_COVERAGE_GAPS=Object.freeze([] as string[]);
export function ioMeterCoverageKnown(sentinelKnown?:boolean):boolean{return IO_METER_COVERAGE_GAPS.length===0&&copyMeterGlobal[copyMeterKey]===true&&childIoMeterInstalled()&&ownedChildIoKnown()&&(sentinelKnown??sentinelIoCovered());}
export function ensureIoMeter():boolean {
 if(attempted)return addon!==undefined;
 attempted=true;
 try{
  const loaded=loadIoMeterAddon(),candidate=loaded?.addon,path=loaded?.path;
  if(!candidate?.ioMeterAdd||!candidate.ioMeterTotal||!candidate.ioMeterBytes||!path)return false;
  const db=new DatabaseSync(":memory:",{allowExtension:true});
  try{db.loadExtension(path,"sqlite3_muragemeter_init");db.enableLoadExtension(false);}catch(error){db.close();throw error;}
  // SQLITE_OK_LOAD_PERMANENTLY pins the callbacks; this handle additionally keeps
  // the bootstrap alive for the lifetime of this thread. No disk/shm is opened.
  bootstrap=db;addon=candidate;nativeMeterPath=path;return true;
 }catch{return false;}
}
export function ioMeterActive():boolean{return ensureIoMeter();}
export function ioMeterTotal():number|null {
 if(!ensureIoMeter()||uncertain)return null;
 try{
  const n=addon!.ioMeterTotal!();
  if(n===null||!Number.isSafeInteger(n)||n<highest)return null;
  highest=n;return n;
 }catch{return null;}
}
export function ioMeterSnapshot():{total:number;known:boolean;buckets:Array<[string,number]>}|null {
 if(!ensureIoMeter())return null;
 try{
  const snapshot=addon!.ioMeterSnapshot?.();
  if(!snapshot)return null;
  if(!Number.isSafeInteger(snapshot.total)||snapshot.total<highest){markIoMeterUnknown();return null;}
  highest=snapshot.total;
  return {...snapshot,known:snapshot.known&&!uncertain};
 }catch{markIoMeterUnknown();return null;}
}
export function ioMeterBytes(source:string):number {
 if(!ensureIoMeter())return 0;
 try{const n=addon!.ioMeterBytes!(source);if(Number.isSafeInteger(n)&&n>=0)return n;}catch{/* unknown below */}
 uncertain=true;return 0;
}
export function noteIoMeterBytes(source:string,bytes:number):void {
 if(!Number.isSafeInteger(bytes)||bytes<0){uncertain=true;return;}
 if(!bytes)return;
 if(!ensureIoMeter())return;
 try{addon!.ioMeterAdd!(source,bytes);}catch{uncertain=true;}
}
/** An uncertain partial write cannot turn a successful save into an exception.
 * It invalidates measurement instead, until a fresh process starts. */
export function markIoMeterUnknown():void{uncertain=true;try{if(ensureIoMeter())addon!.ioMeterUnknown?.();}catch{/* fail closed locally too */}}
/** Only tests that swap the native stand-in may reset the JS loader. The VFS
 * and native counters remain registered and cumulative. */
export function resetIoMeterForTest():void {
 if(process.env.NODE_ENV!=="test")throw new Error("IO_METER_TEST_ONLY");
 // Do not close an extension bootstrap while other connections can use its VFS.
 void bootstrap;attempted=false;addon=undefined;highest=0;uncertain=false;
}

// Install lazily callable readers; importing the lightweight leaf alone never
// pulls in the native loader or application modules.
setWrittenMeter({active:ioMeterActive,snapshot:ioMeterSnapshot});


const copyMeterKey=Symbol.for("murage.io.copy-meter");
const copyMeterGlobal=globalThis as typeof globalThis&{[copyMeterKey]:boolean|undefined};
/** Installs before application imports. Named node:fs bindings (including the
 * reserved native-session writer) are updated by syncBuiltinESMExports. Reflinks
 * deliberately charge logical bytes: an over-count cannot hide a write. */
export function installCopyMeter():void {
 if(copyMeterGlobal[copyMeterKey])return;
 copyMeterGlobal[copyMeterKey]=true;
 const raw={copyFile:fs.copyFile,copyFileSync:fs.copyFileSync,cp:fs.cp,cpSync:fs.cpSync,
  promiseCopyFile:fsp.copyFile,promiseCp:fsp.cp};
 const recursive=new AsyncLocalStorage<boolean>();
 const destination=(path:fs.PathLike)=>{
  try{const stat=fs.statSync(path);if(stat.isFile())noteIoMeterBytes("native-copies",stat.size);}
  catch{markIoMeterUnknown();}
 };
 const entry=(path:string,dereference:boolean)=>{
  try{const stat=dereference?fs.statSync(path):fs.lstatSync(path);if(!stat.isDirectory())noteIoMeterBytes("native-copies",stat.size);}
  catch{markIoMeterUnknown();}
 };
 const options=(input:fs.CopyOptions|undefined,sync:boolean):fs.CopyOptions|undefined=>{
  // Preserve Node's validation for invalid options and invalid filter types.
  if(input!==undefined&&(input===null||typeof input!=="object"))return input;
  if(input?.filter!==undefined&&typeof input.filter!=="function")return input;
  const filter=input?.filter;
  return {...input,filter:sync?((source,dest)=>{
   const accepted=filter?recursive.exit(()=>filter(source,dest)):true;
   if(accepted)entry(source,input?.dereference===true);
   return accepted;
  }):(async(source,dest)=>{
   const accepted=filter?await recursive.exit(()=>filter(source,dest)):true;
   if(accepted)entry(source,input?.dereference===true);
   return accepted;
  })};
 };
 fs.copyFileSync=((...args:Parameters<typeof fs.copyFileSync>)=>{
  try{raw.copyFileSync(...args);if(!recursive.getStore())destination(args[1]);}
  catch(error){markIoMeterUnknown();throw error;}
 }) as typeof fs.copyFileSync;
 fs.copyFile=((...args:unknown[])=>{
  const cb=args.at(-1);if(typeof cb!=="function")return Reflect.apply(raw.copyFile,fs,args);
  const nested=recursive.getStore();
  args[args.length-1]=(error:NodeJS.ErrnoException|null)=>{
   if(error)markIoMeterUnknown();else if(!nested)destination(args[1] as fs.PathLike);
   cb(error);
  };
  return Reflect.apply(raw.copyFile,fs,args);
 }) as typeof fs.copyFile;
 fsp.copyFile=(async(...args:Parameters<typeof fsp.copyFile>)=>{
  try{await raw.promiseCopyFile(...args);if(!recursive.getStore())destination(args[1]);}
  catch(error){markIoMeterUnknown();throw error;}
 }) as typeof fsp.copyFile;
 fs.cpSync=((source:string|URL,dest:string|URL,input?:fs.CopySyncOptions)=>{
  try{return recursive.run(true,()=>raw.cpSync(source,dest,options(input,true) as fs.CopySyncOptions));}
  catch(error){markIoMeterUnknown();throw error;}
 }) as typeof fs.cpSync;
 fs.cp=((...args:unknown[])=>{
  const cb=args.at(-1);if(typeof cb!=="function")return Reflect.apply(raw.cp,fs,args);
  const input=args.length===4?args[2] as fs.CopyOptions:undefined;
  return recursive.run(true,()=>raw.cp(args[0] as string|URL,args[1] as string|URL,options(input,false)??{},error=>{
   if(error)markIoMeterUnknown();cb(error);
  }));
 }) as typeof fs.cp;
 fsp.cp=(async(source:string|URL,dest:string|URL,input?:fs.CopyOptions)=>{
  try{return await recursive.run(true,()=>raw.promiseCp(source,dest,options(input,false)));}
  catch(error){markIoMeterUnknown();throw error;}
 }) as typeof fsp.cp;
 syncBuiltinESMExports();
}

// Ticket issuer owner: scperf-p1 (io-budget). Enforcement owner: scperf-p1 (meter.c).
export interface BgTicket { bytes:number; expiresAt:number }
export function ioGrantSnapshot():import("./engine-exclusion.ts").IoGrantState {
 if(!ensureIoMeter()||!addon?.ioGrantSnapshot)throw new Error("BG_ENFORCEMENT_UNAVAILABLE");
 return addon.ioGrantSnapshot();
}
export function ioMeterSqlDeadline():boolean {
 try{return ioGrantSnapshot().sqlDeadline===true;}catch{return false;}
}
export function beginBgGrant(ticket:BgTicket):void {
 if(!ensureIoMeter()||!addon?.ioGrantBegin)throw new Error("BG_ENFORCEMENT_UNAVAILABLE");
 addon.ioGrantBegin(ticket.bytes,ticket.expiresAt);
}
export function endBgGrant():ReturnType<typeof ioGrantSnapshot> {
 if(!addon?.ioGrantEnd)throw new Error("BG_ENFORCEMENT_UNAVAILABLE");
 return addon.ioGrantEnd();
}
export function chargeBgBytes(bytes:number):void {
 if(!addon?.ioGrantCharge)throw new Error("BG_ENFORCEMENT_UNAVAILABLE");
 addon.ioGrantCharge(bytes);
}
export function registerBg(db:DatabaseSync):boolean {
 if(!ensureIoMeter())return false;
 db.exec("PRAGMA murage_bg=1");
 const answer=db.prepare("PRAGMA murage_bg").get();
 return answer!==undefined&&Number(Object.values(answer)[0])===1;
}
export function registerBgProcess():void {
 if(!ensureIoMeter()||!addon?.ioAllBg)throw new Error("BG_ENFORCEMENT_UNAVAILABLE");
 addon.ioAllBg();
}
export class BgRefused extends Error {
 constructor(){super("BG_REFUSED");}
}
export function withBgGrant<T>(ticket:BgTicket,fn:()=>T,db?:DatabaseSync):T {
 beginBgGrant(ticket);
 const before=ioGrantSnapshot().refusedWrites;
 try {
  const result=fn();
  if(result&&typeof (result as {then?:unknown}).then==="function")throw new Error("BG_GRANT_ASYNC");
  if(ioGrantSnapshot().refusedWrites>before)throw new BgRefused();
  return result;
 }catch(error){
  if(db?.isTransaction)try{db.exec("ROLLBACK");}catch{/* the original refusal is retained */}
  if(ioGrantSnapshot().refusedWrites>before)throw new BgRefused();
  throw error;
 }finally{endBgGrant();}
}
/** Conservative shared-memory dirties for touched wal-index regions (4062 then 4096 frames). */
export function shmCharge(frames:number):number {
 const regions=frames<=0?0:1+Math.ceil(Math.max(0,frames-4062)/4096);
 return (8*regions+1)*4096;
}
export function commitCeiling(frames:number,sqlitePageSize=4096,osPageSize=ioGrantSnapshot().pageSize):number {
 // A frame header can straddle two OS pages, as can its page payload.
 const header=2*osPageSize,payload=(Math.ceil(sqlitePageSize/osPageSize)+1)*osPageSize;
 return frames*(header+payload)+2*osPageSize+shmCharge(frames);
}
export function checkpointCeiling(frames:number,sqlitePageSize=4096,osPageSize=ioGrantSnapshot().pageSize):number {
 return frames*Math.ceil(sqlitePageSize/osPageSize)*osPageSize+osPageSize+shmCharge(0);
}

/** Files written synchronously in a BG bracket use the same currency as SQLite. */
export function admitPlainWrite(length:number,offset=0):void {
 if(!ensureIoMeter()||!addon?.ioGrantSnapshot)return;
 const state=addon.ioGrantSnapshot();
 if(!state.live&&!state.backgroundProcess)return;
 const p=state.pageSize;
 chargeBgBytes((Math.ceil((offset+length)/p)-Math.floor(offset/p))*p);
}

export function ioMeterPageSize():number {
 if(ensureIoMeter()&&addon?.ioGrantSnapshot)return addon.ioGrantSnapshot().pageSize;
 // Enforcement is unavailable; use a conservative idle-copy bound on old/unqualified builds.
 return 65536;
}

export function ioMeterNativePath():string|undefined {ensureIoMeter();return nativeMeterPath;}

/** FGCOPY is metered but uncapped; a caller's synchronous BG bracket is restored afterwards. */
export function withForegroundCopy<T>(fn:()=>T):{result:T;usedBytes:number|null;rawBytes:number} {
 if(!ensureIoMeter()||!addon?.ioFgBegin||!addon.ioFgEnd)return {result:fn(),usedBytes:null,rawBytes:0};
 addon.ioFgBegin();
 let result:T,state:ReturnType<typeof ioGrantSnapshot>;
 try{result=fn();}finally{state=addon.ioFgEnd();}
 return {result,usedBytes:state.usedBytes,rawBytes:state.rawBytes};
}

/** Ticket expiration uses the same OS wall clock as native enforcement. */
export function ioMeterWallTime():number {
 if(ensureIoMeter()&&addon?.ioGrantSnapshot)return addon.ioGrantSnapshot().wallTime??Date.now();
 return Date.now();
}
