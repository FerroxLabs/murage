// SPDX-License-Identifier: AGPL-3.0-or-later
// Ticket issuer owner: scperf-p1 (worker-controller). Ticket consumer owner: scperf-p1 (index-wal/worker).
import type { DatabaseSync } from "node:sqlite";
import { BgDeferred } from "../bg-admission.ts";
import { beginBgGrant, endBgGrant, ioGrantSnapshot, registerBgProcess, withBgGrant, type BgTicket } from "../io-meter.ts";
export interface HelperTicket extends BgTicket { id:string; stepBytes?:number; purpose?:AdmissionPurpose }
export type AdmissionPurpose="bg"|"owner-delete";
interface Carrier { request(ceiling:number,replan:boolean,purpose:AdmissionPurpose):void; settle(ticket:HelperTicket,used:number):void }
let carrier:Carrier|undefined;
let available:HelperTicket|undefined;
let availableUsed=0;
let purpose:AdmissionPurpose="bg",availablePurpose:AdmissionPurpose="bg",pendingPurpose:AdmissionPurpose="bg";
export function admissionPurpose():AdmissionPurpose{return purpose;}
export function setAdmissionPurpose(next:AdmissionPurpose):()=>void {
 const previous=purpose;
 if(next!==purpose&&available&&availablePurpose!==next){carrier?.settle(available,availableUsed);available=undefined;availableUsed=0;}
 purpose=next;
 return ()=>{setAdmissionPurpose(previous);};
}
let requested=0,retryAt=0;
let pendingReplies=0;
const replyWaiters=new Set<()=>void>();
function notifyReplies():void{if(!pendingReplies){for(const done of replyWaiters)done();replyWaiters.clear();}}
let stepBudget=11*1024*1024;
let boot:HelperTicket|undefined,bootUsed=0;
const bootText=process.env.MURAGE_BG_BOOT;
if(bootText){
 boot=JSON.parse(bootText) as HelperTicket;
 registerBgProcess();beginBgGrant(boot);
}
export function finishModuleBoot():void {
 if(boot&&ioGrantSnapshot().live)bootUsed+=endBgGrant().usedBytes;
}
export const helperAdmissionTestHooks:{capBytes?:number}={};
export function configureHelperAdmission(value:Carrier|undefined):void {
 if(available)carrier?.settle(available,availableUsed);
 available=undefined;availableUsed=0;requested=0;pendingReplies=0;notifyReplies();retryAt=0;stepBudget=11*1024*1024;purpose="bg";availablePurpose="bg";pendingPurpose="bg";carrier=value;
}
export function acceptHelperTicket(ticket:HelperTicket|null,retryInMs=0):void {
 requested=0;
 if(pendingReplies)pendingReplies--;
 if(ticket){if(available)carrier?.settle(available,availableUsed);available=ticket;availablePurpose=ticket.purpose??pendingPurpose;availableUsed=0;retryAt=0;if(ticket.stepBytes!==undefined)stepBudget=Math.min(11*1024*1024,ticket.bytes,ticket.stepBytes);}
 else retryAt=Date.now()+Math.max(1,retryInMs);
 notifyReplies();
}
export function helperEnforced():boolean{return carrier!==undefined;}
function ticketFits(ceiling:number):boolean{return Boolean(available&&availablePurpose===purpose&&available.expiresAt>Date.now()&&available.bytes-availableUsed>=ceiling);}
export function helperHasGrant(ceiling:number,replan=false):boolean {
 if(!carrier)return true;
 if(ticketFits(ceiling))return true;
 if(available){carrier.settle(available,availableUsed);available=undefined;availableUsed=0;}
 const plannedStep=stepBudget;
 if(!requested&&!pendingReplies&&Date.now()>=retryAt){
  requested=ceiling;pendingReplies++;pendingPurpose=purpose;
  try{carrier.request(ceiling,replan,purpose);}catch(error){requested=0;if(pendingReplies)pendingReplies--;notifyReplies();throw error;}
 }
 // Inline delivery needs no retry unless its step plan changed: the caller must first resize work to that plan.
 return plannedStep===stepBudget&&ticketFits(ceiling);
}
export function withHelperGrant<T>(ceiling:number,fn:()=>T,db?:DatabaseSync,reserve=ceiling,replan=false):T {
 if(!carrier||ioGrantSnapshot().live)return fn();
 if(!helperHasGrant(reserve,replan))throw new BgDeferred(Math.max(1,retryAt-Date.now()));
 const ticket=available!;
 try{return withBgGrant({...ticket,bytes:helperAdmissionTestHooks.capBytes??ceiling},fn,db);}
 finally{availableUsed+=ioGrantSnapshot().usedBytes;}
}
export function withHelperBoot<T>(fn:()=>T):T {
 if(!boot)return fn();
 finishModuleBoot();
 const ticket=boot;boot=undefined;
 try{return withBgGrant({...ticket,bytes:Math.max(0,ticket.bytes-bootUsed)},fn);}
 finally{carrier?.settle(ticket,bootUsed+ioGrantSnapshot().usedBytes);}
}
export function stopHelperAdmission():void {
 if(available){carrier?.settle(available,availableUsed);available=undefined;availableUsed=0;}
 requested=0;
}
/** A request already sent owns a parent reservation, even before its ticket arrives here. Return it before acknowledging work. */
export async function settleHelperAdmission():Promise<void>{
 if(pendingReplies)await new Promise<void>(resolve=>replyWaiters.add(resolve));
 stopHelperAdmission();
}

export function helperStepBudget():number{return stepBudget;}

export function helperAwaitingGrant():boolean{return Boolean(carrier&&!ticketFits(1)&&(pendingReplies||retryAt>Date.now()));}
