// SPDX-License-Identifier: AGPL-3.0-or-later
// Native meter producer owner: scperf-p2. Source fixture consumer owner: new3-g2d.
// Scanner-only native bootstrap. Built-ins only: the staged scanner never
// imports application config, the live database opener, memory or a driver.
import fs from "node:fs";
import {createRequire} from "node:module";
import {DatabaseSync} from "node:sqlite";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {ChildIoReporter,ownedChildIoBytes,ownedChildIoKnown} from "./io-child-receipts.ts";
export interface ScannerNative {
 sentinelIoAwakeMs?():number;
 sentinelIoCreateRoot?(path:string):boolean;
 sentinelIoRoot?(path:string):object;
 sentinelIoOpen?(root:object,name:string,kind:number):object;
 sentinelIoClose?(handle:object):void;
 sentinelIoLock?(handle:object,mode:number):boolean;
 sentinelIoRead?(handle:object,limit:number):Buffer;
 sentinelIoWrite?(handle:object,bytes:Buffer):boolean;
 sentinelIoReplace?(root:object,from:string,to:string):boolean;
}
interface Meter extends ScannerNative {diskWritten?():number|null;ioMeterAdd(source:string,bytes:number):void;ioMeterSnapshot():{total:number;known:boolean};ioMeterUnknown():void;version():number}
let native:Meter|undefined,bootstrap:DatabaseSync|undefined,attempted=false,uncertain=false;
function ensure():void {
 if(attempted)return;attempted=true;
 const here=dirname(fileURLToPath(import.meta.url)),resources=process.env.MURAGE_RESOURCES_PATH??process.env.OMB_RESOURCES_PATH;
 // Source fixtures already select a real addon through the main native
 // loader's test-only path. Use that same binary without changing the app's
 // packaged resource directory; every native/version check below still runs.
 // Match engine-exclusion.ts overrideAllowed: packaged/resource modes never
 // acquire a test override, even when their test process sets NODE_ENV=test.
 const testOverride=process.env.NODE_ENV==="test"&&!process.env.MURAGE_PACKAGED&&!process.env.MURAGE_RESOURCES_PATH&&!process.env.OMB_RESOURCES_PATH;
 const fixtureAddon=testOverride?process.env.MURAGE_ENGINE_EXCLUSION_PATH?.trim():undefined;
 const candidates=[...(fixtureAddon?[fixtureAddon]:[]),...(resources?[join(resources,"engine-exclusion.node")]:[
  // A scheduled scanner entry is staged away from the server bundle. Its
  // installed interpreter still anchors the packaged resources directory.
  process.platform==="darwin"?join(dirname(process.execPath),"..","Resources","engine-exclusion.node"):join(dirname(process.execPath),"resources","engine-exclusion.node"),
  join(here,"../../dist-native/engine-exclusion",`${process.platform}-${process.arch}`,"engine-exclusion.node"),
  join(here,"../dist-native/engine-exclusion",`${process.platform}-${process.arch}`,"engine-exclusion.node"),
 ])];
 const require=createRequire(import.meta.url);
 for(const path of candidates)try{
  if(!fs.existsSync(path))continue;
  const candidate=require(path) as Meter;
  if(candidate.version()!==11||typeof candidate.ioMeterAdd!=="function"||typeof candidate.ioMeterSnapshot!=="function"||Object.keys(candidate).some(k=>k.startsWith("anchorTest")))continue;
  const db=new DatabaseSync(":memory:",{allowExtension:true});
  try{db.loadExtension(path,"sqlite3_muragemeter_init");db.enableLoadExtension(false);}catch(error){db.close();throw error;}
  bootstrap=db;native=candidate;break;
 }catch{/* keep OS floor; Windows remains unknown without its native meter */}
}
export function scannerNative():ScannerNative|undefined {ensure();return native;}
function unknown(){uncertain=true;try{native?.ioMeterUnknown();}catch{/* local flag remains */}}
export const writeFileSync:typeof fs.writeFileSync=(file,data,options)=>{
 ensure();
 try{
  fs.writeFileSync(file,data,options);
  const stat=typeof file==="number"?fs.fstatSync(file):fs.statSync(file);
  const encoding=typeof options==="string"?options:options?.encoding??"utf8";
  if(stat.isFile())native?.ioMeterAdd("sentinel-files",typeof data==="string"?Buffer.byteLength(data,encoding):data.byteLength);
 }catch(error){unknown();throw error;}
};
function scannerSample(requireChildHistory:boolean){
 ensure();void bootstrap;
 const blocks=process.platform==="win32"?0:process.resourceUsage().fsWrite;
 let osBytes=blocks*512,osKnown=true;
 if(process.platform==="darwin")try{const bytes=native?.diskWritten?.();if(typeof bytes!=="number"||!Number.isSafeInteger(bytes)||bytes<0)osKnown=false;else osBytes=Math.max(osBytes,bytes);}catch{osKnown=false;}
 let snapshot:{total:number;known:boolean}|undefined;
 try{snapshot=native?.ioMeterSnapshot();}catch{unknown();}
 return {blocks,bytes:Math.max(osBytes,snapshot?.total??0)+ownedChildIoBytes(),
  known:osKnown&&!uncertain&&(!requireChildHistory||ownedChildIoKnown())&&(process.platform==="linux"||snapshot?.known===true)};
}
export function scannerIoSample(){return scannerSample(true);}
/** File cycles separately require the CURRENT child final. Prior child loss is
 * preserved in the durable epoch/lossSerial, never repaired into an old interval. */
export function scannerIoCycleSample(){return scannerSample(false);}
export function scannerIoReporter():ChildIoReporter|undefined {
 const generation=process.env.MURAGE_IO_GENERATION;
 if(!generation||!process.send)return;
 const reporter=new ChildIoReporter(generation,scannerIoSample,m=>{if(process.connected)process.send!(m,()=>{});});
 process.on("message",m=>reporter.accept(m));
 return reporter;
}
// Register the VFS before any scanner opens a SQLite file.
ensure();
