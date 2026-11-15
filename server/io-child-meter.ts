// SPDX-License-Identifier: AGPL-3.0-or-later
// Installed before app imports, like the Windows child-process wrapper. A
// launch's executable and pinned entry select its class; names are never inferred
// from a PID or an executable's basename after launch.
import childProcess from "node:child_process";
import {existsSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {syncBuiltinESMExports} from "node:module";
import {dirname,resolve,basename} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {AsyncLocalStorage} from "node:async_hooks";
import {SPAWNED_PROXY_FILES} from "../shared/spawned-proxies.mjs";
import {observeChildIo,invalidateChildIo,noteChildIoMeterInstalled,externalOwnedChildLaunches} from "./sentinel/io-child-receipts.ts";
import {writeSync} from "./counted-fs.ts";
import {markIoMeterUnknown} from "./io-meter.ts";

const root=dirname(fileURLToPath(import.meta.url));
const initialEntries=[...Object.values(SPAWNED_PROXY_FILES),
 "index","io-proxy-launcher","sentinel/cli","backup-coordinator","backup-remote-host","backup-restic","windows-backup-resources",
 "installation-windows-backup-transport","approval-notification-state","incident-diagnostics","memory/restore","browser-restore-cli",
];
const launchStateKey=Symbol.for("murage.io.child-launches");
interface LaunchState {installed:boolean;reported:boolean;entries:Set<string>;counts:{OWNED_NODE:number;ENGINE_EXCLUDED:number;UNMAPPED_NODE:number}}
const launchGlobal=globalThis as typeof globalThis&{[launchStateKey]:LaunchState|undefined};
const launchState=launchGlobal[launchStateKey]??= {installed:false,reported:false,entries:new Set(initialEntries),counts:{OWNED_NODE:0,ENGINE_EXCLUDED:0,UNMAPPED_NODE:0}};
const entries=launchState.entries,runCounts=launchState.counts;
export const childIoCensusSnapshot=()=>({...runCounts,OWNED_NODE:runCounts.OWNED_NODE+externalOwnedChildLaunches()});
/** Emit once, through the counted boundary if stderr is a regular file. A
 * child calls this BEFORE its final sample, so reporting cannot add a late tail. */
export function reportChildIoCensus():void {
 if(launchState.reported)return;launchState.reported=true;
 if(Object.values(childIoCensusSnapshot()).some(Boolean))try{writeSync(2,"[io-census] "+JSON.stringify(childIoCensusSnapshot())+"\n");}catch{markIoMeterUnknown();}
}
export type ChildIoClass=keyof typeof runCounts;
function nodeEntry(args:readonly string[],cwd:string):string|undefined {
 const valueFlags=new Set(["--import","--require","-r","--loader","--experimental-loader","--input-type","--conditions","-C","--inspect-port"]);
 for(let at=0;at<args.length;at++){
  const arg=args[at];
  if(["-e","--eval","-p","--print","-"].includes(arg))return;
  if(valueFlags.has(arg)){at++;continue;}
  if(arg==="--")return args[at+1]?resolve(cwd,args[at+1]):undefined;
  if(!arg.startsWith("-"))return resolve(cwd,arg);
 }
}
export function classifyChildIo(command:string,args:readonly string[],cwd=process.cwd()):ChildIoClass {
 // MAIN RULING Q3: "foreign child programs are excluded by this written ruling,
 // like engine homes." Third-party Node entries belong to that class too.
 if(command!==process.execPath&&!/^node(?:\.exe)?$/.test(basename(command)))return "ENGINE_EXCLUDED";
 const path=nodeEntry(args,cwd);
 if(!path||(!path.startsWith(root+"/")&&!path.startsWith(root+"\\")))return "ENGINE_EXCLUDED";
 const relative=path.slice(root.length+1).replaceAll("\\","/").replace(/\.(?:ts|js|mjs)$/u,"");
 if(entries.has(relative))return "OWNED_NODE";
 return /\.(?:ts|js|mjs)$/.test(path)?"UNMAPPED_NODE":"ENGINE_EXCLUDED";
}

const inside=new AsyncLocalStorage<boolean>();
export function installChildProcessMeter():void {
 if(launchState.installed)return;launchState.installed=true;noteChildIoMeterInstalled();
 const source=resolve(root,"io-child-bootstrap.ts"),preload=pathToFileURL(existsSync(source)?source:resolve(root,"io-child-bootstrap.js")).href;
 interface NormalizedOptions {file:string;args:string[];cwd?:string;envPairs?:string[];stdio?:unknown;execArgv?:string[];execPath?:string}
 const prototype=childProcess.ChildProcess.prototype as childProcess.ChildProcess&{spawn:(options:NormalizedOptions)=>number};
 const spawn=prototype.spawn;
 // This is the common Node launch boundary used by spawn, fork, execFile and
 // exec. In particular execFile discards a caller's stdio option before reaching
 // it; adding IPC here preserves its validation, buffering and callback API.
 prototype.spawn=function(options:NormalizedOptions):number {
  if(inside.getStore())return Reflect.apply(spawn,this,[options]);
  const pairs=options.envPairs??[],cwd=options.cwd??process.cwd();
  const generationPair=pairs.find(pair=>pair.startsWith("MURAGE_IO_GENERATION="));
  const entry=nodeEntry(options.args.slice(1),cwd);
  // Only the existing memory and Sentinel supervisors own an out-of-band
  // generation. Arbitrary environment values cannot bypass the launch meter.
  const supervised=Boolean(generationPair&&generationPair!=="MURAGE_IO_GENERATION="+process.env.MURAGE_IO_GENERATION
   &&(entry===resolve(root,"memory/worker.ts")||entry===resolve(root,"memory/worker.js")||pairs.includes("MURAGE_SENTINEL_CHILD=1")));
  const cls=supervised?"OWNED_NODE":classifyChildIo(options.file,options.args.slice(1),cwd);runCounts[cls]++;
  // Inherited generations belong to THIS process. Nested owned launches need
  // a fresh generation and receipt, never the parent's token.
  if(supervised)return Reflect.apply(spawn,this,[options]);
  if(cls==="ENGINE_EXCLUDED"){
   if(process.env.MURAGE_IO_CHILD==="1"){
    options.envPairs=pairs.filter(pair=>!pair.startsWith("MURAGE_IO_GENERATION=")&&!pair.startsWith("MURAGE_IO_CHILD="));
    options.args=options.args.filter(arg=>arg!==`--import=${preload}`);
    if(options.execArgv)options.execArgv=options.execArgv.filter(arg=>arg!==`--import=${preload}`);
   }
   return Reflect.apply(spawn,this,[options]);
  }
  if(cls==="UNMAPPED_NODE"){invalidateChildIo();markIoMeterUnknown();return Reflect.apply(spawn,this,[options]);}
  const generation=randomUUID();
  const env={MURAGE_IO_GENERATION:generation,MURAGE_IO_CHILD:"1",
   ...(process.env.MURAGE_RESOURCES_PATH?{MURAGE_RESOURCES_PATH:process.env.MURAGE_RESOURCES_PATH}:{}),
   ...(process.env.OMB_RESOURCES_PATH?{OMB_RESOURCES_PATH:process.env.OMB_RESOURCES_PATH}:{}),
   ...(process.env.MURAGE_PACKAGED?{MURAGE_PACKAGED:process.env.MURAGE_PACKAGED}:{}),
  };
  options.envPairs=[...pairs.filter(pair=>!Object.keys(env).some(key=>pair.startsWith(key+"="))),...Object.entries(env).map(([key,value])=>key+"="+value)];
  const stdio=Array.isArray(options.stdio)?[...options.stdio]:Array(3).fill(options.stdio??"pipe");
  if(!stdio.includes("ipc"))stdio.push("ipc");options.stdio=stdio;
  options.args=[options.args[0],`--import=${preload}`,...options.args.slice(1)];
  if(Array.isArray(options.execArgv))options.execArgv=[`--import=${preload}`,...options.execArgv];
  const result=Reflect.apply(spawn,this,[options]);
  observeChildIo(this,generation,{onIoUnknown:markIoMeterUnknown});return result;
 };
 // Production synchronous sites run foreign utilities. If a future change runs
 // an owned Node entry synchronously it needs a receipt transport first; until
 // then the reading is unknown rather than silently reclassifying it foreign.
 for(const api of ["spawnSync","execFileSync","execSync"] as const){
  const original=childProcess[api];
  Object.assign(childProcess,{[api]:new Proxy(original,{apply(target,receiver,args){
   if(inside.getStore())return Reflect.apply(target,receiver,args);
   const cls=api==="execSync"?"ENGINE_EXCLUDED":classifyChildIo(args[0],Array.isArray(args[1])?args[1]:[]);
   runCounts[cls]++;
   if(cls!=="ENGINE_EXCLUDED"){invalidateChildIo();markIoMeterUnknown();}
   return inside.run(true,()=>Reflect.apply(target,receiver,args));
  }})});
 }

 syncBuiltinESMExports();
 process.once("exit",reportChildIoCensus);
}

export function registerOwnedChildForTest(relative:string):void {
 if(process.env.NODE_ENV!=="test"||process.env.MURAGE_PACKAGED)throw new Error("IO_METER_TEST_ONLY");
 entries.add(relative.replace(/\.(?:ts|js|mjs)$/u,""));
}
