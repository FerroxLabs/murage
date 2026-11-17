// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture ticket issuer owner: scperf-p1. Production helper ticket consumer owner: scperf-p1.
import type {ChildProcess,Serializable} from "node:child_process";
import {IoBudget,type AdmissionTicket} from "../../io-budget.ts";
import {ioMeterNativePath} from "../../io-meter.ts";
/** Direct-child fixtures implement the same boot/grant protocol as the production controller. */
export function fixtureHelperPermits(){
 let at=0,sequence=0;
 const budget=new IoBudget({read:()=>({at,fsWriteBlocks:0,cpuMicros:0}),log:()=>{}});
 const pending=new Map<string,AdmissionTicket>();
 const boot=budget.admit("BG",1024*1024)!;pending.set("fixture-boot",boot);
 const reply=(raw:unknown,receive:(event:Serializable)=>void)=>{
  const m=raw as {type?:string;ceiling?:number;id?:string;used?:number};
  if(m.type==="bg-grant-request"){
   let ticket=budget.admit("BG",m.ceiling!);
   if(!ticket){at=(Math.floor(at/60000)+1)*60000;ticket=budget.admit("BG",m.ceiling!);}
   if(!ticket)throw new Error("FIXTURE_HELPER_STEP_TOO_LARGE");
   const id=`fixture-permit-${++sequence}`;pending.set(id,ticket);receive({type:"bg-grant",ticket:{...ticket,id}});
  }else if(m.type==="bg-grant-settle"){
   const ticket=pending.get(m.id!);if(!ticket)throw new Error("FIXTURE_UNKNOWN_HELPER_PERMIT");
   budget.settle(ticket,m.used!);pending.delete(m.id!);
  }
 };
 return {
  env:{...process.env,MURAGE_ENGINE_EXCLUSION_PATH:ioMeterNativePath(),MURAGE_BG_BOOT:JSON.stringify({...boot,id:"fixture-boot"})},
  /** In-process worker fixtures use the same checked permit issuer as real children. */
  reply,
  attach(child:ChildProcess){
   child.on("message",raw=>reply(raw,event=>child.send(event)));
   child.once("exit",()=>{for(const ticket of pending.values())budget.settle(ticket,ticket.bytes);pending.clear();});
  },
 };
}
/** An index stand-in performs no writes; return its attached permit before acknowledging the batch. */
export function settleFixtureIndexGrant(message:unknown,receive:(event:unknown)=>void):void {
 const id=(message as {grant?:{id?:unknown}}).grant?.id;
 if(typeof id==="string")receive({type:"bg-grant-settle",id,used:0});
}
