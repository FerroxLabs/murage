// SPDX-License-Identifier: AGPL-3.0-or-later
// Attach transport owner: electron/sentinel-host.mjs via server/index.ts IPC.
// Validation, byte accounting, coverage state and acknowledgement owner: P2.
import {EventEmitter} from "node:events";
import type {ChildProcess} from "node:child_process";
import {observeChildIo,invalidateChildIo} from "./sentinel/io-child-receipts.ts";
import {sampleSentinelFileIo} from "./sentinel-file-sampling.ts";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";
import {noteSentinelPresent} from "./sentinel-descriptor-state.ts";

type AttachedState="PRESENT_UNATTACHED"|"ATTACHED_PENDING"|"ATTACHED_KNOWN"|"LOST";
let state:AttachedState="PRESENT_UNATTACHED";
/** Every complete coverage evaluation takes a fresh authenticated file snapshot.
 * An attached channel never proves closure of scheduled or orphaned writers. */
export function sentinelIoCovered():boolean {return sampleSentinelFileIo(()=>null).snapshot.known;}
/** One-channel diagnostic only; it carries no complete writer-set authority. */
export function sentinelAttachedIoCovered():boolean {return state==="ATTACHED_KNOWN";}
export function sentinelIoReceiver(reply:(message:unknown)=>void){
 let child:(EventEmitter&{send:(message:unknown)=>void})|undefined,generation:string|undefined;
 let sequence=0;
 const lose=()=>{noteSentinelPresent();state="LOST";invalidateChildIo();};
 return {accept(raw:unknown){
  if(!raw||typeof raw!=="object"){lose();return;}
  const event=raw as {type?:string;generation?:string;message?:unknown;code?:number;signal?:NodeJS.Signals};
  // File-enrolled families are accounted once by the cumulative external
  // source. Their outer IPC must not create pending or duplicate child bytes.
  const dataDir=process.env.MURAGE_DATA_DIR??join(homedir(),".murage");
  if(existsSync(join(dataDir,"sentinel-io"))){noteSentinelPresent();return;}
  if(event.type==="launch"&&typeof event.generation==="string"&&event.generation.length>0&&event.generation.length<=128){
   noteSentinelPresent();
   if(child)child.emit("exit",null,"SIGKILL");
   state="ATTACHED_PENDING";generation=event.generation;sequence=0;
   const launchedGeneration=generation;
   child=Object.assign(new EventEmitter(),{send:(message:unknown)=>reply({generation:launchedGeneration,type:"ack",message})});
   observeChildIo(child as unknown as ChildProcess,generation,{external:true,
    onIo:()=>{if(state!=="LOST")state="ATTACHED_KNOWN";},onIoUnknown:lose});return;
  }
  if(event.type==="uncovered"){noteSentinelPresent();state="LOST";return;}
  if(!child||event.generation!==generation){lose();return;}
  if(event.type==="exit"){
   state="LOST";child.emit("exit",event.code,event.signal);child=undefined;return;
  }
  if(event.type!=="sample"){lose();return;}
  // LOST is terminal for this generation. An old or subsequently valid frame
  // cannot conceal the unmeasured interval; only a new launch can attach.
  if(state==="LOST")return;
  const message=event.message as Record<string,unknown>|null;
  if(!message||typeof message!=="object"||message.type!=="io"||message.ioProtocol!==1
   ||message.generation!==generation||typeof message.sequence!=="number"
   ||!Number.isSafeInteger(message.sequence)||message.sequence<=sequence){lose();return;}
  sequence=message.sequence;
  child.emit("message",message);
 }};
}
