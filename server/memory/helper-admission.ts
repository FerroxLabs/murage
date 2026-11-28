// SPDX-License-Identifier: AGPL-3.0-or-later
// Ticket issuer owner: scperf-p1 (worker-controller). Ticket consumer owner: scperf-p1 (index-wal/worker).
import type { DatabaseSync } from "node:sqlite";
import { BgDeferred } from "../bg-admission.ts";
import { beginBgGrant, endBgGrant, ioGrantSnapshot, registerBgProcess, withBgGrant, type BgTicket } from "../io-meter.ts";
/** relief (1.0.22 bgstarve, io-budget.ts one relief door): the ticket is a step CUT to what was left of the minute's relief grant. It is
 * smaller than a step's worst-case ceilings, so the helper writes under it with the native byte cap as the bound instead (index-wal.ts). */
export interface HelperTicket extends BgTicket { id:string; stepBytes?:number; purpose?:AdmissionPurpose; relief?:true }
// W5 (memv2-D index-debt.ts): "index-debt" is the open check's one copy of a log larger than a background ticket (io-budget admitIndexDebt)
// idle-receipt-design: "exit-seal" is the exit path's one sealing checkpoint
export type AdmissionPurpose="bg"|"owner-delete"|"index-debt"|"exit-seal";
interface Carrier { request(ceiling:number,replan:boolean,purpose:AdmissionPurpose):void; settle(ticket:HelperTicket,used:number):void }
let carrier:Carrier|undefined;
let available:HelperTicket|undefined;
let availableUsed=0;
let purpose:AdmissionPurpose="bg",availablePurpose:AdmissionPurpose="bg",pendingPurpose:AdmissionPurpose="bg";
export function admissionPurpose():AdmissionPurpose{return purpose;}
export function setAdmissionPurpose(next:AdmissionPurpose):()=>void {
 const previous=purpose;
 if(next!==purpose&&available&&!purposeMatches(availablePurpose,next)){carrier?.settle(available,availableUsed);available=undefined;availableUsed=0;}
 if(next==="exit-seal"&&next!==purpose)retryAt=0;
 purpose=next;
 return ()=>{setAdmissionPurpose(previous);};
}
let requested=0,retryAt=0;
let pendingReplies=0;
const replyWaiters=new Set<()=>void>();
function notifyReplies():void{if(!pendingReplies){for(const done of replyWaiters)done();replyWaiters.clear();}}
let stepBudget=11*1024*1024;
/** The step plan in force was cut by a relief ticket (below): it is smaller than one record's worst-case reserve can be. */
let reliefPlan=false;
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
 available=undefined;availableUsed=0;requested=0;pendingReplies=0;notifyReplies();retryAt=0;stepBudget=11*1024*1024;reliefPlan=false;purpose="bg";availablePurpose="bg";pendingPurpose="bg";carrier=value;
}
export function acceptHelperTicket(ticket:HelperTicket|null,retryInMs=0):void {
 requested=0;
 if(pendingReplies)pendingReplies--;
 if(ticket){if(available)carrier?.settle(available,availableUsed);available=ticket;availablePurpose=ticket.purpose??pendingPurpose;availableUsed=0;retryAt=0;if(ticket.stepBytes!==undefined){stepBudget=Math.min(11*1024*1024,ticket.bytes,ticket.stepBytes);reliefPlan=ticket.relief===true;}}
 else retryAt=Date.now()+Math.max(1,retryInMs);
 notifyReplies();
}
export function helperEnforced():boolean{return carrier!==undefined;}
function purposeMatches(held:AdmissionPurpose,wanted:AdmissionPurpose):boolean{return held===wanted||(wanted==="exit-seal"&&held==="bg");}
function ticketFits(ceiling:number):boolean{return Boolean(available&&purposeMatches(availablePurpose,purpose)&&available.expiresAt>Date.now()&&available.bytes-availableUsed>=ceiling);}
/** What is left of a held relief ticket (0: none held). */
export function helperReliefRoom():number {
 return available?.relief&&ticketFits(1)?available.bytes-availableUsed:0;
}
/** bgstarve (review of 1c98f1b0fb, the real helper path): while the step plan is a relief cut, one record whose worst-case reserve is
 * over the cut step is still written, alone (memw-steps.ts formGroup). A plan cut to the minute's grant (at most 4 MiB, a step of 828 KiB
 * of log; 194 KiB at the 1 MiB cut) is under the reserve of any insert (264 KiB and more), so every batch was answered "drain" and
 * nothing was ever written or asked for. The write is bound by the native byte cap, as every relief write is (index-wal.ts write). */
export function helperReliefPlan():boolean{return carrier!==undefined&&reliefPlan;}
export const HELPER_RELIEF_WRITE_MIN_BYTES=512*1024;
export function helperHasGrant(ceiling:number,replan=false,allowRelief=false):boolean {
 if(!carrier)return true;
 const fits=()=>ticketFits(ceiling)||(allowRelief&&helperReliefRoom()>=HELPER_RELIEF_WRITE_MIN_BYTES);
 if(fits())return true;
 if(available){carrier.settle(available,availableUsed);available=undefined;availableUsed=0;}
 const plannedStep=stepBudget;
 if(!requested&&!pendingReplies&&Date.now()>=retryAt){
  requested=ceiling;pendingReplies++;pendingPurpose=purpose;
  try{carrier.request(ceiling,replan,purpose);}catch(error){requested=0;if(pendingReplies)pendingReplies--;notifyReplies();throw error;}
 }
 // Inline delivery needs no retry unless its step plan changed: the caller must first resize work to that plan.
 return plannedStep===stepBudget&&fits();
}
export function withHelperGrant<T>(ceiling:number,fn:()=>T,db?:DatabaseSync,reserve=ceiling,replan=false,finishCheckpoint=false):T {
 if(!carrier||ioGrantSnapshot().live)return fn();
 if(!helperHasGrant(reserve,replan))throw new BgDeferred(Math.max(1,retryAt-Date.now()));
 const ticket=available!;
 // A checkpoint already inside SQLite keeps its byte cap if a slow disk carries it across the minute.
 try{return withBgGrant({...ticket,bytes:helperAdmissionTestHooks.capBytes??ceiling,...finishCheckpoint?{expiresAt:Number.MAX_SAFE_INTEGER}:{}},fn,db);}
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
export async function waitForHelperReply():Promise<boolean>{
 if(!pendingReplies)return false;
 await new Promise<void>(resolve=>replyWaiters.add(resolve));
 return true;
}
export function helperHasReservedGrant():boolean{return Boolean(available);}
/** idle W1a: a stopping helper asks once more for the batch it was sent before the stop; an earlier refusal's retry time does not hold that ask back. */
export function clearHelperRetry():void{retryAt=0;}
export function helperAdmissionRetryMs():number{return Math.max(0,retryAt-Date.now());}
export async function settleHelperAdmission(release=()=>true):Promise<void>{
 await waitForHelperReply();
 if(release())stopHelperAdmission();
}

export function helperStepBudget():number{return stepBudget;}

export function helperAwaitingGrant():boolean{return Boolean(carrier&&!ticketFits(1)&&(pendingReplies||retryAt>Date.now()));}
